import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ACTIVE_TEST_CODES, PREGNANCY_POSITION_NOTE } from "@/lib/clinical/catalog";
import { closingCheck } from "@/lib/clinical/visit-rules";
import { type Clock, fixedClock, romeDateTime } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { getCartellaTab, getTestsOverTime } from "@/server/domain/cartella/queries";
import { closeCycle, updateCycleOpening } from "@/server/domain/cycles/commands";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { saveHistoryItem, saveLifestyle } from "@/server/domain/history/commands";
import { createPatient } from "@/server/domain/patients/commands";
import { saveClinicalSettings } from "@/server/domain/settings/commands";
import { getClinicalSettings } from "@/server/domain/settings/queries";
import { amendVisit, closeVisit, closingFactsFor, copyFromPreviousVisit, editVisit, startVisit } from "@/server/domain/visits/commands";
import { getVisitEditor } from "@/server/domain/visits/editor";
import { loadVisit } from "@/server/domain/visits/ops";
import { CYCLE_A, FILE_A, PATIENT_A1, PRACTICE_A, PRACTICE_B, SERVICE_A, sha256Hex, VISIT_A } from "./fixtures";
import { inRollback, inUserA, insertRow, openTestDb } from "./helpers";

// Le letture della tab Cartella, dei test nel tempo e dell'editor della visita.
// Tutto come uA su dati scritti con i comandi;
// oggi è mercoledì 4/11/2026 alle 08:30 di Roma, le visite passate hanno il loro orologio.

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const clockOf = (day: string): Clock => fixedClock(`${day}T10:00:00+01:00`);

const ALWAYS = ["ci_sistemica", "ci_locale", "rf_rachide"] as const;
const CERVICAL_GROUP = "rf_cervicale_vascolare";
const INR_NOTE = "INR 2,5 del 03/11/2026 dal libretto TAO";
const HVLA_BLOCKED =
  "HVLA controindicata in questa visita: terapia anticoagulante. Cambia l'esito dello screening se hai nuove informazioni.";

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

// Preparazione, tutta come uA ------------------------------------------------------------------------

/** Le fixture hanno `active_test_codes '{}'`: si accendono i 24 test, e i promemoria di rinvio si spengono. */
async function clinicalSettings(tx: Tx): Promise<void> {
  const today = await getClinicalSettings(tx, PRACTICE_A);
  if (!today) throw new Error("impostazioni cliniche mancanti");
  await saveClinicalSettings(tx, PRACTICE_A, clock, {
    defaultRecallWeeks: today.defaultRecallWeeks,
    defaultExpectedSessions: today.defaultExpectedSessions,
    defaultSessionIntervalWeeks: today.defaultSessionIntervalWeeks,
    referralPrompts: [],
    activeTestCodes: [...DEFAULT_ACTIVE_TEST_CODES],
  });
}

async function newPatient(tx: Tx, firstName: string, lastName: string, birthDate = "1980-03-15"): Promise<string> {
  const { id } = await createPatient(tx, PRACTICE_A, clockOf("2026-09-01"), { firstName, lastName, birthDate });
  return id;
}

