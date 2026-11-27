import type { SystemStateProps } from "@/components/shell/system-state";
import type { LockInfo } from "@/server/db/lock";

// Gli errori noti dell'apertura del database diventano uno stato leggibile. In
// produzione `next build` compila i moduli del database una volta per bundle: l'errore può
// venire dalla copia di un'altra route, e allora `instanceof` è falso. Si riconosce quindi dal
// `name`, che ogni classe fissa nel costruttore, più i campi che lo stato legge. Sta fuori da
// layout.tsx, che passa da next.ts e quindi da "server-only": così Vitest la prova da sola.

function named(error: unknown, ...names: string[]): error is Error & Record<string, unknown> {
  return error instanceof Error && names.includes(error.name);
}

function isLockInfo(value: unknown): value is LockInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  return (
    typeof info.pid === "number" &&
    typeof info.startedAt === "string" &&
    typeof info.command === "string" &&
    typeof info.exe === "string"
  );
}

/** Lo stato da mostrare per un errore dell'apertura; ogni altro errore si rilancia così com'è. */
export function systemStateFor(error: unknown): SystemStateProps {
  if (named(error, "DataDirLockedError") && isLockInfo(error.info)) {
    // Il messaggio originale va solo nel log del server.
    console.error(`[app] ${error.message}`);
    return { kind: "locked", info: error.info };
  }
  if (named(error, "MigrationChangedError", "MigrationFailedError") && typeof error.fileName === "string") {
    console.error(`[app] ${error.message}`);
    return { kind: "migration", fileName: error.fileName };
  }
  if (named(error, "NoPracticeError")) return { kind: "no-data" };
  throw error;
}
