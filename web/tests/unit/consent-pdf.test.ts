import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { APP_NAME } from "@/lib/config/app";
import { renderConsent } from "@/lib/consents/render";
import type { ConsentDocumentData } from "@/server/pdf/consent";
import { renderConsentPdf } from "@/server/pdf/render";
import { pdfText } from "../support/pdf-text";

// Il PDF del consenso: testo congelato, firme, data e ora della fotografia,
// versione e dati mancanti; "DATI DI PROVA" su ogni pagina in demo; nessun marchio del prodotto.
// La stampa senza firma non dichiara una firma. Il testo si legge con pdfjs-dist, pagina per pagina.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const PDF_MAGIC = "%PDF-";
const flat = (text: string) => text.replace(/\s+/g, " ");

const body = renderConsent("trattamento", {
  "studio.nome": "Studio Osteopatico di prova", "studio.indirizzo": "Via delle Prove 7, 40121, Bologna, BO",
  "osteopata.nome_completo": "Laura Benedetti", "osteopata.iscrizione": "iscrizione all'albo TSRM PSTRP di Bologna, n. 0000",
  "polizza.compagnia": "Assicurazioni di Prova", "polizza.numero": "POL-2026-0042", "polizza.massimale": "100000000",
  "paziente.nome_completo": "Marco Prova", "paziente.data_nascita": "1990-01-01", "paziente.codice_fiscale": null,
  "listino.prima_visita": "7000", "listino.seduta": "5500", "listino.controllo": "4500",
  "documento.data": "2026-11-04", "documento.luogo": "Bologna",
}).text;
const signedText = `${body}\n\nPromemoria e comunicazioni su WhatsApp: Sì\nRicontatto per i controlli periodici: No\n04/11/2026, Bologna`;

function data(extra: Partial<ConsentDocumentData> = {}): ConsentDocumentData {
  return {
    mode: "signed", text: signedText, signerName: "Marco Prova", secondGuardianName: null,
    signedOn: "2026-11-04", signedAt: "2026-11-04T08:45:00.000Z", place: "Bologna",
    signaturePng: new Uint8Array(PNG), secondSignaturePng: null, practitionerSignaturePng: new Uint8Array(PNG),
    demo: true, version: "2026.1", missingLabels: ["codice fiscale del paziente"], ...extra,
  };
}

/** Il testo di ogni pagina, separato. */
async function pages(bytes: Uint8Array): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false });
  try {
    const doc = await task.promise;
    const out: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      out.push(flat(content.items.map((item) => ("str" in item ? item.str : "")).join(" ")));
    }
    return out;
  } finally {
    await task.destroy();
  }
}

describe("renderConsentPdf", () => {
  it("pdf_completo", async () => {
    const bytes = new Uint8Array(await renderConsentPdf(data()));
    expect(Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString("latin1")).toBe(PDF_MAGIC);
    expect(bytes.length).toBeGreaterThan(1024);
    const { text: raw, info } = await pdfText(bytes);
    const text = flat(raw);
    for (const wanted of [
      "Marco Prova", "POL-2026-0042", "Benefici, rischi e reazioni",
      "Promemoria e comunicazioni su WhatsApp: Sì", "Ricontatto per i controlli periodici: No",
      "Versione del modulo 2026.1", "Firmato con dati mancanti: codice fiscale del paziente.",
      "Firmato a Bologna il 04/11/2026 alle 09:45.", "Firma di Marco Prova", "Firma dell'osteopata",
    ]) expect(text).toContain(wanted);
    expect(text).not.toContain("Secondo genitore");
    for (const value of [text, ...Object.values(info)]) expect(value).not.toContain(APP_NAME);
    const perPage = await pages(bytes);
    expect(perPage.length).toBeGreaterThan(1);
    for (const page of perPage) expect(page).toContain("DATI DI PROVA");

    const second = flat((await pdfText(new Uint8Array(await renderConsentPdf(data({
      secondGuardianName: "Andrea Prova", secondSignaturePng: new Uint8Array(PNG), missingLabels: [], demo: false, signedAt: null,
    }))))).text);
    expect(second).toContain("Firma del secondo genitore, Andrea Prova");
    expect(second).toContain("Firmato a Bologna il 04/11/2026.");
    expect(second).not.toContain("dati mancanti");
    expect(second).not.toContain("DATI DI PROVA");

    const blank = new Uint8Array(await renderConsentPdf(data({
      mode: "blank", text: body, signaturePng: null, practitionerSignaturePng: null, signedAt: null,
    })));
    const blankText = flat((await pdfText(blank)).text);
    expect(blankText).toContain("POL-2026-0042");
    expect(blankText).toContain("Dati da completare: codice fiscale del paziente.");
    expect(blankText).toContain("Firma di Marco Prova");
    expect(blankText).not.toMatch(/Firmat/);
  });
});
