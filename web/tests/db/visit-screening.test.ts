import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REGION_CODES } from "@/lib/clinical/catalog";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock, romeDateTime } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { addPsfsItem } from "@/server/domain/cycles/commands";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { removeHistoryItem, saveHistoryItem, saveLifestyle } from "@/server/domain/history/commands";
import { createPatient } from "@/server/domain/patients/commands";
import { editVisit, startVisit } from "@/server/domain/visits/commands";
import { applyVisitOp, loadScreeningState, loadVisit, screeningSource, type VisitRow } from "@/server/domain/visits/ops";
import type { VisitOp } from "@/server/domain/visits/schemas";
import { PATIENT_A1, PRACTICE_A, PRACTICE_B, PSFS_ITEM_A, SERVICE_A, VISIT_A } from "./fixtures";
import { asUserA, asUserB, inUserA, openTestDb } from "./helpers";

// Lo screening della visita: risposte, "Nessun'altra
// voce", conferma con gli esiti, "Nessuna variazione" e il PSFS iniziale. I dati nascono come uA in ogni
// test, su pazienti nuovi, e tornano indietro. L'orologio è mercoledì 4/11/2026 alle 08:30 di Roma.

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const INVALID = "Valore non valido";
const REGIONS_REQUIRED = "Scegli almeno una regione.";
const ANSWER_ALL = 'Rispondi a ogni voce o premi "Nessun\'altra voce".';
const NOTE_REQUIRED = "Scrivi almeno 10 caratteri per spiegare l'esito.";
const INR_NOTE = "INR 2,5 del 03/11/2026 dal libretto TAO";
/** I gruppi sempre visibili. */
const ALWAYS = ["ci_sistemica", "ci_locale", "rf_rachide"] as const;

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const nameOf = (err: unknown): unknown => (err as { name?: unknown } | null)?.name;

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

async function expectDomainError(p: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
}

// Preparazione, tutta come uA ------------------------------------------------------------------------

async function newPatient(tx: Tx): Promise<string> {
  const { id } = await createPatient(tx, PRACTICE_A, clock, { firstName: "Anna", lastName: "Galli", birthDate: "1954-06-12" });
  return id;
}

async function cycle(tx: Tx, patientId: string, o: { openedOn?: string; mainRegion?: string | null } = {}): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions, main_region)
     values ($1, $2, 'trattamento', $3, 'Lombalgia, ottobre 2026', 4, $4) returning id`,
    [PRACTICE_A, patientId, o.openedOn ?? "2026-10-01", o.mainRegion ?? null],
  );
  if (!row) throw new Error("ciclo non creato");
  return row.id;
}

/** Un appuntamento fatto del giorno dato e la sua visita, aperta con `startVisit`. */
async function visitOn(tx: Tx, patientId: string, cycleId: string, day: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status)
     values ($1, $2, $3, $4, $5, 45, 6000, 'fatto') returning id`,
    [PRACTICE_A, patientId, SERVICE_A, cycleId, romeDateTime(day, "09:00")],
  );
  if (!row) throw new Error("appuntamento non creato");
  return (await startVisit(tx, PRACTICE_A, clock, { appointmentId: row.id })).visitId;
}

/** Paziente, ciclo e una visita del 3/11. */
async function setup(tx: Tx, cycleOpts: { mainRegion?: string | null } = {}) {
  const patientId = await newPatient(tx);
  const cycleId = await cycle(tx, patientId, cycleOpts);
  const visitId = await visitOn(tx, patientId, cycleId, "2026-11-03");
  return { patientId, cycleId, visitId };
}

const run = (tx: Tx, visitId: string, op: Record<string, unknown>) => editVisit(tx, PRACTICE_A, clock, { visitId, op });

const answer = (itemCode: string, value: "no" | "si" | "non_so", extra: Record<string, unknown> = {}) => ({
  op: "risposta",
  itemCode,
  answer: value,
  ...extra,
});

async function noOthers(tx: Tx, visitId: string, groups: readonly string[] = ALWAYS): Promise<void> {
  for (const group of groups) await run(tx, visitId, { op: "nessun_altra_voce", group });
}

const outcomes = (direct: { outcome: string; overrideNote?: string | null }, thrust = "contraindicated", indirect = "indicated") => ({
  op: "esiti",
  outcomes: [
    { family: "thrust", outcome: thrust, overrideNote: null },
    { family: "direct", outcome: direct.outcome, overrideNote: direct.overrideNote ?? null },
    { family: "indirect", outcome: indirect, overrideNote: null },
  ],
});

/** La visita di Anna: ci_avk «si», il resto «no», dirette con cautela con la nota dell'INR. */
async function confirmedWithAvk(tx: Tx, visitId: string): Promise<void> {
  await run(tx, visitId, answer("ci_avk", "si"));
  await noOthers(tx, visitId);
  await run(tx, visitId, outcomes({ outcome: "caution", overrideNote: INR_NOTE }));
}

async function closeVisitRow(tx: Tx, visitId: string): Promise<void> {
  await tx.query("update public.visits set status = 'closed', closed_at = $3 where practice_id = $1 and id = $2", [
    PRACTICE_A,
    visitId,
    clock.now(),
  ]);
}

async function visitOf(tx: Tx, visitId: string): Promise<VisitRow> {
  const visit = await loadVisit(tx, PRACTICE_A, visitId);
  if (!visit) throw new Error("visita non trovata");
  return visit;
}

// Riletture ------------------------------------------------------------------------------------------

interface AnswerRow {
  itemCode: string;
  answer: string;
  regions: string[];
  subAnswers: string[];
  fromHistory: boolean;
  note: string | null;
}

async function answersOf(tx: Tx, visitId: string): Promise<AnswerRow[]> {
  return tx.query<AnswerRow>(
    `select item_code as "itemCode", answer, regions, sub_answers as "subAnswers", from_history as "fromHistory", note
       from public.visit_screening_answers
      where visit_id = $1
      order by item_code`,
    [visitId],
  );
}

async function answerOf(tx: Tx, visitId: string, itemCode: string): Promise<AnswerRow | undefined> {
  return (await answersOf(tx, visitId)).find((a) => a.itemCode === itemCode);
}

