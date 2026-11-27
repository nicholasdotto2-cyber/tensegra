import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADVICE_TEMPLATES, DEFAULT_ACTIVE_TEST_CODES } from "@/lib/clinical/catalog";
import { type AmendOp, mergeAmendOp } from "@/lib/visits/amend-list";
import { toActionFailure } from "@/server/actions/result";
import { type Clock, fixedClock, romeDateTime } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { addPsfsItem, updateCycleOpening } from "@/server/domain/cycles/commands";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { saveLifestyle } from "@/server/domain/history/commands";
import { createPatient } from "@/server/domain/patients/commands";
import { saveClinicalSettings } from "@/server/domain/settings/commands";
import { getClinicalSettings } from "@/server/domain/settings/queries";
import { amendVisit, closeVisit, copyFromPreviousVisit, editVisit, startVisit } from "@/server/domain/visits/commands";
import { getVisitEditor } from "@/server/domain/visits/editor";
import { editOpening, editPsfsItem } from "@/server/domain/visits/section-a";
import { FILE_A, PRACTICE_A, PRACTICE_B, SERVICE_A, sha256Hex, VISIT_A } from "./fixtures";
import { asUserA, asUserB, expectPgError, inUserA, insertRow, openTestDb } from "./helpers";

// Copia dalla visita precedente, chiusura e rettifica.
// La prima visita si prepara il 20/10 con il suo orologio e si chiude; la
// seconda è di oggi, mercoledì 4/11/2026 alle 08:30 di Roma. I casi che leggono "in una transazione
// successiva" scrivono davvero (`asUserA`) su pazienti nuovi; gli altri tornano indietro (`inUserA`).

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const setupClock = fixedClock("2026-10-20T10:00:00+02:00");

const ALWAYS = ["ci_sistemica", "ci_locale", "rf_rachide"] as const;
const CERVICAL_GROUP = "rf_cervicale_vascolare";
const COPY_FIRST = "Prima conferma lo screening di oggi.";
const CONFIRM_COPIED = "Conferma i dati copiati.";
const CONFIRM_SCREENING = "Conferma lo screening.";
const OPENING_MISSING = "Per la prima visita servono motivo, regione principale, obiettivo e sedute previste.";
const CONFLICT =
  'Una tecnica è in contrasto con lo screening: scrivi nella riga "tecnica eseguita prima della comparsa del sintomo" o toglila.';
const RECONFIRM = "Dopo aver cambiato le risposte conferma di nuovo lo screening.";
const SCREENING_REOPENED = "Dopo la rettifica lo screening ha voci senza risposta: rispondi e conferma di nuovo lo screening.";
const SHORT_REASON = "Scrivi almeno 10 caratteri.";
const SYMPTOM_NOTE = "tecnica eseguita prima della comparsa del sintomo";
const SKIPPED_ONE = "1 tecnica non copiata: controindicata oggi";
const CONSENT_REVOKED = "Consenso al trattamento revocato: puoi solo annotare il colloquio.";

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

async function expectDomainError(p: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
}

/** Il comando fallisce prima del database (DomainError o ZodError): la risposta che arriva al modulo. */
async function formFailure(p: Promise<unknown>) {
  const error = await rejectionOf(p);
  expect(["DomainError", "ZodError"], String(error)).toContain(nameOf(error));
  return toActionFailure(error, "test");
}

// Preparazione, tutta come uA ------------------------------------------------------------------------

/** I test attivi di partenza: le fixture non ne hanno, e i test copiati sarebbero esclusi. */
async function activateDefaultTests(tx: Tx): Promise<void> {
  const today = await getClinicalSettings(tx, PRACTICE_A);
  if (!today) throw new Error("impostazioni cliniche mancanti");
  await saveClinicalSettings(tx, PRACTICE_A, clock, {
    defaultRecallWeeks: today.defaultRecallWeeks,
    defaultExpectedSessions: today.defaultExpectedSessions,
    defaultSessionIntervalWeeks: today.defaultSessionIntervalWeeks,
    referralPrompts: today.referralPrompts,
    activeTestCodes: [...DEFAULT_ACTIVE_TEST_CODES],
  });
}

