import { describe, expect, it } from "vitest";
import { computeInvoice } from "@/lib/fiscal/calc";
import { toFatturaModel, xmlAmount, xmlPercent, xmlQuantity, xmlUnitPrice } from "@/lib/fiscal/model";
import { emissionProblems, FOREIGN_PATIENT } from "@/lib/fiscal/problems";
import { RIVALSA_PDF } from "@/lib/fiscal/references";
import { buildSnapshot, type InvoiceSnapshot, type SnapshotInput } from "@/lib/fiscal/snapshot";
import { DEFAULT_RATES } from "@/lib/fiscal/types";
import { VAT_INVALID } from "@/lib/fiscal/validators";
import { CASES } from "../support/fiscal-cases";

function input(s: InvoiceSnapshot): SnapshotInput {
  return { ...structuredClone(s), lines: s.lines.filter((l) => l.kind === "prestazione"), paperStampAuthorization: null };
}

describe("Fotografia e modello fiscale", () => {
  it("F2 congela righe, testi e rimborso del bollo con la natura della prestazione", () => {
    const s = CASES.F2;
    expect(s.lines.map((l) => [l.lineTotalCents, l.netTotalCents, l.nature, l.kind])).toEqual([
      [7000, 7000, "N2.2", "prestazione"], [5500, 5500, "N2.2", "prestazione"], [200, 200, "N2.2", "rimborso_bollo"],
    ]);
    const texts = [
      "Operazione effettuata ai sensi dell'art. 1, commi da 54 a 89, L. 190/2014, regime forfettario.",
      "Compenso non soggetto a ritenuta d'acconto ai sensi dell'art. 1, c. 67, L. 190/2014.",
    ];
    expect(s.texts.causali).toEqual(texts);
    expect(s.texts.references["N2.2"]).toBe("Operazione in franchigia da IVA, art. 1 c. 54-89 L. 190/2014");
    expect(s.texts.pdf).toEqual(expect.arrayContaining([...texts,
      "Imposta di bollo assolta in modo virtuale ai sensi dell'art. 6 del DM 17 giugno 2014.", "Imposta di bollo 2,00 €",
    ]));
    expect(s.texts.footer).toBe("Copia di cortesia. L'originale della fattura elettronica è a disposizione nella sua area riservata del sito web dell'Agenzia delle Entrate.");
    const m = toFatturaModel(s);
    expect(m.summary).toEqual([{ vatRateBp: 0, nature: "N2.2", taxableCents: 12700, vatCents: 0, esigibilita: null, reference: s.texts.references["N2.2"] }]);
    expect(m.document).toMatchObject({ stampCents: 200, totalCents: 12700 });
    expect(m.payment).toEqual({ method: "MP01", amountCents: 12700, dueDate: null, beneficiary: null, iban: null });
    expect(m.supplier).toMatchObject({ regimeCode: "RF19", albo: null });
  });

  it.each([{ lineNetCents: [7000] }, { lineNetCents: [7000, 5500, 200] }])("rifiuta netti calcolati non corrispondenti alle righe: $lineNetCents", ({ lineNetCents }) => {
    const i = input(CASES.F2);
    i.computation.lineNetCents = lineNetCents;
    expect(() => buildSnapshot(i)).toThrowError(new Error("Il numero dei netti calcolati non corrisponde al numero delle righe della fattura."));
  });

  it("O1 scorpora il netto e rappresenta il prezzo unitario con la precisione richiesta", () => {
    const m = toFatturaModel(CASES.O1);
    expect(m.lines[0]).toMatchObject({ unitPrice: "45.08", totalCents: 4508 });
    expect(m.summary).toEqual([{ vatRateBp: 2200, nature: null, taxableCents: 4508, vatCents: 992, esigibilita: "I", reference: null }]);
    const i = input(CASES.O1);
    i.lines = [{ ...i.lines[0]!, quantity: 3, unitPriceCents: 5500 }];
    i.computation = computeInvoice({ regime: "ordinario", recipientKind: "paziente", withholdingAgent: false, rates: DEFAULT_RATES, lines: i.lines });
    expect(toFatturaModel(buildSnapshot(i)).lines[0]).toMatchObject({ unitPrice: "45.08333333", totalCents: 13525 });
    expect(xmlAmount(12700)).toBe("127.00");
    expect(xmlPercent(2200)).toBe("22.00");
    expect(xmlQuantity(1)).toBe("1.00");
    expect(xmlUnitPrice(13525, 3)).toBe("45.08333333");
  });

  it("O4 rappresenta cassa, ritenuta e pagamento al netto", () => {
    const m = toFatturaModel(CASES.O4);
    expect(m.document.withholding).toEqual({ amountCents: 11440, rateBp: 2000 });
    expect(m.document.pension).toEqual({ rateBp: 400, amountCents: 2200, baseCents: 55000, vatRateBp: 2200, withholding: true, nature: null });
    expect(m.summary[0]).toMatchObject({ taxableCents: 57200, vatCents: 12584 });
    expect(m.payment).toEqual({ method: "MP05", amountCents: 58344, dueDate: "2026-10-27", beneficiary: "Chiara Esempio", iban: "IT80N0000001000000000123456" });
    expect(m.recipientCode).toBe("ABC1234");
    expect(m.document.causali).toEqual([]);
    expect(CASES.O4.texts.pdf).toEqual(expect.arrayContaining(["Ritenuta d'acconto 20% su 572,00: 114,40. Netto a pagare 583,44", RIVALSA_PDF]));
  });

  it("F3 somma la cassa al riepilogo N2.2", () => {
    const m = toFatturaModel(CASES.F3);
    expect(m.document.pension).toEqual({ rateBp: 400, amountCents: 280, baseCents: 7000, vatRateBp: 0, withholding: false, nature: "N2.2" });
    expect(m.summary[0]).toMatchObject({ nature: "N2.2", taxableCents: 7280 });
  });

  it("E1 è analogica e conserva data operazione e segnaposto del contrassegno", () => {
    expect(CASES.E1.electronic).toBe(false);
    expect(CASES.E1.texts.footer).toBe("Fattura emessa in formato analogico");
    expect(CASES.E1.texts.pdf).toContain("Imposta di bollo assolta sull'originale, contrassegno n. ________.");
    const i = input(CASES.E1);
    i.payment.paidOn = "2026-10-10";
    expect(buildSnapshot(i).texts.pdf).toContain("Data dell'operazione (pagamento): 10/10/2026");
  });

  it("NC1 mantiene bollo, importi e collegamento senza pagamento", () => {
    expect(CASES.NC1.docType).toBe("TD04");
    expect(CASES.NC1.texts.causali[0]).toBe("Storno totale fattura 2/2026 del 12/10/2026");
    expect(toFatturaModel(CASES.NC1).document).toMatchObject({ linked: { number: "2/2026", date: "2026-10-12" }, stampCents: 200 });
    expect(toFatturaModel(CASES.NC1).payment).toBeNull();
  });

  it("i testi del 2027 restano da confermare", () => {
    expect(buildSnapshot({ ...input(CASES.F2), issueDate: "2027-01-15" }).texts.confirmed).toBe(false);
  });
});

