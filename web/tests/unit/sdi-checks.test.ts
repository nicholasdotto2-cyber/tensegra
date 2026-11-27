import { describe, expect, it } from "vitest";
import { toFatturaModel, type FatturaModel } from "@/lib/fiscal/model";
import { emissionProblems } from "@/lib/fiscal/problems";
import { sdiChecks, type SdiCode } from "@/lib/fiscal/sdi-checks";
import { CASES } from "../support/fiscal-cases";

describe("Controlli SdI locali", () => {
  it.each(Object.entries(CASES))("%s passa tutti i controlli", (_, s) => {
    expect(sdiChecks(toFatturaModel(s))).toEqual([]);
  });

  const failures: [SdiCode, keyof typeof CASES, (m: FatturaModel) => void, string][] = [
    ["00400", "F2", (m) => { m.lines[0]!.nature = null; }, "riga con aliquota zero senza natura"],
    ["00401", "O1", (m) => { m.lines[0]!.nature = "N2.2"; }, "riga con natura e aliquota diversa da zero"],
    ["00411", "O4", (m) => { m.document.withholding = null; }, "riga con ritenuta senza dati della ritenuta"],
    ["00413", "F3", (m) => { m.document.pension!.nature = null; }, "cassa con aliquota zero senza natura"],
    ["00415", "O4", (m) => { m.document.withholding = null; }, "cassa con ritenuta senza dati della ritenuta"],
    ["00417", "F2", (m) => { m.customer.taxCode = null; m.customer.vatNumber = null; }, "destinatario senza codice fiscale né partita IVA"],
    ["00421", "O1", (m) => { m.summary[0]!.vatCents += 2; }, "imposta del riepilogo non corretta"],
    ["00422", "F2", (m) => { m.summary[0]!.taxableCents += 1; }, "imponibile del riepilogo diverso dalla somma delle righe e della cassa"],
    ["00423", "O1", (m) => { m.lines[0]!.unitPrice = "45.07"; }, "prezzo totale della riga non corretto"],
    ["00424", "O1", (m) => { m.lines[0]!.vatRateBp = 22; }, "aliquota IVA espressa in modo non corretto"],
    ["00425", "F2", (m) => { m.document.number = "NC-A/AAAA"; }, "numero del documento senza cifre"],
    ["00427", "F2", (m) => { m.recipientCode = "ABC123"; }, "codice destinatario di 6 caratteri con FPR12"],
    ["00429", "F2", (m) => { m.summary[0]!.nature = null; }, "riepilogo con aliquota zero senza natura"],
    ["00430", "O1", (m) => { m.summary[0]!.nature = "N2.2"; }, "riepilogo con natura e aliquota diversa da zero"],
    ["00443", "F2", (m) => { m.lines[0]!.nature = "N4"; }, "aliquota o natura della riga assente dal riepilogo"],
    ["00444", "F2", (m) => { m.summary.push({ ...m.summary[0]!, nature: "N4", taxableCents: 0 }); }, "riepilogo senza righe con la sua aliquota e natura"],
    ["00445", "F2", (m) => { m.lines[0]!.nature = "N2"; }, "natura generica N2, N3 o N6 non ammessa"],
    ["00471", "O4", (m) => { m.customer.vatNumber = m.supplier.vatNumber; }, "cedente e cessionario con la stessa partita IVA"],
  ];
  it.each(failures)("rifiuta il modello guastato con %s", (code, source, mutate, text) => {
    const m = toFatturaModel(CASES[source]);
    mutate(m);
    expect(sdiChecks(m)).toContainEqual({ code, message: `Controllo SdI ${code}: ${text}` });
  });

  // L'IBAN mancante non deve nascondere un controllo SdI che resta anche cambiando metodo di pagamento.
  it("iban_non_nasconde_00471: senza i problemi di pagamento il controllo 00471 compare", () => {
    const s = { ...CASES.O4, recipient: { ...CASES.O4.recipient, vatNumber: CASES.O4.supplier.vatNumber },
      payment: { ...CASES.O4.payment, iban: null } };
    expect(emissionProblems(s).map((p) => p.field)).toContain("payment.iban");
    const unpaid = emissionProblems(s, { includePayment: false });
    expect(unpaid.some((p) => p.field.startsWith("payment."))).toBe(false);
    expect(unpaid).toContainEqual({ field: "sdi.00471", message: "Controllo SdI 00471: cedente e cessionario con la stessa partita IVA", href: null });
  });

  it("td04_no_pagamento: la nota di credito ha gli stessi controlli con e senza pagamento", () => {
    const s = { ...CASES.NC1, recipient: { ...CASES.F5.recipient, vatNumber: CASES.NC1.supplier.vatNumber },
      payment: { ...CASES.NC1.payment, method: "bonifico" as const, iban: null, beneficiary: null } };
    const all = emissionProblems(s);
    expect(all.some((p) => p.field.startsWith("payment."))).toBe(false);
    expect(all.map((p) => p.field)).toContain("sdi.00471");
    expect(emissionProblems(s, { includePayment: false })).toEqual(all);
    expect(emissionProblems(CASES.NC1, { includePayment: false })).toEqual([]);
  });
});
