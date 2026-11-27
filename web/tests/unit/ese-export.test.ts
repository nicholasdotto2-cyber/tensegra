import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { esePeriod, standardDescriptionsFor } from "@/lib/fiscal/redact";
import type { InvoiceSnapshot } from "@/lib/fiscal/snapshot";
import { buildEseZip, type EseDocument } from "@/server/pdf/ese-export";
import { renderInvoicePdf } from "@/server/pdf/render";
import { CASES } from "../support/fiscal-cases";
import { findForbidden, forbiddenStrings, type Person } from "../support/forbidden";
import { pdfText } from "../support/pdf-text";

// Export oscurato per l'elenco speciale: i PDF si rigenerano dalla fotografia e
// una ricerca per parola intera sul testo estratto prova che nessuna stringa dell'anagrafica sopravvive.

const GENERATED_AT = new Date("2026-11-04T08:30:00+01:00");
const FREE_LINE = "Seduta per Marco Prova";

const holderOf = (snapshot: InvoiceSnapshot): Person => ({
  firstName: snapshot.supplier.firstName, lastName: snapshot.supplier.lastName, name: snapshot.supplier.practiceName,
  taxCode: snapshot.supplier.taxCode, vatNumber: snapshot.supplier.vatNumber, addressLine: snapshot.supplier.address.line,
  postalCode: snapshot.supplier.address.postalCode, city: snapshot.supplier.address.city,
});

const personOf = (snapshot: InvoiceSnapshot): Person => ({
  firstName: snapshot.recipient.firstName, lastName: snapshot.recipient.lastName, name: snapshot.recipient.name,
  taxCode: snapshot.recipient.taxCode, vatNumber: snapshot.recipient.vatNumber,
  addressLine: snapshot.recipient.address.line, postalCode: snapshot.recipient.address.postalCode,
  city: snapshot.recipient.address.city,
});

// Quattro documenti con numeri e giorni propri: i casi del banco hanno tutti 2/2026 del 12/10.
const withNumber = (snapshot: InvoiceSnapshot, numberLabel: string, issueDate: string): InvoiceSnapshot => ({
  ...snapshot, numberLabel, issueDate,
});
const freeLine: InvoiceSnapshot = withNumber(
  { ...CASES.F1, lines: CASES.F1.lines.map((line) => ({ ...line, serviceId: null, description: FREE_LINE })) },
  "3/2026", "2026-10-13",
);
const DOCUMENTS: EseDocument[] = [
  { snapshot: CASES.F2, status: "pagata", paidOn: "2026-10-12", standardDescriptions: CASES.F2.lines.map(() => null) },
  { snapshot: freeLine, status: "emessa", paidOn: null, standardDescriptions: freeLine.lines.map(() => null) },
  {
    snapshot: withNumber(CASES.O4, "4/2026", "2026-10-14"), status: "emessa", paidOn: null,
    standardDescriptions: CASES.O4.lines.map(() => null),
  },
  { snapshot: CASES.NC1, status: "emessa", paidOn: null, standardDescriptions: CASES.NC1.lines.map(() => null) },
];

const flat = (text: string) => text.replace(/\s+/g, " ");