async function outcomesOf(tx: Tx, visitId: string) {
  return tx.query<{
    family: string;
    suggested: string;
    outcome: string;
    localContraindicatedRegions: string[];
    overrideNote: string | null;
  }>(
    `select family, suggested, outcome, local_contraindicated_regions as "localContraindicatedRegions",
            override_note as "overrideNote"
       from public.visit_screening_outcomes
      where visit_id = $1
      order by array_position(array['thrust', 'direct', 'indirect'], family)`,
    [visitId],
  );
}

async function reviewedAt(tx: Tx, visitId: string): Promise<Date | null> {
  const [row] = await tx.query<{ at: Date | null }>('select screening_reviewed_at as "at" from public.visits where id = $1', [
    visitId,
  ]);
  return row?.at ?? null;
}

// ----------------------------------------------------------------------------------------------------

describe("risposta", () => {
  it("loc_aorta «si» senza regioni è «Scegli almeno una regione.»; con [lumbar] è una riga con la regione", async () => {
    const { failure, after } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      const failure = await formFailure(run(tx, visitId, answer("loc_aorta", "si", { regions: [] })));
      expect(await answersOf(tx, visitId)).toEqual([]);
      await run(tx, visitId, answer("loc_aorta", "si", { regions: ["lumbar"] }));
      return { failure, after: await answersOf(tx, visitId) };
    });
    expect(failure.message).toBe(REGIONS_REQUIRED);
    expect(failure.fieldErrors).toMatchObject({ "op.regions": REGIONS_REQUIRED });
    expect(after).toEqual([
      { itemCode: "loc_aorta", answer: "si", regions: ["lumbar"], subAnswers: [], fromHistory: false, note: null },
    ]);
  });

  it("una seconda risposta sulla stessa voce la sostituisce: una riga sola", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, answer("ci_osteo", "si", { note: "Densitometria del 2025" }));
      await run(tx, visitId, answer("ci_osteo", "no"));
      return answersOf(tx, visitId);
    });
    expect(rows).toEqual([
      { itemCode: "ci_osteo", answer: "no", regions: [], subAnswers: [], fromHistory: false, note: null },
    ]);
  });

  it("sottovoci della voce e nota si salvano; «non_so» locale senza regioni è ammesso", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, answer("ci_nao", "si", { subAnswers: ["assunzione_regolare"], note: "  Eliquis da marzo  " }));
      await run(tx, visitId, answer("loc_disc", "non_so"));
      return answersOf(tx, visitId);
    });
    expect(rows).toEqual([
      {
        itemCode: "ci_nao",
        answer: "si",
        regions: [],
        subAnswers: ["assunzione_regolare"],
        fromHistory: false,
        note: "Eliquis da marzo",
      },
      { itemCode: "loc_disc", answer: "non_so", regions: [], subAnswers: [], fromHistory: false, note: null },
    ]);
  });

  it("una voce fuori catalogo, regioni su una voce globale, una sottovoce non sua, una nota di 301 caratteri sono rifiutate", async () => {
    await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      expect((await formFailure(run(tx, visitId, answer("anticoagulanti", "si")))).message).toBe(INVALID);
      expect((await formFailure(run(tx, visitId, answer("ci_osteo", "si", { regions: ["lumbar"] })))).message).toBe(INVALID);
      expect((await formFailure(run(tx, visitId, answer("ci_nao", "si", { subAnswers: ["fumo"] })))).message).toBe(INVALID);
      expect((await formFailure(run(tx, visitId, { op: "risposta", itemCode: "ci_osteo", answer: "forse" }))).message).toBe(
        INVALID,
      );
      const long = await formFailure(run(tx, visitId, answer("ci_osteo", "si", { note: "x".repeat(301) })));
      expect(long.message).toBe("Massimo 300 caratteri.");
      expect(await answersOf(tx, visitId)).toEqual([]);
    });
  });

  it("loc_fixation da anamnesi vale su tutte le regioni; una risposta la restringe e non è più da anamnesi", async () => {
    const { proposed, narrowed } = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      await saveHistoryItem(tx, PRACTICE_A, clock, {
        patientId,
        kind: "intervento",
        label: "Protesi d'anca destra",
        region: "lower_extremity",
        occurredOn: null,
        occurredYear: 2019,
        ongoing: false,
        riskTags: ["mezzi_di_sintesi"],
        note: null,
      });
      const visitId = await visitOn(tx, patientId, await cycle(tx, patientId), "2026-11-03");
      const proposed = await answersOf(tx, visitId);
      await run(tx, visitId, answer("loc_fixation", "si", { regions: ["lower_extremity"] }));
      return { proposed, narrowed: await answersOf(tx, visitId) };
    });
    expect(proposed).toEqual([
      { itemCode: "loc_fixation", answer: "si", regions: [...REGION_CODES], subAnswers: [], fromHistory: true, note: null },
    ]);
    expect(narrowed).toEqual([
      { itemCode: "loc_fixation", answer: "si", regions: ["lower_extremity"], subAnswers: [], fromHistory: false, note: null },
    ]);
  });

  it("una voce di un gruppo nascosto è Operazione non permessa: pediatriche spente, cervicale senza regione principale", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId, cycleId } = await setup(tx);
      await expectDomainError(run(tx, visitId, answer("rf_ped_bilious", "si")), NOT_ALLOWED);
      await expectDomainError(run(tx, visitId, answer("cv_unlike", "si")), NOT_ALLOWED);
      // Alla prima visita con la regione principale cervicale il gruppo cervicale si apre.
      await tx.query("update public.treatment_cycles set main_region = 'cervical' where id = $1", [cycleId]);
      await run(tx, visitId, answer("cv_unlike", "no"));
      return answersOf(tx, visitId);
    });
    expect(rows.map((r) => r.itemCode)).toEqual(["cv_unlike"]);
  });
});

