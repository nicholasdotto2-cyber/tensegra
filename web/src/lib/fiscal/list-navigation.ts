import type { InvoiceListParams } from "@/lib/fiscal/list-params";

/**
 * I parametri dell'elenco fatture dopo un cambio, partendo dall'ultimo elenco chiesto (non da quello che la
 * pagina mostra ancora): due cambi rapidi si sommano. Mese e anno restano coerenti, come li vuole
 * `parseInvoiceListParams`: il mese porta il suo anno, l'anno da solo tiene il mese chiesto.
 */
export function patchInvoiceList(current: InvoiceListParams, patch: Partial<InvoiceListParams>): InvoiceListParams {
  const next = { ...current, ...patch };
  if (patch.mese !== undefined) next.anno = Number(patch.mese.slice(0, 4));
  else if (patch.anno !== undefined) next.mese = `${patch.anno}${current.mese.slice(4)}`;
  return next;
}
