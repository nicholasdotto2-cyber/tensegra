import { describe, expect, it } from "vitest";
import { BUILT_SECTIONS, isBuiltSection, SECTION_SLUGS } from "@/lib/settings/sections";

// Le sezioni di Impostazioni: nove slug fissati,
// "Dati di prova" solo in uno studio demo.

describe("isBuiltSection", () => {
  it("accetta una sezione costruita", () => {
    expect(isBuiltSection("studio", false)).toBe(true);
    expect(isBuiltSection("fisco", true)).toBe(true);
  });

  it("sezione_consensi: abilita Messaggi e Consensi anche fuori demo", () => {
    expect(isBuiltSection("messaggi", true)).toBe(true);
    expect(isBuiltSection("messaggi", false)).toBe(true);
    expect(isBuiltSection("consensi", true)).toBe(true);
    expect(isBuiltSection("consensi", false)).toBe(true);
  });

  it("apre Dati di prova solo in uno studio demo", () => {
    expect(isBuiltSection("dati-di-prova", false)).toBe(false);
    expect(isBuiltSection("dati-di-prova", true)).toBe(true);
  });

  it("rifiuta uno slug sconosciuto", () => {
    expect(isBuiltSection("boh", true)).toBe(false);
    expect(isBuiltSection("", true)).toBe(false);
  });
});

describe("BUILT_SECTIONS", () => {
  it("elenca le nove sezioni costruite, nel loro ordine", () => {
    expect(BUILT_SECTIONS.map((s) => s.label)).toEqual([
      "Studio",
      "Orari",
      "Fisco",
      "Iscrizione e polizza",
      "Cartella",
      "Messaggi",
      "Consensi",
      "Aspetto",
      "Dati di prova",
    ]);
  });

  it("usa solo slug dei nove fissati e segna solo Dati di prova come demo", () => {
    for (const section of BUILT_SECTIONS) expect(SECTION_SLUGS).toContain(section.slug);
    expect(BUILT_SECTIONS.filter((s) => s.demoOnly).map((s) => s.slug)).toEqual(["dati-di-prova"]);
  });
});
