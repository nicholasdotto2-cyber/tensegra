import { type CycleAppointment, sessionLabel, sessionPosition } from "@/lib/agenda/session-label";
import {
  ADVICE_TEMPLATES,
  type AdviceTemplate,
  type Approach,
  FAMILIES,
  type Family,
  type Outcome,
  PREGNANCY_POSITION_NOTE,
  REGION_CODES,
  type RegionCode,
  SCREENING_GROUPS,
  type ScreeningGroup,
  type ScreeningItem,
  type TechniqueCode,
  TECHNIQUES,
  testDefinition,
} from "@/lib/clinical/catalog";
import {
  type Change,
  changeFromFirst,
  formatPrevious,
  formatValue,
  type Measure,
  measureKey,
  severityChange,
} from "@/lib/clinical/compare";
import { VISIT_KIND_LABEL } from "@/lib/clinical/labels";
import {
  checkTreatment,
  type FamilySuggestion,
  pillText,
  type PromptCode,
  type ReferralPrompt,
  referralPrompts,
  type ScreeningAnswer,
  suggestOutcomes,
  type TreatmentCheck,
  visibleItems,
} from "@/lib/clinical/rules";
import { type ClosingCheck, closingCheck } from "@/lib/clinical/visit-rules";
import { age, dayField, dayLong, firstLast, isMinor } from "@/lib/format";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { amendedText, cycleMeasures, cyclePsfs, cycleVisitsInOrder } from "@/server/domain/cartella/queries";
import { cycleVisitAt, listCycleAppointments, openingVisitOf, relapseCandidate } from "@/server/domain/cycles/queries";
import { getHistory, type HistoryView, pregnancyInProgress } from "@/server/domain/history/queries";
import { prepareMessage } from "@/server/domain/messages/queries";
import { clinicalAlertText, patientBadges } from "@/server/domain/patients/card";
import { ageDay } from "@/server/domain/patients/list";
import { listPhysicians, type PhysicianOption } from "@/server/domain/physicians/queries";
import { getClinicalSettings } from "@/server/domain/settings/queries";
import { closingFactsFor } from "./commands";
import { loadScreeningState, loadVisit, screeningSource, treatmentConsentRevoked, type VisitRow } from "./ops";
import { loadAnswers, type OpMode, requiredGroups, visibility } from "./ops/screening";

// La vista dell'editor della visita:
// una lettura che ogni azione dell'editor restituisce dopo la scrittura, nella stessa transazione.
// L'editor mostra ciò che i comandi controllano, con le stesse funzioni: i gruppi dello screening da
// `visibility` (ops/screening.ts), il blocco delle tecniche da `checkTreatment` sugli esiti salvati
// (`loadScreeningState`), "Per chiudere" da `closingFactsFor` e `closingCheck` come `closeVisit` (in
// rettifica per una visita chiusa, come `amendVisit`), copia e "Nessuna variazione" da `screeningSource`
// e solo in bozza. Ogni SQL filtra lo studio anche oltre la RLS; una visita di un altro paziente o di un
// altro studio è null.

/** I campi della visita (`campi`), come li scrive `VisitFieldsInput`. */
export interface VisitFieldsView {
  location: "studio" | "domicilio" | "altro";
  othersPresent: string | null;
  othersPresentConsented: boolean | null;
  nprsPre: number | null;
  nprsPost: number | null;
  subjectiveUpdate: string | null;
  radiationSites: string[];
  radiationSide: "dx" | "sx" | "bilaterale" | null;
  treatmentResponse: "migliorato" | "invariato" | "peggiorato" | null;
  adverseReaction: "nessuna" | "lieve" | "moderata" | "grave" | null;
  adverseReactionNote: string | null;
  observationNote: string | null;
  workingHypothesis: string | null;
  planNext: string | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
}

/** I campi d'apertura del ciclo. */
export interface CycleOpeningView {
  chiefComplaint: string | null;
  mainRegion: RegionCode | null;
  /** "AAAA-MM-GG". */
  onsetOn: string | null;
  onsetMode: "acuto" | "graduale" | "post_traumatico" | "ricorrente" | null;
  medicalDiagnosisText: string | null;
  medicalDiagnosisSource: "referto_allegato" | "riferita_dal_paziente" | "assente";
  /** Il medico inviante salvato sul ciclo. */
  referringPhysicianId: string | null;
  /** Quello che il campo propone quando il ciclo non ne ha uno: `patients.default_referring_physician_id`. */
  proposedReferringPhysicianId: string | null;
  selfReferred: boolean;
  goal: string | null;
  expectedSessions: number | null;
  planNote: string | null;
  /** "AAAA-MM-GG": "Piano spiegato e accettato dal paziente". */
  planAgreedOn: string | null;
}

