import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_PRACTICE_ID, DEMO_USER_ID } from "@/server/auth/actor";
import { fixedClock } from "@/server/clock";
import { type AppConfig, ConfigError } from "@/server/config";
import { BackupError, backupDataDir, restoreDataDir } from "@/server/db/backup";
import type { Db } from "@/server/db/db";
import { DataDirLockedError, type LockDeps, type LockInfo, readLock, releaseLock } from "@/server/db/lock";
import { resetDataDir } from "@/server/db/maintenance";
import { listMigrationFiles } from "@/server/db/migrate";
import { openDb } from "@/server/db/open";
import { asService } from "@/server/db/service";
import { createPatient } from "@/server/domain/patients/commands";

// Backup e restore su vere cartelle dentro web/.data/test:
// il seed del 4/11 si prepara una volta in un modello e ogni test ne copia `pglite/` e `files/`.

const SEED_CLOCK = fixedClock("2026-11-04T08:30:00+01:00");
const BACKUP_CLOCK = fixedClock("2026-11-04T18:05:00+01:00");
const NAME = "20261104-1805";
const BASE = resolve(".data", "test");
const TEMPLATE = join(BASE, `backup-template-${process.pid}`);
const PARTS = ["pgdata.tar.gz", "files.zip", "public-data.sql"] as const;

let counter = 0;
const toClean: string[] = [TEMPLATE];

function cfgFor(dataDir: string): AppConfig {
  return { webRoot: process.cwd(), dataDir, fixedNow: null, demoMode: false };
}

function freshDir(): string {
  counter += 1;
  const dir = join(BASE, `backup-${process.pid}-${counter}`);
  rmSync(dir, { recursive: true, force: true });
  toClean.push(dir);
  for (const name of ["pglite", "files"]) cpSync(join(TEMPLATE, name), join(dir, name), { recursive: true });
  return dir;
}

beforeAll(async () => {
  rmSync(TEMPLATE, { recursive: true, force: true });
  await resetDataDir(cfgFor(TEMPLATE), { seed: true, clock: SEED_CLOCK });
}, 180000);

// Ogni cartella ha pglite/ più i backup: sulla macchina condivisa la pulizia supera i 60 s di default.
afterAll(async () => {
  await Promise.all(toClean.map((dir) => rm(dir, { recursive: true, force: true })));
}, 180000);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Ogni file sotto `root` con il suo sha256, per dire se una cartella è rimasta com'era. */
function snapshot(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const out: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out[relative(root, full).replaceAll("\\", "/")] = sha256(readFileSync(full));
  }
  return out;
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

