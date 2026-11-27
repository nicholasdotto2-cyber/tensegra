import { arr, rdiv, STAMP_CENTS, STAMP_THRESHOLD_CENTS } from "./amounts";
import type { FiscalRates, Nature, RecipientKind, Regime } from "./types";

export interface CalcLine {
  quantity: number;
  unitPriceCents: number;
}

export interface CalcInput {
  regime: Regime;
  recipientKind: RecipientKind;
  withholdingAgent: boolean;
  rates: FiscalRates;
  lines: readonly CalcLine[];
}

export interface InvoiceComputation {
  mode: "scorporo" | "netto";
  feesCents: number;
  surchargeCents: number;
  taxableCents: number;
  vatCents: number;
  stampDue: boolean;
  stampCharged: boolean;
  stampChargedCents: number;
  totalCents: number;
  withholdingCents: number;
  netCents: number;
  surchargeApplied: boolean;
  withholdingApplied: boolean;
  lineVatRateBp: number;
  lineNature: Nature | null;
  lineNetCents: number[];
}

export function natureOf(regime: Regime): Nature | null {
  switch (regime) {
    case "ordinario": return null;
    case "forfettario": return "N2.2";
    case "esente_sanitario": return "N4";
  }
}

/** Riparto proporzionale per resto più grande; a parità di resto vince la riga prima. */
export function splitNet(lineGrossCents: readonly number[], feesCents: number): number[] {
  const total = lineGrossCents.reduce((a, b) => a + BigInt(b), BigInt(0));
  if (total === BigInt(0)) return lineGrossCents.map(() => 0);
  const fees = BigInt(feesCents);
  const base = lineGrossCents.map((g) => (fees * BigInt(g)) / total);
  const rest = lineGrossCents.map((g) => (fees * BigInt(g)) % total);
  let missing = Number(fees - base.reduce((a, b) => a + b, BigInt(0)));
  const order = rest.map((_, i) => i).sort((a, b) => (rest[b]! > rest[a]! ? 1 : rest[b]! < rest[a]! ? -1 : a - b));
  const out = base.map(Number);
  for (const i of order) {
    if (missing === 0) break;
    out[i]! += 1;
    missing -= 1;
  }
  return out;
}

export function computeInvoice(input: CalcInput): InvoiceComputation {
  const { regime, recipientKind, withholdingAgent, rates } = input;
  const lineGrossCents = input.lines.map(({ quantity, unitPriceCents }) => {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new RangeError("La quantità deve essere un intero maggiore o uguale a 1.");
    }
    if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
      throw new RangeError("Il prezzo deve essere in centesimi interi da zero in su.");
    }
    return quantity * unitPriceCents;
  });
  const lineTotalCents = lineGrossCents.reduce((sum, cents) => sum + cents, 0);
  const mode = regime === "ordinario" && recipientKind !== "committente" ? "scorporo" : "netto";
  const surchargeApplied = rates.inpsSurchargeEnabled;
  let feesCents = lineTotalCents;
  let surchargeCents: number;
  let taxableCents: number;
  let vatCents: number;

  if (mode === "scorporo") {
    const bp = BigInt(10000);
    const gross = BigInt(lineTotalCents);
    feesCents = Number(surchargeApplied
      ? rdiv(gross * bp * bp, (bp + BigInt(rates.inpsSurchargeBp)) * (bp + BigInt(rates.vatRateBp)))
      : rdiv(gross * bp, bp + BigInt(rates.vatRateBp)));
    surchargeCents = surchargeApplied ? arr(feesCents, rates.inpsSurchargeBp) : 0;
    taxableCents = feesCents + surchargeCents;
    vatCents = lineTotalCents - taxableCents;

    // Al più due spostamenti di un centesimo verso la tolleranza IVA.
    if (surchargeApplied) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const difference = vatCents - arr(taxableCents, rates.vatRateBp);
        if (Math.abs(difference) <= 1) break;
        feesCents += difference > 0 ? 1 : -1;
        surchargeCents = arr(feesCents, rates.inpsSurchargeBp);
        taxableCents = feesCents + surchargeCents;
        vatCents = lineTotalCents - taxableCents;
      }
    }
  } else {
    surchargeCents = surchargeApplied ? arr(feesCents, rates.inpsSurchargeBp) : 0;
    taxableCents = feesCents + surchargeCents;
    vatCents = regime === "ordinario" ? arr(taxableCents, rates.vatRateBp) : 0;
  }

  const stampDue = regime !== "ordinario" && taxableCents > STAMP_THRESHOLD_CENTS;
  const stampCharged = stampDue && rates.stampChargedToClient;
  const stampChargedCents = stampCharged ? STAMP_CENTS : 0;
  const totalCents = taxableCents + vatCents + stampChargedCents;
  const withholdingApplied = recipientKind === "committente" && withholdingAgent && regime !== "forfettario";
  const withholdingCents = withholdingApplied
    ? arr(feesCents + surchargeCents + stampChargedCents, rates.withholdingBp)
    : 0;

  return {
    mode, feesCents, surchargeCents, taxableCents, vatCents,
    stampDue, stampCharged, stampChargedCents, totalCents,
    withholdingCents, netCents: totalCents - withholdingCents,
    surchargeApplied, withholdingApplied,
    lineVatRateBp: regime === "ordinario" ? rates.vatRateBp : 0,
    lineNature: natureOf(regime),
    lineNetCents: mode === "scorporo" ? splitNet(lineGrossCents, feesCents) : lineGrossCents,
  };
}
