import * as lucide from "lucide-react";
import { describe, expect, it } from "vitest";
import { isNavActive, NAV_ITEMS } from "@/components/shell/nav-items";

// Le sei voci della sidebar: etichette, rotte e icone. Il test verifica che ogni
// nome esista in lucide-react.

const ICONS = {
  Oggi: lucide.Sun,
  Agenda: lucide.CalendarRange,
  Pazienti: lucide.ContactRound,
  Fatture: lucide.FileText,
  Listino: lucide.Tags,
  Impostazioni: lucide.SlidersHorizontal,
} as const;

describe("NAV_ITEMS", () => {
  it("ha le sei voci in ordine", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Oggi",
      "Agenda",
      "Pazienti",
      "Fatture",
      "Listino",
      "Impostazioni",
    ]);
  });

  it("porta ogni voce alla sua rotta, Impostazioni alla prima sezione", () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual([
      "/oggi",
      "/agenda",
      "/pazienti",
      "/fatture",
      "/listino",
      "/impostazioni/studio",
    ]);
  });

  it("usa le icone scelte", () => {
    // Se un nome non esistesse in lucide-react, il confronto con `undefined` passerebbe per sbaglio.
    for (const icon of Object.values(ICONS)) expect(icon).toBeDefined();
    expect(NAV_ITEMS.map((item) => item.icon)).toEqual(NAV_ITEMS.map((item) => ICONS[item.label as keyof typeof ICONS]));
  });

  it("ha un percorso di confronto per voce, prefisso del suo href", () => {
    for (const item of NAV_ITEMS) expect(item.href.startsWith(item.match)).toBe(true);
    expect(new Set(NAV_ITEMS.map((item) => item.match)).size).toBe(NAV_ITEMS.length);
  });
});

describe("isNavActive", () => {
  it("accende la voce sulla sua rotta e sulle rotte sotto di essa", () => {
    expect(isNavActive("/oggi", "/oggi")).toBe(true);
    expect(isNavActive("/pazienti/9f3c", "/pazienti")).toBe(true);
    expect(isNavActive("/impostazioni/studio", "/impostazioni")).toBe(true);
    expect(isNavActive("/impostazioni/orari", "/impostazioni")).toBe(true);
  });

  it("non confonde un percorso che comincia con le stesse lettere", () => {
    expect(isNavActive("/oggi-e-domani", "/oggi")).toBe(false);
    expect(isNavActive("/agenda", "/oggi")).toBe(false);
    expect(isNavActive("/", "/oggi")).toBe(false);
  });
});
