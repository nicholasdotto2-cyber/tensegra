import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConsentsSection } from "@/components/impostazioni/consents-section";
import { settingsConsentPreview } from "@/lib/consents/studio-values";

// Impostazioni > Consensi: l'anteprima del catalogo e lo stato della firma salvata.
vi.mock("@/app/(app)/impostazioni/actions", () => ({ saveCommunicationSettingsAction: vi.fn(), storePractitionerSignatureAction: vi.fn() }));
vi.mock("@/components/consensi/signature-canvas", () => ({ SignatureCanvas: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));

describe("anteprima dei moduli in Impostazioni", () => {
  it("una conservazione non valida nella bozza esce come mancante, mai nel testo legale", () => {
    for (const draft of ["0", "abc", "", "31", "2.5"]) {
      const text = settingsConsentPreview("informativa", {}, draft);
      expect.soft(text, draft).toContain("Documentazione clinica: ________ anni dall'ultima prestazione.");
    }
    expect(settingsConsentPreview("informativa", {}, "12")).toContain("Documentazione clinica: 12 anni dall'ultima prestazione.");
  });

  it("parte dal corpo del modulo, senza titolo né avviso, qualunque sia l'intestazione", () => {
    const text = settingsConsentPreview("informativa", {}, "10");
    expect(text.startsWith("1. Titolare.")).toBe(true);
    expect(settingsConsentPreview("trattamento", {}, "10").startsWith("1. Chi firma e chi tratta.")).toBe(true);
    expect(settingsConsentPreview("trattamento_minore", {}, "10").startsWith("1. Chi è il minore e chi firma.")).toBe(true);
  });
});

describe("firma salvata dell'osteopata", () => {
  const props = { retentionYears: 10, previewValues: {} };
  it("una firma salvata che non si legge lo dice, invece di «Nessuna firma salvata.»", () => {
    const html = renderToStaticMarkup(createElement(ConsentsSection, { ...props, signaturePng: null, signatureUnreadable: true }));
    expect(html).toContain("La firma salvata non si legge: disegnala e salvala di nuovo.");
    expect(html).not.toContain("Nessuna firma salvata.");
  });
  it("senza firma resta «Nessuna firma salvata.»", () => {
    const html = renderToStaticMarkup(createElement(ConsentsSection, { ...props, signaturePng: null, signatureUnreadable: false }));
    expect(html).toContain("Nessuna firma salvata.");
    expect(html).not.toContain("non si legge");
  });
});
