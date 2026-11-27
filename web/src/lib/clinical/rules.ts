// Regole pure della cartella: esiti dello screening per famiglia, blocchi delle tecniche, promemoria
// di rinvio R1-R3 e risposte proposte dall'anamnesi.
// Nessun database, nessun fuso, nessun orologio. Sicuro per il client.

import {
  FAMILIES,
  NAO_DRUGS,
  REGION_CODES,
  SCREENING_GROUPS,
  SCREENING_ITEMS,
  TAO_DRUGS,
  technique,
  type Approach,
  type Effect,
  type Family,
  type Outcome,
  type RegionCode,
  type RiskTag,
  type ScreeningGroup,
  type ScreeningItem,
  type TechniqueCode,
} from "./catalog";
import { FAMILY_LABEL, OUTCOME_TEXT, fold } from "./labels";

// ---------------------------------------------------------------------------------------------------
// Risposte e suggerimento per famiglia.

export type Answer = "no" | "si" | "non_so";

export interface ScreeningAnswer {
  itemCode: string;
  answer: Answer;
  regions: readonly RegionCode[];
  subAnswers: readonly string[];
  fromHistory: boolean;
  note: string | null;
}

export interface FamilySuggestion {
  suggested: Outcome;
  /** Il `short` della prima voce che porta l'esito suggerito; null con `indicated`. */
  reason: string | null;
  localContraindicated: RegionCode[];
  /** Regioni con cautela locale che non sono già fra le controindicate. */
  localCaution: RegionCode[];
  /** Il motivo di ogni regione controindicata: il `short` della prima voce che la porta. */
  localReasons: Partial<Record<RegionCode, string>>;
  /** "da verificare" quando un "non_so" ha portato una controindicazione a cautela. */
  toVerify: string[];
}

const TO_VERIFY = "da verificare";

const EFFECT_RANK: Record<Effect, number> = { none: 0, caution: 1, contraindicated: 2 };
const OUTCOME_OF: Record<Effect, Outcome> = { none: "indicated", caution: "caution", contraindicated: "contraindicated" };

function maxEffect(a: Effect, b: Effect): Effect {
  return EFFECT_RANK[b] > EFFECT_RANK[a] ? b : a;
}

/** Posizione della voce nel catalogo: gruppo, poi `sort`. */
const CATALOG_INDEX = new Map(SCREENING_ITEMS.map((item, i) => [item.code, i]));

/** Le risposte "si" e "non_so" sulle voci del catalogo, in ordine di catalogo. */
function positiveAnswers(answers: readonly ScreeningAnswer[]): { answer: ScreeningAnswer; item: ScreeningItem }[] {
  return answers
    .filter((a) => a.answer !== "no" && CATALOG_INDEX.has(a.itemCode))
    .map((a) => ({ answer: a, index: CATALOG_INDEX.get(a.itemCode) ?? 0 }))
    .sort((x, y) => x.index - y.index)
    .map(({ answer, index }) => ({ answer, item: SCREENING_ITEMS[index] as ScreeningItem }));
}

function byRegionOrder(regions: Iterable<RegionCode>): RegionCode[] {
  const set = new Set(regions);
  return REGION_CODES.filter((r) => set.has(r));
}

export function suggestOutcomes(answers: readonly ScreeningAnswer[]): Record<Family, FamilySuggestion> {
  const acc = Object.fromEntries(
    FAMILIES.map((f) => [
      f,
      {
        effect: "none" as Effect,
        reason: null as string | null,
        contraindicated: new Set<RegionCode>(),
        caution: new Set<RegionCode>(),
        reasons: {} as Partial<Record<RegionCode, string>>,
        toVerify: false,
      },
    ]),
  ) as Record<
    Family,
    {
      effect: Effect;
      reason: string | null;
      contraindicated: Set<RegionCode>;
      caution: Set<RegionCode>;
      reasons: Partial<Record<RegionCode, string>>;
      toVerify: boolean;
    }
  >;

  for (const { answer, item } of positiveAnswers(answers)) {
    let effect: Record<Family, Effect> = { ...item.effect };
    if (item.scope === "global" && (item.referral === "urgente" || item.referral === "emergenza")) {
      effect = { thrust: "contraindicated", direct: "contraindicated", indirect: "contraindicated" }; // red flag urgente o di emergenza
    }
    const downgraded = new Set<Family>();
    if (answer.answer === "non_so") {
      for (const f of FAMILIES) {
        if (effect[f] === "contraindicated") {
          effect[f] = "caution"; // "non_so": da controindicato a cautela
          downgraded.add(f);
        }
      }
    }
    // Il thrust eredita le dirette, anche la controindicazione portata a cautela.
    if (downgraded.has("direct")) downgraded.add("thrust");
    effect.thrust = maxEffect(effect.thrust, effect.direct);

    // Una risposta locale senza regioni ("non_so", o "si" proposto dall'anamnesi) vale sulle
    // regioni proposte della voce: il dubbio resta visibile sulla riga.
    const regions = answer.regions.length > 0 ? answer.regions : item.proposedRegions;

    for (const f of FAMILIES) {
      const a = acc[f];
      if (downgraded.has(f)) a.toVerify = true;
      if (item.scope === "global") {
        if (EFFECT_RANK[effect[f]] > EFFECT_RANK[a.effect]) {
          a.effect = effect[f];
          a.reason = item.short;
        }
      } else if (effect[f] === "contraindicated") {
        for (const r of regions) {
          a.contraindicated.add(r);
          a.reasons[r] ??= item.short;
        }
      } else if (effect[f] === "caution") {
        for (const r of regions) a.caution.add(r);
      }
    }
  }

  return Object.fromEntries(
    FAMILIES.map((f) => {
      const a = acc[f];
      const suggestion: FamilySuggestion = {
        suggested: OUTCOME_OF[a.effect],
        reason: a.reason,
        localContraindicated: byRegionOrder(a.contraindicated),
        localCaution: byRegionOrder([...a.caution].filter((r) => !a.contraindicated.has(r))),
        localReasons: a.reasons,
        toVerify: a.toVerify ? [TO_VERIFY] : [],
      };
      return [f, suggestion];
    }),
  ) as Record<Family, FamilySuggestion>;
}

