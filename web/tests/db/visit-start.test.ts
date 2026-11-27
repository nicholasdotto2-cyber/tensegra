import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock, romeDateTime } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { closeCycle } from "@/server/domain/cycles/commands";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { saveHistoryItem } from "@/server/domain/history/commands";
import { createPatient } from "@/server/domain/patients/commands";
import { editVisit, startVisit } from "@/server/domain/visits/commands";
import { loadVisit } from "@/server/domain/visits/ops";
import { PRACTICE_A, PRACTICE_B, VISIT_A } from "./fixtures";
import { asUserA, asUserB, inUserA, openTestDb } from "./helpers";

// L'avvio della visita dal suo appuntamento e i campi della visita.
// I dati nascono come uA in ogni test, su pazienti nuovi, e tornano
// indietro. L'orologio è mercoledì 4/11/2026 alle 08:30 di Roma.

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const INVALID = "Valore non valido";
const CYCLE_CLOSED = "Il ciclo di questo appuntamento è chiuso.";

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

// Preparazione, tutta come uA ------------------------------------------------------------------------

async function newPatient(tx: Tx, practiceId = PRACTICE_A): Promise<string> {
  const { id } = await createPatient(tx, practiceId, clock, { firstName: "Marco", lastName: "Bellandi", birthDate: "1979-03-09" });
  return id;
}

async function cycle(tx: Tx, patientId: string, openedOn = "2026-10-01", practiceId = PRACTICE_A): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions)
     values ($1, $2, 'trattamento', $3, 'Nuovo ciclo, ottobre 2026', 4) returning id`,
    [practiceId, patientId, openedOn],
  );
  if (!row) throw new Error("ciclo non creato");
  return row.id;
}

type ServiceKind = "prima_visita" | "seduta" | "controllo" | "altro";

async function service(tx: Tx, kind: ServiceKind, practiceId = PRACTICE_A): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into public.services (practice_id, kind, name, invoice_description, duration_min, price_cents, color)
     values ($1, $2, $3, 'Prestazione di osteopatia', 45, 6000, 'petrolio') returning id`,
    [practiceId, kind, `Voce ${kind}`],
  );
  if (!row) throw new Error("voce non creata");
  return row.id;
}

type Status = "prenotato" | "confermato" | "fatto" | "saltato" | "annullato";

interface AppointmentOpts {
  day?: string;
  time?: string;
  status?: Status;
  kind?: ServiceKind;
  practiceId?: string;
}

async function appointment(tx: Tx, patientId: string, cycleId: string, o: AppointmentOpts = {}): Promise<string> {
  const practiceId = o.practiceId ?? PRACTICE_A;
  const status = o.status ?? "fatto";
  const [row] = await tx.query<{ id: string }>(
    `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents,
                                      status, cancel_reason)
     values ($1, $2, $3, $4, $5, 45, 6000, $6, $7) returning id`,
    [
      practiceId,
      patientId,
      await service(tx, o.kind ?? "seduta", practiceId),
      cycleId,
      romeDateTime(o.day ?? "2026-11-03", o.time ?? "09:00"),
      status,
      status === "annullato" ? "paziente" : null,
    ],
  );
  if (!row) throw new Error("appuntamento non creato");
  return row.id;
}

/** Paziente, ciclo e un appuntamento: l'occorrente per aprire una visita. */
async function setup(tx: Tx, o: AppointmentOpts = {}) {
  const patientId = await newPatient(tx);
  const cycleId = await cycle(tx, patientId);
  const appointmentId = await appointment(tx, patientId, cycleId, o);
  return { patientId, cycleId, appointmentId };
}

async function closeVisitRow(tx: Tx, visitId: string): Promise<void> {
  await tx.query("update public.visits set status = 'closed', closed_at = $3 where practice_id = $1 and id = $2", [
    PRACTICE_A,
    visitId,
    clock.now(),
  ]);
}

// Riletture ------------------------------------------------------------------------------------------

async function visitRow(tx: Tx, id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx.query("select * from public.visits where id = $1", [id]);
  return row;
}

