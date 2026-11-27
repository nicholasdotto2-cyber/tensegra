import {
  ADVICE_TEMPLATES,
  FAMILIES,
  type Family,
  type Outcome,
  REGION_CODES,
  REGION_LABEL,
  type RegionCode,
  SCREENING_GROUPS,
  screeningItem,
  type TechniqueCode,
  technique,
  testDefinition,
} from "@/lib/clinical/catalog";
import { measureKey } from "@/lib/clinical/compare";
import { AMEND_TARGET_TWICE } from "@/lib/clinical/labels";
import { pillText, type ScreeningAnswer, techniqueFamily } from "@/lib/clinical/rules";
import type {
  EditorAdvice,
  EditorFinding,
  EditorTest,
  EditorTreatment,
  SavedOutcome,
  VisitEditor,
} from "@/server/domain/visits/editor";

import {
  type AmendOp,
  type AmendRows,
  adviceRowOf,
  amendTargets,
  definedKeys,
  familyOf,
  mainTarget,
  testTarget,
  treatmentTarget,
} from "./amend-targets";
import { techniqueSwitchName } from "./treatment-row";

// La lista delle modifiche di una rettifica, senza React: l'editor la tiene nel
// client finché «Salva la rettifica» non la manda tutta con `amendVisitAction`, e i test unitari la provano da sola.
//
// - Le chiavi delle voci sono quelle del server (`amend-targets.ts`, lo stesso modulo di `requireUniqueTargets`).
// - Un'operazione che riscrive la stessa riga (stessa famiglia, stessa riga: `mainTarget`) sostituisce quella di prima,
//   e va in fondo. Ogni altra sovrapposizione (la primaria, la regione che la perde, il gruppo di «Nessun'altra
//   voce») si rifiuta con la frase del server, perché il server non saprebbe comporle e scartare in silenzio una
//   modifica clinica non è ammesso. Un'eccezione: una regione resa primaria dopo
//   un'altra resa primaria nella stessa rettifica riscrive l'operazione di prima senza la primaria.
// - I campi della visita (`campi`) e quelli d'apertura (`apertura`) stanno in una sola operazione ciascuno.
// - Una riga nuova della rettifica ha un id provvisorio (`pendingId`): toglierla toglie la sua operazione dalla lista.
// - `applyAmendOps` mostra la lista sulla vista (campi, apertura, PSFS, risposte ed esiti dello screening,
//   disfunzioni, test, tecniche, consigli), così ogni sezione legge le modifiche in attesa; le parti calcolate dal
//   server (gruppi visibili, blocchi delle tecniche, "Per chiudere") restano quelle della visita chiusa fino al
//   salvataggio, che le ricontrolla tutte.

export type { AmendOp };

const PENDING_PREFIX = "in-attesa:";

/** L'id provvisorio di una riga nata nella rettifica: la chiave della sua riga. */
export const pendingId = (target: string): string => `${PENDING_PREFIX}${target}`;
/** L'id provvisorio del consiglio di un modello spuntato nella rettifica e non ancora salvato. */
export const pendingAdviceId = (templateCode: string): string => pendingId(`consiglio-modello:${templateCode}`);
export const isPendingId = (id: string): boolean => id.startsWith(PENDING_PREFIX);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Un'operazione che le sezioni hanno passato a `op`; null se non è un oggetto con il suo nome. */
export function toAmendOp(value: unknown): AmendOp | null {
  if (!isRecord(value) || typeof value.op !== "string") return null;
  return value as AmendOp;
}

export { amendTargets };

/** Il risultato di `mergeAmendOp`: la lista nuova, o la frase del rifiuto. */
export type MergeResult = { ok: true; list: AmendOp[] } | { ok: false; message: string };

/** L'id che un'operazione «togli» porta, per le righe che hanno un id. */
const REMOVED_ID: Readonly<Record<string, string>> = {
  togli_test: "resultId",
  togli_tecnica: "treatmentId",
  togli_consiglio: "adviceId",
};

/** Una riga nata nella rettifica che si toglie: la riga delle operazioni da togliere dalla lista, o null. */
function pendingRemoval(op: AmendOp, base: AmendRows): string | null {
  const field = REMOVED_ID[op.op];
  if (field !== undefined) {
    const id = text(op[field]) ?? "";
    return isPendingId(id) ? id.slice(PENDING_PREFIX.length) : null;
  }
  if (op.op === "togli_disfunzione" && !base.findings.some((f) => f.region === op.region)) {
    return `disfunzione:${text(op.region) ?? ""}`;
  }
  return null;
}

