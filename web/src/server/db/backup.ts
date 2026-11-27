import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pgDump } from "@electric-sql/pglite-tools/pg_dump";
import { unzipSync, zipSync } from "fflate";
import { z } from "zod";
import { type Clock, romeTime, todayRome } from "@/server/clock";
import { type AppConfig, assertInsideWeb } from "@/server/config";
import { acquireLock, describeCommand, type LockDeps, nodeLockDeps, releaseLock } from "./lock";
import { listMigrationFiles } from "./migrate";
import { openDb } from "./open";
import { createPglite } from "./pglite";
import { asService } from "./service";

// Backup e restore della cartella dati. Il backup va in
// `<dataDir>/backups/AAAAMMGG-hhmm/` (ora di Roma); il restore accetta solo quel nome, controlla
// tutto prima di toccare `pglite/` e `files/`, e se fallisce dopo rimette le cartelle di prima.

export type BackupPart = "pgdata.tar.gz" | "files.zip" | "public-data.sql";

export interface BackupManifest {
  createdAt: string;
  pgliteVersion: string;
  lastMigration: string;
  rows: Record<string, number>;
  /** sha256 esadecimale di ogni parte; null per una parte assente. */
  parts: Record<BackupPart, string | null>;
}

/** Un errore il cui messaggio è per l'utente: niente percorsi. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

/** Per i test: il lock e l'apertura del database. */
export interface BackupDeps {
  lock?: LockDeps;
  open?: typeof openDb;
}

const NAME_PATTERN = /^\d{8}-\d{4}$/;
const BAD_NAME = "Indica il nome di una cartella di backup, per esempio 20261104-1805.";
const SAME_MINUTE = "Esiste già un backup di questo minuto: riprova fra un minuto.";
const NEWER_BACKUP = "Il backup viene da una versione più nuova del programma: non si può ripristinare.";
const HALF_RESTORE = "È rimasto un ripristino a metà: controlla le cartelle .restore-old nel log prima di riprovare.";
const MANIFEST = "manifest.json";
const DATA_DIRS = ["pglite", "files"] as const;
const OLD_SUFFIX = ".restore-old";

