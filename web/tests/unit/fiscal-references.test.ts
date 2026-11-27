import { describe, expect, it } from "vitest";
import {
  fillLegal, LEGAL_KEYS, legalText, REFERENCES_2027_NOTE, REFERENCES_CHANGE_NOTE,
  RIVALSA_PDF, type LegalKey,
} from "@/lib/fiscal/references";

const texts2026: Record<LegalKey, string> = {
  forfettario_xml: "Operazione in franchigia da IVA, art. 1 c. 54-89 L. 190/2014",
  forfettario_dicitura: "Operazione effettuata ai sensi dell'art. 1, commi da 54 a 89, L. 190/2014, regime forfettario.",
  forfettario_no_ritenuta: "Compenso non soggetto a ritenuta d'acconto ai sensi dell'art. 1, c. 67, L. 190/2014.",
  esente_xml: "Esente IVA art. 10 c. 1 n. 18 DPR 633/1972",
  bollo_virtuale_pdf: "Imposta di bollo assolta in modo virtuale ai sensi dell'art. 6 del DM 17 giugno 2014.",
  bollo_contrassegno_pdf: "Imposta di bollo assolta sull'originale, contrassegno n. {stamp_mark_code}.",
  bollo_virtuale_autorizzato_pdf: "Imposta di bollo assolta in modo virtuale, autorizzazione {paper_stamp_authorization} (art. 15 DPR 642/1972).",
  copia_cortesia_pdf: "Copia di cortesia. L'originale della fattura elettronica è a disposizione nella sua area riservata del sito web dell'Agenzia delle Entrate.",
};

const texts2027: Record<LegalKey, string> = {
  ...texts2026,
  forfettario_xml: "Operazione in franchigia da IVA, Capo XXI D.Lgs. 117/2026",
  forfettario_dicitura: "Operazione effettuata ai sensi del Capo XXI del D.Lgs. 117/2026, regime forfettario.",
  forfettario_no_ritenuta: "Compenso non soggetto a ritenuta d'acconto ai sensi del Capo XXI del D.Lgs. 117/2026.",
  esente_xml: "Esente IVA art. 37 D.Lgs. 10/2026",
};

describe("Testi normativi per data della fattura", () => {
  it("espone tutte e sole le otto chiavi fiscali e le diciture comuni", () => {
    expect(LEGAL_KEYS).toEqual(Object.keys(texts2026));
    expect(RIVALSA_PDF).toBe("Rivalsa INPS 4% (art. 1 c. 212 L. 662/1996)");
    expect(REFERENCES_2027_NOTE).toBe("Riferimenti 2027 da confermare");
    expect(REFERENCES_CHANGE_NOTE).toBe("Dal 1/01/2027 cambiano i riferimenti: il gestionale li aggiorna da solo per le fatture datate 2027");
  });

  it.each(Object.entries(texts2026) as [LegalKey, string][])("%s: confermato fino al 31/12/2026", (key, text) => {
    for (const date of ["2026-01-01", "2026-10-12", "2026-12-31"]) {
      expect(legalText(key, date)).toEqual({ text, confirmed: true });
    }
  });

  it.each(Object.entries(texts2027) as [LegalKey, string][])("%s: provvisorio dal 1/01/2027", (key, text) => {
    for (const date of ["2027-01-01", "2027-12-31"]) {
      expect(legalText(key, date)).toEqual({ text, confirmed: false });
    }
  });

  it.each(["esente_xml", "forfettario_xml"] as const)("%s cambia al confine dell'anno", (key) => {
    expect(legalText(key, "2026-12-31").text).not.toBe(legalText(key, "2027-01-01").text);
  });

  it.each(["2026-12-31", "2027-01-01"])("limiti XML e apostrofi semplici per %s", (date) => {
    for (const key of LEGAL_KEYS) {
      const { text } = legalText(key, date);
      expect(text).not.toMatch(/[\u2019\u2014]/);
      if (key.endsWith("_xml")) expect(text.length).toBeLessThanOrEqual(100);
      if (key === "forfettario_dicitura" || key === "forfettario_no_ritenuta") {
        expect(text.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it("inserisce il codice del contrassegno nel testo", () => {
    expect(fillLegal(legalText("bollo_contrassegno_pdf", "2026-10-12").text, {
      stamp_mark_code: "01234567890123",
    })).toBe("Imposta di bollo assolta sull'originale, contrassegno n. 01234567890123.");
  });
});