function countPatients(dataDir: string): Promise<number> {
  return inspect(dataDir, (db) =>
    asService(db, async (tx) => {
      const [row] = await tx.query<{ n: number }>("select count(*)::int as n from public.patients");
      return row?.n ?? -1;
    }),
  );
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

function readManifest(dataDir: string) {
  return JSON.parse(readFileSync(join(dataDir, "backups", NAME, "manifest.json"), "utf8"));
}

function writeManifest(dataDir: string, manifest: unknown): void {
  writeFileSync(join(dataDir, "backups", NAME, "manifest.json"), JSON.stringify(manifest));
}

/** Lo stato che un restore rifiutato non deve cambiare. */
async function stateOf(dataDir: string) {
  const files = snapshot(join(dataDir, "files"));
  return { files, patients: await countPatients(dataDir) };
}

describe("backupDataDir", () => {
  it("backup_crea_le_parti", async () => {
    const dir = freshDir();
    const { name, manifest } = await backupDataDir(cfgFor(dir), BACKUP_CLOCK);
    expect(name).toBe(NAME);
    const out = join(dir, "backups", NAME);
    expect(readdirSync(out).sort()).toEqual(["files.zip", "manifest.json", "pgdata.tar.gz", "public-data.sql"]);
    for (const part of PARTS) {
      expect(manifest.parts[part]).toBe(sha256(readFileSync(join(out, part))));
    }
    expect(readManifest(dir)).toEqual(manifest);
    expect(manifest.rows["public.patients"]).toBe(15);
    expect(manifest.pgliteVersion).toBe("0.5.11");
    expect(manifest.lastMigration).toBe(listMigrationFiles(join(process.cwd(), "supabase")).at(-1)?.version);
    expect(manifest.createdAt).toBe("2026-11-04T17:05:00.000Z");
    expect(readFileSync(join(out, "public-data.sql"), "utf8")).toContain("INSERT INTO public.patients");
    expect(existsSync(join(dir, "app.lock"))).toBe(false);
  }, 180000);

  it("backup_stesso_minuto", async () => {
    const dir = freshDir();
    await backupDataDir(cfgFor(dir), BACKUP_CLOCK);
    const before = snapshot(join(dir, "backups"));
    const error = await rejection(backupDataDir(cfgFor(dir), BACKUP_CLOCK));
    expect(error).toBeInstanceOf(BackupError);
    expect((error as Error).message).toBe("Esiste già un backup di questo minuto: riprova fra un minuto.");
    expect(snapshot(join(dir, "backups"))).toEqual(before);
  }, 180000);
});

describe("restoreDataDir", () => {
  it("restore_torna_uguale", async () => {
    const dir = freshDir();
    const { manifest } = await backupDataDir(cfgFor(dir), BACKUP_CLOCK);

    const added = await inspect(dir, (db) =>
      db.asUser({ userId: DEMO_USER_ID }, (tx) =>
        createPatient(tx, DEMO_PRACTICE_ID, SEED_CLOCK, { firstName: "Nuova", lastName: "Paziente", birthDate: "1980-01-01" }),
      ),
    );
    const someFile = Object.keys(snapshot(join(dir, "files")))[0];
    if (!someFile) throw new Error("il seed non ha file");
    rmSync(join(dir, "files", someFile));

    const restored = await restoreDataDir(cfgFor(dir), NAME);
    expect(restored).toEqual(manifest);

    await inspect(dir, (db) =>
      asService(db, async (tx) => {
        for (const [table, n] of Object.entries(manifest.rows)) {
          const [row] = await tx.query<{ n: number }>(`select count(*)::int as n from ${table}`);
          expect(row?.n, table).toBe(n);
        }
        const found = await tx.query("select 1 from public.patients where id = $1", [added.id]);
        expect(found).toHaveLength(0);
        const files = await tx.query<{ storage_key: string; sha256: string }>("select storage_key, sha256 from public.files");
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
          expect(sha256(readFileSync(join(dir, "files", file.storage_key))), file.storage_key).toBe(file.sha256);
        }
      }),
    );
    expect(existsSync(join(dir, "pglite.restore-old"))).toBe(false);
    expect(existsSync(join(dir, "files.restore-old"))).toBe(false);
    expect(existsSync(join(dir, "app.lock"))).toBe(false);
  }, 180000);

  it("restore_sha_diverso", async () => {
    const dir = freshDir();
    await backupDataDir(cfgFor(dir), BACKUP_CLOCK);
    const zip = join(dir, "backups", NAME, "files.zip");
    const bytes = readFileSync(zip);
    bytes[10] = (bytes[10] ?? 0) ^ 0xff;
    writeFileSync(zip, bytes);
    const before = await stateOf(dir);

    const error = await rejection(restoreDataDir(cfgFor(dir), NAME));
    expect(error).toBeInstanceOf(BackupError);
    expect((error as Error).message).toBe("Il backup è danneggiato: files.zip non corrisponde.");
    expect(await stateOf(dir)).toEqual(before);
  }, 180000);

  it("restore_versione_diversa", async () => {
    const dir = freshDir();
    await backupDataDir(cfgFor(dir), BACKUP_CLOCK);
    writeManifest(dir, { ...readManifest(dir), pgliteVersion: "0.4.0" });
    const before = await stateOf(dir);

    const error = await rejection(restoreDataDir(cfgFor(dir), NAME));
    expect(error).toBeInstanceOf(BackupError);
    expect((error as Error).message).toBe(
      "Il backup è stato fatto con un'altra versione del database (0.4.0): non si può ripristinare.",
    );
    expect(await stateOf(dir)).toEqual(before);
  }, 180000);

  it("restore_migrazione_sconosciuta", async () => {
    const dir = freshDir();
    await backupDataDir(cfgFor(dir), BACKUP_CLOCK);
    writeManifest(dir, { ...readManifest(dir), lastMigration: "29991231235959" });
    const before = await stateOf(dir);

    const error = await rejection(restoreDataDir(cfgFor(dir), NAME));
    expect(error).toBeInstanceOf(BackupError);
    expect((error as Error).message).toBe(
      "Il backup viene da una versione più nuova del programma: non si può ripristinare.",
    );
    expect(await stateOf(dir)).toEqual(before);
  }, 180000);

  it("restore_fallito_rimette", async () => {
    const dir = freshDir();
    await backupDataDir(cfgFor(dir), BACKUP_CLOCK);
    const before = await stateOf(dir);
    const pgliteBefore = snapshot(join(dir, "pglite"));

    const failing: typeof openDb = async (opts) => {
      if (opts.loadDataDir) throw new Error("apertura fallita per prova");
      return openDb(opts);
    };
    const error = await rejection(restoreDataDir(cfgFor(dir), NAME, { open: failing }));
    expect((error as Error).message).toBe("apertura fallita per prova");

    expect(snapshot(join(dir, "pglite"))).toEqual(pgliteBefore);
    expect(existsSync(join(dir, "pglite.restore-old"))).toBe(false);
    expect(existsSync(join(dir, "files.restore-old"))).toBe(false);
    expect(existsSync(join(dir, "app.lock"))).toBe(false);
    expect(await stateOf(dir)).toEqual(before);
  }, 180000);

  it("restore_nome_libero", async () => {
    const dir = freshDir();
    for (const name of ["../pglite", "20261104"]) {
      const error = await rejection(restoreDataDir(cfgFor(dir), name));
      expect(error).toBeInstanceOf(BackupError);
      expect((error as Error).message).toBe("Indica il nome di una cartella di backup, per esempio 20261104-1805.");
    }
    expect(existsSync(join(dir, "app.lock"))).toBe(false);
  });
});

