import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/db";
import { BuildPhaseError, cachedOpen, openDb } from "@/server/db/open";

// Un Db finto: cachedOpen non lo usa, conta solo che sia lo stesso oggetto.
function fakeDb(): Db {
  return {
    asUser: () => Promise.reject(new Error("non usato nel test")),
  };
}

describe("cachedOpen", () => {
  it("due chiamate concorrenti aspettano la stessa apertura", async () => {
    const key = Symbol("test.open.concurrent");
    const db = fakeDb();
    const open = vi.fn(() => new Promise<Db>((resolve) => setTimeout(() => resolve(db), 20)));

    const [first, second] = await Promise.all([cachedOpen(key, open), cachedOpen(key, open)]);

    expect(open).toHaveBeenCalledTimes(1);
    expect(first).toBe(db);
    expect(second).toBe(first);
  });

  it("una Promise rifiutata non resta in cache", async () => {
    const key = Symbol("test.open.retry");
    const db = fakeDb();
    const open = vi
      .fn<() => Promise<Db>>()
      .mockRejectedValueOnce(new Error("lock preso"))
      .mockResolvedValueOnce(db);

    await expect(cachedOpen(key, open)).rejects.toThrow("lock preso");
    await expect(cachedOpen(key, open)).resolves.toBe(db);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("openDb", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("openDb rifiuta in fase di build", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    const dataDir = join(process.cwd(), ".data", "test", `open-build-${process.pid}-${Date.now()}`);

    await expect(openDb({ dataDir })).rejects.toBeInstanceOf(BuildPhaseError);
    expect(existsSync(dataDir)).toBe(false);
  });
});
