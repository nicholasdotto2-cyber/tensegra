import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isActive } from "@/lib/agenda/status";
import { weekdayDayNumeric } from "@/lib/format";
import { DEMO_PRACTICE_ID, getActor } from "@/server/auth/actor";
import { fixedClock } from "@/server/clock";
import type { Db } from "@/server/db/db";
import * as locks from "@/server/db/lock";
import * as pglite from "@/server/db/pglite";
import { demoCheck } from "@/server/demo/check";
import { markDone } from "@/server/domain/appointments/commands";
import { listDayAppointments } from "@/server/domain/appointments/queries";
import { seedDemo } from "../../seed/demo";
import { openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

// Il comando non deve leggere i file .env durante questi test.
vi.mock("../../scripts/script-env", () => ({
  loadNextEnvFiles: () => {},
  webRootOf: () => process.cwd(),
}));

const seedClock = fixedClock("2026-11-04T07:00:00+01:00");
const clock = fixedClock("2026-11-04T08:30:00+01:00");
const readyLines = [
  "Dati di prova creati oggi alle 07:00.",
  "Appuntamenti di oggi: 5",
  "Consensi mancanti: 2",
  "Fatture da emettere: 2",
  "Promemoria per domani: 3",
  "Da richiamare: 2",
  "Pronto per la demo.",
];
let db: Db;
let pg: PGlite;

beforeEach(async () => {
  ({ db, pg } = await openTestDb());
});
afterEach(async () => {
  await pg.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function seed() {
  await seedDemo(db, seedClock, new MemoryFileStore());
}

it("demo_check_pronto", async () => {
  await seed();
  expect(await demoCheck(db, clock)).toEqual({ ok: true, lines: readyLines });
});

it("demo_check_dopo_le_17", async () => {
  await seed();
  expect(await demoCheck(db, fixedClock("2026-11-04T18:30:00+01:00")))
    .toEqual({ ok: true, lines: readyLines });
});

it("demo_check_dati_di_ieri", async () => {
  await seed();
  const result = await demoCheck(db, fixedClock("2026-11-05T08:30:00+01:00"));
  expect(result.ok).toBe(false);
  expect(result.lines[0]).toBe(`I dati di prova sono di ${weekdayDayNumeric("2026-11-04")}: esegui pnpm demo:prep oppure "Ricrea per oggi".`);
  expect(result.lines).not.toContain("Pronto per la demo.");
});

it("demo_check_differenza", async () => {
  await seed();
  await db.asUser(getActor(), async (tx) => {
    const rows = await listDayAppointments(tx, DEMO_PRACTICE_ID, clock, clock.today());
    const marco = rows.find((row) => row.patientLabel.includes("Bellandi") && isActive(row.status));
    expect(marco).toBeDefined();
    await markDone(tx, DEMO_PRACTICE_ID, clock, { id: marco!.id });
  });
  const result = await demoCheck(db, clock);
  expect(result.ok).toBe(false);
  expect(result.lines).toContain("Atteso 2, trovato 3: Fatture da emettere.");
  expect(result.lines).not.toContain("Pronto per la demo.");
});

it("demo_check_senza_studio", async () => {
  await expect(demoCheck(db, clock)).rejects.toThrow("Nessun dato demo: esegui pnpm db:seed.");
});

it("demo_check_lock", async () => {
  const base = resolve("../.tmp");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "demo-check-lock-"));
  const info: locks.LockInfo = {
    pid: 4242, startedAt: "2026-11-04T07:30:00.000Z", command: "pnpm start", exe: "node.exe",
  };
  const content = JSON.stringify(info);
  writeFileSync(join(dir, "app.lock"), content);
  const create = vi.spyOn(pglite, "createPglite");
  let elapsed = 0;
  vi.spyOn(locks, "nodeLockDeps").mockReturnValue({
    pid: process.pid, command: "demo-check", exe: "node.exe",
    isAlive: () => true, exeOf: () => ({ kind: "found", exe: "node.exe" }),
    sleep: async (ms) => { elapsed += ms; },
    now: () => new Date(clock.now().getTime() + elapsed), log: () => {},
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("APP_DATA_DIR", dir);
  vi.stubEnv("APP_FIXED_NOW", "2026-11-04T08:30:00+01:00");
  const argv = process.argv;
  const exitCode = process.exitCode;
  process.argv = [process.execPath, "scripts/db.ts", "demo-check"];
  try {
    await import("../../scripts/db");
    expect(error).toHaveBeenCalledWith(locks.formatLockMessage(info));
    expect(process.exitCode).toBe(1);
    expect(create).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "app.lock"), "utf8")).toBe(content);
    expect(readdirSync(dir)).toEqual(["app.lock"]);
    expect(existsSync(join(dir, "pglite"))).toBe(false);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});
