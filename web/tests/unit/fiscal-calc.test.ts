import { describe, expect, it } from "vitest";
import { arr, rdiv } from "@/lib/fiscal/amounts";
import { computeInvoice, natureOf, splitNet, type CalcInput, type InvoiceComputation } from "@/lib/fiscal/calc";
import { DEFAULT_RATES, type Regime } from "@/lib/fiscal/types";

function input(overrides: Partial<CalcInput> = {}): CalcInput {
  return {
    regime: "forfettario",
    recipientKind: "paziente",
    withholdingAgent: false,
    rates: { ...DEFAULT_RATES },
    lines: [{ quantity: 1, unitPriceCents: 5500 }],
    ...overrides,
  };
}

interface CalculationCase {
  name: string;
  input: Partial<CalcInput>;
  // fees, surcharge, taxable, vat, stampDue, stampChargedCents, total, withholding, net
  amounts: [number, number, number, number, boolean, number, number, number, number];
  extra?: Partial<InvoiceComputation>;
}

const surchargeRates = { ...DEFAULT_RATES, inpsSurchargeEnabled: true };
const twoLines = [{ quantity: 1, unitPriceCents: 7000 }, { quantity: 1, unitPriceCents: 5500 }];
const tenSessions = [{ quantity: 10, unitPriceCents: 5500 }];

const cases: CalculationCase[] = [
  { name: "F1", input: {}, amounts: [5500, 0, 5500, 0, false, 0, 5500, 0, 5500] },
  { name: "F2", input: { lines: twoLines }, amounts: [12500, 0, 12500, 0, true, 200, 12700, 0, 12700], extra: { lineNetCents: [7000, 5500] } },
  { name: "F2b", input: { lines: twoLines, rates: { ...DEFAULT_RATES, stampChargedToClient: false } }, amounts: [12500, 0, 12500, 0, true, 0, 12500, 0, 12500], extra: { stampCharged: false } },
  { name: "F3", input: { lines: [{ quantity: 1, unitPriceCents: 7000 }], rates: surchargeRates }, amounts: [7000, 280, 7280, 0, false, 0, 7280, 0, 7280] },
  { name: "F4", input: { lines: [{ quantity: 1, unitPriceCents: 7500 }], rates: surchargeRates }, amounts: [7500, 300, 7800, 0, true, 200, 8000, 0, 8000] },
  { name: "F5", input: { recipientKind: "committente", withholdingAgent: true, lines: tenSessions }, amounts: [55000, 0, 55000, 0, true, 200, 55200, 0, 55200], extra: { withholdingApplied: false } },
  { name: "O1", input: { regime: "ordinario" }, amounts: [4508, 0, 4508, 992, false, 0, 5500, 0, 5500], extra: { mode: "scorporo", lineNetCents: [4508] } },
  { name: "O2", input: { regime: "ordinario", lines: [{ quantity: 1, unitPriceCents: 7000 }] }, amounts: [5738, 0, 5738, 1262, false, 0, 7000, 0, 7000] },
  { name: "O3", input: { regime: "ordinario", lines: [{ quantity: 1, unitPriceCents: 7000 }], rates: surchargeRates }, amounts: [5517, 221, 5738, 1262, false, 0, 7000, 0, 7000] },
  { name: "O4", input: { regime: "ordinario", recipientKind: "committente", withholdingAgent: true, rates: surchargeRates, lines: tenSessions }, amounts: [55000, 2200, 57200, 12584, false, 0, 69784, 11440, 58344], extra: { mode: "netto", lineNetCents: [55000] } },
  { name: "E1", input: { regime: "esente_sanitario", lines: twoLines }, amounts: [12500, 0, 12500, 0, true, 200, 12700, 0, 12700], extra: { lineNature: "N4" } },
  { name: "S1", input: { lines: [{ quantity: 1, unitPriceCents: 8000 }] }, amounts: [8000, 0, 8000, 0, true, 200, 8200, 0, 8200] },
  { name: "S2", input: {}, amounts: [5500, 0, 5500, 0, false, 0, 5500, 0, 5500] },
  { name: "S3", input: { lines: [{ quantity: 1, unitPriceCents: 4500 }] }, amounts: [4500, 0, 4500, 0, false, 0, 4500, 0, 4500] },
  { name: "S4", input: { recipientKind: "committente", withholdingAgent: true, lines: [{ quantity: 4, unitPriceCents: 5500 }] }, amounts: [22000, 0, 22000, 0, true, 200, 22200, 0, 22200] },
  { name: "S5", input: { regime: "ordinario" }, amounts: [4508, 0, 4508, 992, false, 0, 5500, 0, 5500] },
];