/** Senza la chiave `key`. */
function without(op: AmendOp, key: string): AmendOp {
  return Object.fromEntries(Object.entries(op).filter(([k]) => k !== key)) as AmendOp;
}

/** I campi e l'apertura si sommano a quelli già nella lista: la scelta dopo vince. */
function combine(earlier: AmendOp, op: AmendOp): AmendOp {
  if (op.op === "campi") {
    const before = isRecord(earlier.values) ? earlier.values : {};
    const after = isRecord(op.values) ? op.values : {};
    return { op: "campi", values: { ...before, ...after } };
  }
  return { ...earlier, ...op };
}

/**
 * La lista con l'operazione `op`: in fondo, al posto di quella che riscriveva la stessa riga; rifiutata se tocca una
 * voce di un'altra operazione della lista. Una riga nata nella rettifica e tolta esce dalla lista senza lasciare niente.
 */
export function mergeAmendOp(list: readonly AmendOp[], op: AmendOp, base: AmendRows): MergeResult {
  const removed = pendingRemoval(op, base);
  if (removed !== null) return { ok: true, list: list.filter((o) => mainTarget(o, base) !== removed) };

  let next = op.op === "consiglio" && isPendingId(text(op.adviceId) ?? "") ? without(op, "adviceId") : op;
  let rest = [...list];
  if (next.op === "campi" || next.op === "apertura") {
    const earlier = rest.find((o) => o.op === next.op);
    if (earlier !== undefined) {
      next = combine(earlier, next);
      rest = rest.filter((o) => o !== earlier);
    }
  }
  const family = familyOf(next);
  const main = mainTarget(next, base);
  rest = rest.filter((o) => !(familyOf(o) === family && mainTarget(o, base) === main));

  if (next.op === "disfunzione" && next.isPrimary === true) {
    // Y primaria e poi Z primaria: Y resta con la sua modifica, senza la primaria (non era la primaria di prima).
    const before = base.findings.find((f) => f.isPrimary)?.region;
    rest = rest.map((o) =>
      o.op === "disfunzione" && o.isPrimary === true && o.region !== next.region && o.region !== before
        ? { ...o, isPrimary: false }
        : o,
    );
  }

  const keys = new Set(amendTargets(next, base));
  if (rest.some((o) => amendTargets(o, base).some((k) => keys.has(k)))) return { ok: false, message: AMEND_TARGET_TWICE };
  return { ok: true, list: [...rest, next] };
}

/** Le voci cambiate della lista, per «3 modifiche da salvare»: ogni campo della visita o d'apertura conta da solo. */
export function amendCount(list: readonly AmendOp[]): number {
  return list.reduce((sum, op) => {
    if (op.op === "campi") return sum + (isRecord(op.values) ? definedKeys(op.values).length : 0);
    if (op.op === "apertura") return sum + definedKeys(op, "op").length;
    return sum + 1;
  }, 0);
}

// Una riga per modifica, per l'elenco della rettifica -------------------------------------------------------------

const FIELD_LABEL: Readonly<Record<string, string>> = {
  location: "Luogo della visita",
  othersPresent: "Presenti alla visita",
  othersPresentConsented: "Consenso dei presenti",
  nprsPre: "Dolore 0-10 (NRS) a inizio seduta",
  nprsPost: "Dolore 0-10 (NRS) a fine seduta",
  subjectiveUpdate: "Novità dall'ultima seduta",
  radiationSites: "Irradiazione",
  radiationSide: "Lato dell'irradiazione",
  treatmentResponse: "Risposta al trattamento",
  adverseReaction: "Reazioni dopo l'ultima seduta",
  adverseReactionNote: "Nota sulla reazione",
  observationNote: "Osservazione",
  workingHypothesis: "Ipotesi di lavoro",
  planNext: "Piano",
  bpSystolic: "Pressione massima",
  bpDiastolic: "Pressione minima",
};

const OPENING_LABEL: Readonly<Record<string, string>> = {
  chiefComplaint: "Motivo della visita",
  mainRegion: "Regione principale",
  onsetOn: "Da quando",
  onsetMode: "Come è iniziato",
  medicalDiagnosisText: "Diagnosi medica di riferimento",
  medicalDiagnosisSource: "Fonte della diagnosi medica",
  referringPhysicianId: "Medico inviante",
  selfReferred: "Medico inviante",
  goal: "Obiettivo",
  expectedSessions: "Sedute previste",
  planNote: "Piano",
  planAgreedOn: "Piano spiegato e accettato dal paziente",
};