export interface EditorFinding {
  id: string;
  region: RegionCode;
  severity: number;
  tissueTexture: boolean;
  asymmetry: boolean;
  restriction: boolean;
  tenderness: boolean;
  side: "dx" | "sx" | "bilaterale" | "centrale" | null;
  segmentNote: string | null;
  isPrimary: boolean;
  copied: boolean;
}

export interface EditorTest {
  id: string;
  testCode: string;
  /** Il nome del catalogo, o l'etichetta del test libero. */
  name: string;
  customLabel: string | null;
  customUnit: string | null;
  side: "dx" | "sx" | null;
  valueBool: boolean | null;
  valueLateral: "neg" | "dx" | "sx" | "bil" | null;
  valueNumeric: number | null;
  valueOrdinal: number | null;
  painProvoked: boolean | null;
  note: string | null;
  copied: boolean;
  /** Il valore della visita chiusa più recente con lo stesso test e lato, in grigio ("28°"). */
  previousText: string | null;
  /** La variazione dalla prima misura del ciclo con lo stesso test e lato ("+10° dx"). */
  change: Change | null;
}

export interface EditorTreatment {
  id: string;
  region: RegionCode;
  techniqueCode: TechniqueCode;
  customTechnique: string | null;
  approach: Approach | null;
  family: Family;
  tolerance: "buona" | "fastidio" | "interrotta";
  response: "migliorato" | "invariato" | "peggiorato" | null;
  note: string | null;
  copied: boolean;
  /** Il blocco dello screening sulla riga, come in `closingFactsFor`. */
  check: TreatmentCheck;
}

export interface EditorAdvice {
  id: string;
  templateCode: string | null;
  text: string;
  communicatedVia: ("a_voce" | "foglio_stampato" | "messaggio_copiato")[];
}

/** "Confronta con": le disfunzioni di un'altra visita del ciclo e, per regione, la variazione fino a oggi. */
export interface CompareSet {
  label: string;
  findings: { region: RegionCode; severity: number; isPrimary: boolean; side: EditorFinding["side"] }[];
  changes: Partial<Record<RegionCode, Change>>;
}

export interface ScreeningGroupView {
  code: ScreeningGroup;
  label: string;
  items: { item: ScreeningItem; answer: ScreeningAnswer | null }[];
}

export interface SavedOutcome {
  suggested: Outcome;
  outcome: Outcome;
  overrideNote: string | null;
  localContraindicated: RegionCode[];
}

