import { readFileSync } from "node:fs";
import { convert, create } from "xmlbuilder2";
import { describe, expect, it } from "vitest";
import { APP_NAME } from "@/lib/config/app";
import { computeInvoice } from "@/lib/fiscal/calc";
import { toFatturaModel } from "@/lib/fiscal/model";
import { buildSnapshot } from "@/lib/fiscal/snapshot";
import { DEFAULT_RATES } from "@/lib/fiscal/types";
import { buildXml, xmlSha256 } from "@/server/fatturapa/build-xml";
import { CASES } from "../support/fiscal-cases";
import { validateFatturaXml } from "../support/xsd";

const caseNames = ["F1", "F2", "F3", "F4", "F5", "O1", "O3", "O4", "E1", "NC1", "S1", "S4", "S5"] as const;

function readBody(xml: string): Record<string, unknown> {
  const parsed = convert(xml, { format: "object" }) as {
    "p:FatturaElettronica": { FatturaElettronicaBody: Record<string, unknown> };
  };
  return parsed["p:FatturaElettronica"].FatturaElettronicaBody;
}

describe("XML FatturaPA FPR12", () => {
  it.each(caseNames)("%s valida sull'XSD ufficiale senza dati del prodotto", async (name) => {
    const xml = buildXml(toFatturaModel(CASES[name]));
    expect(await validateFatturaXml(xml)).toEqual({ valid: true, errors: [] });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12">');
    expect(xml).toContain("<FormatoTrasmissione>FPR12</FormatoTrasmissione>");
    expect(xml.match(/<\/?p:/g)).toHaveLength(2);
    expect(xml).not.toContain(APP_NAME);
    expect(xml).not.toMatch(/APP_NAME|SistemaEmittente|<!--|<Contatti|<NumeroCivico/);
  });

  it("F2 coincide con l'esempio sul contenuto", () => {
    const example = readFileSync(new URL("../fixtures/fatturapa/F2.xml", import.meta.url), "utf8");
    const xml = buildXml(toFatturaModel(CASES.F2));
    expect(convert(xml.replace(/>\s+</g, "><"), { format: "object" }))
      .toEqual(convert(example.replace(/>\s+</g, "><"), { format: "object" }));
  });

  it("O4 conserva totale, ritenuta, cassa TC22 e bonifico al netto", () => {
    expect(readBody(buildXml(toFatturaModel(CASES.O4)))).toMatchObject({
      DatiGenerali: { DatiGeneraliDocumento: {
        ImportoTotaleDocumento: "697.84",
        DatiRitenuta: { TipoRitenuta: "RT01", ImportoRitenuta: "114.40", AliquotaRitenuta: "20.00", CausalePagamento: "A" },
        DatiCassaPrevidenziale: {
          TipoCassa: "TC22", AlCassa: "4.00", ImportoContributoCassa: "22.00",
          ImponibileCassa: "550.00", AliquotaIVA: "22.00", Ritenuta: "SI",
        },
      } },
      DatiPagamento: { CondizioniPagamento: "TP02", DettaglioPagamento: {
        Beneficiario: "Chiara Esempio", ModalitaPagamento: "MP05", DataScadenzaPagamento: "2026-10-27",
        ImportoPagamento: "583.44", IBAN: "IT80N0000001000000000123456",
      } },
    });
  });

  it("F2 dichiara il bollo virtuale e tre righe N2.2", () => {
    expect(readBody(buildXml(toFatturaModel(CASES.F2)))).toMatchObject({
      DatiGenerali: { DatiGeneraliDocumento: { DatiBollo: { BolloVirtuale: "SI", ImportoBollo: "2.00" } } },
      DatiBeniServizi: { DettaglioLinee: [{ Natura: "N2.2" }, { Natura: "N2.2" }, { Natura: "N2.2" }] },
    });
  });

  it("NC1 collega la fattura stornata e omette i dati di pagamento", () => {
    const body = readBody(buildXml(toFatturaModel(CASES.NC1)));
    expect(body).toMatchObject({ DatiGenerali: {
      DatiGeneraliDocumento: { TipoDocumento: "TD04" },
      DatiFattureCollegate: { IdDocumento: "2/2026", Data: "2026-10-12" },
    } });
    expect(body).not.toHaveProperty("DatiPagamento");
  });

  it("tre sedute da 55,00 in ordinario validano con prezzo netto a otto decimali", async () => {
    const lines = CASES.O1.lines.filter((line) => line.kind === "prestazione")
      .map((line) => ({ ...line, quantity: 3, unitPriceCents: 5500 }));
    const snapshot = buildSnapshot({
      ...CASES.O1, lines, paperStampAuthorization: null,
      computation: computeInvoice({
        regime: "ordinario", recipientKind: "paziente", withholdingAgent: false, rates: DEFAULT_RATES, lines,
      }),
    });
    const xml = buildXml(toFatturaModel(snapshot));
    expect(await validateFatturaXml(xml)).toEqual({ valid: true, errors: [] });
    expect(readBody(xml)).toMatchObject({ DatiBeniServizi: {
      DettaglioLinee: { Quantita: "3.00", PrezzoUnitario: "45.08333333", PrezzoTotale: "135.25" },
    } });
  });

  it("l'escape conserva ampersand e parentesi angolari nella descrizione", async () => {
    const model = toFatturaModel(CASES.F1);
    model.lines[0]!.description = "Visita & controllo <prima>";
    const xml = buildXml(model);
    expect(await validateFatturaXml(xml)).toEqual({ valid: true, errors: [] });
    const description = create(xml).find((node) => node.node.nodeName === "Descrizione", false, true);
    expect(description?.node.textContent).toBe("Visita & controllo <prima>");
  });
});

describe("xmlSha256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ])("calcola il vettore noto %j", (xml, expected) => {
    expect(xmlSha256(xml)).toBe(expected);
  });
});
