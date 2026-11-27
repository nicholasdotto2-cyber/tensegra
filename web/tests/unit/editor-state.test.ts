import { describe, expect, it } from "vitest";
import { type EditorLine, type EditorState, regimeLabel, summaryRows, toDraftInput } from "@/lib/fiscal/editor-state";
import { money } from "@/lib/format";
import { CASES } from "../support/fiscal-cases";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const SERVICE = "22222222-2222-4222-8222-222222222222";
const APPOINTMENT = "33333333-3333-4333-8333-333333333333";

function line(overrides: Partial<EditorLine> = {}): EditorLine {
  return {
    key: "a", serviceId: SERVICE, appointmentId: APPOINTMENT, description: "Trattamento osteopatico",
    serviceDate: "2026-11-03", quantity: "1", price: "55,00", ...overrides,
  };
}

function state(lines: EditorLine[]): EditorState {
  return {
    invoiceId: null, recipient: { kind: "paziente", patientId: PATIENT }, lines,
    paymentMethod: "contanti", paid: true, paidOn: "2026-11-03", stampMarkCode: "", internalNotes: null,
  };
}

describe("stato dell'editor della fattura", () => {
  it("righe valide diventano l'input della bozza, prezzo in centesimi e quantità intera", () => {
    expect(toDraftInput(state([line(), line({ key: "b", serviceId: null, appointmentId: null,
      description: "Riga libera", serviceDate: null, quantity: "2", price: "80.5" })]))).toEqual({
      invoiceId: null, recipient: { kind: "paziente", patientId: PATIENT },
      lines: [
        { serviceId: SERVICE, appointmentId: APPOINTMENT, description: "Trattamento osteopatico",
          serviceDate: "2026-11-03", quantity: 1, unitPriceCents: 5500 },
        { serviceId: null, appointmentId: null, description: "Riga libera", serviceDate: null, quantity: 2, unitPriceCents: 8050 },
      ],
      paymentMethod: "contanti", paidOn: "2026-11-03", stampMarkCode: null, internalNotes: null,
    });
  });

  it("senza «Già incassata» la data dell'incasso non parte", () => {
    const result = toDraftInput({ ...state([line()]), paid: false });
    expect(result).toMatchObject({ paidOn: null });
  });

  it("una quantità non intera è un errore sotto il campo", () => {
    expect(toDraftInput(state([line({ quantity: "1,5" })]))).toEqual({
      errors: { "lines.0.quantity": "Scrivi una quantità intera, da 1 in su." },
    });
  });

  it("un prezzo che non si legge è un errore sotto il campo", () => {
    expect(toDraftInput(state([line({ price: "abc" })]))).toEqual({
      errors: { "lines.0.price": "Scrivi un importo, per esempio 55,00." },
    });
  });

  it("il riepilogo di O1 dice compenso, IVA e totale", () => {
    expect(summaryRows(CASES.O1.computation, "ordinario")).toEqual([
      { label: "Compenso", amount: money(4508) },
      { label: "IVA 22%", amount: money(992) },
      { label: "Totale", amount: money(5500) },
    ]);
    expect(money(4508)).toBe("45,08 €");
  });

  it("l'etichetta del regime", () => {
    expect(regimeLabel("forfettario")).toBe("Forfettario: niente IVA, bollo di 2 euro sopra 77,47 euro");
    expect(regimeLabel("ordinario")).toBe("Ordinario: IVA 22% compresa nel prezzo per i pazienti");
    expect(regimeLabel("esente_sanitario")).toBe("Esente: niente IVA, bollo di 2 euro sopra 77,47 euro");
  });
});