const manifestSchema = z.object({
  createdAt: z.string(),
  pgliteVersion: z.string(),
  lastMigration: z.string(),
  rows: z.record(z.string(), z.number().int()),
  parts: z.object({
    "pgdata.tar.gz": z.string().regex(/^[0-9a-f]{64}$/),
    "files.zip": z.string().regex(/^[0-9a-f]{64}$/),
    "public-data.sql": z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  }),
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pgliteVersionOf(cfg: AppConfig): string {
  const pkg = JSON.parse(
    readFileSync(join(cfg.webRoot, "node_modules", "@electric-sql", "pglite", "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

/** Le migrazioni del codice (non lo shim), in ordine. */
function codeMigrations(cfg: AppConfig): string[] {
  return listMigrationFiles(join(cfg.webRoot, "supabase"))
    .map((file) => file.version)
    .filter((version) => !version.startsWith("local:"));
}

function backupName(clock: Clock): string {
  const now = clock.now();
  return `${todayRome(now).replaceAll("-", "")}-${romeTime(now).replace(":", "")}`;
}

/** Ogni file sotto `root`, con il percorso relativo in `/`, come voce dello zip. */
function readTree(root: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out[relative(root, full).replaceAll("\\", "/")] = new Uint8Array(readFileSync(full));
  }
  return out;
}

/**
 * Crea `backups/<AAAAMMGG-hhmm>/` con `pgdata.tar.gz`, `files.zip`, `public-data.sql` e, per ultimo,
 * `manifest.json`. Con l'app accesa si ferma sul lock senza scrivere niente; se un passo fallisce la
 * cartella del backup a metà si toglie.
 */
export async function backupDataDir(
  cfg: AppConfig,
  clock: Clock,
  deps: BackupDeps = {},
): Promise<{ name: string; manifest: BackupManifest }> {
  assertInsideWeb(cfg.dataDir, cfg.webRoot);
  const command = describeCommand(process.env, process.argv);
  await acquireLock(cfg.dataDir, deps.lock ?? nodeLockDeps(command));
  try {
    const name = backupName(clock);
    const backups = join(cfg.dataDir, "backups");
    const out = join(backups, name);
    mkdirSync(backups, { recursive: true });
    try {
      mkdirSync(out);
    } catch (error) {
      if ((error as { code?: unknown }).code === "EEXIST") throw new BackupError(SAME_MINUTE);
      throw error;
    }
    try {
      const open = deps.open ?? openDb;
      const { db, pg } = await open({ dataDir: cfg.dataDir, supabaseDir: join(cfg.webRoot, "supabase"), command });
      let dump: Blob;
      let rows: Record<string, number>;
      let lastMigration: string;
      try {
        dump = await pg.dumpDataDir("gzip");
        ({ rows, lastMigration } = await asService(db, async (tx) => {
          const tables = await tx.query<{ name: string }>(
            `select table_schema || '.' || table_name as name from information_schema.tables
             where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
          );
          const counts: Record<string, number> = {};
          for (const { name: table } of tables) {
            const [row] = await tx.query<{ n: number }>(`select count(*)::int as n from ${table}`);
            counts[table] = row?.n ?? 0;
          }
          const [last] = await tx.query<{ version: string | null }>(
            "select max(version) as version from local_meta.schema_migrations where version not like 'local:%'",
          );
          return { rows: counts, lastMigration: last?.version ?? "" };
        }));
      } finally {
        await pg.close();
      }

      const pgdata = new Uint8Array(await dump.arrayBuffer());
      // pgDump esegue DEALLOCATE ALL e cambia il search_path: gira su un'istanza solo sua.
      const scratch = await createPglite({ loadDataDir: dump });
      let publicData: Uint8Array;
      try {
        const file = await pgDump({ pg: scratch, args: ["--data-only", "--schema=public"] });
        publicData = new Uint8Array(await file.arrayBuffer());
      } finally {
        await scratch.close();
      }
      const filesZip = zipSync(readTree(join(cfg.dataDir, "files")));

      writeFileSync(join(out, "pgdata.tar.gz"), pgdata);
      writeFileSync(join(out, "files.zip"), filesZip);
      writeFileSync(join(out, "public-data.sql"), publicData);
      const manifest: BackupManifest = {
        createdAt: clock.now().toISOString(),
        pgliteVersion: pgliteVersionOf(cfg),
        lastMigration,
        rows,
        parts: { "pgdata.tar.gz": sha256(pgdata), "files.zip": sha256(filesZip), "public-data.sql": sha256(publicData) },
      };
      writeFileSync(join(out, MANIFEST), JSON.stringify(manifest, null, 2));
      return { name, manifest };
    } catch (error) {
      rmSync(out, { recursive: true, force: true });
      throw error;
    }
  } finally {
    releaseLock(cfg.dataDir, process.pid);
  }
}

function readManifest(dir: string, name: string): z.infer<typeof manifestSchema> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  } catch {
    throw new BackupError(`Non trovo il backup ${name}, o il suo manifest.json non si legge.`);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new BackupError(`Il backup è danneggiato: ${MANIFEST} non corrisponde.`);
  return parsed.data;
}

/** I byte della parte, solo se il loro sha256 è quello del manifest. */
function verifiedPart(dir: string, part: BackupPart, expected: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(readFileSync(join(dir, part)));
  } catch {
    throw new BackupError(`Il backup è danneggiato: ${part} non corrisponde.`);
  }
  if (sha256(bytes) !== expected) throw new BackupError(`Il backup è danneggiato: ${part} non corrisponde.`);
  return bytes;
}

/**
 * Ripristina `pglite/` e `files/` dal backup `name`. Prima: nome, cartella dentro
 * web/, lock, sha256 delle parti, versione di PGlite, ultima migrazione nota al codice. Poi rinomina le
 * cartelle in `*.restore-old/`, apre con `loadDataDir` (che applica le migrazioni pendenti), scompatta
 * i file e solo alla fine cancella le vecchie; in errore rimette quelle di prima.
 */
export async function restoreDataDir(cfg: AppConfig, name: string, deps: BackupDeps = {}): Promise<BackupManifest> {
  if (!NAME_PATTERN.test(name)) throw new BackupError(BAD_NAME);
  assertInsideWeb(cfg.dataDir, cfg.webRoot);
  const command = describeCommand(process.env, process.argv);
  await acquireLock(cfg.dataDir, deps.lock ?? nodeLockDeps(command));
  try {
    const dir = join(cfg.dataDir, "backups", name);
    const manifest = readManifest(dir, name);
    const pgdata = verifiedPart(dir, "pgdata.tar.gz", manifest.parts["pgdata.tar.gz"]);
    const filesZip = verifiedPart(dir, "files.zip", manifest.parts["files.zip"]);
    const publicSha = manifest.parts["public-data.sql"];
    if (publicSha !== null) verifiedPart(dir, "public-data.sql", publicSha);
    if (manifest.pgliteVersion !== pgliteVersionOf(cfg)) {
      throw new BackupError(
        `Il backup è stato fatto con un'altra versione del database (${manifest.pgliteVersion}): non si può ripristinare.`,
      );
    }
    if (!codeMigrations(cfg).includes(manifest.lastMigration)) throw new BackupError(NEWER_BACKUP);
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(filesZip);
    } catch {
      throw new BackupError("Il backup è danneggiato: files.zip non si apre.");
    }

    const current = (dirName: string) => join(cfg.dataDir, dirName);
    const old = (dirName: string) => join(cfg.dataDir, `${dirName}${OLD_SUFFIX}`);
    if (DATA_DIRS.some((dirName) => existsSync(old(dirName)))) {
      console.warn(`[backup] Cartelle ${OLD_SUFFIX} rimaste in ${cfg.dataDir}.`);
      throw new BackupError(HALF_RESTORE);
    }

    const moved: string[] = [];
    try {
      for (const dirName of DATA_DIRS) {
        if (!existsSync(current(dirName))) continue;
        renameSync(current(dirName), old(dirName));
        moved.push(dirName);
      }
      const open = deps.open ?? openDb;
      const { pg } = await open({
        dataDir: cfg.dataDir,
        supabaseDir: join(cfg.webRoot, "supabase"),
        command,
        loadDataDir: new Blob([pgdata]),
      });
      await pg.close();
      for (const [key, bytes] of Object.entries(files)) {
        if (key.endsWith("/")) continue;
        const target = join(current("files"), key);
        if (relative(current("files"), target).startsWith("..")) {
          throw new BackupError("Il backup è danneggiato: files.zip non corrisponde.");
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
    } catch (error) {
      for (const dirName of DATA_DIRS) rmSync(current(dirName), { recursive: true, force: true });
      for (const dirName of moved) renameSync(old(dirName), current(dirName));
      throw error;
    }
    for (const dirName of moved) rmSync(old(dirName), { recursive: true, force: true });
    return manifest;
  } finally {
    releaseLock(cfg.dataDir, process.pid);
  }
}