async function visitsOf(tx: Tx, appointmentId: string) {
  return tx.query<{ id: string }>("select id from public.visits where appointment_id = $1", [appointmentId]);
}

async function answersOf(tx: Tx, visitId: string) {
  return tx.query<{ itemCode: string; answer: string; regions: string[]; fromHistory: boolean }>(
    `select item_code as "itemCode", answer, regions, from_history as "fromHistory"
       from public.visit_screening_answers
      where visit_id = $1
      order by item_code`,
    [visitId],
  );
}

const edit = (visitId: string, values: Record<string, unknown>) => ({ visitId, op: { op: "campi", values } });

// ----------------------------------------------------------------------------------------------------

describe("startVisit", () => {
  it("un fatto di ieri con la seduta dà una visita in bozza del 3/11 sul ciclo e sul paziente dell'appuntamento", async () => {
    const { started, row, ids } = await inUserA(db, async (tx) => {
      const ids = await setup(tx, { day: "2026-11-03", status: "fatto", kind: "seduta" });
      const started = await startVisit(tx, PRACTICE_A, clock, { appointmentId: ids.appointmentId });
      return { started, row: await visitRow(tx, started.visitId), ids };
    });
    expect(started.patientId).toBe(ids.patientId);
    expect(row).toMatchObject({
      status: "draft",
      visit_date: "2026-11-03",
      kind: "seduta",
      location: "studio",
      screening_catalog_version: 1,
      cycle_id: ids.cycleId,
      patient_id: ids.patientId,
      appointment_id: ids.appointmentId,
      screening_reviewed_at: null,
      closed_at: null,
      copied_from_visit_id: null,
    });
  });

  it("una seconda chiamata restituisce la stessa visita e non ne crea un'altra", async () => {
    const { first, second, visits } = await inUserA(db, async (tx) => {
      const { appointmentId } = await setup(tx);
      const first = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      const second = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      return { first, second, visits: await visitsOf(tx, appointmentId) };
    });
    expect(second).toEqual(first);
    expect(visits).toEqual([{ id: first.visitId }]);
  });

  it.each([
    ["altro", "seduta"],
    ["prima_visita", "prima_visita"],
    ["controllo", "controllo"],
  ] as const)("il servizio %s dà una visita di tipo %s", async (serviceKind, visitKind) => {
    const row = await inUserA(db, async (tx) => {
      const { appointmentId } = await setup(tx, { kind: serviceKind });
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      return visitRow(tx, visitId);
    });
    expect(row?.kind).toBe(visitKind);
  });

  it("un confermato di oggi alle 10:00 dà la visita, aperta prima che l'appuntamento sia fatto", async () => {
    const { row, status } = await inUserA(db, async (tx) => {
      const { appointmentId } = await setup(tx, { day: "2026-11-04", time: "10:00", status: "confermato" });
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      const [appt] = await tx.query<{ status: string }>("select status from public.appointments where id = $1", [
        appointmentId,
      ]);
      return { row: await visitRow(tx, visitId), status: appt?.status };
    });
    expect(row).toMatchObject({ status: "draft", visit_date: "2026-11-04" });
    expect(status).toBe("confermato");
  });

  it.each([
    ["un prenotato di domani", { day: "2026-11-05", status: "prenotato" }],
    ["un annullato di ieri", { day: "2026-11-03", status: "annullato" }],
    ["un saltato di ieri", { day: "2026-11-03", status: "saltato" }],
  ] as const)("%s è Operazione non permessa e nessuna visita nasce", async (_label, opts) => {
    const visits = await inUserA(db, async (tx) => {
      const { appointmentId } = await setup(tx, opts);
      await expectDomainError(startVisit(tx, PRACTICE_A, clock, { appointmentId }), NOT_ALLOWED);
      return visitsOf(tx, appointmentId);
    });
    expect(visits).toEqual([]);
  });

  it("un appuntamento che non c'è è Operazione non permessa; un id che non è un uuid è Valore non valido", async () => {
    await inUserA(db, async (tx) => {
      await expectDomainError(
        startVisit(tx, PRACTICE_A, clock, { appointmentId: "a0000000-0000-4000-8000-0000000fffff" }),
        NOT_ALLOWED,
      );
      expect((await formFailure(startVisit(tx, PRACTICE_A, clock, { appointmentId: "abc" }))).message).toBe(INVALID);
      expect(
        (await formFailure(startVisit(tx, PRACTICE_A, clock, { appointmentId: VISIT_A, status: "fatto" }))).message,
      ).toBe(INVALID);
    });
  });

  it("con «Warfarin 5 mg» in anamnesi (anticoagulante_tao) la visita nasce con ci_avk «si» da anamnesi", async () => {
    const answers = await inUserA(db, async (tx) => {
      const { patientId, appointmentId } = await setup(tx);
      await saveHistoryItem(tx, PRACTICE_A, clock, {
        patientId,
        kind: "farmaco",
        label: "Warfarin 5 mg",
        region: null,
        occurredOn: null,
        occurredYear: null,
        ongoing: true,
        note: null,
      });
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      return answersOf(tx, visitId);
    });
    expect(answers).toEqual([{ itemCode: "ci_avk", answer: "si", regions: [], fromHistory: true }]);
  });

  it("senza etichette di rischio la visita nasce senza risposte", async () => {
    const answers = await inUserA(db, async (tx) => {
      const { appointmentId } = await setup(tx);
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      return answersOf(tx, visitId);
    });
    expect(answers).toEqual([]);
  });

  it("un ciclo aperto il 4/11 con l'appuntamento del 3/11 si apre il 3/11 e la visita nasce", async () => {
    const { openedOn, row } = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId, "2026-11-04");
      const appointmentId = await appointment(tx, patientId, cycleId, { day: "2026-11-03" });
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      const [c] = await tx.query<{ openedOn: string }>(
        'select opened_on as "openedOn" from public.treatment_cycles where id = $1',
        [cycleId],
      );
      return { openedOn: c?.openedOn, row: await visitRow(tx, visitId) };
    });
    expect(openedOn).toBe("2026-11-03");
    expect(row).toMatchObject({ visit_date: "2026-11-03", status: "draft" });
  });

  it("un ciclo aperto prima dell'appuntamento resta com'è", async () => {
    const openedOn = await inUserA(db, async (tx) => {
      const { cycleId, appointmentId } = await setup(tx, { day: "2026-11-03" });
      await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      const [c] = await tx.query<{ openedOn: string }>(
        'select opened_on as "openedOn" from public.treatment_cycles where id = $1',
        [cycleId],
      );
      return c?.openedOn;
    });
    expect(openedOn).toBe("2026-10-01");
  });

  // Un prenotato di ieri resta nel ciclo che si chiude oggi (non è futuro).
  it("un appuntamento di un ciclo chiuso è «Il ciclo di questo appuntamento è chiuso.»; la visita già aperta si riapre", async () => {
    const r = await inUserA(db, async (tx) => {
      const { patientId, cycleId, appointmentId } = await setup(tx, { day: "2026-11-02", status: "prenotato" });
      const opened = await appointment(tx, patientId, cycleId, { day: "2026-11-03", status: "fatto", kind: "controllo" });
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId: opened });
      await closeCycle(tx, PRACTICE_A, clock, {
        cycleId,
        outcome: "raggiunto",
        closedOn: "2026-11-04",
        finalScores: "non_tornato",
        recall: "nessuno",
      });
      await expectDomainError(startVisit(tx, PRACTICE_A, clock, { appointmentId }), CYCLE_CLOSED);
      const again = await startVisit(tx, PRACTICE_A, clock, { appointmentId: opened });
      return { visitId, again: again.visitId, visits: await visitsOf(tx, appointmentId) };
    });
    expect(r.again).toBe(r.visitId);
    expect(r.visits).toEqual([]);
  });
});

