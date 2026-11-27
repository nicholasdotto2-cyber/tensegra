import { describe, expect, it } from "vitest";
import { type ModuleKey, missingModules, missingText, type ValidConsents } from "@/lib/consents/required";
import { isMinor } from "@/lib/format";

// Moduli richiesti e testo di "Consensi mancanti": l'informativa una volta per
// paziente, il consenso al trattamento (o del genitore, per un minore) per ciclo.

type TreatmentKey = "trattamento" | "trattamento_minore";

function consents(informativa: boolean, treatment: Record<string, TreatmentKey[]> = {}): ValidConsents {
  return {
    informativa,
    treatment: new Map(Object.entries(treatment).map(([cycleId, keys]) => [cycleId, new Set(keys)])),
  };
}

describe("missingText", () => {
  it.each<[ModuleKey[], boolean, string]>([
    [["informativa", "trattamento_minore"], true, "Informativa e consenso del genitore"],
    [["informativa", "trattamento"], false, "Informativa e consenso al trattamento"],
    [["trattamento"], false, "Consenso al trattamento"],
    [["trattamento_minore"], true, "Consenso del genitore"],
    [["informativa"], true, "Informativa"],
    [["informativa"], false, "Informativa"],
  ])("%j (minore: %s) -> %s", (missing, minor, text) => {
    expect(missingText(missing, minor)).toBe(text);
  });
});

describe("missingModules", () => {
  it("maggiorenne_stesso_ciclo", () => {
    const birth = "2008-11-03";
    const minor = isMinor(birth, "2026-11-04");
    const openedMinor = isMinor(birth, "2026-10-22");
    expect(missingModules(undefined, "c", minor, openedMinor)).toEqual(["informativa", "trattamento"]);
    expect(missingModules(consents(false, { c: ["trattamento_minore"] }), "c", minor, openedMinor)).toEqual(["informativa"]);
    expect(missingModules(consents(false, { c: ["trattamento_minore"] }), "nuovo", minor, isMinor(birth, "2026-11-05")))
      .toEqual(["informativa", "trattamento"]);
  });
  it("senza consensi a un minore mancano l'informativa e il consenso del genitore", () => {
    expect(missingModules(undefined, "c", true, true)).toEqual(["informativa", "trattamento_minore"]);
  });

  it("senza consensi a un adulto mancano l'informativa e il consenso al trattamento", () => {
    expect(missingModules(undefined, "c", false, false)).toEqual(["informativa", "trattamento"]);
    expect(missingModules(consents(false), "c", false, false)).toEqual(["informativa", "trattamento"]);
  });

  it("con l'informativa e il trattamento del ciclo non manca niente", () => {
    expect(missingModules(consents(true, { c: ["trattamento"] }), "c", false, false)).toEqual([]);
    expect(missingModules(consents(true, { c: ["trattamento_minore"] }), "c", true, true)).toEqual([]);
  });

  it("il trattamento di un altro ciclo non vale", () => {
    expect(missingModules(consents(true, { altro: ["trattamento"] }), "c", false, false)).toEqual(["trattamento"]);
  });

  it("l'età decide il modulo: il consenso di un adulto non vale per un minore, e viceversa", () => {
    expect(missingModules(consents(true, { c: ["trattamento"] }), "c", true, true)).toEqual(["trattamento_minore"]);
    expect(missingModules(consents(true, { c: ["trattamento_minore"] }), "c", false, false)).toEqual(["trattamento"]);
  });

  it("con il solo trattamento manca l'informativa", () => {
    expect(missingModules(consents(false, { c: ["trattamento"] }), "c", false, false)).toEqual(["informativa"]);
  });
});