export interface VisitEditor {
  visit: {
    id: string;
    patientId: string;
    appointmentId: string;
    appointmentStatus: string;
    status: "draft" | "closed";
    /** "lunedì 2 novembre 2026". */
    dateText: string;
    /** "AAAA-MM-GG". */
    visitDate: string;
    kind: "prima_visita" | "seduta" | "controllo";
    kindLabel: string;
    amendedText: string | null;
    fields: VisitFieldsView;
    /** Lo screening confermato come lo legge la chiusura: esiti salvati e ogni voce visibile con una risposta. */
    screeningConfirmed: boolean;
  };
  patient: {
    /** "Nome Cognome". */
    name: string;
    /** L'età al giorno della visita. */
    ageText: string;
    minor: boolean;
    /** I mesi compiuti al giorno della visita, come li conta lo screening. */
    ageMonths: number;
    badges: string[];
    clinicalAlert: string | null;
    pregnancyInProgress: boolean;
  };
  cycle: {
    id: string;
    kind: "trattamento" | "mantenimento";
    status: "open" | "closed";
    title: string;
    /** "Seduta 2 di 4": la posizione dell'appuntamento nel ciclo. */
    sessionText: string | null;
    /** La prima visita del ciclo in ordine di data. */
    isFirstVisit: boolean;
    /**
     * La sezione A mostra l'apertura del ciclo (e la sezione E il piano accettato): alla prima visita, e alla visita chiusa
     * che la tiene quando una seduta precedente, compilata dopo, è diventata la prima.
     */
    showsOpening: boolean;
    /**
     * «L'apertura del ciclo si cambia con una rettifica della visita del 20/10/2026.»: nella prima visita per data che non
     * tiene l'apertura, quando la tiene una visita chiusa (in bozza, in lettura e in rettifica). L'apertura qui è in sola
     * lettura; null altrimenti.
     */
    openingLock: string | null;
    opening: CycleOpeningView;
    psfs: { id: string; activity: string; initial: number | null }[];
    /** "È una ricaduta di [titolo]?": solo alla prima visita in bozza, con la regione principale. */
    relapse: { id: string; title: string } | null;
  };
  history: HistoryView;
  screening: {
    groups: ScreeningGroupView[];
    suggestion: Record<Family, FamilySuggestion>;
    /** Gli esiti salvati; null finché lo screening non è confermato. */
    outcomes: Record<Family, SavedOutcome> | null;
    /** "Thrust: controindicato", ... dagli esiti salvati; vuote finché lo screening non è confermato. */
    pills: string[];
    /** "Nessuna variazione dal 15/10": solo in bozza e con una visita sorgente. */
    noChange: { label: string } | null;
    /** La riga di posizionamento accanto al gruppo gravidanza, quando è visibile. */
    positionNote: string | null;
  };
  findings: EditorFinding[];
  tests: EditorTest[];
  /**
   * Il valore precedente di ogni test e lato misurato in una visita chiusa prima di questa (`measureKey` → "28°"):
   * si legge in grigio anche sui test che oggi non hanno ancora una riga.
   */
  previousByKey: Record<string, string>;
  activeTestCodes: string[];
  treatments: EditorTreatment[];
  /**
   * Il blocco di ogni tecnica in ogni regione: per le tecniche con l'approccio a scelta quello dell'approccio
   * meno restrittivo, per le altre quello della loro famiglia.
   */
  techniqueChecks: Record<RegionCode, Record<TechniqueCode, TreatmentCheck>>;
  /** Per le tecniche con l'approccio a scelta, il blocco di ciascun approccio, come lo controlla `saveTechnique`. */
  approachChecks: Partial<Record<RegionCode, Partial<Record<TechniqueCode, Record<Approach, TreatmentCheck>>>>>;
  advice: EditorAdvice[];
  /** I modelli proposti: prima quelli della visita copiata, poi quelli delle regioni con disfunzioni o trattate. */
  suggestedAdvice: AdviceTemplate[];
  compare: { first: CompareSet | null; previous: CompareSet | null };
  prompts: ReferralPrompt[];
  closing: ClosingCheck;
  /** "Copia dalla visita precedente": c'è una visita sorgente e la visita è in bozza; `label` «del 15/10» o «dal ciclo precedente». */
  copy: { available: boolean; label: string | null };
  physicians: PhysicianOption[];
  consentRevoked: boolean;
  /**
   * «Copia il messaggio» dei consigli: i consigli da modello della visita e il consenso al canale
   * WhatsApp, come li controlla `recordMessage`; anche sulla visita chiusa in lettura, dove la copia rettifica da sé.
   */
  canCopyAdvice: boolean;
  /** Perché «Copia il messaggio» è fermo; null se si può. */
  adviceCopyReason: string | null;
}

const COMPARE_FIRST = "la prima visita del ciclo";
const COMPARE_PREVIOUS = "la visita precedente";
const OTHER_CYCLE = "dal ciclo precedente";
/** I promemoria accesi quando lo studio non ha ancora la riga delle impostazioni: il default della colonna. */
const DEFAULT_PROMPTS: readonly PromptCode[] = ["R1", "R2", "R3"];
const INFANT_MONTHS = 12;
const NO_ADVICE = "Spunta almeno un consiglio per preparare il messaggio.";

/** "15/10" da "AAAA-MM-GG". */
const dayMonth = (day: string): string => dayField(day).slice(0, 5);

/** La frase dell'apertura in sola lettura, con il giorno della visita chiusa che la tiene. */
const openingLockText = (day: string): string => `L'apertura del ciclo si cambia con una rettifica della visita del ${dayField(day)}.`;

interface DetailsRow extends VisitFieldsView, Omit<CycleOpeningView, "proposedReferringPhysicianId"> {
  appointmentStatus: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  clinicalAlert: string | null;
  defaultReferringPhysicianId: string | null;
  cycleKind: "trattamento" | "mantenimento";
  cycleStatus: "open" | "closed";
  cycleTitle: string;
  lastAmendedAt: Date | null;
}

