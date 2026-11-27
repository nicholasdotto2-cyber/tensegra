"use server";

import { z } from "zod";

import type { ActionResult } from "@/server/actions/result";
import { runAction } from "@/server/actions/run";
import { getInvoiceXml } from "@/server/domain/invoices/queries";

// Le Server Action del dettaglio della fattura. Studio e utente arrivano dalla richiesta, mai dal
// client. Incasso e annullamento usano le azioni di `../actions.ts`, montate dai loro dialoghi.

const INVOICE_ID = z.uuid({ error: "Valore non valido" });

/** "Vedi XML": il testo dell'XML salvato all'emissione, null se la fattura non ne ha. Solo lettura. */
export async function invoiceXmlAction(id: string): Promise<ActionResult<string | null>> {
  return runAction(
    "invoiceXml",
    ({ tx, practiceId }) => getInvoiceXml(tx, practiceId, INVOICE_ID.parse(id)),
    { revalidate: false },
  );
}
