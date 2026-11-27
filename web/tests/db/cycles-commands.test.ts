import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { openCycle } from "@/server/domain/cycles/commands";
import { getOpenCycle, listCycleAppointments } from "@/server/domain/cycles/queries";
import { createPatient } from "@/server/domain/patients/commands";
import { getPatientForBooking } from "@/server/domain/patients/queries";
import { APPOINTMENT_A, CYCLE_A, PATIENT_A1, PATIENT_A2, PATIENT_B1, PRACTICE_A, PRACTICE_B, SERVICE_A } from "./fixtures";
import { inRollback, inUserA, openTestDb } from "./helpers";

// Apertura del ciclo dall'agenda: un ciclo nuovo non comincia dopo il suo primo
// appuntamento, ha il titolo e le sedute previste di default, e un paziente ne ha uno aperto solo.

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

/** Il comando risponde con un DomainError di testo `message`: la transazione resta valida. */
async function expectDomainError(p: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
}

const ALREADY_OPEN = "Il paziente ha già un ciclo aperto.";

/** Un paziente adulto nuovo, senza cicli, creato come uA. */
async function newPatient(tx: Tx, lastName = "Bellandì"): Promise<string> {
  const { id } = await createPatient(tx, PRACTICE_A, clock, { firstName: "Marco", lastName, birthDate: "1979-03-09" });
  return id;
}

async function cycleRow(tx: Tx, id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx.query("select * from public.treatment_cycles where id = $1", [id]);
  return row;
}

async function countCycles(tx: Tx, practiceId = PRACTICE_A): Promise<number> {
  const [row] = await tx.query<{ n: number }>(
    "select count(*)::int as n from public.treatment_cycles where practice_id = $1",
    [practiceId],
  );
  return row?.n ?? -1;
}

