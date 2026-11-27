import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pgCode } from "@/server/db/errors";
import { MigrationChangedError, MigrationFailedError, runMigrations } from "@/server/db/migrate";
import { createPglite } from "@/server/db/pglite";

let pg: PGlite;
let dir: string;

// Ogni test ha il suo PGlite in memoria e la sua copia di supabase/ (le migrazioni vere
// possono essere zero o molte: i test non dipendono da quante sono).
beforeEach(async () => {
  pg = await createPglite();
  dir = mkdtempSync(join(tmpdir(), "migrate-db-"));
  cpSync(resolve("supabase"), dir, { recursive: true });
  mkdirSync(join(dir, "migrations"), { recursive: true });
});

afterEach(async () => {
  await pg.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("runMigrations", () => {
  it("primo giro applica shim e migrazioni, secondo giro niente", async () => {
    const first = await runMigrations(pg, dir);
    expect(first.applied).toContain("0001_shim.sql");
    const second = await runMigrations(pg, dir);
    expect(second.applied).toEqual([]);
  });

  it("file cambiato dopo l'applicazione", async () => {
    await runMigrations(pg, dir);
    const shim = join(dir, "local", "0001_shim.sql");
    writeFileSync(shim, `${readFileSync(shim, "utf8")}\n-- ritocco\n`, "utf8");
    const attempt = runMigrations(pg, dir);
    await expect(attempt).rejects.toBeInstanceOf(MigrationChangedError);
    await expect(attempt).rejects.toThrow(
      "La migrazione 0001_shim.sql è cambiata dopo essere stata applicata. Esegui pnpm db:reset.",
    );
    await expect(attempt).rejects.toMatchObject({ fileName: "0001_shim.sql" });
  });

  it("stesso file con CRLF: nessun errore", async () => {
    await runMigrations(pg, dir);
    const shim = join(dir, "local", "0001_shim.sql");
    const lf = readFileSync(shim, "utf8").replace(/\r\n/g, "\n");
    writeFileSync(shim, lf.replace(/\n/g, "\r\n"), "utf8");
    await expect(runMigrations(pg, dir)).resolves.toEqual({ applied: [] });
  });

  it("migrazione fallita non lascia niente", async () => {
    writeFileSync(
      join(dir, "migrations", "20990101000000_broken.sql"),
      "create table public.t_broken (id int); select 1/0;",
      "utf8",
    );
    const attempt = runMigrations(pg, dir);
    await expect(attempt).rejects.toBeInstanceOf(MigrationFailedError);
    await expect(attempt).rejects.toMatchObject({ fileName: "20990101000000_broken.sql" });
    await expect(attempt).rejects.toThrow(/^Migrazione 20990101000000_broken\.sql fallita: .*division by zero/);
    expect((await pg.query("select to_regclass('public.t_broken')::text as t")).rows[0]).toEqual({ t: null });
    expect(
      (await pg.query("select count(*)::int as n from local_meta.schema_migrations where version = '20990101000000'"))
        .rows[0],
    ).toEqual({ n: 0 });
  });

  it("migrazione fallita: nel messaggio e nella cause nessun dato delle righe", async () => {
    writeFileSync(
      join(dir, "migrations", "20990101000000_secret.sql"),
      "create table public.t_secret (v text unique); insert into public.t_secret values ('segreto-123'), ('segreto-123');",
      "utf8",
    );
    const error = await runMigrations(pg, dir).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MigrationFailedError);
    const failed = error as MigrationFailedError;
    expect(failed.message).not.toContain("segreto-123");
    expect(pgCode(failed.cause)).toBe("23505");
    expect((failed.cause as { detail?: unknown }).detail).toBeUndefined();
  });

  it("migrazione fallita con un errore 22: il valore citato sparisce", async () => {
    writeFileSync(join(dir, "migrations", "20990101000000_cast.sql"), "select 'segreto-456'::int;", "utf8");
    const error = await runMigrations(pg, dir).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MigrationFailedError);
    const failed = error as MigrationFailedError;
    expect(pgCode(failed.cause)).toBe("22P02");
    expect(failed.message).not.toContain("segreto-456");
    expect((failed.cause as Error).message).not.toContain("segreto-456");
  });

  it("file registrato e assente: solo un avviso", async () => {
    const extra = join(dir, "migrations", "20990101000001_extra.sql");
    writeFileSync(extra, "select 1;", "utf8");
    await runMigrations(pg, dir);
    rmSync(extra);
    const log = vi.fn();
    await expect(runMigrations(pg, dir, log)).resolves.toEqual({ applied: [] });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("20990101000001_extra.sql");
  });
});

describe("shim locale", () => {
  beforeEach(async () => {
    await runMigrations(pg, dir);
  });

  it("ruoli e auth.uid()", async () => {
    expect(
      (await pg.query("select count(*)::int as n from pg_roles where rolname in ('anon','authenticated','service_role')"))
        .rows[0],
    ).toEqual({ n: 3 });
    expect((await pg.query("select rolbypassrls from pg_roles where rolname = 'service_role'")).rows[0]).toEqual({
      rolbypassrls: true,
    });
    await pg.transaction(async (t) => {
      await t.query("select set_config('request.jwt.claim.sub', $1, true)", ["a0000000-0000-4000-8000-00000000000a"]);
      expect((await t.query("select auth.uid()::text as u")).rows[0]).toEqual({
        u: "a0000000-0000-4000-8000-00000000000a",
      });
    });
    // claims JSON di riserva
    await pg.transaction(async (t) => {
      await t.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: "b0000000-0000-4000-8000-00000000000b", role: "authenticated" }),
      ]);
      expect((await t.query("select auth.uid()::text as u, auth.role() as r")).rows[0]).toEqual({
        u: "b0000000-0000-4000-8000-00000000000b",
        r: "authenticated",
      });
    });
  });
});