describe("editVisit: campi", () => {
  it("nprsPre 6 si salva, e una chiave assente non cambia la colonna", async () => {
    const row = await inUserA(db, async (tx) => {
      const { appointmentId } = await setup(tx);
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      await editVisit(tx, PRACTICE_A, clock, edit(visitId, { nprsPost: 3, subjectiveUpdate: "  Meglio da lunedì  " }));
      await editVisit(tx, PRACTICE_A, clock, edit(visitId, { nprsPre: 6 }));
      return visitRow(tx, visitId);
    });
    expect(row).toMatchObject({ nprs_pre: 6, nprs_post: 3, subjective_update: "Meglio da lunedì", location: "studio" });
  });

  it("nprsPre 11 è Valore non valido sul campo e niente cambia", async () => {
    const { failure, row } = await inUserA(db, async (tx) => {
      const { appointmentId } = await setup(tx);
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      const failure = await formFailure(editVisit(tx, PRACTICE_A, clock, edit(visitId, { nprsPre: 11 })));
      return { failure, row: await visitRow(tx, visitId) };
    });
    expect(failure.message).toBe(INVALID);
    expect(failure.fieldErrors).toMatchObject({ "op.values.nprsPre": INVALID });
    expect(row?.nprs_pre).toBeNull();
  });

  it("radiationSites [coscia] si salva; [] svuota; un sito fuori elenco è Valore non valido", async () => {
    const { saved, cleared, failure } = await inUserA(db, async (tx) => {
      const { appointmentId } = await setup(tx);
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      await editVisit(tx, PRACTICE_A, clock, edit(visitId, { radiationSites: ["coscia"], radiationSide: "dx" }));
      const saved = await visitRow(tx, visitId);
      await editVisit(tx, PRACTICE_A, clock, edit(visitId, { radiationSites: [], radiationSide: null }));
      const cleared = await visitRow(tx, visitId);
      const failure = await formFailure(editVisit(tx, PRACTICE_A, clock, edit(visitId, { radiationSites: ["piede"] })));
      return { saved, cleared, failure };
    });
    expect(saved).toMatchObject({ radiation_sites: ["coscia"], radiation_side: "dx" });
    expect(cleared).toMatchObject({ radiation_sites: [], radiation_side: null });
    expect(failure.message).toBe(INVALID);
  });

  it("tutti i campi si scrivono insieme, e un testo vuoto diventa null", async () => {
    const row = await inUserA(db, async (tx) => {
      const { appointmentId } = await setup(tx);
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      await editVisit(
        tx,
        PRACTICE_A,
        clock,
        edit(visitId, {
          location: "domicilio",
          othersPresent: "madre",
          othersPresentConsented: true,
          nprsPre: 5,
          nprsPost: 2,
          subjectiveUpdate: "",
          radiationSites: ["gluteo", "coscia"],
          radiationSide: "sx",
          treatmentResponse: "migliorato",
          adverseReaction: "lieve",
          adverseReactionNote: "Indolenzimento per un giorno",
          observationNote: "Spalla destra più alta",
          workingHypothesis: "Disfunzione lombare con compenso dorsale",
          planNext: "Rivedere fra due settimane",
          bpSystolic: 125,
          bpDiastolic: 80,
        }),
      );
      return visitRow(tx, visitId);
    });
    expect(row).toMatchObject({
      location: "domicilio",
      others_present: "madre",
      others_present_consented: true,
      nprs_pre: 5,
      nprs_post: 2,
      subjective_update: null,
      radiation_sites: ["gluteo", "coscia"],
      radiation_side: "sx",
      treatment_response: "migliorato",
      adverse_reaction: "lieve",
      adverse_reaction_note: "Indolenzimento per un giorno",
      observation_note: "Spalla destra più alta",
      working_hypothesis: "Disfunzione lombare con compenso dorsale",
      plan_next: "Rivedere fra due settimane",
      bp_systolic: 125,
      bp_diastolic: 80,
    });
  });

  it("una chiave in più, un'operazione che non c'è o un testo troppo lungo sono rifiutati", async () => {
    await inUserA(db, async (tx) => {
      const { appointmentId } = await setup(tx);
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      expect((await formFailure(editVisit(tx, PRACTICE_A, clock, edit(visitId, { status: "closed" })))).message).toBe(INVALID);
      expect((await formFailure(editVisit(tx, PRACTICE_A, clock, { visitId, op: { op: "chiudi" } }))).message).toBe(INVALID);
      const long = await formFailure(editVisit(tx, PRACTICE_A, clock, edit(visitId, { planNext: "x".repeat(501) })));
      expect(long.message).toBe("Massimo 500 caratteri.");
      expect((await visitRow(tx, visitId))?.status).toBe("draft");
    });
  });

  it("su una visita chiusa è Operazione non permessa dal comando, prima del trigger: la transazione resta valida", async () => {
    const row = await inUserA(db, async (tx) => {
      const { appointmentId } = await setup(tx);
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      await closeVisitRow(tx, visitId);
      await expectDomainError(editVisit(tx, PRACTICE_A, clock, edit(visitId, { nprsPre: 4 })), NOT_ALLOWED);
      // Un errore del database avrebbe abortito la transazione: questa lettura passa.
      return visitRow(tx, visitId);
    });
    expect(row).toMatchObject({ status: "closed", nprs_pre: null });
  });

  it("una visita che non c'è è Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      await expectDomainError(
        editVisit(tx, PRACTICE_A, clock, edit("a0000000-0000-4000-8000-0000000fffff", { nprsPre: 4 })),
        NOT_ALLOWED,
      );
    });
  });
});