describe("openCycle", () => {
  it("un ciclo di trattamento per un primo appuntamento futuro si apre oggi, con 4 sedute previste", async () => {
    const saved = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const { id } = await openCycle(tx, PRACTICE_A, clock, {
        patientId,
        kind: "trattamento",
        firstAppointmentDay: "2026-11-10",
      });
      return { id, patientId, row: await cycleRow(tx, id) };
    });
    expect(saved.row).toMatchObject({
      id: saved.id,
      practice_id: PRACTICE_A,
      patient_id: saved.patientId,
      kind: "trattamento",
      status: "open",
      expected_sessions: 4,
      opened_on: "2026-11-04",
      title: "Nuovo ciclo, novembre 2026",
      closed_on: null,
      outcome: null,
    });
  });

  it("un primo appuntamento nel passato porta l'apertura a quel giorno e il mese nel titolo", async () => {
    const row = await inUserA(db, async (tx) => {
      const { id } = await openCycle(tx, PRACTICE_A, clock, {
        patientId: await newPatient(tx),
        kind: "trattamento",
        firstAppointmentDay: "2026-10-20",
      });
      return cycleRow(tx, id);
    });
    expect(row).toMatchObject({ opened_on: "2026-10-20", title: "Nuovo ciclo, ottobre 2026" });
  });

  it("un primo appuntamento di oggi si apre oggi", async () => {
    const row = await inUserA(db, async (tx) => {
      const { id } = await openCycle(tx, PRACTICE_A, clock, {
        patientId: await newPatient(tx),
        kind: "trattamento",
        firstAppointmentDay: "2026-11-04",
      });
      return cycleRow(tx, id);
    });
    expect(row).toMatchObject({ opened_on: "2026-11-04", title: "Nuovo ciclo, novembre 2026" });
  });

  it("il mantenimento non ha sedute previste", async () => {
    const row = await inUserA(db, async (tx) => {
      const { id } = await openCycle(tx, PRACTICE_A, clock, {
        patientId: await newPatient(tx),
        kind: "mantenimento",
        firstAppointmentDay: "2026-11-10",
      });
      return cycleRow(tx, id);
    });
    expect(row).toMatchObject({ kind: "mantenimento", expected_sessions: null, status: "open" });
  });

  it("le sedute previste date dal chiamante vincono sul default dello studio", async () => {
    const rows = await inUserA(db, async (tx) => {
      const three = await openCycle(tx, PRACTICE_A, clock, {
        patientId: await newPatient(tx, "Uno"),
        kind: "trattamento",
        firstAppointmentDay: "2026-11-10",
        expectedSessions: 3,
      });
      // Il default viene da clinical_settings, non da una costante.
      await tx.query("update public.clinical_settings set default_expected_sessions = 6 where practice_id = $1", [
        PRACTICE_A,
      ]);
      const six = await openCycle(tx, PRACTICE_A, clock, {
        patientId: await newPatient(tx, "Due"),
        kind: "trattamento",
        firstAppointmentDay: "2026-11-10",
      });
      return { three: await cycleRow(tx, three.id), six: await cycleRow(tx, six.id) };
    });
    expect(rows.three?.expected_sessions).toBe(3);
    expect(rows.six?.expected_sessions).toBe(6);
  });

  it("il titolo dato (lo passa il seed) sostituisce quello di default", async () => {
    const row = await inUserA(db, async (tx) => {
      const { id } = await openCycle(tx, PRACTICE_A, clock, {
        patientId: await newPatient(tx),
        kind: "trattamento",
        firstAppointmentDay: "2026-11-10",
        title: "Dolore al ginocchio destro, novembre 2026",
      });
      return cycleRow(tx, id);
    });
    expect(row?.title).toBe("Dolore al ginocchio destro, novembre 2026");
  });

  it("un titolo di 80 caratteri passa, uno di 81 è rifiutato sul campo title", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const failure = await formFailure(
        openCycle(tx, PRACTICE_A, clock, {
          patientId,
          kind: "trattamento",
          firstAppointmentDay: "2026-11-10",
          title: "a".repeat(81),
        }),
      );
      expect(failure).toEqual({ ok: false, refused: true, message: "Massimo 80 caratteri.", fieldErrors: { title: "Massimo 80 caratteri." } });
      expect(await getOpenCycle(tx, PRACTICE_A, patientId)).toBeNull();

      const { id } = await openCycle(tx, PRACTICE_A, clock, {
        patientId,
        kind: "trattamento",
        firstAppointmentDay: "2026-11-10",
        title: "a".repeat(80),
      });
      expect((await cycleRow(tx, id))?.title).toBe("a".repeat(80));
    });
  });

  it.each([
    ["kind fuori elenco", { kind: "altro" }, "kind"],
    ["giorno scritto come nel campo", { firstAppointmentDay: "10/11/2026" }, "firstAppointmentDay"],
    ["giorno che non esiste", { firstAppointmentDay: "2026-02-30" }, "firstAppointmentDay"],
    ["sedute previste a 0", { expectedSessions: 0 }, "expectedSessions"],
    ["sedute previste a 21", { expectedSessions: 21 }, "expectedSessions"],
    ["sedute previste decimali", { expectedSessions: 2.5 }, "expectedSessions"],
    ["paziente che non è un uuid", { patientId: "non-un-uuid" }, "patientId"],
  ])("%s è rifiutato sul suo campo", async (_name, patch, field) => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const failure = await formFailure(
        openCycle(tx, PRACTICE_A, clock, { patientId, kind: "trattamento", firstAppointmentDay: "2026-11-10", ...patch }),
      );
      expect(Object.keys(failure.fieldErrors ?? {})).toEqual([field]);
      expect(await getOpenCycle(tx, PRACTICE_A, patientId)).toBeNull();
    });
  });

  it("rifiuta una chiave in più (stato, studio, sedute fatte) e non scrive niente", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const before = await countCycles(tx);
      for (const extra of [{ status: "closed" }, { practiceId: PRACTICE_B }, { openedOn: "2026-01-01" }]) {
        const failure = await formFailure(
          openCycle(tx, PRACTICE_A, clock, { patientId, kind: "trattamento", firstAppointmentDay: "2026-11-10", ...extra }),
        );
        expect(failure.ok).toBe(false);
      }
      expect(await countCycles(tx)).toBe(before);
    });
  });

  it("con un ciclo già aperto risponde che il paziente ne ha uno, e non scrive niente", async () => {
    await inUserA(db, async (tx) => {
      const before = await countCycles(tx);
      await expectDomainError(
        openCycle(tx, PRACTICE_A, clock, { patientId: PATIENT_A1, kind: "trattamento", firstAppointmentDay: "2026-11-10" }),
        ALREADY_OPEN,
      );
      await expectDomainError(
        openCycle(tx, PRACTICE_A, clock, { patientId: PATIENT_A1, kind: "mantenimento", firstAppointmentDay: "2026-11-10" }),
        ALREADY_OPEN,
      );
      expect(await countCycles(tx)).toBe(before);
      expect((await getOpenCycle(tx, PRACTICE_A, PATIENT_A1))?.id).toBe(CYCLE_A);
    });
  });

  it("dopo che il ciclo è stato aperto un secondo ciclo dello stesso paziente è rifiutato", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      await openCycle(tx, PRACTICE_A, clock, { patientId, kind: "trattamento", firstAppointmentDay: "2026-11-10" });
      await expectDomainError(
        openCycle(tx, PRACTICE_A, clock, { patientId, kind: "mantenimento", firstAppointmentDay: "2026-11-17" }),
        ALREADY_OPEN,
      );
    });
  });

  it("un paziente con il ciclo chiuso ne apre uno nuovo", async () => {
    const opened = await inUserA(db, async (tx) => {
      await tx.query(
        "update public.treatment_cycles set status = 'closed', closed_on = '2026-10-20', outcome = 'raggiunto' where id = $1",
        [CYCLE_A],
      );
      const { id } = await openCycle(tx, PRACTICE_A, clock, {
        patientId: PATIENT_A1,
        kind: "mantenimento",
        firstAppointmentDay: "2026-11-10",
      });
      return { id, open: await getOpenCycle(tx, PRACTICE_A, PATIENT_A1) };
    });
    expect(opened.open).toMatchObject({ id: opened.id, kind: "mantenimento", expectedSessions: null, openedOn: "2026-11-04" });
  });

  it("un paziente che non c'è risponde Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const before = await countCycles(tx);
      await expectDomainError(
        openCycle(tx, PRACTICE_A, clock, {
          patientId: "c0000000-0000-4000-8000-0000000000ff",
          kind: "trattamento",
          firstAppointmentDay: "2026-11-10",
        }),
        NOT_ALLOWED,
      );
      expect(await countCycles(tx)).toBe(before);
    });
  });

  it("come uB sugli id di A fallisce e non cambia niente", async () => {
    await inRollback(db, "B", async (tx) => {
      const before = await countCycles(tx, PRACTICE_B);
      // Il paziente di A senza ciclo, con lo studio di A e con lo studio di B.
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        await expectDomainError(
          openCycle(tx, practiceId, clock, { patientId: PATIENT_A2, kind: "trattamento", firstAppointmentDay: "2026-11-10" }),
          NOT_ALLOWED,
        );
      }
      expect(await countCycles(tx, PRACTICE_B)).toBe(before);
      // Controllo: con gli id e lo studio di B il comando risponde, e arriva alla regola del ciclo aperto.
      await expectDomainError(
        openCycle(tx, PRACTICE_B, clock, { patientId: PATIENT_B1, kind: "trattamento", firstAppointmentDay: "2026-11-10" }),
        ALREADY_OPEN,
      );
    });
  });
});

