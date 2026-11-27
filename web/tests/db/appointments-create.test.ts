import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionFailure } from "@/server/actions/result";
import { type Clock, fixedClock, romeTime, todayRome } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { createAppointment } from "@/server/domain/appointments/commands";
import {
  bookingDefaults,
  loadBusy,
  nextSession,
  previewAppointment,
  suggestStart,
} from "@/server/domain/appointments/queries";
import { openCycle } from "@/server/domain/cycles/commands";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { createPatient } from "@/server/domain/patients/commands";
import { createService } from "@/server/domain/services/commands";
import { saveOpeningHours } from "@/server/domain/settings/commands";
import {
  APPOINTMENT_A,
  CYCLE_A,
  CYCLE_B,
  PATIENT_A1,
  PATIENT_A2,
  PATIENT_B1,
  PRACTICE_A,
  PRACTICE_B,
  SERVICE_A,
  SERVICE_B,
  USER_A,
} from "./fixtures";
import { asUserB, inRollback, inUserA, openTestDb } from "./helpers";

// Creazione degli appuntamenti dall'agenda: un
// comando che prenota una data o una serie nell'ora di Roma, apre il paziente e il ciclo nella stessa
// transazione e rifiuta una fine alla mezzanotte prima del database; l'anteprima avvisa di
// sovrapposizioni e orari chiusi senza bloccare; i default del dialogo, l'orario proposto e la
// prossima seduta del pannello "Seduta fatta".

const clock = fixedClock("2026-11-04T08:30:00+01:00");

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const nameOf = (err: unknown): unknown => (err as { name?: unknown } | null)?.name;