const regionLabel = (value: unknown): string => REGION_LABEL[value as RegionCode] ?? String(value);
const labels = (keys: readonly string[], map: Readonly<Record<string, string>>): string =>
  [...new Set(keys.map((k) => map[k] ?? k))].join(", ");

function testName(row: Readonly<Record<string, unknown>>): string {
  const code = text(row.testCode) ?? "";
  const name = testDefinition(code)?.name ?? text(row.customLabel) ?? code;
  const side = text(row.side);
  return side === null ? name : `${name} ${side}`;
}

/** Il nome dell'interruttore della sezione D («Tessuti molli», «HVLA»), o quello di «Altra tecnica». */
function treatmentName(row: Readonly<Record<string, unknown>>): string {
  const code = text(row.techniqueCode) as TechniqueCode;
  const label = technique(code)?.label;
  const name = text(row.customTechnique)?.trim() || (label === undefined ? String(code) : techniqueSwitchName(label));
  return `${name}, ${regionLabel(row.region)}`;
}

const adviceTitle = (code: unknown): string => ADVICE_TEMPLATES.find((t) => t.code === code)?.title ?? String(code);

/** La modifica in parole: «Dolore 0-10 (NRS) a fine seduta», «Disfunzione: Cervicale», «Tecnica tolta: HVLA, Lombare». */
export function amendLine(op: AmendOp, view: VisitEditor): string {
  switch (op.op) {
    case "campi":
      return isRecord(op.values) ? labels(definedKeys(op.values), FIELD_LABEL) : "Campi della visita";
    case "apertura":
      return `Apertura del ciclo: ${labels(definedKeys(op, "op"), OPENING_LABEL)}`;
    case "risposta": {
      const item = screeningItem(text(op.itemCode) ?? "");
      return `Screening: ${item?.short ?? text(op.itemCode) ?? ""}`;
    }
    case "nessun_altra_voce":
      return `Screening, Nessun'altra voce: ${SCREENING_GROUPS.find((g) => g.code === op.group)?.label ?? String(op.group)}`;
    case "esiti":
      return "Esiti dello screening";
    case "nessuna_variazione":
      return "Screening senza variazioni";
    case "psfs":
      return `PSFS: ${view.cycle.psfs.find((i) => i.id === op.itemId)?.activity ?? ""}`;
    case "disfunzione":
      return `Disfunzione: ${regionLabel(op.region)}${op.isPrimary === true ? ", primaria" : ""}`;
    case "togli_disfunzione":
      return `Disfunzione tolta: ${regionLabel(op.region)}`;
    case "test":
      return `Test: ${testName(op)}`;
    case "togli_test": {
      const row = view.tests.find((t) => t.id === op.resultId);
      return `Test tolto: ${row ? testName({ ...row }) : ""}`;
    }
    case "tecnica":
      return `Tecnica: ${treatmentName(op)}`;
    case "togli_tecnica": {
      const row = view.treatments.find((t) => t.id === op.treatmentId);
      return `Tecnica tolta: ${row ? treatmentName({ ...row }) : ""}`;
    }
    case "consiglio":
      return `Consiglio: ${adviceTitle(op.templateCode)}`;
    case "togli_consiglio": {
      const row = view.advice.find((a) => a.id === op.adviceId);
      return `Consiglio tolto: ${adviceTitle(row?.templateCode)}`;
    }
    case "conferma":
      return "Conferma dei dati copiati";
    default:
      return op.op;
  }
}

// La lista sulla vista ------------------------------------------------------------------------------------------

const CHANNELS = ["a_voce", "foglio_stampato", "messaggio_copiato"] as const;
type Channel = (typeof CHANNELS)[number];

const channels = (value: unknown): Channel[] => (Array.isArray(value) ? CHANNELS.filter((c) => value.includes(c)) : []);
const valueOr = <T>(op: AmendOp, key: string, fallback: T): T => (op[key] === undefined ? fallback : (op[key] as T));
const regionOrder = (region: RegionCode): number => REGION_CODES.indexOf(region);

function withAdvice(advice: readonly EditorAdvice[], op: AmendOp): EditorAdvice[] {
  const templateCode = text(op.templateCode) ?? "";
  const template = ADVICE_TEMPLATES.find((t) => t.code === templateCode);
  const row: Omit<EditorAdvice, "id"> = {
    templateCode,
    text: text(op.text)?.trim() || (template?.body ?? ""),
    communicatedVia: channels(op.communicatedVia),
  };
  const id = pendingAdviceId(templateCode);
  const existing = adviceRowOf(op, advice) ?? advice.find((a) => a.id === id);
  if (existing) return advice.map((a) => (a === existing ? { ...a, ...row } : a));
  return [...advice, { id, ...row }];
}

