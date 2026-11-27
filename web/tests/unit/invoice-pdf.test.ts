import { describe, expect, it, vi } from "vitest";
import * as model from "@/lib/fiscal/model";
import { legalText } from "@/lib/fiscal/references";
import type { InvoiceSnapshot } from "@/lib/fiscal/snapshot";
import { APP_NAME } from "@/lib/config/app";
import { renderInvoicePdf } from "@/server/pdf/render";
import { CASES } from "../support/fiscal-cases";
import { pdfText } from "../support/pdf-text";

// Il PDF di cortesia della fattura: react-pdf con l'Helvetica
// integrata, tutto dalla fotografia. Il testo si legge con pdfjs-dist (`pdfText`); a capo e spazi doppi
// dell'estrazione non contano, quindi si confronta il testo con gli spazi ridotti a uno.

// Il prezzo unitario del PDF è quello dell'XML: lo stesso `xmlUnitPrice`, qui solo osservato.
vi.mock("@/lib/fiscal/model", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/fiscal/model")>();
  return { ...original, xmlUnitPrice: vi.fn(original.xmlUnitPrice) };
});

const PDF_MAGIC = "%PDF-";
const DEMO_WATERMARK = "DATI DI PROVA. Non trasmessa al Sistema di Interscambio";

const flat = (text: string) => text.replace(/\s+/g, " ");

async function read(snapshot: InvoiceSnapshot, variant?: "copia" | "oscurata", standard?: readonly (string | null)[]) {
  const bytes = new Uint8Array(await renderInvoicePdf(snapshot, variant, standard));
  const { text, info } = await pdfText(bytes);
  return { bytes, text: flat(text), info };
}

describe("renderInvoicePdf", () => {
  it("F2 nasce come PDF e porta titolo, destinatario, bollo, copia di cortesia e nome dell'XML", async () => {
    const { bytes, text, info } = await read(CASES.F2);
    expect(Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString("latin1")).toBe(PDF_MAGIC);
    expect(bytes.length).toBeGreaterThan(1024);
    for (const wanted of [
      "Fattura n. 2/2026 del 12/10/2026",
      "Marco Prova",
      "PRVMRC90A01X999S",
      "Rimborso imposta di bollo",
      legalText("copia_cortesia_pdf", "2026-10-12").text,
      "File XML:",
      "Iscritto all'elenco speciale degli osteopati, Ordine TSRM PSTRP di VR, n. 0000",
      "Pagata il 12/10/2026 in contanti",
    ]) {
      expect(text).toContain(wanted);
    }
    expect(text).not.toContain("DATI DI PROVA");
    expect(info.Title).toBe("Fattura 2/2026");
    expect(info.Author).toBe("Chiara Esempio");
    expect(info.Subject).toBeUndefined();
  });

  it("con isDemo la filigrana dice che la fattura non è trasmessa", async () => {
    const { text } = await read({ ...CASES.F2, isDemo: true });
    expect(text).toContain(DEMO_WATERMARK);
  });

  it("NC1 scrive la nota di credito con lo storno della fattura", async () => {
    const { text, info } = await read(CASES.NC1);
    expect(text).toContain("Nota di credito n. NC-1/2026 del 20/10/2026, storno della fattura n. 2/2026 del 12/10/2026");
    expect(text).not.toContain("Pagata il");
    expect(text).not.toContain("Da pagare");
    expect(info.Title).toBe("Nota di credito NC-1/2026");
  });

  it("O4 mostra la ritenuta, il netto a pagare, il bonifico con IBAN e il codice destinatario", async () => {
    const { text } = await read(CASES.O4);
    expect(text).toContain("Ritenuta d'acconto 20% su 572,00: 114,40. Netto a pagare 583,44");
    expect(text).toContain("Da pagare con bonifico entro il 27/10/2026, IBAN IT80N0000001000000000123456");
    expect(text).toContain("Polisportiva Esempio SSD a r.l.");
    expect(text).toContain("09876540007");
    expect(text).toContain("ABC1234");
    expect(text).toContain("IVA 22%");
  });

  it("le righe stampano il netto e la colonna IVA dice 22%, Non soggetta o Esente", async () => {
    const ordinario = await read(CASES.O1);
    expect(ordinario.text).toContain("22%");
    expect(ordinario.text).toContain("45,08");
    expect((await read(CASES.F2)).text).toContain("Non soggetta");
    expect((await read(CASES.E1)).text).toContain("Esente");
  });

  it("esente verso persona fisica: copia analogica, senza nome di file XML", async () => {
    const { text } = await read(CASES.E1);
    expect(text).toContain("Fattura emessa in formato analogico");
    expect(text).not.toContain("File XML:");
  });

  it("nessun PDF contiene 'detraibile' né il nome del prodotto", async () => {
    for (const snapshot of Object.values(CASES)) {
      const { text, info } = await read({ ...snapshot, isDemo: true });
      expect(text.toLowerCase()).not.toContain("detraibile");
      expect(text).not.toContain(APP_NAME);
      expect(JSON.stringify(info)).not.toContain(APP_NAME);
    }
  });

  it("la rivalsa compare con la sua dicitura e solo le righe diverse da zero entrano nel riepilogo", async () => {
    const withSurcharge = await read(CASES.F4);
    expect(withSurcharge.text).toContain("Rivalsa INPS 4% (art. 1 c. 212 L. 662/1996)");
    const plain = await read(CASES.F1);
    expect(plain.text).not.toContain("Rivalsa INPS");
    expect(plain.text).not.toContain("Ritenuta d'acconto");
    expect(plain.text).not.toContain("Netto a pagare");
  });
});

