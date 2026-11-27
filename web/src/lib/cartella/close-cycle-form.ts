import { CYCLE_OUTCOME_LABEL, REFERRAL_FIRST } from "@/lib/clinical/labels";

// Il modulo della finestra "Chiudi ciclo" senza interfaccia: da
// ciò che si è scritto costruisce l'input di `closeCycle` oppure gli errori sui campi, e rimappa i percorsi
// degli errori del comando sui campi della finestra. Chi apre la finestra (Cartella, dialogo
// dell'appuntamento, pannello "Seduta fatta") passa da qui: la regola dei punteggi finali sta in un posto
// solo. Nessun database, nessun fuso. Sicuro per il client.

export type CloseOutcome = keyof typeof CYCLE_OUTCOME_LABEL;
export const OUTCOMES = Object.keys(CYCLE_OUTCOME_LABEL) as CloseOutcome[];

export const CADENCE_PRESETS = [4, 6, 8, 12] as const;
export const CADENCE_OTHER = "altra";
export const CADENCE_NONE = "nessuno";
export type Cadence = `${(typeof CADENCE_PRESETS)[number]}` | typeof CADENCE_OTHER | typeof CADENCE_NONE;

export const MIN_WEEKS = 2;
export const MAX_WEEKS = 52;
export const SCORE_MAX = 10;

export const PICK_OUTCOME = "Scegli l'esito del ciclo.";
export const INVALID_WEEKS = "Scrivi un numero di settimane da 2 a 52.";
export const INVALID_SCORE = "Scrivi un punteggio da 0 a 10.";

/** Ciò che serve della finestra letta dal server (`CycleClosingView`). */
export interface CloseFormView {
  cycleId: string;
  psfs: readonly { itemId: string }[];
  canScoreFinal: boolean;
  hasReferral: boolean;
}

/** Ciò che l'utente ha scritto o scelto. `scores` per `itemId`, come testo del campo. */
export interface CloseFormState {
  outcome: CloseOutcome | null;
  note: string;
  closedOn: string;
  scores: Record<string, string>;
  notReturned: boolean;
  cadence: Cadence;
  other: string;
}

export type CloseCycleInputValue = {
  cycleId: string;
  outcome: CloseOutcome;
  outcomeNote?: string;
  closedOn: string;
  finalScores: "non_tornato" | { itemId: string; score: number }[];
  recall: "nessuno" | { weeks: number };
};

export type BuiltClose = { ok: true; input: CloseCycleInputValue } | { ok: false; errors: Record<string, string> };

/** La cadenza di partenza: quella proposta se è nell'elenco, altrimenti «Altra» con il suo numero. */
export function initialCadence(weeks: number): { cadence: Cadence; other: string } {
  const preset = CADENCE_PRESETS.find((p) => p === weeks);
  return preset === undefined ? { cadence: CADENCE_OTHER, other: `${weeks}` } : { cadence: `${preset}`, other: "" };
}

/** «Rinviato al medico» propone «Nessun richiamo»; ogni altro esito la cadenza di partenza. */
export function defaultCadence(outcome: CloseOutcome | null, start: Cadence): Cadence {
  return outcome === "rinviato_al_medico" ? CADENCE_NONE : start;
}

/** Le settimane scritte in «Altra»: un intero da 2 a 52, altrimenti null. */
export function parseOtherWeeks(text: string): number | null {
  const typed = Number(text.trim());
  if (text.trim() === "" || !Number.isInteger(typed) || typed < MIN_WEEKS || typed > MAX_WEEKS) return null;
  return typed;
}

/** I punteggi finali si scrivono solo con attività, una bozza libera (`canScoreFinal`) e senza «Paziente non tornato». */
export function isScoring(view: Pick<CloseFormView, "psfs" | "canScoreFinal">, notReturned: boolean): boolean {
  return view.psfs.length > 0 && view.canScoreFinal && !notReturned;
}

/**
 * L'input di `closeCycle` o gli errori per campo (`outcome`, `score-<itemId>`, `weeks`, `letter`). Senza attività i
 * punteggi sono un elenco vuoto; con attività e senza bozza libera, o con «Paziente non tornato», «non_tornato».
 * «Rinviato al medico» senza un rinvio del ciclo è rifiutato qui (`letter`): la frase la mostra già la finestra.
 */
export function buildCloseCycleInput(view: CloseFormView, state: CloseFormState): BuiltClose {
  const errors: Record<string, string> = {};
  if (state.outcome === null) errors.outcome = PICK_OUTCOME;
  else if (state.outcome === "rinviato_al_medico" && !view.hasReferral) errors.letter = REFERRAL_FIRST;

  const scoring = isScoring(view, state.notReturned);
  const scores: { itemId: string; score: number }[] = [];
  if (scoring) {
    for (const item of view.psfs) {
      const text = (state.scores[item.itemId] ?? "").trim();
      const score = Number(text);
      if (text === "" || !Number.isInteger(score) || score < 0 || score > SCORE_MAX) {
        errors[`score-${item.itemId}`] = INVALID_SCORE;
      } else {
        scores.push({ itemId: item.itemId, score });
      }
    }
  }

  let recall: CloseCycleInputValue["recall"] = CADENCE_NONE;
  if (state.cadence === CADENCE_OTHER) {
    const weeks = parseOtherWeeks(state.other);
    if (weeks === null) errors.weeks = INVALID_WEEKS;
    else recall = { weeks };
  } else if (state.cadence !== CADENCE_NONE) {
    recall = { weeks: Number(state.cadence) };
  }

  if (Object.keys(errors).length > 0 || state.outcome === null) return { ok: false, errors };

  const note = state.note.trim();
  let finalScores: CloseCycleInputValue["finalScores"] = [];
  if (view.psfs.length > 0) finalScores = scoring ? scores : "non_tornato";
  return {
    ok: true,
    input: {
      cycleId: view.cycleId,
      outcome: state.outcome,
      ...(note === "" ? {} : { outcomeNote: note }),
      closedOn: state.closedOn,
      finalScores,
      recall,
    },
  };
}

/** I percorsi degli errori del comando sui campi della finestra: i punteggi insieme (`scores`) e la cadenza (`weeks`). */
export function mapCloseErrors(fieldErrors: Record<string, string> | undefined): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [path, message] of Object.entries(fieldErrors ?? {})) {
    const field = path.startsWith("finalScores") ? "scores" : path.startsWith("recall") ? "weeks" : path;
    if (!(field in mapped)) mapped[field] = message;
  }
  return mapped;
}
