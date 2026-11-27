import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { scrubDbError } from "./errors";

// Runner delle migrazioni: applica supabase/local/*.sql (lo shim) e poi
// supabase/migrations/*.sql, in ordine di nome, come l'utente `postgres`.

export interface MigrationFile {
  /** "local:0001" per lo shim, le 14 cifre per le migrazioni. */
  version: string;
  /** Il nome senza prefisso numerico e senza ".sql". */
  name: string;
  fileName: string;
  /** Il testo con fini riga LF: è lo stesso su cui si calcola il checksum e che gira. */
  sql: string;
  checksum: string;
}

export class MigrationChangedError extends Error {
  readonly fileName: string;

  constructor(fileName: string) {
    super(`La migrazione ${fileName} è cambiata dopo essere stata applicata. Esegui pnpm db:reset.`);
    this.name = "MigrationChangedError";
    this.fileName = fileName;
  }
}

export class MigrationFailedError extends Error {
  readonly fileName: string;

  constructor(fileName: string, detail: string, options?: ErrorOptions) {
    super(`Migrazione ${fileName} fallita: ${detail}`, options);
    this.name = "MigrationFailedError";
    this.fileName = fileName;
  }
}

const SHIM_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MIGRATION_PATTERN = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const SHIM_PREFIX = "local:";

function normalizeLineEnds(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** sha256 esadecimale del testo con `\r\n` portato a `\n`: su Windows git può cambiare le fini riga. */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(normalizeLineEnds(sql), "utf8").digest("hex");
}

function sqlNamesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    // Una cartella che non c'è è una cartella vuota (supabase/migrations ancora non esiste).
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
}

function readFiles(dir: string, pattern: RegExp, versionPrefix: string): MigrationFile[] {
  return sqlNamesIn(dir).map((fileName) => {
    const match = pattern.exec(fileName);
    const [, number, name] = match ?? [];
    if (!number || !name) {
      throw new MigrationFailedError(fileName, "il nome del file non ha il formato previsto.");
    }
    const sql = normalizeLineEnds(readFileSync(join(dir, fileName), "utf8"));
    return { version: `${versionPrefix}${number}`, name, fileName, sql, checksum: checksumOf(sql) };
  });
}

/** Prima `local/` (shim, `NNNN_nome.sql`), poi `migrations/` (`<14 cifre>_nome.sql`), ognuna in ordine di nome. */
export function listMigrationFiles(supabaseDir: string): MigrationFile[] {
  return [
    ...readFiles(join(supabaseDir, "local"), SHIM_PATTERN, SHIM_PREFIX),
    ...readFiles(join(supabaseDir, "migrations"), MIGRATION_PATTERN, ""),
  ];
}

// Il nome del file di una riga di local_meta: l'inverso di `readFiles`.
function fileNameOf(version: string, name: string): string {
  return `${version.startsWith(SHIM_PREFIX) ? version.slice(SHIM_PREFIX.length) : version}_${name}.sql`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RegisteredMigration {
  version: string;
  name: string;
  checksum: string;
}

export async function runMigrations(
  pg: PGlite,
  supabaseDir: string,
  log: (message: string) => void = (message) => console.warn(`[migrate] ${message}`),
): Promise<{ applied: string[] }> {
  const files = listMigrationFiles(supabaseDir);

  await pg.exec(`
    create schema if not exists local_meta;
    create table if not exists local_meta.schema_migrations (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
  `);
  const registered = new Map(
    (
      await pg.query<RegisteredMigration>("select version, name, checksum from local_meta.schema_migrations")
    ).rows.map((row) => [row.version, row]),
  );

  // Prima si controlla tutto ciò che è già applicato: se un file vecchio è cambiato il
  // database non corrisponde più ai sorgenti, e non ha senso metterci sopra altro.
  for (const file of files) {
    const row = registered.get(file.version);
    if (row && row.checksum !== file.checksum) throw new MigrationChangedError(file.fileName);
  }
  const onDisk = new Set(files.map((file) => file.version));
  for (const row of registered.values()) {
    if (!onDisk.has(row.version)) {
      log(`La migrazione ${fileNameOf(row.version, row.name)} è già applicata ma il file non c'è più: la lascio com'è.`);
    }
  }

  const applied: string[] = [];
  for (const file of files) {
    if (registered.has(file.version)) continue;
    try {
      await pg.transaction(async (tx) => {
        await tx.exec(file.sql);
        await tx.query("insert into local_meta.schema_migrations (version, name, checksum) values ($1, $2, $3)", [
          file.version,
          file.name,
          file.checksum,
        ]);
      });
    } catch (error) {
      // Come ogni errore che esce dal database: senza `params`, `detail` e valore
      // citato dei codici 22, perché una migrazione che tocca dati li porterebbe nel log.
      const clean = scrubDbError(error);
      throw new MigrationFailedError(file.fileName, messageOf(clean), { cause: clean });
    }
    applied.push(file.fileName);
  }
  return { applied };
}