describe("nessun_altra_voce", () => {
  it("ci_sistemica con ci_osteo già «si» scrive «no» sulle altre 5 voci e lascia ci_osteo", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, answer("ci_osteo", "si"));
      await run(tx, visitId, { op: "nessun_altra_voce", group: "ci_sistemica" });
      return answersOf(tx, visitId);
    });
    expect(rows.map((r) => [r.itemCode, r.answer])).toEqual([
      ["ci_avk", "no"],
      ["ci_coag", "no"],
      ["ci_connective", "no"],
      ["ci_integrity", "no"],
      ["ci_nao", "no"],
      ["ci_osteo", "si"],
    ]);
    expect(rows.filter((r) => r.answer === "no").every((r) => !r.fromHistory)).toBe(true);
  });

  it("un gruppo nascosto è Operazione non permessa; un gruppo che non c'è è Valore non valido", async () => {
    await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await expectDomainError(run(tx, visitId, { op: "nessun_altra_voce", group: "rf_gravidanza" }), NOT_ALLOWED);
      expect((await formFailure(run(tx, visitId, { op: "nessun_altra_voce", group: "rf_altro" }))).message).toBe(INVALID);
      expect(await answersOf(tx, visitId)).toEqual([]);
    });
  });
});

describe("esiti", () => {
  it("con una voce visibile senza risposta è «Rispondi a ogni voce o premi \"Nessun'altra voce\".» e niente si salva", async () => {
    const { outcomesRows, at } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await noOthers(tx, visitId, ["ci_sistemica", "ci_locale"]);
      await expectDomainError(run(tx, visitId, outcomes({ outcome: "indicated" }, "indicated")), ANSWER_ALL);
      return { outcomesRows: await outcomesOf(tx, visitId), at: await reviewedAt(tx, visitId) };
    });
    expect(outcomesRows).toEqual([]);
    expect(at).toBeNull();
  });

  it("ci_avk «si» con le dirette con cautela senza nota è «Scrivi almeno 10 caratteri per spiegare l'esito.» sulla nota delle dirette", async () => {
    const { failure, rows } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, answer("ci_avk", "si"));
      await noOthers(tx, visitId);
      const failure = await formFailure(run(tx, visitId, outcomes({ outcome: "caution" })));
      const short = await formFailure(run(tx, visitId, outcomes({ outcome: "caution", overrideNote: "  INR ok   " })));
      expect(short.message).toBe(NOTE_REQUIRED);
      return { failure, rows: await outcomesOf(tx, visitId) };
    });
    expect(failure.message).toBe(NOTE_REQUIRED);
    expect(failure.fieldErrors).toEqual({ "outcomes.1.overrideNote": NOTE_REQUIRED });
    expect(rows).toEqual([]);
  });

  it("con la nota dell'INR salva i tre esiti, il suggerito e la nota, e screening_reviewed_at è l'orologio", async () => {
    const { rows, at } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await confirmedWithAvk(tx, visitId);
      return { rows: await outcomesOf(tx, visitId), at: await reviewedAt(tx, visitId) };
    });
    expect(rows).toEqual([
      { family: "thrust", suggested: "contraindicated", outcome: "contraindicated", localContraindicatedRegions: [], overrideNote: null },
      { family: "direct", suggested: "contraindicated", outcome: "caution", localContraindicatedRegions: [], overrideNote: INR_NOTE },
      { family: "indirect", suggested: "indicated", outcome: "indicated", localContraindicatedRegions: [], overrideNote: null },
    ]);
    expect(at).toEqual(clock.now());
  });

  it("le regioni controindicate vengono dalle voci locali; un esito più severo del suggerito non vuole la nota", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, answer("loc_aorta", "si", { regions: ["lumbar"] }));
      await noOthers(tx, visitId);
      await run(tx, visitId, outcomes({ outcome: "indicated" }, "indicated", "caution"));
      return outcomesOf(tx, visitId);
    });
    expect(rows).toEqual([
      { family: "thrust", suggested: "indicated", outcome: "indicated", localContraindicatedRegions: ["lumbar"], overrideNote: null },
      { family: "direct", suggested: "indicated", outcome: "indicated", localContraindicatedRegions: ["lumbar"], overrideNote: null },
      { family: "indirect", suggested: "indicated", outcome: "caution", localContraindicatedRegions: [], overrideNote: null },
    ]);
  });

  it("due esiti, o una famiglia ripetuta, sono Valore non valido", async () => {
    await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await noOthers(tx, visitId);
      const two = outcomes({ outcome: "indicated" }, "indicated");
      two.outcomes.pop();
      expect((await formFailure(run(tx, visitId, two))).message).toBe(INVALID);
      const repeated = outcomes({ outcome: "indicated" }, "indicated");
      repeated.outcomes[2] = { family: "direct", outcome: "indicated", overrideNote: null };
      expect((await formFailure(run(tx, visitId, repeated))).message).toBe(INVALID);
      expect(await outcomesOf(tx, visitId)).toEqual([]);
    });
  });

  it("un esito riconfermato aggiorna le tre righe senza doppioni", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await confirmedWithAvk(tx, visitId);
      await run(tx, visitId, outcomes({ outcome: "contraindicated" }));
      return outcomesOf(tx, visitId);
    });
    expect(rows.map((r) => [r.family, r.outcome, r.overrideNote])).toEqual([
      ["thrust", "contraindicated", null],
      ["direct", "contraindicated", null],
      ["indirect", "indicated", null],
    ]);
  });
});

describe("loadScreeningState", () => {
  it("null senza conferma; dopo gli esiti gli esiti salvati e il suggerimento dalle risposte", async () => {
    const { before, after, other } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, answer("loc_aorta", "si", { regions: ["lumbar"] }));
      const before = await loadScreeningState(tx, PRACTICE_A, visitId);
      await run(tx, visitId, answer("ci_avk", "si"));
      await noOthers(tx, visitId);
      await run(tx, visitId, outcomes({ outcome: "caution", overrideNote: INR_NOTE }));
      return {
        before,
        after: await loadScreeningState(tx, PRACTICE_A, visitId),
        other: await loadScreeningState(tx, PRACTICE_B, visitId),
      };
    });
    expect(before).toBeNull();
    expect(other).toBeNull();
    expect(after?.outcomes).toEqual({
      thrust: { outcome: "contraindicated", localContraindicated: ["lumbar"] },
      direct: { outcome: "caution", localContraindicated: ["lumbar"] },
      indirect: { outcome: "indicated", localContraindicated: [] },
    });
    expect(after?.suggestion.direct).toMatchObject({ suggested: "contraindicated", reason: "terapia anticoagulante" });
  });
});

