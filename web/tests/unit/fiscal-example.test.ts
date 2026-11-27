import { describe, expect, it } from "vitest";
import { liveExample } from "@/lib/fiscal/example";
import { DEFAULT_RATES } from "@/lib/fiscal/types";

const service = { name: "Seduta osteopatica", priceCents: 5500 };

describe("liveExample", () => {
  it("scorpora l'IVA dal prezzo finale del paziente in ordinario", () => {
    expect(liveExample("ordinario", DEFAULT_RATES, service)).toBe(
      "Seduta osteopatica 55,00\u00a0€: compenso 45,08\u00a0€ più IVA 9,92\u00a0€, niente bollo. Il paziente paga 55,00\u00a0€.",
    );
  });

  it("mantiene il compenso senza IVA in forfettario", () => {
    expect(liveExample("forfettario", DEFAULT_RATES, service)).toBe(
      "Seduta osteopatica 55,00\u00a0€: compenso 55,00\u00a0€, niente IVA, niente bollo. Il paziente paga 55,00\u00a0€.",
    );
  });

  it("indica l'esenzione sanitaria", () => {
    expect(liveExample("esente_sanitario", DEFAULT_RATES, service)).toBe(
      "Seduta osteopatica 55,00\u00a0€: compenso 55,00\u00a0€, esente da IVA, niente bollo. Il paziente paga 55,00\u00a0€.",
    );
  });

  it("somma rivalsa e bollo quando la rivalsa fa superare la soglia", () => {
    expect(liveExample("forfettario", { ...DEFAULT_RATES, inpsSurchargeEnabled: true }, { ...service, priceCents: 7500 })).toBe(
      "Seduta osteopatica 75,00\u00a0€: compenso 75,00\u00a0€ più rivalsa INPS 3,00\u00a0€, niente IVA, più bollo 2,00\u00a0€. Il paziente paga 80,00\u00a0€.",
    );
  });
});
