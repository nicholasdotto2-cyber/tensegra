import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Gli script (`pnpm db:*`, `pnpm test:smoke`) vedono la stessa configurazione di `next start`.

/**
 * La cartella web/ di uno script di `web/scripts/`, ricavata dal suo path (`import.meta.url`) e
 * non dalla cartella corrente: `tsx web/scripts/db.ts` lanciato dalla radice del repo
 * lavora comunque su `web/.data` e `web/supabase`.
 */
export function webRootOf(scriptUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(scriptUrl)), "..");
}

// @next/env è un bundle CommonJS: con un import ESM Node non ne vede gli export per nome.
const { loadEnvConfig } = createRequire(import.meta.url)("@next/env") as typeof import("@next/env");

/**
 * Carica in `process.env` gli stessi file .env* che legge `next start` (`.env`, `.env.local` e le
 * varianti `production`): APP_DATA_DIR e APP_FIXED_NOW valgono uguali per l'app e per i comandi.
 * Una variabile già nell'ambiente vince sui file, come in Next.
 */
export function loadNextEnvFiles(webRoot: string): void {
  loadEnvConfig(webRoot);
}
