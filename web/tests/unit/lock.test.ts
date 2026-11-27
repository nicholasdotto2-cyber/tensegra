import { spawn } from "node:child_process";
import * as childProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DataDirLockedError,
  acquireLock,
  describeCommand,
  formatLockMessage,
  nodeLockDeps,
  readLock,
  releaseLock,
  type LockDeps,
  type LockInfo,
} from "@/server/db/lock";

const OWN_PID = 4242;
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});
const OTHER_PID = 999;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lock-test-"));
});

afterEach(() => {
  vi.mocked(childProcess.execFileSync).mockReset();
  rmSync(dir, { recursive: true, force: true });
});

// Deps finte: il tempo è finto e avanza solo quando `sleep` viene chiamata.
function makeDeps(overrides: Partial<LockDeps> = {}) {
  let t = Date.parse("2026-10-22T13:00:00.000Z");
  const sleep = vi.fn(async (ms: number) => {
    t += ms;
  });
  const log = vi.fn();
  const deps: LockDeps = {
    pid: OWN_PID,
    command: "pnpm test",
    exe: "node.exe",
    isAlive: () => false,
    exeOf: () => ({ kind: "unknown", reason: "error" }),
    sleep,
    now: () => new Date(t),
    log,
    ...overrides,
  };
  return { deps, sleep, log };
}

function writeLock(info: Partial<LockInfo> = {}): LockInfo {
  const full: LockInfo = {
    pid: OTHER_PID,
    startedAt: "2026-10-22T12:00:00.000Z",
    command: "next start",
    exe: "node.exe",
    ...info,
  };
  writeFileSync(join(dir, "app.lock"), JSON.stringify(full));
  return full;
}

