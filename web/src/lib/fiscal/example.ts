import { money } from "@/lib/format";
import { STAMP_CENTS } from "./amounts";
import { computeInvoice } from "./calc";
import type { FiscalRates, Regime } from "./types";

/** Una prestazione al paziente, calcolata con le stesse regole della fattura. */
export function liveExample(regime: Regime, rates: FiscalRates, service: { name: string; priceCents: number }): string {
  const result = computeInvoice({
    regime,
    rates,
    recipientKind: "paziente",
    withholdingAgent: false,
    lines: [{ quantity: 1, unitPriceCents: service.priceCents }],
  });
  let text = `${service.name} ${money(service.priceCents)}: compenso ${money(result.feesCents)}`;
  if (result.surchargeApplied) text += ` più rivalsa INPS ${money(result.surchargeCents)}`;
  text += regime === "ordinario" ? ` più IVA ${money(result.vatCents)}`
    : regime === "forfettario" ? ", niente IVA" : ", esente da IVA";
  text += result.stampCharged ? `, più bollo ${money(STAMP_CENTS)}`
    : result.stampDue ? `, bollo di ${money(STAMP_CENTS)} a carico dello studio` : ", niente bollo";
  return `${text}. Il paziente paga ${money(result.totalCents)}.`;
}