/** La visita con i suoi campi, l'appuntamento, il paziente, il ciclo con i campi d'apertura e l'ultima rettifica. */
async function loadDetails(tx: Tx, practiceId: string, visit: VisitRow): Promise<DetailsRow | null> {
  const [row] = await tx.query<DetailsRow>(
    `select a.status as "appointmentStatus",
            v.location, v.others_present as "othersPresent", v.others_present_consented as "othersPresentConsented",
            v.nprs_pre as "nprsPre", v.nprs_post as "nprsPost", v.subjective_update as "subjectiveUpdate",
            v.radiation_sites as "radiationSites", v.radiation_side as "radiationSide",
            v.treatment_response as "treatmentResponse", v.adverse_reaction as "adverseReaction",
            v.adverse_reaction_note as "adverseReactionNote", v.observation_note as "observationNote",
            v.working_hypothesis as "workingHypothesis", v.plan_next as "planNext",
            v.bp_systolic as "bpSystolic", v.bp_diastolic as "bpDiastolic",
            p.first_name as "firstName", p.last_name as "lastName", p.birth_date as "birthDate",
            p.clinical_alert as "clinicalAlert",
            p.default_referring_physician_id as "defaultReferringPhysicianId",
            c.kind as "cycleKind", c.status as "cycleStatus", c.title as "cycleTitle",
            c.chief_complaint as "chiefComplaint", c.main_region as "mainRegion", c.onset_on as "onsetOn",
            c.onset_mode as "onsetMode", c.medical_diagnosis_text as "medicalDiagnosisText",
            c.medical_diagnosis_source as "medicalDiagnosisSource", c.referring_physician_id as "referringPhysicianId",
            c.self_referred as "selfReferred", c.goal, c.expected_sessions as "expectedSessions",
            c.plan_note as "planNote", c.plan_agreed_on as "planAgreedOn",
            (select max(m.amended_at) from public.visit_amendments m
              where m.practice_id = v.practice_id and m.visit_id = v.id) as "lastAmendedAt"
       from public.visits v
       join public.appointments a on a.practice_id = v.practice_id and a.id = v.appointment_id
       join public.patients p on p.practice_id = v.practice_id and p.id = v.patient_id
       join public.treatment_cycles c on c.practice_id = v.practice_id and c.id = v.cycle_id
      where v.practice_id = $1 and v.id = $2`,
    [practiceId, visit.id],
  );
  return row ?? null;
}

function fieldsOf(d: DetailsRow): VisitFieldsView {
  return {
    location: d.location,
    othersPresent: d.othersPresent,
    othersPresentConsented: d.othersPresentConsented,
    nprsPre: d.nprsPre,
    nprsPost: d.nprsPost,
    subjectiveUpdate: d.subjectiveUpdate,
    radiationSites: d.radiationSites,
    radiationSide: d.radiationSide,
    treatmentResponse: d.treatmentResponse,
    adverseReaction: d.adverseReaction,
    adverseReactionNote: d.adverseReactionNote,
    observationNote: d.observationNote,
    workingHypothesis: d.workingHypothesis,
    planNext: d.planNext,
    bpSystolic: d.bpSystolic,
    bpDiastolic: d.bpDiastolic,
  };
}

function openingOf(d: DetailsRow): CycleOpeningView {
  return {
    chiefComplaint: d.chiefComplaint,
    mainRegion: d.mainRegion,
    onsetOn: d.onsetOn,
    onsetMode: d.onsetMode,
    medicalDiagnosisText: d.medicalDiagnosisText,
    medicalDiagnosisSource: d.medicalDiagnosisSource,
    referringPhysicianId: d.referringPhysicianId,
    proposedReferringPhysicianId: d.defaultReferringPhysicianId,
    selfReferred: d.selfReferred,
    goal: d.goal,
    expectedSessions: d.expectedSessions,
    planNote: d.planNote,
    planAgreedOn: d.planAgreedOn,
  };
}

// Screening ------------------------------------------------------------------------------------------

async function screeningView(
  tx: Tx,
  practiceId: string,
  visit: VisitRow,
  answers: readonly ScreeningAnswer[],
  mode: OpMode,
): Promise<{ groups: ScreeningGroupView[]; ageMonths: number }> {
  // Gli stessi gruppi che i comandi chiedono (`requiredGroups`): un gruppo con risposte
  // salvate resta visibile, una voce fuori età non compare (le sue risposte il comando le rifiuta), e in
  // rettifica la gravidanza o il pediatrico di oggi non compaiono su una visita che non li aveva.
  const v = await visibility(tx, practiceId, visit, answers);
  const answerOf = new Map(answers.map((a) => [a.itemCode, a]));
  return {
    ageMonths: v.ageMonths,
    groups: requiredGroups(v, answers, mode).map((code) => ({
      code,
      label: SCREENING_GROUPS.find((g) => g.code === code)?.label ?? code,
      items: visibleItems(code, v.ageMonths).map((item) => ({ item, answer: answerOf.get(item.code) ?? null })),
    })),
  };
}