describe("getOpenCycle", () => {
  it("legge il ciclo aperto con titolo, sedute previste e giorno di apertura", async () => {
    const cycle = await inUserA(db, (tx) => getOpenCycle(tx, PRACTICE_A, PATIENT_A1));
    expect(cycle).toEqual({
      id: CYCLE_A,
      kind: "trattamento",
      title: "Lombalgia, ottobre 2026",
      expectedSessions: 4,
      openedOn: "2026-10-01",
    });
  });

  it("senza ciclo aperto, o con lo studio sbagliato, dà null", async () => {
    await inUserA(db, async (tx) => {
      expect(await getOpenCycle(tx, PRACTICE_A, PATIENT_A2)).toBeNull();
      expect(await getOpenCycle(tx, PRACTICE_B, PATIENT_A1)).toBeNull();
    });
    await inRollback(db, "B", async (tx) => {
      expect(await getOpenCycle(tx, PRACTICE_A, PATIENT_A1)).toBeNull();
    });
  });
});

describe("getPatientForBooking con il ciclo aperto dal comando", () => {
  it("il ciclo aperto per un paziente nuovo è quello che il dialogo preseleziona", async () => {
    const patient = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const { id } = await openCycle(tx, PRACTICE_A, clock, { patientId, kind: "mantenimento", firstAppointmentDay: "2026-11-10" });
      return { id, booking: await getPatientForBooking(tx, PRACTICE_A, patientId) };
    });
    expect(patient.booking).toMatchObject({
      hasDoneAppointment: false,
      hasClosedCycle: false,
      openCycle: { id: patient.id, kind: "mantenimento", title: "Nuovo ciclo, novembre 2026", expectedSessions: null },
    });
  });

  it("PATIENT_A1 ha CYCLE_A aperto, nessun appuntamento fatto e nessun ciclo chiuso", async () => {
    const patient = await inUserA(db, (tx) => getPatientForBooking(tx, PRACTICE_A, PATIENT_A1));
    expect(patient?.openCycle?.id).toBe(CYCLE_A);
    expect(patient?.hasDoneAppointment).toBe(false);
    expect(patient?.hasClosedCycle).toBe(false);
  });
});

