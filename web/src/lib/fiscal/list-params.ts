export interface InvoiceListParams {
  tab: "da_emettere" | "emesse" | "bozze";
  anno: number;
  mese: string;
  stato: "tutte" | "da_incassare" | "pagate" | "annullate";
  q: string;
}

/** Parametri URL non fidati: un array o un valore sconosciuto lascia il default. */
export function parseInvoiceListParams(
  sp: Record<string, string | string[] | undefined>, today: string,
): InvoiceListParams {
  const anno = typeof sp.anno === "string" && /^[1-9]\d{3}$/.test(sp.anno)
    ? Number(sp.anno) : Number(today.slice(0, 4));
  const mese = typeof sp.mese === "string" && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(sp.mese)
    && Number(sp.mese.slice(0, 4)) === anno ? sp.mese : `${anno}${today.slice(4, 7)}`;
  return {
    tab: sp.tab === "da_emettere" || sp.tab === "bozze" ? sp.tab : "emesse",
    anno, mese,
    stato: sp.stato === "da_incassare" || sp.stato === "pagate" || sp.stato === "annullate" ? sp.stato : "tutte",
    q: typeof sp.q === "string" ? sp.q.trim() : "",
  };
}
