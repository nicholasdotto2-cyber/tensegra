import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { loadConfig } from "@/server/config";
import { createDb, type Db } from "./db";
import { acquireLock, describeCommand, nodeLockDeps, releaseLock } from "./lock";
import { runMigrations } from "./migrate";
import { createPglite } from "./pglite";

// Apertura di PGlite su disco. Niente qui apre il database all'import: in build
// Next importa le route, quindi l'apertura parte solo da una richiesta (getDb).

const APP_PGLITE_KEY = Symbol.for("app.pglite");

/** `next build` importa le route: la build non apre mai i dati. */
export class BuildPhaseError extends Error {
  constructor() {
    super("La build non apre i dati: il database si apre solo durante una richiesta.");
    this.name = "BuildPhaseError";
  }
}

export interface OpenOptions {
  dataDir: string;
  /** Default `<cwd>/supabase`, cioè `web/supabase`. */
  supabaseDir?: string;
  /** Scritto nel lock; default il comando che ha avviato il processo. */
  command?: string;
  /** Un dump di `dumpDataDir` da cui creare la cartella vuota (il restore). */
  loadDataDir?: Blob;
}

export async function openDb(opts: OpenOptions): Promise<{ db: Db; pg: PGlite }> {
  if (process.env.NEXT_PHASE === "phase-production-build") throw new BuildPhaseError();
  const { dataDir } = opts;
  mkdirSync(dataDir, { recursive: true });
  await acquireLock(dataDir, nodeLockDeps(opts.command ?? describeCommand(process.env, process.argv)));

  let pg: PGlite | undefined;
  try {
    pg = await createPglite({
      dataDir: join(dataDir, "pglite"),
      ...(opts.loadDataDir ? { loadDataDir: opts.loadDataDir } : {}),
    });
    await runMigrations(pg, opts.supabaseDir ?? join(process.cwd(), "supabase"));
  } catch (error) {
    // Il chiamante può riprovare nello stesso processo (cachedOpen): un PGlite rimasto aperto
    // sulla stessa cartella romperebbe i dati, e il lock di questo PID non lo fermerebbe.
    await pg?.close().catch(() => {});
    releaseLock(dataDir, process.pid);
    throw error;
  }

  // Niente pg.close() nei gestori di segnale: i dati reggono anche a un taskkill /F.
  process.once("exit", () => releaseLock(dataDir, process.pid));
  return { db: createDb(pg), pg };
}

type OpenStore = Record<symbol, Promise<Db> | undefined>;

/**
 * Una sola apertura per processo: la Promise sta su `globalThis` (sopravvive all'HMR di
 * `next dev`), così due richieste al primo avvio aspettano la stessa. Una Promise rifiutata
 * esce dalla cache e la richiesta dopo riprova (per esempio dopo `pnpm db:unlock`).
 */
export function cachedOpen(key: symbol, open: () => Promise<Db>): Promise<Db> {
  const store = globalThis as unknown as OpenStore;
  const cached = store[key];
  if (cached) return cached;
  const opening = open();
  store[key] = opening;
  opening.catch(() => {
    if (store[key] === opening) delete store[key];
  });
  return opening;
}

/** Il database dell'app, aperto alla prima richiesta nella cartella di `APP_DATA_DIR`. */
export function getDb(): Promise<Db> {
  return cachedOpen(APP_PGLITE_KEY, async () => (await openDb({ dataDir: loadConfig().dataDir })).db);
}
