// Regole pure della visita: cosa copia "Copia dalla visita precedente" e cosa serve per chiuderla.
// Nessun database, nessun fuso. Sicuro per il
// client.

import type { Approach, RegionCode, TechniqueCode } from "./catalog";
import { fold } from "./labels";
import { checkTreatment, type ScreeningState, type TreatmentCheck } from "./rules";

// ---------------------------------------------------------------------------------------------------
// Copia dalla visita precedente.

export interface CopyFinding {
  region: RegionCode;
  severity: number;
  tissueTexture: boolean;
  asymmetry: boolean;
  restriction: boolean;
  tenderness: boolean;
  side: "dx" | "sx" | "bilaterale" | "centrale" | null;
  segmentNote: string | null;
  isPrimary: boolean;
}

/** Gli stessi test, senza valori: la forma non li prevede. */
export interface CopyTest {
  testCode: string;
  customLabel: string | null;
  customUnit: string | null;
  side: "dx" | "sx" | null;
}

export interface CopyTreatment {
  region: RegionCode;
  techniqueCode: TechniqueCode;
  customTechnique: string | null;
  approach: Approach | null;
}

/** I modelli dati nella visita sorgente: ordinano i consigli proposti, non diventano righe. */
export interface CopyAdvice {
  templateCode: string | null;
  text: string;
}

export interface CopySource {
  findings: readonly CopyFinding[];
  tests: readonly CopyTest[];
  treatments: readonly CopyTreatment[];
  advice: readonly CopyAdvice[];
}

/**
 * Le righe da copiare con lo screening di oggi confermato: le disfunzioni tutte, i test senza
 * valori, i trattamenti tranne quelli che lo screening di oggi non lascerebbe salvare (`skipped`). I
 * consigli passano così come sono: nessuna riga di consiglio si copia.
 */
export function planCopy(source: CopySource, today: ScreeningState): CopySource & { skipped: number } {
  const treatments = source.treatments
    .filter((t) => checkTreatment(t, today).kind !== "blocked")
    .map((t) => ({ region: t.region, techniqueCode: t.techniqueCode, customTechnique: t.customTechnique, approach: t.approach }));
  return {
    findings: source.findings.map((f) => ({
      region: f.region,
      severity: f.severity,
      tissueTexture: f.tissueTexture,
      asymmetry: f.asymmetry,
      restriction: f.restriction,
      tenderness: f.tenderness,
      side: f.side,
      segmentNote: f.segmentNote,
      isPrimary: f.isPrimary,
    })),
    tests: source.tests.map((t) => ({ testCode: t.testCode, customLabel: t.customLabel, customUnit: t.customUnit, side: t.side })),
    treatments,
    advice: source.advice,
    skipped: source.treatments.length - treatments.length,
  };
}

/** Perché una tecnica non si copia: lo screening di oggi, o il consenso al trattamento revocato. */
export type SkipReason = "controindicata" | "consenso_revocato";

/**
 * "1 tecnica non copiata: controindicata oggi", «2 tecniche non copiate: consenso al trattamento
 * revocato» con il consenso revocato; null se non ne manca nessuna.
 */
export function skippedText(n: number, reason: SkipReason = "controindicata"): string | null {
  if (n <= 0) return null;
  if (reason === "consenso_revocato") {
    return `${n} ${n === 1 ? "tecnica non copiata" : "tecniche non copiate"}: consenso al trattamento revocato`;
  }
  return n === 1 ? "1 tecnica non copiata: controindicata oggi" : `${n} tecniche non copiate: controindicate oggi`;
}

// ---------------------------------------------------------------------------------------------------
// "Per chiudere".

export type ClosingCode =
  | "screening"
  | "conflitto"
  | "copiati"
  | "presenti"
  | "reazione"
  | "irradiazione"
  | "apertura"
  | "dolore"
  | "consigli"
  | "senza_tart"
  | "consenso"
  | "genitore"
  | "piano"
  | "psfs";

export interface ClosingItem {
  code: ClosingCode;
  text: string;
  /** L'id del campo nell'editor a cui porta il link della colonna "Per chiudere". */
  anchor: string;
}

export interface ClosingCheck {
  blocking: ClosingItem[];
  warnings: ClosingItem[];
}

export interface ClosingFacts {
  screeningConfirmed: boolean;
  treatments: readonly { region: RegionCode; check: TreatmentCheck; note: string | null }[];
  copiedCount: number;
  othersPresent: string | null;
  othersPresentConsented: boolean | null;
  adverseReaction: string | null;
  adverseReactionNote: string | null;
  radiationSites: readonly string[];
  radiationSide: string | null;
  firstVisitOfTreatmentCycle: boolean;
  opening: {
    chiefComplaint: string | null;
    mainRegion: RegionCode | null;
    goal: string | null;
    expectedSessions: number | null;
  };
  nprsPre: number | null;
  adviceCount: number;
  findingRegions: readonly RegionCode[];
  treatmentConsentMissing: boolean;
  minorAtVisit: boolean;
  planAgreed: boolean;
  psfsCount: number;
  firstVisitOfCycle: boolean;
}

