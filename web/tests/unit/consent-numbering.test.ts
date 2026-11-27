import { describe, expect, it } from "vitest";
import { renderConsent } from "@/lib/consents/render";
import type { ModuleKey } from "@/lib/consents/required";
import { type ConsentPreview, freezeConsent } from "@/server/domain/consents/preview";
import type { ConsentFields } from "@/server/domain/consents/schemas";
import { renderConsentPdf } from "@/server/pdf/render";
import { ADULT_VALUES, SOFIA_VALUES } from "../support/consent-cases";
import { pdfText } from "../support/pdf-text";

// Il caso da evitare: il testo congelato del modulo per il minore stampava 1-7 e poi 9, perché la dichiarazione
// del punto 8 va nel blocco firmato. I punti visibili sono in fila in ogni modulo e la dichiarazione resta.

const SINGLE_GUARDIAN = "Io sottoscritto/a dichiaro che l'altro genitore è informato e d'accordo, oppure che esercito da solo/a la responsabilità genitoriale.";

function frozen(moduleKey: ModuleKey, extra: Partial<ConsentFields> = {}): string {
  const preview = { rendered: renderConsent(moduleKey, moduleKey === "trattamento" ? ADULT_VALUES : SOFIA_VALUES), place: "Verona" };
  const fields = {
    moduleKey, outcome: "accetta", refusesInformation: false, refusalNote: null, trusteeName: null, trusteeContact: null,
    minorOpinionNote: null, singleGuardianDeclaration: moduleKey === "trattamento_minore", secondGuardianName: null, notes: null,
    choices: moduleKey === "informativa" ? { whatsapp: true, richiami: false } : null, ...extra,
  };
  return freezeConsent(preview as ConsentPreview, fields as ConsentFields, "2026-11-04", null).text;
}

/** I numeri con cui iniziano i paragrafi del testo congelato. */
const points = (text: string): number[] => text.split("\n\n").flatMap(part => /^(\d+)\. /.exec(part)?.[1] ?? []).map(Number);
const inLine = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

describe("numerazione del testo congelato", () => {
  it("minore_un_genitore: punti 1-8 in fila e la dichiarazione sull'altro genitore nel blocco firmato", () => {
    const text = frozen("trattamento_minore");
    expect(points(text)).toEqual(inLine(8));
    expect(text).toContain('8. Dichiarazione e firme. "Io sottoscritto/a, in qualità di genitore o tutore, dichiaro');
    expect(text.split("\n\n").at(-1)!.split("\n")).toContain(SINGLE_GUARDIAN);
  });

  it("minore_due_genitori: punti in fila, senza la dichiarazione", () => {
    const text = frozen("trattamento_minore", { singleGuardianDeclaration: false, secondGuardianName: "Altro Prova" });
    expect(points(text)).toEqual(inLine(8));
    expect(text).not.toContain(SINGLE_GUARDIAN);
  });

  it("adulto_e_informativa: nessun buco", () => {
    expect(points(frozen("trattamento"))).toEqual(inLine(11));
    expect(points(frozen("informativa"))).toEqual(inLine(10));
  });

  it("pdf_minore: il PDF stampa i punti in fila e la dichiarazione", async () => {
    const text = frozen("trattamento_minore");
    const bytes = await renderConsentPdf({
      mode: "signed", text, signerName: "Elena Rinaldi", secondGuardianName: null, signedOn: "2026-11-04",
      signedAt: "2026-11-04T08:45:00.000Z", place: "Verona", signaturePng: null, secondSignaturePng: null,
      practitionerSignaturePng: null, demo: true, version: "2026.1", missingLabels: [],
    });
    const printed = (await pdfText(new Uint8Array(bytes))).text.replace(/\s+/g, " ");
    const titles = ["Chi è il minore e chi firma.", "Che cosa fa l'osteopata.", "Come si svolge la seduta.",
      "Benefici, rischi, alternative e cosa segnalare.", "Piano, compenso, assicurazione.", "La voce del minore.",
      "Diritti, esercitati dal genitore o tutore.", "Dichiarazione e firme."];
    titles.forEach((title, i) => expect(printed).toContain(`${i + 1}. ${title}`));
    expect(printed).not.toMatch(/\b9\. /);
    expect(printed).toContain(SINGLE_GUARDIAN);
  });
});