describe("listCycleAppointments", () => {
  it("elenca gli appuntamenti del ciclo con id, orario e stato", async () => {
    const list = await inUserA(db, (tx) => listCycleAppointments(tx, PRACTICE_A, CYCLE_A));
    expect(list).toEqual([{ id: APPOINTMENT_A, startsAt: new Date("2026-10-05T07:00:00Z"), status: "prenotato" }]);
  });

  it("li ordina per orario e include ogni stato", async () => {
    const list = await inUserA(db, async (tx) => {
      const [later] = await tx.query<{ id: string }>(
        `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status)
         values ($1, $2, $3, $4, '2026-10-19T08:00:00Z', 45, 6000, 'confermato') returning id`,
        [PRACTICE_A, PATIENT_A1, SERVICE_A, CYCLE_A],
      );
      const [earlier] = await tx.query<{ id: string }>(
        `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status, cancel_reason)
         values ($1, $2, $3, $4, '2026-09-28T08:00:00Z', 45, 6000, 'annullato', 'paziente') returning id`,
        [PRACTICE_A, PATIENT_A1, SERVICE_A, CYCLE_A],
      );
      return { later: later?.id, earlier: earlier?.id, list: await listCycleAppointments(tx, PRACTICE_A, CYCLE_A) };
    });
    expect(list.list.map((a) => [a.id, a.status])).toEqual([
      [list.earlier, "annullato"],
      [APPOINTMENT_A, "prenotato"],
      [list.later, "confermato"],
    ]);
  });

  it("un ciclo senza appuntamenti, o di un altro studio, dà []", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const { id } = await openCycle(tx, PRACTICE_A, clock, { patientId, kind: "trattamento", firstAppointmentDay: "2026-11-10" });
      expect(await listCycleAppointments(tx, PRACTICE_A, id)).toEqual([]);
      expect(await listCycleAppointments(tx, PRACTICE_B, CYCLE_A)).toEqual([]);
    });
    await inRollback(db, "B", async (tx) => {
      expect(await listCycleAppointments(tx, PRACTICE_A, CYCLE_A)).toEqual([]);
      expect(await listCycleAppointments(tx, PRACTICE_B, CYCLE_A)).toEqual([]);
    });
  });
});
