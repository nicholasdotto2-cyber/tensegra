import { afterEach, describe, expect, it, vi } from "vitest";
import { systemStateFor } from "@/app/(app)/system-state-for";
import { ConfigError } from "@/server/config";
import { InvalidActorError, NestedTransactionError } from "@/server/db/db";
import { DataDirLockedError, type LockInfo } from "@/server/db/lock";
import { MigrationChangedError, MigrationFailedError } from "@/server/db/migrate";
import { BuildPhaseError } from "@/server/db/open";

// Gli errori dell'apertura che il layout di (app) mostra come stato. `next build`
// compila i moduli del database una volta per bundle: l'errore può venire da una copia della
// classe diversa da quella che il layout importerebbe, quindi si riconosce dal `name`.

const INFO: LockInfo = { pid: 18244, startedAt: "2026-10-22T13:02:00.000Z", command: "next start", exe: "node.exe" };

// NoPracticeError sta in next.ts, che importa "server-only" e non si carica fuori da Next:
// basta il suo name, fissato nel costruttore.
const noPractice = () => Object.assign(new Error("Nessun dato demo: esegui pnpm db:seed."), { name: "NoPracticeError" });

afterEach(() => {
  vi.restoreAllMocks();
});

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("nessun errore lanciato");
}

describe("systemStateFor", () => {
  it("DataDirLockedError: stato locked con il lock trovato, messaggio solo nel log", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new DataDirLockedError(INFO);
    expect(systemStateFor(error)).toEqual({ kind: "locked", info: INFO });
    expect(log.mock.calls).toEqual([[`[app] ${error.message}`]]);
  });

  it("un DataDirLockedError di un'altra copia del modulo vale lo stesso", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    const other = await import("@/server/db/lock");
    const error = new other.DataDirLockedError(INFO);
    expect(error).not.toBeInstanceOf(DataDirLockedError);
    expect(systemStateFor(error)).toEqual({ kind: "locked", info: INFO });
  });

  it("MigrationChangedError e MigrationFailedError: stato migration con il file", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(systemStateFor(new MigrationChangedError("0001_shim.sql"))).toEqual({
      kind: "migration",
      fileName: "0001_shim.sql",
    });
    expect(systemStateFor(new MigrationFailedError("20261023100000_core.sql", "syntax error"))).toEqual({
      kind: "migration",
      fileName: "20261023100000_core.sql",
    });
  });

  it("NoPracticeError: stato no-data, senza log", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(systemStateFor(noPractice())).toEqual({ kind: "no-data" });
    expect(log).not.toHaveBeenCalled();
  });

  it("ogni altro errore si rilancia, lo stesso oggetto", () => {
    const boom = new Error("boom");
    expect(thrownBy(() => systemStateFor(boom))).toBe(boom);
    const config = new ConfigError("APP_DEMO_MODE non è valida: usa 0 oppure 1.");
    expect(thrownBy(() => systemStateFor(config))).toBe(config);
    expect(thrownBy(() => systemStateFor("non un Error"))).toBe("non un Error");
  });

  it("il name senza i campi che lo stato legge non basta: si rilancia", () => {
    const fakeLock = Object.assign(new Error("x"), { name: "DataDirLockedError" });
    expect(thrownBy(() => systemStateFor(fakeLock))).toBe(fakeLock);
    const fakeMigration = Object.assign(new Error("x"), { name: "MigrationFailedError" });
    expect(thrownBy(() => systemStateFor(fakeMigration))).toBe(fakeMigration);
  });
});

describe("ogni errore noto ha un name fisso, che non dipende dal bundle", () => {
  it.each([
    ["DataDirLockedError", new DataDirLockedError(INFO)],
    ["MigrationChangedError", new MigrationChangedError("f.sql")],
    ["MigrationFailedError", new MigrationFailedError("f.sql", "x")],
    ["NestedTransactionError", new NestedTransactionError()],
    ["InvalidActorError", new InvalidActorError()],
    ["BuildPhaseError", new BuildPhaseError()],
    ["ConfigError", new ConfigError("x")],
  ])("%s", (name, error) => {
    expect(error.name).toBe(name);
  });
});