describe("una risposta dopo la conferma", () => {
  it("una risposta rf_weight «si» toglie la conferma e i tre esiti; un nuovo «esiti» riconferma", async () => {
    const { afterAnswer, afterReconfirm } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await confirmedWithAvk(tx, visitId);
      await run(tx, visitId, answer("rf_weight", "si"));
      const afterAnswer = {
        at: await reviewedAt(tx, visitId),
        rows: await outcomesOf(tx, visitId),
        weight: (await answerOf(tx, visitId, "rf_weight"))?.answer,
      };
      await run(tx, visitId, outcomes({ outcome: "caution", overrideNote: INR_NOTE }));
      return { afterAnswer, afterReconfirm: { at: await reviewedAt(tx, visitId), rows: await outcomesOf(tx, visitId) } };
    });
    expect(afterAnswer).toEqual({ at: null, rows: [], weight: "si" });
    expect(afterReconfirm.at).toEqual(clock.now());
    expect(afterReconfirm.rows).toHaveLength(3);
  });

  it("«Nessun'altra voce» su uno screening confermato toglie la conferma e i tre esiti", async () => {
    const { at, rows } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await confirmedWithAvk(tx, visitId);
      await run(tx, visitId, { op: "nessun_altra_voce", group: "ci_sistemica" });
      return { at: await reviewedAt(tx, visitId), rows: await outcomesOf(tx, visitId) };
    });
    expect(at).toBeNull();
    expect(rows).toEqual([]);
  });
});

