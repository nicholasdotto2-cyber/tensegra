import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/db";
import { asUserA, openTestDb } from "./helpers";

// Il banco di prova apre PGlite come l'app: sessione in UTC e `date` come stringa
// "AAAA-MM-GG". Se i due divergono, un test passa su un comportamento che `next start` non ha.

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

describe("openTestDb apre PGlite come l'app", () => {
  it("la sessione è in UTC", async () => {
    const { rows } = await pg.query<{ TimeZone: string }>("show timezone");
    expect(rows).toEqual([{ TimeZone: "UTC" }]);
  });

  it("una date resta la stringa AAAA-MM-GG, anche dentro asUser", async () => {
    const { rows } = await pg.query<{ d: string }>("select '2026-10-22'::date as d");
    expect(rows).toEqual([{ d: "2026-10-22" }]);
    expect(await asUserA(db, (tx) => tx.query("select '2026-10-22'::date as d"))).toEqual([{ d: "2026-10-22" }]);
  });
});