function withFinding(findings: readonly EditorFinding[], op: AmendOp): EditorFinding[] {
  const region = op.region as RegionCode;
  const existing = findings.find((f) => f.region === region);
  const row: EditorFinding = {
    id: existing?.id ?? pendingId(`disfunzione:${region}`),
    region,
    severity: valueOr(op, "severity", 0),
    tissueTexture: valueOr(op, "tissueTexture", false),
    asymmetry: valueOr(op, "asymmetry", false),
    restriction: valueOr(op, "restriction", false),
    tenderness: valueOr(op, "tenderness", false),
    side: valueOr(op, "side", null),
    segmentNote: text(op.segmentNote)?.trim() || null,
    isPrimary: op.isPrimary === true,
    copied: false,
  };
  const others = findings
    .filter((f) => f !== existing)
    .map((f) => (row.isPrimary && f.isPrimary ? { ...f, isPrimary: false } : f));
  return [...others, row].sort((a, b) => regionOrder(a.region) - regionOrder(b.region));
}

function withTest(tests: readonly EditorTest[], op: AmendOp, previousByKey: Readonly<Record<string, string>>): EditorTest[] {
  const target = testTarget(op);
  const existing = tests.find((t) => testTarget({ ...t }) === target);
  const testCode = text(op.testCode) ?? "";
  const customLabel = text(op.customLabel)?.trim() || null;
  const side = valueOr<EditorTest["side"]>(op, "side", null);
  const values = {
    valueBool: valueOr(op, "valueBool", null),
    valueLateral: valueOr(op, "valueLateral", null),
    valueNumeric: valueOr(op, "valueNumeric", null),
    valueOrdinal: valueOr(op, "valueOrdinal", null),
    painProvoked: valueOr(op, "painProvoked", null),
    note: text(op.note)?.trim() || null,
  };
  if (existing) return tests.map((t) => (t === existing ? { ...t, ...values, copied: false } : t));
  return [
    ...tests,
    {
      id: pendingId(target),
      testCode,
      name: testDefinition(testCode)?.name ?? customLabel ?? testCode,
      customLabel,
      customUnit: text(op.customUnit)?.trim() || null,
      side,
      ...values,
      copied: false,
      previousText: previousByKey[measureKey({ testCode, customLabel, side })] ?? null,
      change: null,
    },
  ];
}

function withTreatment(view: VisitEditor, treatments: readonly EditorTreatment[], op: AmendOp): EditorTreatment[] {
  const target = treatmentTarget(op);
  const existing = treatments.find((t) => treatmentTarget({ ...t }) === target);
  const region = op.region as RegionCode;
  const techniqueCode = op.techniqueCode as TechniqueCode;
  const approach = valueOr<EditorTreatment["approach"]>(op, "approach", null);
  const values = {
    approach,
    family: techniqueFamily(techniqueCode, approach),
    tolerance: valueOr<EditorTreatment["tolerance"]>(op, "tolerance", "buona"),
    response: valueOr<EditorTreatment["response"]>(op, "response", null),
    note: text(op.note)?.trim() || null,
  };
  // Il blocco di una riga nuova o con l'approccio cambiato, come lo mostra la sezione D per quella tecnica.
  const check =
    existing !== undefined && existing.approach === approach
      ? existing.check
      : ((approach === null ? undefined : view.approachChecks[region]?.[techniqueCode]?.[approach]) ??
        view.techniqueChecks[region][techniqueCode]);
  if (existing) return treatments.map((t) => (t === existing ? { ...t, ...values, check, copied: false } : t));
  const row: EditorTreatment = {
    id: pendingId(target),
    region,
    techniqueCode,
    customTechnique: text(op.customTechnique)?.trim() || null,
    ...values,
    copied: false,
    check,
  };
  return [...treatments, row].sort((a, b) => regionOrder(a.region) - regionOrder(b.region));
}

type Screening = VisitEditor["screening"];

function answerOf(op: AmendOp): ScreeningAnswer {
  return {
    itemCode: text(op.itemCode) ?? "",
    answer: op.answer as ScreeningAnswer["answer"],
    regions: Array.isArray(op.regions) ? (op.regions as RegionCode[]) : [],
    subAnswers: Array.isArray(op.subAnswers) ? (op.subAnswers as string[]) : [],
    fromHistory: false,
    note: text(op.note)?.trim() || null,
  };
}