const CLOSING_TEXT: Record<ClosingCode, string> = {
  screening: "Conferma lo screening.",
  conflitto:
    'Una tecnica è in contrasto con lo screening: scrivi nella riga "tecnica eseguita prima della comparsa del sintomo" o toglila.',
  copiati: "Conferma i dati copiati.",
  presenti: "Indica se il paziente acconsente alla presenza di altre persone.",
  reazione: "Scrivi una nota sulla reazione dall'ultima visita.",
  irradiazione: "Scegli il lato dell'irradiazione.",
  apertura: "Per la prima visita servono motivo, regione principale, obiettivo e sedute previste.",
  dolore: "Manca il dolore 0-10 a inizio seduta.",
  consigli: "Nessun consiglio dato.",
  senza_tart: "Regione trattata senza disfunzioni somatiche (TART)",
  consenso: "Manca il consenso al trattamento per questo ciclo.",
  genitore: "Minore senza un genitore fra i presenti.",
  piano: "Piano non segnato come spiegato e accettato.",
  psfs: "Nessuna attività PSFS per questo ciclo.",
};

const treatmentAnchor = (region: RegionCode) => `riga-tecnica-${region}`;

/** I presenti che contano come genitore, senza maiuscole e accenti. */
const GUARDIAN_WORDS = /\b(madre|padre|genitor[ei]|tutor[ei])\b/;

function filled(text: string | null): boolean {
  return text !== null && text.trim() !== "";
}

function uniqueRegions(regions: Iterable<RegionCode>): RegionCode[] {
  return [...new Set(regions)];
}

/** Bloccanti e avvisi gialli della colonna "Per chiudere", ognuno nell'ordine dei codici. */
export function closingCheck(f: ClosingFacts): ClosingCheck {
  const item = (code: ClosingCode, anchor: string): ClosingItem => ({ code, text: CLOSING_TEXT[code], anchor });
  const blocking: ClosingItem[] = [];
  const warnings: ClosingItem[] = [];

  if (!f.screeningConfirmed) blocking.push(item("screening", "sezione-b"));
  // Senza screening confermato ogni riga è bloccata da SCREENING_FIRST: il conflitto si legge
  // solo sugli esiti confermati.
  if (f.screeningConfirmed) {
    const conflicts = f.treatments.filter((t) => t.check.kind === "blocked" && !filled(t.note));
    for (const region of uniqueRegions(conflicts.map((t) => t.region))) {
      blocking.push(item("conflitto", treatmentAnchor(region)));
    }
  }
  if (f.copiedCount > 0) blocking.push(item("copiati", "sezione-c"));
  if (filled(f.othersPresent) && f.othersPresentConsented === null) blocking.push(item("presenti", "campo-presenti"));
  if (f.adverseReaction !== null && f.adverseReaction !== "nessuna" && !filled(f.adverseReactionNote)) {
    blocking.push(item("reazione", "campo-reazione"));
  }
  if (f.radiationSites.length > 0 && f.radiationSide === null) blocking.push(item("irradiazione", "campo-irradiazione"));
  if (f.firstVisitOfTreatmentCycle) {
    const o = f.opening;
    if (!filled(o.chiefComplaint) || o.mainRegion === null || !filled(o.goal) || o.expectedSessions === null) {
      blocking.push(item("apertura", "apertura-ciclo"));
    }
  }

  if (f.nprsPre === null) warnings.push(item("dolore", "campo-dolore-inizio"));
  if (f.adviceCount === 0) warnings.push(item("consigli", "sezione-e"));
  const withFindings = new Set(f.findingRegions);
  for (const region of uniqueRegions(f.treatments.map((t) => t.region))) {
    if (!withFindings.has(region)) warnings.push(item("senza_tart", treatmentAnchor(region)));
  }
  if (f.treatmentConsentMissing) warnings.push(item("consenso", "sezione-d"));
  if (f.minorAtVisit && !GUARDIAN_WORDS.test(fold(f.othersPresent ?? ""))) warnings.push(item("genitore", "campo-presenti"));
  if (f.firstVisitOfCycle && !f.planAgreed) warnings.push(item("piano", "sezione-e"));
  if (f.firstVisitOfCycle && f.psfsCount === 0) warnings.push(item("psfs", "apertura-ciclo"));

  return { blocking, warnings };
}
