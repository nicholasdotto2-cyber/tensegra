import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { systemClock } from "@/server/clock";
import { type AppConfig, ConfigError, loadConfig } from "@/server/config";
import { BackupError, backupDataDir, restoreDataDir } from "@/server/db/backup";
import type { Db } from "@/server/db/db";
import { logDbError } from "@/server/db/errors";
import {
  DataDirLockedError,
  describeCommand,
  formatLockMessage,
  nodeLockDeps,
  readLock,
  releaseLock,
} from "@/server/db/lock";
import { resetDataDir, unlockDataDir } from "@/server/db/maintenance";
import { MigrationChangedError, MigrationFailedError } from "@/server/db/migrate";
import { openDb } from "@/server/db/open";
import { demoCheck, DemoCheckError } from "@/server/demo/check";
import { DiskFileStore, filesRoot } from "@/server/files/disk-store";
import { demoExists, seedDemo } from "../seed/demo";
import { loadNextEnvFiles, webRootOf } from "./script-env";

// Comandi del database: pnpm db:migrate, db:seed, db:reset, db:unlock, db:backup, db:restore,
// demo:check. Prendono lo
// stesso lock dell'app, quindi con l'app accesa si fermano con un messaggio. Uscita 0 se il
// comando è andato, 1 con un messaggio in italiano e senza percorsi se no.

const webRoot = webRootOf(import.meta.url);
// Gli stessi file .env* che legge `next start` (.env, .env.local): APP_DATA_DIR e APP_FIXED_NOW
// valgono uguali per l'app e per i comandi. Una variabile già nell'ambiente vince sui file.
loadNextEnvFiles(webRoot);

const E2E_DATA_DIR = ".data/e2e";
const CONFIRM_WORD = "SBLOCCA";

/** Un errore il cui messaggio è già per l'utente. */
class CliError extends Error {}

/** Apre (e migra), fa il lavoro, poi chiude PGlite e rilascia il lock: anche se il lavoro fallisce. */
async function withDb<T>(cfg: AppConfig, fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, pg } = await openDb({ dataDir: cfg.dataDir, supabaseDir: join(cfg.webRoot, "supabase") });
  try {
    return await fn(db);
  } finally {
    if (!pg.closed) await pg.close();
    releaseLock(cfg.dataDir, process.pid);
  }
}

// Risposta vuota se stdin si chiude senza che l'utente scriva niente (script, CI). Da terminale
// l'a capo lo scrive l'utente premendo Invio; da pipe lo scriviamo noi, per non attaccare
// il messaggio che segue alla domanda.
function ask(question: string): Promise<string> {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    const finish = (answer: string) => {
      if (!process.stdin.isTTY) process.stdout.write("\n");
      resolveAnswer(answer);
    };
    rl.on("close", () => {
      if (!answered) finish("");
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      finish(answer);
    });
  });
}

async function migrate(cfg: AppConfig): Promise<void> {
  await withDb(cfg, async () => {});
  console.log("Migrazioni applicate.");
}

async function seed(cfg: AppConfig): Promise<void> {
  const created = await withDb(cfg, async (db) => {
    if (await demoExists(db)) return false;
    // Lo store dei file della stessa cartella dati dell'app.
    await seedDemo(db, systemClock, new DiskFileStore(filesRoot(cfg)));
    return true;
  });
  console.log(created ? "Dati demo creati." : "Dati demo già presenti. Per ripartire: pnpm db:reset.");
}

async function checkDemo(cfg: AppConfig): Promise<void> {
  const { lines, ok } = await withDb(cfg, (db) => demoCheck(db, systemClock));
  for (const line of lines) console.log(line);
  if (!ok) process.exitCode = 1;
}

async function reset(cfg: AppConfig, empty: boolean): Promise<void> {
  await resetDataDir(cfg, { seed: !empty, clock: systemClock });
  console.log(empty ? "Database ricreato, senza dati demo." : "Database ricreato con i dati demo.");
}

// Come reset, ma solo sulla cartella dei test e2e: un APP_DATA_DIR sbagliato non cancella i dati veri.
async function e2eReset(cfg: AppConfig): Promise<void> {
  if (cfg.dataDir !== resolve(cfg.webRoot, E2E_DATA_DIR)) {
    throw new CliError(`e2e-reset lavora solo sui dati dei test e2e: imposta APP_DATA_DIR=${E2E_DATA_DIR}.`);
  }
  await reset(cfg, false);
}