describe("Problemi prima dell'emissione", () => {
  it("X2 richiede il numero albo in Basic Latin stampabile solo nell'XML", () => {
    const s = structuredClone(CASES.F2);
    s.supplier.registration = { ...s.supplier.registration, kind: "albo", order: "Ordine di prova", number: "n° 123", province: "BO" };
    for (const number of ["n° 123", "è123", "12\t3"]) {
      s.supplier.registration.number = number;
      expect(emissionProblems(s)).toContainEqual({
        field: "supplier.registration.number",
        message: 'Scrivi il numero di iscrizione all\'albo senza simboli, per esempio "123", in Impostazioni, Fisco.',
        href: "/impostazioni/fisco",
      });
    }
    s.supplier.registration.number = "123";
    expect(emissionProblems(s)).toEqual([]);
    s.supplier.registration.number = "n° 123";
    s.supplier.registration.kind = "ese";
    expect(emissionProblems(s)).toEqual([]);
    s.supplier.registration.kind = "albo";
    s.electronic = false;
    expect(emissionProblems(s)).toEqual([]);
  });

  it("X1 controlla il beneficiario solo per il bonifico elettronico", () => {
    const s = structuredClone(CASES.F2);
    s.payment = { ...s.payment, method: "bonifico", iban: "IT80N0000001000000000123456", beneficiary: "Nguyễn" };
    expect(emissionProblems(s)).toContainEqual({
      field: "payment.beneficiary",
      message: "L'intestatario del conto contiene una lettera che la fattura elettronica non accetta: correggila in Impostazioni",
      href: "/impostazioni/fisco",
    });
    s.payment.beneficiary = "a".repeat(201);
    expect(emissionProblems(s).some((p) => p.field === "payment.beneficiary")).toBe(true);
    s.payment.method = "carta";
    expect(emissionProblems(s).some((p) => p.field === "payment.beneficiary")).toBe(false);
    s.payment.method = "bonifico";
    s.electronic = false;
    expect(emissionProblems(s).some((p) => p.field === "payment.beneficiary")).toBe(false);
    // La nota di credito copia il pagamento ma il suo XML non ha DatiPagamento: non si blocca.
    s.electronic = true;
    s.payment.beneficiary = "Nguyễn";
    s.docType = "TD04";
    expect(emissionProblems(s).some((p) => p.field === "payment.beneficiary")).toBe(false);
  });

  it("F2 non ha problemi", () => { expect(emissionProblems(CASES.F2)).toEqual([]); });

  it("il CF del paziente mancante produce un solo problema senza duplicato SdI", () => {
    const s = structuredClone(CASES.F2);
    s.recipient.taxCode = null;
    expect(emissionProblems(s)).toEqual([
      { field: "recipient.taxCode", message: "Codice fiscale del paziente mancante", href: null },
    ]);
  });

  const cases: [string, (s: InvoiceSnapshot) => void, string, string, string | null][] = [
    ["CF paziente", (s) => { s.recipient.taxCode = null; }, "recipient.taxCode", "Codice fiscale del paziente mancante", null],
    ["CAP", (s) => { s.recipient.address.postalCode = "3712"; }, "recipient.address", "Indirizzo del paziente incompleto: servono indirizzo, CAP di 5 cifre, città e provincia.", null],
    ["Latin-1", (s) => { s.recipient.lastName = "Nguyễn"; }, "recipient.lastName", "Il cognome del paziente contiene una lettera che la fattura elettronica non accetta: correggila in anagrafica", null],
    ["estero", (s) => { s.recipient.address.country = "FR"; }, "recipient.address.country", FOREIGN_PATIENT, null],
    ["CF tutore", (s) => { s.recipient.kind = "tutore"; s.recipient.taxCode = null; }, "recipient.taxCode", "Codice fiscale del genitore mancante", null],
    ["identità committente", (s) => { s.recipient = { ...CASES.O4.recipient, taxCode: null, vatNumber: null }; }, "recipient.taxCode", "Partita IVA o codice fiscale del committente mancante", null],
    ["P.IVA studio", (s) => { s.supplier.vatNumber = ""; }, "supplier.vatNumber", "Manca la partita IVA dello studio: completala in Impostazioni, Fisco.", "/impostazioni/fisco"],
    ["P.IVA non valida", (s) => { s.supplier.vatNumber = "01234560008"; }, "supplier.vatNumber", VAT_INVALID, "/impostazioni/fisco"],
    ["IBAN", (s) => { s.payment.method = "bonifico"; s.payment.iban = null; }, "payment.iban", "Per il bonifico serve l'IBAN dello studio: completalo in Impostazioni, Fisco.", "/impostazioni/fisco"],
    ["totale zero", (s) => { s.computation.totalCents = 0; }, "computation.totalCents", "Il totale è zero: aggiungi una riga con un importo.", null],
    ["lunghezza cognome", (s) => { s.recipient.lastName = "a".repeat(61); }, "recipient.lastName", "Il cognome del paziente è troppo lungo per la fattura elettronica (massimo 60 caratteri).", null],
  ];
  it.each(cases)("segnala %s", (_, mutate, field, message, href) => {
    const s = structuredClone(CASES.F2);
    mutate(s);
    expect(emissionProblems(s)).toContainEqual({ field, message, href });
  });
});
