"use server";

import { z } from "zod";

import type { ActionResult } from "@/server/actions/result";
import { runAction } from "@/server/actions/run";
import { cancelWithCreditNote, deleteInvoiceDraft, issueInvoice, markNotToInvoice, registerPayment, saveBillingParty, saveInvoiceDraft, undoPayment } from "@/server/domain/invoices/commands";
import type { IssuedInvoice } from "@/server/domain/invoices/emission";
import { countEseDocuments, type EditorStart, getInvoiceEditor, type InvoiceEditorView, peekNextNumber } from "@/server/domain/invoices/queries";
import { saveRecipientFiscalFields } from "@/server/domain/invoices/recipient";

// Le Server Action dell'editor della fattura. Ognuna apre la sua transazione come
// l'utente con `runAction`; studio e utente arrivano dalla richiesta, mai dal client, e ogni input passa dallo
// schema del comando. L'editor lavora su uno stato del client: aprire e chiudere il pannello non scrive niente.

const INVALID = "Valore non valido";
const START = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new") }).strict(),
  z.object({ kind: z.literal("appointment"), appointmentId: z.uuid({ error: INVALID }) }).strict(),
  z.object({ kind: z.literal("draft"), invoiceId: z.uuid({ error: INVALID }) }).strict(),
], { error: INVALID });

/** Lettura all'apertura del pannello: niente bozza e niente numero consumato. */
export async function invoiceEditorAction(start: EditorStart): Promise<ActionResult<InvoiceEditorView | null>> {
  return runAction(
    "invoiceEditor",
    ({ tx, practiceId, clock }) => getInvoiceEditor(tx, practiceId, clock, START.parse(start)),
    { revalidate: false },
  );
}

/** Numero della Data prevista, letto senza prenotarlo prima della conferma. */
export async function peekInvoiceNumberAction(input: unknown): Promise<ActionResult<string>> {
  return runAction("peekInvoiceNumber", ({ tx, practiceId }) => {
    const { issueDate } = z.object({ issueDate: z.iso.date({ error: INVALID }) }).strict().parse(input);
    return peekNextNumber(tx, practiceId, "TD01", Number(issueDate.slice(0, 4)));
  }, { revalidate: false });
}

/** "Salva bozza": salva l'intera bozza, nuova o esistente. */
export async function saveDraftAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction("saveInvoiceDraft", ({ tx, practiceId, clock }) => saveInvoiceDraft(tx, practiceId, clock, input));
}

/** Salva ed emette nella stessa transazione: saveInvoiceDraft riusa l'id del client e rifiuta una fattura già emessa prima di consumare numeri. */
export async function issueFromEditorAction(input: unknown /* DraftInput */): Promise<ActionResult<IssuedInvoice>> {
  return runAction("issueFromEditor", async ({ tx, practiceId, clock }) => {
    const { id } = await saveInvoiceDraft(tx, practiceId, clock, input);
    return issueInvoice(tx, practiceId, clock, { invoiceId: id });
  });
}

/** "Elimina bozza", dopo la conferma. */
export async function deleteDraftAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("deleteInvoiceDraft", ({ tx, practiceId, clock }) => deleteInvoiceDraft(tx, practiceId, clock, input));
}

/** "Nuovo committente": restituisce l'id per sceglierlo subito. */
export async function saveBillingPartyAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction("saveBillingParty", ({ tx, practiceId, clock }) => saveBillingParty(tx, practiceId, clock, input));
}

/** Codice fiscale e indirizzo mancanti del destinatario, salvati anche in anagrafica. */
export async function saveRecipientFieldsAction(input: unknown): Promise<ActionResult<void>> {
  return runAction(
    "saveRecipientFiscalFields",
    ({ tx, practiceId, clock }) => saveRecipientFiscalFields(tx, practiceId, clock, input),
  );
}

export async function registerPaymentAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("registerPayment", ({ tx, practiceId, clock }) => registerPayment(tx, practiceId, clock, input));
}

export async function undoPaymentAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("undoPayment", ({ tx, practiceId, clock }) => undoPayment(tx, practiceId, clock, input));
}

export async function cancelInvoiceAction(input: unknown): Promise<ActionResult<{ creditNoteId: string; numberLabel: string; wasPaid: boolean }>> {
  return runAction("cancelWithCreditNote", ({ tx, practiceId, clock }) => cancelWithCreditNote(tx, practiceId, clock, input));
}

export async function markNotToInvoiceAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("markNotToInvoice", ({ tx, practiceId, clock }) => markNotToInvoice(tx, practiceId, clock, input));
}

export async function eseCountAction(input: { da: string; a: string }): Promise<ActionResult<number>> {
  return runAction("countEseDocuments", ({ tx, practiceId }) => {
    const period = z.object({ da: z.string(), a: z.string() }).strict().parse(input);
    return countEseDocuments(tx, practiceId, period.da, period.a);
  }, { revalidate: false });
}
