import { randomUUID } from "node:crypto";
import { withLivePayment, type LivePayment } from "@/lib/fiscal/live-payment";
import { downloadXmlName, pdfFileName } from "@/lib/fiscal/numbering";
import type { InvoiceSnapshot } from "@/lib/fiscal/snapshot";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { attachInvoicePdf, recordDownload } from "@/server/domain/invoices/commands";
import { storageKey } from "@/server/files/keys";
import { sha256Of } from "@/server/files/sniff";
import type { FileStore } from "@/server/files/store";
import type { StoreContext } from "@/server/files/upload";
import { renderInvoicePdf } from "./render";

export { withLivePayment } from "@/lib/fiscal/live-payment";

// Il PDF di cortesia di una fattura o nota di credito, generato alla prima richiesta e poi servito dallo
// stesso file. Come `ensureReferralPdf`, ma senza il controllo del
// testo cambiato: tutto viene dalla fotografia congelata all'emissione, tranne il pagamento (data, metodo e,
// per il bonifico, scadenza), che si legge dalla riga della fattura al momento di generare.
// Registrare o annullare un incasso azzera `pdf_file_id` (il file vecchio resta in `files`):
// la richiesta dopo genera di nuovo. Prima una transazione legge
// la fattura; se ha già il suo file lo si prende dallo store; altrimenti il PDF si genera fuori da ogni
// transazione, si scrive nello store e una seconda transazione salva `files` e `pdf_file_id`. Se la seconda
// fallisce il file si toglie; se nel frattempo un'altra richiesta ha salvato il PDF, si serve quello,
// altrimenti l'errore risale. Questo helper apre le sue transazioni: riceve `db`, mai `tx`, e non si chiama
// dentro un'altra `asUser`.

interface SavedInvoice {
  snapshot: InvoiceSnapshot;
  renderedPayment: Pick<LivePayment, "method" | "paidOn">;
  /** La chiave del file salvato nello store; null se il PDF non è ancora stato generato. */
  fileKey: string | null;
}

/** Una fattura emessa dello studio (la RLS filtra anche per l'utente); una bozza non ha fotografia né PDF. */
async function readInvoice(tx: Tx, practiceId: string, invoiceId: string): Promise<SavedInvoice | null> {
  const [row] = await tx.query<{
    snapshot: InvoiceSnapshot | null; fileKey: string | null;
    paymentMethod: LivePayment["method"]; paidOn: string | null; dueDate: string | null;
  }>(
    `select i.snapshot, f.storage_key as "fileKey", i.payment_method as "paymentMethod",
            i.paid_on as "paidOn", i.due_date as "dueDate"
       from public.invoices i
       left join public.files f on f.practice_id = i.practice_id and f.id = i.pdf_file_id
      where i.practice_id = $1 and i.id = $2 and i.status <> 'bozza'`,
    [practiceId, invoiceId],
  );
  if (!row?.snapshot) return null;
  const snapshot = withLivePayment(row.snapshot, { method: row.paymentMethod, paidOn: row.paidOn, dueDate: row.dueDate });
  return { snapshot, fileKey: row.fileKey, renderedPayment: { method: row.paymentMethod, paidOn: row.paidOn } };
}

async function savedBytes(store: FileStore, saved: SavedInvoice): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const bytes = saved.fileKey === null ? null : await store.get(saved.fileKey);
  return bytes === null ? null : { bytes, fileName: pdfFileName(saved.snapshot.docType, saved.snapshot.numberLabel) };
}

/**
 * I byte del PDF della fattura e il nome da scaricare; null se la fattura non c'è, è una bozza, è di un altro
 * studio, o il suo file salvato non è più nello store. Se un'altra richiesta ha già salvato il PDF mentre
 * questa lo generava, si serve quello salvato.
 */
export async function ensureInvoicePdf(
  ctx: StoreContext,
  clock: Clock,
  store: FileStore,
  invoiceId: string,
): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const saved = await ctx.db.asUser(ctx.actor, (tx) => readInvoice(tx, ctx.practiceId, invoiceId));
  if (!saved) return null;
  if (saved.fileKey !== null) return savedBytes(store, saved);

  const bytes = new Uint8Array(await renderInvoicePdf(saved.snapshot));
  const fileId = randomUUID();
  const key = storageKey(ctx.practiceId, "invoice_pdf", fileId, "application/pdf");
  const file = { id: fileId, storageKey: key, size: bytes.length, sha256: sha256Of(bytes) };
  await store.put(key, bytes);
  try {
    await ctx.db.asUser(ctx.actor, (tx) => attachInvoicePdf(tx, ctx.practiceId, clock, {
      invoiceId, file, renderedPayment: saved.renderedPayment,
    }));
  } catch (error) {
    // Un errore della pulizia non nasconde quello della transazione: al più resta un orfano.
    await store.remove(key).catch(() => {});
    const again = await ctx.db.asUser(ctx.actor, (tx) => readInvoice(tx, ctx.practiceId, invoiceId)).catch(() => null);
    const other = again?.fileKey ? await savedBytes(store, again).catch(() => null) : null;
    if (other) return other;
    throw error;
  }
  return { bytes, fileName: pdfFileName(saved.snapshot.docType, saved.snapshot.numberLabel) };
}

/** Scrive `pdf_scaricato` o `xml_scaricato`: la route del PDF lo chiama solo per il download, con `?download=1`; quella dell'XML a ogni risposta 200. */
export async function recordInvoiceDownload(
  ctx: StoreContext,
  clock: Clock,
  invoiceId: string,
  kind: "pdf" | "xml",
): Promise<void> {
  await ctx.db.asUser(ctx.actor, (tx) => recordDownload(tx, ctx.practiceId, clock, { invoiceId, kind }));
}

/**
 * L'XML salvato e il nome da scaricare (`PROVA_` davanti in demo); null se la fattura non c'è, è una bozza o
 * non ha XML (l'esente verso persona fisica). Scrive `xml_scaricato` nella stessa transazione della lettura.
 */
export async function readInvoiceXml(
  ctx: StoreContext,
  clock: Clock,
  invoiceId: string,
): Promise<{ xml: string; fileName: string } | null> {
  return ctx.db.asUser(ctx.actor, async (tx) => {
    const [row] = await tx.query<{ xml: string | null; xmlFileName: string | null; isDemo: boolean }>(
      `select xml, xml_file_name as "xmlFileName", coalesce((snapshot ->> 'isDemo')::boolean, false) as "isDemo"
         from public.invoices where practice_id = $1 and id = $2 and status <> 'bozza'`,
      [ctx.practiceId, invoiceId],
    );
    if (!row?.xml || !row.xmlFileName) return null;
    await recordDownload(tx, ctx.practiceId, clock, { invoiceId, kind: "xml" });
    return { xml: row.xml, fileName: downloadXmlName(row.xmlFileName, row.isDemo) };
  });
}