describe("Calcolo fiscale", () => {
  it.each(cases)("$name: importi al centesimo", ({ input: overrides, amounts, extra }) => {
    const result = computeInvoice(input(overrides));
    const [feesCents, surchargeCents, taxableCents, vatCents, stampDue, stampChargedCents, totalCents, withholdingCents, netCents] = amounts;
    expect(result).toMatchObject({
      feesCents, surchargeCents, taxableCents, vatCents, stampDue, stampChargedCents,
      totalCents, withholdingCents, netCents,
      stampCharged: stampChargedCents > 0,
      surchargeApplied: overrides.rates?.inpsSurchargeEnabled ?? false,
      withholdingApplied: overrides.recipientKind === "committente" && overrides.withholdingAgent === true && overrides.regime !== undefined && overrides.regime !== "forfettario",
      ...extra,
    });
  });

  it.each([{ price: 7747, due: false }, { price: 7748, due: true }])("bollo a $price centesimi: $due", ({ price, due }) => {
    expect(computeInvoice(input({ lines: [{ quantity: 1, unitPriceCents: price }] })).stampDue).toBe(due);
  });

  it("in esente la ritenuta del committente comprende rivalsa e rimborso del bollo", () => {
    expect(computeInvoice(input({ regime: "esente_sanitario", recipientKind: "committente", withholdingAgent: true, rates: surchargeRates, lines: tenSessions }))).toMatchObject({
      mode: "netto", feesCents: 55000, surchargeCents: 2200, taxableCents: 57200, vatCents: 0,
      stampDue: true, stampCharged: true, stampChargedCents: 200, totalCents: 57400,
      withholdingApplied: true, withholdingCents: 11480, netCents: 45920,
    });
  });

  it("il committente non sostituto paga il netto più IVA senza ritenuta", () => {
    expect(computeInvoice(input({ regime: "ordinario", recipientKind: "committente" }))).toMatchObject({
      mode: "netto", feesCents: 5500, vatCents: 1210, totalCents: 6710,
      withholdingApplied: false, withholdingCents: 0, netCents: 6710,
    });
  });

  it.each(["paziente", "tutore"] as const)("scorpora e non applica ritenuta verso %s anche con il flag sostituto", (recipientKind) => {
    expect(computeInvoice(input({ regime: "ordinario", recipientKind, withholdingAgent: true }))).toMatchObject({
      mode: "scorporo", feesCents: 4508, vatCents: 992, totalCents: 5500,
      withholdingApplied: false, withholdingCents: 0, netCents: 5500,
    });
  });

  it.each<{ regime: Regime; vat: number; nature: "N2.2" | "N4" | null }>([
    { regime: "ordinario", vat: 2200, nature: null },
    { regime: "forfettario", vat: 0, nature: "N2.2" },
    { regime: "esente_sanitario", vat: 0, nature: "N4" },
  ])("aliquota e natura delle righe in $regime", ({ regime, vat, nature }) => {
    expect(computeInvoice(input({ regime }))).toMatchObject({ lineVatRateBp: vat, lineNature: nature });
    expect(natureOf(regime)).toBe(nature);
  });

  it("scorpora la somma delle righe e ripartisce il netto proporzionalmente", () => {
    expect(computeInvoice(input({ regime: "ordinario", lines: [{ quantity: 1, unitPriceCents: 8000 }, { quantity: 1, unitPriceCents: 5500 }] }))).toMatchObject({
      feesCents: 11066, vatCents: 2434, lineNetCents: [6558, 4508],
    });
  });

  it("scorpora il totale della riga con quantità tre", () => {
    expect(computeInvoice(input({ regime: "ordinario", lines: [{ quantity: 3, unitPriceCents: 5500 }] }))).toMatchObject({
      feesCents: 13525, lineNetCents: [13525],
    });
  });

  it("ripartisce il totale zero senza divisioni per zero", () => {
    expect(splitNet([0, 0], 0)).toEqual([0, 0]);
  });

  it("a parità di resto assegna il centesimo alla riga precedente", () => {
    expect(splitNet([1, 1, 1], 2)).toEqual([1, 1, 0]);
  });

  it("rispetta la tolleranza IVA senza correzioni su tutti i 999999 prezzi con rivalsa", () => {
    let maxDeviation = 0;
    for (let price = 1; price <= 999999; price += 1) {
      const fees = Number(rdiv(BigInt(price) * BigInt(100000000), BigInt(10400) * BigInt(12200)));
      const taxable = fees + arr(fees, 400);
      const vat = price - taxable;
      const deviation = Math.abs(vat - arr(taxable, 2200));
      const result = computeInvoice(input({ regime: "ordinario", rates: surchargeRates, lines: [{ quantity: 1, unitPriceCents: price }] }));
      if (deviation > 1 || result.feesCents !== fees || result.vatCents !== vat || result.totalCents !== price) {
        throw new Error(`Scorporo fuori tolleranza o corretto al prezzo ${price}: ${JSON.stringify(result)}`);
      }
      maxDeviation = Math.max(maxDeviation, deviation);
    }
    expect(maxDeviation).toBeLessThanOrEqual(1);
  }, 30000);

  it.each([1.5, 0])("rifiuta la quantità %s", (quantity) => {
    expect(() => computeInvoice(input({ lines: [{ quantity, unitPriceCents: 5500 }] }))).toThrow(RangeError);
  });

  it.each([-1, 1.5, NaN, Infinity])("rifiuta il prezzo non valido %s", (unitPriceCents) => {
    expect(() => computeInvoice(input({ lines: [{ quantity: 1, unitPriceCents }] }))).toThrow(RangeError);
  });
});
