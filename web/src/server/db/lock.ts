import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { romeTime } from "@/server/clock";

// Lock a mano contro due processi sulla stessa cartella dati: PGlite non ne ha uno.
// Il file app.lock si crea in modo atomico; chi lo trova decide se è vecchio o ancora in uso.

const LOCK_FILE = "app.lock";
const WAIT_MS = 5000;
const POLL_MS = 250;
// Windows riusa i PID anche per lo stesso eseguibile: serve l'avvio del processo.
export type ProcessProbe =
  | { kind: "found"; exe: string; processStartedAt?: string }
  | { kind: "absent" }
  | { kind: "unknown"; reason: "timeout" | "error" };

export interface LockInfo {
  pid: number;
  /** ISO UTC. */
  startedAt: string;
  /** Avvio del processo in ISO UTC; assente nei lock del vecchio formato. */
  processStartedAt?: string;
  command: string;
  exe: string;
}

export function formatLockMessage(info: LockInfo): string {
  const time = romeTime(new Date(info.startedAt));
  return `I dati sono già aperti da un altro processo (PID ${info.pid}, avviato alle ${time} con ${info.command}). Chiudi quel processo. Se sei sicuro che non esiste più, esegui pnpm db:unlock.`;
}

export class DataDirLockedError extends Error {
  readonly info: LockInfo;

  constructor(info: LockInfo) {
    super(formatLockMessage(info));
    this.name = "DataDirLockedError";
    this.info = info;
  }
}

export interface LockDeps {
  pid: number;
  command: string;
  exe: string;
  isAlive(pid: number): boolean;
  /** Identità del processo; un errore non prova che sia terminato. */
  exeOf(pid: number): ProcessProbe;
  sleep(ms: number): Promise<void>;
  now(): Date;
  log(message: string): void;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: il processo non c'è. EPERM: c'è, ma è di un altro utente.
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}

const processSchema = z.object({ exe: z.string().min(1), processStartedAt: z.iso.datetime() });

function exeOf(pid: number, timeout: number): ProcessProbe {
  try {
    const options: ExecFileSyncOptionsWithStringEncoding = {
      encoding: "utf8",
      windowsHide: true,
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
    };
    if (process.platform === "win32") {
      const script = `try {
        $p = Get-Process -Id ${pid} -ErrorAction Stop
        @{ exe = $p.ProcessName + '.exe'; processStartedAt = $p.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") } | ConvertTo-Json -Compress
      } catch {
        if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { exit 3 }
        exit 1
      }`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], options);
      const info = processSchema.parse(JSON.parse(out.trim()));
      return { kind: "found", ...info, exe: info.exe.toLowerCase() };
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], {
      ...options, env: { ...process.env, LC_ALL: "C" },
    }).trim();
    if (!out) return { kind: "absent" };
    const match = /^(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(out);
    if (!match?.[1] || !match[2]) return { kind: "unknown", reason: "error" };
    // Su Linux comm è il nome del thread principale, che Node rinomina ("MainThread"): l'eseguibile vero è in /proc.
    const exe = process.platform === "linux" ? readlinkSync(`/proc/${pid}/exe`) : match[2];
    return { kind: "found", exe: basename(exe).toLowerCase(), processStartedAt: new Date(match[1]).toISOString() };
  } catch (error) {
    if (errorCode(error) === "ETIMEDOUT") return { kind: "unknown", reason: "timeout" };
    const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
    if (status === 3 || (process.platform !== "win32" && status === 1 && !isAlive(pid))) return { kind: "absent" };
    return { kind: "unknown", reason: "error" };
  }
}

export function nodeLockDeps(command: string, probeTimeoutMs = 5000): LockDeps {
  return {
    pid: process.pid,
    command,
    exe: basename(process.execPath).toLowerCase(),
    isAlive,
    exeOf: (pid) => exeOf(pid, probeTimeoutMs),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // Ora vera, non systemClock: con APP_FIXED_NOW l'attesa non finirebbe mai.
    now: () => new Date(),
    log: (message) => console.warn(`[lock] ${message}`),
  };
}