async function savedOutcomes(tx: Tx, practiceId: string, visitId: string): Promise<Record<Family, SavedOutcome> | null> {
  const rows = await tx.query<SavedOutcome & { family: Family }>(
    `select family, suggested, outcome, override_note as "overrideNote",
            local_contraindicated_regions as "localContraindicated"
       from public.visit_screening_outcomes
      where practice_id = $1 and visit_id = $2`,
    [practiceId, visitId],
  );
  const byFamily: Partial<Record<Family, SavedOutcome>> = {};
  for (const { family, ...outcome } of rows) byFamily[family] = outcome;
  return FAMILIES.every((f) => byFamily[f] !== undefined) ? (byFamily as Record<Family, SavedOutcome>) : null;
}

// Righe della visita -----------------------------------------------------------------------------------

function loadFindings(tx: Tx, practiceId: string, visitIds: readonly string[]) {
  return tx.query<EditorFinding & { visitId: string }>(
    `select id, visit_id as "visitId", region, severity, tissue_texture as "tissueTexture", asymmetry, restriction,
            tenderness, side, segment_note as "segmentNote", is_primary as "isPrimary", copied
       from public.visit_region_findings
      where practice_id = $1 and visit_id = any($2::uuid[])
      order by array_position(app.region_codes(), region), id`,
    [practiceId, [...visitIds]],
  );
}

type TestRow = Omit<EditorTest, "name" | "previousText" | "change"> & { visitId: string; visitDate: string };

function loadTests(tx: Tx, practiceId: string, visitIds: readonly string[]) {
  return tx.query<TestRow>(
    `select r.id, r.visit_id as "visitId", v.visit_date as "visitDate", r.test_code as "testCode",
            r.custom_label as "customLabel", r.custom_unit as "customUnit", r.side,
            r.value_bool as "valueBool", r.value_lateral as "valueLateral",
            r.value_numeric::float8 as "valueNumeric", r.value_ordinal as "valueOrdinal",
            r.pain_provoked as "painProvoked", r.note, r.copied
       from public.visit_test_results r
       join public.visits v on v.practice_id = r.practice_id and v.id = r.visit_id
      where r.practice_id = $1 and r.visit_id = any($2::uuid[])
      order by r.test_code, r.side nulls first, r.id`,
    [practiceId, [...visitIds]],
  );
}

/** Le visite chiuse del paziente prima di questa, per giorno e orario come `screeningSource`, dalla più vecchia. */
function earlierClosedVisits(tx: Tx, practiceId: string, visitId: string) {
  return tx.query<{ id: string; cycleId: string }>(
    `select v.id, v.cycle_id as "cycleId"
       from public.visits cur
       join public.appointments ca on ca.practice_id = cur.practice_id and ca.id = cur.appointment_id
       join public.visits v on v.practice_id = cur.practice_id and v.patient_id = cur.patient_id
       join public.appointments a on a.practice_id = v.practice_id and a.id = v.appointment_id
      where cur.practice_id = $1 and cur.id = $2
        and v.id <> cur.id and v.status = 'closed'
        and (v.visit_date, a.starts_at) < (cur.visit_date, ca.starts_at)
      order by v.visit_date, a.starts_at, v.id`,
    [practiceId, visitId],
  );
}

function testName(t: { testCode: string; customLabel: string | null }): string {
  return testDefinition(t.testCode)?.name ?? (t.customLabel ?? "").trim();
}

/**
 * Il valore precedente (la misura più recente con lo stesso test e lato fra le visite chiuse del paziente
 * prima di questa) e la variazione dalla prima misura del ciclo, bozze comprese (`changeFromFirst`). Il valore
 * precedente di ogni test misurato si dà anche per chiave (`previousByKey`), per i test che oggi non hanno una riga.
 */
function withHistory(
  current: readonly TestRow[],
  earlier: readonly TestRow[],
  earlierVisits: readonly { id: string; cycleId: string }[],
  cycle: { order: readonly string[]; measures: readonly Measure[] },
): { tests: EditorTest[]; previousByKey: Record<string, string> } {
  const order = new Map(earlierVisits.map((v, i) => [v.id, i]));
  const measured = earlier
    .filter((m) => formatValue(m) !== null)
    .sort((a, b) => (order.get(a.visitId) ?? 0) - (order.get(b.visitId) ?? 0));
  const latest = new Map<string, Measure>();
  for (const m of measured) latest.set(measureKey(m), m);
  const previousByKey: Record<string, string> = {};
  for (const [key, m] of latest) previousByKey[key] = formatPrevious(m) ?? "";
  const tests = current.map((t): EditorTest => {
    const previous = latest.get(measureKey(t));
    return {
      id: t.id,
      testCode: t.testCode,
      name: testName(t),
      customLabel: t.customLabel,
      customUnit: t.customUnit,
      side: t.side,
      valueBool: t.valueBool,
      valueLateral: t.valueLateral,
      valueNumeric: t.valueNumeric,
      valueOrdinal: t.valueOrdinal,
      painProvoked: t.painProvoked,
      note: t.note,
      copied: t.copied,
      previousText: previous ? formatPrevious(previous) : null,
      change: changeFromFirst(cycle.order, cycle.measures, t),
    };
  });
  return { tests, previousByKey };
}

