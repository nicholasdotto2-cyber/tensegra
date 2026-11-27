import { computeInvoice, type CalcInput } from "@/lib/fiscal/calc";
import { numberLabel, xmlFileName } from "@/lib/fiscal/numbering";
import { buildSnapshot, isElectronic, type InvoiceSnapshot, type SnapshotInput } from "@/lib/fiscal/snapshot";
import { DEFAULT_RATES } from "@/lib/fiscal/types";

const twoLines = [{ quantity: 1, unitPriceCents: 7000 }, { quantity: 1, unitPriceCents: 5500 }];
const tenSessions = [{ quantity: 10, unitPriceCents: 5500 }];
const surcharge = { ...DEFAULT_RATES, inpsSurchargeEnabled: true };

function makeCase(overrides: Partial<CalcInput> = {}, bankTransfer = false): InvoiceSnapshot {
  const calc: CalcInput = {
    regime: "forfettario", recipientKind: "paziente", withholdingAgent: false,
    rates: { ...DEFAULT_RATES }, lines: [{ quantity: 1, unitPriceCents: 5500 }], ...overrides,
  };
  const company = calc.recipientKind === "committente";
  const input: SnapshotInput = {
    isDemo: false, docType: "TD01", numberLabel: numberLabel("TD01", 2, 2026),
    issueDate: "2026-10-12", regime: calc.regime,
    supplier: {
      firstName: "Chiara", lastName: "Esempio", practiceName: "Studio Esempio",
      taxCode: "SMPCHR85M41X999B", vatNumber: "01234560009",
      address: { line: "Via del Modello 3", postalCode: "37100", city: "Verona", province: "VR", country: "IT" },
      registration: { kind: "ese", order: null, province: "VR", number: "0000", date: null },
    },
    recipient: {
      kind: calc.recipientKind, firstName: company ? null : "Marco", lastName: company ? null : "Prova",
      name: company ? "Polisportiva Esempio SSD a r.l." : null,
      taxCode: company ? "09876540007" : "PRVMRC90A01X999S", vatNumber: company ? "09876540007" : null,
      address: company
        ? { line: "Via dello Stadio 5", postalCode: "37138", city: "Verona", province: "VR", country: "IT" }
        : { line: "Via Esempio 3", postalCode: "37121", city: "Verona", province: "VR", country: "IT" },
      recipientCode: company ? "ABC1234" : "0000000", pec: null, minorName: null,
    },
    computation: computeInvoice(calc),
    lines: calc.lines.map((line) => ({
      ...line, serviceId: null, appointmentId: null, serviceDate: "2026-10-12",
      description: company ? "Trattamento osteopatico atleti, ottobre 2026"
        : line.unitPriceCents === 7000 ? "Prima visita osteopatica"
          : line.unitPriceCents === 8000 ? "Prima visita osteopatica"
            : line.unitPriceCents === 4500 ? "Controllo osteopatico" : "Trattamento osteopatico",
    })),
    payment: {
      method: bankTransfer ? "bonifico" : "contanti", paidOn: bankTransfer ? null : "2026-10-12",
      dueDate: bankTransfer ? "2026-10-27" : null, iban: bankTransfer ? "IT80N0000001000000000123456" : null,
      beneficiary: bankTransfer ? "Chiara Esempio" : null,
    },
    credited: null, stampMarkCode: null, paperStampAuthorization: null,
    transmission: isElectronic(calc.regime, calc.recipientKind)
      ? { progressive: "00002", fileName: xmlFileName("SMPCHR85M41X999B", "00002") } : null,
  };
  return buildSnapshot(input);
}

const F2 = makeCase({ lines: twoLines });

export const CASES: Record<"F1" | "F2" | "F2b" | "F3" | "F4" | "F5" | "O1" | "O2" | "O3" | "O4" | "E1" | "NC1" | "S1" | "S2" | "S3" | "S4" | "S5", InvoiceSnapshot> = {
  F1: makeCase(), F2,
  F2b: makeCase({ lines: twoLines, rates: { ...DEFAULT_RATES, stampChargedToClient: false } }),
  F3: makeCase({ lines: [{ quantity: 1, unitPriceCents: 7000 }], rates: surcharge }),
  F4: makeCase({ lines: [{ quantity: 1, unitPriceCents: 7500 }], rates: surcharge }),
  F5: makeCase({ recipientKind: "committente", withholdingAgent: true, lines: tenSessions }),
  O1: makeCase({ regime: "ordinario" }),
  O2: makeCase({ regime: "ordinario", lines: [{ quantity: 1, unitPriceCents: 7000 }] }),
  O3: makeCase({ regime: "ordinario", lines: [{ quantity: 1, unitPriceCents: 7000 }], rates: surcharge }),
  O4: makeCase({ regime: "ordinario", recipientKind: "committente", withholdingAgent: true, rates: surcharge, lines: tenSessions }, true),
  E1: makeCase({ regime: "esente_sanitario", lines: twoLines }),
  NC1: buildSnapshot({
    ...F2, docType: "TD04", numberLabel: "NC-1/2026", issueDate: "2026-10-20",
    credited: { numberLabel: "2/2026", issueDate: "2026-10-12" },
    lines: F2.lines.filter((line) => line.kind === "prestazione"), paperStampAuthorization: null,
  }),
  S1: makeCase({ lines: [{ quantity: 1, unitPriceCents: 8000 }] }),
  S2: makeCase(), S3: makeCase({ lines: [{ quantity: 1, unitPriceCents: 4500 }] }),
  S4: makeCase({ recipientKind: "committente", withholdingAgent: true, lines: [{ quantity: 4, unitPriceCents: 5500 }] }, true),
  S5: makeCase({ regime: "ordinario" }),
};