describe("buildEseZip", () => {
  it("lo ZIP ha LEGGIMI, indice e un PDF oscurato per documento, e nessuna stringa dell'anagrafica sopravvive", async () => {
    const zip = await buildEseZip({ from: "2026-10", to: "2026-10", generatedAt: GENERATED_AT, documents: DOCUMENTS });
    expect(zip.fileName).toBe("fatture-oscurate_2026-10_2026-10.zip");
    expect(zip.count).toBe(4);
    expect(zip.sha256).toMatch(/^[0-9a-f]{64}$/);

    const files = unzipSync(zip.bytes);
    const names = Object.keys(files).sort();
    expect(names).toEqual([
      "2026-10/2026-10-12_Fattura_2-2026.pdf",
      "2026-10/2026-10-13_Fattura_3-2026.pdf",
      "2026-10/2026-10-14_Fattura_4-2026.pdf",
      "2026-10/2026-10-20_NotaCredito_NC-1-2026.pdf",
      "LEGGIMI.txt",
      "indice.csv",
    ]);

    const readme = strFromU8(files["LEGGIMI.txt"]!);
    expect(readme.split("\n")).toEqual([
      "Fatture e note di credito con i dati degli assistiti oscurati.",
      "Periodo: da ottobre 2026 a ottobre 2026.",
      "Documenti: 4. Generato il 04/11/2026 alle 08:30.",
      "Regola di oscuramento:",
      '1. Nome, cognome e denominazione del destinatario sostituiti da "Dati dell\'assistito oscurati".',
      "2. Codice fiscale, partita IVA, indirizzo, codice destinatario, PEC e contatti del destinatario rimossi.",
      "3. Nome del minore rimosso; descrizioni delle righe sostituite con quella standard del listino.",
      "4. Causali libere, note e IBAN rimossi; restano le diciture del regime.",
      "5. Restano titolare, numero, data, importi, regime, data della prestazione, metodo e data del pagamento.",
      "",
    ]);

    const index = strFromU8(files["indice.csv"]!);
    const rows = index.trimEnd().split("\n");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toBe("mese;tipo;numero;data;totale;stato;data_incasso");
    expect(rows[1]).toBe("2026-10;Fattura;2/2026;12/10/2026;127,00;pagata;12/10/2026");
    expect(rows[4]).toMatch(/^2026-10;Nota di credito;NC-1\/2026;20\/10\/2026;\d+,\d{2};emessa;$/);

    const forbidden = forbiddenStrings(
      [personOf(CASES.F2), personOf(CASES.O4)],
      holderOf(CASES.F2),
      [CASES.O4.payment.iban!, CASES.O4.recipient.recipientCode],
    );
    expect(forbidden).toEqual(expect.arrayContaining([
      "Marco", "Prova", "PRVMRC90A01X999S", "Via Esempio 3", "Polisportiva Esempio SSD a r.l.", "09876540007",
      "Via dello Stadio 5", "IT80N0000001000000000123456", "ABC1234",
    ]));

    const texts: string[] = [readme, index, names.join("\n")];
    for (const name of names.filter((n) => n.endsWith(".pdf"))) {
      const { text, info } = await pdfText(files[name]!);
      texts.push(flat(text), JSON.stringify(info));
      if (name.includes("3-2026")) {
        expect(flat(text)).toContain("Prestazione osteopatica");
        expect(flat(text)).not.toContain(FREE_LINE);
      }
    }
    for (const text of texts) expect(findForbidden(text, forbidden)).toEqual([]);
  });

  it("controllo positivo: il PDF di copia di F2 contiene 'Marco', quindi l'estrattore e la ricerca funzionano", async () => {
    const copia = new Uint8Array(await renderInvoicePdf(CASES.F2, "copia"));
    const { text } = await pdfText(copia);
    expect(findForbidden(text, ["Marco", "PRVMRC90A01X999S"])).toEqual(["Marco", "PRVMRC90A01X999S"]);
  });

  it("findForbidden cerca parole intere, senza maiuscole né accenti", () => {
    expect(findForbidden("generico", ["Neri"])).toEqual([]);
    expect(findForbidden("Paolo Neri", ["neri"])).toEqual(["neri"]);
    expect(findForbidden("Città", ["citta"])).toEqual(["citta"]);
  });
});

describe("redact", () => {
  it("standardDescriptionsFor è allineata a snapshot.lines, bollo compreso", () => {
    const lines = CASES.F2.lines;
    expect(lines.map((line) => line.kind)).toEqual(["prestazione", "prestazione", "rimborso_bollo"]);
    const first = lines[0]!.serviceId;
    const withService = lines.map((line, i) => (i === 0 ? { ...line, serviceId: "s-1" } : line));
    expect(first).toBeNull();
    expect(standardDescriptionsFor(withService, new Map([["s-1", "Seduta di osteopatia"]]))).toEqual([
      "Seduta di osteopatia", null, null,
    ]);
    expect(standardDescriptionsFor(withService, new Map())).toEqual([null, null, null]);
  });

  it("esePeriod accetta fino a 24 mesi e dà primo e ultimo giorno", () => {
    expect(esePeriod("2026-10", "2026-10")).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(esePeriod("2026-02", "2028-01")).toEqual({ start: "2026-02-01", end: "2028-01-31" });
    expect(esePeriod("2026-12", "2026-12")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
    expect(esePeriod("2026-01", "2028-01")).toBeNull();
    expect(esePeriod("2026-10", "2026-09")).toBeNull();
    expect(esePeriod("2026-1", "2026-10")).toBeNull();
    expect(esePeriod("2026-13", "2026-13")).toBeNull();
  });
});