async function cycle(tx: Tx, patientId: string, openedOn: string, title: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions)
     values ($1, $2, 'trattamento', $3, $4, 4) returning id`,
    [PRACTICE_A, patientId, openedOn, title],
  );
  if (!row) throw new Error("ciclo non creato");
  return row.id;
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

async function visitOn(tx: Tx, patientId: string, cycleId: string, day: string, status = "fatto", time = "09:00"): Promise<string> {
  const appointmentId = await appointment(tx, patientId, cycleId, day, time, status);
  const { visitId } = await startVisit(tx, PRACTICE_A, day === "2026-11-04" ? clock : clockOf(day), { appointmentId });
  return visitId;
}

const run = (tx: Tx, visitId: string, op: Record<string, unknown>, c: Clock = clock) =>
  editVisit(tx, PRACTICE_A, c, { visitId, op });

async function noOthers(tx: Tx, visitId: string, groups: readonly string[], c: Clock = clock): Promise<void> {
  for (const group of groups) await run(tx, visitId, { op: "nessun_altra_voce", group }, c);
}

const outcomes = (thrust: string, direct: string, indirect: string, directNote: string | null = null) => ({
  op: "esiti",
  outcomes: [
    { family: "thrust", outcome: thrust, overrideNote: null },
    { family: "direct", outcome: direct, overrideNote: directNote },
    { family: "indirect", outcome: indirect, overrideNote: null },
  ],
});

const opening = (tx: Tx, cycleId: string, mainRegion: string, c: Clock) =>
  updateCycleOpening(tx, PRACTICE_A, c, {
    cycleId,
    chiefComplaint: "Dolore da tre settimane, peggio la sera",
    mainRegion,
    goal: "Tornare a lavorare senza dolore",
    expectedSessions: 4,
  });

/** La prima visita di un ciclo, confermata, con il dolore e le tecniche date, chiusa con il suo orologio. */
async function closedFirstVisit(
  tx: Tx,
  patientId: string,
  cycleId: string,
  day: string,
  o: { mainRegion: "cervical" | "lumbar"; pain: [number, number]; techniques: readonly string[] },
): Promise<string> {
  const c = clockOf(day);
  const visitId = await visitOn(tx, patientId, cycleId, day);
  await opening(tx, cycleId, o.mainRegion, c);
  await noOthers(tx, visitId, o.mainRegion === "cervical" ? [...ALWAYS, CERVICAL_GROUP] : ALWAYS, c);
  await run(tx, visitId, outcomes("indicated", "indicated", "indicated"), c);
  await run(tx, visitId, { op: "campi", values: { nprsPre: o.pain[0], nprsPost: o.pain[1] } }, c);
  for (const region of o.techniques) await run(tx, visitId, { op: "tecnica", region, techniqueCode: "tessuti_molli" }, c);
  await closeVisit(tx, PRACTICE_A, c, { visitId, confirmCopied: false, alsoMarkDone: false });
  return visitId;
}

async function revokedTreatmentConsent(tx: Tx, patientId: string, cycleId: string): Promise<void> {
  const text = "Consenso al trattamento osteopatico di Anna Galli";
  const row = await insertRow(tx, "consent_records", {
    practice_id: PRACTICE_A,
    patient_id: patientId,
    cycle_id: cycleId,
    module_key: "trattamento",
    module_version: "2026.1",
    rendered_text: text,
    rendered_hash: sha256Hex(text),
    signer_kind: "paziente",
    signer_name: "Anna Galli",
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

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (value: unknown) => expect.fail(`atteso un errore, invece la lettura ha restituito ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );
}

// ----------------------------------------------------------------------------------------------------

