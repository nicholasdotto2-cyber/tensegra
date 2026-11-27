import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/clock";
import { type AppConfig, ConfigError } from "@/server/config";
import type { Db } from "@/server/db/db";
import { DataDirLockedError, type LockDeps, type LockInfo, readLock, releaseLock } from "@/server/db/lock";
import { resetDataDir, unlockDataDir } from "@/server/db/maintenance";
import { openDb } from "@/server/db/open";
import { asService } from "@/server/db/service";
import { demoExists } from "../../seed/demo";

// reset e unlock su vere cartelle dentro web/.data/test (initdb, lock, cancellazione): il
// punto è cosa tocca il comando e cosa no, non il contenuto del database.

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const BASE = resolve(".data", "test");

let counter = 0;
const toClean: string[] = [];

function freshDir(): string {
  counter += 1;
  const dir = join(BASE, `maint-${process.pid}-${counter}`);
  rmSync(dir, { recursive: true, force: true });
  toClean.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of toClean) rmSync(dir, { recursive: true, force: true });
});

function cfgFor(dataDir: string): AppConfig {
  return { webRoot: process.cwd(), dataDir, fixedNow: null, demoMode: false };
}

/** Riapre la cartella com'è dopo il comando, per guardarci dentro. */
async function inspect<T>(dataDir: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, pg } = await openDb({ dataDir, command: "vitest" });
  try {
    return await fn(db);
  } finally {
    await pg.close();
    releaseLock(dataDir, process.pid);
  }
}

function count(db: Db, table: string): Promise<number> {
  return asService(db, async (tx) => {
    const [row] = await tx.query<{ n: number }>(`select count(*)::int as n from ${table}`);
    return row?.n ?? -1;
  });
}

