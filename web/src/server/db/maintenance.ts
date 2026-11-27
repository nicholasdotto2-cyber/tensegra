import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "@/server/clock";
import { type AppConfig, assertInsideWeb } from "@/server/config";
import { DiskFileStore } from "@/server/files/disk-store";
import { seedDemo } from "../../../seed/demo";
import { acquireLock, describeCommand, isStale, type LockDeps, nodeLockDeps, readLock, releaseLock } from "./lock";
import { openDb } from "./open";

// Operazioni sulla cartella dati che non sono una richiesta dell'app:
// la ricreazione per `pnpm db:reset` e lo sblocco per `pnpm db:unlock`.

// Le sole cartelle che il reset cancella: `backups/`, `e2e/` e `test/` non si toccano mai.
const RESET_DIRS = ["pglite", "files"] as const;

/**
 * Cancella `pglite/` e `files/`, riapre (initdb), migra e, con `seed`, semina lo studio demo.
 * Prima controlla che la cartella stia dentro web/ e prende il lock: con l'app accesa si ferma
 * senza aver cancellato niente. Alla fine chiude PGlite e rilascia il lock.
 */
export async function resetDataDir(cfg: AppConfig, opts: { seed: boolean; clock: Clock }): Promise<void> {
  assertInsideWeb(cfg.dataDir, cfg.webRoot);
  const command = describeCommand(process.env, process.argv);
  await acquireLock(cfg.dataDir, nodeLockDeps(command));
  try {
    for (const name of RESET_DIRS) rmSync(join(cfg.dataDir, name), { recursive: true, force: true });
    // openDb trova il lock già di questo PID e continua.
    const { db, pg } = await openDb({ dataDir: cfg.dataDir, supabaseDir: join(cfg.webRoot, "supabase"), command });
    try {
      // I file del seed nella `files/` appena svuotata, accanto a `pglite/`.
      if (opts.seed) await seedDemo(db, opts.clock, new DiskFileStore(join(cfg.dataDir, "files")));
    } finally {
      await pg.close();
    }
  } finally {
    releaseLock(cfg.dataDir, process.pid);
  }
}

export type UnlockResult = "none" | "removed" | "refused";

/**
 * Toglie `app.lock`. Senza `force` solo se il processo che lo teneva non c'è più o se quel PID
 * oggi è un altro programma; con `force` anche se è ancora un node.exe vivo (la conferma scritta
 * la chiede il comando, non questa funzione).
 */
export function unlockDataDir(dataDir: string, deps: LockDeps, force: boolean): UnlockResult {
  const held = readLock(dataDir);
  if (!held) return "none";
  if (!force && !isStale(held, deps)) return "refused";
  releaseLock(dataDir, held.pid);
  return "removed";
}