// ---------------------------------------------------------------------------------------------------
// Esiti scelti dall'osteopata e pillole dell'editor.

const OUTCOME_RANK: Record<Outcome, 0 | 1 | 2> = { indicated: 0, caution: 1, contraindicated: 2 };

export function outcomeRank(o: Outcome): 0 | 1 | 2 {
  return OUTCOME_RANK[o];
}

/** Un esito meno severo del suggerito vuole la nota. */
export function needsOverrideNote(suggested: Outcome, outcome: Outcome): boolean {
  return outcomeRank(outcome) < outcomeRank(suggested);
}

export const OVERRIDE_NOTE_MIN = 10;

export function pillText(family: Family, outcome: Outcome): string {
  return `${FAMILY_LABEL[family]}: ${OUTCOME_TEXT[outcome]}`;
}

// ---------------------------------------------------------------------------------------------------
// Gruppi e voci visibili.

export interface GroupContext {
  firstVisit: boolean;
  mainRegion: RegionCode | null;
  cervicalDirectOrThrust: boolean;
  pregnancyInProgress: boolean;
  ageMonths: number;
  pediatricEnabled: boolean;
  answeredGroups: readonly ScreeningGroup[];
}

export function visibleGroups(c: GroupContext): ScreeningGroup[] {
  const visible: Record<ScreeningGroup, boolean> = {
    ci_sistemica: true,
    ci_locale: true,
    rf_rachide: true,
    rf_cervicale_vascolare:
      (c.firstVisit && (c.mainRegion === "cervical" || c.mainRegion === "head")) ||
      c.cervicalDirectOrThrust ||
      c.answeredGroups.includes("rf_cervicale_vascolare"),
    rf_gravidanza: c.pregnancyInProgress,
    rf_pediatrico: c.pediatricEnabled && c.ageMonths < 12,
  };
  return SCREENING_GROUPS.map((g) => g.code).filter((g) => visible[g]);
}

/** Le voci del gruppo per l'età: `ageMaxMonths` vale "sotto i N mesi". */
export function visibleItems(group: ScreeningGroup, ageMonths: number): ScreeningItem[] {
  return SCREENING_ITEMS.filter(
    (i) => i.group === group && (i.ageMaxMonths === null || ageMonths < i.ageMaxMonths),
  ).sort((a, b) => a.sort - b.sort);
}

// ---------------------------------------------------------------------------------------------------
// Blocchi sul trattamento.

export interface ScreeningState {
  outcomes: Record<Family, { outcome: Outcome; localContraindicated: readonly RegionCode[] }>;
  suggestion: Record<Family, FamilySuggestion>;
}

function techniqueOf(code: TechniqueCode) {
  const t = technique(code);
  if (!t) throw new Error(`Tecnica sconosciuta: ${code}`);
  return t;
}

/** Senza approccio dichiarato vale la famiglia predefinita del catalogo. */
export function techniqueFamily(code: TechniqueCode, approach: Approach | null): Family {
  const t = techniqueOf(code);
  if (t.variableApproach && approach !== null) return approach;
  return t.families[0] as Family;
}

export function techniqueName(code: TechniqueCode, custom: string | null): string {
  if (code === "altra") return custom?.trim() || techniqueOf(code).label;
  return techniqueOf(code).blockName;
}

export type TreatmentCheck = { kind: "ok" } | { kind: "caution"; text: string } | { kind: "blocked"; text: string };

export const SCREENING_FIRST = "Conferma lo screening prima di scrivere il trattamento.";

const CAUTION_TEXT = "Con cautela";