function compareSet(
  label: string,
  visitId: string | undefined,
  findings: readonly (EditorFinding & { visitId: string })[],
  today: readonly EditorFinding[],
): CompareSet | null {
  if (visitId === undefined) return null;
  const other = findings.filter((f) => f.visitId === visitId);
  const before = new Map(other.map((f) => [f.region, f.severity]));
  const after = new Map(today.map((f) => [f.region, f.severity]));
  const changes: Partial<Record<RegionCode, Change>> = {};
  for (const region of REGION_CODES) {
    if (!before.has(region) && !after.has(region)) continue;
    changes[region] = severityChange(before.get(region) ?? null, after.get(region) ?? null);
  }
  return {
    label,
    findings: other.map((f) => ({ region: f.region, severity: f.severity, isPrimary: f.isPrimary, side: f.side })),
    changes,
  };
}

/**
 * I modelli di consiglio proposti: in testa, non spuntati, quelli della visita copiata; poi
 * quelli per tutte le regioni e quelli che toccano una regione con disfunzione o trattata, nell'ordine del
 * catalogo. Il modello del lattante solo sotto 12 mesi.
 */
function suggestAdvice(regions: ReadonlySet<RegionCode>, sourceCodes: ReadonlySet<string>, ageMonths: number): AdviceTemplate[] {
  const eligible = ADVICE_TEMPLATES.filter((t) => !t.infantOnly || ageMonths < INFANT_MONTHS);
  const head = eligible.filter((t) => sourceCodes.has(t.code));
  const rest = eligible.filter(
    (t) => !sourceCodes.has(t.code) && (t.regions === "all" || t.regions.some((r) => regions.has(r))),
  );
  return [...head, ...rest];
}

type ScreeningStateOrNull = Awaited<ReturnType<typeof loadScreeningState>>;

const APPROACHES: readonly Approach[] = ["direct", "indirect"];
const CHECK_RANK: Record<TreatmentCheck["kind"], number> = { ok: 0, caution: 1, blocked: 2 };

/**
 * Il blocco di ogni approccio delle tecniche con l'approccio a scelta (fasciale, craniale, viscerale, Still,
 * altra), con gli stessi dati di `saveTechnique`: la tecnica, la regione, l'approccio e gli esiti salvati.
 */
function approachChecks(state: ScreeningStateOrNull): VisitEditor["approachChecks"] {
  return Object.fromEntries(
    REGION_CODES.map((region) => [
      region,
      Object.fromEntries(
        TECHNIQUES.filter((t) => t.variableApproach).map((t) => [
          t.code,
          Object.fromEntries(
            APPROACHES.map((approach) => [
              approach,
              checkTreatment({ region, techniqueCode: t.code, approach, customTechnique: null }, state),
            ]),
          ),
        ]),
      ),
    ]),
  ) as VisitEditor["approachChecks"];
}

/**
 * Il blocco di ogni tecnica in ogni regione. Per una tecnica con l'approccio a scelta vale l'approccio meno
 * restrittivo che il server accetterebbe (ok, poi con cautela, poi bloccato): l'interruttore si accende se
 * almeno un approccio passa, e `approachChecks` dice quale.
 */
function techniqueChecks(state: ScreeningStateOrNull, byApproach: VisitEditor["approachChecks"]): VisitEditor["techniqueChecks"] {
  return Object.fromEntries(
    REGION_CODES.map((region) => [
      region,
      Object.fromEntries(
        TECHNIQUES.map((t) => {
          const choices = byApproach[region]?.[t.code];
          if (choices) {
            const best = APPROACHES.map((a) => choices[a]).reduce((x, y) => (CHECK_RANK[y.kind] < CHECK_RANK[x.kind] ? y : x));
            return [t.code, best];
          }
          return [t.code, checkTreatment({ region, techniqueCode: t.code, approach: null, customTechnique: null }, state)];
        }),
      ),
    ]),
  ) as VisitEditor["techniqueChecks"];
}

