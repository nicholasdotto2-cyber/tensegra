import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/db";
import { PRACTICE_A, PRACTICE_B } from "./fixtures";
import { type Case, expectPgError, idOf, insertRow, inService, openTestDb, type Values } from "./helpers";

// Vincoli e default del listino: public.services. Ogni test gira in una
// transazione che torna indietro, sullo studio A delle fixture (una voce attiva, "Seduta
// osteopatica"); un caso che fallisce per transazione, con il codice Postgres esatto.

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

// Il nome non è quello della fixture ("Seduta osteopatica"): una voce nuova non urta l'indice
// sul nome delle voci attive, salvo nei casi che lo provano.
const service = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  kind: "seduta",
  name: "Seduta",
  invoice_description: "Seduta di osteopatia",
  duration_min: 45,
  price_cents: 6000,
  color: "petrolio",
  ...extra,
});

const ARCHIVED_AT = "2026-10-20T08:00:00Z";

describe("public.services", () => {
  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "services", service()));
    expect(row).toMatchObject({ sort_order: 0, archived_at: null });
  });

  it.each<Case>([
    ["kind", "massaggio"],
    ["kind", "Seduta"],
    ["duration_min", 50],
    ["duration_min", 0],
    ["duration_min", 10],
    ["duration_min", 135],
    ["price_cents", 1000000],
    ["price_cents", -1],
    ["color", "rosso"],
    ["color", "Petrolio"],
    // Oltre ai check della tabella: un nome o un testo di fattura di soli spazi vale il vuoto.
    ["name", "   "],
    ["name", ""],
    ["name", "a".repeat(61)],
    ["invoice_description", "   "],
    ["invoice_description", ""],
    ["invoice_description", "a".repeat(201)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "services", service({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["name", "a".repeat(60)],
    ["name", "S"],
    ["invoice_description", "a".repeat(200)],
    ["invoice_description", "S"],
    ["price_cents", 0],
    ["price_cents", 999999],
    ["sort_order", 5],
    ...[15, 30, 45, 60, 75, 90, 105, 120].map((minutes): Case => ["duration_min", minutes]),
    ...["prima_visita", "seduta", "controllo", "altro"].map((kind): Case => ["kind", kind]),
    ...["petrolio", "salvia", "oceano", "ocra", "corallo", "ardesia"].map((color): Case => ["color", color]),
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "services", service({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  // L'indice unico guarda il nome senza maiuscole, solo fra le voci attive.
  it('due voci attive "Seduta" e "seduta" nello stesso studio: 23505', async () => {
    await expectPgError(
      inService(db, async (tx) => {
        await insertRow(tx, "services", service({ name: "Seduta" }));
        await insertRow(tx, "services", service({ name: "seduta" }));
      }),
      "23505",
    );
  });

  it("lo stesso nome in due studi diversi: accettato", async () => {
    const rows = await inService(db, async (tx) => {
      await insertRow(tx, "services", service({ practice_id: PRACTICE_A }));
      await insertRow(tx, "services", service({ practice_id: PRACTICE_B }));
      return tx.query<{ practice_id: string }>(
        "select practice_id::text as practice_id from public.services where name = 'Seduta' order by practice_id",
      );
    });
    expect(rows).toEqual([{ practice_id: PRACTICE_A }, { practice_id: PRACTICE_B }]);
  });

  it("archiviare libera il nome, riattivare lo riprende: 23505", async () => {
    await inService(db, async (tx) => {
      const firstId = idOf(await insertRow(tx, "services", service({ name: "Seduta" })));
      await tx.query("update public.services set archived_at = $1 where id = $2", [ARCHIVED_AT, firstId]);
      // L'archiviazione ha liberato il nome: una seconda "Seduta" attiva passa (se no, 23505 qui e il test fallisce).
      await insertRow(tx, "services", service({ name: "Seduta" }));
      const states = await tx.query<{ archived: boolean }>(
        "select archived_at is not null as archived from public.services where name = 'Seduta' order by archived",
      );
      expect(states).toEqual([{ archived: false }, { archived: true }]);
      // Riportare la prima ad attiva la rimetterebbe accanto alla seconda.
      await expectPgError(tx.query("update public.services set archived_at = null where id = $1", [firstId]), "23505");
    });
  });

  it("due voci archiviate con lo stesso nome convivono", async () => {
    const rows = await inService(db, async (tx) => {
      await insertRow(tx, "services", service({ name: "Seduta", archived_at: ARCHIVED_AT }));
      await insertRow(tx, "services", service({ name: "Seduta", archived_at: ARCHIVED_AT }));
      return tx.query<{ count: number }>("select count(*)::int as count from public.services where name = 'Seduta'");
    });
    expect(rows).toEqual([{ count: 2 }]);
  });
});