describe("lock e cartella", () => {
  function liveNodeLock(): LockDeps {
    let tick = Date.parse("2026-11-04T17:05:00.000Z");
    return {
      pid: process.pid,
      command: "pnpm db:backup",
      exe: "node.exe",
      isAlive: () => true,
      exeOf: (pid) => (pid === 4242 ? { kind: "found", exe: "node.exe" } : { kind: "absent" }),
      sleep: async () => {},
      // Avanza a ogni chiamata: l'attesa del lock finisce senza dormire.
      now: () => new Date((tick += 1000)),
      log: () => {},
    };
  }

  it("backup_lock", async () => {
    const dir = freshDir();
    await backupDataDir(cfgFor(dir), BACKUP_CLOCK);
    const held: LockInfo = { pid: 4242, startedAt: "2026-11-04T07:30:00.000Z", command: "pnpm start", exe: "node.exe" };
    writeFileSync(join(dir, "app.lock"), JSON.stringify(held));
    const backupsBefore = snapshot(join(dir, "backups"));
    const pgliteBefore = snapshot(join(dir, "pglite"));
    const filesBefore = snapshot(join(dir, "files"));

    const other = fixedClock("2026-11-04T18:10:00+01:00");
    expect(await rejection(backupDataDir(cfgFor(dir), other, { lock: liveNodeLock() }))).toBeInstanceOf(DataDirLockedError);
    expect(await rejection(restoreDataDir(cfgFor(dir), NAME, { lock: liveNodeLock() }))).toBeInstanceOf(DataDirLockedError);

    expect(snapshot(join(dir, "backups"))).toEqual(backupsBefore);
    expect(snapshot(join(dir, "pglite"))).toEqual(pgliteBefore);
    expect(snapshot(join(dir, "files"))).toEqual(filesBefore);
    expect(readLock(dir)?.pid).toBe(4242);
  }, 180000);

  it("backup_fuori_da_web", async () => {
    const outside = mkdtempSync(join(tmpdir(), "backup-outside-"));
    try {
      mkdirSync(join(outside, "pglite"));
      writeFileSync(join(outside, "pglite", "sentinella.txt"), "x");
      for (const attempt of [restoreDataDir(cfgFor(outside), NAME), backupDataDir(cfgFor(outside), BACKUP_CLOCK)]) {
        const error = await rejection(attempt);
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).not.toContain(outside);
      }
      expect(existsSync(join(outside, "pglite", "sentinella.txt"))).toBe(true);
      expect(existsSync(join(outside, "app.lock"))).toBe(false);
      expect(existsSync(join(outside, "backups"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
