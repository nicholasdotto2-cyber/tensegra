import path from "node:path";
import { z } from "zod";

// Errore di configurazione: il messaggio è per l'utente, quindi in italiano
// e senza percorsi né valori delle variabili.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface AppConfig {
  readonly webRoot: string;
  readonly dataDir: string;
  readonly fixedNow: Date | null;
  readonly demoMode: boolean;
}

// process.env ci entra; Next vi aggiunge NODE_ENV come obbligatoria, quindi un oggetto
// di prova come { APP_DEMO_MODE: "1" } non sarebbe un NodeJS.ProcessEnv per tsc.
type EnvSource = Readonly<Record<string, string | undefined>>;

const envSchema = z.object({
  APP_DATA_DIR: z.string().optional(),
  APP_FIXED_NOW: z.iso.datetime({ offset: true }).optional(),
  APP_DEMO_MODE: z.enum(["0", "1"]).optional(),
});

const ENV_MESSAGES: Record<string, string> = {
  APP_FIXED_NOW:
    "APP_FIXED_NOW non è valida: serve una data ISO con fuso, per esempio 2026-11-04T08:30:00+01:00.",
  APP_DEMO_MODE: "APP_DEMO_MODE non è valida: usa 0 oppure 1.",
};

// Una variabile vuota (per esempio "APP_FIXED_NOW=") vale come assente.
function readEnv(env: EnvSource) {
  const pick = (name: string): string | undefined => env[name] || undefined;
  return {
    APP_DATA_DIR: pick("APP_DATA_DIR"),
    APP_FIXED_NOW: pick("APP_FIXED_NOW"),
    APP_DEMO_MODE: pick("APP_DEMO_MODE"),
  };
}

export function loadConfig(
  env: EnvSource = process.env,
  cwd: string = process.cwd(),
): AppConfig {
  const parsed = envSchema.safeParse(readEnv(env));
  if (!parsed.success) {
    const messages = new Set<string>();
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? "");
      messages.add(ENV_MESSAGES[name] ?? "La configurazione non è valida.");
    }
    throw new ConfigError([...messages].join(" "));
  }
  const vars = parsed.data;
  return {
    webRoot: cwd,
    dataDir: path.resolve(cwd, vars.APP_DATA_DIR ?? ".data"),
    fixedNow: vars.APP_FIXED_NOW ? new Date(vars.APP_FIXED_NOW) : null,
    demoMode: vars.APP_DEMO_MODE === "1",
  };
}

// reset e restore cancellano o riscrivono la cartella dati: si fermano prima
// se, risolta, non sta strettamente dentro web/ (stessa cartella compresa).
export function assertInsideWeb(dataDir: string, webRoot: string): void {
  const rel = path.relative(path.resolve(webRoot), path.resolve(dataDir));
  const inside =
    rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  if (!inside) {
    throw new ConfigError("La cartella dati deve stare dentro web/.");
  }
}
