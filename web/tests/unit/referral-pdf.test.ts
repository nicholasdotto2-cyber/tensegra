import { describe, expect, it } from "vitest";
import type { ReferralLetter } from "@/server/domain/referrals/queries";
import { renderReferralPdf } from "@/server/pdf/render";
import { pdfText } from "../support/pdf-text";
import { APP_NAME } from "@/lib/config/app";

// Il PDF della lettera al medico: react-pdf con l'Helvetica integrata.
// I byte sono compressi: qui si prova solo che il documento nasce (comincia con `%PDF-` e supera 1 KB);
// il testo si prova sul modello dati della lettera (`getReferralLetter`, tests/db/referrals.test.ts).

function letter(extra: Partial<ReferralLetter> = {}): ReferralLetter {
  return {
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
    ...extra,
  };
}

const PDF_MAGIC = "%PDF-";

describe("renderReferralPdf", () => {
  it("lettera_firma: PNG come image XObject, nome e DATI DI PROVA; senza firma resta la linea", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const pdf = await renderReferralPdf(letter(), png);
    expect(pdf.toString("latin1")).toMatch(/\/Subtype\s*\/Image/);
    const text = (await pdfText(pdf)).text;
    expect(text).toContain("Anna Rossi, Osteopata");
    expect(text).toContain("DATI DI PROVA");
    expect(text).not.toContain(APP_NAME);
    // Con la firma l'immagine prende il posto della linea vuota «Firma».
    expect(text).not.toContain("Firma");
    const blank = await renderReferralPdf(letter());
    expect(blank.toString("latin1")).not.toMatch(/\/Subtype\s*\/Image/);
    expect((await pdfText(blank)).text).toContain("Firma");
  });
  it("una lettera di prova diventa un PDF di più di 1 KB", async () => {
    const pdf = await renderReferralPdf(letter());
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, PDF_MAGIC.length).toString("latin1")).toBe(PDF_MAGIC);
    expect(pdf.length).toBeGreaterThan(1024);
  });

  it("anche senza filigrana, senza righe dello studio e con una sintesi lunga su più pagine", async () => {
    const pdf = await renderReferralPdf(
      letter({
        demo: false,
        studio: { name: "Studio", lines: [] },
        dayText: "04/11/2026",
        summaryText: Array.from({ length: 60 }, (_, i) => `Riga ${i + 1} della sintesi, con accenti: è, à, ù, € .`).join("\n"),
      }),
    );
    expect(pdf.subarray(0, PDF_MAGIC.length).toString("latin1")).toBe(PDF_MAGIC);
    expect(pdf.length).toBeGreaterThan(1024);
  });
});