describe("renderInvoicePdf, prezzo e diciture", () => {
  it("il prezzo unitario viene da xmlUnitPrice, a otto decimali quando la divisione non è esatta", async () => {
    const [first, ...others] = CASES.F2.lines;
    const snapshot: InvoiceSnapshot = { ...CASES.F2, lines: [{ ...first!, quantity: 3, netTotalCents: 10000 }, ...others] };
    vi.mocked(model.xmlUnitPrice).mockClear();
    const { text } = await read(snapshot);
    expect(model.xmlUnitPrice).toHaveBeenCalledWith(10000, 3);
    expect(text).toContain("33,33333333 €");
    expect(text).toContain("55,00 € 55,00 €");
  });

  it("la rivalsa e il bollo si scrivono una volta sola nel posto loro", async () => {
    const count = (text: string, part: string) => text.split(part).length - 1;
    const surcharge = await read(CASES.F4);
    expect(count(surcharge.text, "Rivalsa INPS 4%")).toBe(1);
    expect(surcharge.text).toContain("Rivalsa INPS 4% (art. 1 c. 212 L. 662/1996) 3,00 €");

    const charged = await read(CASES.F2);
    expect(count(charged.text, "Imposta di bollo assolta")).toBe(1);
    expect(count(charged.text, "Imposta di bollo 2,00")).toBe(0);
    expect(count(charged.text, "imposta di bollo 2,00 €")).toBe(1);

    const borne = await read(CASES.F2b);
    expect(count(borne.text, "Imposta di bollo assolta")).toBe(1);
    expect(count(borne.text, "Imposta di bollo 2,00")).toBe(1);

    const paper = await read(CASES.E1);
    expect(count(paper.text, "Imposta di bollo assolta sull'originale")).toBe(1);
    expect(count(paper.text, "Imposta di bollo 2,00")).toBe(0);
  });
});

describe("renderInvoicePdf, variante oscurata", () => {
  it("F2 non porta il paziente, il codice fiscale né l'indirizzo", async () => {
    const { text, info } = await read(CASES.F2, "oscurata");
    expect(text).toContain("Dati dell'assistito oscurati");
    expect(text).toContain("Destinatario: persona fisica");
    for (const forbidden of ["Marco", "Prova", "PRVMRC90A01X999S", "Via Esempio", "37121"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("Prestazione osteopatica");
    expect(text).not.toContain("Prima visita osteopatica");
    expect(text).toContain("Rimborso imposta di bollo");
    expect(JSON.stringify(info)).not.toContain("Marco");
    expect(info.Subject).toBeUndefined();
  });

  it("le descrizioni standard del listino prendono il posto di quelle scritte, il bollo resta", async () => {
    const { text } = await read(CASES.F2, "oscurata", ["Prima visita osteopatica standard", null]);
    expect(text).toContain("Prima visita osteopatica standard");
    expect(text).toContain("Prestazione osteopatica");
    expect(text).toContain("Rimborso imposta di bollo");
  });

  it("O4 non porta la polisportiva, la partita IVA, il codice destinatario né l'IBAN", async () => {
    const { text } = await read(CASES.O4, "oscurata");
    expect(text).toContain("Destinatario: soggetto IVA");
    for (const forbidden of ["Polisportiva", "09876540007", "ABC1234", "IT80N0000001000000000123456", "Via dello Stadio"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("Da pagare con bonifico entro il 27/10/2026");
    expect(text).toContain("Ritenuta d'acconto 20% su 572,00: 114,40. Netto a pagare 583,44");
  });

  it("con un minore intestato al genitore il nome del minore non esce", async () => {
    const guardian: InvoiceSnapshot = {
      ...CASES.F2,
      recipient: { ...CASES.F2.recipient, kind: "tutore", firstName: "Paolo", lastName: "Rossetti", minorName: "Martina Rossetti" },
    };
    const open = await read(guardian);
    expect(open.text).toContain("per Martina Rossetti");
    const redacted = await read(guardian, "oscurata");
    expect(redacted.text).not.toContain("Martina");
    expect(redacted.text).not.toContain("Paolo");
    expect(redacted.text).toContain("Destinatario: persona fisica");
  });
});
