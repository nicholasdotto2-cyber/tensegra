import { arr, rdiv, STAMP_CENTS } from "./amounts";
import type { InvoiceSnapshot } from "./snapshot";
import { DEFAULT_RATES, type DocType, type PaymentMethod } from "./types";

export interface XmlAddress {
  line: string; postalCode: string; city: string; province: string | null; country: string;
}

export interface FatturaModel {
  transmitter: { country: "IT"; code: string };
  progressive: string;
  recipientCode: string;
  recipientPec: string | null;
  supplier: {
    vatNumber: string; taxCode: string; firstName: string; lastName: string; regimeCode: "RF01" | "RF19";
    albo: { order: string; province: string | null; number: string; date: string | null } | null;
    address: XmlAddress;
  };
  customer: {
    vatNumber: string | null; taxCode: string | null; firstName: string | null; lastName: string | null;
    name: string | null; address: XmlAddress;
  };
  document: {
    type: DocType; date: string; number: string;
    withholding: { amountCents: number; rateBp: number } | null;
    stampCents: number | null;
    pension: {
      rateBp: number; amountCents: number; baseCents: number; vatRateBp: number;
      withholding: boolean; nature: string | null;
    } | null;
    totalCents: number; causali: string[]; linked: { number: string; date: string } | null;
  };
  lines: {
    number: number; description: string; quantity: number; unitPrice: string; totalCents: number;
    vatRateBp: number; withholding: boolean; nature: string | null;
  }[];
  summary: {
    vatRateBp: number; nature: string | null; taxableCents: number; vatCents: number;
    esigibilita: "I" | null; reference: string | null;
  }[];
  payment: {
    method: "MP01" | "MP05" | "MP08"; amountCents: number; dueDate: string | null;
    beneficiary: string | null; iban: string | null;
  } | null;
}

function decimal(value: bigint, places: number): string {
  const digits = (value < BigInt(0) ? -value : value).toString().padStart(places + 1, "0");
  return `${value < BigInt(0) ? "-" : ""}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

export function xmlAmount(cents: number): string { return decimal(BigInt(cents), 2); }
export function xmlPercent(bp: number): string { return decimal(BigInt(bp), 2); }
export function xmlQuantity(q: number): string { return decimal(BigInt(q) * BigInt(100), 2); }

export function xmlUnitPrice(totalCents: number, quantity: number): string {
  if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError("La quantità deve essere un intero maggiore o uguale a 1.");
  const total = BigInt(totalCents);
  const q = BigInt(quantity);
  if (total % q === BigInt(0)) return decimal(total / q, 2);
  let value = decimal(rdiv(total * BigInt(1000000), q), 8);
  while (value.endsWith("0") && value.length - value.indexOf(".") - 1 > 2) value = value.slice(0, -1);
  return value;
}

const PAYMENT_CODES: Record<PaymentMethod, "MP01" | "MP05" | "MP08"> = {
  contanti: "MP01", carta: "MP08", bonifico: "MP05",
};

/** Legge solo la fotografia, compresi testi e IVA già arrotondata dallo scorporo. */
export function toFatturaModel(s: InvoiceSnapshot, overrides?: { number?: string; progressive?: string }): FatturaModel {
  const c = s.computation;
  const registration = s.supplier.registration;
  const summary: FatturaModel["summary"] = [];
  const add = (vatRateBp: number, nature: string | null, cents: number) => {
    let group = summary.find((row) => row.vatRateBp === vatRateBp && row.nature === nature);
    if (!group) {
      group = { vatRateBp, nature, taxableCents: 0, vatCents: 0,
        esigibilita: s.regime === "ordinario" ? "I" : null,
        reference: nature === "N2.2" || nature === "N4" ? s.texts.references[nature] ?? null : null,
      };
      summary.push(group);
    }
    group.taxableCents += cents;
  };
  for (const line of s.lines) add(line.vatRateBp, line.nature, line.netTotalCents);
  if (c.surchargeApplied) add(c.lineVatRateBp, c.lineNature, c.surchargeCents);
  for (const group of summary) group.vatCents = summary.length === 1 ? c.vatCents : arr(group.taxableCents, group.vatRateBp);
  const bank = s.payment.method === "bonifico";
  return {
    transmitter: { country: "IT", code: s.supplier.taxCode },
    progressive: overrides?.progressive ?? s.transmission?.progressive ?? "00000",
    recipientCode: s.recipient.kind === "committente" ? s.recipient.recipientCode : "0000000",
    recipientPec: s.recipient.kind === "committente" ? s.recipient.pec : null,
    supplier: {
      vatNumber: s.supplier.vatNumber, taxCode: s.supplier.taxCode,
      firstName: s.supplier.firstName, lastName: s.supplier.lastName,
      regimeCode: s.regime === "forfettario" ? "RF19" : "RF01",
      albo: registration.kind === "albo" ? {
        order: registration.order ?? "", province: registration.province,
        number: registration.number ?? "", date: registration.date,
      } : null,
      address: { ...s.supplier.address },
    },
    customer: {
      vatNumber: s.recipient.kind === "committente" ? s.recipient.vatNumber : null,
      taxCode: s.recipient.taxCode,
      firstName: s.recipient.kind === "committente" ? null : s.recipient.firstName,
      lastName: s.recipient.kind === "committente" ? null : s.recipient.lastName,
      name: s.recipient.kind === "committente" ? s.recipient.name : null, address: { ...s.recipient.address },
    },
    document: {
      type: s.docType, date: s.issueDate, number: overrides?.number ?? s.numberLabel,
      withholding: c.withholdingApplied ? { amountCents: c.withholdingCents, rateBp: DEFAULT_RATES.withholdingBp } : null,
      stampCents: c.stampDue ? STAMP_CENTS : null,
      pension: c.surchargeApplied ? {
        rateBp: DEFAULT_RATES.inpsSurchargeBp, amountCents: c.surchargeCents, baseCents: c.feesCents,
        vatRateBp: c.lineVatRateBp, withholding: c.withholdingApplied, nature: c.lineNature,
      } : null,
      totalCents: c.totalCents, causali: [...s.texts.causali],
      linked: s.docType === "TD04" && s.credited ? { number: s.credited.numberLabel, date: s.credited.issueDate } : null,
    },
    lines: s.lines.map((line) => ({
      number: line.lineNumber, description: line.description, quantity: line.quantity,
      unitPrice: xmlUnitPrice(line.netTotalCents, line.quantity), totalCents: line.netTotalCents,
      vatRateBp: line.vatRateBp, withholding: line.subjectToWithholding, nature: line.nature,
    })),
    summary,
    payment: s.docType === "TD04" ? null : {
      method: PAYMENT_CODES[s.payment.method], amountCents: c.netCents,
      dueDate: bank ? s.payment.dueDate : null, beneficiary: bank ? s.payment.beneficiary : null,
      iban: bank ? s.payment.iban : null,
    },
  };
}