describe("le proposte «da anamnesi» seguono l'anamnesi della bozza", () => {
  const drug = (patientId: string, label: string, extra: Record<string, unknown> = {}) => ({
    patientId,
    kind: "farmaco",
    label,
    region: null,
    occurredOn: null,
    occurredYear: null,
    ongoing: true,
    note: null,
    ...extra,
  });
  const addDrug = (tx: Tx, patientId: string, label: string, extra: Record<string, unknown> = {}) =>
    saveHistoryItem(tx, PRACTICE_A, clock, drug(patientId, label, extra));

  it("un farmaco TAO aggiunto con la visita aperta propone ci_avk «si» da anamnesi; tolto il segnale, la proposta sparisce", async () => {
    const seen = await inUserA(db, async (tx) => {
      const { patientId, visitId } = await setup(tx);
      const before = await answerOf(tx, visitId, "ci_avk");
      const { id } = await addDrug(tx, patientId, "Coumadin 5 mg");
      const added = await answerOf(tx, visitId, "ci_avk");
      await addDrug(tx, patientId, "Coumadin 5 mg", { itemId: id, riskTags: [] });
      const untagged = await answerOf(tx, visitId, "ci_avk");
      await addDrug(tx, patientId, "Coumadin 5 mg", { itemId: id, riskTags: ["anticoagulante_tao"] });
      const retagged = await answerOf(tx, visitId, "ci_avk");
      await removeHistoryItem(tx, PRACTICE_A, clock, { patientId, itemId: id });
      return { before, added, untagged, retagged, removed: await answerOf(tx, visitId, "ci_avk") };
    });
    expect(seen.before).toBeUndefined();
    expect(seen.added).toMatchObject({ answer: "si", fromHistory: true, regions: [], note: null });
    expect(seen.untagged).toBeUndefined();
    expect(seen.retagged).toMatchObject({ answer: "si", fromHistory: true });
    expect(seen.removed).toBeUndefined();
  });

  it("un TAO aggiunto su uno screening confermato porta ci_avk a «si», toglie la conferma e i tre esiti; riconfermato, le dirette sono controindicate", async () => {
    const seen = await inUserA(db, async (tx) => {
      const { patientId, visitId } = await setup(tx);
      await noOthers(tx, visitId);
      await run(tx, visitId, outcomes({ outcome: "indicated" }, "indicated"));
      const confirmedAt = await reviewedAt(tx, visitId);
      await addDrug(tx, patientId, "Warfarin 5 mg");
      const after = {
        at: await reviewedAt(tx, visitId),
        rows: await outcomesOf(tx, visitId),
        avk: await answerOf(tx, visitId, "ci_avk"),
        state: await loadScreeningState(tx, PRACTICE_A, visitId),
      };
      // L'esito di prima, «indicato», ora vuole la nota: il suggerito segue la proposta.
      await expectDomainError(run(tx, visitId, outcomes({ outcome: "indicated" }, "indicated")), NOTE_REQUIRED);
      await run(tx, visitId, outcomes({ outcome: "contraindicated" }));
      return { confirmedAt, after, reconfirmed: await outcomesOf(tx, visitId) };
    });
    expect(seen.confirmedAt).toEqual(clock.now());
    expect(seen.after).toEqual({
      at: null,
      rows: [],
      avk: expect.objectContaining({ answer: "si", fromHistory: true }),
      state: null,
    });
    expect(seen.reconfirmed.find((r) => r.family === "direct")).toMatchObject({
      suggested: "contraindicated",
      outcome: "contraindicated",
    });
  });

  it("un «si» dato dall'osteopata resta com'è e la conferma resta; un farmaco senza segnali non tocca lo screening", async () => {
    const seen = await inUserA(db, async (tx) => {
      const { patientId, visitId } = await setup(tx);
      await confirmedWithAvk(tx, visitId);
      await run(tx, visitId, answer("ci_avk", "si", { note: "INR 2,5" }));
      await run(tx, visitId, outcomes({ outcome: "caution", overrideNote: INR_NOTE }));
      const { id } = await addDrug(tx, patientId, "Warfarin 5 mg");
      const withTao = { at: await reviewedAt(tx, visitId), avk: await answerOf(tx, visitId, "ci_avk") };
      // Togliere il farmaco non toglie una risposta che l'osteopata ha dato.
      await removeHistoryItem(tx, PRACTICE_A, clock, { patientId, itemId: id });
      await addDrug(tx, patientId, "Tachipirina 1000");
      return {
        withTao,
        at: await reviewedAt(tx, visitId),
        avk: await answerOf(tx, visitId, "ci_avk"),
        rows: await outcomesOf(tx, visitId),
      };
    });
    expect(seen.withTao).toEqual({
      at: clock.now(),
      avk: expect.objectContaining({ answer: "si", fromHistory: false, note: "INR 2,5" }),
    });
    expect(seen.at).toEqual(clock.now());
    expect(seen.avk).toMatchObject({ answer: "si", fromHistory: false, note: "INR 2,5" });
    expect(seen.rows).toHaveLength(3);
  });

  it("il «si» proposto prende il posto di «no» e «non_so» ma tiene nota, sottovoci e regioni scritte dall'osteopata", async () => {
    const seen = await inUserA(db, async (tx) => {
      const { patientId, visitId } = await setup(tx);
      await run(tx, visitId, answer("ci_avk", "no", { note: "Nega anticoagulanti, da ricontrollare" }));
      await run(tx, visitId, answer("ci_nao", "non_so", { subAnswers: ["assunzione_regolare"], note: "Non ricorda il nome" }));
      await run(tx, visitId, answer("loc_fixation", "non_so", { regions: ["lumbar"], note: "Intervento anni fa" }));
      await addDrug(tx, patientId, "Warfarin 5 mg");
      await addDrug(tx, patientId, "Eliquis 5 mg");
      await addDrug(tx, patientId, "Placca lombare", { riskTags: ["mezzi_di_sintesi"] });
      return {
        avk: await answerOf(tx, visitId, "ci_avk"),
        nao: await answerOf(tx, visitId, "ci_nao"),
        fixation: await answerOf(tx, visitId, "loc_fixation"),
      };
    });
    expect(seen.avk).toEqual({
      itemCode: "ci_avk",
      answer: "si",
      regions: [],
      subAnswers: [],
      fromHistory: true,
      note: "Nega anticoagulanti, da ricontrollare",
    });
    expect(seen.nao).toMatchObject({
      answer: "si",
      fromHistory: true,
      subAnswers: ["assunzione_regolare"],
      note: "Non ricorda il nome",
    });
    expect(seen.fixation).toMatchObject({ answer: "si", fromHistory: true, regions: ["lumbar"], note: "Intervento anni fa" });
  });

  it("tolto il segnale, una proposta con il dettaglio dell'osteopata resta (non più da anamnesi) e la conferma si toglie", async () => {
    const seen = await inUserA(db, async (tx) => {
      const { patientId, visitId } = await setup(tx);
      await run(tx, visitId, answer("ci_avk", "no", { note: "Nega anticoagulanti, da ricontrollare" }));
      await run(tx, visitId, answer("loc_fixation", "non_so", { regions: ["lumbar"] }));
      await noOthers(tx, visitId);
      const tao = await addDrug(tx, patientId, "Warfarin 5 mg");
      const plate = await addDrug(tx, patientId, "Placca lombare", { riskTags: ["mezzi_di_sintesi"] });
      const screw = await addDrug(tx, patientId, "Vite del polso", { riskTags: ["mezzi_di_sintesi"] });
      await run(tx, visitId, outcomes({ outcome: "contraindicated" }));
      const confirmedAt = await reviewedAt(tx, visitId);
      await removeHistoryItem(tx, PRACTICE_A, clock, { patientId, itemId: tao.id });
      await removeHistoryItem(tx, PRACTICE_A, clock, { patientId, itemId: plate.id });
      await removeHistoryItem(tx, PRACTICE_A, clock, { patientId, itemId: screw.id });
      return {
        confirmedAt,
        at: await reviewedAt(tx, visitId),
        rows: await outcomesOf(tx, visitId),
        avk: await answerOf(tx, visitId, "ci_avk"),
        fixation: await answerOf(tx, visitId, "loc_fixation"),
      };
    });
    expect(seen.confirmedAt).toEqual(clock.now());
    expect(seen.at).toBeNull();
    expect(seen.rows).toEqual([]);
    expect(seen.avk).toMatchObject({ answer: "si", fromHistory: false, note: "Nega anticoagulanti, da ricontrollare" });
    expect(seen.fixation).toMatchObject({ answer: "si", fromHistory: false, regions: ["lumbar"], note: null });
  });

  it("tolto il segnale, una proposta locale con le regioni proposte e senza nota si ritira", async () => {
    const seen = await inUserA(db, async (tx) => {
      const { patientId, visitId } = await setup(tx);
      const plate = await addDrug(tx, patientId, "Placca lombare", { riskTags: ["mezzi_di_sintesi"] });
      const proposed = await answerOf(tx, visitId, "loc_fixation");
      await removeHistoryItem(tx, PRACTICE_A, clock, { patientId, itemId: plate.id });
      return { proposed, after: await answerOf(tx, visitId, "loc_fixation") };
    });
    expect(seen.proposed).toMatchObject({ answer: "si", fromHistory: true, regions: [...REGION_CODES] });
    expect(seen.after).toBeUndefined();
  });

  it("la bozza di un altro paziente dello stesso studio non cambia", async () => {
    const seen = await inUserA(db, async (tx) => {
      const mine = await setup(tx);
      const other = await setup(tx);
      await noOthers(tx, other.visitId);
      await run(tx, other.visitId, outcomes({ outcome: "indicated" }, "indicated"));
      const before = { answers: await answersOf(tx, other.visitId), rows: await outcomesOf(tx, other.visitId) };
      await addDrug(tx, mine.patientId, "Warfarin 5 mg");
      return {
        before,
        after: { answers: await answersOf(tx, other.visitId), rows: await outcomesOf(tx, other.visitId) },
        at: await reviewedAt(tx, other.visitId),
        mine: await answerOf(tx, mine.visitId, "ci_avk"),
      };
    });
    expect(seen.after).toEqual(seen.before);
    expect(seen.at).toEqual(clock.now());
    expect(seen.mine).toMatchObject({ answer: "si", fromHistory: true });
  });

  it("una visita chiusa non cambia: risposte, conferma ed esiti restano quelli della chiusura", async () => {
    const seen = await inUserA(db, async (tx) => {
      const { patientId, visitId } = await setup(tx);
      await noOthers(tx, visitId);
      await run(tx, visitId, outcomes({ outcome: "indicated" }, "indicated"));
      await closeVisitRow(tx, visitId);
      const before = { answers: await answersOf(tx, visitId), rows: await outcomesOf(tx, visitId) };
      await addDrug(tx, patientId, "Warfarin 5 mg");
      return {
        before,
        after: { answers: await answersOf(tx, visitId), rows: await outcomesOf(tx, visitId) },
        at: await reviewedAt(tx, visitId),
      };
    });
    expect(seen.after).toEqual(seen.before);
    expect(seen.before.answers.find((a) => a.itemCode === "ci_avk")).toMatchObject({ answer: "no", fromHistory: false });
    expect(seen.at).toEqual(clock.now());
  });
});