describe("acquireLock", () => {
  it("salva l'avvio reale del processo distinto dall'ora del lock", async () => {
    const { deps } = makeDeps({ exeOf: () => ({ kind: "found", exe: "node.exe", processStartedAt: "2026-10-22T11:00:00.123Z" }) });
    await acquireLock(dir, deps);
    expect(readLock(dir)?.processStartedAt).toBe("2026-10-22T11:00:00.123Z");
    expect(readLock(dir)?.startedAt).toBe("2026-10-22T13:00:00.000Z");
  });

  it.each([OTHER_PID, OWN_PID])("riuso PID %s: un altro node con avvio diverso prende il lock", async (pid) => {
    writeLock({ pid, processStartedAt: "2026-10-22T10:00:00.000Z" });
    const { deps, log } = makeDeps({ isAlive: () => true, exeOf: () => ({ kind: "found", exe: "node.exe", processStartedAt: "2026-10-22T10:00:32.000Z" }) });
    await acquireLock(dir, deps);
    expect(log).toHaveBeenCalledTimes(1);
    expect(readLock(dir)?.processStartedAt).toBe("2026-10-22T10:00:32.000Z");
  });

  it.each([
    ["stesso avvio", { kind: "found", exe: "node.exe", processStartedAt: "2026-10-22T10:00:00.000Z" }],
    ["timeout", { kind: "unknown", reason: "timeout" }],
    ["errore", { kind: "unknown", reason: "error" }],
    ["avvio sconosciuto", { kind: "found", exe: "node.exe" }],
  ] as const)("conserva il lock con avvio registrato: %s", async (_label, probe) => {
    const held = writeLock({ processStartedAt: "2026-10-22T10:00:00.000Z" });
    const { deps } = makeDeps({ isAlive: () => true, exeOf: () => probe });
    const error = await acquireLock(dir, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataDirLockedError);
    expect((error as DataDirLockedError).info).toEqual(held);
    expect(JSON.parse(readFileSync(join(dir, "app.lock"), "utf8"))).toEqual(held);
  });
  it("su cartella libera crea app.lock con il proprio pid", async () => {
    const { deps } = makeDeps();
    const info = await acquireLock(dir, deps);
    expect(readLock(dir)?.pid).toBe(deps.pid);
    expect(info).toEqual({
      pid: OWN_PID,
      startedAt: "2026-10-22T13:00:00.000Z",
      command: "pnpm test",
      exe: "node.exe",
    });
    expect(readLock(dir)).toEqual(info);
  });

  it("crea la cartella dati se non esiste ancora", async () => {
    const fresh = join(dir, "nuova", "data");
    const { deps } = makeDeps();
    await acquireLock(fresh, deps);
    expect(readLock(fresh)?.pid).toBe(deps.pid);
  });

  it("stesso pid continua", async () => {
    const { deps, sleep } = makeDeps();
    writeLock({ pid: deps.pid });
    await expect(acquireLock(dir, deps)).resolves.toMatchObject({ pid: deps.pid });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stesso pid continua anche se la sonda del proprio avvio non risponde", async () => {
    // Macchina carica: la sonda va in timeout, ma un lock con il nostro pid scritto da noi resta nostro.
    const { deps, sleep } = makeDeps({ isAlive: () => true, exeOf: () => ({ kind: "unknown", reason: "timeout" }) });
    writeLock({ pid: deps.pid, processStartedAt: "2026-10-22T12:59:00.000Z" });
    await expect(acquireLock(dir, deps)).resolves.toMatchObject({ pid: deps.pid });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("pid morto: prende il lock e lo annota", async () => {
    const { deps, log } = makeDeps({ isAlive: () => false });
    writeLock();
    await acquireLock(dir, deps);
    expect(log).toHaveBeenCalledTimes(1);
    expect(readLock(dir)?.pid).toBe(deps.pid);
  });

  it("pid vivo che non è node.exe: lock vecchio, preso", async () => {
    const { deps, sleep, log } = makeDeps({ isAlive: () => true, exeOf: () => ({ kind: "found", exe: "chrome.exe" }) });
    writeLock();
    await acquireLock(dir, deps);
    expect(readLock(dir)?.pid).toBe(deps.pid);
    expect(sleep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("pid vivo node.exe: DataDirLockedError dopo 5 s", async () => {
    const { deps, sleep } = makeDeps({ isAlive: () => true, exeOf: () => ({ kind: "found", exe: "node.exe" }) });
    const held = writeLock();
    const error = await acquireLock(dir, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataDirLockedError);
    expect((error as DataDirLockedError).info).toEqual(held);
    expect(sleep).toHaveBeenCalledTimes(20);
    expect(sleep.mock.calls.every(([ms]) => ms === 250)).toBe(true);
    // il lock dell'altro processo resta dov'è
    expect(readLock(dir)).toEqual(held);
  });

  it("pid vivo di cui non si conosce l'eseguibile: aspetta come per node.exe", async () => {
    const { deps, sleep } = makeDeps({ isAlive: () => true, exeOf: () => ({ kind: "unknown", reason: "error" }) });
    writeLock();
    await expect(acquireLock(dir, deps)).rejects.toBeInstanceOf(DataDirLockedError);
    expect(sleep).toHaveBeenCalledTimes(20);
  });

  it("se l'altro processo rilascia durante l'attesa, prende il lock", async () => {
    let alive = true;
    const { deps, sleep } = makeDeps({ isAlive: () => alive, exeOf: () => ({ kind: "found", exe: "node.exe" }) });
    writeLock();
    sleep.mockImplementation(async () => {
      if (sleep.mock.calls.length === 3) {
        alive = false;
      }
    });
    await acquireLock(dir, deps);
    expect(readLock(dir)?.pid).toBe(deps.pid);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  // La sonda dura centinaia di ms: mentre gira, un altro processo parte, trova lo stesso
  // lock vecchio, lo toglie e ne scrive uno suo. Il primo non deve cancellare quello fresco.
  it.each([
    ["un altro pid", { pid: 777, startedAt: "2026-10-22T13:00:00.100Z" }],
    ["lo stesso pid con un altro avvio", { pid: OTHER_PID, startedAt: "2026-10-22T13:00:00.100Z" }],
    ["lo stesso pid e ora del lock, ma un altro avvio del processo", { pid: OTHER_PID, processStartedAt: "2026-10-22T13:00:00.100Z" }],
  ])("non cancella il lock fresco che un altro processo scrive mentre decide (%s)", async (_label, replacement) => {
    let fresh: LockInfo | undefined;
    const exeOf = vi.fn((pid: number): ReturnType<LockDeps["exeOf"]> => {
      if (pid === OWN_PID) return { kind: "unknown", reason: "error" };
      if (fresh) return { kind: "found", exe: "node.exe" };
      fresh = writeLock(replacement);
      return { kind: "found", exe: "chrome.exe" };
    });
    const { deps, sleep, log } = makeDeps({ isAlive: () => true, exeOf });
    writeLock();
    const error = await acquireLock(dir, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataDirLockedError);
    expect((error as DataDirLockedError).info).toEqual(fresh);
    expect(readLock(dir)).toEqual(fresh);
    expect(sleep).toHaveBeenCalledTimes(20);
    expect(log).not.toHaveBeenCalled();
  });

  it("file illeggibile: aspetta 5 s (potrebbe essere in scrittura), poi lo riprende", async () => {
    const { deps, sleep, log } = makeDeps();
    writeFileSync(join(dir, "app.lock"), "{ non è json");
    await acquireLock(dir, deps);
    expect(sleep).toHaveBeenCalledTimes(20);
    expect(log).toHaveBeenCalledTimes(1);
    expect(readLock(dir)?.pid).toBe(deps.pid);
  });
});

describe("releaseLock", () => {
  it("lascia stare il lock di un altro pid", async () => {
    const { deps } = makeDeps();
    writeLock({ pid: OTHER_PID });
    releaseLock(dir, deps.pid);
    expect(existsSync(join(dir, "app.lock"))).toBe(true);
    releaseLock(dir, OTHER_PID);
    expect(existsSync(join(dir, "app.lock"))).toBe(false);
  });

  it("senza lock non fa nulla", () => {
    expect(() => releaseLock(dir, OWN_PID)).not.toThrow();
  });

  it("lascia stare un file illeggibile", () => {
    writeFileSync(join(dir, "app.lock"), "");
    releaseLock(dir, OWN_PID);
    expect(readFileSync(join(dir, "app.lock"), "utf8")).toBe("");
  });
});

describe("readLock", () => {
  it("senza file o con contenuto sbagliato dà null", () => {
    expect(readLock(dir)).toBeNull();
    writeFileSync(join(dir, "app.lock"), JSON.stringify({ pid: "x" }));
    expect(readLock(dir)).toBeNull();
  });
});

describe("messaggio", () => {
  const info: LockInfo = {
    pid: 18244,
    startedAt: "2026-10-22T13:02:00.000Z",
    command: "next start",
    exe: "node.exe",
  };

  it("esatto e senza path", () => {
    expect(formatLockMessage(info)).toBe(
      "I dati sono già aperti da un altro processo (PID 18244, avviato alle 15:02 con next start). Chiudi quel processo. Se sei sicuro che non esiste più, esegui pnpm db:unlock.",
    );
    const message = new DataDirLockedError(info).message;
    expect(message).not.toContain(dir);
    expect(message).not.toContain("app.lock");
    expect(new DataDirLockedError(info).info).toBe(info);
  });

  it("l'ora è quella di Roma anche d'inverno", () => {
    const winter = { ...info, startedAt: "2026-11-04T13:02:00.000Z" };
    expect(formatLockMessage(winter)).toContain("avviato alle 14:02");
  });
});

describe("describeCommand", () => {
  const env = { NODE_ENV: "test" } as const;

  it("usa lo script pnpm se c'è", () => {
    const withScript = { ...env, npm_lifecycle_event: "db:seed" };
    expect(describeCommand(withScript, ["node", "x.js"])).toBe("pnpm db:seed");
  });

  it("altrimenti il nome del file lanciato da node", () => {
    const argv = ["node", join("C:", "app", "scripts", "seed.ts")];
    expect(describeCommand(env, argv)).toBe("node seed.ts");
    expect(describeCommand(env, ["node"])).toBe("node");
  });
});

// Questi usano il sistema vero: è l'unico modo di sapere che process.kill e la sonda
// rispondono come il lock si aspetta.
describe("nodeLockDeps", () => {
  it.each([
    ["timeout", { code: "ETIMEDOUT" }, "timeout"],
    ["errore", { code: "EACCES" }, "error"],
  ])("sonda: %s resta sconosciuto", (_label, error, reason) => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw error; });
    expect(nodeLockDeps("pnpm test").exeOf(process.pid)).toEqual({ kind: "unknown", reason });
  });

  it("sonda: distingue il processo assente", () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw { status: 3 }; });
    expect(nodeLockDeps("pnpm test").exeOf(OTHER_PID)).toEqual({ kind: "absent" });
  });

  it.runIf(process.platform === "win32")("sonda: legge eseguibile e avvio in UTC", () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(JSON.stringify({
      exe: "NODE.EXE", processStartedAt: "2026-10-22T12:00:00.123Z",
    }));
    expect(nodeLockDeps("pnpm test").exeOf(OTHER_PID)).toEqual({
      kind: "found", exe: "node.exe", processStartedAt: "2026-10-22T12:00:00.123Z",
    });
  });

  it("sonda: una risposta illeggibile resta sconosciuta", () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue("non json");
    expect(nodeLockDeps("pnpm test").exeOf(OTHER_PID)).toEqual({ kind: "unknown", reason: "error" });
  });
  it("descrive il processo corrente", () => {
    const deps = nodeLockDeps("pnpm test");
    expect(deps.pid).toBe(process.pid);
    expect(deps.command).toBe("pnpm test");
    expect(deps.exe).toBe(deps.exe.toLowerCase());
    expect(deps.isAlive(process.pid)).toBe(true);
  });

  it("riconosce un processo terminato", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    expect(pid).toBeTypeOf("number");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(nodeLockDeps("pnpm test").isAlive(pid as number)).toBe(false);
    expect(nodeLockDeps("pnpm test", 20_000).exeOf(pid as number)).toEqual({ kind: "absent" });
    // La sonda può metterci secondi con la macchina carica: più tempo del default di 5 s.
  }, 30_000);

  it.runIf(process.platform === "win32")("exeOf legge il nome e l'avvio con PowerShell", () => {
    const deps = nodeLockDeps("pnpm test", 20_000);
    const probe = deps.exeOf(process.pid);
    expect(probe).toMatchObject({ kind: "found", exe: "node.exe" });
    expect(probe.kind === "found" && probe.processStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(deps.exe).toBe("node.exe");
  }, 30_000);

  it.skipIf(process.platform === "win32")("exeOf fuori da Windows legge il processo", () => {
    expect(nodeLockDeps("pnpm test", 20_000).exeOf(process.pid)).toMatchObject({ kind: "found", exe: "node" });
  });
});
