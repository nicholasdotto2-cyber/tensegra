import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock, romeDateTime } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import {
  addPsfsItem,
  closeCycle,
  linkRelapse,
  removePsfsItem,
  renamePsfsItem,
  updateCycleOpening,
} from "@/server/domain/cycles/commands";
import { REGION_LABEL } from "@/lib/clinical/catalog";
import { getCycleClosing, relapseCandidate } from "@/server/domain/cycles/queries";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { createPatient } from "@/server/domain/patients/commands";
import { CYCLE_A, PATIENT_A1, PHYSICIAN_A, PRACTICE_A, PRACTICE_B, PSFS_ITEM_A, SERVICE_A } from "./fixtures";
import { asUserA, asUserB, expectPgError, inUserA, openTestDb } from "./helpers";

// La parte clinica del ciclo:
// campi d'apertura e titolo, attività PSFS, ricaduta e chiusura con i punteggi finali
// e il richiamo. I dati nascono come uA in ogni test, su pazienti nuovi, e tornano indietro. L'orologio
// è mercoledì 4/11/2026 alle 08:30 di Roma.

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const TODAY = "2026-11-04";

const VOICE_1 = 'Il punteggio finale si scrive mentre la visita dell\'ultima seduta è aperta. Scegli "Paziente non tornato".';
const MAX_3 = "Al massimo 3 attività.";
const SCORED_IN_CLOSED = "L'attività ha già un punteggio in una visita chiusa: aggiungine una nuova.";
const NEEDS_LETTER = "Per chiudere come rinviato al medico prepara prima la lettera.";
const IN_FUTURE = "La chiusura non può essere nel futuro.";
const BEFORE_OPENING = "La chiusura non può precedere l'apertura del ciclo.";
const ALL_FINAL = "Scrivi il punteggio finale di ogni attività.";
const INVALID = "Valore non valido";

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

async function newPatient(tx: Tx, lastName = "Bellandi"): Promise<string> {
  const { id } = await createPatient(tx, PRACTICE_A, clock, { firstName: "Marco", lastName, birthDate: "1979-03-09" });
  return id;
}

interface CycleOpts {
  kind?: "trattamento" | "mantenimento";
  openedOn?: string;
  title?: string;
  mainRegion?: string | null;
  goal?: string | null;
}