describe("nessuna_variazione", () => {
  it("copia le risposte della visita chiusa del ciclo senza le note e ricalcola gli esiti senza note, confermati all'orologio", async () => {
    const { source, copied, sourceAnswers, rows, at } = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const first = await visitOn(tx, patientId, cycleId, "2026-10-28");
      await run(tx, first, answer("loc_aorta", "si", { regions: ["lumbar"], note: "Ecografia del 2024" }));
      await run(tx, first, answer("ci_avk", "si", { note: INR_NOTE }));
      await noOthers(tx, first);
      await run(tx, first, outcomes({ outcome: "caution", overrideNote: INR_NOTE }));
      await closeVisitRow(tx, first);
      const second = await visitOn(tx, patientId, cycleId, "2026-11-03");
      const source = await screeningSource(tx, PRACTICE_A, await visitOf(tx, second));
      await run(tx, second, { op: "nessuna_variazione" });
      return {
        source: { ...source, expected: first },
        sourceAnswers: await answersOf(tx, first),
        copied: await answersOf(tx, second),
        rows: await outcomesOf(tx, second),
        at: await reviewedAt(tx, second),
      };
    });
    expect(source).toEqual({ visitId: source.expected, visitDate: "2026-10-28", otherCycle: false, expected: source.expected });
    // La nota dell'INR del 28/10 resta nella sorgente e non arriva a oggi.
    expect(sourceAnswers.find((a) => a.itemCode === "ci_avk")?.note).toBe(INR_NOTE);
    expect(copied).toEqual(sourceAnswers.map((a) => ({ ...a, note: null })));
    expect(copied.find((a) => a.itemCode === "ci_avk")).toMatchObject({ answer: "si", note: null });
    expect(copied.find((a) => a.itemCode === "loc_aorta")).toMatchObject({ regions: ["lumbar"], note: null });
    expect(rows).toEqual([
      { family: "thrust", suggested: "contraindicated", outcome: "contraindicated", localContraindicatedRegions: ["lumbar"], overrideNote: null },
      { family: "direct", suggested: "contraindicated", outcome: "contraindicated", localContraindicatedRegions: ["lumbar"], overrideNote: null },
      { family: "indirect", suggested: "indicated", outcome: "indicated", localContraindicatedRegions: [], overrideNote: null },
    ]);
    expect(at).toEqual(clock.now());
  });

  it("una risposta data oggi resta e guida gli esiti; una voce senza risposta oggi prende quella della sorgente", async () => {
    const { today, rows } = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const first = await visitOn(tx, patientId, cycleId, "2026-10-28");
      await run(tx, first, answer("ci_osteo", "si"));
      await noOthers(tx, first);
      await run(tx, first, outcomes({ outcome: "caution" }, "caution"));
      await closeVisitRow(tx, first);
      const second = await visitOn(tx, patientId, cycleId, "2026-11-03");
      // Oggi, prima di "Nessuna variazione", due red flag del rachide che la sorgente aveva a «no».
      await run(tx, second, answer("rf_weight", "si", { note: "Meno 5 kg in due mesi" }));
      await run(tx, second, answer("rf_bilat_sciatica", "si"));
      await run(tx, second, { op: "nessuna_variazione" });
      return { today: await answersOf(tx, second), rows: await outcomesOf(tx, second) };
    });
    const byCode = new Map(today.map((a) => [a.itemCode, a]));
    expect(byCode.get("rf_weight")).toEqual({
      itemCode: "rf_weight",
      answer: "si",
      regions: [],
      subAnswers: [],
      fromHistory: false,
      note: "Meno 5 kg in due mesi",
    });
    expect(byCode.get("rf_bilat_sciatica")).toMatchObject({ answer: "si", fromHistory: false });
    expect(byCode.get("ci_osteo")).toMatchObject({ answer: "si", note: null });
    expect(byCode.get("ci_avk")).toMatchObject({ answer: "no" });
    // rf_bilat_sciatica (rinvio urgente) controindica le tre famiglie anche dopo la copia.
    expect(rows.map((r) => [r.family, r.suggested, r.outcome, r.overrideNote])).toEqual([
      ["thrust", "contraindicated", "contraindicated", null],
      ["direct", "contraindicated", "contraindicated", null],
      ["indirect", "contraindicated", "contraindicated", null],
    ]);
  });

  it("senza una visita chiusa precedente è Operazione non permessa e niente cambia", async () => {
    const { rows, at } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await expectDomainError(run(tx, visitId, { op: "nessuna_variazione" }), NOT_ALLOWED);
      return { rows: await answersOf(tx, visitId), at: await reviewedAt(tx, visitId) };
    });
    expect(rows).toEqual([]);
    expect(at).toBeNull();
  });

  it("una visita chiusa dopo questa, o una in bozza, non fanno da sorgente", async () => {
    const source = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const draftBefore = await visitOn(tx, patientId, cycleId, "2026-10-21");
      await noOthers(tx, draftBefore);
      const current = await visitOn(tx, patientId, cycleId, "2026-10-28");
      const later = await visitOn(tx, patientId, cycleId, "2026-11-03");
      await noOthers(tx, later);
      await closeVisitRow(tx, later);
      return screeningSource(tx, PRACTICE_A, await visitOf(tx, current));
    });
    expect(source).toBeNull();
  });

  it("in un ciclo nuovo la sorgente è l'ultima visita chiusa del paziente, «dal ciclo precedente»", async () => {
    const { source, copied } = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const oldCycle = await cycle(tx, patientId, { openedOn: "2026-09-01" });
      const old = await visitOn(tx, patientId, oldCycle, "2026-09-10");
      await run(tx, old, answer("ci_osteo", "si"));
      await noOthers(tx, old);
      await closeVisitRow(tx, old);
      await tx.query(
        "update public.treatment_cycles set status = 'closed', closed_on = '2026-09-20', outcome = 'raggiunto' where id = $1",
        [oldCycle],
      );
      const current = await visitOn(tx, patientId, await cycle(tx, patientId, { openedOn: "2026-11-02" }), "2026-11-03");
      const source = await screeningSource(tx, PRACTICE_A, await visitOf(tx, current));
      await run(tx, current, { op: "nessuna_variazione" });
      return { source: { ...source, expected: old }, copied: await answerOf(tx, current, "ci_osteo") };
    });
    expect(source).toEqual({ visitId: source.expected, visitDate: "2026-09-10", otherCycle: true, expected: source.expected });
    expect(copied).toMatchObject({ answer: "si" });
  });

  it("un «si» proposto oggi dall'anamnesi resta anche se la sorgente diceva «no»", async () => {
    const avk = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const first = await visitOn(tx, patientId, cycleId, "2026-10-28");
      await noOthers(tx, first);
      await run(tx, first, outcomes({ outcome: "indicated" }, "indicated"));
      await closeVisitRow(tx, first);
      // Dopo la visita del 28/10 il paziente comincia il Warfarin.
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
      const second = await visitOn(tx, patientId, cycleId, "2026-11-03");
      await run(tx, second, { op: "nessuna_variazione" });
      return {
        answer: await answerOf(tx, second, "ci_avk"),
        direct: (await outcomesOf(tx, second)).find((r) => r.family === "direct"),
      };
    });
    expect(avk.answer).toMatchObject({ answer: "si", fromHistory: true });
    expect(avk.direct).toMatchObject({ suggested: "contraindicated", outcome: "contraindicated" });
  });

  it("con un gruppo visibile oggi e assente nella sorgente (gravidanza in corso) chiede le risposte e non copia", async () => {
    const { rows, at } = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const first = await visitOn(tx, patientId, cycleId, "2026-10-28");
      await noOthers(tx, first);
      await closeVisitRow(tx, first);
      await saveLifestyle(tx, PRACTICE_A, clock, {
        patientId,
        reviewedOn: "2026-11-03",
        occupation: null,
        sport: null,
        familyHistory: null,
        pregnancyStatus: "in_corso",
        pregnancyWeeks: 22,
      });
      const second = await visitOn(tx, patientId, cycleId, "2026-11-03");
      await expectDomainError(run(tx, second, { op: "nessuna_variazione" }), ANSWER_ALL);
      return { rows: await answersOf(tx, second), at: await reviewedAt(tx, second) };
    });
    expect(rows).toEqual([]);
    expect(at).toBeNull();
  });

  it("in rettifica è Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const first = await visitOn(tx, patientId, cycleId, "2026-10-28");
      await noOthers(tx, first);
      await closeVisitRow(tx, first);
      const second = await visitOn(tx, patientId, cycleId, "2026-11-03");
      const op: VisitOp = { op: "nessuna_variazione" };
      await expectDomainError(applyVisitOp(tx, PRACTICE_A, clock, await visitOf(tx, second), op, "rettifica"), NOT_ALLOWED);
      expect(await answersOf(tx, second)).toEqual([]);
    });
  });
});