export function describeCommand(env: NodeJS.ProcessEnv, argv: string[]): string {
  if (env.npm_lifecycle_event) return `pnpm ${env.npm_lifecycle_event}`;
  const script = argv[1];
  return script ? `node ${basename(script)}` : "node";
}

const lockSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.iso.datetime(),
  processStartedAt: z.iso.datetime().optional(),
  command: z.string(),
  exe: z.string(),
});

/** Il lock com'è sul disco; null se manca o non è leggibile. */
export function readLock(dataDir: string): LockInfo | null {
  try {
    const parsed = lockSchema.safeParse(JSON.parse(readFileSync(join(dataDir, LOCK_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function tryCreate(file: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(file, "wx");
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(info));
  } catch (error) {
    closeSync(fd);
    rmSync(file, { force: true });
    throw error;
  }
  closeSync(fd);
  return true;
}

/** Il lock è di un processo morto o di un PID riusato. Lo usa anche `db:unlock`. */
export function isStale(held: LockInfo, deps: LockDeps): boolean {
  if (!deps.isAlive(held.pid)) return true;
  const probe = deps.exeOf(held.pid);
  if (probe.kind === "absent") return true;
  if (probe.kind === "unknown") return false;
  if (held.processStartedAt) {
    // Senza l'avvio non possiamo provare che il PID sia stato riusato.
    return probe.processStartedAt !== undefined && probe.processStartedAt !== held.processStartedAt;
  }
  return probe.exe !== held.exe;
}

// Decidere se un lock è vecchio può durare centinaia di ms (la sonda lancia un comando): nel
// frattempo un altro processo può aver tolto quel lock e scritto il suo. Si cancella solo se
// il file è ancora quello giudicato vecchio (stesso pid e stesso avvio, o ancora illeggibile).
function removeIfUnchanged(dataDir: string, seen: LockInfo | null): boolean {
  const current = readLock(dataDir);
  const unchanged =
    seen === null
      ? current === null
      : current !== null && current.pid === seen.pid && current.startedAt === seen.startedAt &&
        current.processStartedAt === seen.processStartedAt;
  if (unchanged) rmSync(join(dataDir, LOCK_FILE), { force: true });
  return unchanged;
}

export async function acquireLock(dataDir: string, deps: LockDeps): Promise<LockInfo> {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, LOCK_FILE);
  const owner = deps.exeOf(deps.pid);
  const mine: LockInfo = {
    pid: deps.pid,
    startedAt: deps.now().toISOString(),
    command: deps.command,
    exe: deps.exe,
    ...(owner.kind === "found" && owner.processStartedAt ? { processStartedAt: owner.processStartedAt } : {}),
  };
  const deadline = deps.now().getTime() + WAIT_MS;
  for (;;) {
    if (tryCreate(file, mine)) return mine;
    const held = readLock(dataDir);
    // HMR può continuare solo se il PID non appartiene a un altro avvio. Se uno dei due avvii non si
    // conosce (sonda in timeout a macchina carica) vale la regola di prima: stesso PID, stesso processo.
    if (
      held?.pid === deps.pid &&
      (!held.processStartedAt || !mine.processStartedAt || held.processStartedAt === mine.processStartedAt)
    ) return held;
    const timeUp = deps.now().getTime() >= deadline;
    if (held ? isStale(held, deps) : timeUp) {
      // Un file illeggibile può essere in scrittura in quel momento: si aspetta prima di buttarlo.
      if (removeIfUnchanged(dataDir, held)) {
        deps.log(
          held
            ? `Lock vecchio del PID ${held.pid} (${held.exe}) rimosso.`
            : "Lock illeggibile rimosso.",
        );
      }
      continue;
    }
    if (held && timeUp) throw new DataDirLockedError(held);
    await deps.sleep(POLL_MS);
  }
}

/** Cancella il lock solo se è di questo PID. */
export function releaseLock(dataDir: string, pid: number): void {
  if (readLock(dataDir)?.pid === pid) rmSync(join(dataDir, LOCK_FILE), { force: true });
}
