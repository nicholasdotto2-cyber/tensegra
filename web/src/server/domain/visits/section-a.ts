import { z } from "zod";

import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { addPsfsItem, linkRelapse, removePsfsItem, renamePsfsItem, updateCycleOpening } from "@/server/domain/cycles/commands";
import { openingVisitOf } from "@/server/domain/cycles/queries";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import {
  removeHistoryItem,
  saveHistoryItem,
  saveLifestyle,
  savePerinatal,
  saveSystemsReview,
} from "@/server/domain/history/commands";
import { loadVisit, type VisitRow } from "./ops";
import { INVALID } from "./schemas";

// Le scritture della sezione A dell'editor della visita, prima
// che la Server Action rilegga la vista. I campi d'apertura, le attività PSFS e la ricaduta sono del ciclo e si
// scrivono dalla prima visita del ciclo, finché è in bozza e senza visite chiuse; l'anamnesi è del paziente e si scrive anche da una visita
// chiusa (in rettifica non passa dalla rettifica: non è della visita). Il ciclo, il paziente e il giorno della
// visita li legge il server dalla visita: il client non li manda, e una chiave sua non li sostituisce.

/** Il tipo dell'azione e il resto dell'input, che il comando controlla con il suo schema `.strict()`. */
function splitKind<K extends string>(input: unknown, kinds: readonly [K, ...K[]]): { kind: K; rest: Record<string, unknown> } {
  const { kind, ...rest } = z
    .object({ kind: z.enum(kinds, { error: INVALID }) })
    .catchall(z.unknown())
    .parse(input);
  return { kind, rest };
}

/** Le chiavi dell'input, che il comando controlla con il suo schema `.strict()`. */
const recordOf = (input: unknown): Record<string, unknown> => z.record(z.string(), z.unknown(), { error: INVALID }).parse(input);

const visitIdOf = (visitId: string): string => z.uuid({ error: INVALID }).parse(visitId);

/**
 * La visita in bozza che tiene l'apertura del suo ciclo: la prima del ciclo, senza visite chiuse (`openingVisitOf`). Da
 * lì si scrive l'apertura; con una visita chiusa nel ciclo solo una rettifica di quella la cambia.
 */
async function openingVisit(tx: Tx, practiceId: string, visitId: string): Promise<VisitRow> {
  const visit = await loadVisit(tx, practiceId, visitIdOf(visitId));
  if (visit?.status !== "draft" || (await openingVisitOf(tx, practiceId, visit.cycleId))?.id !== visit.id) {
    throw new DomainError(NOT_ALLOWED);
  }
  return visit;
}

/** I campi d'apertura del ciclo della visita (`updateCycleOpening`). */
export async function editOpening(tx: Tx, practiceId: string, clock: Clock, visitId: string, input: unknown): Promise<void> {
  const visit = await openingVisit(tx, practiceId, visitId);
  await updateCycleOpening(tx, practiceId, clock, { ...recordOf(input), cycleId: visit.cycleId });
}

/** Un'attività PSFS del ciclo della visita: `aggiungi`, `rinomina` o `togli`. */
export async function editPsfsItem(tx: Tx, practiceId: string, clock: Clock, visitId: string, input: unknown): Promise<void> {
  const visit = await openingVisit(tx, practiceId, visitId);
  const { kind, rest } = splitKind(input, ["aggiungi", "rinomina", "togli"]);
  if (kind === "aggiungi") {
    await addPsfsItem(tx, practiceId, clock, { ...rest, cycleId: visit.cycleId });
    return;
  }
  // L'attività è del ciclo di questa visita, non di un altro ciclo dello studio (i comandi controllano solo lo studio).
  const { itemId } = z.object({ itemId: z.uuid({ error: INVALID }) }).catchall(z.unknown()).parse(rest);
  const own = await tx.query("select 1 from public.psfs_items where practice_id = $1 and id = $2 and cycle_id = $3", [
    practiceId,
    itemId,
    visit.cycleId,
  ]);
  if (own.length === 0) throw new DomainError(NOT_ALLOWED);
  await (kind === "rinomina" ? renamePsfsItem : removePsfsItem)(tx, practiceId, clock, rest);
}

/** «Sì, è una ricaduta»: collega il ciclo chiuso che la domanda propone al ciclo della visita. */
export async function editRelapse(tx: Tx, practiceId: string, clock: Clock, visitId: string, input: unknown): Promise<void> {
  const visit = await openingVisit(tx, practiceId, visitId);
  await linkRelapse(tx, practiceId, clock, { ...recordOf(input), cycleId: visit.cycleId });
}

/** La più recente di due date "AAAA-MM-GG" (in ordine di testo sono in ordine di calendario). */
const later = (a: string, b: string | null): string => (b !== null && b > a ? b : a);

/**
 * L'anamnesi del paziente della visita: `voce`, `togli_voce`, `apparati`, `stile` o `perinatale`. Il paziente viene
 * dalla visita; il giorno della revisione (`reviewedOn`) è il giorno della visita, ma non va mai indietro: una
 * rettifica di una visita vecchia non cancella una revisione più recente.
 */
export async function editHistory(tx: Tx, practiceId: string, clock: Clock, visitId: string, input: unknown): Promise<void> {
  const visit = await loadVisit(tx, practiceId, visitIdOf(visitId));
  if (visit === null) throw new DomainError(NOT_ALLOWED);
  const { kind, rest } = splitKind(input, ["voce", "togli_voce", "apparati", "stile", "perinatale"]);
  const { patientId, visitDate } = visit;
  switch (kind) {
    case "voce": {
      // Il tipo della voce (`kind` dell'anamnesi) sta dentro `item`: `kind` qui è il tipo dell'azione.
      const { item } = z.object({ item: z.record(z.string(), z.unknown(), { error: INVALID }) }).catchall(z.unknown()).parse(rest);
      await saveHistoryItem(tx, practiceId, clock, { ...item, patientId });
      return;
    }
    case "togli_voce":
      await removeHistoryItem(tx, practiceId, clock, { ...rest, patientId });
      return;
    case "apparati": {
      const [stored] = await tx.query<{ day: string | null }>(
        "select max(reviewed_on) as day from public.patient_systems_review where practice_id = $1 and patient_id = $2",
        [practiceId, patientId],
      );
      await saveSystemsReview(tx, practiceId, clock, { ...rest, patientId, reviewedOn: later(visitDate, stored?.day ?? null) });
      return;
    }
    case "stile": {
      const [stored] = await tx.query<{ day: string | null }>(
        "select last_reviewed_on as day from public.patient_lifestyle where practice_id = $1 and patient_id = $2",
        [practiceId, patientId],
      );
      await saveLifestyle(tx, practiceId, clock, { ...rest, patientId, reviewedOn: later(visitDate, stored?.day ?? null) });
      return;
    }
    case "perinatale":
      await savePerinatal(tx, practiceId, clock, { ...rest, patientId });
      return;
  }
}
