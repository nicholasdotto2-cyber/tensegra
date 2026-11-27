import { dayField, money } from "@/lib/format";
import { STAMP_CENTS } from "./amounts";
import type { InvoiceComputation } from "./calc";
import { fillLegal, legalText, RIVALSA_PDF, type LegalKey } from "./references";
import { DEFAULT_RATES, type DocType, type Nature, type PaymentMethod, type RecipientKind, type Regime } from "./types";

export interface SnapshotAddress {
  line: string;
  postalCode: string;
  city: string;
  province: string | null;
  country: string;
}

export interface SnapshotLine {
  lineNumber: number;
  kind: "prestazione" | "rimborso_bollo";
  serviceId: string | null;
  appointmentId: string | null;
  description: string;
  serviceDate: string | null;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  netTotalCents: number;
  vatRateBp: number;
  nature: Nature | null;
  subjectToWithholding: boolean;
}

export interface InvoiceSnapshot {
  version: 1;
  isDemo: boolean;
  docType: DocType;
  numberLabel: string;
  issueDate: string;
  regime: Regime;
  electronic: boolean;
  supplier: {
    firstName: string; lastName: string; practiceName: string; taxCode: string; vatNumber: string;
    address: SnapshotAddress;
    registration: {
      kind: "nessuna" | "in_attesa" | "ese" | "albo";
      order: string | null; province: string | null; number: string | null; date: string | null;
    };
  };
  recipient: {
    kind: RecipientKind; firstName: string | null; lastName: string | null; name: string | null;
    taxCode: string | null; vatNumber: string | null; address: SnapshotAddress;
    recipientCode: string; pec: string | null; minorName: string | null;
  };
  computation: InvoiceComputation;
  lines: SnapshotLine[];
  payment: {
    method: PaymentMethod; paidOn: string | null; dueDate: string | null;
    iban: string | null; beneficiary: string | null;
  };
  texts: {
    causali: string[]; references: Partial<Record<Nature, string>>;
    pdf: string[]; footer: string; confirmed: boolean;
  };
  credited: { numberLabel: string; issueDate: string } | null;
  transmission: { progressive: string; fileName: string } | null;
  stampMarkCode: string | null;
}

export type SnapshotInput = Omit<InvoiceSnapshot, "version" | "electronic" | "lines" | "texts"> & {
  lines: readonly {
    serviceId: string | null; appointmentId: string | null; description: string;
    serviceDate: string | null; quantity: number; unitPriceCents: number;
  }[];
  paperStampAuthorization: string | null;
};

export const stampLineDescription = "Rimborso imposta di bollo";

export function isElectronic(regime: Regime, kind: RecipientKind): boolean {
  return regime !== "esente_sanitario" || kind === "committente";
}

/** Copia i dati e i testi scelti per data: le successive modifiche all'anagrafica non entrano qui. */
export function buildSnapshot(input: SnapshotInput): InvoiceSnapshot {
  const { lines: sourceLines, paperStampAuthorization, ...base } = structuredClone(input);
  const c = base.computation;
  if (c.lineNetCents.length !== sourceLines.length) {
    throw new Error("Il numero dei netti calcolati non corrisponde al numero delle righe della fattura.");
  }
  const electronic = isElectronic(base.regime, base.recipient.kind);
  let confirmed = true;
  const text = (key: LegalKey): string => {
    const chosen = legalText(key, base.issueDate);
    confirmed = confirmed && chosen.confirmed;
    return chosen.text;
  };
  const causali: string[] = [];
  const pdf: string[] = [];
  const references: Partial<Record<Nature, string>> = {};
  if (base.docType === "TD04" && base.credited) {
    causali.push(`Storno totale fattura ${base.credited.numberLabel} del ${dayField(base.credited.issueDate)}`);
  }
  if (base.regime === "forfettario") {
    causali.push(text("forfettario_dicitura"), text("forfettario_no_ritenuta"));
    references["N2.2"] = text("forfettario_xml");
    pdf.push(...causali);
  } else if (base.regime === "esente_sanitario") {
    references.N4 = text("esente_xml");
    pdf.push(`Operazione esente: ${references.N4}`);
  }
  if (c.surchargeApplied) pdf.push(RIVALSA_PDF);
  if (c.withholdingApplied) {
    const amount = (cents: number) => money(cents).replace(/\s*€$/, "");
    pdf.push(`Ritenuta d'acconto ${DEFAULT_RATES.withholdingBp / 100}% su ${amount(c.taxableCents + c.stampChargedCents)}: ${amount(c.withholdingCents)}. Netto a pagare ${amount(c.netCents)}`);
  }
  if (c.stampDue) {
    pdf.push(electronic ? text("bollo_virtuale_pdf") : paperStampAuthorization
      ? fillLegal(text("bollo_virtuale_autorizzato_pdf"), { paper_stamp_authorization: paperStampAuthorization })
      : fillLegal(text("bollo_contrassegno_pdf"), { stamp_mark_code: base.stampMarkCode || "________" }));
    pdf.push(`Imposta di bollo ${money(STAMP_CENTS).replace(/\s/g, " ")}`);
  }
  if (!electronic && base.payment.paidOn && base.payment.paidOn < base.issueDate) {
    pdf.push(`Data dell'operazione (pagamento): ${dayField(base.payment.paidOn)}`);
  }
  // Il footer sceglie la versione normativa anche quando non compare sul PDF analogico.
  const courtesy = text("copia_cortesia_pdf");
  const lines: SnapshotLine[] = sourceLines.map((line, i) => ({
    ...line, lineNumber: i + 1, kind: "prestazione", lineTotalCents: line.quantity * line.unitPriceCents,
    netTotalCents: c.lineNetCents[i]!, vatRateBp: c.lineVatRateBp, nature: c.lineNature,
    subjectToWithholding: c.withholdingApplied,
  }));
  if (c.stampCharged) {
    lines.push({
      lineNumber: lines.length + 1, kind: "rimborso_bollo", serviceId: null, appointmentId: null,
      description: stampLineDescription, serviceDate: null, quantity: 1,
      unitPriceCents: c.stampChargedCents, lineTotalCents: c.stampChargedCents, netTotalCents: c.stampChargedCents,
      vatRateBp: c.lineVatRateBp, nature: c.lineNature, subjectToWithholding: c.withholdingApplied,
    });
  }
  return {
    ...base, version: 1, electronic, lines,
    payment: { ...base.payment,
      iban: base.payment.method === "bonifico" ? base.payment.iban : null,
      beneficiary: base.payment.method === "bonifico" ? base.payment.beneficiary : null,
    },
    texts: { causali, references, pdf, footer: electronic ? courtesy : "Fattura emessa in formato analogico", confirmed },
  };
}