describe("loadVisit", () => {
  it("rilegge la visita con lo studio; un altro studio non la trova", async () => {
    const { row, other, ids } = await inUserA(db, async (tx) => {
      const ids = await setup(tx, { kind: "prima_visita" });
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId: ids.appointmentId });
      return {
        row: await loadVisit(tx, PRACTICE_A, visitId),
        other: await loadVisit(tx, PRACTICE_B, visitId),
        ids: { ...ids, visitId },
      };
    });
    expect(row).toEqual({
      id: ids.visitId,
      patientId: ids.patientId,
      cycleId: ids.cycleId,
      appointmentId: ids.appointmentId,
      status: "draft",
      visitDate: "2026-11-03",
      kind: "prima_visita",
      copiedFromVisitId: null,
    });
    expect(other).toBeNull();
  });
});

describe("come uB sui dati di A", () => {
  let isolated: Db;
  let isolatedPg: PGlite;

  beforeAll(async () => {
    ({ db: isolated, pg: isolatedPg } = await openTestDb());
  });

  afterAll(async () => {
    await isolatedPg?.close();
  });

  const snapshotOfA = () =>
    asUserA(isolated, async (tx) => ({
      visits: await tx.query("select * from public.visits where practice_id = $1 order by id", [PRACTICE_A]),
      answers: await tx.query("select * from public.visit_screening_answers where practice_id = $1 order by id", [
        PRACTICE_A,
      ]),
      cycles: await tx.query("select * from public.treatment_cycles where practice_id = $1 order by id", [PRACTICE_A]),
    }));

  it("startVisit ed editVisit sono Operazione non permessa, nessuna visita nasce e A non cambia", async () => {
    // Un appuntamento fatto di A senza visita, su un ciclo aperto dopo di lui: uB non
    // deve né creare la visita né spostare l'apertura.
    const appointmentId = await asUserA(isolated, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId, "2026-11-04");
      return appointment(tx, patientId, cycleId, { day: "2026-11-03" });
    });
    const before = await snapshotOfA();
    await asUserB(isolated, async (tx) => {
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        await expectDomainError(startVisit(tx, practiceId, clock, { appointmentId }), NOT_ALLOWED);
        await expectDomainError(editVisit(tx, practiceId, clock, edit(VISIT_A, { nprsPre: 4 })), NOT_ALLOWED);
        expect(await loadVisit(tx, practiceId, VISIT_A)).toBeNull();
      }
    });
    expect(await snapshotOfA()).toEqual(before);
    expect(await asUserA(isolated, (tx) => visitsOf(tx, appointmentId))).toEqual([]);
  });
});
