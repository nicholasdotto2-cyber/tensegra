"use server";

import { z } from "zod";

import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import type { ActionResult } from "@/server/actions/result";
import { runAction } from "@/server/actions/run";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { amendVisit, closeVisit, copyFromPreviousVisit, editVisit } from "@/server/domain/visits/commands";
import { getVisitEditor, type VisitEditor } from "@/server/domain/visits/editor";
import { loadVisit } from "@/server/domain/visits/ops";
import { INVALID } from "@/server/domain/visits/schemas";
import { editHistory, editOpening, editPsfsItem, editRelapse } from "@/server/domain/visits/section-a";

// Le Server Action dell'editor della visita. Eccezione al corpo a una
// riga: ognuna applica il suo comando e rilegge la vista dell'editor nella stessa transazione, così il client la
// sostituisce senza un'altra richiesta. Niente `revalidatePath`: l'editor salva a ogni campo e una pagina riletta
// a ogni battuta lo rallenterebbe; le altre pagine sono dinamiche e si rileggono quando si aprono. Studio e utente
// arrivano dalla richiesta, mai dal client; il paziente della visita lo legge il server.

/** La vista dell'editor della visita, letta col paziente della visita stessa; una visita assente o di un altro studio si ferma qui. */
async function editorOf(tx: Tx, practiceId: string, clock: Clock, visitId: string): Promise<VisitEditor> {
  const visit = await loadVisit(tx, practiceId, visitId);
  const editor = visit === null ? null : await getVisitEditor(tx, practiceId, clock, visit.patientId, visit.id);
  if (editor === null) throw new DomainError(NOT_ALLOWED);
  return editor;
}

/** La vista dell'editor, sola lettura: l'editor la rilegge quando la scheda torna in primo piano. */
export async function visitEditorAction(visitId: string): Promise<ActionResult<VisitEditor>> {
  return runAction(
    "visitEditor",
    ({ tx, practiceId, clock }) => editorOf(tx, practiceId, clock, z.uuid({ error: INVALID }).parse(visitId)),
    { revalidate: false },
  );
}

/** L'input del client con la visita della rotta: un valore che non è un oggetto lo rifiuta lo schema del comando. */
function withVisit(visitId: string, input: unknown): unknown {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? { ...input, visitId } : input;
}

/** Un'operazione su una visita in bozza (`VisitOp`), poi la vista riletta. */
export async function editVisitAction(visitId: string, op: unknown): Promise<ActionResult<VisitEditor>> {
  return runAction(
    "editVisit",
    async ({ tx, practiceId, clock }) => {
      await editVisit(tx, practiceId, clock, { visitId, op });
      return editorOf(tx, practiceId, clock, visitId);
    },
    { revalidate: false },
  );
}

// Sezione A: le scritture sono in `visits/section-a.ts`, provate dal db come uA e uB.

/** I campi d'apertura del ciclo della visita, poi la vista riletta. */
export async function cycleOpeningAction(visitId: string, input: unknown): Promise<ActionResult<VisitEditor>> {
  return runAction(
    "cycleOpening",
    async ({ tx, practiceId, clock }) => {
      await editOpening(tx, practiceId, clock, visitId, input);
      return editorOf(tx, practiceId, clock, visitId);
    },
    { revalidate: false },
  );
}

/** Un'attività PSFS del ciclo: `aggiungi`, `rinomina` o `togli`; poi la vista riletta. */
export async function psfsItemAction(visitId: string, input: unknown): Promise<ActionResult<VisitEditor>> {
  return runAction(
    "psfsItem",
    async ({ tx, practiceId, clock }) => {
      await editPsfsItem(tx, practiceId, clock, visitId, input);
      return editorOf(tx, practiceId, clock, visitId);
    },
    { revalidate: false },
  );
}

/** «Sì, è una ricaduta», poi la vista riletta. */
export async function relapseAction(visitId: string, input: unknown): Promise<ActionResult<VisitEditor>> {
  return runAction(
    "relapse",
    async ({ tx, practiceId, clock }) => {
      await editRelapse(tx, practiceId, clock, visitId, input);
      return editorOf(tx, practiceId, clock, visitId);
    },
    { revalidate: false },
  );
}

/** L'anamnesi del paziente della visita: `voce`, `togli_voce`, `apparati`, `stile` o `perinatale`; poi la vista riletta. */
export async function historyAction(visitId: string, input: unknown): Promise<ActionResult<VisitEditor>> {
  return runAction(
    "history",
    async ({ tx, practiceId, clock }) => {
      await editHistory(tx, practiceId, clock, visitId, input);
      return editorOf(tx, practiceId, clock, visitId);
    },
    { revalidate: false },
  );
}

// Copia, chiusura e rettifica.

/**
 * "Copia dalla visita precedente": con `replace` sostituisce i copiati non confermati. Senza `replace`, con copiati
 * non confermati, non scrive e risponde `needsReplace`; `skippedText` dice le tecniche non copiate.
 */
export async function copyVisitAction(
  visitId: string,
  replace: boolean,
): Promise<ActionResult<{ editor: VisitEditor; needsReplace: boolean; skippedText: string | null }>> {
  return runAction(
    "copyVisit",
    async ({ tx, practiceId, clock }) => {
      const result = await copyFromPreviousVisit(tx, practiceId, clock, { visitId, replace });
      return { ...result, editor: await editorOf(tx, practiceId, clock, visitId) };
    },
    { revalidate: false },
  );
}

/** «Chiudi la visita»: `{ confirmCopied, alsoMarkDone }`; un bloccante di "Per chiudere" risponde con il suo testo. */
export async function closeVisitAction(visitId: string, input: unknown): Promise<ActionResult<VisitEditor>> {
  return runAction(
    "closeVisit",
    async ({ tx, practiceId, clock }) => {
      await closeVisit(tx, practiceId, clock, withVisit(visitId, input));
      return editorOf(tx, practiceId, clock, visitId);
    },
    { revalidate: false },
  );
}

/** «Salva la rettifica»: `{ reason, ops }`, il motivo con tutte le modifiche in una sola transazione. */
export async function amendVisitAction(visitId: string, input: unknown): Promise<ActionResult<VisitEditor>> {
  return runAction(
    "amendVisit",
    async ({ tx, practiceId, clock }) => {
      await amendVisit(tx, practiceId, clock, withVisit(visitId, input));
      return editorOf(tx, practiceId, clock, visitId);
    },
    { revalidate: false },
  );
}