describe("un gruppo che diventa nascosto", () => {
  it("le sue risposte restano e contano negli esiti, ma la conferma non le chiede", async () => {
    const { pregnancy, rows } = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const lifestyle = (pregnancyStatus: "in_corso" | "no") =>
        saveLifestyle(tx, PRACTICE_A, clock, {
          patientId,
          reviewedOn: "2026-11-03",
          occupation: null,
          sport: null,
          familyHistory: null,
          pregnancyStatus,
          pregnancyWeeks: pregnancyStatus === "in_corso" ? 22 : null,
        });
      await lifestyle("in_corso");
      const visitId = await visitOn(tx, patientId, await cycle(tx, patientId), "2026-11-03");
      await run(tx, visitId, answer("rf_preg_bleeding", "si"));
      await lifestyle("no");
      await noOthers(tx, visitId);
      await run(tx, visitId, outcomes({ outcome: "contraindicated" }, "contraindicated", "contraindicated"));
      return { pregnancy: await answerOf(tx, visitId, "rf_preg_bleeding"), rows: await outcomesOf(tx, visitId) };
    });
    expect(pregnancy).toMatchObject({ answer: "si" });
    expect(rows.map((r) => [r.family, r.suggested])).toEqual([
      ["thrust", "contraindicated"],
      ["direct", "contraindicated"],
      ["indirect", "contraindicated"],
    ]);
  });
});

// La gravidanza apre o chiude il suo gruppo come le etichette di rischio aprono le voci:
// una bozza confermata con un gruppo in più o in meno da chiedere va riconfermata.
describe("un cambio di gravidanza nelle bozze", () => {
  const lifestyle = (tx: Tx, patientId: string, pregnancyStatus: "in_corso" | "no" | null, occupation: string | null = null) =>
    saveLifestyle(tx, PRACTICE_A, clock, {
      patientId,
      reviewedOn: "2026-11-03",
      occupation,
      sport: null,
      familyHistory: null,
      pregnancyStatus,
      pregnancyWeeks: pregnancyStatus === "in_corso" ? 22 : null,
    });

  it("«In corso» toglie la conferma e i tre esiti della bozza confermata; la visita chiusa resta com'è", async () => {
    const seen = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      const closed = await visitOn(tx, patientId, cycleId, "2026-10-28");
      await noOthers(tx, closed);
      await run(tx, closed, outcomes({ outcome: "indicated" }, "indicated"));
      await closeVisitRow(tx, closed);
      const draft = await visitOn(tx, patientId, cycleId, "2026-11-03");
      await noOthers(tx, draft);
      await run(tx, draft, outcomes({ outcome: "indicated" }, "indicated"));
      const closedBefore = { at: await reviewedAt(tx, closed), rows: await outcomesOf(tx, closed) };
      await lifestyle(tx, patientId, "in_corso");
      return {
        draft: { at: await reviewedAt(tx, draft), rows: await outcomesOf(tx, draft) },
        closedBefore,
        closedAfter: { at: await reviewedAt(tx, closed), rows: await outcomesOf(tx, closed) },
      };
    });
    expect(seen.draft).toEqual({ at: null, rows: [] });
    expect(seen.closedAfter).toEqual(seen.closedBefore);
    expect(seen.closedAfter.rows).toHaveLength(3);
  });

  it("finita la gravidanza il suo gruppo si chiude: i gruppi da chiedere cambiano, la conferma si toglie e le risposte restano", async () => {
    const seen = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      await lifestyle(tx, patientId, "in_corso");
      const draft = await visitOn(tx, patientId, await cycle(tx, patientId), "2026-11-03");
      await noOthers(tx, draft, [...ALWAYS, "rf_gravidanza"]);
      await run(tx, draft, outcomes({ outcome: "indicated" }, "indicated"));
      const confirmedAt = await reviewedAt(tx, draft);
      await lifestyle(tx, patientId, "no");
      return { confirmedAt, at: await reviewedAt(tx, draft), bleeding: await answerOf(tx, draft, "rf_preg_bleeding") };
    });
    expect(seen.confirmedAt).toEqual(clock.now());
    expect(seen.at).toBeNull();
    expect(seen.bleeding).toMatchObject({ answer: "no" });
  });

  it("lo stile di vita senza cambio di gravidanza non tocca la conferma", async () => {
    const at = await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const draft = await visitOn(tx, patientId, await cycle(tx, patientId), "2026-11-03");
      await noOthers(tx, draft);
      await run(tx, draft, outcomes({ outcome: "indicated" }, "indicated"));
      await lifestyle(tx, patientId, "no", "Impiegata");
      await lifestyle(tx, patientId, null, "Impiegata in banca");
      return reviewedAt(tx, draft);
    });
    expect(at).toEqual(clock.now());
  });
});