describe("getCartellaTab", () => {
  /**
   * Un ciclo chiuso (settembre: una visita chiusa e poi rettificata, una seduta fatta senza visita) e un ciclo
   * aperto (ottobre-novembre: la prima visita chiusa con dolore 7 → 4 su cervicale e dorsale, una bozza su un
   * fatto, una bozza sull'appuntamento confermato di oggi), un rinvio in bozza.
   */
  async function scenario(tx: Tx) {
    await clinicalSettings(tx);
    const patientId = await newPatient(tx, "Piero", "Lanzi");

    const closedCycle = await cycle(tx, patientId, "2026-09-01", "Lombalgia, settembre 2026");
    const oldVisit = await closedFirstVisit(tx, patientId, closedCycle, "2026-09-02", {
      mainRegion: "lumbar",
      pain: [5, 2],
      techniques: ["lumbar"],
    });
    await amendVisit(tx, PRACTICE_A, clock, {
      visitId: oldVisit,
      reason: "Piano scritto nella visita sbagliata",
      ops: [{ op: "campi", values: { planNext: "Controllo fra un mese" } }],
    });
    const noVisit = await appointment(tx, patientId, closedCycle, "2026-09-09", "09:00", "fatto");
    await closeCycle(tx, PRACTICE_A, clock, {
      cycleId: closedCycle,
      outcome: "raggiunto",
      closedOn: "2026-09-30",
      finalScores: "non_tornato",
      recall: "nessuno",
    });

    const openCycle = await cycle(tx, patientId, "2026-10-20", "Cervicalgia, ottobre 2026");
    const first = await closedFirstVisit(tx, patientId, openCycle, "2026-10-20", {
      mainRegion: "cervical",
      pain: [7, 4],
      techniques: ["cervical", "thoracic"],
    });
    const doneDraft = await visitOn(tx, patientId, openCycle, "2026-10-27");
    await run(tx, doneDraft, { op: "campi", values: { nprsPre: 5 } }, clockOf("2026-10-27"));
    const confirmedDraft = await visitOn(tx, patientId, openCycle, "2026-11-04", "confermato", "08:00");

    const referral = await insertRow(tx, "referrals", {
      practice_id: PRACTICE_A,
      patient_id: patientId,
      cycle_id: openCycle,
      created_on: "2026-10-27",
      recipient_kind: "specialista",
      recipient_free: "Dott. Neri, ortopedico",
      reason: "sintomi_persistenti",
      urgency: "programmato",
      summary_text: "Cervicalgia che non migliora dopo due sedute",
      request_text: "Si chiede una valutazione ortopedica",
    });

    return {
      patientId,
      closedCycle,
      openCycle,
      oldVisit,
      noVisit,
      first,
      doneDraft,
      confirmedDraft,
      referralId: String(referral.id),
      tab: await getCartellaTab(tx, PRACTICE_A, clock, patientId),
    };
  }

  it("testata, ciclo aperto, cronologia con le sedute da compilare, rinvii e richiamo", async () => {
    const s = await inUserA(db, scenario);
    const { tab } = s;

    expect(tab.header).toEqual({ ageText: "46 anni", badges: [], clinicalAlert: null, consentText: "Manca 2", gp: null });
    expect(tab.openCycle).toEqual({
      id: s.openCycle,
      kind: "trattamento",
      title: "Cervicalgia, ottobre 2026",
      goal: "Tornare a lavorare senza dolore",
      sessionText: "Seduta 2 di 4",
      pain: [
        { day: "2026-10-20", value: 7 },
        { day: "2026-10-27", value: 5 },
      ],
      psfs: [],
    });

    // Il ciclo chiuso dopo l'aperto: dal più recente.
    expect(tab.history.map((c) => [c.id, c.title, c.statusText])).toEqual([
      [s.openCycle, "Cervicalgia, ottobre 2026", "Aperto"],
      [s.closedCycle, "Lombalgia, settembre 2026", "Chiuso il 30/09/2026, Obiettivo raggiunto"],
    ]);
    expect(tab.history[0]?.sessions).toEqual([
      {
        kind: "visita",
        visitId: s.first,
        day: "2026-10-20",
        dateText: "mar 20 ott",
        kindLabel: "Seduta",
        painText: "7 → 4",
        regionsText: "Cervicale, Dorsale",
        statusLabel: "Chiusa",
        amendedText: null,
        toFill: false,
      },
      {
        kind: "visita",
        visitId: s.doneDraft,
        day: "2026-10-27",
        dateText: "mar 27 ott",
        kindLabel: "Seduta",
        painText: "5 → non rilevato",
        regionsText: "",
        statusLabel: "Bozza",
        amendedText: null,
        toFill: true,
      },
      {
        kind: "visita",
        visitId: s.confirmedDraft,
        day: "2026-11-04",
        dateText: "mer 4 nov",
        kindLabel: "Seduta",
        painText: null,
        regionsText: "",
        statusLabel: "Bozza",
        amendedText: null,
        toFill: false,
      },
    ]);
    expect(tab.history[1]?.sessions).toEqual([
      {
        kind: "visita",
        visitId: s.oldVisit,
        day: "2026-09-02",
        dateText: "mer 2 set",
        kindLabel: "Seduta",
        painText: "5 → 2",
        regionsText: "Lombare",
        statusLabel: "Chiusa",
        amendedText: "Rettificata il 04/11/2026",
        toFill: false,
      },
      { kind: "senza_visita", appointmentId: s.noVisit, day: "2026-09-09", dateText: "mer 9 set", toFill: true },
    ]);

    // Il rinvio della fixture è di un altro paziente: non compare.
    expect(tab.referrals).toEqual([
      { id: s.referralId, text: "Lettera del 27/10/2026: Dott. Neri, ortopedico", statusLabel: "Bozza" },
    ]);
    expect(tab.attachments).toEqual([]);
    expect(tab.recallText).toBe("Nessun richiamo previsto.");
    expect(tab.canStartReferral).toBe(true);
  });

  it("un paziente senza cicli: niente ciclo aperto, cronologia vuota, nessun rinvio da preparare", async () => {
    const tab = await inUserA(db, async (tx) => getCartellaTab(tx, PRACTICE_A, clock, await newPatient(tx, "Lia", "Monti")));
    expect(tab.openCycle).toBeNull();
    expect(tab.history).toEqual([]);
    expect(tab.referrals).toEqual([]);
    expect(tab.canStartReferral).toBe(false);
    expect(tab.recallText).toBe("Nessun richiamo previsto.");
  });

  it("un paziente di un altro studio non si legge", async () => {
    const error = await inRollback(db, "B", (tx) => rejectionOf(getCartellaTab(tx, PRACTICE_B, clock, PATIENT_A1)));
    expect(isDomainError(error)).toBe(true);
    expect((error as Error).message).toBe(NOT_ALLOWED);
  });
});