async function appointment(tx: Tx, patientId: string, cycleId: string, day: string, time: string, status: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status)
     values ($1, $2, $3, $4, $5, 45, 6000, $6) returning id`,
    [PRACTICE_A, patientId, SERVICE_A, cycleId, romeDateTime(day, time), status],
  );
  if (!row) throw new Error("appuntamento non creato");
  return row.id;
}

const run = (tx: Tx, visitId: string, op: Record<string, unknown>, c: Clock = clock) =>
  editVisit(tx, PRACTICE_A, c, { visitId, op });

async function noOthers(tx: Tx, visitId: string, groups: readonly string[], c: Clock = clock): Promise<void> {
  for (const group of groups) await run(tx, visitId, { op: "nessun_altra_voce", group }, c);
}

const outcomes = (thrust: string, direct: string, indirect: string) => ({
  op: "esiti",
  outcomes: [
    { family: "thrust", outcome: thrust, overrideNote: null },
    { family: "direct", outcome: direct, overrideNote: null },
    { family: "indirect", outcome: indirect, overrideNote: null },
  ],
});

const answer = (itemCode: string, value: "no" | "si" | "non_so") => ({ op: "risposta", itemCode, answer: value });

const close = (tx: Tx, visitId: string, o: { confirmCopied?: boolean; alsoMarkDone?: boolean } = {}, c: Clock = clock) =>
  closeVisit(tx, PRACTICE_A, c, { visitId, confirmCopied: false, alsoMarkDone: false, ...o });

const amend = (tx: Tx, visitId: string, reason: string, ops: Record<string, unknown>[]) =>
  amendVisit(tx, PRACTICE_A, clock, { visitId, reason, ops });

const copy = (tx: Tx, visitId: string, replace = false) => copyFromPreviousVisit(tx, PRACTICE_A, clock, { visitId, replace });

const CERVICAL_FINDING = {
  op: "disfunzione",
  region: "cervical",
  severity: 2,
  tissueTexture: true,
  asymmetry: false,
  restriction: true,
  tenderness: true,
  side: "dx",
  segmentNote: "C2-C3 dx",
  isPrimary: true,
};

const SOFT_TISSUE_CERVICAL = {
  op: "tecnica",
  region: "cervical",
  techniqueCode: "tessuti_molli",
  tolerance: "fastidio",
  response: "migliorato",
  note: "Risposta buona già in seduta",
};

interface Scenario {
  patientId: string;
  cycleId: string;
  firstId: string;
}

/**
 * Un paziente con un ciclo di trattamento e la prima visita del 20/10, chiusa con lo stesso orologio:
 * campi d'apertura con la regione principale, screening confermato pulito, due disfunzioni, due test con
 * valori, tessuti molli (sulla regione principale) e HVLA lombare, un consiglio, dolore, risposta,
 * osservazione e irradiazione.
 */
async function closedFirstVisit(
  tx: Tx,
  mainRegion: "cervical" | "lumbar" = "cervical",
  firstName = "Piero",
): Promise<Scenario> {
  await activateDefaultTests(tx);
  const { id: patientId } = await createPatient(tx, PRACTICE_A, setupClock, {
    firstName,
    lastName: "Lanzi",
    birthDate: "1980-03-15",
  });
  const [cycle] = await tx.query<{ id: string }>(
    `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions)
     values ($1, $2, 'trattamento', '2026-10-20', 'Nuovo ciclo, ottobre 2026', 4) returning id`,
    [PRACTICE_A, patientId],
  );
  if (!cycle) throw new Error("ciclo non creato");
  const appointmentId = await appointment(tx, patientId, cycle.id, "2026-10-20", "09:00", "fatto");
  const { visitId: firstId } = await startVisit(tx, PRACTICE_A, setupClock, { appointmentId });

  await updateCycleOpening(tx, PRACTICE_A, setupClock, {
    cycleId: cycle.id,
    chiefComplaint: "Dolore al collo da tre settimane, peggio la sera",
    mainRegion,
    goal: "Girare la testa in auto senza dolore",
    expectedSessions: 4,
  });
  await noOthers(tx, firstId, mainRegion === "cervical" ? [...ALWAYS, CERVICAL_GROUP] : ALWAYS, setupClock);
  await run(tx, firstId, outcomes("indicated", "indicated", "indicated"), setupClock);
  await run(
    tx,
    firstId,
    {
      op: "campi",
      values: {
        nprsPre: 6,
        nprsPost: 3,
        treatmentResponse: "migliorato",
        observationNote: "Spalle in avanti, capo anteposto",
        adverseReaction: "nessuna",
        radiationSites: ["braccio"],
        radiationSide: "dx",
      },
    },
    setupClock,
  );
  await run(tx, firstId, CERVICAL_FINDING, setupClock);
  await run(tx, firstId, { op: "disfunzione", region: "lumbar", severity: 1, restriction: true }, setupClock);
  await run(tx, firstId, { op: "test", testCode: "rom_rotazione_cervicale", side: "dx", valueNumeric: 60 }, setupClock);
  await run(tx, firstId, { op: "test", testCode: "spurling", side: "dx", valueBool: false }, setupClock);
  // Con la regione principale lombare il gruppo cervicale resta chiuso: i tessuti molli vanno sulla lombare.
  await run(tx, firstId, mainRegion === "cervical" ? SOFT_TISSUE_CERVICAL : { ...SOFT_TISSUE_CERVICAL, region: "lumbar" }, setupClock);
  await run(tx, firstId, { op: "tecnica", region: "lumbar", techniqueCode: "hvla" }, setupClock);
  await run(tx, firstId, { op: "consiglio", templateCode: "camminata", text: null, communicatedVia: ["a_voce"] }, setupClock);
  await close(tx, firstId, {}, setupClock);
  return { patientId, cycleId: cycle.id, firstId };
}

/** La seconda visita, di oggi alle 08:00, sull'appuntamento nello stato dato. */
async function secondVisit(tx: Tx, s: Scenario, status = "confermato"): Promise<{ visitId: string; appointmentId: string }> {
  const appointmentId = await appointment(tx, s.patientId, s.cycleId, "2026-11-04", "08:00", status);
  const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
  return { visitId, appointmentId };
}

/** La seconda visita con lo screening di oggi: «Sì» su NAO (thrust controindicato) e "Nessuna variazione". */
async function secondVisitScreened(tx: Tx, s: Scenario, status = "confermato") {
  const second = await secondVisit(tx, s, status);
  await run(tx, second.visitId, answer("ci_nao", "si"));
  await run(tx, second.visitId, { op: "nessuna_variazione" });
  return second;
}

// Riletture ------------------------------------------------------------------------------------------

function findingsOf(tx: Tx, visitId: string) {
  return tx.query<Record<string, unknown>>(
    `select id, region, severity, tissue_texture as "tissueTexture", asymmetry, restriction, tenderness, side,
            segment_note as "segmentNote", is_primary as "isPrimary", copied
       from public.visit_region_findings where visit_id = $1 order by region`,
    [visitId],
  );
}

function testsOf(tx: Tx, visitId: string) {
  return tx.query<Record<string, unknown>>(
    `select id, test_code as "testCode", custom_label as "customLabel", side, value_bool as "valueBool",
            value_lateral as "valueLateral", value_numeric::float8 as "valueNumeric", value_ordinal as "valueOrdinal",
            pain_provoked as "painProvoked", note, copied
       from public.visit_test_results where visit_id = $1 order by test_code, side`,
    [visitId],
  );
}

function treatmentsOf(tx: Tx, visitId: string) {
  return tx.query<Record<string, unknown>>(
    `select id, region, technique_code as "techniqueCode", approach, family, tolerance, response, note, copied
       from public.visit_treatments where visit_id = $1 order by region, technique_code`,
    [visitId],
  );
}

async function visitOf(tx: Tx, visitId: string) {
  const [row] = await tx.query<Record<string, unknown>>(
    `select status, closed_at as "closedAt", copied_from_visit_id as "copiedFromVisitId",
            screening_reviewed_at as "screeningReviewedAt", nprs_pre as "nprsPre", nprs_post as "nprsPost",
            treatment_response as "treatmentResponse", observation_note as "observationNote",
            adverse_reaction as "adverseReaction", radiation_sites as "radiationSites", radiation_side as "radiationSide"
       from public.visits where id = $1`,
    [visitId],
  );
  return row;
}

function outcomesOf(tx: Tx, visitId: string) {
  return tx.query<Record<string, unknown>>(
    `select family, suggested, outcome, override_note as "overrideNote"
       from public.visit_screening_outcomes where visit_id = $1 order by family`,
    [visitId],
  );
}

async function answerOf(tx: Tx, visitId: string, itemCode: string): Promise<string | undefined> {
  const [row] = await tx.query<{ answer: string }>(
    "select answer from public.visit_screening_answers where visit_id = $1 and item_code = $2",
    [visitId, itemCode],
  );
  return row?.answer;
}

function amendmentsOf(tx: Tx, visitId: string) {
  return tx.query<{ amendedAt: Date; reason: string; changes: unknown }>(
    `select amended_at as "amendedAt", reason, changes
       from public.visit_amendments where visit_id = $1 order by created_at, id`,
    [visitId],
  );
}

async function appointmentStatus(tx: Tx, id: string): Promise<string | undefined> {
  const [row] = await tx.query<{ status: string }>("select status from public.appointments where id = $1", [id]);
  return row?.status;
}

const ids = (rows: Record<string, unknown>[]) => rows.map((r) => r.id);

/** La riga senza le chiavi date (l'id generato, il nome dell'operazione). */
const without = (row: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));

// ----------------------------------------------------------------------------------------------------

describe("copyFromPreviousVisit", () => {
  it("vuole lo screening di oggi; poi copia disfunzioni, test senza valori e tecniche ammesse oggi, mai consigli né campi", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      const { visitId } = await secondVisit(tx, s);
      await expectDomainError(copy(tx, visitId), COPY_FIRST);
      const untouched = { findings: (await findingsOf(tx, visitId)).length, copiedFrom: (await visitOf(tx, visitId))?.copiedFromVisitId };

      await run(tx, visitId, answer("ci_nao", "si"));
      await run(tx, visitId, { op: "nessuna_variazione" });
      const result = await copy(tx, visitId);
      const advice = await tx.query("select id from public.visit_advice where visit_id = $1", [visitId]);
      return {
        untouched,
        result,
        firstId: s.firstId,
        findings: await findingsOf(tx, visitId),
        tests: await testsOf(tx, visitId),
        treatments: await treatmentsOf(tx, visitId),
        advice: advice.length,
        visit: await visitOf(tx, visitId),
        outcomes: await outcomesOf(tx, visitId),
      };
    });

    expect(r.untouched).toEqual({ findings: 0, copiedFrom: null });
    expect(r.result).toEqual({ needsReplace: false, skippedText: SKIPPED_ONE });
    expect(r.findings.map((f) => without(f, "id"))).toEqual([
      { ...without(CERVICAL_FINDING, "op"), copied: true },
      {
        region: "lumbar",
        severity: 1,
        tissueTexture: false,
        asymmetry: false,
        restriction: true,
        tenderness: false,
        side: null,
        segmentNote: null,
        isPrimary: false,
        copied: true,
      },
    ]);
    const noValues = { customLabel: null, valueBool: null, valueLateral: null, valueNumeric: null, valueOrdinal: null };
    expect(r.tests.map((t) => without(t, "id"))).toEqual([
      { testCode: "rom_rotazione_cervicale", side: "dx", ...noValues, painProvoked: null, note: null, copied: true },
      { testCode: "spurling", side: "dx", ...noValues, painProvoked: null, note: null, copied: true },
    ]);
    // La HVLA lombare è controindicata oggi (NAO «Sì»): non si copia; i tessuti molli sì, senza risposta né nota.
    expect(r.treatments.map((t) => without(t, "id"))).toEqual([
      {
        region: "cervical",
        techniqueCode: "tessuti_molli",
        approach: null,
        family: "direct",
        tolerance: "buona",
        response: null,
        note: null,
        copied: true,
      },
    ]);
    expect(r.advice).toBe(0);
    expect(r.visit).toMatchObject({
      copiedFromVisitId: r.firstId,
      nprsPre: null,
      nprsPost: null,
      treatmentResponse: null,
      observationNote: null,
      adverseReaction: null,
      radiationSites: [],
      radiationSide: null,
    });
    // Gli esiti sono quelli ricalcolati da "Nessuna variazione": esito = suggerito, nessuna nota.
    expect(r.outcomes).toEqual([
      { family: "direct", suggested: "caution", outcome: "caution", overrideNote: null },
      { family: "indirect", suggested: "indicated", outcome: "indicated", overrideNote: null },
      { family: "thrust", suggested: "contraindicated", outcome: "contraindicated", overrideNote: null },
    ]);
  });

  it("premuta di nuovo chiede di sostituire senza scrivere; con replace sostituisce i copiati e lascia le righe confermate", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      const { visitId } = await secondVisitScreened(tx, s);
      await copy(tx, visitId);
      const cervicalId = (await findingsOf(tx, visitId)).find((f) => f.region === "cervical")?.id;
      await run(tx, visitId, { op: "conferma", target: { table: "findings", id: cervicalId } });
      const before = { findings: await findingsOf(tx, visitId), tests: await testsOf(tx, visitId), treatments: await treatmentsOf(tx, visitId) };

      const asked = await copy(tx, visitId, false);
      const afterAsk = { findings: await findingsOf(tx, visitId), tests: await testsOf(tx, visitId), treatments: await treatmentsOf(tx, visitId) };
      const replaced = await copy(tx, visitId, true);
      return {
        cervicalId,
        before,
        asked,
        afterAsk,
        replaced,
        findings: await findingsOf(tx, visitId),
        tests: await testsOf(tx, visitId),
        treatments: await treatmentsOf(tx, visitId),
      };
    });

    expect(r.asked).toEqual({ needsReplace: true, skippedText: null });
    expect(r.afterAsk).toEqual(r.before);
    expect(r.replaced).toEqual({ needsReplace: false, skippedText: SKIPPED_ONE });
    // La riga cervicale confermata resta la stessa; la lombare, i test e la tecnica sono righe nuove copiate.
    expect(r.findings.map((f) => [f.region, f.copied])).toEqual([
      ["cervical", false],
      ["lumbar", true],
    ]);
    expect(r.findings[0]?.id).toBe(r.cervicalId);
    const lumbarBefore = r.before.findings.find((f) => f.region === "lumbar")?.id;
    expect(r.findings[1]?.id).not.toBe(lumbarBefore);
    expect(r.tests.map((t) => t.copied)).toEqual([true, true]);
    expect(ids(r.tests).some((id) => ids(r.before.tests).includes(id))).toBe(false);
    expect(r.treatments.map((t) => [t.techniqueCode, t.copied])).toEqual([["tessuti_molli", true]]);
    expect(r.treatments[0]?.id).not.toBe(r.before.treatments[0]?.id);
  });

  it("vuole lo screening di oggi confermato come la chiusura: un gruppo aperto dopo la conferma va risposto prima", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx, "lumbar");
      const { visitId: second } = await secondVisit(tx, s);
      await run(tx, second, { op: "nessuna_variazione" });
      // Una riga diretta sulla cervicale apre il gruppo cervicale con gli esiti ancora salvati.
      await tx.query(
        `insert into public.visit_treatments (practice_id, visit_id, region, technique_code, family, copied)
         values ($1, $2, 'cervical', 'articolatoria', 'direct', true)`,
        [PRACTICE_A, second],
      );
      const before = (await findingsOf(tx, second)).length;
      await expectDomainError(copy(tx, second), COPY_FIRST);
      const afterRefusal = (await findingsOf(tx, second)).length;
      await noOthers(tx, second, [CERVICAL_GROUP]);
      await run(tx, second, outcomes("indicated", "indicated", "indicated"));
      return { before, afterRefusal, copied: await copy(tx, second) };
    });
    expect(r.afterRefusal).toBe(r.before);
    // Con il gruppo risposto la copia riparte: la riga copiata di prima chiede di sostituire.
    expect(r.copied).toEqual({ needsReplace: true, skippedText: null });
  });

  it("una visita senza visita chiusa prima, o già chiusa, è Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      await expectDomainError(copy(tx, s.firstId), NOT_ALLOWED);
      const { id: patientId } = await createPatient(tx, PRACTICE_A, clock, { firstName: "Elsa", lastName: "Morri", birthDate: "1990-01-01" });
      const [cycle] = await tx.query<{ id: string }>(
        `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions)
         values ($1, $2, 'trattamento', '2026-11-04', 'Nuovo ciclo, novembre 2026', 4) returning id`,
        [PRACTICE_A, patientId],
      );
      const appointmentId = await appointment(tx, patientId, String(cycle?.id), "2026-11-04", "08:00", "fatto");
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      await noOthers(tx, visitId, ALWAYS);
      await run(tx, visitId, outcomes("indicated", "indicated", "indicated"));
      await expectDomainError(copy(tx, visitId), NOT_ALLOWED);
    });
  });
});

describe("closeVisit", () => {
  it("con copiati non confermati risponde «Conferma i dati copiati.»; con confirmCopied chiude e segna l'appuntamento fatto", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      const { visitId, appointmentId } = await secondVisitScreened(tx, s);
      await copy(tx, visitId);
      await expectDomainError(close(tx, visitId), CONFIRM_COPIED);
      const stillDraft = (await visitOf(tx, visitId))?.status;

      await close(tx, visitId, { confirmCopied: true, alsoMarkDone: true });
      const visit = await visitOf(tx, visitId);
      const copied = [
        ...(await findingsOf(tx, visitId)),
        ...(await testsOf(tx, visitId)),
        ...(await treatmentsOf(tx, visitId)),
      ].map((row) => row.copied);
      await expectDomainError(close(tx, visitId), NOT_ALLOWED);
      return { stillDraft, visit, copied, appointment: await appointmentStatus(tx, appointmentId) };
    });

    expect(r.stillDraft).toBe("draft");
    expect(r.visit).toMatchObject({ status: "closed", closedAt: clock.now() });
    // I due test copiati restano senza valore: confermarli li toglie.
    expect(r.copied).toEqual([false, false, false]);
    expect(r.appointment).toBe("fatto");
  });

  it("senza alsoMarkDone l'appuntamento resta confermato e la visita si chiude", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      const { visitId, appointmentId } = await secondVisitScreened(tx, s);
      await close(tx, visitId, { confirmCopied: true, alsoMarkDone: false });
      return { visit: await visitOf(tx, visitId), appointment: await appointmentStatus(tx, appointmentId) };
    });
    expect(r.visit).toMatchObject({ status: "closed", closedAt: clock.now() });
    expect(r.appointment).toBe("confermato");
  });

  it("la prima visita di trattamento senza obiettivo non chiude; con i campi d'apertura chiude", async () => {
    const r = await inUserA(db, async (tx) => {
      const { id: patientId } = await createPatient(tx, PRACTICE_A, clock, { firstName: "Elsa", lastName: "Morri", birthDate: "1990-01-01" });
      const [cycle] = await tx.query<{ id: string }>(
        `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions)
         values ($1, $2, 'trattamento', '2026-11-04', 'Nuovo ciclo, novembre 2026', 4) returning id`,
        [PRACTICE_A, patientId],
      );
      const cycleId = String(cycle?.id);
      const appointmentId = await appointment(tx, patientId, cycleId, "2026-11-04", "08:00", "fatto");
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      await noOthers(tx, visitId, ALWAYS);
      await run(tx, visitId, outcomes("indicated", "indicated", "indicated"));
      await expectDomainError(close(tx, visitId), OPENING_MISSING);

      await updateCycleOpening(tx, PRACTICE_A, clock, {
        cycleId,
        chiefComplaint: "Mal di schiena quando si alza dalla sedia",
        mainRegion: "lumbar",
        goal: "Stare seduta in ufficio 2 ore senza dolore",
        expectedSessions: 4,
      });
      await close(tx, visitId);
      return visitOf(tx, visitId);
    });
    expect(r).toMatchObject({ status: "closed", closedAt: clock.now() });
  });

  it("la riga di tessuti molli in contrasto senza nota non chiude; con la nota chiude", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx, "lumbar");
      const { visitId } = await secondVisit(tx, s);
      await run(tx, visitId, { op: "nessuna_variazione" });
      await run(tx, visitId, { op: "tecnica", region: "lumbar", techniqueCode: "tessuti_molli" });
      await run(tx, visitId, answer("rf_ces_saddle", "si"));
      await run(tx, visitId, outcomes("contraindicated", "contraindicated", "contraindicated"));
      await expectDomainError(close(tx, visitId), CONFLICT);
      await run(tx, visitId, { op: "tecnica", region: "lumbar", techniqueCode: "tessuti_molli", note: SYMPTOM_NOTE });
      await close(tx, visitId);
      return visitOf(tx, visitId);
    });
    expect(r).toMatchObject({ status: "closed", closedAt: clock.now() });
  });

  it("un gruppo cervicale aperto dopo la conferma (regione principale o riga copiata) va risposto e riconfermato", async () => {
    const r = await inUserA(db, async (tx) => {
      // Regione principale cambiata in cervicale con l'operazione `apertura` sulla prima visita in bozza.
      const { id: patientId } = await createPatient(tx, PRACTICE_A, clock, { firstName: "Elsa", lastName: "Morri", birthDate: "1990-01-01" });
      const [cycle] = await tx.query<{ id: string }>(
        `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions)
         values ($1, $2, 'trattamento', '2026-11-04', 'Nuovo ciclo, novembre 2026', 4) returning id`,
        [PRACTICE_A, patientId],
      );
      const cycleId = String(cycle?.id);
      const appointmentId = await appointment(tx, patientId, cycleId, "2026-11-04", "08:00", "fatto");
      const { visitId: first } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      await updateCycleOpening(tx, PRACTICE_A, clock, {
        cycleId,
        chiefComplaint: "Mal di schiena quando si alza dalla sedia",
        mainRegion: "lumbar",
        goal: "Stare seduta in ufficio 2 ore senza dolore",
        expectedSessions: 4,
      });
      await noOthers(tx, first, ALWAYS);
      await run(tx, first, outcomes("indicated", "indicated", "indicated"));
      await run(tx, first, { op: "apertura", mainRegion: "cervical" });
      const reviewedAfterOpening = (await visitOf(tx, first))?.screeningReviewedAt;
      await expectDomainError(close(tx, first), CONFIRM_SCREENING);
      await noOthers(tx, first, [CERVICAL_GROUP]);
      await run(tx, first, outcomes("indicated", "indicated", "indicated"));
      await close(tx, first);

      // Una riga copiata diretta sulla cervicale apre il gruppo su uno screening già confermato.
      const s = await closedFirstVisit(tx, "lumbar");
      const { visitId: second } = await secondVisit(tx, s);
      await run(tx, second, { op: "nessuna_variazione" });
      await tx.query(
        `insert into public.visit_treatments (practice_id, visit_id, region, technique_code, family, copied)
         values ($1, $2, 'cervical', 'articolatoria', 'direct', true)`,
        [PRACTICE_A, second],
      );
      await expectDomainError(close(tx, second), CONFIRM_SCREENING);
      await expectDomainError(close(tx, second, { confirmCopied: true }), CONFIRM_SCREENING);
      await noOthers(tx, second, [CERVICAL_GROUP]);
      await run(tx, second, outcomes("indicated", "indicated", "indicated"));
      await close(tx, second, { confirmCopied: true });
      return { reviewedAfterOpening, first: await visitOf(tx, first), second: await visitOf(tx, second) };
    });
    // La regione principale non toglie la conferma: è la chiusura a chiedere le voci nuove.
    expect(r.reviewedAfterOpening).toEqual(clock.now());
    expect(r.first?.status).toBe("closed");
    expect(r.second?.status).toBe("closed");
  });
});

describe("amendVisit", () => {
  it("la rettifica del segmento scrive motivo, prima e dopo; dopo, senza rettifica, niente si scrive", async () => {
    const s = await asUserA(db, (tx) => closedFirstVisit(tx));
    const corrected = { ...CERVICAL_FINDING, segmentNote: "C2 FRS dx" };
    await asUserA(db, (tx) => amend(tx, s.firstId, "Errore di battitura sul segmento", [corrected]));

    const saved = await asUserA(db, async (tx) => ({
      finding: (await findingsOf(tx, s.firstId)).find((f) => f.region === "cervical"),
      amendments: await amendmentsOf(tx, s.firstId),
    }));
    const before = without(CERVICAL_FINDING, "op");
    const after = without(corrected, "op");
    expect(saved.finding?.segmentNote).toBe("C2 FRS dx");
    expect(saved.amendments).toEqual([
      {
        amendedAt: clock.now(),
        reason: "Errore di battitura sul segmento",
        changes: [{ op: "disfunzione", before, after }],
      },
    ]);

    // Una seconda transazione, senza rettifica: il comando e il database rifiutano.
    await inUserA(db, (tx) => expectDomainError(editVisit(tx, PRACTICE_A, clock, { visitId: s.firstId, op: corrected }), NOT_ALLOWED));
    await inUserA(db, (tx) =>
      expectPgError(
        tx.query("update public.visit_region_findings set segment_note = 'C3' where practice_id = $1 and visit_id = $2", [
          PRACTICE_A,
          s.firstId,
        ]),
        "42501",
      ),
    );

    const short = await inUserA(db, async (tx) => {
      const failure = await formFailure(amend(tx, s.firstId, "troppo br", [corrected]));
      return { message: failure.message, amendments: (await amendmentsOf(tx, s.firstId)).length };
    });
    expect(short).toEqual({ message: SHORT_REASON, amendments: 1 });

    await inUserA(db, async (tx) => {
      const { visitId } = await secondVisit(tx, s);
      await expectDomainError(amend(tx, visitId, "Errore di battitura sul segmento", [corrected]), NOT_ALLOWED);
    });
  });

  it("risposta ed esiti nella stessa rettifica, con prima e dopo; senza esiti è rifiutata prima di scrivere", async () => {
    const s = await asUserA(db, (tx) => closedFirstVisit(tx));
    const oldOutcomes = await asUserA(db, (tx) => outcomesOf(tx, s.firstId));

    const r = await inUserA(db, async (tx) => {
      await amend(tx, s.firstId, "Risposta segnata per errore", [
        answer("ci_osteo", "si"),
        outcomes("caution", "caution", "indicated"),
      ]);
      return {
        answer: await answerOf(tx, s.firstId, "ci_osteo"),
        outcomes: await outcomesOf(tx, s.firstId),
        visit: await visitOf(tx, s.firstId),
        amendments: await amendmentsOf(tx, s.firstId),
      };
    });
    expect(r.answer).toBe("si");
    expect(r.outcomes.map((o) => [o.family, o.outcome])).toEqual([
      ["direct", "caution"],
      ["indirect", "indicated"],
      ["thrust", "caution"],
    ]);
    expect(r.visit?.screeningReviewedAt).toEqual(clock.now());
    expect(r.amendments).toHaveLength(1);
    const changes = r.amendments[0]?.changes as { op: string; before: unknown; after: unknown }[];
    expect(changes.map((c) => c.op)).toEqual(["risposta", "esiti"]);
    expect(changes[0]?.before).toEqual({ answer: "no", regions: [], subAnswers: [], fromHistory: false, note: null });
    expect(changes[0]?.after).toEqual({ itemCode: "ci_osteo", answer: "si", regions: [], subAnswers: [] });
    expect(changes[1]?.before).toEqual(
      ["thrust", "direct", "indirect"].map((family) => {
        const row = oldOutcomes.find((o) => o.family === family);
        return { family, suggested: row?.suggested, outcome: row?.outcome, localContraindicated: [], overrideNote: null };
      }),
    );
    expect(changes[1]?.after).toEqual({ outcomes: outcomes("caution", "caution", "indicated").outcomes });

    const unconfirmed = await inUserA(db, async (tx) => {
      await expectDomainError(amend(tx, s.firstId, "Risposta segnata per errore", [answer("ci_osteo", "si")]), RECONFIRM);
      return { amendments: (await amendmentsOf(tx, s.firstId)).length, answer: await answerOf(tx, s.firstId, "ci_osteo") };
    });
    expect(unconfirmed).toEqual({ amendments: 0, answer: "no" });

    await inUserA(db, (tx) =>
      expectDomainError(amend(tx, s.firstId, "Risposta segnata per errore", [{ op: "nessuna_variazione" }]), NOT_ALLOWED),
    );
  });

  it("un red flag che mette in contrasto i tessuti molli annulla tutta la rettifica; con la nota nella riga si salva", async () => {
    const s = await asUserA(db, (tx) => closedFirstVisit(tx));
    const redFlag = [answer("rf_ces_saddle", "si"), outcomes("contraindicated", "contraindicated", "contraindicated")];

    // Il comando lancia dentro una transazione vera: `asUserA` la annulla, rettifica compresa, e rilancia.
    await expectDomainError(asUserA(db, (tx) => amend(tx, s.firstId, "Sintomo riferito dopo la seduta", redFlag)), CONFLICT);
    const afterConflict = await asUserA(db, async (tx) => ({
      amendments: (await amendmentsOf(tx, s.firstId)).length,
      answer: await answerOf(tx, s.firstId, "rf_ces_saddle"),
      outcomes: (await outcomesOf(tx, s.firstId)).map((o) => o.outcome),
    }));
    expect(afterConflict).toEqual({ amendments: 0, answer: "no", outcomes: ["indicated", "indicated", "indicated"] });

    // Le due righe della prima visita (tessuti molli cervicali e HVLA lombare) sono in contrasto: ognuna la sua nota.
    const saved = await inUserA(db, async (tx) => {
      await amend(tx, s.firstId, "Sintomo riferito dopo la seduta", [
        ...redFlag,
        { ...SOFT_TISSUE_CERVICAL, note: SYMPTOM_NOTE },
        { op: "tecnica", region: "lumbar", techniqueCode: "hvla", note: SYMPTOM_NOTE },
      ]);
      return {
        amendments: await amendmentsOf(tx, s.firstId),
        notes: (await treatmentsOf(tx, s.firstId)).map((t) => [t.techniqueCode, t.note]),
        outcomes: (await outcomesOf(tx, s.firstId)).map((o) => o.outcome),
      };
    });
    expect(saved.notes).toEqual([
      ["tessuti_molli", SYMPTOM_NOTE],
      ["hvla", SYMPTOM_NOTE],
    ]);
    expect(saved.outcomes).toEqual(["contraindicated", "contraindicated", "contraindicated"]);
    expect((saved.amendments[0]?.changes as { op: string }[]).map((c) => c.op)).toEqual(["risposta", "esiti", "tecnica", "tecnica"]);
  });

  it("`apertura` sulla prima visita cambia l'obiettivo con prima e dopo; su un'altra visita è Operazione non permessa", async () => {
    const goal = "Lavorare al computer 3 ore senza dolore";
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      await amend(tx, s.firstId, "Obiettivo riscritto con il paziente", [{ op: "apertura", goal }]);
      const [cycle] = await tx.query<{ goal: string }>("select goal from public.treatment_cycles where id = $1", [s.cycleId]);

      const { visitId: second } = await secondVisit(tx, s);
      await expectDomainError(run(tx, second, { op: "apertura", goal }), NOT_ALLOWED);
      await run(tx, second, { op: "nessuna_variazione" });
      await close(tx, second);
      await expectDomainError(amend(tx, second, "Obiettivo riscritto con il paziente", [{ op: "apertura", goal }]), NOT_ALLOWED);
      return { goal: cycle?.goal, amendments: await amendmentsOf(tx, s.firstId), secondAmendments: (await amendmentsOf(tx, second)).length };
    });
    expect(r.goal).toBe(goal);
    expect(r.amendments.map((a) => a.changes)).toEqual([
      [{ op: "apertura", before: { goal: "Girare la testa in auto senza dolore" }, after: { goal } }],
    ]);
    expect(r.secondAmendments).toBe(0);
  });

  it("una tecnica o la regione principale che apre il gruppo cervicale vuole le risposte e la conferma nella stessa rettifica", async () => {
    // Ogni rettifica rifiutata dopo la scrittura annulla la sua transazione: un caso per transazione.
    await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx, "lumbar");
      const articolatoria = { op: "tecnica", region: "cervical", techniqueCode: "articolatoria" };
      await expectDomainError(amend(tx, s.firstId, "Tecnica cervicale non registrata", [articolatoria]), SCREENING_REOPENED);
    });
    await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx, "lumbar");
      await expectDomainError(
        amend(tx, s.firstId, "Regione principale corretta", [{ op: "apertura", mainRegion: "cervical" }]),
        SCREENING_REOPENED,
      );
    });

    const ok = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx, "lumbar");
      await amend(tx, s.firstId, "Tecnica cervicale non registrata", [
        { op: "tecnica", region: "cervical", techniqueCode: "articolatoria" },
        { op: "nessun_altra_voce", group: CERVICAL_GROUP },
        outcomes("indicated", "indicated", "indicated"),
      ]);
      return {
        treatments: (await treatmentsOf(tx, s.firstId)).map((t) => [t.region, t.techniqueCode]),
        cervicalAnswer: await answerOf(tx, s.firstId, "cv_unlike"),
        visit: await visitOf(tx, s.firstId),
      };
    });
    expect(ok.treatments).toContainEqual(["cervical", "articolatoria"]);
    expect(ok.cervicalAnswer).toBe("no");
    expect(ok.visit?.screeningReviewedAt).toEqual(clock.now());
  });
});

describe("casi limite di rettifica e chiusura", () => {
  /** Una gravidanza in corso registrata oggi nello stile di vita della paziente. */
  const pregnantToday = (tx: Tx, patientId: string) =>
    saveLifestyle(tx, PRACTICE_A, clock, {
      patientId,
      reviewedOn: "2026-11-04",
      occupation: null,
      sport: null,
      familyHistory: null,
      pregnancyStatus: "in_corso",
      pregnancyWeeks: 12,
    });

  it("una gravidanza di oggi non blocca la rettifica di una visita chiusa prima; la chiusura di una bozza la chiede", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx, "cervical", "Giada");
      // La bozza di oggi ha lo screening confermato prima che la gravidanza fosse registrata.
      const { visitId: draft } = await secondVisit(tx, s);
      await run(tx, draft, { op: "nessuna_variazione" });
      await pregnantToday(tx, s.patientId);

      await amend(tx, s.firstId, "Errore di battitura sul segmento", [{ ...CERVICAL_FINDING, segmentNote: "C2 FRS dx" }]);
      await amend(tx, s.firstId, "Risposta segnata per errore", [answer("ci_osteo", "si"), outcomes("caution", "caution", "indicated")]);
      await expectDomainError(close(tx, draft), CONFIRM_SCREENING);
      const pregnancyAnswers = await tx.query(
        "select 1 from public.visit_screening_answers where visit_id = $1 and item_code like 'rf_preg%'",
        [s.firstId],
      );
      return {
        amendments: (await amendmentsOf(tx, s.firstId)).length,
        answer: await answerOf(tx, s.firstId, "ci_osteo"),
        pregnancyAnswers: pregnancyAnswers.length,
        draft: (await visitOf(tx, draft))?.status,
      };
    });
    expect(r).toEqual({ amendments: 2, answer: "si", pregnancyAnswers: 0, draft: "draft" });
  });

  describe("consenso al trattamento revocato", () => {
    const CONSENT_TEXT = "Consenso al trattamento osteopatico di Piero Lanzi";

    async function revokedConsent(tx: Tx, s: Scenario): Promise<void> {
      const row = await insertRow(tx, "consent_records", {
        practice_id: PRACTICE_A,
        patient_id: s.patientId,
        cycle_id: s.cycleId,
        module_key: "trattamento",
        module_version: "2026.1",
        rendered_text: CONSENT_TEXT,
        rendered_hash: sha256Hex(CONSENT_TEXT),
        signer_kind: "paziente",
        signer_name: "Piero Lanzi",
        method: "tela",
        signature_file_id: FILE_A,
        signed_on: "2026-10-20",
      });
      await tx.query(
        `update public.consent_records set status = 'revocato', revoked_on = '2026-11-02', revocation_mode = 'verbale'
          where practice_id = $1 and id = $2`,
        [PRACTICE_A, String(row.id)],
      );
    }

    it("la copia non scrive tecniche e le conta nel testo; disfunzioni e test si copiano", async () => {
      const r = await inUserA(db, async (tx) => {
        const s = await closedFirstVisit(tx);
        const { visitId } = await secondVisitScreened(tx, s);
        await revokedConsent(tx, s);
        const result = await copy(tx, visitId);
        return {
          result,
          findings: (await findingsOf(tx, visitId)).length,
          tests: (await testsOf(tx, visitId)).length,
          treatments: (await treatmentsOf(tx, visitId)).length,
        };
      });
      expect(r).toEqual({
        result: { needsReplace: false, skippedText: "2 tecniche non copiate: consenso al trattamento revocato" },
        findings: 2,
        tests: 2,
        treatments: 0,
      });
    });

    it("una tecnica copiata non si conferma, né da sola né con tutti; una disfunzione copiata sì", async () => {
      const r = await inUserA(db, async (tx) => {
        const s = await closedFirstVisit(tx);
        const { visitId } = await secondVisitScreened(tx, s);
        await copy(tx, visitId);
        await revokedConsent(tx, s);
        const treatmentId = (await treatmentsOf(tx, visitId))[0]?.id;
        const findingId = (await findingsOf(tx, visitId))[0]?.id;
        await expectDomainError(run(tx, visitId, { op: "conferma", target: { table: "treatments", id: treatmentId } }), CONSENT_REVOKED);
        await expectDomainError(run(tx, visitId, { op: "conferma", target: "tutti" }), CONSENT_REVOKED);
        await expectDomainError(close(tx, visitId, { confirmCopied: true }), CONSENT_REVOKED);
        await run(tx, visitId, { op: "conferma", target: { table: "findings", id: findingId } });
        return {
          treatments: (await treatmentsOf(tx, visitId)).map((t) => t.copied),
          finding: (await findingsOf(tx, visitId)).find((f) => f.id === findingId)?.copied,
        };
      });
      expect(r).toEqual({ treatments: [true], finding: false });
    });

    it("copiati presi prima della revoca: si tolgono le tecniche copiate e la visita chiude; una tecnica confermata non si toglie", async () => {
      const r = await inUserA(db, async (tx) => {
        const s = await closedFirstVisit(tx);
        const { visitId } = await secondVisitScreened(tx, s);
        await copy(tx, visitId);
        // Una seconda tecnica copiata, scritta come uA, oltre ai tessuti molli della copia.
        await tx.query(
          `insert into public.visit_treatments (practice_id, visit_id, region, technique_code, family, copied)
           values ($1, $2, 'lumbar', 'funzionale', 'indirect', true)`,
          [PRACTICE_A, visitId],
        );
        // Una tecnica registrata oggi, prima della revoca: resta e non si toglie.
        await run(tx, visitId, { op: "tecnica", region: "lumbar", techniqueCode: "energia_muscolare" });
        await revokedConsent(tx, s);

        await expectDomainError(close(tx, visitId, { confirmCopied: true }), CONSENT_REVOKED);
        const rows = await treatmentsOf(tx, visitId);
        const confirmedId = rows.find((t) => !t.copied)?.id;
        await expectDomainError(run(tx, visitId, { op: "togli_tecnica", treatmentId: confirmedId }), CONSENT_REVOKED);
        for (const t of rows.filter((row) => row.copied)) {
          await run(tx, visitId, { op: "togli_tecnica", treatmentId: t.id });
        }
        await close(tx, visitId, { confirmCopied: true });
        return {
          copiedRemoved: rows.filter((t) => t.copied).length,
          treatments: (await treatmentsOf(tx, visitId)).map((t) => [t.techniqueCode, t.copied]),
          findings: (await findingsOf(tx, visitId)).map((f) => f.copied),
          visit: await visitOf(tx, visitId),
        };
      });
      expect(r.copiedRemoved).toBe(2);
      expect(r.treatments).toEqual([["energia_muscolare", false]]);
      expect(r.findings).toEqual([false, false]);
      expect(r.visit).toMatchObject({ status: "closed", closedAt: clock.now() });
    });
  });

  it("alsoMarkDone su un appuntamento già fatto non fa niente e la visita si chiude", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      const { visitId, appointmentId } = await secondVisitScreened(tx, s, "fatto");
      await close(tx, visitId, { alsoMarkDone: true });
      return { visit: await visitOf(tx, visitId), appointment: await appointmentStatus(tx, appointmentId) };
    });
    expect(r.visit).toMatchObject({ status: "closed", closedAt: clock.now() });
    expect(r.appointment).toBe("fatto");
  });
});

describe("rettifica: primaria, apertura, bloccanti e voci di changes", () => {
  const SCREENING_FIRST = "Conferma lo screening prima di scrivere il trattamento.";
  const REACTION_NOTE = "Scrivi una nota sulla reazione dall'ultima visita.";
  const CAMMINATA = ADVICE_TEMPLATES.find((t) => t.code === "camminata")?.body;

  // Le rettifiche della stessa transazione hanno lo stesso `created_at`: si ritrovano dal motivo.
  const changesOf = async (tx: Tx, visitId: string, reason: string) => {
    const rows = (await amendmentsOf(tx, visitId)).filter((a) => a.reason === reason);
    expect(rows).toHaveLength(1);
    return rows[0]?.changes as { op: string; before: unknown; after: unknown }[];
  };

  it("una disfunzione primaria che toglie la primaria a un'altra regione scrive anche quella riga", async () => {
    const changes = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      await amend(tx, s.firstId, "Primaria segnata sulla regione sbagliata", [
        { op: "disfunzione", region: "lumbar", severity: 1, restriction: true, isPrimary: true },
      ]);
      return changesOf(tx, s.firstId, "Primaria segnata sulla regione sbagliata");
    });
    const lumbar = {
      region: "lumbar",
      severity: 1,
      tissueTexture: false,
      asymmetry: false,
      restriction: true,
      tenderness: false,
      side: null,
      segmentNote: null,
    };
    const cervical = without(CERVICAL_FINDING, "op");
    expect(changes).toEqual([
      { op: "disfunzione", before: { ...lumbar, isPrimary: false }, after: { ...lumbar, isPrimary: true } },
      { op: "disfunzione", before: cervical, after: { ...cervical, isPrimary: false } },
    ]);
  });

  it("un'apertura che rigenera il titolo del ciclo lo scrive nel prima e nel dopo", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      const title = async () =>
        (await tx.query<{ title: string }>("select title from public.treatment_cycles where id = $1", [s.cycleId]))[0]?.title;
      const before = await title();
      await amend(tx, s.firstId, "Regione principale corretta", [{ op: "apertura", mainRegion: "head" }]);
      return { before, after: await title(), changes: await changesOf(tx, s.firstId, "Regione principale corretta") };
    });
    expect(r.after).not.toBe(r.before);
    expect(r.changes).toEqual([
      { op: "apertura", before: { mainRegion: "cervical", title: r.before }, after: { mainRegion: "head", title: r.after } },
    ]);
  });

  it("in bozza l'apertura vuole il ciclo aperto", async () => {
    await inUserA(db, async (tx) => {
      const { id: patientId } = await createPatient(tx, PRACTICE_A, clock, { firstName: "Elsa", lastName: "Morri", birthDate: "1990-01-01" });
      const [cycle] = await tx.query<{ id: string }>(
        `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions)
         values ($1, $2, 'trattamento', '2026-11-04', 'Nuovo ciclo, novembre 2026', 4) returning id`,
        [PRACTICE_A, patientId],
      );
      const appointmentId = await appointment(tx, patientId, String(cycle?.id), "2026-11-04", "08:00", "fatto");
      const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId });
      await run(tx, visitId, { op: "apertura", goal: "Stare seduta 2 ore senza dolore" });
      await tx.query(
        `update public.treatment_cycles set status = 'closed', closed_on = '2026-11-04', outcome = 'interrotto_dal_paziente'
          where practice_id = $1 and id = $2`,
        [PRACTICE_A, String(cycle?.id)],
      );
      await expectDomainError(run(tx, visitId, { op: "apertura", goal: "Un altro obiettivo" }), NOT_ALLOWED);
    });
  });

  it("la rettifica rilegge ogni bloccante della chiusura: una reazione senza nota annulla la rettifica", async () => {
    const s = await asUserA(db, (tx) => closedFirstVisit(tx));
    await expectDomainError(
      asUserA(db, (tx) => amend(tx, s.firstId, "Reazione riferita al telefono", [{ op: "campi", values: { adverseReaction: "lieve" } }])),
      REACTION_NOTE,
    );
    const after = await asUserA(db, async (tx) => ({
      amendments: (await amendmentsOf(tx, s.firstId)).length,
      reaction: (await visitOf(tx, s.firstId))?.adverseReaction,
    }));
    expect(after).toEqual({ amendments: 0, reaction: "nessuna" });

    await inUserA(db, async (tx) => {
      await amend(tx, s.firstId, "Reazione riferita al telefono", [
        { op: "campi", values: { adverseReaction: "lieve", adverseReactionNote: "Indolenzimento per un giorno" } },
      ]);
      expect((await visitOf(tx, s.firstId))?.adverseReaction).toBe("lieve");
    });
  });

  it("confermare una tecnica copiata vuole lo screening confermato e non passa sopra a un blocco", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      const { visitId } = await secondVisitScreened(tx, s);
      await copy(tx, visitId);
      const treatmentId = (await treatmentsOf(tx, visitId))[0]?.id;
      const confirmOne = { op: "conferma", target: { table: "treatments", id: treatmentId } };

      // Una risposta nuova toglie la conferma dello screening.
      await run(tx, visitId, answer("rf_ces_saddle", "no"));
      await expectDomainError(run(tx, visitId, confirmOne), SCREENING_FIRST);
      await expectDomainError(run(tx, visitId, { op: "conferma", target: "tutti" }), SCREENING_FIRST);

      // Riconfermato con un red flag: i tessuti molli copiati sono controindicati.
      await run(tx, visitId, answer("rf_ces_saddle", "si"));
      await run(tx, visitId, outcomes("contraindicated", "contraindicated", "contraindicated"));
      const blocked = await rejectionOf(run(tx, visitId, confirmOne));
      const blockedAll = await rejectionOf(run(tx, visitId, { op: "conferma", target: "tutti" }));
      await run(tx, visitId, { op: "togli_tecnica", treatmentId });
      await run(tx, visitId, { op: "conferma", target: "tutti" });
      return {
        blocked: (blocked as Error).message,
        blockedAll: (blockedAll as Error).message,
        treatments: (await treatmentsOf(tx, visitId)).length,
        copied: (await findingsOf(tx, visitId)).map((f) => f.copied),
      };
    });
    expect(r.blocked).toMatch(/^Tecnica tessuti molli controindicata in questa visita: /);
    expect(r.blockedAll).toBe(r.blocked);
    expect(r.treatments).toBe(0);
    expect(r.copied).toEqual([false, false]);
  });

  it("le voci di changes per ogni operazione della rettifica", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      // Dopo la chiusura `addPsfsItem` non aggiunge attività: la riga si prepara a mano.
      const [item] = await tx.query<{ id: string }>(
        "insert into public.psfs_items (practice_id, cycle_id, position, activity) values ($1, $2, 1, 'Guidare per 30 minuti') returning id",
        [PRACTICE_A, s.cycleId],
      );
      const itemId = item?.id;
      const tests = await testsOf(tx, s.firstId);
      const treatments = await treatmentsOf(tx, s.firstId);
      const [advice] = await tx.query<{ id: string }>("select id from public.visit_advice where visit_id = $1", [s.firstId]);
      const cervicalId = (await findingsOf(tx, s.firstId)).find((f) => f.region === "cervical")?.id;
      const spurling = tests.find((t) => t.testCode === "spurling")?.id;
      const hvla = treatments.find((t) => t.techniqueCode === "hvla")?.id;

      const cases: [string, Record<string, unknown>[]][] = [
        ["campi", [{ op: "campi", values: { nprsPre: 4, observationNote: "Capo in asse" } }]],
        ["tecnica esistente", [{ ...SOFT_TISSUE_CERVICAL, note: "Risposta buona, ridotta la tensione" }]],
        ["tecnica nuova", [{ op: "tecnica", region: "lumbar", techniqueCode: "funzionale" }]],
        ["test", [{ op: "test", testCode: "rom_rotazione_cervicale", side: "dx", valueNumeric: 55 }]],
        ["psfs nuovo", [{ op: "psfs", itemId, score: 3 }]],
        ["psfs esistente", [{ op: "psfs", itemId, score: 5 }]],
        ["consiglio", [{ op: "consiglio", templateCode: "camminata", text: "Cammina 15 minuti", communicatedVia: ["a_voce"] }]],
        ["togli_test", [{ op: "togli_test", resultId: spurling }]],
        ["togli_tecnica", [{ op: "togli_tecnica", treatmentId: hvla }]],
        ["togli_consiglio", [{ op: "togli_consiglio", adviceId: advice?.id }]],
        ["togli_disfunzione", [{ op: "togli_disfunzione", region: "lumbar" }]],
        ["nessun_altra_voce", [{ op: "nessun_altra_voce", group: "ci_sistemica" }, outcomes("indicated", "indicated", "indicated")]],
        ["conferma", [{ op: "conferma", target: { table: "findings", id: cervicalId } }]],
      ];
      const out: Record<string, unknown> = { spurling, hvla, adviceId: advice?.id, itemId, cervicalId };
      for (const [name, ops] of cases) {
        await amend(tx, s.firstId, `Rettifica di prova: ${name}`, ops);
        out[name] = await changesOf(tx, s.firstId, `Rettifica di prova: ${name}`);
      }
      return out;
    });

    const noTest = { customLabel: null, customUnit: null, valueBool: null, valueLateral: null, valueOrdinal: null, painProvoked: null, note: null };
    const soft = { region: "cervical", techniqueCode: "tessuti_molli", customTechnique: null, approach: null, tolerance: "fastidio", response: "migliorato" };
    const hvlaRow = { region: "lumbar", techniqueCode: "hvla", customTechnique: null, approach: null, tolerance: "buona", response: null, note: null };
    const advice = { templateCode: "camminata", communicatedVia: ["a_voce"] };
    const lumbar = {
      region: "lumbar",
      severity: 1,
      tissueTexture: false,
      asymmetry: false,
      restriction: true,
      tenderness: false,
      side: null,
      segmentNote: null,
      isPrimary: false,
    };
    const expected: Record<string, unknown> = {
      campi: [
        {
          op: "campi",
          before: { nprsPre: 6, observationNote: "Spalle in avanti, capo anteposto" },
          after: { nprsPre: 4, observationNote: "Capo in asse" },
        },
      ],
      "tecnica esistente": [
        {
          op: "tecnica",
          before: { ...soft, note: "Risposta buona già in seduta" },
          after: { ...soft, note: "Risposta buona, ridotta la tensione" },
        },
      ],
      "tecnica nuova": [
        {
          op: "tecnica",
          before: null,
          after: { region: "lumbar", techniqueCode: "funzionale", customTechnique: null, approach: null, tolerance: "buona", response: null, note: null },
        },
      ],
      test: [
        {
          op: "test",
          before: { testCode: "rom_rotazione_cervicale", side: "dx", valueNumeric: 60, ...noTest },
          after: { testCode: "rom_rotazione_cervicale", side: "dx", valueNumeric: 55, ...noTest },
        },
      ],
      "psfs nuovo": [{ op: "psfs", before: null, after: { itemId: r.itemId, score: 3 } }],
      "psfs esistente": [{ op: "psfs", before: { score: 3 }, after: { itemId: r.itemId, score: 5 } }],
      consiglio: [
        {
          op: "consiglio",
          before: { ...advice, text: CAMMINATA },
          after: { ...advice, text: "Cammina 15 minuti" },
        },
      ],
      togli_test: [
        {
          op: "togli_test",
          before: { testCode: "spurling", side: "dx", ...noTest, valueBool: false, valueNumeric: null },
          after: { resultId: r.spurling },
        },
      ],
      togli_tecnica: [{ op: "togli_tecnica", before: hvlaRow, after: { treatmentId: r.hvla } }],
      togli_consiglio: [{ op: "togli_consiglio", before: { ...advice, text: "Cammina 15 minuti" }, after: { adviceId: r.adviceId } }],
      togli_disfunzione: [{ op: "togli_disfunzione", before: lumbar, after: { region: "lumbar" } }],
      nessun_altra_voce: [
        { op: "nessun_altra_voce", before: null, after: { group: "ci_sistemica" } },
        {
          op: "esiti",
          before: ["thrust", "direct", "indirect"].map((family) => ({
            family,
            suggested: "indicated",
            outcome: "indicated",
            localContraindicated: [],
            overrideNote: null,
          })),
          after: { outcomes: outcomes("indicated", "indicated", "indicated").outcomes },
        },
      ],
      conferma: [{ op: "conferma", before: { copied: false }, after: { target: { table: "findings", id: r.cervicalId } } }],
    };
    for (const [name, changes] of Object.entries(expected)) expect(r[name], name).toEqual(changes);
  });
});

describe("ogni voce una volta sola nella rettifica", () => {
  const TWICE = "In una rettifica ogni voce si cambia una volta sola.";

  it("due risposte sulla stessa voce, una disfunzione sulla primaria tolta, o Nessun'altra voce e una sua voce: rifiutate senza scrivere", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      const reason = "Rettifica con voci ripetute";
      const esiti = outcomes("caution", "caution", "indicated");
      await expectDomainError(amend(tx, s.firstId, reason, [answer("ci_osteo", "si"), answer("ci_osteo", "non_so"), esiti]), TWICE);
      // La primaria passa alla lombare e toglie quella cervicale: una seconda scrittura della cervicale è rifiutata.
      await expectDomainError(
        amend(tx, s.firstId, reason, [
          { op: "disfunzione", region: "lumbar", severity: 1, restriction: true, isPrimary: true },
          { ...CERVICAL_FINDING, isPrimary: false, segmentNote: "C2 FRS dx" },
        ]),
        TWICE,
      );
      await expectDomainError(
        amend(tx, s.firstId, reason, [{ op: "nessun_altra_voce", group: "ci_sistemica" }, answer("ci_osteo", "si"), esiti]),
        TWICE,
      );
      await expectDomainError(
        amend(tx, s.firstId, reason, [answer("ci_osteo", "si"), { op: "nessun_altra_voce", group: "ci_sistemica" }, esiti]),
        TWICE,
      );
      return {
        amendments: (await amendmentsOf(tx, s.firstId)).length,
        answer: await answerOf(tx, s.firstId, "ci_osteo"),
        findings: (await findingsOf(tx, s.firstId)).map((f) => [f.region, f.isPrimary, f.segmentNote]),
      };
    });
    expect(r).toEqual({
      amendments: 0,
      answer: "no",
      findings: [
        ["cervical", true, "C2-C3 dx"],
        ["lumbar", false, null],
      ],
    });
  });

  it("due disfunzioni primarie nella stessa rettifica, su una visita senza primaria: rifiutate senza scrivere", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      await amend(tx, s.firstId, "Nessuna regione primaria", [{ ...CERVICAL_FINDING, isPrimary: false }]);
      await expectDomainError(
        amend(tx, s.firstId, "Due primarie per errore", [
          { op: "disfunzione", region: "lumbar", severity: 1, restriction: true, isPrimary: true },
          { op: "disfunzione", region: "thoracic", severity: 2, tenderness: true, isPrimary: true },
        ]),
        TWICE,
      );
      return {
        amendments: (await amendmentsOf(tx, s.firstId)).map((a) => a.reason),
        findings: (await findingsOf(tx, s.firstId)).map((f) => [f.region, f.isPrimary]),
      };
    });
    expect(r).toEqual({
      amendments: ["Nessuna regione primaria"],
      findings: [
        ["cervical", false],
        ["lumbar", false],
      ],
    });
  });

  it("la lista del client tiene una voce cambiata più volte in una sola operazione: il server la accetta", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      const view = await getVisitEditor(tx, PRACTICE_A, clock, s.patientId, s.firstId);
      if (view === null) throw new Error("vista assente");
      const advice = view.advice.find((a) => a.templateCode === "camminata");
      if (advice === undefined) throw new Error("consiglio assente");
      const raw: Record<string, unknown>[] = [
        { op: "campi", values: { nprsPost: 2 } },
        answer("ci_osteo", "non_so"),
        outcomes("caution", "caution", "indicated"),
        { ...SOFT_TISSUE_CERVICAL, tolerance: "buona" },
        { op: "togli_consiglio", adviceId: advice.id },
        answer("ci_osteo", "si"),
        outcomes("caution", "caution", "indicated"),
        { ...SOFT_TISSUE_CERVICAL, note: "Nota corretta" },
        { op: "consiglio", templateCode: "camminata", text: null, communicatedVia: ["foglio_stampato"] },
        { op: "campi", values: { nprsPost: 1, treatmentResponse: "invariato" } },
      ];
      // Così come arriva dalle sezioni, la stessa sequenza tocca più volte le stesse voci.
      await expectDomainError(amend(tx, s.firstId, "Modifiche ripetute", raw), TWICE);
      const list = raw.reduce<AmendOp[]>((acc, op) => {
        const merged = mergeAmendOp(acc, op as AmendOp, view);
        if (!merged.ok) throw new Error(merged.message);
        return merged.list;
      }, []);
      // Una sovrapposizione che il server non comporrebbe la rifiuta già il client, con la stessa frase.
      const demoted = mergeAmendOp([{ op: "disfunzione", region: "lumbar", severity: 1, restriction: true, isPrimary: true }], { ...CERVICAL_FINDING, isPrimary: false } as AmendOp, view);
      expect(demoted).toEqual({ ok: false, message: TWICE });
      await expectDomainError(
        amend(tx, s.firstId, "Modifiche ripetute", [{ op: "disfunzione", region: "lumbar", severity: 1, restriction: true, isPrimary: true }, { ...CERVICAL_FINDING, isPrimary: false }]),
        TWICE,
      );
      await amend(tx, s.firstId, "Modifiche ripetute", list);
      return {
        ops: list.map((o) => o.op),
        amendments: (await amendmentsOf(tx, s.firstId)).length,
        answer: await answerOf(tx, s.firstId, "ci_osteo"),
        visit: await visitOf(tx, s.firstId),
        note: (await treatmentsOf(tx, s.firstId)).find((t) => t.techniqueCode === "tessuti_molli")?.note,
      };
    });
    expect(r.ops).toEqual(["risposta", "esiti", "tecnica", "consiglio", "campi"]);
    expect(r.amendments).toBe(1);
    expect(r.answer).toBe("si");
    expect(r.visit).toMatchObject({ nprsPost: 1, treatmentResponse: "invariato" });
    expect(r.note).toBe("Nota corretta");
  });

  it("risposta ed esiti restano ammessi insieme, con un prima esatto", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await closedFirstVisit(tx);
      await amend(tx, s.firstId, "Risposta segnata per errore", [answer("ci_osteo", "si"), outcomes("caution", "caution", "indicated")]);
      return (await amendmentsOf(tx, s.firstId))[0]?.changes as { op: string; before: unknown }[];
    });
    expect(r.map((c) => c.op)).toEqual(["risposta", "esiti"]);
    expect(r[0]?.before).toMatchObject({ answer: "no" });
  });
});

// Una seduta del 15/10, compilata dopo, diventa la prima del ciclo in ordine di data, ma
// l'apertura scritta e chiusa con la visita del 20/10 cambia solo con una rettifica di quella visita.
describe("l'apertura di un ciclo con una visita chiusa", () => {
  const LOCKED = "L'apertura del ciclo si cambia con una rettifica della visita del 20/10/2026.";

  /** La prima visita del 20/10 chiusa, poi la bozza della seduta del 15/10 (un fatto rimasto senza visita). */
  async function backFilled(tx: Tx) {
    const s = await closedFirstVisit(tx);
    const earlier = await appointment(tx, s.patientId, s.cycleId, "2026-10-15", "09:00", "fatto");
    const { visitId: draftId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId: earlier });
    return { ...s, draftId };
  }

  const openingOf = (tx: Tx, cycleId: string) =>
    tx.query<Record<string, unknown>>(
      `select chief_complaint as "chiefComplaint", goal, plan_agreed_on as "planAgreedOn" from public.treatment_cycles where id = $1`,
      [cycleId],
    );

  it("la sonda: nessuna scrittura dell'apertura passa fuori dalla rettifica e niente cambia", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await backFilled(tx);
      const [item] = await tx.query<{ id: string }>(
        "insert into public.psfs_items (practice_id, cycle_id, position, activity) values ($1, $2, 1, 'Guidare 30 minuti') returning id",
        [PRACTICE_A, s.cycleId],
      );
      const before = await openingOf(tx, s.cycleId);
      const changed = { cycleId: s.cycleId, chiefComplaint: "Cambiato senza rettifica" };
      await expectDomainError(updateCycleOpening(tx, PRACTICE_A, clock, changed), NOT_ALLOWED);
      await expectDomainError(editOpening(tx, PRACTICE_A, clock, s.draftId, { goal: "Dalla bozza" }), NOT_ALLOWED);
      await expectDomainError(run(tx, s.draftId, { op: "apertura", goal: "Dalla bozza" }), NOT_ALLOWED);
      await expectDomainError(run(tx, s.draftId, { op: "psfs", itemId: item?.id, score: 4 }), NOT_ALLOWED);
      await expectDomainError(
        editPsfsItem(tx, PRACTICE_A, clock, s.draftId, { kind: "aggiungi", activity: "Dormire sul fianco" }),
        NOT_ALLOWED,
      );
      await expectDomainError(addPsfsItem(tx, PRACTICE_A, clock, { cycleId: s.cycleId, activity: "Dormire sul fianco" }), NOT_ALLOWED);
      return {
        before,
        after: await openingOf(tx, s.cycleId),
        items: (await tx.query("select 1 from public.psfs_items where cycle_id = $1", [s.cycleId])).length,
        scores: (await tx.query("select 1 from public.psfs_scores where visit_id = $1", [s.draftId])).length,
        amendments: (await amendmentsOf(tx, s.firstId)).length,
      };
    });
    expect(r.after).toEqual(r.before);
    expect(r.after[0]).toMatchObject({ chiefComplaint: "Dolore al collo da tre settimane, peggio la sera" });
    expect(r).toMatchObject({ items: 1, scores: 0, amendments: 0 });
  });

  it("la rettifica della visita chiusa del 20/10 cambia l'apertura con prima e dopo", async () => {
    const goal = "Lavorare al computer 3 ore senza dolore";
    const r = await inUserA(db, async (tx) => {
      const s = await backFilled(tx);
      await amend(tx, s.firstId, "Obiettivo riscritto con il paziente", [{ op: "apertura", goal }]);
      return { opening: await openingOf(tx, s.cycleId), amendments: await amendmentsOf(tx, s.firstId) };
    });
    expect(r.opening[0]?.goal).toBe(goal);
    expect(r.amendments.map((a) => a.changes)).toEqual([
      [{ op: "apertura", before: { goal: "Girare la testa in auto senza dolore" }, after: { goal } }],
    ]);
  });

  it("una seconda visita chiusa non prende l'apertura: resta della visita chiusa del 20/10", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await backFilled(tx);
      // La bozza del 15/10 resta la prima; la visita del 20/10 tiene l'apertura anche dopo un'altra chiusa.
      const { visitId: later } = await secondVisit(tx, s);
      await run(tx, later, { op: "nessuna_variazione" });
      await close(tx, later);
      await expectDomainError(amend(tx, later, "Obiettivo riscritto con il paziente", [{ op: "apertura", goal: "Dopo" }]), NOT_ALLOWED);
      await expectDomainError(editOpening(tx, PRACTICE_A, clock, s.draftId, { goal: "Dalla bozza" }), NOT_ALLOWED);
      return openingOf(tx, s.cycleId);
    });
    expect(r[0]?.goal).toBe("Girare la testa in auto senza dolore");
  });

  // La visita che tiene l'apertura è quella chiusa per prima nel tempo, non per data.
  it("chiusa anche la seduta del 15/10, l'apertura e il punteggio iniziale restano della visita del 20/10", async () => {
    const goal = "Lavorare al computer 3 ore senza dolore";
    const r = await inUserA(db, async (tx) => {
      const s = await backFilled(tx);
      const [item] = await tx.query<{ id: string }>(
        "insert into public.psfs_items (practice_id, cycle_id, position, activity) values ($1, $2, 1, 'Guidare 30 minuti') returning id",
        [PRACTICE_A, s.cycleId],
      );
      const itemId = item?.id ?? "";
      await amend(tx, s.firstId, "Punteggio iniziale dimenticato", [{ op: "psfs", itemId, score: 4 }]);
      // La bozza del 15/10 si chiude il 4/11, dopo la visita del 20/10.
      await noOthers(tx, s.draftId, [...ALWAYS, CERVICAL_GROUP]);
      await run(tx, s.draftId, outcomes("indicated", "indicated", "indicated"));
      await close(tx, s.draftId);

      await expectDomainError(amend(tx, s.draftId, "Obiettivo riscritto con il paziente", [{ op: "apertura", goal }]), NOT_ALLOWED);
      await expectDomainError(amend(tx, s.draftId, "Punteggio iniziale corretto", [{ op: "psfs", itemId, score: 7 }]), NOT_ALLOWED);
      await amend(tx, s.firstId, "Obiettivo riscritto con il paziente", [{ op: "apertura", goal }]);
      await amend(tx, s.firstId, "Punteggio iniziale corretto", [{ op: "psfs", itemId, score: 5 }]);

      const first = await getVisitEditor(tx, PRACTICE_A, clock, s.patientId, s.firstId);
      const backFill = await getVisitEditor(tx, PRACTICE_A, clock, s.patientId, s.draftId);
      return {
        opening: await openingOf(tx, s.cycleId),
        scores: await tx.query<{ visitId: string; score: number; phase: string }>(
          'select visit_id as "visitId", score, phase from public.psfs_scores where item_id = $1',
          [itemId],
        ),
        firstAmendments: (await amendmentsOf(tx, s.firstId)).map((a) => a.changes),
        backFillAmendments: (await amendmentsOf(tx, s.draftId)).length,
        first: first?.cycle,
        backFill: backFill?.cycle,
        ids: { firstId: s.firstId, itemId },
      };
    });
    expect(r.opening[0]?.goal).toBe(goal);
    expect(r.scores).toEqual([{ visitId: r.ids.firstId, score: 5, phase: "iniziale" }]);
    // Nella stessa transazione `created_at` è uguale per le tre rettifiche: l'ordine non conta.
    expect(r.firstAmendments).toHaveLength(3);
    expect(r.firstAmendments).toEqual(
      expect.arrayContaining([
        [{ op: "psfs", before: null, after: { itemId: r.ids.itemId, score: 4 } }],
        [{ op: "apertura", before: { goal: "Girare la testa in auto senza dolore" }, after: { goal } }],
        [{ op: "psfs", before: { score: 4 }, after: { itemId: r.ids.itemId, score: 5 } }],
      ]),
    );
    expect(r.backFillAmendments).toBe(0);
    expect(r.first).toMatchObject({ isFirstVisit: false, showsOpening: true, openingLock: null });
    expect(r.backFill).toMatchObject({ isFirstVisit: true, showsOpening: true, openingLock: LOCKED });
  });

  it("l'editor mostra l'apertura in sola lettura nella bozza, con la data della visita chiusa che la tiene", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await backFilled(tx);
      const draft = await getVisitEditor(tx, PRACTICE_A, clock, s.patientId, s.draftId);
      const closed = await getVisitEditor(tx, PRACTICE_A, clock, s.patientId, s.firstId);
      return { draft: draft?.cycle, closed: closed?.cycle };
    });
    expect(r.draft).toMatchObject({ isFirstVisit: true, showsOpening: true, openingLock: LOCKED, relapse: null });
    expect(r.closed).toMatchObject({ isFirstVisit: false, showsOpening: true, openingLock: null });
  });
});

describe("come uB sui dati di A", () => {
  const snapshotOfA = () =>
    asUserA(db, async (tx) => {
      const rows = (table: string) => tx.query(`select * from public.${table} where practice_id = $1 order by id`, [PRACTICE_A]);
      return {
        visits: await rows("visits"),
        findings: await rows("visit_region_findings"),
        treatments: await rows("visit_treatments"),
        amendments: await rows("visit_amendments"),
        cycles: await rows("treatment_cycles"),
      };
    });

  it("copia, chiusura e rettifica sono Operazione non permessa e A non cambia", async () => {
    const s = await asUserA(db, (tx) => closedFirstVisit(tx));
    const before = await snapshotOfA();
    await asUserB(db, async (tx) => {
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        for (const visitId of [VISIT_A, s.firstId]) {
          await expectDomainError(copyFromPreviousVisit(tx, practiceId, clock, { visitId, replace: true }), NOT_ALLOWED);
          await expectDomainError(closeVisit(tx, practiceId, clock, { visitId, confirmCopied: true, alsoMarkDone: true }), NOT_ALLOWED);
          await expectDomainError(
            amendVisit(tx, practiceId, clock, {
              visitId,
              reason: "Errore di battitura sul segmento",
              ops: [{ op: "apertura", goal: "Obiettivo di un altro studio" }],
            }),
            NOT_ALLOWED,
          );
        }
      }
    });
    expect(await snapshotOfA()).toEqual(before);
  });
});
