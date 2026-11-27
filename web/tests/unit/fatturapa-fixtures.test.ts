import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReferralLetter } from "@/server/domain/referrals/queries";
import { renderReferralPdf } from "@/server/pdf/render";
import { pdfText } from "../support/pdf-text";
import { validateFatturaXml } from "../support/xsd";

const f2 = readFileSync(new URL("../fixtures/fatturapa/F2.xml", import.meta.url), "utf8");

const letter: ReferralLetter = {
  id: "a0000000-0000-4000-8000-000000000610",
  patientId: "a0000000-0000-4000-8000-000000000202",
  status: "bozza",
  statusLabel: "Bozza",
  editable: true,
  agreed: false,
  letterFileId: null,
  fileName: "lettera-medico-2026-11-04.pdf",
  studio: {
    name: "Studio Osteopatico di prova",
    lines: ["Via dei Mille 12, 40121 Bologna (BO)", "Iscrizione n. 1234, Ordine TSRM PSTRP di Bologna"],
  },
  recipient: { kind: "medico_curante", physicianId: null, free: null, text: "Dott. Mario Bianchi" },
  reason: "red_flag",
  urgency: "programmato",
  dayText: "Bologna, 04/11/2026",
  patient: { name: "Roberto Esposito", birthDateText: "nato il 12/03/1971" },
  summaryText:
    "Segnalo la comparsa di segni che richiedono una valutazione medica in Roberto Esposito, che seguo dal 14/10/2026 per Dolore dorsale e lombare, e chiedo una sua valutazione.\nNella visita del 14/10/2026 ho rilevato: Calo di peso non spiegato.\nDolore 0-10 a inizio seduta: 6.",
  requestText:
    "Le chiedo di valutare il paziente e, se lo ritiene, di indicarmi se proseguire il trattamento osteopatico.",
  signature: "Anna Rossi, Osteopata",
  demo: true,
  deliveredOn: null,
};

describe("fixture FatturaPA e strumenti di prova", () => {
  it("valida F2 con lo schema ufficiale e l'import della firma locale", async () => {
    expect(await validateFatturaXml(f2)).toEqual({ valid: true, errors: [] });
  });

  it("rifiuta l'apostrofo tipografico U+2019 nella descrizione", async () => {
    const original = "<Descrizione>Prima visita osteopatica</Descrizione>";
    expect(f2).toContain(original);
    const xml = f2.replace(original, "<Descrizione>Prima visita dell’osteopata</Descrizione>");
    const result = await validateFatturaXml(xml);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rifiuta la virgola nell'importo del bollo", async () => {
    const original = "<ImportoBollo>2.00</ImportoBollo>";
    expect(f2).toContain(original);
    const xml = f2.replace(original, "<ImportoBollo>2,00</ImportoBollo>");
    const result = await validateFatturaXml(xml);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("ammette sei caratteri per CodiceDestinatario nello schema, prima del controllo SdI 00427", async () => {
    const original = "<CodiceDestinatario>0000000</CodiceDestinatario>";
    expect(f2).toContain(original);
    const xml = f2.replace(original, "<CodiceDestinatario>000000</CodiceDestinatario>");
    expect(await validateFatturaXml(xml)).toEqual({ valid: true, errors: [] });
  });

  it("estrae il testo e il dizionario Info dal PDF compresso della lettera di prova", async () => {
    const result = await pdfText(await renderReferralPdf(letter));
    expect(result.text).toContain(letter.studio.name);
    expect(result.text).toContain("DATI DI PROVA");
    expect(result.info).toEqual(expect.any(Object));
  });
});