export function checkTreatment(
  t: { region: RegionCode; techniqueCode: TechniqueCode; approach: Approach | null; customTechnique: string | null },
  s: ScreeningState | null,
): TreatmentCheck {
  if (!s) return { kind: "blocked", text: SCREENING_FIRST };
  const f = techniqueFamily(t.techniqueCode, t.approach);
  const { outcome, localContraindicated } = s.outcomes[f];
  const suggestion = s.suggestion[f];
  let reason: string | null = null;
  if (outcome === "contraindicated") reason = suggestion.reason ?? "esito dello screening";
  else if (localContraindicated.includes(t.region)) reason = suggestion.localReasons[t.region] ?? "controindicazione locale";
  if (reason !== null) {
    return {
      kind: "blocked",
      text: `${techniqueName(t.techniqueCode, t.customTechnique)} controindicata in questa visita: ${reason}. Cambia l'esito dello screening se hai nuove informazioni.`,
    };
  }
  // Il blocco locale legge le regioni salvate; una regione segnata dalle voci locali e non bloccata
  // negli esiti salvati resta con cautela, mai libera.
  const localFlag = suggestion.localCaution.includes(t.region) || suggestion.localContraindicated.includes(t.region);
  if (outcome === "caution" || localFlag) return { kind: "caution", text: CAUTION_TEXT };
  return { kind: "ok" };
}

// ---------------------------------------------------------------------------------------------------
// Promemoria di rinvio: rileggono solo ciò che l'osteopata ha scritto.

/** Un "si" su un red flag con rinvio urgente o di emergenza. */
export function urgentRedFlag(answers: readonly ScreeningAnswer[]): boolean {
  return positiveAnswers(answers).some(
    ({ answer, item }) => answer.answer === "si" && (item.referral === "urgente" || item.referral === "emergenza"),
  );
}

export type PromptCode = "R1" | "R2" | "R3";

export interface ReferralPrompt {
  code: PromptCode;
  text: string;
  urgency: "emergenza" | "urgente" | "programmato" | null;
}

export interface PromptInput {
  enabled: readonly PromptCode[];
  answers: readonly ScreeningAnswer[];
  cycleKind: "trattamento" | "mantenimento";
  expectedSessions: number | null;
  /** Il numero della seduta nel ciclo (`sessionPosition`), passato da chi chiama. */
  sessionNumber: number | null;
  firstNprsPre: number | null;
  todayNprsPre: number | null;
  isFirstVisitOfCycle: boolean;
}

export function referralPrompts(i: PromptInput): ReferralPrompt[] {
  const prompts: ReferralPrompt[] = [];
  if (i.enabled.includes("R1")) {
    for (const { answer, item } of positiveAnswers(i.answers)) {
      if (answer.answer !== "si" || item.referral === "none") continue;
      prompts.push({
        code: "R1",
        text: `Hai segnato: ${item.label}. Indicazione della fonte: ${item.referral}.`,
        urgency: item.referral,
      });
    }
  }
  const first = i.firstNprsPre;
  const today = i.todayNprsPre;
  const pains = !i.isFirstVisitOfCycle && first !== null && today !== null;
  if (i.enabled.includes("R2") && pains && today >= first + 2) {
    prompts.push({
      code: "R2",
      text: `Il dolore 0-10 di oggi (${today}) supera di almeno 2 punti quello della prima visita del ciclo (${first}).`,
      urgency: null,
    });
  }
  if (
    i.enabled.includes("R3") &&
    pains &&
    i.cycleKind === "trattamento" &&
    i.expectedSessions !== null &&
    i.sessionNumber !== null &&
    i.sessionNumber > i.expectedSessions &&
    first - today < 2
  ) {
    prompts.push({
      code: "R3",
      text: `Seduta ${i.sessionNumber} oltre ${i.expectedSessions === 1 ? "l'unica prevista" : `le ${i.expectedSessions} previste`} e il dolore 0-10 è sceso di meno di 2 punti dalla prima visita.`,
      urgency: null,
    });
  }
  return prompts;
}

// ---------------------------------------------------------------------------------------------------
// Anamnesi.

/** Le etichette di rischio di un farmaco nuovo, dal nome o dal principio attivo. */
export function riskTagsForDrug(label: string): RiskTag[] {
  const name = fold(label);
  const tags: RiskTag[] = [];
  if (TAO_DRUGS.some((d) => name.includes(d))) tags.push("anticoagulante_tao");
  if (NAO_DRUGS.some((d) => name.includes(d))) tags.push("anticoagulante_nao");
  return tags;
}

/**
 * Le risposte "si (da anamnesi)" delle voci collegate alle etichette di rischio attive. Una voce
 * locale parte dalle sue regioni proposte (una risposta locale "si" vuole almeno una regione).
 */
export function historyAnswers(tags: readonly RiskTag[]): ScreeningAnswer[] {
  return SCREENING_ITEMS.filter((item) => item.linkedRiskTag !== null && tags.includes(item.linkedRiskTag)).map(
    (item) => ({
      itemCode: item.code,
      answer: "si",
      regions: item.scope === "local" ? [...item.proposedRegions] : [],
      subAnswers: [],
      fromHistory: true,
      note: null,
    }),
  );
}
