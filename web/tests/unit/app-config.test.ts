import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// APP_NAME si legge una volta al caricamento del modulo: ricarichiamo il modulo a ogni caso.
async function loadAppName() {
  vi.resetModules();
  const mod = await import("@/lib/config/app");
  return mod.APP_NAME;
}

describe("APP_NAME", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("usa il nome predefinito se NEXT_PUBLIC_APP_NAME manca", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_NAME", undefined);
    expect(await loadAppName()).toBe("Tensegra");
  });

  it("usa il nome predefinito se NEXT_PUBLIC_APP_NAME è vuota", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_NAME", "");
    expect(await loadAppName()).toBe("Tensegra");
  });

  it("restituisce il valore di NEXT_PUBLIC_APP_NAME quando c'è", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_NAME", "Studio Prova");
    expect(await loadAppName()).toBe("Studio Prova");
  });
});