describe("getTestsOverTime", () => {
  async function scenario(tx: Tx) {
    await clinicalSettings(tx);
    const patientId = await newPatient(tx, "Giulia", "Ferrante");
    const cycleId = await cycle(tx, patientId, "2026-10-13", "Lombalgia, ottobre 2026");
    const days = ["2026-10-13", "2026-10-20", "2026-10-27"];
    const values = [28, 18, 10];
    const visits: string[] = [];
    for (const [i, day] of days.entries()) {
      const visitId = await visitOn(tx, patientId, cycleId, day);
      await run(tx, visitId, { op: "test", testCode: "dita_pavimento", valueNumeric: values[i] }, clockOf(day));
      visits.push(visitId);
    }
    return { patientId, cycleId, visits };
  }

  it("una riga per test e lato, una colonna per visita, la variazione dalla prima misura; il filtro della regione", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await scenario(tx);
      return {
        s,
        all: await getTestsOverTime(tx, PRACTICE_A, s.patientId, { cycleId: null, region: null }),
        lumbar: await getTestsOverTime(tx, PRACTICE_A, s.patientId, { cycleId: s.cycleId, region: "lumbar" }),
        cervical: await getTestsOverTime(tx, PRACTICE_A, s.patientId, { cycleId: null, region: "cervical" }),
        // Il ciclo di un altro paziente non si sceglie: vale il predefinito.
        foreign: await getTestsOverTime(tx, PRACTICE_A, s.patientId, { cycleId: CYCLE_A, region: null }),
      };
    });
    expect(r.all.cycles).toEqual([{ id: r.s.cycleId, title: "Lombalgia, ottobre 2026" }]);
    expect(r.all.cycleId).toBe(r.s.cycleId);
    expect(r.all.region).toBeNull();
    expect(r.all.columns).toEqual([
      { visitId: r.s.visits[0], dateText: "mar 13 ott" },
      { visitId: r.s.visits[1], dateText: "mar 20 ott" },
      { visitId: r.s.visits[2], dateText: "mar 27 ott" },
    ]);
    expect(r.all.rows).toHaveLength(1);
    expect(r.all.rows[0]).toMatchObject({
      label: "Distanza dita-pavimento",
      region: "lumbar",
      values: ["28 cm", "18 cm", "10 cm"],
      numeric: [28, 18, 10],
      change: { text: "-18 cm", trend: "improved" },
    });
    expect(r.lumbar.rows).toHaveLength(1);
    expect(r.cervical.region).toBe("cervical");
    expect(r.cervical.columns).toHaveLength(3);
    expect(r.cervical.rows).toEqual([]);
    expect(r.foreign.cycleId).toBe(r.s.cycleId);
  });

  it("un paziente senza cicli e un paziente di un altro studio: nessuna colonna e nessuna riga", async () => {
    const empty = await inUserA(db, async (tx) =>
      getTestsOverTime(tx, PRACTICE_A, await newPatient(tx, "Lia", "Monti"), { cycleId: null, region: null }),
    );
    const foreign = await inRollback(db, "B", (tx) => getTestsOverTime(tx, PRACTICE_B, PATIENT_A1, { cycleId: null, region: null }));
    for (const view of [empty, foreign]) {
      expect(view).toEqual({ cycles: [], cycleId: null, region: null, columns: [], rows: [] });
    }
  });
});

