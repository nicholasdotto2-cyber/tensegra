import { money } from "@/lib/format";
import { parseEuroCents } from "@/lib/money";
import { STAMP_CENTS } from "./amounts";
import type { InvoiceComputation } from "./calc";
import { DEFAULT_RATES, type PaymentMethod, type Regime } from "./types";

// Lo stato dell'editor della fattura nel browser: i campi come si scrivono,
// trasformati nell'input di `saveInvoiceDraft` solo su "Salva bozza" o "Emetti", e le righe del
// riepilogo dal vivo. Puro e sicuro per il client: nessun import dal server, la forma dell'input è
// quella di `DraftInput` (src/server/domain/invoices/schemas.ts).

export type EditorRecipient =
  | { kind: "paziente"; patientId: string }
  | { kind: "tutore"; patientId: string; guardianId: string }
  | { kind: "committente"; billingPartyId: string };

export interface EditorLine {
  key: string;
  serviceId: string | null;
  appointmentId: string | null;
  description: string;
  serviceDate: string | null;
  quantity: string;
  price: string;
}

export interface EditorState {
  invoiceId: string | null;
  recipient: EditorRecipient | null;
  lines: EditorLine[];
  paymentMethod: PaymentMethod;
  /** "Già incassata". */
  paid: boolean;
  /** "AAAA-MM-GG", o "" se il campo è vuoto. */
  paidOn: string;
  stampMarkCode: string;
  internalNotes: string | null;
}

/** La stessa forma di `DraftInput`. */
export interface EditorDraft {
  invoiceId: string | null;
  recipient: EditorRecipient;
  lines: {
    serviceId: string | null; appointmentId: string | null; description: string;
    serviceDate: string | null; quantity: number; unitPriceCents: number;
  }[];
  paymentMethod: PaymentMethod;
  paidOn: string | null;
  stampMarkCode: string | null;
  internalNotes: string | null;
}

export const QUANTITY_ERROR = "Scrivi una quantità intera, da 1 in su.";
export const PRICE_ERROR = "Scrivi un importo, per esempio 55,00.";
export const RECIPIENT_REQUIRED = "Scegli a chi è intestata la fattura.";
export const LINES_REQUIRED = "Aggiungi almeno una riga.";
export const PAID_ON_REQUIRED = "Scrivi la data dell'incasso.";

/** La quantità scritta: un intero da 1 in su, senza segni ("1,5", "0" e "abc" no). */
export function parseQuantity(text: string): number | null {
  const compact = text.trim();
  if (!/^\d{1,4}$/.test(compact)) return null;
  const quantity = Number(compact);
  return quantity >= 1 ? quantity : null;
}

/** Le righe che si leggono, per il riepilogo dal vivo: una riga ancora da scrivere non conta. */
export function liveLines(lines: readonly EditorLine[]): { quantity: number; unitPriceCents: number }[] {
  return lines.flatMap((line) => {
    const quantity = parseQuantity(line.quantity);
    const unitPriceCents = parseEuroCents(line.price);
    return quantity === null || unitPriceCents === null ? [] : [{ quantity, unitPriceCents }];
  });
}

/** L'input della bozza, o gli errori per campo (`lines.0.price`) da mostrare sotto i campi. */
export function toDraftInput(state: EditorState): EditorDraft | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (state.recipient === null) errors.recipient = RECIPIENT_REQUIRED;
  if (state.lines.length === 0) errors.lines = LINES_REQUIRED;
  const lines = state.lines.map((line, index) => {
    const quantity = parseQuantity(line.quantity);
    const unitPriceCents = parseEuroCents(line.price);
    if (quantity === null) errors[`lines.${index}.quantity`] = QUANTITY_ERROR;
    if (unitPriceCents === null) errors[`lines.${index}.price`] = PRICE_ERROR;
    return {
      serviceId: line.serviceId, appointmentId: line.appointmentId, description: line.description,
      serviceDate: line.serviceDate === "" ? null : line.serviceDate, quantity: quantity ?? 0, unitPriceCents: unitPriceCents ?? 0,
    };
  });
  if (state.paid && state.paidOn === "") errors.paidOn = PAID_ON_REQUIRED;
  if (Object.keys(errors).length > 0 || state.recipient === null) return { errors };
  return {
    invoiceId: state.invoiceId, recipient: state.recipient, lines, paymentMethod: state.paymentMethod,
    paidOn: state.paid ? state.paidOn : null,
    stampMarkCode: state.stampMarkCode.trim() === "" ? null : state.stampMarkCode,
    internalNotes: state.internalNotes,
  };
}

const percent = (bp: number) => `${(bp / 100).toLocaleString("it-IT")}%`;

/** Ogni passo del calcolo, nell'ordine della fattura: compenso, rivalsa, IVA, bollo, totale, ritenuta e netto. */
export function summaryRows(computation: InvoiceComputation, regime: Regime): { label: string; amount: string }[] {
  const c = computation;
  const rows = [{ label: "Compenso", amount: money(c.feesCents) }];
  if (c.surchargeApplied) rows.push({ label: `Rivalsa INPS ${percent(DEFAULT_RATES.inpsSurchargeBp)}`, amount: money(c.surchargeCents) });
  if (regime === "ordinario") rows.push({ label: `IVA ${percent(c.lineVatRateBp)}`, amount: money(c.vatCents) });
  if (c.stampCharged) rows.push({ label: "Rimborso imposta di bollo", amount: money(c.stampChargedCents) });
  rows.push({ label: "Totale", amount: money(c.totalCents) });
  if (c.stampDue && !c.stampCharged) rows.push({ label: "Bollo a carico dello studio", amount: money(STAMP_CENTS) });
  if (c.withholdingApplied) {
    rows.push({ label: `Ritenuta d'acconto ${percent(DEFAULT_RATES.withholdingBp)}`, amount: money(-c.withholdingCents) });
    rows.push({ label: "Netto a pagare", amount: money(c.netCents) });
  }
  return rows;
}

const REGIME_LABEL: Record<Regime, string> = {
  forfettario: "Forfettario: niente IVA, bollo di 2 euro sopra 77,47 euro",
  ordinario: "Ordinario: IVA 22% compresa nel prezzo per i pazienti",
  esente_sanitario: "Esente: niente IVA, bollo di 2 euro sopra 77,47 euro",
};

export function regimeLabel(regime: Regime): string {
  return REGIME_LABEL[regime];
}
