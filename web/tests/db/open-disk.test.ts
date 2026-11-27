import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readLock, releaseLock } from "@/server/db/lock";
import { MigrationFailedError } from "@/server/db/migrate";
import { openDb } from "@/server/db/open";

// openDb su una vera cartella dentro web/.data/test: initdb, lock, migrazioni e
// impostazioni della connessione come le vede next start.

const DIR = resolve(".data", "test", `open-${process.pid}`);

describe("openDb su disco", () => {
  let pg: PGlite | undefined;

  beforeAll(async () => {
    rmSync(DIR, { recursive: true, force: true });
    ({ pg } = await openDb({ dataDir: DIR, command: "vitest" }));
  });

  afterAll(async () => {
    if (pg && !pg.closed) await pg.close();
    releaseLock(DIR, process.pid);
    rmSync(DIR, { recursive: true, force: true });
  });

  function opened(): PGlite {
    if (!pg) throw new Error("openDb non ha aperto il database");
    return pg;
  }

  it("crea la cartella, prende il lock e applica le migrazioni", async () => {
    expect(existsSync(join(DIR, "pglite"))).toBe(true);
    expect(readLock(DIR)?.pid).toBe(process.pid);
    const { rows } = await opened().query<{ n: number }>(
      "select count(*)::int as n from local_meta.schema_migrations",
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(2);
  });

  it("la sessione è in UTC", async () => {
    const { rows } = await opened().query<{ TimeZone: string }>("show timezone");
    expect(rows).toEqual([{ TimeZone: "UTC" }]);
  });

  it("una date resta la stringa AAAA-MM-GG", async () => {
    const { rows } = await opened().query<{ d: string }>("select '2026-10-22'::date as d");
    expect(rows).toEqual([{ d: "2026-10-22" }]);
  });

  it("dopo close e releaseLock il lock non c'è più", async () => {
    await opened().close();
    releaseLock(DIR, process.pid);
    expect(existsSync(join(DIR, "app.lock"))).toBe(false);
  });
});

// Una apertura fallita esce dalla cache e la richiesta dopo riprova: non deve
// trovare un PGlite ancora aperto sulla stessa cartella né un lock dello stesso processo.
describe("openDb con una migrazione che fallisce", () => {
  const dataDir = resolve(".data", "test", `open-fail-${process.pid}`);
  const supabaseDir = resolve(".data", "test", `open-fail-src-${process.pid}`);

  beforeAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(supabaseDir, { recursive: true, force: true });
    cpSync(resolve("supabase"), supabaseDir, { recursive: true });
    mkdirSync(join(supabaseDir, "migrations"), { recursive: true });
    writeFileSync(
      join(supabaseDir, "migrations", "29991231000000_broken.sql"),
      "select * from table_that_does_not_exist;\n",
      "utf8",
    );
  });

  afterAll(() => {
    vi.restoreAllMocks();
    releaseLock(dataDir, process.pid);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(supabaseDir, { recursive: true, force: true });
  });

  it("chiude PGlite, libera il lock e il tentativo dopo apre", async () => {
    const create = vi.spyOn(PGlite, "create");

    await expect(openDb({ dataDir, supabaseDir, command: "vitest" })).rejects.toBeInstanceOf(
      MigrationFailedError,
    );
    // Su una cartella nuova PGlite.create si richiama da solo per initdb: la prima chiamata
    // registrata è quella di openDb.
    const failed: PGlite = await create.mock.results[0]?.value;
    expect(failed.closed).toBe(true);
    expect(existsSync(join(dataDir, "app.lock"))).toBe(false);
    create.mockRestore();

    const { pg } = await openDb({ dataDir, command: "vitest" });
    try {
      expect(readLock(dataDir)?.pid).toBe(process.pid);
      const { rows } = await pg.query<{ n: number }>(
        "select count(*)::int as n from local_meta.schema_migrations",
      );
      expect(rows[0]?.n).toBeGreaterThanOrEqual(2);
    } finally {
      await pg.close();
    }
  });
});