/** L'errore con cui il comando fallisce; se riesce, il test fallisce. */
function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (value: unknown) => expect.fail(`atteso un errore, invece il comando ha restituito ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );
}

/** Il comando fallisce prima del database (DomainError o ZodError): la risposta che arriva al modulo. */
async function formFailure(p: Promise<unknown>) {
  const error = await rejectionOf(p);
  expect(["DomainError", "ZodError"], String(error)).toContain(nameOf(error));
  return toActionFailure(error, "test");
}

/** Un DomainError di testo `message`, sul campo `field` se c'è: la transazione resta valida. */
async function expectDomainError(p: Promise<unknown>, message: string, field?: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
  if (field !== undefined) expect((error as { field?: unknown }).field).toBe(field);
}

const SAME_DAY = "L'appuntamento deve finire entro la stessa giornata.";
const ARCHIVED = "Paziente archiviato: ripristinalo dalla sua scheda.";
const NO_DATES = "Scegli almeno una data.";
const OUTSIDE = "Fuori dagli orari dello studio.";
const ANNA_OVERLAP = "Si sovrappone a Morelli Anna, 10:00-10:30.";

type DayBands = { opens: string; closes: string }[];

/** Una settimana con le fasce date per giorno ISO; i giorni assenti sono chiusi. */
function hours(bands: Partial<Record<number, DayBands>>) {
  return { days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, bands: bands[weekday] ?? [] })) };
}

const MORNING = { opens: "09:00", closes: "13:00" };
const AFTERNOON = { opens: "14:30", closes: "19:30" };
const FULL_DAY = [MORNING, AFTERNOON];

/** Gli orari del seed: lun-ven 09:00-13:00 e 14:30-19:30, sab 09:00-13:00, dom chiuso. */
const SEED_HOURS = hours({ 1: FULL_DAY, 2: FULL_DAY, 3: FULL_DAY, 4: FULL_DAY, 5: FULL_DAY, 6: [MORNING] });

interface Setup {
  firstVisitId: string;
  checkId: string;
}

/** Gli orari del seed, e accanto a SERVICE_A (seduta da 45) una prima visita da 60 e un controllo da 30. */
async function prepare(tx: Tx): Promise<Setup> {
  await saveOpeningHours(tx, PRACTICE_A, clock, SEED_HOURS);
  const firstVisit = await createService(tx, PRACTICE_A, clock, {
    kind: "prima_visita",
    name: "Prima visita osteopatica",
    invoiceDescription: "Prima visita osteopatica",
    durationMin: 60,
    priceCents: 8000,
    color: "ocra",
  });
  const check = await createService(tx, PRACTICE_A, clock, {
    kind: "controllo",
    name: "Controllo",
    invoiceDescription: "Controllo osteopatico",
    durationMin: 30,
    priceCents: 4500,
    color: "salvia",
  });
  return { firstVisitId: firstVisit.id, checkId: check.id };
}

/** Un paziente adulto nuovo, senza cicli, creato come uA. */
async function newPatient(tx: Tx, firstName: string, lastName: string): Promise<string> {
  const { id } = await createPatient(tx, PRACTICE_A, clock, { firstName, lastName, birthDate: "1979-03-09" });
  return id;
}

const ELISA = { kind: "new", firstName: "Elisa", lastName: "Fontana", birthDate: "1964-05-02" };

/** Una seduta di PATIENT_A1 nel suo ciclo aperto, lunedì 9/11 alle 09:00; `patch` cambia i campi. */
function seduta(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    patient: { kind: "existing", patientId: PATIENT_A1 },
    serviceId: SERVICE_A,
    day: "2026-11-09",
    time: "09:00",
    durationMin: 45,
    cycle: { kind: "existing", cycleId: CYCLE_A },
    priceCents: 6000,
    status: "prenotato",
    ...patch,
  };
}

/** Un appuntamento di un paziente esistente; `patch` cambia i campi. */
function forPatient(patientId: string, patch: Record<string, unknown>): Record<string, unknown> {
  return seduta({ patient: { kind: "existing", patientId }, ...patch });
}

async function book(tx: Tx, input: Record<string, unknown>, at: Clock = clock): Promise<string> {
  const created = await createAppointment(tx, PRACTICE_A, at, input);
  const [first] = created.appointments;
  if (!first) throw new Error("nessun appuntamento creato");
  return first.id;
}

async function appointmentRow(tx: Tx, id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx.query("select * from public.appointments where id = $1", [id]);
  return row;
}

async function count(tx: Tx, table: string, practiceId = PRACTICE_A): Promise<number> {
  const [row] = await tx.query<{ n: number }>(`select count(*)::int as n from public.${table} where practice_id = $1`, [
    practiceId,
  ]);
  return row?.n ?? -1;
}

async function counts(tx: Tx, practiceId = PRACTICE_A) {
  return {
    patients: await count(tx, "patients", practiceId),
    cycles: await count(tx, "treatment_cycles", practiceId),
    series: await count(tx, "appointment_series", practiceId),
    appointments: await count(tx, "appointments", practiceId),
  };
}

const iso = (value: unknown): string => (value as Date).toISOString();

describe("createAppointment", () => {
  it("una seduta nel ciclo aperto", async () => {
    const outcome = await inUserA(db, async (tx) => {
      await prepare(tx);
      const created = await createAppointment(tx, PRACTICE_A, clock, seduta());
      const [first] = created.appointments;
      return { created, row: first ? await appointmentRow(tx, first.id) : undefined };
    });
    expect(outcome.created).toEqual({
      appointments: [{ id: outcome.row?.id, startsAt: new Date("2026-11-09T08:00:00.000Z"), status: "prenotato" }],
      seriesId: null,
      cycleId: CYCLE_A,
      patientId: PATIENT_A1,
    });
    expect(outcome.row).toMatchObject({
      practice_id: PRACTICE_A,
      patient_id: PATIENT_A1,
      service_id: SERVICE_A,
      cycle_id: CYCLE_A,
      series_id: null,
      duration_min: 45,
      price_cents: 6000,
      status: "prenotato",
      cancel_reason: null,
      payment_method: null,
      no_invoice_reason: null,
      notes: null,
      created_by: USER_A,
    });
    expect(iso(outcome.row?.starts_at)).toBe("2026-11-09T08:00:00.000Z");
    expect(iso(outcome.row?.ends_at)).toBe("2026-11-09T08:45:00.000Z");
    expect(iso(outcome.row?.status_changed_at)).toBe("2026-11-04T07:30:00.000Z");
  });

  it("paziente nuovo e ciclo nuovo nella stessa transazione", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const { firstVisitId } = await prepare(tx);
      const before = await counts(tx);
      const created = await createAppointment(tx, PRACTICE_A, clock, {
        ...seduta({ serviceId: firstVisitId, day: "2026-11-10", time: "10:00", durationMin: 60, priceCents: 8000 }),
        patient: ELISA,
        cycle: { kind: "new" },
      });
      return {
        created,
        before,
        after: await counts(tx),
        patients: await tx.query(
          "select id, first_name, last_name, birth_date, archived_at from public.patients where practice_id = $1 and last_name = 'Fontana'",
          [PRACTICE_A],
        ),
        cycles: await tx.query("select * from public.treatment_cycles where patient_id = $1", [created.patientId]),
        appointments: await tx.query("select * from public.appointments where patient_id = $1", [created.patientId]),
      };
    });
    expect(outcome.after).toEqual({
      patients: outcome.before.patients + 1,
      cycles: outcome.before.cycles + 1,
      series: outcome.before.series,
      appointments: outcome.before.appointments + 1,
    });
    expect(outcome.patients).toEqual([
      { id: outcome.created.patientId, first_name: "Elisa", last_name: "Fontana", birth_date: "1964-05-02", archived_at: null },
    ]);
    expect(outcome.cycles).toHaveLength(1);
    expect(outcome.cycles[0]).toMatchObject({
      id: outcome.created.cycleId,
      kind: "trattamento",
      status: "open",
      opened_on: "2026-11-04",
      title: "Nuovo ciclo, novembre 2026",
      expected_sessions: 4,
    });
    expect(outcome.appointments).toHaveLength(1);
    expect(outcome.appointments[0]).toMatchObject({
      id: outcome.created.appointments[0]?.id,
      cycle_id: outcome.created.cycleId,
      duration_min: 60,
      price_cents: 8000,
      series_id: null,
    });
  });

  it("un controllo per un paziente senza ciclo apre un mantenimento senza sedute previste", async () => {
    const cycle = await inUserA(db, async (tx) => {
      const { checkId } = await prepare(tx);
      const patientId = await newPatient(tx, "Roberto", "Galli");
      const created = await createAppointment(
        tx,
        PRACTICE_A,
        clock,
        forPatient(patientId, { serviceId: checkId, durationMin: 30, priceCents: 4500, cycle: { kind: "new" } }),
      );
      const [row] = await tx.query("select kind, expected_sessions from public.treatment_cycles where id = $1", [
        created.cycleId,
      ]);
      return row;
    });
    expect(cycle).toEqual({ kind: "mantenimento", expected_sessions: null });
  });

  it("nessuna scrittura prima dei controlli", async () => {
    const outcome = await inRollback(db, "A", async (tx) => {
      await prepare(tx);
      const before = await counts(tx);
      // Il paziente nuovo con la prestazione di un altro studio, poi con il ciclo di un altro paziente.
      await expectDomainError(
        createAppointment(tx, PRACTICE_A, clock, { ...seduta({ serviceId: SERVICE_B }), patient: ELISA, cycle: { kind: "new" } }),
        NOT_ALLOWED,
        "serviceId",
      );
      await expectDomainError(
        createAppointment(tx, PRACTICE_A, clock, { ...seduta(), patient: ELISA, cycle: { kind: "existing", cycleId: CYCLE_A } }),
        NOT_ALLOWED,
        "cycle",
      );
      return {
        before,
        after: await counts(tx),
        elisa: await tx.query("select id from public.patients where first_name = 'Elisa' and last_name = 'Fontana'"),
      };
    });
    expect(outcome.elisa).toEqual([]);
    expect(outcome.after).toEqual(outcome.before);
  });

  it("le regole del paziente nuovo arrivano sui campi sotto patient e non scrivono niente", async () => {
    const outcome = await inUserA(db, async (tx) => {
      await prepare(tx);
      const before = await counts(tx);
      const future = await formFailure(
        createAppointment(tx, PRACTICE_A, clock, {
          ...seduta(),
          patient: { ...ELISA, birthDate: "2026-11-05" },
          cycle: { kind: "new" },
        }),
      );
      const minor = await formFailure(
        createAppointment(tx, PRACTICE_A, clock, {
          ...seduta(),
          patient: { ...ELISA, birthDate: "2016-02-14" },
          cycle: { kind: "new" },
        }),
      );
      const blank = await formFailure(
        createAppointment(tx, PRACTICE_A, clock, { ...seduta(), patient: { ...ELISA, firstName: " " }, cycle: { kind: "new" } }),
      );
      return { before, after: await counts(tx), future, minor, blank };
    });
    expect(outcome.future.fieldErrors).toEqual({ "patient.birthDate": "La data di nascita non può essere nel futuro." });
    expect(outcome.minor.fieldErrors).toEqual({
      "patient.guardian.firstName": "Per un minore servono nome e cognome di un genitore.",
    });
    expect(outcome.blank.fieldErrors).toEqual({ "patient.firstName": "Campo obbligatorio." });
    expect(outcome.after).toEqual(outcome.before);
  });

  it("fatto nel passato apre il ciclo al giorno dell'appuntamento", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const { firstVisitId } = await prepare(tx);
      const patientId = await newPatient(tx, "Marco", "Bellandi");
      const visit = { serviceId: firstVisitId, durationMin: 60, priceCents: 8000 };
      const created = await createAppointment(
        tx,
        PRACTICE_A,
        clock,
        forPatient(patientId, { ...visit, day: "2026-11-02", time: "18:00", cycle: { kind: "new" }, status: "fatto" }),
      );
      const [cycle] = await tx.query("select opened_on from public.treatment_cycles where id = $1", [created.cycleId]);
      const row = await appointmentRow(tx, created.appointments[0]?.id ?? "");
      const inCycle = { cycle: { kind: "existing", cycleId: created.cycleId } };
      const before = await counts(tx);
      await expectDomainError(
        createAppointment(tx, PRACTICE_A, clock, forPatient(patientId, { ...inCycle, day: "2026-11-05", status: "fatto" })),
        NOT_ALLOWED,
        "status",
      );
      await expectDomainError(
        createAppointment(
          tx,
          PRACTICE_A,
          clock,
          forPatient(patientId, {
            ...inCycle,
            day: "2026-10-21",
            status: "fatto",
            repeat: { intervalWeeks: 1, count: 2, excludedDays: [] },
          }),
        ),
        NOT_ALLOWED,
        "status",
      );
      const afterRefusals = await counts(tx);
      // Oggi, anche più tardi di adesso, è "fino a oggi".
      const later = await createAppointment(
        tx,
        PRACTICE_A,
        clock,
        forPatient(patientId, { ...inCycle, day: "2026-11-04", time: "17:00", status: "fatto" }),
      );
      return { cycle, row, before, afterRefusals, later };
    });
    expect(outcome.cycle).toEqual({ opened_on: "2026-11-02" });
    expect(outcome.row).toMatchObject({ status: "fatto", duration_min: 60 });
    expect(iso(outcome.row?.starts_at)).toBe("2026-11-02T17:00:00.000Z");
    expect(iso(outcome.row?.status_changed_at)).toBe("2026-11-04T07:30:00.000Z");
    expect(outcome.afterRefusals).toEqual(outcome.before);
    expect(outcome.later.appointments).toEqual([
      { id: expect.any(String), startsAt: new Date("2026-11-04T16:00:00.000Z"), status: "fatto" },
    ]);
  });

  it("un appuntamento prima di opened_on porta indietro l'apertura del ciclo; uno dopo non la tocca", async () => {
    const outcome = await inUserA(db, async (tx) => {
      await prepare(tx);
      const { id: cycleId } = await openCycle(tx, PRACTICE_A, clock, {
        patientId: PATIENT_A2,
        kind: "trattamento",
        firstAppointmentDay: "2026-11-04",
      });
      const openedOn = async (): Promise<unknown> =>
        (await tx.query("select opened_on from public.treatment_cycles where id = $1", [cycleId]))[0];
      const inCycle = forPatient(PATIENT_A2, { cycle: { kind: "existing", cycleId } });
      const initial = await openedOn();
      await createAppointment(tx, PRACTICE_A, clock, { ...inCycle, day: "2026-11-10" });
      const afterLater = await openedOn();
      await createAppointment(tx, PRACTICE_A, clock, { ...inCycle, day: "2026-10-28" });
      return { initial, afterLater, afterEarlier: await openedOn() };
    });
    expect(outcome.initial).toEqual({ opened_on: "2026-11-04" });
    expect(outcome.afterLater).toEqual({ opened_on: "2026-11-04" });
    expect(outcome.afterEarlier).toEqual({ opened_on: "2026-10-28" });
  });

  it("serie ogni 2 settimane (passo 2 della demo)", async () => {
    const outcome = await inUserA(db, async (tx) => {
      await prepare(tx);
      const created = await createAppointment(
        tx,
        PRACTICE_A,
        clock,
        seduta({ day: "2026-11-04", time: "12:00", repeat: { intervalWeeks: 2, count: 3, excludedDays: [] } }),
      );
      return {
        created,
        rows: await tx.query<{ id: string; starts_at: Date; series_id: string; status_changed_at: Date; status: string }>(
          "select id, starts_at, series_id, status_changed_at, status from public.appointments where series_id = $1 order by starts_at",
          [created.seriesId],
        ),
        series: await tx.query("select * from public.appointment_series where id = $1", [created.seriesId]),
      };
    });
    expect(outcome.created.seriesId).toEqual(expect.any(String));
    expect(outcome.rows.map((r) => [todayRome(r.starts_at), romeTime(r.starts_at), iso(r.starts_at)])).toEqual([
      ["2026-11-04", "12:00", "2026-11-04T11:00:00.000Z"],
      ["2026-11-18", "12:00", "2026-11-18T11:00:00.000Z"],
      ["2026-12-02", "12:00", "2026-12-02T11:00:00.000Z"],
    ]);
    expect(outcome.rows.map((r) => r.id)).toEqual(outcome.created.appointments.map((a) => a.id));
    expect(outcome.rows.every((r) => iso(r.status_changed_at) === "2026-11-04T07:30:00.000Z")).toBe(true);
    expect(outcome.series).toHaveLength(1);
    expect(outcome.series[0]).toMatchObject({
      practice_id: PRACTICE_A,
      weekday: 3,
      local_time: "12:00:00",
      interval_weeks: 2,
      count: 3,
      created_by: USER_A,
    });
  });

  it("una serie settimanale delle 09:00 resta alle 09:00 dopo il cambio d'ora", async () => {
    const outcome = await inUserA(db, async (tx) => {
      await prepare(tx);
      const created = await createAppointment(
        tx,
        PRACTICE_A,
        clock,
        seduta({ day: "2026-10-19", time: "09:00", repeat: { intervalWeeks: 1, count: 2, excludedDays: [] } }),
      );
      const [series] = await tx.query("select weekday, local_time from public.appointment_series where id = $1", [
        created.seriesId,
      ]);
      return { created, series };
    });
    expect(outcome.created.appointments.map((a) => a.startsAt.toISOString())).toEqual([
      "2026-10-19T07:00:00.000Z",
      "2026-10-26T08:00:00.000Z",
    ]);
    expect(outcome.series).toEqual({ weekday: 1, local_time: "09:00:00" });
  });

  it("date escluse: una data sola non fa una serie, nessuna data è un errore", async () => {
    const outcome = await inUserA(db, async (tx) => {
      await prepare(tx);
      const series = { day: "2026-11-04", time: "12:00" };
      const start = await counts(tx);
      const single = await createAppointment(
        tx,
        PRACTICE_A,
        clock,
        seduta({ ...series, repeat: { intervalWeeks: 2, count: 3, excludedDays: ["2026-11-04", "2026-12-02"] } }),
      );
      const afterSingle = await counts(tx);
      const two = await createAppointment(
        tx,
        PRACTICE_A,
        clock,
        seduta({ ...series, time: "15:00", repeat: { intervalWeeks: 2, count: 3, excludedDays: ["2026-11-18", "2026-11-05"] } }),
      );
      const [twoSeries] = await tx.query("select count from public.appointment_series where id = $1", [two.seriesId]);
      const beforeNone = await counts(tx);
      const none = await formFailure(
        createAppointment(
          tx,
          PRACTICE_A,
          clock,
          seduta({ ...series, repeat: { intervalWeeks: 2, count: 2, excludedDays: ["2026-11-04", "2026-11-18"] } }),
        ),
      );
      return { start, single, afterSingle, two, twoSeries, beforeNone, none, afterNone: await counts(tx) };
    });
    expect(outcome.single.seriesId).toBeNull();
    expect(outcome.single.appointments.map((a) => a.startsAt.toISOString())).toEqual(["2026-11-18T11:00:00.000Z"]);
    expect(outcome.afterSingle).toEqual({ ...outcome.start, appointments: outcome.start.appointments + 1 });
    // Un giorno escluso che non è della serie non toglie niente.
    expect(outcome.two.appointments.map((a) => a.startsAt.toISOString())).toEqual([
      "2026-11-04T14:00:00.000Z",
      "2026-12-02T14:00:00.000Z",
    ]);
    expect(outcome.twoSeries).toEqual({ count: 2 });
    expect(outcome.none).toEqual({ ok: false, refused: true, message: NO_DATES, fieldErrors: { "repeat.excludedDays": NO_DATES } });
    expect(outcome.afterNone).toEqual(outcome.beforeNone);
  });

  it("una fine alle 00:00 è rifiutata prima del database, anche il 25/10", async () => {
    const outcome = await inUserA(db, async (tx) => {
      await prepare(tx);
      const before = await counts(tx);
      await expectDomainError(createAppointment(tx, PRACTICE_A, clock, seduta({ day: "2026-11-04", time: "23:15" })), SAME_DAY, "time");
      await expectDomainError(createAppointment(tx, PRACTICE_A, clock, seduta({ day: "2026-10-25", time: "23:15" })), SAME_DAY, "time");
      // In una serie basta una data.
      await expectDomainError(
        createAppointment(
          tx,
          PRACTICE_A,
          clock,
          seduta({ day: "2026-10-18", time: "23:15", repeat: { intervalWeeks: 1, count: 2, excludedDays: [] } }),
        ),
        SAME_DAY,
        "time",
      );
      // 02:30 del 28/03/2027 a Roma non esiste.
      await expectDomainError(
        createAppointment(tx, PRACTICE_A, clock, seduta({ day: "2027-03-28", time: "02:30" })),
        "Valore non valido",
        "time",
      );
      const afterRefusals = await counts(tx);
      const late = await book(tx, seduta({ day: "2026-11-04", time: "23:00" }));
      const lateDst = await book(tx, seduta({ day: "2026-10-25", time: "23:00" }));
      return {
        before,
        afterRefusals,
        late: await appointmentRow(tx, late),
        lateDst: await appointmentRow(tx, lateDst),
      };
    });
    expect(outcome.afterRefusals).toEqual(outcome.before);
    expect([iso(outcome.late?.starts_at), iso(outcome.late?.ends_at)]).toEqual([
      "2026-11-04T22:00:00.000Z",
      "2026-11-04T22:45:00.000Z",
    ]);
    // Il 25/10 dura 25 ore: le 23:00 di Roma sono le 22:00 UTC, la fine le 23:45 di Roma.
    expect([iso(outcome.lateDst?.starts_at), iso(outcome.lateDst?.ends_at)]).toEqual([
      "2026-10-25T22:00:00.000Z",
      "2026-10-25T22:45:00.000Z",
    ]);
  });

  it("paziente archiviato, ciclo di un altro paziente, prestazione archiviata e ciclo chiuso", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const { firstVisitId } = await prepare(tx);
      const archived = await newPatient(tx, "Carla", "Bianchi");
      await tx.query("update public.patients set archived_at = '2026-11-01T10:00:00Z' where id = $1", [archived]);
      const before = await counts(tx);
      await expectDomainError(
        createAppointment(tx, PRACTICE_A, clock, forPatient(archived, { cycle: { kind: "new" } })),
        ARCHIVED,
        "patient",
      );
      await expectDomainError(createAppointment(tx, PRACTICE_A, clock, forPatient(PATIENT_A2, {})), NOT_ALLOWED, "cycle");
      await expectDomainError(
        createAppointment(tx, PRACTICE_A, clock, forPatient("a0000000-0000-4000-8000-0000000002ff", { cycle: { kind: "new" } })),
        NOT_ALLOWED,
        "patient",
      );
      await tx.query("update public.services set archived_at = '2026-11-01T10:00:00Z' where id = $1", [firstVisitId]);
      await expectDomainError(
        createAppointment(tx, PRACTICE_A, clock, seduta({ serviceId: firstVisitId })),
        NOT_ALLOWED,
        "serviceId",
      );
      await tx.query(
        "update public.treatment_cycles set status = 'closed', closed_on = '2026-11-01', outcome = 'raggiunto' where id = $1",
        [CYCLE_A],
      );
      await expectDomainError(createAppointment(tx, PRACTICE_A, clock, seduta()), NOT_ALLOWED, "cycle");
      return { before, after: await counts(tx) };
    });
    expect(outcome.after).toEqual(outcome.before);
  });

  it.each([
    ["paziente mancante", { patient: undefined }, "patient", "Scegli il paziente."],
    ["paziente senza id", { patient: { kind: "existing" } }, "patient.patientId", "Scegli il paziente."],
    ["prestazione mancante", { serviceId: undefined }, "serviceId", "Scegli la prestazione."],
    ["prestazione che non è un uuid", { serviceId: "seduta" }, "serviceId", "Scegli la prestazione."],
    ["data come nel campo", { day: "09/11/2026" }, "day", "Scrivi la data nel formato 22/10/2026."],
    ["data che non esiste", { day: "2026-02-30" }, "day", "Scrivi la data nel formato 22/10/2026."],
    ["ora fuori dai quarti", { time: "09:10" }, "time", "Scegli un orario a passi di 15 minuti."],
    ["ora 24:00", { time: "24:00" }, "time", "Scegli un orario a passi di 15 minuti."],
    ["durata di 20 minuti", { durationMin: 20 }, "durationMin", "Valore non valido"],
    ["durata di 135 minuti", { durationMin: 135 }, "durationMin", "Valore non valido"],
    ["prezzo negativo", { priceCents: -1 }, "priceCents", "Valore non valido"],
    ["prezzo oltre il massimo", { priceCents: 1_000_000 }, "priceCents", "Valore non valido"],
    ["stato saltato", { status: "saltato" }, "status", "Valore non valido"],
    ["note di 301 caratteri", { notes: "a".repeat(301) }, "notes", "Massimo 300 caratteri."],
    ["ciclo senza tipo", { cycle: {} }, "cycle.kind", "Valore non valido"],
    ["ripetizione ogni 5 settimane", { repeat: { intervalWeeks: 5, count: 3, excludedDays: [] } }, "repeat.intervalWeeks", "Valore non valido"],
    ["ripetizione di 13 sedute", { repeat: { intervalWeeks: 2, count: 13, excludedDays: [] } }, "repeat.count", "Valore non valido"],
    ["ripetizione di 1 seduta", { repeat: { intervalWeeks: 2, count: 1, excludedDays: [] } }, "repeat.count", "Valore non valido"],
    ["ripetizione senza date escluse", { repeat: { intervalWeeks: 2, count: 3 } }, "repeat.excludedDays", "Valore non valido"],
    ["paziente nuovo con il codice fiscale", { patient: { ...ELISA, taxCode: "FNTLSE64E42X999X" } }, "patient", "Valore non valido"],
    ["chiave in più", { seriesId: "a0000000-0000-4000-8000-000000000501" }, "", "Valore non valido"],
  ])("%s è rifiutato sul suo campo", async (_label, patch, field, message) => {
    const outcome = await inUserA(db, async (tx) => {
      await prepare(tx);
      const before = await counts(tx);
      const failure = await formFailure(createAppointment(tx, PRACTICE_A, clock, seduta(patch)));
      return { failure, before, after: await counts(tx) };
    });
    expect(outcome.failure.message).toBe(message);
    if (field === "") expect(outcome.failure.fieldErrors).toBeUndefined();
    else expect(outcome.failure.fieldErrors?.[field]).toBe(message);
    expect(outcome.after).toEqual(outcome.before);
  });

  it("le note si salvano senza spazi ai lati, e vuote diventano null", async () => {
    const rows = await inUserA(db, async (tx) => {
      await prepare(tx);
      const withNotes = await book(tx, seduta({ notes: "  Porta la risonanza  " }));
      const blank = await book(tx, seduta({ time: "10:00", notes: "   " }));
      return [await appointmentRow(tx, withNotes), await appointmentRow(tx, blank)];
    });
    expect(rows.map((r) => r?.notes)).toEqual(["Porta la risonanza", null]);
  });

  it("come uB con PATIENT_A1 fallisce e non scrive niente, né in A né in B", async () => {
    const before = await inUserA(db, (tx) => counts(tx));
    // asUserB conferma la transazione: se il comando scrivesse prima di fermarsi, la riga resterebbe.
    const beforeB = await asUserB(db, async (tx) => {
      const own = await counts(tx, PRACTICE_B);
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        await expectDomainError(createAppointment(tx, practiceId, clock, seduta()), NOT_ALLOWED, "patient");
        await expectDomainError(
          createAppointment(tx, practiceId, clock, { ...seduta(), patient: ELISA, cycle: { kind: "new" } }),
          NOT_ALLOWED,
          "serviceId",
        );
      }
      expect(await counts(tx, PRACTICE_B)).toEqual(own);
      return own;
    });
    expect(await inUserA(db, (tx) => counts(tx))).toEqual(before);
    expect(await inRollback(db, "B", (tx) => counts(tx, PRACTICE_B))).toEqual(beforeB);
    // Controllo: con gli id di B il comando di uB riesce.
    const own = await inRollback(db, "B", (tx) =>
      createAppointment(tx, PRACTICE_B, clock, {
        ...seduta(),
        patient: { kind: "existing", patientId: PATIENT_B1 },
        serviceId: SERVICE_B,
        cycle: { kind: "existing", cycleId: CYCLE_B },
      }),
    );
    expect(own.appointments).toHaveLength(1);
  });
});

describe("loadBusy", () => {
  it("raggruppa per giorno di Roma gli appuntamenti attivi, con Cognome Nome e orario", async () => {
    const outcome = await inUserA(db, async (tx) => {
      await prepare(tx);
      const lateDst = await book(tx, seduta({ day: "2026-10-25", time: "23:00" }));
      const afterMidnight = await book(tx, seduta({ day: "2026-10-26", time: "00:30" }));
      const skipped = await book(tx, seduta({ day: "2026-10-26", time: "10:00" }));
      await tx.query("update public.appointments set status = 'saltato' where id = $1", [skipped]);
      const done = await book(tx, seduta({ day: "2026-10-26", time: "11:00", status: "fatto" }));
      const days = ["2026-10-05", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-25"];
      return {
        ids: { lateDst, afterMidnight, done },
        busy: await loadBusy(tx, PRACTICE_A, days),
        ignoring: await loadBusy(tx, PRACTICE_A, ["2026-10-05"], APPOINTMENT_A),
        none: await loadBusy(tx, PRACTICE_A, []),
      };
    });
    expect([...outcome.busy.keys()]).toEqual(["2026-10-05", "2026-10-25", "2026-10-26", "2026-10-27"]);
    expect(outcome.busy.get("2026-10-05")).toEqual([
      { id: APPOINTMENT_A, startMin: 540, endMin: 585, label: "Ferrari Giulia, 09:00-09:45" },
    ]);
    expect(outcome.busy.get("2026-10-25")).toEqual([
      { id: outcome.ids.lateDst, startMin: 1380, endMin: 1425, label: "Ferrari Giulia, 23:00-23:45" },
    ]);
    expect(outcome.busy.get("2026-10-26")).toEqual([
      { id: outcome.ids.afterMidnight, startMin: 30, endMin: 75, label: "Ferrari Giulia, 00:30-01:15" },
      { id: outcome.ids.done, startMin: 660, endMin: 705, label: "Ferrari Giulia, 11:00-11:45" },
    ]);
    expect(outcome.busy.get("2026-10-27")).toEqual([]);
    expect(outcome.ignoring.get("2026-10-05")).toEqual([]);
    expect(outcome.none.size).toBe(0);
  });

  it("uB non vede gli appuntamenti di A, nemmeno con lo studio di A", async () => {
    const busy = await inRollback(db, "B", async (tx) => ({
      a: await loadBusy(tx, PRACTICE_A, ["2026-10-05"]),
      b: await loadBusy(tx, PRACTICE_B, ["2026-10-05"]),
    }));
    expect(busy.a.get("2026-10-05")).toEqual([]);
    expect(busy.b.get("2026-10-05")?.map((b) => b.label)).toEqual(["Conti Elena, 09:00-09:45"]);
  });
});

describe("previewAppointment", () => {
  /** Morelli Anna mercoledì 4/11 10:00-10:30, confermata: l'id del suo appuntamento. */
  async function withAnna(tx: Tx): Promise<string> {
    const { checkId } = await prepare(tx);
    const anna = await newPatient(tx, "Anna", "Morelli");
    return book(
      tx,
      forPatient(anna, {
        serviceId: checkId,
        day: "2026-11-04",
        time: "10:00",
        durationMin: 30,
        priceCents: 4500,
        cycle: { kind: "new" },
        status: "confermato",
      }),
    );
  }

  const preview = (tx: Tx, patch: Record<string, unknown> = {}) =>
    previewAppointment(tx, PRACTICE_A, clock, { day: "2026-11-04", time: "10:15", durationMin: 45, ...patch });

  it("avvisa di una sovrapposizione e degli orari chiusi, senza bloccare", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const annaId = await withAnna(tx);
      return {
        overlap: await preview(tx),
        touching: await preview(tx, { time: "10:30" }),
        ignoring: await preview(tx, { ignoreAppointmentId: annaId }),
        lunch: await preview(tx, { time: "12:30", durationMin: 60 }),
        sunday: await preview(tx, { day: "2026-11-08", time: "10:00" }),
        both: await preview(tx, { time: "08:45", durationMin: 120 }),
      };
    });
    expect(outcome.overlap).toEqual({ warnings: [ANNA_OVERLAP], pastStart: false, endsNextDay: false, rows: [] });
    expect(outcome.touching.warnings).toEqual([]);
    expect(outcome.ignoring.warnings).toEqual([]);
    expect(outcome.lunch.warnings).toEqual([OUTSIDE]);
    expect(outcome.sunday.warnings).toEqual([OUTSIDE]);
    expect(outcome.both.warnings).toEqual([ANNA_OVERLAP, OUTSIDE]);
  });

  it("un saltato o un annullato liberano l'orario", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const annaId = await withAnna(tx);
      await tx.query("update public.appointments set status = 'saltato' where id = $1", [annaId]);
      const skipped = await preview(tx);
      await tx.query("update public.appointments set status = 'annullato', cancel_reason = 'paziente' where id = $1", [annaId]);
      return { skipped, cancelled: await preview(tx) };
    });
    expect(outcome.skipped.warnings).toEqual([]);
    expect(outcome.cancelled.warnings).toEqual([]);
  });

  it("una riga per data della serie, con lo stato di ognuna", async () => {
    const outcome = await inUserA(db, async (tx) => {
      await withAnna(tx);
      return {
        wednesday: await preview(tx, { repeat: { intervalWeeks: 1, count: 3 } }),
        saturday: await preview(tx, { day: "2026-11-07", time: "15:00", repeat: { intervalWeeks: 1, count: 2 } }),
        sunday: await preview(tx, { day: "2026-11-08", time: "10:00", repeat: { intervalWeeks: 1, count: 2 } }),
      };
    });
    expect(outcome.wednesday.rows).toEqual([
      { day: "2026-11-04", time: "10:15", state: "sovrapposto", label: "Si sovrappone a Morelli Anna, 10:00-10:30" },
      { day: "2026-11-11", time: "10:15", state: "libero", label: "Libero" },
      { day: "2026-11-18", time: "10:15", state: "libero", label: "Libero" },
    ]);
    expect(outcome.wednesday.warnings).toEqual([ANNA_OVERLAP]);
    expect(outcome.saturday.rows[0]).toEqual({ day: "2026-11-07", time: "15:00", state: "fuori_orario", label: "Fuori orario" });
    expect(outcome.sunday.rows).toEqual([
      { day: "2026-11-08", time: "10:00", state: "giorno_chiuso", label: "Giorno chiuso" },
      { day: "2026-11-15", time: "10:00", state: "giorno_chiuso", label: "Giorno chiuso" },
    ]);
  });

  it("dice se l'orario è già passato e se finisce nel giorno dopo", async () => {
    const outcome = await inUserA(db, async (tx) => {
      await prepare(tx);
      return {
        past: await preview(tx, { time: "08:00" }),
        now: await preview(tx, { time: "08:30" }),
        yesterday: await preview(tx, { day: "2026-11-03", time: "18:00" }),
        midnight: await preview(tx, { time: "23:15" }),
        beforeMidnight: await preview(tx, { time: "23:00" }),
      };
    });
    expect(outcome.past.pastStart).toBe(true);
    expect(outcome.now.pastStart).toBe(false);
    expect(outcome.yesterday.pastStart).toBe(true);
    expect(outcome.midnight).toMatchObject({ endsNextDay: true, pastStart: false });
    expect(outcome.beforeMidnight.endsNextDay).toBe(false);
  });

  it("un input fuori forma è rifiutato sul suo campo", async () => {
    const outcome = await inUserA(db, async (tx) => ({
      quarter: await formFailure(preview(tx, { time: "10:10" })),
      excluded: await formFailure(preview(tx, { repeat: { intervalWeeks: 1, count: 2, excludedDays: [] } })),
      missingDay: await formFailure(preview(tx, { day: undefined })),
    }));
    expect(outcome.quarter.fieldErrors).toEqual({ time: "Scegli un orario a passi di 15 minuti." });
    expect(outcome.excluded.message).toBe("Valore non valido");
    expect(outcome.missingDay.fieldErrors).toEqual({ day: "Scrivi la data nel formato 22/10/2026." });
  });

  it("come uB l'anteprima non vede gli appuntamenti né gli orari di A", async () => {
    const outcome = await inRollback(db, "B", async (tx) => {
      const input = { day: "2026-10-05", time: "09:00", durationMin: 45 };
      return {
        a: await previewAppointment(tx, PRACTICE_A, clock, input),
        b: await previewAppointment(tx, PRACTICE_B, clock, input),
      };
    });
    expect(outcome.a.warnings).toEqual([OUTSIDE]);
    expect(outcome.b.warnings).toEqual(["Si sovrappone a Conti Elena, 09:00-09:45."]);
  });
});

describe("bookingDefaults", () => {
  it("dopo la prima visita fatta propone la seduta nel ciclo aperto, con le sedute che mancano", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const { firstVisitId } = await prepare(tx);
      const patientId = await newPatient(tx, "Marco", "Bellandi");
      const created = await createAppointment(
        tx,
        PRACTICE_A,
        clock,
        forPatient(patientId, {
          serviceId: firstVisitId,
          day: "2026-11-02",
          time: "10:00",
          durationMin: 60,
          cycle: { kind: "new" },
          status: "fatto",
        }),
      );
      return { patientId, cycleId: created.cycleId, defaults: await bookingDefaults(tx, PRACTICE_A, clock, { patientId }) };
    });
    expect(outcome.defaults).toMatchObject({
      patient: { id: outcome.patientId, firstName: "Marco", lastName: "Bellandi", hasDoneAppointment: true, archived: false },
      serviceId: SERVICE_A,
      cycle: { kind: "existing", cycleId: outcome.cycleId, title: "Nuovo ciclo, novembre 2026", cycleKind: "trattamento" },
      seriesCount: 3,
      intervalWeeks: 2,
    });
  });

  it("un paziente senza appuntamenti comincia con la prima visita in un ciclo nuovo", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const { firstVisitId } = await prepare(tx);
      const patientId = await newPatient(tx, "Elisa", "Fontana");
      const defaults = await bookingDefaults(tx, PRACTICE_A, clock, { patientId });
      // Previste e intervallo vengono da clinical_settings.
      await tx.query(
        "update public.clinical_settings set default_expected_sessions = 6, default_session_interval_weeks = 3 where practice_id = $1",
        [PRACTICE_A],
      );
      return { firstVisitId, defaults, changed: await bookingDefaults(tx, PRACTICE_A, clock, { patientId }) };
    });
    expect(outcome.defaults).toMatchObject({
      serviceId: outcome.firstVisitId,
      cycle: { kind: "new" },
      seriesCount: 4,
      intervalWeeks: 2,
    });
    expect(outcome.changed).toMatchObject({ seriesCount: 6, intervalWeeks: 3 });
  });

  it("con un mantenimento aperto propone il controllo, e senza previste 4 sedute", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const { checkId } = await prepare(tx);
      const patientId = await newPatient(tx, "Roberto", "Galli");
      const created = await createAppointment(
        tx,
        PRACTICE_A,
        clock,
        forPatient(patientId, { serviceId: checkId, day: "2026-11-02", durationMin: 30, cycle: { kind: "new" }, status: "fatto" }),
      );
      return { checkId, cycleId: created.cycleId, defaults: await bookingDefaults(tx, PRACTICE_A, clock, { patientId }) };
    });
    expect(outcome.defaults).toMatchObject({
      serviceId: outcome.checkId,
      cycle: { kind: "existing", cycleId: outcome.cycleId, cycleKind: "mantenimento" },
      seriesCount: 4,
    });
  });

  it("un paziente che non c'è, o di A letto da uB, risponde Operazione non permessa", async () => {
    await inUserA(db, (tx) =>
      expectDomainError(
        bookingDefaults(tx, PRACTICE_A, clock, { patientId: "a0000000-0000-4000-8000-0000000002ff" }),
        NOT_ALLOWED,
        "patient",
      ),
    );
    await inRollback(db, "B", async (tx) => {
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        await expectDomainError(bookingDefaults(tx, practiceId, clock, { patientId: PATIENT_A1 }), NOT_ALLOWED, "patient");
      }
    });
  });
});

describe("suggestStart", () => {
  /** Gli appuntamenti del D0 del seed: 09:00-09:45, 10:00-10:30, 11:00-12:00, 15:00-15:45, 16:00-16:45. */
  async function seedDay(tx: Tx): Promise<void> {
    await prepare(tx);
    for (const [time, durationMin] of [
      ["09:00", 45],
      ["10:00", 30],
      ["11:00", 60],
      ["15:00", 45],
      ["16:00", 45],
    ] as const) {
      await book(tx, seduta({ day: "2026-11-04", time, durationMin }));
    }
    // Un annullato alle 12:00 non occupa l'orario.
    const cancelled = await book(tx, seduta({ day: "2026-11-04", time: "12:00" }));
    await tx.query("update public.appointments set status = 'annullato', cancel_reason = 'studio' where id = $1", [cancelled]);
  }

  const suggestAt = (tx: Tx, at: string, durationMin = 45) => suggestStart(tx, PRACTICE_A, fixedClock(at), { durationMin });

  it("il primo quarto d'ora libero di oggi, poi la prima apertura del giorno aperto dopo", async () => {
    const outcome = await inUserA(db, async (tx) => {
      await seedDay(tx);
      return {
        morning: await suggestAt(tx, "2026-11-04T08:30:00+01:00"),
        lunch: await suggestAt(tx, "2026-11-04T12:30:00+01:00"),
        evening: await suggestAt(tx, "2026-11-04T19:00:00+01:00"),
        seconds: await suggestAt(tx, "2026-11-05T09:00:20+01:00"),
        saturday: await suggestAt(tx, "2026-11-07T14:00:00+01:00"),
      };
    });
    expect(outcome.morning).toEqual({ day: "2026-11-04", time: "12:00" });
    expect(outcome.lunch).toEqual({ day: "2026-11-04", time: "16:45" });
    expect(outcome.evening).toEqual({ day: "2026-11-05", time: "09:00" });
    // Da adesso arrotondato in su: alle 09:00:20 le 09:00 sono già passate.
    expect(outcome.seconds).toEqual({ day: "2026-11-05", time: "09:15" });
    // Il sabato pomeriggio è chiuso e la domenica pure: lunedì alle 09:00.
    expect(outcome.saturday).toEqual({ day: "2026-11-09", time: "09:00" });
  });

  it("senza orari propone il giorno dopo all'inizio della scelta dell'ora", async () => {
    const suggestion = await inUserA(db, async (tx) => {
      await prepare(tx);
      await saveOpeningHours(tx, PRACTICE_A, clock, hours({}));
      return suggestAt(tx, "2026-11-04T08:30:00+01:00");
    });
    expect(suggestion).toEqual({ day: "2026-11-05", time: "07:00" });
  });

  it("una durata fuori elenco è rifiutata", async () => {
    const failure = await inUserA(db, (tx) => formFailure(suggestStart(tx, PRACTICE_A, clock, { durationMin: 20 })));
    expect(failure.fieldErrors).toEqual({ durationMin: "Valore non valido" });
  });
});

describe("nextSession", () => {
  /** Una seduta fatta (di default giovedì 22/10 alle 09:00), prima di un ciclo di trattamento da 4. */
  async function doneSession(
    tx: Tx,
    day = "2026-10-22",
    time = "09:00",
  ): Promise<{ patientId: string; cycleId: string; doneId: string }> {
    await prepare(tx);
    const patientId = await newPatient(tx, "Marco", "Bellandi");
    const created = await createAppointment(
      tx,
      PRACTICE_A,
      clock,
      forPatient(patientId, { day, time, cycle: { kind: "new" }, status: "fatto" }),
    );
    return { patientId, cycleId: created.cycleId, doneId: created.appointments[0]?.id ?? "" };
  }

  const inCycle = (s: { patientId: string; cycleId: string }, patch: Record<string, unknown>) =>
    forPatient(s.patientId, { cycle: { kind: "existing", cycleId: s.cycleId }, ...patch });

  const PROPOSAL = {
    kind: "proposal",
    text: "Prossima seduta: giovedì 5 novembre alle 09:00",
    day: "2026-11-05",
    time: "09:00",
    serviceId: SERVICE_A,
    durationMin: 45,
    priceCents: 6000,
  };

  it("una seduta già prenotata dopo questa e da oggi è la prossima", async () => {
    const next = await inUserA(db, async (tx) => {
      const s = await doneSession(tx);
      await book(tx, inCycle(s, { day: "2026-11-17", time: "10:00" }));
      await book(tx, inCycle(s, { day: "2026-11-10", time: "09:00" }));
      return nextSession(tx, PRACTICE_A, clock, { appointmentId: s.doneId });
    });
    expect(next).toEqual({ kind: "booked", text: "Prossima seduta già fissata: martedì 10 novembre alle 09:00" });
  });

  it("una seduta prenotata prima di oggi, o una annullata, non è la prossima", async () => {
    const next = await inUserA(db, async (tx) => {
      const s = await doneSession(tx);
      await book(tx, inCycle(s, { day: "2026-11-03", time: "09:00" }));
      const cancelled = await book(tx, inCycle(s, { day: "2026-11-10", time: "09:00" }));
      await tx.query("update public.appointments set status = 'annullato', cancel_reason = 'paziente' where id = $1", [cancelled]);
      return nextSession(tx, PRACTICE_A, clock, { appointmentId: s.doneId });
    });
    expect(next).toEqual(PROPOSAL);
  });

  it("senza prossima seduta propone la stessa ora dopo l'intervallo, spostata al primo orario libero", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const s = await doneSession(tx);
      const free = await nextSession(tx, PRACTICE_A, clock, { appointmentId: s.doneId });
      // Il 5/11 09:00-09:45 occupato da un'altra paziente.
      await book(tx, seduta({ day: "2026-11-05", time: "09:00" }));
      return { free, busy: await nextSession(tx, PRACTICE_A, clock, { appointmentId: s.doneId }) };
    });
    expect(outcome.free).toEqual(PROPOSAL);
    expect(outcome.busy).toEqual({ ...PROPOSAL, text: "Prossima seduta: giovedì 5 novembre alle 09:45", time: "09:45" });
  });

  it("un giorno chiuso passa al giorno aperto dopo; senza orari resta l'ora di partenza", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const s = await doneSession(tx);
      await saveOpeningHours(tx, PRACTICE_A, clock, hours({ 1: FULL_DAY, 2: FULL_DAY, 3: FULL_DAY, 5: [AFTERNOON] }));
      const thursdayClosed = await nextSession(tx, PRACTICE_A, clock, { appointmentId: s.doneId });
      await saveOpeningHours(tx, PRACTICE_A, clock, hours({}));
      return { thursdayClosed, noHours: await nextSession(tx, PRACTICE_A, clock, { appointmentId: s.doneId }) };
    });
    expect(outcome.thursdayClosed).toEqual({
      ...PROPOSAL,
      text: "Prossima seduta: venerdì 6 novembre alle 14:30",
      day: "2026-11-06",
      time: "14:30",
    });
    expect(outcome.noHours).toEqual(PROPOSAL);
  });

  it("una seduta segnata fatta in ritardo non propone un orario già passato", async () => {
    const outcome = await inUserA(db, async (tx) => {
      // Fatta giovedì 1/10 alle 09:00: giorno + 2 settimane è il 15/10, prima di oggi (4/11).
      const s = await doneSession(tx, "2026-10-01");
      const at = (instant: string) => nextSession(tx, PRACTICE_A, fixedClock(instant), { appointmentId: s.doneId });
      const early = await at("2026-11-04T08:30:00+01:00");
      const seconds = await at("2026-11-04T10:00:20+01:00");
      const evening = await at("2026-11-04T19:00:00+01:00");
      await saveOpeningHours(tx, PRACTICE_A, clock, hours({}));
      return { early, seconds, evening, lateNoHours: await at("2026-11-04T23:50:00+01:00") };
    });
    // Oggi alla stessa ora, che non è ancora passata.
    expect(outcome.early).toEqual({
      ...PROPOSAL,
      text: "Prossima seduta: mercoledì 4 novembre alle 09:00",
      day: "2026-11-04",
    });
    // Da adesso arrotondato in su al quarto d'ora: alle 10:00:20 le 10:00 sono già passate.
    expect(outcome.seconds).toEqual({
      ...PROPOSAL,
      text: "Prossima seduta: mercoledì 4 novembre alle 10:15",
      day: "2026-11-04",
      time: "10:15",
    });
    // Alle 19:00 una seduta da 45 non sta più nella fascia che chiude alle 19:30: il giorno aperto dopo.
    expect(outcome.evening).toEqual(PROPOSAL);
    // Alle 23:50 oggi non resta nessun quarto d'ora: senza orari, domani alla stessa ora.
    expect(outcome.lateNoHours).toEqual(PROPOSAL);
  });

  it("giorno più intervallo che cade oggi tiene la stessa ora, ma non prima di adesso", async () => {
    const outcome = await inUserA(db, async (tx) => {
      // Fatta mercoledì 21/10 alle 15:00: giorno + 2 settimane è oggi, mercoledì 4/11.
      const s = await doneSession(tx, "2026-10-21", "15:00");
      const at = (instant: string) => nextSession(tx, PRACTICE_A, fixedClock(instant), { appointmentId: s.doneId });
      return { before: await at("2026-11-04T08:30:00+01:00"), after: await at("2026-11-04T15:05:00+01:00") };
    });
    expect(outcome.before).toEqual({
      ...PROPOSAL,
      text: "Prossima seduta: mercoledì 4 novembre alle 15:00",
      day: "2026-11-04",
      time: "15:00",
    });
    expect(outcome.after).toEqual({
      ...PROPOSAL,
      text: "Prossima seduta: mercoledì 4 novembre alle 15:15",
      day: "2026-11-04",
      time: "15:15",
    });
  });

  it("con le sedute previste già tutte in agenda è l'ultima", async () => {
    const next = await inUserA(db, async (tx) => {
      await prepare(tx);
      const patientId = await newPatient(tx, "Marco", "Bellandi");
      const first = await createAppointment(
        tx,
        PRACTICE_A,
        clock,
        forPatient(patientId, { day: "2026-10-01", time: "09:00", cycle: { kind: "new" }, status: "fatto" }),
      );
      const s = { patientId, cycleId: first.cycleId };
      await book(tx, inCycle(s, { day: "2026-10-08", time: "09:00", status: "fatto" }));
      await book(tx, inCycle(s, { day: "2026-10-15", time: "09:00", status: "fatto" }));
      const last = await book(tx, inCycle(s, { day: "2026-10-22", time: "09:00", status: "fatto" }));
      return nextSession(tx, PRACTICE_A, clock, { appointmentId: last });
    });
    expect(next).toEqual({ kind: "last" });
  });

  it("nel mantenimento non c'è una proposta", async () => {
    const next = await inUserA(db, async (tx) => {
      const { checkId } = await prepare(tx);
      const patientId = await newPatient(tx, "Roberto", "Galli");
      const id = await book(
        tx,
        forPatient(patientId, {
          serviceId: checkId,
          day: "2026-10-22",
          time: "09:00",
          durationMin: 30,
          cycle: { kind: "new" },
          status: "fatto",
        }),
      );
      return nextSession(tx, PRACTICE_A, clock, { appointmentId: id });
    });
    expect(next).toEqual({ kind: "none" });
  });

  it("un appuntamento che non c'è, o di A letto da uB, risponde Operazione non permessa", async () => {
    await inUserA(db, (tx) =>
      expectDomainError(
        nextSession(tx, PRACTICE_A, clock, { appointmentId: "a0000000-0000-4000-8000-0000000005ff" }),
        NOT_ALLOWED,
      ),
    );
    await inRollback(db, "B", async (tx) => {
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        await expectDomainError(nextSession(tx, practiceId, clock, { appointmentId: APPOINTMENT_A }), NOT_ALLOWED);
      }
    });
  });
});