/** Le risposte, «Nessun'altra voce» ed esiti sullo screening della vista; una risposta toglie la conferma. */
function withScreening(screening: Screening, op: AmendOp): Screening {
  if (op.op === "esiti" && Array.isArray(op.outcomes)) {
    const chosen = op.outcomes as { family: Family; outcome: Outcome; overrideNote?: string | null }[];
    const outcomes = Object.fromEntries(
      FAMILIES.map((family): [Family, SavedOutcome] => {
        const row = chosen.find((c) => c.family === family);
        return [
          family,
          {
            suggested: screening.suggestion[family].suggested,
            outcome: row?.outcome ?? screening.suggestion[family].suggested,
            overrideNote: text(row?.overrideNote)?.trim() || null,
            localContraindicated: screening.outcomes?.[family].localContraindicated ?? [],
          },
        ];
      }),
    ) as Record<Family, SavedOutcome>;
    return { ...screening, outcomes, pills: FAMILIES.map((f) => pillText(f, outcomes[f].outcome)) };
  }
  let written = false;
  const groups = screening.groups.map((group) => {
    if (op.op === "nessun_altra_voce" && group.code !== op.group) return group;
    let changed = false;
    const items = group.items.map((entry) => {
      if (op.op === "risposta" && entry.item.code === op.itemCode) {
        changed = true;
        return { ...entry, answer: answerOf(op) };
      }
      if (op.op === "nessun_altra_voce" && entry.answer === null) {
        changed = true;
        const answer: ScreeningAnswer = { itemCode: entry.item.code, answer: "no", regions: [], subAnswers: [], fromHistory: false, note: null };
        return { ...entry, answer };
      }
      return entry;
    });
    written ||= changed;
    return changed ? { ...group, items } : group;
  });
  if (!written) return screening;
  return { ...screening, groups, outcomes: null, pills: [] };
}

/**
 * La vista con la lista della rettifica. Senza modifiche è la vista stessa; le parti che la lista non tocca restano gli
 * stessi oggetti, così le bozze delle sezioni su quelle parti non ripartono.
 */
export function applyAmendOps(base: VisitEditor, ops: readonly AmendOp[]): VisitEditor {
  if (ops.length === 0) return base;
  let fields = base.visit.fields;
  let opening = base.cycle.opening;
  let psfs = base.cycle.psfs;
  let { advice, findings, tests, treatments, screening } = base;
  for (const op of ops) {
    switch (op.op) {
      case "campi":
        if (isRecord(op.values)) {
          const values = op.values;
          fields = { ...fields, ...Object.fromEntries(definedKeys(values).map((k) => [k, values[k]])) };
        }
        break;
      case "apertura":
        opening = { ...opening, ...Object.fromEntries(definedKeys(op, "op").map((k) => [k, op[k]])) };
        break;
      case "psfs":
        if (base.cycle.showsOpening) {
          const score = typeof op.score === "number" ? op.score : null;
          psfs = psfs.map((item) => (item.id === op.itemId ? { ...item, initial: score } : item));
        }
        break;
      case "risposta":
      case "nessun_altra_voce":
      case "esiti":
        screening = withScreening(screening, op);
        break;
      case "disfunzione":
        findings = withFinding(findings, op);
        break;
      case "togli_disfunzione":
        findings = findings.filter((f) => f.region !== op.region);
        break;
      case "test":
        tests = withTest(tests, op, base.previousByKey);
        break;
      case "togli_test":
        tests = tests.filter((t) => t.id !== op.resultId);
        break;
      case "tecnica":
        treatments = withTreatment(base, treatments, op);
        break;
      case "togli_tecnica":
        treatments = treatments.filter((t) => t.id !== op.treatmentId);
        break;
      case "consiglio":
        advice = withAdvice(advice, op);
        break;
      case "togli_consiglio":
        advice = advice.filter((a) => a.id !== op.adviceId);
        break;
      default:
        break;
    }
  }
  const visit =
    fields === base.visit.fields && screening === base.screening
      ? base.visit
      : { ...base.visit, fields, screeningConfirmed: screening === base.screening ? base.visit.screeningConfirmed : screening.outcomes !== null };
  return {
    ...base,
    visit,
    cycle: opening === base.cycle.opening && psfs === base.cycle.psfs ? base.cycle : { ...base.cycle, opening, psfs },
    screening,
    findings,
    tests,
    treatments,
    advice,
  };
}