describe("psfs", () => {
  it("alla prima visita del ciclo scrive il punteggio iniziale, lo aggiorna, e con null lo toglie", async () => {
    const { written, updated, removed } = await inUserA(db, async (tx) => {
      const { cycleId, visitId } = await setup(tx);
      const { id: itemId } = await addPsfsItem(tx, PRACTICE_A, clock, { cycleId, activity: "Stare seduta alla scrivania" });
      const read = () =>
        tx.query<{ itemId: string; score: number; phase: string }>(
          'select item_id as "itemId", score, phase from public.psfs_scores where visit_id = $1',
          [visitId],
        );
      await run(tx, visitId, { op: "psfs", itemId, score: 4 });
      const written = { rows: await read(), itemId };
      await run(tx, visitId, { op: "psfs", itemId, score: 6 });
      const updated = await read();
      await run(tx, visitId, { op: "psfs", itemId, score: null });
      return { written, updated, removed: await read() };
    });
    expect(written.rows).toEqual([{ itemId: written.itemId, score: 4, phase: "iniziale" }]);
    expect(updated).toEqual([{ itemId: written.itemId, score: 6, phase: "iniziale" }]);
    expect(removed).toEqual([]);
  });

  it("su una visita che non è la prima del ciclo, o con un'attività di un altro ciclo, è Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await newPatient(tx);
      const cycleId = await cycle(tx, patientId);
      await visitOn(tx, patientId, cycleId, "2026-10-28");
      const second = await visitOn(tx, patientId, cycleId, "2026-11-03");
      const { id: itemId } = await addPsfsItem(tx, PRACTICE_A, clock, { cycleId, activity: "Guidare 30 minuti" });
      await expectDomainError(run(tx, second, { op: "psfs", itemId, score: 4 }), NOT_ALLOWED);

      const other = await setup(tx);
      await expectDomainError(run(tx, other.visitId, { op: "psfs", itemId: PSFS_ITEM_A, score: 4 }), NOT_ALLOWED);
      await expectDomainError(run(tx, other.visitId, { op: "psfs", itemId, score: 4 }), NOT_ALLOWED);
      const scores = await tx.query("select 1 from public.psfs_scores where visit_id = any($1::uuid[])", [
        [second, other.visitId],
      ]);
      expect(scores).toEqual([]);
    });
  });

  it("11 è Valore non valido", async () => {
    await inUserA(db, async (tx) => {
      const { cycleId, visitId } = await setup(tx);
      const { id: itemId } = await addPsfsItem(tx, PRACTICE_A, clock, { cycleId, activity: "Guidare 30 minuti" });
      expect((await formFailure(run(tx, visitId, { op: "psfs", itemId, score: 11 }))).message).toBe(INVALID);
    });
  });
});

describe("come uB sui dati di A", () => {
  const snapshotOfA = () =>
    asUserA(db, async (tx) => ({
      visits: await tx.query("select * from public.visits where practice_id = $1 order by id", [PRACTICE_A]),
      answers: await tx.query("select * from public.visit_screening_answers where practice_id = $1 order by id", [PRACTICE_A]),
      outcomes: await tx.query("select * from public.visit_screening_outcomes where practice_id = $1 order by id", [
        PRACTICE_A,
      ]),
      scores: await tx.query("select * from public.psfs_scores where practice_id = $1 order by id", [PRACTICE_A]),
    }));

  it("ogni operazione è Operazione non permessa, le letture non trovano niente, e A non cambia", async () => {
    const visitA = await asUserA(db, (tx) => visitOf(tx, VISIT_A));
    const before = await snapshotOfA();
    await asUserB(db, async (tx) => {
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        const edit = (op: Record<string, unknown>) => editVisit(tx, practiceId, clock, { visitId: VISIT_A, op });
        await expectDomainError(edit(answer("ci_osteo", "si")), NOT_ALLOWED);
        await expectDomainError(edit({ op: "nessun_altra_voce", group: "ci_sistemica" }), NOT_ALLOWED);
        await expectDomainError(edit(outcomes({ outcome: "indicated" }, "indicated")), NOT_ALLOWED);
        await expectDomainError(edit({ op: "nessuna_variazione" }), NOT_ALLOWED);
        await expectDomainError(edit({ op: "psfs", itemId: PSFS_ITEM_A, score: 5 }), NOT_ALLOWED);
        expect(await loadScreeningState(tx, practiceId, VISIT_A)).toBeNull();
        expect(await screeningSource(tx, practiceId, visitA)).toBeNull();
      }
    });
    expect(await snapshotOfA()).toEqual(before);
  });

  it("un farmaco TAO scritto da B sul paziente della bozza di A è Operazione non permessa e lo screening di A non cambia", async () => {
    const before = await snapshotOfA();
    await asUserB(db, async (tx) => {
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        await expectDomainError(
          saveHistoryItem(tx, practiceId, clock, {
            patientId: PATIENT_A1,
            kind: "farmaco",
            label: "Warfarin 5 mg",
            region: null,
            occurredOn: null,
            occurredYear: null,
            ongoing: true,
            note: null,
          }),
          NOT_ALLOWED,
        );
      }
    });
    expect(await snapshotOfA()).toEqual(before);
  });
});