describe("getVisitEditor", () => {
  /**
   * Una paziente in TAO: la prima visita del 20/10 con la regione principale lombare, lo screening confermato
   * (thrust controindicato, dirette con cautela con la nota dell'INR), la flessione-rotazione dx a 28, una
   * tecnica funzionale lombare e il consiglio delle pause attive, chiusa. La seconda visita è di oggi.
   */
  async function taoPatient(tx: Tx) {
    await clinicalSettings(tx);
    const patientId = await newPatient(tx, "Anna", "Galli", "1958-06-02");
    await saveHistoryItem(tx, PRACTICE_A, clockOf("2026-10-01"), {
      patientId,
      kind: "farmaco",
      label: "Warfarin 5 mg",
      region: null,
      occurredOn: null,
      occurredYear: null,
      ongoing: true,
      note: null,
    });
    const cycleId = await cycle(tx, patientId, "2026-10-20", "Lombalgia, ottobre 2026");
    const c = clockOf("2026-10-20");
    const firstId = await visitOn(tx, patientId, cycleId, "2026-10-20");
    const firstDraft = await getVisitEditor(tx, PRACTICE_A, c, patientId, firstId);

    await opening(tx, cycleId, "lumbar", c);
    await noOthers(tx, firstId, ALWAYS, c);
    await run(tx, firstId, outcomes("contraindicated", "caution", "indicated", INR_NOTE), c);
    await run(tx, firstId, { op: "test", testCode: "flessione_rotazione", side: "dx", valueNumeric: 28 }, c);
    await run(tx, firstId, { op: "tecnica", region: "lumbar", techniqueCode: "funzionale" }, c);
    await run(tx, firstId, { op: "consiglio", templateCode: "pause_attive", text: null, communicatedVia: ["a_voce"] }, c);
    await closeVisit(tx, PRACTICE_A, c, { visitId: firstId, confirmCopied: false, alsoMarkDone: false });

    const visitId = await visitOn(tx, patientId, cycleId, "2026-11-04", "confermato", "08:00");
    return { patientId, cycleId, firstId, firstDraft, visitId };
  }

  it("pillole, blocchi delle tecniche, copia, test con il valore precedente e la variazione, chiusura", async () => {
    const r = await inUserA(db, async (tx) => {
      const s = await taoPatient(tx);
      const unconfirmed = await getVisitEditor(tx, PRACTICE_A, clock, s.patientId, s.visitId);
      await noOthers(tx, s.visitId, ALWAYS);
      await run(tx, s.visitId, outcomes("contraindicated", "caution", "indicated", INR_NOTE));
      await run(tx, s.visitId, { op: "test", testCode: "flessione_rotazione", side: "dx", valueNumeric: 38 });
      const confirmed = await getVisitEditor(tx, PRACTICE_A, clock, s.patientId, s.visitId);
      await copyFromPreviousVisit(tx, PRACTICE_A, clock, { visitId: s.visitId, replace: false });
      const copied = await getVisitEditor(tx, PRACTICE_A, clock, s.patientId, s.visitId);
      await revokedTreatmentConsent(tx, s.patientId, s.cycleId);
      const revoked = await getVisitEditor(tx, PRACTICE_A, clock, s.patientId, s.visitId);
      return {
        s,
        unconfirmed,
        confirmed,
        copied,
        revoked,
        closedFirst: await getVisitEditor(tx, PRACTICE_A, clock, s.patientId, s.firstId),
        otherPatient: await getVisitEditor(tx, PRACTICE_A, clock, PATIENT_A1, s.visitId),
      };
    });

    // La prima visita di una paziente senza visite chiuse: nessuna copia, nessuna "Nessuna variazione".
    expect(r.s.firstDraft?.copy).toEqual({ available: false, label: null });
    expect(r.s.firstDraft?.screening.noChange).toBeNull();
    expect(r.s.firstDraft?.cycle.isFirstVisit).toBe(true);
    expect(r.s.firstDraft?.compare).toEqual({ first: null, previous: null });

    const u = r.unconfirmed;
    expect(u?.visit).toMatchObject({
      id: r.s.visitId,
      patientId: r.s.patientId,
      appointmentStatus: "confermato",
      status: "draft",
      dateText: "mercoledì 4 novembre 2026",
      visitDate: "2026-11-04",
      kind: "seduta",
      kindLabel: "Seduta",
      amendedText: null,
      screeningConfirmed: false,
    });
    expect(u?.patient).toMatchObject({ name: "Anna Galli", ageText: "68 anni", minor: false, badges: ["TAO"], pregnancyInProgress: false });
    expect(u?.cycle).toMatchObject({ id: r.s.cycleId, kind: "trattamento", sessionText: "Seduta 2 di 4", isFirstVisit: false, relapse: null });
    // I gruppi sono quelli che il server chiede: regione principale lombare, nessuna gravidanza.
    expect(u?.screening.groups.map((g) => g.code)).toEqual([...ALWAYS]);
    const avk = u?.screening.groups[0]?.items.find((i) => i.item.code === "ci_avk");
    expect(avk?.answer).toMatchObject({ answer: "si", fromHistory: true });
    expect(u?.screening.pills).toEqual([]);
    expect(u?.screening.outcomes).toBeNull();
    expect(u?.screening.noChange).toEqual({ label: "Nessuna variazione dal 20/10" });
    expect(u?.screening.positionNote).toBeNull();
    expect(u?.closing.blocking.map((b) => b.code)).toEqual(["screening"]);
    expect(u?.techniqueChecks.lumbar.funzionale).toEqual({
      kind: "blocked",
      text: "Conferma lo screening prima di scrivere il trattamento.",
    });

    const e = r.confirmed;
    expect(e?.visit.screeningConfirmed).toBe(true);
    expect(e?.screening.pills).toEqual(["Thrust: controindicato", "Dirette: con cautela", "Indirette: indicato"]);
    expect(e?.screening.outcomes?.direct).toMatchObject({ suggested: "contraindicated", outcome: "caution", overrideNote: INR_NOTE });
    expect(e?.screening.suggestion.thrust).toMatchObject({ suggested: "contraindicated", reason: "terapia anticoagulante" });
    expect(e?.techniqueChecks.lumbar.hvla).toEqual({ kind: "blocked", text: HVLA_BLOCKED });
    expect(e?.techniqueChecks.lumbar.funzionale.kind).toBe("ok");
    expect(e?.techniqueChecks.lumbar.tessuti_molli).toEqual({ kind: "caution", text: "Con cautela" });
    expect(e?.copy).toEqual({ available: true, label: "del 20/10" });
    expect(e?.prompts).toEqual([]);
    expect(e?.closing.blocking).toEqual([]);
    expect(e?.consentRevoked).toBe(false);
    expect(e?.activeTestCodes).toEqual([...DEFAULT_ACTIVE_TEST_CODES].sort());
    const flexion = e?.tests.find((t) => t.testCode === "flessione_rotazione" && t.side === "dx");
    expect(flexion).toMatchObject({ valueNumeric: 38, previousText: "28°", change: { text: "+10° dx", trend: "improved" } });
    // Il valore precedente c'è anche per i test senza una riga oggi (il lato sx non ha una misura, il dx sì).
    expect(e?.previousByKey).toEqual({ "flessione_rotazione|dx": "28°" });
    // Senza disfunzioni né tecniche oggi: solo i modelli per tutte le regioni, nessuno del lattante.
    expect(e?.suggestedAdvice.map((a) => a.code)).toEqual(["idratazione_riposo", "indolenzimento"]);
    expect(e?.compare.first).toMatchObject({ label: "la prima visita del ciclo", findings: [], changes: {} });
    expect(e?.compare.previous).toMatchObject({ label: "la visita precedente", findings: [] });

    // Dopo la copia: i modelli della visita sorgente in testa, non spuntati.
    expect(r.copied?.suggestedAdvice[0]?.code).toBe("pause_attive");
    expect(r.copied?.advice).toEqual([]);
    expect(r.copied?.treatments).toMatchObject([
      { region: "lumbar", techniqueCode: "funzionale", copied: true, check: { kind: "ok" } },
    ]);
    expect(r.copied?.closing.blocking.map((b) => b.code)).toEqual(["copiati"]);

    expect(r.revoked?.consentRevoked).toBe(true);

    // La prima visita chiusa: in sola lettura, nessuna copia offerta, la chiusura letta come in rettifica.
    expect(r.closedFirst?.visit.status).toBe("closed");
    expect(r.closedFirst?.copy).toEqual({ available: false, label: null });
    expect(r.closedFirst?.screening.noChange).toBeNull();
    expect(r.closedFirst?.cycle.isFirstVisit).toBe(true);
    expect(r.closedFirst?.cycle.opening).toMatchObject({ mainRegion: "lumbar", expectedSessions: 4 });

    expect(r.otherPatient).toBeNull();
  });

  it("gruppi e «Per chiudere» sono quelli del server: la regione principale cervicale dopo la conferma riapre lo screening", async () => {
    const r = await inUserA(db, async (tx) => {
      await clinicalSettings(tx);
      const patientId = await newPatient(tx, "Marco", "Bellandi");
      const cycleId = await cycle(tx, patientId, "2026-11-04", "Nuovo ciclo, novembre 2026");
      const visitId = await visitOn(tx, patientId, cycleId, "2026-11-04", "confermato", "08:00");
      await opening(tx, cycleId, "lumbar", clock);
      await noOthers(tx, visitId, ALWAYS);
      await run(tx, visitId, outcomes("indicated", "indicated", "indicated"));
      const before = await getVisitEditor(tx, PRACTICE_A, clock, patientId, visitId);
      await opening(tx, cycleId, "cervical", clock);
      const after = await getVisitEditor(tx, PRACTICE_A, clock, patientId, visitId);
      const refusal = await rejectionOf(closeVisit(tx, PRACTICE_A, clock, { visitId, confirmCopied: false, alsoMarkDone: false }));
      return { before, after, refusal };
    });
    expect(r.before?.screening.groups.map((g) => g.code)).toEqual([...ALWAYS]);
    expect(r.before?.closing.blocking).toEqual([]);
    expect(r.after?.screening.groups.map((g) => g.code)).toEqual([...ALWAYS, CERVICAL_GROUP]);
    expect(r.after?.screening.groups[3]?.items.every((i) => i.answer === null)).toBe(true);
    // Gli esiti salvati restano, ma la visita non chiude: l'editor lo dice come il comando.
    expect(r.after?.screening.pills).toHaveLength(3);
    expect(r.after?.visit.screeningConfirmed).toBe(false);
    expect(r.after?.closing.blocking.map((b) => b.text)).toEqual(["Conferma lo screening."]);
    expect(isDomainError(r.refusal)).toBe(true);
    expect((r.refusal as Error).message).toBe("Conferma lo screening.");
  });

  it("una gravidanza di oggi: la visita chiusa prima non mostra né chiede il gruppo, la bozza di oggi sì", async () => {
    const r = await inUserA(db, async (tx) => {
      await clinicalSettings(tx);
      const patientId = await newPatient(tx, "Sara", "Neri", "1992-04-10");
      const cycleId = await cycle(tx, patientId, "2026-10-20", "Lombalgia, ottobre 2026");
      const closedId = await closedFirstVisit(tx, patientId, cycleId, "2026-10-20", {
        mainRegion: "lumbar",
        pain: [6, 3],
        techniques: ["lumbar"],
      });
      await saveLifestyle(tx, PRACTICE_A, clock, {
        patientId,
        reviewedOn: "2026-11-04",
        occupation: null,
        sport: null,
        familyHistory: null,
        pregnancyStatus: "in_corso",
        pregnancyWeeks: 12,
      });
      const draftId = await visitOn(tx, patientId, cycleId, "2026-11-04", "confermato", "08:00");
      await noOthers(tx, draftId, ALWAYS);
      const refusal = await rejectionOf(run(tx, draftId, outcomes("indicated", "indicated", "indicated")));
      return {
        closed: await getVisitEditor(tx, PRACTICE_A, clock, patientId, closedId),
        draft: await getVisitEditor(tx, PRACTICE_A, clock, patientId, draftId),
        refusal,
      };
    });
    expect(r.closed?.patient.pregnancyInProgress).toBe(true);
    expect(r.closed?.screening.groups.map((g) => g.code)).toEqual([...ALWAYS]);
    expect(r.closed?.screening.positionNote).toBeNull();
    expect(r.closed?.visit.screeningConfirmed).toBe(true);
    expect(r.closed?.closing.blocking).toEqual([]);

    expect(r.draft?.screening.groups.map((g) => g.code)).toEqual([...ALWAYS, "rf_gravidanza"]);
    expect(r.draft?.screening.positionNote).toBe(PREGNANCY_POSITION_NOTE);
    expect(r.draft?.closing.blocking.map((b) => b.code)).toEqual(["screening"]);
    // Il server chiede lo stesso gruppo: senza risposte lì la conferma non passa.
    expect(isDomainError(r.refusal)).toBe(true);
    expect((r.refusal as Error).message).toBe('Rispondi a ogni voce o premi "Nessun\'altra voce".');
  });

  it("tecniche con l'approccio a scelta: vale l'approccio meno restrittivo, e ogni approccio ha il suo blocco come sul server", async () => {
    const r = await inUserA(db, async (tx) => {
      await clinicalSettings(tx);
      const patientId = await newPatient(tx, "Elio", "Conti");
      const cycleId = await cycle(tx, patientId, "2026-11-04", "Lombalgia, novembre 2026");
      const visitId = await visitOn(tx, patientId, cycleId, "2026-11-04", "confermato", "08:00");
      await run(tx, visitId, { op: "risposta", itemCode: "ci_avk", answer: "si" });
      await noOthers(tx, visitId, ALWAYS);
      // Solo le dirette (e il thrust che le eredita) controindicate.
      await run(tx, visitId, outcomes("contraindicated", "contraindicated", "indicated"));
      const editor = await getVisitEditor(tx, PRACTICE_A, clock, patientId, visitId);
      const fascialDirect = await rejectionOf(
        run(tx, visitId, { op: "tecnica", region: "lumbar", techniqueCode: "fasciale", approach: "direct" }),
      );
      const cranialDirect = await rejectionOf(
        run(tx, visitId, { op: "tecnica", region: "lumbar", techniqueCode: "craniale", approach: "direct" }),
      );
      await run(tx, visitId, { op: "tecnica", region: "lumbar", techniqueCode: "fasciale", approach: "indirect" });
      return { editor, fascialDirect, cranialDirect };
    });
    const e = r.editor;
    expect(e?.techniqueChecks.lumbar.fasciale.kind).toBe("ok");
    expect(e?.approachChecks.lumbar?.fasciale).toEqual({
      direct: {
        kind: "blocked",
        text: "Tecnica fasciale controindicata in questa visita: terapia anticoagulante. Cambia l'esito dello screening se hai nuove informazioni.",
      },
      indirect: { kind: "ok" },
    });
    expect(e?.approachChecks.lumbar?.craniale?.direct.kind).toBe("blocked");
    expect(e?.approachChecks.lumbar?.craniale?.indirect.kind).toBe("ok");
    // Le tecniche senza approccio a scelta non hanno la voce, e restano come prima.
    expect(e?.approachChecks.lumbar?.hvla).toBeUndefined();
    expect(e?.techniqueChecks.lumbar.tessuti_molli.kind).toBe("blocked");
    // Il server rifiuta gli stessi approcci con lo stesso testo e accetta l'indiretto.
    expect(isDomainError(r.fascialDirect)).toBe(true);
    expect((r.fascialDirect as Error).message).toBe(
      "Tecnica fasciale controindicata in questa visita: terapia anticoagulante. Cambia l'esito dello screening se hai nuove informazioni.",
    );
    expect(isDomainError(r.cranialDirect)).toBe(true);
    expect((r.cranialDirect as Error).message).toBe(
      "Tecnica craniale controindicata in questa visita: terapia anticoagulante. Cambia l'esito dello screening se hai nuove informazioni.",
    );
  });

  it("«Per chiudere» di una visita chiusa si legge in rettifica, come la controlla amendVisit", async () => {
    const r = await inUserA(db, async (tx) => {
      await clinicalSettings(tx);
      const patientId = await newPatient(tx, "Rita", "Sala", "1990-02-11");
      const cycleId = await cycle(tx, patientId, "2026-10-20", "Lombalgia, ottobre 2026");
      const visitId = await closedFirstVisit(tx, patientId, cycleId, "2026-10-20", {
        mainRegion: "lumbar",
        pain: [6, 3],
        techniques: ["lumbar"],
      });
      // Oggi la paziente è in gravidanza: in bozza il gruppo si chiederebbe, in rettifica no.
      await saveLifestyle(tx, PRACTICE_A, clock, {
        patientId,
        reviewedOn: "2026-11-04",
        occupation: null,
        sport: null,
        familyHistory: null,
        pregnancyStatus: "in_corso",
        pregnancyWeeks: 12,
      });
      const visit = await loadVisit(tx, PRACTICE_A, visitId);
      if (!visit) throw new Error("visita mancante");
      const asDraft = closingCheck(await closingFactsFor(tx, PRACTICE_A, visit, "bozza"));
      const asAmendment = closingCheck(await closingFactsFor(tx, PRACTICE_A, visit, "rettifica"));
      const editor = await getVisitEditor(tx, PRACTICE_A, clock, patientId, visitId);
      await amendVisit(tx, PRACTICE_A, clock, {
        visitId,
        reason: "Dolore a fine seduta scritto male",
        ops: [{ op: "campi", values: { nprsPost: 2 } }],
      });
      const amended = await getVisitEditor(tx, PRACTICE_A, clock, patientId, visitId);
      return { asDraft, asAmendment, editor, amended };
    });
    expect(r.asDraft.blocking.map((b) => b.code)).toEqual(["screening"]);
    expect(r.editor?.closing).toEqual(r.asAmendment);
    expect(r.editor?.closing.blocking).toEqual([]);
    // La rettifica passa: il server non trova bloccanti, come l'editor.
    expect(r.amended?.visit).toMatchObject({ amendedText: "Rettificata il 04/11/2026", fields: { nprsPost: 2 } });
    expect(r.amended?.closing.blocking).toEqual([]);
  });

  it("la variazione di un test ha la stessa misura di riferimento nell'editor e in «Test nel tempo», bozze comprese", async () => {
    const r = await inUserA(db, async (tx) => {
      await clinicalSettings(tx);
      const patientId = await newPatient(tx, "Ugo", "Ferri");
      const cycleId = await cycle(tx, patientId, "2026-10-27", "Lombalgia, ottobre 2026");
      const earlierDraft = await visitOn(tx, patientId, cycleId, "2026-10-27");
      await run(tx, earlierDraft, { op: "test", testCode: "dita_pavimento", valueNumeric: 30 }, clockOf("2026-10-27"));
      const today = await visitOn(tx, patientId, cycleId, "2026-11-04", "confermato", "08:00");
      await run(tx, today, { op: "test", testCode: "dita_pavimento", valueNumeric: 20 });
      return {
        editor: await getVisitEditor(tx, PRACTICE_A, clock, patientId, today),
        first: await getVisitEditor(tx, PRACTICE_A, clock, patientId, earlierDraft),
        table: await getTestsOverTime(tx, PRACTICE_A, patientId, { cycleId: null, region: null }),
      };
    });
    const change = r.editor?.tests.find((t) => t.testCode === "dita_pavimento")?.change;
    expect(change).toEqual({ text: "-10 cm", trend: "improved" });
    expect(r.table.rows[0]?.change).toEqual(change);
    // La prima misura del ciclo non ha una variazione; nessuna visita chiusa, quindi nessun valore precedente.
    expect(r.first?.tests[0]?.change).toBeNull();
    expect(r.editor?.tests[0]?.previousText).toBeNull();
  });

  it("i test si leggono come numeri (value_numeric::float8), non come la stringa di numeric", async () => {
    const editor = await inUserA(db, async (tx) => {
      const s = await taoPatient(tx);
      return getVisitEditor(tx, PRACTICE_A, clock, s.patientId, s.firstId);
    });
    const flexion = editor?.tests.find((t) => t.testCode === "flessione_rotazione");
    expect(flexion?.valueNumeric).toBe(28);
    expect(typeof flexion?.valueNumeric).toBe("number");
    // Nella prima visita del ciclo non c'è un valore precedente né una variazione.
    expect(flexion?.previousText).toBeNull();
    expect(flexion?.change).toBeNull();
  });

  it("come uB la visita di A non si legge, né con lo studio di B né con quello di A", async () => {
    const r = await inRollback(db, "B", async (tx) => ({
      own: await getVisitEditor(tx, PRACTICE_B, clock, PATIENT_A1, VISIT_A),
      other: await getVisitEditor(tx, PRACTICE_A, clock, PATIENT_A1, VISIT_A),
    }));
    expect(r).toEqual({ own: null, other: null });
  });
});
