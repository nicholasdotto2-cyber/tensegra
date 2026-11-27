import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { requireConsentToRemoveTechnique } from "./ops/consent";
import {
  confirmCopied,
  removeChild,
  removeFinding,
  requireChild,
  saveAdvice,
  saveFinding,
  saveTechnique,
  saveTest,
  scorePsfs,
  validateAdvice,
  validateConfirm,
  validateFields,
  validateOpening,
  validatePsfs,
  validateTechnique,
  validateTest,
  writeFields,
  writeOpening,
} from "./ops/record";
import {
  answerItem,
  confirmOutcomes,
  copyScreening,
  noOtherItem,
  screeningSource,
  type VisitRow,
} from "./ops/screening";
import type { VisitOp } from "./schemas";

// Le operazioni sulla visita.
// Lo stesso codice le applica in bozza (`editVisit`) e in rettifica (`amendVisit`), con le stesse
// regole: `applyVisitOp` non guarda lo stato della visita, che controlla chi la chiama (una visita
// chiusa si scrive solo dopo la riga di `visit_amendments`). Ogni SQL scrive solo righe della visita
// data e filtra lo studio anche oltre la RLS. Le operazioni stanno in `ops/screening.ts` (visita e
// screening), `ops/record.ts` (campi, apertura, PSFS, disfunzioni, test, tecniche, consigli, copiati),
// `ops/consent.ts` (consenso al trattamento revocato) e `ops/before.ts` (il "prima" di una rettifica);
// qui restano lo smistamento e i nomi pubblici.

export { AMEND_TARGET_TWICE, afterOf, type Change, changesFor, readBefore, requireUniqueTargets } from "./ops/before";
export { TREATMENT_CONSENT_REVOKED, treatmentConsentRevoked } from "./ops/consent";
export { COPIED_TABLES, copiedRowsCount, TEST_NOT_ACTIVE, testActive } from "./ops/record";
export {
  ANSWER_EVERY_ITEM,
  everyVisibleAnswered,
  loadScreeningState,
  loadVisit,
  OVERRIDE_NOTE_TEXT,
  saveAnswer,
  screeningSource,
  type VisitRow,
} from "./ops/screening";

/**
 * Le regole dell'operazione che si controllano senza scrivere, sullo stato di adesso: consenso al
 * trattamento revocato, prima visita del ciclo, righe che appartengono alla visita, test attivi, e
 * "Nessuna variazione", che in rettifica non c'è (la sorgente di una visita chiusa non è definita).
 * `amendVisit` le controlla tutte prima di scrivere la rettifica; `applyVisitOp` le richiama per prima
 * cosa. Le regole che leggono lo screening (voci visibili, risposte, esiti, blocco della tecnica)
 * restano nella scrittura: in una rettifica le cambiano le operazioni che vengono prima nella lista.
 */
export async function validateVisitOp(
  tx: Tx,
  practiceId: string,
  visit: VisitRow,
  op: VisitOp,
  mode: "bozza" | "rettifica",
): Promise<void> {
  switch (op.op) {
    case "campi":
      return validateFields(tx, practiceId, visit, op.values);
    case "risposta":
    case "nessun_altra_voce":
    case "esiti":
    case "disfunzione":
    case "togli_disfunzione":
      return;
    case "nessuna_variazione":
      if (mode === "rettifica" || !(await screeningSource(tx, practiceId, visit))) throw new DomainError(NOT_ALLOWED);
      return;
    case "psfs":
      return validatePsfs(tx, practiceId, visit, op);
    case "test":
      return validateTest(tx, practiceId, visit, op);
    case "togli_test":
      return requireChild(tx, practiceId, visit, "visit_test_results", op.resultId);
    case "tecnica":
      return validateTechnique(tx, practiceId, visit, op);
    case "togli_tecnica":
      await requireChild(tx, practiceId, visit, "visit_treatments", op.treatmentId);
      return requireConsentToRemoveTechnique(tx, practiceId, visit, op.treatmentId);
    case "consiglio":
      return validateAdvice(tx, practiceId, visit, op);
    case "togli_consiglio":
      return requireChild(tx, practiceId, visit, "visit_advice", op.adviceId);
    case "conferma":
      return validateConfirm(tx, practiceId, visit, op);
    case "apertura":
      return validateOpening(tx, practiceId, visit, mode);
    default:
      return unreachable(op);
  }
}

/** Applica un'operazione alla visita, con le stesse regole in bozza e in rettifica. */
export async function applyVisitOp(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  visit: VisitRow,
  op: VisitOp,
  mode: "bozza" | "rettifica",
): Promise<void> {
  await validateVisitOp(tx, practiceId, visit, op, mode);
  switch (op.op) {
    case "campi":
      return writeFields(tx, practiceId, visit, op.values);
    case "risposta":
      return answerItem(tx, practiceId, visit, op);
    case "nessun_altra_voce":
      return noOtherItem(tx, practiceId, visit, op);
    case "esiti":
      return confirmOutcomes(tx, practiceId, clock, visit, op, mode);
    case "nessuna_variazione":
      return copyScreening(tx, practiceId, clock, visit);
    case "psfs":
      return scorePsfs(tx, practiceId, visit, op);
    case "disfunzione":
      return saveFinding(tx, practiceId, visit, op);
    case "togli_disfunzione":
      return removeFinding(tx, practiceId, visit, op);
    case "test":
      return saveTest(tx, practiceId, visit, op);
    case "togli_test":
      return removeChild(tx, practiceId, visit, "visit_test_results", op.resultId);
    case "tecnica":
      return saveTechnique(tx, practiceId, visit, op);
    case "togli_tecnica":
      return removeChild(tx, practiceId, visit, "visit_treatments", op.treatmentId);
    case "consiglio":
      return saveAdvice(tx, practiceId, visit, op);
    case "togli_consiglio":
      return removeChild(tx, practiceId, visit, "visit_advice", op.adviceId);
    case "conferma":
      return confirmCopied(tx, practiceId, visit, op);
    case "apertura":
      return writeOpening(tx, practiceId, visit, op);
    default:
      return unreachable(op);
  }
}

/** Ogni operazione dell'unione ha il suo caso: un'operazione nuova senza caso non compila. */
function unreachable(op: never): never {
  throw new Error(`Operazione sulla visita sconosciuta: ${String((op as { op?: unknown }).op)}`);
}