async function cycle(tx: Tx, patientId: string, o: CycleOpts = {}): Promise<string> {
  const kind = o.kind ?? "trattamento";
  const [row] = await tx.query<{ id: string }>(
    `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions, main_region, goal)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      PRACTICE_A,
      patientId,
      kind,
      o.openedOn ?? "2026-10-01",
      o.title ?? "Nuovo ciclo, ottobre 2026",
      kind === "trattamento" ? 4 : null,
      o.mainRegion ?? null,
      o.goal ?? null,
    ],
  );
  if (!row) throw new Error("ciclo non creato");
  return row.id;
}

/** Chiude il ciclo con una scrittura diretta, per preparare una ricaduta o un ciclo già chiuso. */
async function closeCycleRow(tx: Tx, cycleId: string, closedOn: string): Promise<void> {
  await tx.query(
    `update public.treatment_cycles set status = 'closed', closed_on = $3, outcome = 'raggiunto'
      where practice_id = $1 and id = $2`,
    [PRACTICE_A, cycleId, closedOn],
  );
}

type Status = "prenotato" | "confermato" | "fatto" | "saltato" | "annullato";

async function appointment(tx: Tx, patientId: string, cycleId: string, day: string, time = "09:00", status: Status = "fatto") {
  const [row] = await tx.query<{ id: string }>(
    `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status, cancel_reason)
     values ($1, $2, $3, $4, $5, 45, 6000, $6, case when $6 = 'annullato' then 'paziente' end) returning id`,
    [PRACTICE_A, patientId, SERVICE_A, cycleId, romeDateTime(day, time), status],
  );
  if (!row) throw new Error("appuntamento non creato");
  return row.id;
}

/** Un appuntamento fatto con la sua visita in bozza. */
async function session(tx: Tx, patientId: string, cycleId: string, day: string, time = "09:00"): Promise<string> {
  const appointmentId = await appointment(tx, patientId, cycleId, day, time);
  const [row] = await tx.query<{ id: string }>(
    `insert into public.visits (practice_id, patient_id, cycle_id, appointment_id, visit_date, kind, screening_catalog_version)
     values ($1, $2, $3, $4, $5, 'seduta', 1) returning id`,
    [PRACTICE_A, patientId, cycleId, appointmentId, day],
  );
  if (!row) throw new Error("visita non creata");
  return row.id;
}

async function closeVisitRow(tx: Tx, visitId: string): Promise<void> {
  await tx.query("update public.visits set status = 'closed', closed_at = $3 where practice_id = $1 and id = $2", [
    PRACTICE_A,
    visitId,
    clock.now(),
  ]);
}

async function score(tx: Tx, itemId: string, visitId: string, value: number, phase = "iniziale"): Promise<void> {
  await tx.query(
    "insert into public.psfs_scores (practice_id, item_id, visit_id, score, phase) values ($1, $2, $3, $4, $5)",
    [PRACTICE_A, itemId, visitId, value, phase],
  );
}

async function referral(tx: Tx, patientId: string, cycleId: string): Promise<void> {
  await tx.query(
    `insert into public.referrals (practice_id, patient_id, cycle_id, created_on, recipient_kind, reason, urgency,
                                   summary_text, request_text)
     values ($1, $2, $3, '2026-11-02', 'medico_curante', 'sintomi_persistenti', 'programmato',
             'Dolore lombare da sei settimane', 'Si chiede una valutazione clinica')`,
    [PRACTICE_A, patientId, cycleId],
  );
}

async function setPatientRecall(tx: Tx, patientId: string, weeks: number | null, paused = false): Promise<void> {
  await tx.query(
    "update public.patients set recall_interval_weeks = $3, recall_paused = $4 where practice_id = $1 and id = $2",
    [PRACTICE_A, patientId, weeks, paused],
  );
}

/** Tre attività aggiunte col comando. */
async function threeItems(tx: Tx, cycleId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const activity of ["Guidare 30 minuti", "Dormire sul fianco destro", "Allacciarmi le scarpe"]) {
    ids.push((await addPsfsItem(tx, PRACTICE_A, clock, { cycleId, activity })).id);
  }
  return ids;
}

// Riletture ------------------------------------------------------------------------------------------

async function cycleRow(tx: Tx, id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx.query("select * from public.treatment_cycles where id = $1", [id]);
  return row;
}

async function patientRecall(tx: Tx, id: string) {
  const [row] = await tx.query<{ weeks: number | null; paused: boolean }>(
    'select recall_interval_weeks as weeks, recall_paused as paused from public.patients where id = $1',
    [id],
  );
  return row;
}

async function items(tx: Tx, cycleId: string) {
  return tx.query<{ id: string; position: number; activity: string }>(
    "select id, position, activity from public.psfs_items where cycle_id = $1 order by position",
    [cycleId],
  );
}

async function scores(tx: Tx, where: { itemId?: string; visitId?: string; phase?: string }) {
  return tx.query<{ itemId: string; visitId: string; score: number; phase: string }>(
    `select item_id as "itemId", visit_id as "visitId", score, phase
       from public.psfs_scores
      where ($1::uuid is null or item_id = $1) and ($2::uuid is null or visit_id = $2) and ($3::text is null or phase = $3)
      order by item_id, visit_id`,
    [where.itemId ?? null, where.visitId ?? null, where.phase ?? null],
  );
}

const close = (cycleId: string, extra: Record<string, unknown> = {}) => ({
  cycleId,
  outcome: "raggiunto",
  outcomeNote: null,
  closedOn: TODAY,
  finalScores: "non_tornato",
  recall: { weeks: 6 },
  ...extra,
});

// ----------------------------------------------------------------------------------------------------

describe("updateCycleOpening", () => {
  it("la regione principale su un ciclo «Nuovo ciclo, ...» dà il titolo «{Regione}, {mese anno di apertura}»", async () => {
    const row = await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx), { openedOn: "2026-11-02", title: "Nuovo ciclo, novembre 2026" });
      await updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, mainRegion: "lumbar" });
      return cycleRow(tx, cycleId);
    });
    expect(row).toMatchObject({ title: "Lombare, novembre 2026", main_region: "lumbar" });
  });

  it("il titolo prende il mese di apertura, non quello di oggi", async () => {
    const row = await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx), { openedOn: "2026-10-20", title: "Nuovo ciclo, ottobre 2026" });
      await updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, mainRegion: "head" });
      return cycleRow(tx, cycleId);
    });
    expect(row).toMatchObject({ title: "Cranio e ATM, ottobre 2026", main_region: "head" });
  });

  it("un titolo nato dalla regione segue la regione nuova: «Lombare, novembre 2026» diventa «Cervicale, novembre 2026»", async () => {
    const row = await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx), {
        openedOn: "2026-11-02",
        title: "Nuovo ciclo, novembre 2026",
      });
      await updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, mainRegion: "lumbar" });
      expect((await cycleRow(tx, cycleId))?.title).toBe(`${REGION_LABEL.lumbar}, novembre 2026`);
      await updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, mainRegion: "cervical" });
      return cycleRow(tx, cycleId);
    });
    expect(row).toMatchObject({ title: `${REGION_LABEL.cervical}, novembre 2026`, main_region: "cervical" });
    expect(row?.title).toBe("Cervicale, novembre 2026");
  });

  it("un titolo come quello di un'altra regione o di un altro mese resta: non nasce dalla regione di adesso", async () => {
    const rows = await inUserA(db, async (tx) => {
      const otherRegion = await cycle(tx, await newPatient(tx), {
        openedOn: "2026-11-02",
        mainRegion: "lumbar",
        title: "Dorsale, novembre 2026",
      });
      await updateCycleOpening(tx, PRACTICE_A, clock, { cycleId: otherRegion, mainRegion: "cervical" });
      const otherMonth = await cycle(tx, await newPatient(tx, "Altro"), {
        openedOn: "2026-11-02",
        mainRegion: "lumbar",
        title: "Lombare, ottobre 2026",
      });
      await updateCycleOpening(tx, PRACTICE_A, clock, { cycleId: otherMonth, mainRegion: "cervical" });
      return [await cycleRow(tx, otherRegion), await cycleRow(tx, otherMonth)];
    });
    expect(rows.map((r) => r?.title)).toEqual(["Dorsale, novembre 2026", "Lombare, ottobre 2026"]);
  });

  it("su un titolo già scelto la regione non cambia il titolo", async () => {
    const row = await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx), { title: "Cervicalgia con cefalea", mainRegion: "cervical" });
      await updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, mainRegion: "lumbar" });
      return cycleRow(tx, cycleId);
    });
    expect(row).toMatchObject({ title: "Cervicalgia con cefalea", main_region: "lumbar" });
  });

  it("salva i campi dati, compreso il piano accettato del 4/11, e lascia com'erano quelli assenti", async () => {
    const { before, after } = await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx), { mainRegion: "cervical", goal: "Girare la testa in auto" });
      const before = await cycleRow(tx, cycleId);
      await updateCycleOpening(tx, PRACTICE_A, clock, {
        cycleId,
        chiefComplaint: "  Dolore alla nuca lavorando al computer  ",
        onsetOn: "2026-09-15",
        onsetMode: "graduale",
        medicalDiagnosisText: "Cervicalgia",
        medicalDiagnosisSource: "riferita_dal_paziente",
        referringPhysicianId: PHYSICIAN_A,
        selfReferred: false,
        expectedSessions: 6,
        planNote: "Una seduta a settimana per tre settimane, poi ogni due",
        planAgreedOn: "2026-11-04",
      });
      return { before, after: await cycleRow(tx, cycleId) };
    });
    expect(after).toMatchObject({
      chief_complaint: "Dolore alla nuca lavorando al computer",
      main_region: "cervical",
      onset_on: "2026-09-15",
      onset_mode: "graduale",
      medical_diagnosis_text: "Cervicalgia",
      medical_diagnosis_source: "riferita_dal_paziente",
      referring_physician_id: PHYSICIAN_A,
      self_referred: false,
      goal: "Girare la testa in auto",
      expected_sessions: 6,
      plan_note: "Una seduta a settimana per tre settimane, poi ogni due",
      plan_agreed_on: "2026-11-04",
      title: before?.title,
      status: "open",
      created_by: before?.created_by,
      created_at: before?.created_at,
    });
  });

  it("null e testo vuoto svuotano un campo", async () => {
    const row = await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx), { mainRegion: "cervical", goal: "Girare la testa" });
      await updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, planAgreedOn: "2026-11-04" });
      await updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, goal: "  ", planAgreedOn: null, mainRegion: null });
      return cycleRow(tx, cycleId);
    });
    expect(row).toMatchObject({ goal: null, plan_agreed_on: null, main_region: null });
  });

  it("21 sedute previste: Valore non valido, e niente cambia", async () => {
    await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx));
      const failure = await formFailure(updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, expectedSessions: 21 }));
      expect(failure.message).toBe(INVALID);
      expect((await cycleRow(tx, cycleId))?.expected_sessions).toBe(4);
    });
  });

  it("una chiave in più è rifiutata", async () => {
    await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx));
      const failure = await formFailure(updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, status: "closed" }));
      expect(failure.message).toBe(INVALID);
    });
  });

  it("con la prima visita del ciclo chiusa l'obiettivo è Operazione non permessa e niente cambia", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId, { goal: "Dormire senza dolore" });
      // La prima visita chiusa e una seconda ancora in bozza: conta la prima.
      await closeVisitRow(tx, await session(tx, patientId, cycleId, "2026-10-05"));
      await session(tx, patientId, cycleId, "2026-10-12");
      await expectDomainError(
        updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, goal: "Correre di nuovo" }),
        NOT_ALLOWED,
      );
      expect((await cycleRow(tx, cycleId))?.goal).toBe("Dormire senza dolore");
    });
  });

  it("con la prima visita in bozza e una dopo chiusa, campi e attività non si scrivono", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId, { goal: "Dormire senza dolore" });
      await session(tx, patientId, cycleId, "2026-10-05");
      const { id: itemId } = await addPsfsItem(tx, PRACTICE_A, clock, { cycleId, activity: "Guidare 30 minuti" });
      await closeVisitRow(tx, await session(tx, patientId, cycleId, "2026-10-12"));
      await expectDomainError(updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, goal: "Correre di nuovo" }), NOT_ALLOWED);
      await expectDomainError(addPsfsItem(tx, PRACTICE_A, clock, { cycleId, activity: "Correre" }), NOT_ALLOWED);
      await expectDomainError(renamePsfsItem(tx, PRACTICE_A, clock, { itemId, activity: "Guidare" }), NOT_ALLOWED);
      await expectDomainError(removePsfsItem(tx, PRACTICE_A, clock, { itemId }), NOT_ALLOWED);
      expect((await cycleRow(tx, cycleId))?.goal).toBe("Dormire senza dolore");
      expect(await items(tx, cycleId)).toEqual([{ id: itemId, position: 1, activity: "Guidare 30 minuti" }]);
    });
  });

  it("a parità di giorno la prima visita è quella dell'orario prima", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      await session(tx, patientId, cycleId, "2026-10-05", "11:00");
      await closeVisitRow(tx, await session(tx, patientId, cycleId, "2026-10-05", "09:00"));
      await expectDomainError(updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, goal: "Correre" }), NOT_ALLOWED);
    });
  });

  it("con la prima visita in bozza i campi si scrivono", async () => {
    const row = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      await session(tx, patientId, cycleId, "2026-10-05");
      await updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, goal: "Correre di nuovo" });
      return cycleRow(tx, cycleId);
    });
    expect(row?.goal).toBe("Correre di nuovo");
  });

  it("dopo la chiusura del ciclo l'obiettivo è Operazione non permessa e niente cambia", async () => {
    await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx), { goal: "Dormire senza dolore" });
      await closeCycleRow(tx, cycleId, "2026-10-30");
      await expectDomainError(
        updateCycleOpening(tx, PRACTICE_A, clock, { cycleId, goal: "Correre di nuovo" }),
        NOT_ALLOWED,
      );
      expect((await cycleRow(tx, cycleId))?.goal).toBe("Dormire senza dolore");
    });
  });
});

describe("attività PSFS", () => {
  it("tre attività prendono le posizioni 1, 2, 3; la quarta è «Al massimo 3 attività.»", async () => {
    await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx));
      const ids = await threeItems(tx, cycleId);
      expect(await items(tx, cycleId)).toEqual([
        { id: ids[0], position: 1, activity: "Guidare 30 minuti" },
        { id: ids[1], position: 2, activity: "Dormire sul fianco destro" },
        { id: ids[2], position: 3, activity: "Allacciarmi le scarpe" },
      ]);
      await expectDomainError(addPsfsItem(tx, PRACTICE_A, clock, { cycleId, activity: "Correre" }), MAX_3);
      expect(await items(tx, cycleId)).toHaveLength(3);
    });
  });

  it("dopo un'attività tolta la nuova prende il posto libero", async () => {
    await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx));
      const ids = await threeItems(tx, cycleId);
      await removePsfsItem(tx, PRACTICE_A, clock, { itemId: ids[1] });
      await addPsfsItem(tx, PRACTICE_A, clock, { cycleId, activity: "Correre" });
      expect((await items(tx, cycleId)).map((i) => [i.position, i.activity])).toEqual([
        [1, "Guidare 30 minuti"],
        [2, "Correre"],
        [3, "Allacciarmi le scarpe"],
      ]);
    });
  });

  it("un'attività vuota o di 121 caratteri è rifiutata col testo del campo", async () => {
    await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx));
      expect((await formFailure(addPsfsItem(tx, PRACTICE_A, clock, { cycleId, activity: "  " }))).message).toBe(
        "Campo obbligatorio.",
      );
      expect((await formFailure(addPsfsItem(tx, PRACTICE_A, clock, { cycleId, activity: "a".repeat(121) }))).message).toBe(
        "Massimo 120 caratteri.",
      );
      expect(await items(tx, cycleId)).toEqual([]);
    });
  });

  it("su un ciclo chiuso aggiungere, rinominare e togliere sono Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx));
      const [itemId = ""] = await threeItems(tx, cycleId);
      await closeCycleRow(tx, cycleId, "2026-10-30");
      await expectDomainError(addPsfsItem(tx, PRACTICE_A, clock, { cycleId, activity: "Correre" }), NOT_ALLOWED);
      await expectDomainError(renamePsfsItem(tx, PRACTICE_A, clock, { itemId, activity: "Guidare" }), NOT_ALLOWED);
      await expectDomainError(removePsfsItem(tx, PRACTICE_A, clock, { itemId }), NOT_ALLOWED);
      expect(await items(tx, cycleId)).toHaveLength(3);
    });
  });

  it("con un punteggio in una visita in bozza la rinomina riscrive lo stesso punteggio", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const [itemId = ""] = await threeItems(tx, cycleId);
      const visitId = await session(tx, patientId, cycleId, "2026-10-05");
      await score(tx, itemId, visitId, 4);
      await renamePsfsItem(tx, PRACTICE_A, clock, { itemId, activity: "  Guidare 40 minuti  " });
      expect((await items(tx, cycleId))[0]).toEqual({ id: itemId, position: 1, activity: "Guidare 40 minuti" });
      expect(await scores(tx, { itemId })).toEqual([{ itemId, visitId, score: 4, phase: "iniziale" }]);
    });
  });

  it("senza punteggi la rinomina cambia solo il testo", async () => {
    await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx));
      const [itemId = ""] = await threeItems(tx, cycleId);
      await renamePsfsItem(tx, PRACTICE_A, clock, { itemId, activity: "Guidare 40 minuti" });
      expect((await items(tx, cycleId))[0]?.activity).toBe("Guidare 40 minuti");
    });
  });

  it("con un punteggio in una visita chiusa rinomina e togli rispondono con la loro frase e niente cambia", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const [itemId = ""] = await threeItems(tx, cycleId);
      const closedVisit = await session(tx, patientId, cycleId, "2026-10-05");
      await score(tx, itemId, closedVisit, 4);
      await closeVisitRow(tx, closedVisit);
      // Un altro punteggio in una bozza non basta a rinominare.
      await score(tx, itemId, await session(tx, patientId, cycleId, "2026-10-12"), 6, "intermedia");
      const before = await scores(tx, { itemId });

      await expectDomainError(renamePsfsItem(tx, PRACTICE_A, clock, { itemId, activity: "Guidare" }), SCORED_IN_CLOSED);
      await expectDomainError(removePsfsItem(tx, PRACTICE_A, clock, { itemId }), SCORED_IN_CLOSED);
      expect((await items(tx, cycleId))[0]).toEqual({ id: itemId, position: 1, activity: "Guidare 30 minuti" });
      expect(await scores(tx, { itemId })).toEqual(before);
    });
  });

  it("con un punteggio in una visita in bozza togli cancella attività e punteggio", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const [itemId = "", second = ""] = await threeItems(tx, cycleId);
      const visitId = await session(tx, patientId, cycleId, "2026-10-05");
      await score(tx, itemId, visitId, 4);
      await score(tx, second, visitId, 5);
      await removePsfsItem(tx, PRACTICE_A, clock, { itemId });
      expect((await items(tx, cycleId)).map((i) => i.position)).toEqual([2, 3]);
      expect(await scores(tx, { itemId })).toEqual([]);
      expect(await scores(tx, { visitId })).toEqual([{ itemId: second, visitId, score: 5, phase: "iniziale" }]);
    });
  });

  it("il database rifiuta la rinomina diretta di un'attività con un punteggio (42501)", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const [itemId = ""] = await threeItems(tx, cycleId);
      await score(tx, itemId, await session(tx, patientId, cycleId, "2026-10-05"), 4);
      await expectPgError(
        tx.query("update public.psfs_items set activity = 'Guidare' where practice_id = $1 and id = $2", [
          PRACTICE_A,
          itemId,
        ]),
        "42501",
      );
    });
  });

  it("un'attività che non c'è è Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const itemId = "a0000000-0000-4000-8000-00000000ffff";
      await expectDomainError(renamePsfsItem(tx, PRACTICE_A, clock, { itemId, activity: "Guidare" }), NOT_ALLOWED);
      await expectDomainError(removePsfsItem(tx, PRACTICE_A, clock, { itemId }), NOT_ALLOWED);
      await expectDomainError(
        addPsfsItem(tx, PRACTICE_A, clock, { cycleId: "a0000000-0000-4000-8000-00000000ffff", activity: "Guidare" }),
        NOT_ALLOWED,
      );
    });
  });
});

describe("ricaduta", () => {
  it("relapseCandidate: un ciclo chiuso 40 giorni fa con la stessa regione; 89 sì, 90 e 100 no; regione diversa no", async () => {
    const found = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const old40 = await cycle(tx, patientId, {
        openedOn: "2026-08-01",
        title: "Lombalgia, agosto 2026",
        mainRegion: "lumbar",
      });
      await closeCycleRow(tx, old40, "2026-09-25");
      const current = await cycle(tx, patientId, { openedOn: "2026-11-02" });
      return {
        old40,
        lumbar: await relapseCandidate(tx, PRACTICE_A, clock, current, "lumbar"),
        cervical: await relapseCandidate(tx, PRACTICE_A, clock, current, "cervical"),
      };
    });
    expect(found.lumbar).toEqual({ id: found.old40, title: "Lombalgia, agosto 2026" });
    expect(found.cervical).toBeNull();

    for (const [closedOn, expected] of [
      ["2026-08-07", true], // 89 giorni
      ["2026-08-06", false], // 90 giorni
      ["2026-07-27", false], // 100 giorni
    ] as const) {
      const result = await inUserA(db, async (tx) => {
        const patientId = await newPatient(tx);
        const old = await cycle(tx, patientId, { openedOn: "2026-07-01", mainRegion: "lumbar" });
        await closeCycleRow(tx, old, closedOn);
        return relapseCandidate(tx, PRACTICE_A, clock, await cycle(tx, patientId, { openedOn: "2026-11-02" }), "lumbar");
      });
      expect(result !== null, closedOn).toBe(expected);
    }
  });

  it("relapseCandidate non propone il ciclo di un altro paziente né un ciclo aperto", async () => {
    const result = await inUserA(db, async (tx) => {
      const other = await newPatient(tx, "Altro");
      const otherCycle = await cycle(tx, other, { mainRegion: "lumbar" });
      await closeCycleRow(tx, otherCycle, "2026-10-20");
      const current = await cycle(tx, await newPatient(tx), { mainRegion: "lumbar" });
      return relapseCandidate(tx, PRACTICE_A, clock, current, "lumbar");
    });
    expect(result).toBeNull();
  });

  it("linkRelapse collega il ciclo chiuso 40 giorni fa e copia obiettivo e attività", async () => {
    const saved = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const old = await cycle(tx, patientId, { openedOn: "2026-08-01", mainRegion: "lumbar", goal: "Allacciarsi le scarpe" });
      await addPsfsItem(tx, PRACTICE_A, clock, { cycleId: old, activity: "Guidare 30 minuti" });
      await addPsfsItem(tx, PRACTICE_A, clock, { cycleId: old, activity: "Allacciarmi le scarpe" });
      await closeCycleRow(tx, old, "2026-09-25");
      const current = await cycle(tx, patientId, { openedOn: "2026-11-02", mainRegion: "lumbar" });
      await linkRelapse(tx, PRACTICE_A, clock, { cycleId: current, previousCycleId: old });
      return {
        old,
        row: await cycleRow(tx, current),
        items: await items(tx, current),
        oldItems: await items(tx, old),
        // La domanda ha avuto la sua risposta: non si ripropone.
        candidateAfter: await relapseCandidate(tx, PRACTICE_A, clock, current, "lumbar"),
      };
    });
    expect(saved.candidateAfter).toBeNull();
    expect(saved.row).toMatchObject({ previous_cycle_id: saved.old, goal: "Allacciarsi le scarpe" });
    expect(saved.items.map((i) => [i.position, i.activity])).toEqual([
      [1, "Guidare 30 minuti"],
      [2, "Allacciarmi le scarpe"],
    ]);
    // Attività nuove del ciclo nuovo, non quelle del ciclo chiuso.
    expect(saved.items.map((i) => i.id)).not.toContain(saved.oldItems[0]?.id);
  });

  it("linkRelapse non tocca obiettivo e attività già scritti", async () => {
    const saved = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const old = await cycle(tx, patientId, { mainRegion: "lumbar", goal: "Allacciarsi le scarpe" });
      await addPsfsItem(tx, PRACTICE_A, clock, { cycleId: old, activity: "Guidare 30 minuti" });
      await closeCycleRow(tx, old, "2026-10-20");
      const current = await cycle(tx, patientId, {
        openedOn: "2026-11-02",
        mainRegion: "lumbar",
        goal: "Correre di nuovo",
      });
      await addPsfsItem(tx, PRACTICE_A, clock, { cycleId: current, activity: "Correre 5 km" });
      await linkRelapse(tx, PRACTICE_A, clock, { cycleId: current, previousCycleId: old });
      return { old, row: await cycleRow(tx, current), items: await items(tx, current) };
    });
    expect(saved.row).toMatchObject({ previous_cycle_id: saved.old, goal: "Correre di nuovo" });
    expect(saved.items.map((i) => i.activity)).toEqual(["Correre 5 km"]);
  });

  it("linkRelapse su un ciclo di un altro paziente o su sé stesso è Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const current = await cycle(tx, patientId, { openedOn: "2026-11-02", mainRegion: "lumbar" });
      const otherClosed = await cycle(tx, await newPatient(tx, "Altro"), { mainRegion: "lumbar" });
      await closeCycleRow(tx, otherClosed, "2026-10-20");
      for (const previousCycleId of [otherClosed, current]) {
        await expectDomainError(linkRelapse(tx, PRACTICE_A, clock, { cycleId: current, previousCycleId }), NOT_ALLOWED);
      }
      expect((await cycleRow(tx, current))?.previous_cycle_id).toBeNull();
    });
  });

  it("linkRelapse vuole il ciclo proposto: chiuso 100 giorni fa, di un'altra regione o senza regione no", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const old100 = await cycle(tx, patientId, {
        openedOn: "2026-06-01",
        mainRegion: "lumbar",
        goal: "Allacciarsi le scarpe",
      });
      await addPsfsItem(tx, PRACTICE_A, clock, { cycleId: old100, activity: "Guidare 30 minuti" });
      await closeCycleRow(tx, old100, "2026-07-27");
      const cervical = await cycle(tx, patientId, { openedOn: "2026-08-01", mainRegion: "cervical" });
      await closeCycleRow(tx, cervical, "2026-10-20");
      const current = await cycle(tx, patientId, { openedOn: "2026-11-02", mainRegion: "lumbar" });
      for (const previousCycleId of [old100, cervical]) {
        await expectDomainError(linkRelapse(tx, PRACTICE_A, clock, { cycleId: current, previousCycleId }), NOT_ALLOWED);
      }
      const noRegion = await cycle(tx, await newPatient(tx, "Senza"), { openedOn: "2026-11-02" });
      await expectDomainError(
        linkRelapse(tx, PRACTICE_A, clock, { cycleId: noRegion, previousCycleId: old100 }),
        NOT_ALLOWED,
      );
      expect(await cycleRow(tx, current)).toMatchObject({ previous_cycle_id: null, goal: null });
      expect(await items(tx, current)).toEqual([]);
    });
  });

  it("un secondo linkRelapse dopo il primo è Operazione non permessa e il collegamento resta", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const older = await cycle(tx, patientId, { openedOn: "2026-08-01", mainRegion: "lumbar", goal: "Primo obiettivo" });
      await closeCycleRow(tx, older, "2026-09-10");
      const newer = await cycle(tx, patientId, {
        openedOn: "2026-09-15",
        mainRegion: "lumbar",
        goal: "Secondo obiettivo",
      });
      await closeCycleRow(tx, newer, "2026-10-20");
      const current = await cycle(tx, patientId, { openedOn: "2026-11-02", mainRegion: "lumbar" });
      await linkRelapse(tx, PRACTICE_A, clock, { cycleId: current, previousCycleId: newer });
      for (const previousCycleId of [newer, older]) {
        await expectDomainError(linkRelapse(tx, PRACTICE_A, clock, { cycleId: current, previousCycleId }), NOT_ALLOWED);
      }
      expect(await cycleRow(tx, current)).toMatchObject({ previous_cycle_id: newer, goal: "Secondo obiettivo" });
    });
  });
});

describe("closeCycle", () => {
  it("raggiunto oggi con i finali sulla bozza più recente: tre finali, ciclo chiuso, richiamo a 6 settimane", async () => {
    const saved = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      await setPatientRecall(tx, patientId, 8, true);
      const cycleId = await cycle(tx, patientId);
      const ids = await threeItems(tx, cycleId);
      const first = await session(tx, patientId, cycleId, "2026-10-05");
      for (const [i, id] of ids.entries()) await score(tx, id, first, [4, 3, 5][i] ?? 0);
      await closeVisitRow(tx, first);
      const last = await session(tx, patientId, cycleId, "2026-11-04");
      await closeCycle(
        tx,
        PRACTICE_A,
        clock,
        close(cycleId, {
          outcomeNote: "  Torna a guidare senza dolore  ",
          finalScores: ids.map((itemId, i) => ({ itemId, score: [8, 7, 9][i] })),
        }),
      );
      return {
        ids,
        last,
        row: await cycleRow(tx, cycleId),
        finals: await scores(tx, { phase: "finale", visitId: last }),
        recall: await patientRecall(tx, patientId),
      };
    });
    expect(saved.finals).toHaveLength(3);
    expect(new Map(saved.finals.map((s) => [s.itemId, s.score]))).toEqual(
      new Map([
        [saved.ids[0], 8],
        [saved.ids[1], 7],
        [saved.ids[2], 9],
      ]),
    );
    expect(saved.row).toMatchObject({
      status: "closed",
      closed_on: TODAY,
      outcome: "raggiunto",
      outcome_note: "Torna a guidare senza dolore",
    });
    expect(saved.recall).toEqual({ weeks: 6, paused: false });
  });

  it("con l'ultima visita già chiusa i finali rispondono con la frase e niente cambia", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const ids = await threeItems(tx, cycleId);
      const visit = await session(tx, patientId, cycleId, "2026-10-05");
      for (const id of ids) await score(tx, id, visit, 4);
      await closeVisitRow(tx, visit);
      await expectDomainError(
        closeCycle(tx, PRACTICE_A, clock, close(cycleId, { finalScores: ids.map((itemId) => ({ itemId, score: 8 })) })),
        VOICE_1,
      );
      expect((await cycleRow(tx, cycleId))?.status).toBe("open");
      expect(await scores(tx, { phase: "finale" })).toEqual([]);
    });
  });

  it("con l'ultima visita già chiusa «Paziente non tornato» chiude senza finali e senza 42501", async () => {
    const saved = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const ids = await threeItems(tx, cycleId);
      const visit = await session(tx, patientId, cycleId, "2026-10-05");
      for (const id of ids) await score(tx, id, visit, 4);
      await closeVisitRow(tx, visit);
      await closeCycle(tx, PRACTICE_A, clock, close(cycleId, { finalScores: "non_tornato" }));
      return { row: await cycleRow(tx, cycleId), finals: await scores(tx, { phase: "finale", visitId: visit }) };
    });
    expect(saved.row).toMatchObject({ status: "closed", outcome: "raggiunto" });
    expect(saved.finals).toEqual([]);
  });

  it("con la bozza più recente «Paziente non tornato» chiude senza finali", async () => {
    const saved = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      await threeItems(tx, cycleId);
      const last = await session(tx, patientId, cycleId, "2026-11-04");
      await closeCycle(tx, PRACTICE_A, clock, close(cycleId, { finalScores: "non_tornato" }));
      return { row: await cycleRow(tx, cycleId), finals: await scores(tx, { visitId: last }) };
    });
    expect(saved.row?.status).toBe("closed");
    expect(saved.finals).toEqual([]);
  });

  it("con la bozza più recente che è la visita dell'iniziale: frase dei finali, nessun 23505, canScoreFinal falso", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const ids = await threeItems(tx, cycleId);
      const visit = await session(tx, patientId, cycleId, "2026-11-04");
      for (const id of ids) await score(tx, id, visit, 4);
      await expectDomainError(
        closeCycle(tx, PRACTICE_A, clock, close(cycleId, { finalScores: ids.map((itemId) => ({ itemId, score: 8 })) })),
        VOICE_1,
      );
      // Nessun errore del database: la transazione resta valida e si rilegge.
      expect((await cycleRow(tx, cycleId))?.status).toBe("open");
      expect(await scores(tx, { visitId: visit })).toHaveLength(3);
      expect(await getCycleClosing(tx, PRACTICE_A, clock, cycleId)).toMatchObject({
        hasDraftVisit: true,
        canScoreFinal: false,
      });
    });
  });

  it("un'attività senza finale o un'attività di un altro ciclo sono rifiutate e niente cambia", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const ids = await threeItems(tx, cycleId);
      await session(tx, patientId, cycleId, "2026-11-04");
      const two = ids.slice(0, 2).map((itemId) => ({ itemId, score: 8 }));
      await expectDomainError(closeCycle(tx, PRACTICE_A, clock, close(cycleId, { finalScores: two })), ALL_FINAL);
      await expectDomainError(
        closeCycle(tx, PRACTICE_A, clock, close(cycleId, { finalScores: [...two, { itemId: PSFS_ITEM_A, score: 8 }] })),
        INVALID,
      );
      await expectDomainError(
        closeCycle(tx, PRACTICE_A, clock, close(cycleId, { finalScores: [...two, { itemId: ids[0], score: 8 }] })),
        INVALID,
      );
      const eleven = close(cycleId, { finalScores: [{ itemId: ids[0], score: 11 }] });
      expect((await formFailure(closeCycle(tx, PRACTICE_A, clock, eleven))).message).toBe(INVALID);
      expect((await cycleRow(tx, cycleId))?.status).toBe("open");
      expect(await scores(tx, { phase: "finale" })).toEqual([]);
    });
  });

  it("rinviato al medico senza rinvio: «Per chiudere come rinviato al medico prepara prima la lettera.»", async () => {
    await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx));
      await expectDomainError(
        closeCycle(tx, PRACTICE_A, clock, close(cycleId, { outcome: "rinviato_al_medico", recall: "nessuno" })),
        NEEDS_LETTER,
      );
      expect((await cycleRow(tx, cycleId))?.status).toBe("open");
    });
  });

  it("rinviato al medico con un rinvio del ciclo e «Nessun richiamo»: chiude, richiami in pausa, cadenza invariata", async () => {
    const saved = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      await setPatientRecall(tx, patientId, 8);
      const cycleId = await cycle(tx, patientId);
      await referral(tx, patientId, cycleId);
      await closeCycle(tx, PRACTICE_A, clock, close(cycleId, { outcome: "rinviato_al_medico", recall: "nessuno" }));
      return { row: await cycleRow(tx, cycleId), recall: await patientRecall(tx, patientId) };
    });
    expect(saved.row).toMatchObject({ status: "closed", outcome: "rinviato_al_medico" });
    expect(saved.recall).toEqual({ weeks: 8, paused: true });
  });

  it("la chiusura domani o prima dell'apertura è rifiutata col suo testo", async () => {
    await inUserA(db, async (tx) => {
      const cycleId = await cycle(tx, await newPatient(tx), { openedOn: "2026-10-01" });
      const tomorrow = await formFailure(closeCycle(tx, PRACTICE_A, clock, close(cycleId, { closedOn: "2026-11-05" })));
      expect(tomorrow).toMatchObject({ message: IN_FUTURE, fieldErrors: { closedOn: IN_FUTURE } });
      await expectDomainError(closeCycle(tx, PRACTICE_A, clock, close(cycleId, { closedOn: "2026-09-30" })), BEFORE_OPENING);
      expect((await cycleRow(tx, cycleId))?.status).toBe("open");
      // Il giorno dell'apertura passa.
      await closeCycle(tx, PRACTICE_A, clock, close(cycleId, { closedOn: "2026-10-01" }));
      expect((await cycleRow(tx, cycleId))?.closed_on).toBe("2026-10-01");
    });
  });

  it("con appuntamenti prenotati o confermati da oggi in poi non si chiude, col testo dell'archivio", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      await appointment(tx, patientId, cycleId, "2026-10-28");
      // Uno di stamattina, già passato ma non segnato, conta come futuro (00:00 di oggi).
      await appointment(tx, patientId, cycleId, TODAY, "08:00", "confermato");
      await expectDomainError(closeCycle(tx, PRACTICE_A, clock, close(cycleId)), "Prima annulla l'appuntamento futuro.");
      expect((await cycleRow(tx, cycleId))?.status).toBe("open");

      await appointment(tx, patientId, cycleId, "2026-11-16", "09:00", "prenotato");
      await expectDomainError(closeCycle(tx, PRACTICE_A, clock, close(cycleId)), "Prima annulla i 2 appuntamenti futuri.");
      expect(await patientRecall(tx, patientId)).toEqual({ weeks: null, paused: false });
      expect((await cycleRow(tx, cycleId))?.status).toBe("open");
    });
  });

  it("chiude se gli appuntamenti dopo oggi sono annullati o saltati, o se i prenotati sono di ieri o di un altro ciclo", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      await appointment(tx, patientId, cycleId, "2026-11-09", "09:00", "annullato");
      await appointment(tx, patientId, cycleId, "2026-11-10", "09:00", "saltato");
      await appointment(tx, patientId, cycleId, "2026-11-03", "09:00", "prenotato");
      const other = await newPatient(tx, "Altro");
      await appointment(tx, other, await cycle(tx, other), "2026-11-16", "09:00", "prenotato");
      await closeCycle(tx, PRACTICE_A, clock, close(cycleId));
      expect((await cycleRow(tx, cycleId))?.status).toBe("closed");
    });
  });

  it("un ciclo già chiuso è Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      await closeCycleRow(tx, cycleId, "2026-10-30");
      await expectDomainError(closeCycle(tx, PRACTICE_A, clock, close(cycleId)), NOT_ALLOWED);
      expect(await cycleRow(tx, cycleId)).toMatchObject({ closed_on: "2026-10-30", outcome: "raggiunto" });
      expect(await patientRecall(tx, patientId)).toEqual({ weeks: null, paused: false });
    });
  });

  it("un mantenimento senza attività né visite chiude", async () => {
    const saved = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId, { kind: "mantenimento" });
      await closeCycle(tx, PRACTICE_A, clock, close(cycleId, { finalScores: [], recall: { weeks: 12 } }));
      return { row: await cycleRow(tx, cycleId), recall: await patientRecall(tx, patientId) };
    });
    expect(saved.row).toMatchObject({ kind: "mantenimento", status: "closed", closed_on: TODAY });
    expect(saved.recall).toEqual({ weeks: 12, paused: false });
  });
});

describe("getCycleClosing", () => {
  it("ultimo fatto il 22/10: 51 cadenze da 2 a 52, con «Richiamo il 03/12/2026» a 6 settimane", async () => {
    const view = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      await appointment(tx, patientId, cycleId, "2026-10-08");
      await appointment(tx, patientId, cycleId, "2026-10-22");
      await appointment(tx, patientId, cycleId, "2026-11-10", "09:00", "prenotato");
      return getCycleClosing(tx, PRACTICE_A, clock, cycleId);
    });
    const choices = view?.recallChoices ?? [];
    expect(choices).toHaveLength(51);
    expect(choices[0]?.weeks).toBe(2);
    expect(choices.at(-1)?.weeks).toBe(52);
    expect(choices.filter((c) => [4, 6, 8, 12].includes(c.weeks))).toEqual([
      { weeks: 4, text: "Richiamo il 19/11/2026" },
      { weeks: 6, text: "Richiamo il 03/12/2026" },
      { weeks: 8, text: "Richiamo il 17/12/2026" },
      { weeks: 12, text: "Richiamo il 14/01/2027" },
    ]);
  });

  it("senza fatti le cadenze sono null; la cadenza proposta è quella del paziente, altrimenti 6", async () => {
    const views = await inUserA(db, async (tx) => {
      const noCadence = await newPatient(tx, "Uno");
      const withCadence = await newPatient(tx, "Due");
      await setPatientRecall(tx, withCadence, 8, true);
      return {
        noCadence: await getCycleClosing(tx, PRACTICE_A, clock, await cycle(tx, noCadence)),
        withCadence: await getCycleClosing(tx, PRACTICE_A, clock, await cycle(tx, withCadence)),
      };
    });
    expect(views.noCadence).toMatchObject({ recallChoices: null, proposedWeeks: 6 });
    expect(views.withCadence).toMatchObject({ recallChoices: null, proposedWeeks: 8 });
  });

  it("legge ciclo, attività con l'iniziale, rinvio, bozza più recente senza punteggi: canScoreFinal vero", async () => {
    const saved = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId, { openedOn: "2026-10-01", title: "Lombare, ottobre 2026" });
      const ids = await threeItems(tx, cycleId);
      const first = await session(tx, patientId, cycleId, "2026-10-05");
      await score(tx, ids[0] ?? "", first, 4);
      await score(tx, ids[1] ?? "", first, 3);
      await closeVisitRow(tx, first);
      await session(tx, patientId, cycleId, "2026-11-04");
      await referral(tx, patientId, cycleId);
      return { patientId, cycleId, ids, view: await getCycleClosing(tx, PRACTICE_A, clock, cycleId) };
    });
    expect(saved.view).toEqual({
      cycleId: saved.cycleId,
      patientId: saved.patientId,
      kind: "trattamento",
      title: "Lombare, ottobre 2026",
      openedOn: "2026-10-01",
      today: TODAY,
      psfs: [
        { itemId: saved.ids[0], activity: "Guidare 30 minuti", initial: 4 },
        { itemId: saved.ids[1], activity: "Dormire sul fianco destro", initial: 3 },
        { itemId: saved.ids[2], activity: "Allacciarmi le scarpe", initial: null },
      ],
      hasDraftVisit: true,
      canScoreFinal: true,
      proposedWeeks: 6,
      recallChoices: expect.any(Array),
      hasReferral: true,
    });
  });

  it("senza bozza hasDraftVisit e canScoreFinal sono falsi, anche con una bozza più vecchia", async () => {
    const views = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      await threeItems(tx, cycleId);
      const none = await getCycleClosing(tx, PRACTICE_A, clock, cycleId);
      await session(tx, patientId, cycleId, "2026-10-05");
      await closeVisitRow(tx, await session(tx, patientId, cycleId, "2026-10-12"));
      return { none, olderDraft: await getCycleClosing(tx, PRACTICE_A, clock, cycleId) };
    });
    for (const view of [views.none, views.olderDraft]) {
      expect(view).toMatchObject({ hasDraftVisit: false, canScoreFinal: false, hasReferral: false });
    }
  });

  it("senza attività una bozza non dà canScoreFinal; un ciclo chiuso o assente dà null", async () => {
    const views = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId, { kind: "mantenimento" });
      await session(tx, patientId, cycleId, "2026-11-04");
      const open = await getCycleClosing(tx, PRACTICE_A, clock, cycleId);
      const closed = await cycle(tx, await newPatient(tx, "Altro"));
      await closeCycleRow(tx, closed, "2026-10-30");
      return {
        open,
        closed: await getCycleClosing(tx, PRACTICE_A, clock, closed),
        missing: await getCycleClosing(tx, PRACTICE_A, clock, "a0000000-0000-4000-8000-00000000ffff"),
      };
    });
    expect(views.open).toMatchObject({ kind: "mantenimento", psfs: [], hasDraftVisit: true, canScoreFinal: false });
    expect(views.closed).toBeNull();
    expect(views.missing).toBeNull();
  });
});

// Studio B sugli id di A: un database tutto suo, perché qui le transazioni di uB arrivano al commit
// (un DomainError lascia la transazione valida) e si rilegge A dopo.
describe("studio B sugli id di A", () => {
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
      cycles: await tx.query("select * from public.treatment_cycles where practice_id = $1 order by id", [PRACTICE_A]),
      items: await tx.query("select * from public.psfs_items where practice_id = $1 order by id", [PRACTICE_A]),
      scores: await tx.query("select * from public.psfs_scores where practice_id = $1 order by id", [PRACTICE_A]),
      patients: await tx.query("select * from public.patients where practice_id = $1 order by id", [PRACTICE_A]),
    }));

  it("ogni comando è Operazione non permessa, le letture non trovano niente, e A non cambia", async () => {
    // Un ciclo chiuso del paziente di CYCLE_A con la stessa regione, perché la ricaduta abbia un candidato vero.
    const closedA = await asUserA(isolated, async (tx) => {
      const [row] = await tx.query<{ id: string }>(
        `insert into public.treatment_cycles (practice_id, patient_id, opened_on, title, expected_sessions, main_region,
                                              status, closed_on, outcome)
         values ($1, $2, '2026-07-01', 'Lombalgia, luglio 2026', 4, 'lumbar', 'closed', '2026-09-20', 'raggiunto')
         returning id`,
        [PRACTICE_A, PATIENT_A1],
      );
      if (!row) throw new Error("ciclo non creato");
      return row.id;
    });
    const before = await snapshotOfA();
    await asUserB(isolated, async (tx) => {
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        await expectDomainError(
          updateCycleOpening(tx, practiceId, clock, { cycleId: CYCLE_A, goal: "Inventato" }),
          NOT_ALLOWED,
        );
        await expectDomainError(addPsfsItem(tx, practiceId, clock, { cycleId: CYCLE_A, activity: "Inventata" }), NOT_ALLOWED);
        await expectDomainError(
          renamePsfsItem(tx, practiceId, clock, { itemId: PSFS_ITEM_A, activity: "Inventata" }),
          NOT_ALLOWED,
        );
        await expectDomainError(removePsfsItem(tx, practiceId, clock, { itemId: PSFS_ITEM_A }), NOT_ALLOWED);
        await expectDomainError(
          linkRelapse(tx, practiceId, clock, { cycleId: CYCLE_A, previousCycleId: closedA }),
          NOT_ALLOWED,
        );
        await expectDomainError(
          closeCycle(tx, practiceId, clock, close(CYCLE_A, { outcome: "rinviato_al_medico", recall: "nessuno" })),
          NOT_ALLOWED,
        );
        expect(await getCycleClosing(tx, practiceId, clock, CYCLE_A)).toBeNull();
        expect(await relapseCandidate(tx, practiceId, clock, CYCLE_A, "lumbar")).toBeNull();
      }
    });
    expect(await snapshotOfA()).toEqual(before);
    // Come uA la ricaduta c'è: la lettura di uB era vuota per lo studio, non per i dati.
    expect(await asUserA(isolated, (tx) => relapseCandidate(tx, PRACTICE_A, clock, CYCLE_A, "lumbar"))).toEqual({
      id: closedA,
      title: "Lombalgia, luglio 2026",
    });
  });
});
