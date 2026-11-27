import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/server/config";
import { loadNextEnvFiles, webRootOf } from "../../scripts/script-env";

// Gli script (`pnpm db:*`, `pnpm test:smoke`) vedono la stessa configurazione di `next start`:
// web/ ricavata dal path dello script, e gli stessi file .env* di Next.

const WEB = resolve(".");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("webRootOf", () => {
  it("è la cartella sopra scripts/, qualunque sia la cartella corrente", () => {
    vi.spyOn(process, "cwd").mockReturnValue(resolve(WEB, ".."));
    expect(webRootOf(pathToFileURL(join(WEB, "scripts", "db.ts")).href)).toBe(WEB);
    expect(webRootOf(pathToFileURL(join(WEB, "scripts", "smoke.ts")).href)).toBe(WEB);
  });
});

describe("loadNextEnvFiles", () => {
  it("una APP_DATA_DIR scritta in .env.local arriva a loadConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "script-env-"));
    const before = { ...process.env };
    try {
      writeFileSync(join(dir, ".env.local"), "APP_DATA_DIR=.data/da-env-local\n", "utf8");
      // Gli script girano senza NODE_ENV, come `next start`: modalità production, che legge .env.local.
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("APP_DATA_DIR", undefined);
      loadNextEnvFiles(dir);
      expect(loadConfig(process.env, dir).dataDir).toBe(resolve(dir, ".data/da-env-local"));
    } finally {
      // @next/env scrive in process.env anche le sue variabili interne: si torna a prima.
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
