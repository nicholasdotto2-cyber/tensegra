import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fixedClock } from "@/server/clock";
import type { Db } from "@/server/db/db";
import { createPatient } from "@/server/domain/patients/commands";
import { PRACTICE_A } from "./fixtures";
import { inUserA, openTestDb } from "./helpers";

const clock = fixedClock("2026-11-04T08:30:00+01:00");
let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

it("createPatient salva il cognome convertito nella riga dello studio A", async () => {
  const row = await inUserA(db, async (tx) => {
    const { id } = await createPatient(tx, PRACTICE_A, clock, {
      firstName: "Lucia", lastName: "D’Amico", birthDate: "1990-01-01", phone: null,
    });
    const [saved] = await tx.query<{ last_name: string }>(
      "select last_name from public.patients where practice_id = $1 and id = $2",
      [PRACTICE_A, id],
    );
    return saved;
  });
  expect(row?.last_name).toBe("D'Amico");
});
