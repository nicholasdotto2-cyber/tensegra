import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationFailedError, checksumOf, listMigrationFiles } from "@/server/db/migrate";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migrate-files-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(relative: string, sql: string): void {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, sql, "utf8");
}

describe("checksumOf", () => {
  it("ignora le fini riga CRLF ma vede le altre differenze", () => {
    expect(checksumOf("a\r\nb")).toBe(checksumOf("a\nb"));
    expect(checksumOf("a\r\nb")).not.toBe(checksumOf("a\nc"));
  });

  it("è uno sha256 esadecimale", () => {
    expect(checksumOf("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("listMigrationFiles", () => {
  it("mette lo shim per primo, come local:0001", () => {
    const first = listMigrationFiles(resolve("supabase"))[0];
    expect(first).toMatchObject({ version: "local:0001", name: "shim", fileName: "0001_shim.sql" });
  });

  it("accetta una cartella senza migrations/", () => {
    write("local/0001_shim.sql", "select 1;");
    expect(listMigrationFiles(dir).map((f) => f.fileName)).toEqual(["0001_shim.sql"]);
  });

  it("legge prima local/ poi migrations/, ognuna in ordine di nome", () => {
    write("local/0002_second.sql", "select 2;");
    write("local/0001_first.sql", "select 1;");
    write("migrations/20261023100200_patients.sql", "select 4;");
    write("migrations/20261023100100_core.sql", "select 3;");
    write("migrations/README.md", "non è un file sql");
    const files = listMigrationFiles(dir);
    expect(files.map((f) => [f.version, f.name, f.fileName])).toEqual([
      ["local:0001", "first", "0001_first.sql"],
      ["local:0002", "second", "0002_second.sql"],
      ["20261023100100", "core", "20261023100100_core.sql"],
      ["20261023100200", "patients", "20261023100200_patients.sql"],
    ]);
    expect(files[0]).toMatchObject({ sql: "select 1;", checksum: checksumOf("select 1;") });
  });

  it("rifiuta un nome di migrazione fuori formato", () => {
    write("migrations/2026_core.sql", "select 1;");
    expect(() => listMigrationFiles(dir)).toThrow(MigrationFailedError);
    expect(() => listMigrationFiles(dir)).toThrow(expect.objectContaining({ fileName: "2026_core.sql" }));
  });

  it("rifiuta un nome di shim fuori formato", () => {
    write("local/shim.sql", "select 1;");
    expect(() => listMigrationFiles(dir)).toThrow(MigrationFailedError);
  });

  it("non scambia una migrazione per uno shim né il contrario", () => {
    write("local/20261023100100_core.sql", "select 1;");
    expect(() => listMigrationFiles(dir)).toThrow(MigrationFailedError);
    rmSync(join(dir, "local"), { recursive: true });
    write("migrations/0001_shim.sql", "select 1;");
    expect(() => listMigrationFiles(dir)).toThrow(MigrationFailedError);
  });
});