describe("resetDataDir", () => {
  it("rifiuta una cartella fuori da web/ e non cancella niente", async () => {
    const outside = mkdtempSync(join(tmpdir(), "maint-outside-"));
    try {
      mkdirSync(join(outside, "pglite"));
      mkdirSync(join(outside, "files"));
      writeFileSync(join(outside, "pglite", "sentinella.txt"), "x");
      writeFileSync(join(outside, "files", "sentinella.txt"), "x");

      const error = await resetDataDir(cfgFor(outside), { seed: true, clock }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain(outside);
      expect(existsSync(join(outside, "pglite", "sentinella.txt"))).toBe(true);
      expect(existsSync(join(outside, "files", "sentinella.txt"))).toBe(true);
      expect(existsSync(join(outside, "app.lock"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rifiuta web/ stessa e non prende nessun lock", async () => {
    await expect(resetDataDir(cfgFor(process.cwd()), { seed: true, clock })).rejects.toBeInstanceOf(ConfigError);
    expect(existsSync(join(process.cwd(), "app.lock"))).toBe(false);
  });

  it("cancella pglite/ e files/ ma non backups/, poi migra e semina", async () => {
    const dir = freshDir();
    await resetDataDir(cfgFor(dir), { seed: true, clock });
    expect(existsSync(join(dir, "app.lock"))).toBe(false);

    // Un secondo studio nel database e un file in ognuna delle tre cartelle.
    await inspect(dir, (db) =>
      asService(db, (tx) => tx.query("insert into public.practices (name) values ('Altro studio')")),
    );
    mkdirSync(join(dir, "files"), { recursive: true });
    mkdirSync(join(dir, "backups"), { recursive: true });
    writeFileSync(join(dir, "pglite", "segno.txt"), "x");
    writeFileSync(join(dir, "files", "x.txt"), "x");
    writeFileSync(join(dir, "backups", "keep.txt"), "tieni");

    await resetDataDir(cfgFor(dir), { seed: true, clock });

    expect(existsSync(join(dir, "pglite", "segno.txt"))).toBe(false);
    expect(existsSync(join(dir, "files", "x.txt"))).toBe(false);
    expect(readFileSync(join(dir, "backups", "keep.txt"), "utf8")).toBe("tieni");
    expect(existsSync(join(dir, "app.lock"))).toBe(false);
    await inspect(dir, async (db) => {
      expect(await demoExists(db)).toBe(true);
      expect(await count(db, "public.practices")).toBe(1);
    });
  });

  it("senza seed lascia lo schema migrato e vuoto", async () => {
    const dir = freshDir();
    await resetDataDir(cfgFor(dir), { seed: false, clock });
    await inspect(dir, async (db) => {
      expect(await demoExists(db)).toBe(false);
      expect(await count(db, "public.practices")).toBe(0);
      expect(await count(db, "local_meta.schema_migrations")).toBeGreaterThanOrEqual(2);
    });
  });

  it("con i dati aperti da un altro processo non cancella niente", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, "files"), { recursive: true });
    writeFileSync(join(dir, "files", "x.txt"), "x");
    // Un vero processo node vivo: per il lock è un'app accesa (node.exe su Windows, node altrove).
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error("processo di prova non avviato");
      const held: LockInfo = { pid, startedAt: new Date().toISOString(), command: "pnpm dev", exe: basename(process.execPath).toLowerCase() };
      writeFileSync(join(dir, "app.lock"), JSON.stringify(held));

      await expect(resetDataDir(cfgFor(dir), { seed: true, clock })).rejects.toBeInstanceOf(DataDirLockedError);
      expect(existsSync(join(dir, "files", "x.txt"))).toBe(true);
      expect(readLock(dir)?.pid).toBe(pid);
    } finally {
      child.kill();
    }
  }, 20000);
});

describe("unlockDataDir", () => {
  function depsFor(overrides: Partial<LockDeps>): LockDeps {
    return {
      pid: 1,
      command: "pnpm db:unlock",
      exe: "node.exe",
      isAlive: () => false,
      exeOf: () => ({ kind: "unknown", reason: "error" }),
      sleep: async () => {},
      now: () => new Date(),
      log: () => {},
      ...overrides,
    };
  }

  function lockedDir(pid: number): string {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    const info: LockInfo = { pid, startedAt: "2026-11-04T07:30:00.000Z", command: "pnpm start", exe: "node.exe" };
    writeFileSync(join(dir, "app.lock"), JSON.stringify(info));
    return dir;
  }

  it("senza lock dà none", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    expect(unlockDataDir(dir, depsFor({}), false)).toBe("none");
  });

  it("con un PID morto toglie il lock", () => {
    const dir = lockedDir(4242);
    expect(unlockDataDir(dir, depsFor({ isAlive: () => false }), false)).toBe("removed");
    expect(existsSync(join(dir, "app.lock"))).toBe(false);
  });

  it("con un PID vivo che non è node.exe toglie il lock (Windows riusa i PID)", () => {
    const dir = lockedDir(4242);
    const deps = depsFor({ isAlive: () => true, exeOf: () => ({ kind: "found", exe: "chrome.exe" }) });
    expect(unlockDataDir(dir, deps, false)).toBe("removed");
    expect(existsSync(join(dir, "app.lock"))).toBe(false);
  });

  it("con un node.exe vivo senza force rifiuta e il file resta", () => {
    const dir = lockedDir(4242);
    const deps = depsFor({ isAlive: () => true, exeOf: () => ({ kind: "found", exe: "node.exe" }) });
    expect(unlockDataDir(dir, deps, false)).toBe("refused");
    expect(readLock(dir)?.pid).toBe(4242);
  });

  it("con un node.exe vivo e force toglie il lock", () => {
    const dir = lockedDir(4242);
    const deps = depsFor({ isAlive: () => true, exeOf: () => ({ kind: "found", exe: "node.exe" }) });
    expect(unlockDataDir(dir, deps, true)).toBe("removed");
    expect(existsSync(join(dir, "app.lock"))).toBe(false);
  });
});