async function unlock(cfg: AppConfig, force: boolean): Promise<void> {
  const deps = nodeLockDeps(describeCommand(process.env, process.argv));
  let result = unlockDataDir(cfg.dataDir, deps, false);
  if (result === "refused") {
    const held = readLock(cfg.dataDir);
    if (!held) {
      result = "none"; // tolto da un altro processo fra i due controlli
    } else if (!force) {
      throw new CliError(
        `${formatLockMessage(held)}\nIl processo è ancora attivo. Se sei sicuro, esegui pnpm db:unlock --force.`,
      );
    } else {
      console.log(`${formatLockMessage(held)}\nIl processo è ancora attivo.`);
      if ((await ask(`Scrivi ${CONFIRM_WORD} per confermare: `)).trim() !== CONFIRM_WORD) {
        throw new CliError("Sblocco annullato: il lock è rimasto dov'era.");
      }
      result = unlockDataDir(cfg.dataDir, deps, true);
    }
  }
  console.log(result === "removed" ? "Lock rimosso." : "Nessun lock.");
}

async function backup(cfg: AppConfig): Promise<void> {
  const { name } = await backupDataDir(cfg, systemClock);
  console.log(`Backup creato: ${name}.`);
}

async function restore(cfg: AppConfig, name: string): Promise<void> {
  await restoreDataDir(cfg, name);
  console.log(`Dati ripristinati dal backup ${name}.`);
}

interface Command {
  /** Le opzioni ammesse: qualunque altra ferma il comando prima che tocchi i dati. */
  flags: readonly string[];
  /** Quanti argomenti senza `--` vuole il comando (default nessuno). */
  args?: number;
  /** Il messaggio se gli argomenti non sono quanti servono. */
  usage?: string;
  run(cfg: AppConfig, flags: readonly string[], args: readonly string[]): Promise<void>;
}

// Una Map, non un oggetto: "constructor" o "toString" non devono risultare comandi.
const COMMANDS = new Map<string, Command>([
  ["migrate", { flags: [], run: migrate }],
  ["seed", { flags: [], run: seed }],
  ["demo-check", { flags: [], run: checkDemo }],
  ["reset", { flags: ["--empty"], run: (cfg, flags) => reset(cfg, flags.includes("--empty")) }],
  ["unlock", { flags: ["--force"], run: (cfg, flags) => unlock(cfg, flags.includes("--force")) }],
  ["e2e-reset", { flags: [], run: e2eReset }],
  ["backup", { flags: [], run: backup }],
  [
    "restore",
    {
      flags: [],
      args: 1,
      usage: "Indica il backup da ripristinare: pnpm db:restore 20261104-1805.",
      run: (cfg, _flags, args) => restore(cfg, args[0] ?? ""),
    },
  ],
]);

async function run(name: string | undefined, rest: readonly string[]): Promise<void> {
  const command = name === undefined ? undefined : COMMANDS.get(name);
  if (!command) {
    throw new CliError(
      "Comando non riconosciuto. Usa: migrate, seed, demo-check, reset [--empty], unlock [--force], e2e-reset, backup, restore <nome>.",
    );
  }
  const flags = rest.filter((arg) => arg.startsWith("--"));
  const args = rest.filter((arg) => !arg.startsWith("--"));
  const unknown = flags.find((flag) => !command.flags.includes(flag));
  if (unknown !== undefined) throw new CliError(`Opzione non riconosciuta per ${name}: ${unknown}.`);
  if (args.length !== (command.args ?? 0)) {
    throw new CliError(command.usage ?? `Argomento non riconosciuto per ${name}: ${args[0]}.`);
  }
  await command.run(loadConfig(process.env, webRoot), flags, args);
}

/** Il messaggio per l'utente; il dettaglio tecnico di un errore inatteso va nel log, non nel messaggio. */
function messageFor(error: unknown, name: string | undefined): string {
  if (
    error instanceof CliError ||
    error instanceof BackupError ||
    error instanceof DemoCheckError ||
    error instanceof ConfigError ||
    error instanceof DataDirLockedError ||
    error instanceof MigrationChangedError
  ) {
    return error.message;
  }
  logDbError(error, `db ${name ?? ""}`.trim());
  if (error instanceof MigrationFailedError) return `La migrazione ${error.fileName} non è riuscita.`;
  return "Operazione non riuscita. Il dettaglio tecnico è nella riga [db] qui sopra.";
}

const [name, ...rest] = process.argv.slice(2);
try {
  await run(name, rest);
} catch (error) {
  console.error(messageFor(error, name));
  process.exitCode = 1;
}