async function nprsPreOf(tx: Tx, practiceId: string, visitId: string): Promise<number | null> {
  const [row] = await tx.query<{ nprsPre: number | null }>(
    'select nprs_pre as "nprsPre" from public.visits where practice_id = $1 and id = $2',
    [practiceId, visitId],
  );
  return row?.nprsPre ?? null;
}

/** La vista dell'editor della visita `visitId` del paziente `patientId`; null se non c'è o non è sua. */
export async function getVisitEditor(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  patientId: string,
  visitId: string,
): Promise<VisitEditor | null> {
  const visit = await loadVisit(tx, practiceId, visitId);
  if (!visit || visit.patientId !== patientId) return null;
  const d = await loadDetails(tx, practiceId, visit);
  if (!d) return null;
  const draft = visit.status === "draft";
  const mode = draft ? "bozza" : "rettifica";

  // Screening e blocchi, con le funzioni dei comandi.
  const answers = await loadAnswers(tx, practiceId, visit.id);
  const { groups, ageMonths } = await screeningView(tx, practiceId, visit, answers, mode);
  const state = await loadScreeningState(tx, practiceId, visit.id);
  const outcomes = state ? await savedOutcomes(tx, practiceId, visit.id) : null;
  const facts = await closingFactsFor(tx, practiceId, visit, mode);
  const source = await screeningSource(tx, practiceId, visit);

  // Ciclo.
  const appointments: CycleAppointment[] = await listCycleAppointments(tx, practiceId, visit.cycleId);
  const position = sessionPosition(visit.appointmentId, appointments);
  const firstOfCycle = await cycleVisitAt(tx, practiceId, visit.cycleId, "first");
  const isFirstVisit = firstOfCycle?.id === visit.id;
  const holder = await openingVisitOf(tx, practiceId, visit.cycleId);
  const holdsOpening = holder?.id === visit.id;
  const openingLock =
    isFirstVisit && !holdsOpening && holder?.status === "closed" ? openingLockText(holder.visitDate) : null;
  const relapse =
    draft && holdsOpening && d.cycleStatus === "open" && d.mainRegion !== null
      ? await relapseCandidate(tx, practiceId, clock, visit.cycleId, d.mainRegion)
      : null;

  // Righe di oggi e delle visite chiuse prima di questa.
  const earlier = await earlierClosedVisits(tx, practiceId, visit.id);
  const earlierInCycle = earlier.filter((v) => v.cycleId === visit.cycleId);
  const findingRows = await loadFindings(tx, practiceId, [visit.id, ...earlierInCycle.map((v) => v.id)]);
  const findings = findingRows
    .filter((f) => f.visitId === visit.id)
    .map(
      (f): EditorFinding => ({
        id: f.id,
        region: f.region,
        severity: f.severity,
        tissueTexture: f.tissueTexture,
        asymmetry: f.asymmetry,
        restriction: f.restriction,
        tenderness: f.tenderness,
        side: f.side,
        segmentNote: f.segmentNote,
        isPrimary: f.isPrimary,
        copied: f.copied,
      }),
    );
  const testRows = await loadTests(tx, practiceId, [visit.id, ...earlier.map((v) => v.id)]);
  const { tests, previousByKey } = withHistory(
    testRows.filter((t) => t.visitId === visit.id),
    testRows.filter((t) => t.visitId !== visit.id),
    earlier,
    {
      order: (await cycleVisitsInOrder(tx, practiceId, visit.cycleId)).map((v) => v.id),
      measures: await cycleMeasures(tx, practiceId, visit.cycleId),
    },
  );
  const treatmentRows = await tx.query<Omit<EditorTreatment, "check">>(
    `select id, region, technique_code as "techniqueCode", custom_technique as "customTechnique", approach, family,
            tolerance, response, note, copied
       from public.visit_treatments
      where practice_id = $1 and visit_id = $2
      order by array_position(app.region_codes(), region), technique_code, id`,
    [practiceId, visit.id],
  );
  const treatments = treatmentRows.map((t) => ({ ...t, check: checkTreatment(t, state) }));
  const advice = await tx.query<EditorAdvice>(
    `select id, template_code as "templateCode", text, communicated_via as "communicatedVia"
       from public.visit_advice
      where practice_id = $1 and visit_id = $2
      order by template_code, id`,
    [practiceId, visit.id],
  );
  const sourceAdvice =
    visit.copiedFromVisitId === null
      ? []
      : await tx.query<{ templateCode: string | null }>(
          'select template_code as "templateCode" from public.visit_advice where practice_id = $1 and visit_id = $2',
          [practiceId, visit.copiedFromVisitId],
        );

  // I motivi del server che valgono per ogni testo (consenso, modello salvato non valido), non la lunghezza: il testo
  // si accorcia nel compositore.
  const adviceIds = advice.flatMap((a) => (a.templateCode === null ? [] : [a.id]));
  const adviceMessage =
    adviceIds.length === 0
      ? null
      : await prepareMessage(tx, practiceId, clock, { kind: "visit", visitId: visit.id, adviceIds, templateKey: "consigli" });
  const adviceCopyReason =
    adviceMessage === null
      ? NO_ADVICE
      : adviceMessage.copyDisabledCode === "non_ammesso"
        ? adviceMessage.copyDisabledReason
        : null;

  const settings = await getClinicalSettings(tx, practiceId);
  const firstNprsPre = firstOfCycle === null ? null : await nprsPreOf(tx, practiceId, firstOfCycle.id);
  const day = ageDay(d.birthDate, visit.visitDate);
  const byApproach = approachChecks(state);
  const touched = new Set<RegionCode>([...findings.map((f) => f.region), ...treatments.map((t) => t.region)]);

  return {
    visit: {
      id: visit.id,
      patientId: visit.patientId,
      appointmentId: visit.appointmentId,
      appointmentStatus: d.appointmentStatus,
      status: visit.status,
      dateText: dayLong(visit.visitDate),
      visitDate: visit.visitDate,
      kind: visit.kind as VisitEditor["visit"]["kind"],
      kindLabel: VISIT_KIND_LABEL[visit.kind as VisitEditor["visit"]["kind"]],
      amendedText: amendedText(d.lastAmendedAt),
      fields: fieldsOf(d),
      screeningConfirmed: facts.screeningConfirmed,
    },
    patient: {
      name: firstLast(d),
      ageText: age(d.birthDate, day),
      minor: isMinor(d.birthDate, day),
      ageMonths,
      badges: await patientBadges(tx, practiceId, visit.patientId),
      clinicalAlert: clinicalAlertText(d.clinicalAlert),
      pregnancyInProgress: await pregnancyInProgress(tx, practiceId, visit.patientId),
    },
    cycle: {
      id: visit.cycleId,
      kind: d.cycleKind,
      status: d.cycleStatus,
      title: d.cycleTitle,
      sessionText: sessionLabel(position, d.expectedSessions),
      isFirstVisit,
      showsOpening: isFirstVisit || holdsOpening,
      openingLock,
      opening: openingOf(d),
      psfs: await cyclePsfs(tx, practiceId, visit.cycleId),
      relapse,
    },
    history: await getHistory(tx, practiceId, visit.patientId),
    screening: {
      groups,
      suggestion: suggestOutcomes(answers),
      outcomes,
      pills: state ? FAMILIES.map((f) => pillText(f, state.outcomes[f].outcome)) : [],
      noChange: draft && source ? { label: `Nessuna variazione dal ${dayMonth(source.visitDate)}` } : null,
      positionNote: groups.some((g) => g.code === "rf_gravidanza") ? PREGNANCY_POSITION_NOTE : null,
    },
    findings,
    tests,
    previousByKey,
    activeTestCodes: settings?.activeTestCodes ?? [],
    treatments,
    techniqueChecks: techniqueChecks(state, byApproach),
    approachChecks: byApproach,
    advice,
    suggestedAdvice: suggestAdvice(
      touched,
      new Set(sourceAdvice.flatMap((a) => (a.templateCode === null ? [] : [a.templateCode]))),
      ageMonths,
    ),
    compare: {
      first: compareSet(COMPARE_FIRST, earlierInCycle[0]?.id, findingRows, findings),
      previous: compareSet(COMPARE_PREVIOUS, earlierInCycle[earlierInCycle.length - 1]?.id, findingRows, findings),
    },
    prompts: referralPrompts({
      enabled: settings?.referralPrompts ?? DEFAULT_PROMPTS,
      answers,
      cycleKind: d.cycleKind,
      expectedSessions: d.expectedSessions,
      sessionNumber: position,
      firstNprsPre,
      todayNprsPre: d.nprsPre,
      isFirstVisitOfCycle: isFirstVisit,
    }),
    closing: closingCheck(facts),
    copy: {
      available: draft && source !== null,
      label: draft && source ? (source.otherCycle ? OTHER_CYCLE : `del ${dayMonth(source.visitDate)}`) : null,
    },
    physicians: await listPhysicians(tx, practiceId),
    consentRevoked: await treatmentConsentRevoked(tx, practiceId, visit),
    canCopyAdvice: adviceCopyReason === null,
    adviceCopyReason,
  };
}
