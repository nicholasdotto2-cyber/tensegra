import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, assertInsideWeb, loadConfig } from "@/server/config";

describe("loadConfig", () => {
  it("applica i valori predefiniti", () => {
    const cfg = loadConfig({}, "/w/web");
    expect(cfg.webRoot).toBe("/w/web");
    expect(cfg.dataDir).toBe(path.resolve("/w/web", ".data"));
    expect(cfg.fixedNow).toBeNull();
    expect(cfg.demoMode).toBe(false);
  });

  it("legge APP_DATA_DIR relativa a webRoot", () => {
    const cfg = loadConfig({ APP_DATA_DIR: ".data/e2e" }, "/w/web");
    expect(cfg.dataDir).toBe(path.resolve("/w/web", ".data/e2e"));
  });

  it("legge APP_DEMO_MODE solo con 0 o 1", () => {
    expect(loadConfig({ APP_DEMO_MODE: "1" }, "/w/web").demoMode).toBe(true);
    expect(loadConfig({ APP_DEMO_MODE: "0" }, "/w/web").demoMode).toBe(false);
    expect(() => loadConfig({ APP_DEMO_MODE: "si" }, "/w/web")).toThrow(ConfigError);
  });

  it("legge APP_FIXED_NOW come data ISO con fuso", () => {
    const cfg = loadConfig({ APP_FIXED_NOW: "2027-01-01T00:30:00+01:00" }, "/w/web");
    expect(cfg.fixedNow?.toISOString()).toBe("2026-12-31T23:30:00.000Z");
    expect(() => loadConfig({ APP_FIXED_NOW: "domani" }, "/w/web")).toThrow(ConfigError);
    expect(() => loadConfig({ APP_FIXED_NOW: "2027-01-01T00:30:00" }, "/w/web")).toThrow(ConfigError);
    expect(() => loadConfig({ APP_FIXED_NOW: "2026-02-30T00:00:00Z" }, "/w/web")).toThrow(ConfigError);
  });

  it("tratta una variabile vuota come assente", () => {
    const cfg = loadConfig({ APP_FIXED_NOW: "", APP_DEMO_MODE: "", APP_DATA_DIR: "" }, "/w/web");
    expect(cfg.fixedNow).toBeNull();
    expect(cfg.demoMode).toBe(false);
    expect(cfg.dataDir).toBe(path.resolve("/w/web", ".data"));
  });

  it("il messaggio di errore è in italiano e non contiene i valori", () => {
    try {
      loadConfig({ APP_FIXED_NOW: "segreto-domani" }, "/w/web");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(String((e as Error).message)).not.toContain("segreto-domani");
      expect(String((e as Error).message)).toContain("APP_FIXED_NOW");
    }
  });
});

describe("assertInsideWeb", () => {
  const web = path.resolve("/w/web");

  it("accetta una cartella dentro web/", () => {
    expect(() => assertInsideWeb(path.resolve("/w/web", ".data/e2e"), web)).not.toThrow();
  });

  it("rifiuta una cartella fuori da web/", () => {
    expect(() => assertInsideWeb(path.resolve("/w/fuori"), web)).toThrow(ConfigError);
  });

  it("rifiuta web/ stessa", () => {
    expect(() => assertInsideWeb(web, web)).toThrow(ConfigError);
  });

  it("rifiuta una cartella sorella con lo stesso prefisso", () => {
    expect(() => assertInsideWeb(path.resolve("/w/web-copia/.data"), web)).toThrow(ConfigError);
  });

  it("rifiuta un percorso che risale con ..", () => {
    expect(() => assertInsideWeb(path.resolve("/w/web", "../fuori"), web)).toThrow(ConfigError);
  });

  it("accetta una cartella il cui nome inizia con due punti", () => {
    expect(() => assertInsideWeb(path.resolve("/w/web", "..dati"), web)).not.toThrow();
  });

  it("il messaggio non contiene il percorso", () => {
    try {
      assertInsideWeb(path.resolve("/w/fuori"), web);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect(String((e as Error).message)).not.toContain("fuori");
      expect(String((e as Error).message)).toBe("La cartella dati deve stare dentro web/.");
    }
  });
});
