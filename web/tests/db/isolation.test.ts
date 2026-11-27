import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, SqlParam, Tx } from "@/server/db/db";
import { PRACTICE_A, PRACTICE_B, TABLE_FIXTURES, type TableFixture, USER_A, USER_B } from "./fixtures";
import {
  asAnon,
  asServiceFor,
  asUserA,
  asUserB,
  expectPgError,
  ident,
  inRollback,
  openTestDb,
  publicTables,
} from "./helpers";

// Isolamento fra studi, ripetuto per ogni tabella di `public` presa dal catalogo:
// una tabella nuova entra da sola, con la sua TableFixture. Ogni scrittura sulle righe delle
// fixture gira in una transazione che torna indietro (`inRollback`), e lo stato dopo la
// scrittura si rilegge nella stessa transazione: nessun valore resta salvato, così ogni test
// parte dalle fixture e l'ordine non conta.
//
// Postgres applica la policy di select anche a una scrittura che legge colonne (where,
// returning): lì una policy di insert o di update sbagliata non si vede. Per questo insertFor
// non usa returning, e l'update e lo spostamento verso B girano anche senza where. La delete
// di una riga di B resta con where (senza, cancellerebbe le righe di A e urterebbe le chiavi
// restrict dei figli): una policy di delete troppo larga la ferma rls-catalog.test.ts.

// Il catalogo serve prima di raccogliere i test: lo si legge da un clone a parte.
const TABLES = await (async () => {
  const { pg } = await openTestDb();
  try {
    return await publicTables(pg);
  } finally {
    await pg.close();
  }
})();

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

type Who = "A" | "B";

function scopeValue(fixture: TableFixture, who: Who): string {
  if (fixture.scope === "user_id") return who === "A" ? USER_A : USER_B;
  return who === "A" ? PRACTICE_A : PRACTICE_B;
}

/**
 * Il messaggio con cui la policy di `table` rifiuta una riga di un altro studio ("new row
 * violates row-level security policy"), per i casi in cui la tabella non ha `answeredBy`.
 */
function rlsMessage(table: string): RegExp {
  return new RegExp(`row-level security policy for table "${table}"`);
}

function readRows(tx: Tx, table: string, column: string, value: string): Promise<{ r: string }[]> {
  return tx.query<{ r: string }>(
    `select to_jsonb(t)::text as r from public.${ident(table)} t where t.${ident(column)} = $1 order by 1`,
    [value],
  );
}

/** Le righe con `column = value` lette come servizio, in JSON e in ordine: per confrontare prima e dopo una scrittura. */
async function snapshot(table: string, column: string, value: string): Promise<string[]> {
  const rows = await asServiceFor(db, (tx) => readRows(tx, table, column, value));
  return rows.map((row) => row.r);
}

/**
 * Come `snapshot`, ma dentro la transazione di uA, dopo la scrittura e prima del rollback. La
 * sessione è di `postgres`, quindi `set_config('role', 'postgres', true)` torna superutente per
 * il resto della transazione e si vedono anche le righe di B: va chiamata per ultima.
 */
async function snapshotBeforeRollback(tx: Tx, table: string, column: string, value: string): Promise<string[]> {
  await tx.query("select set_config('role', 'postgres', true)");
  return (await readRows(tx, table, column, value)).map((row) => row.r);
}

describe.each(TABLES)("public.%s", (table) => {
  const fixture = TABLE_FIXTURES[table];
  if (!fixture) {
    it("ha una TableFixture", () => {
      expect.fail(`manca TABLE_FIXTURES.${table} in tests/db/fixtures.ts`);
    });
    return;
  }
  const { insertFor, updateColumn, parent, policies } = fixture;
  const t = `public.${ident(table)}`;
  const scope = ident(fixture.scope);

  let rowsOfA: string[];
  beforeAll(async () => {
    rowsOfA = await snapshot(table, fixture.scope, scopeValue(fixture, "A"));
  });

  it("uA legge solo le righe di A", async () => {
    const rows = await asUserA(db, (tx) => tx.query<{ s: string }>(`select ${scope}::text as s from ${t}`));
    expect(rows.map((row) => row.s)).toEqual(Array(fixture.expectedA).fill(scopeValue(fixture, "A")));
  });

  it("uB legge solo le righe di B", async () => {
    const rows = await asUserB(db, (tx) => tx.query<{ s: string }>(`select ${scope}::text as s from ${t}`));
    expect(rows.map((row) => row.s)).toEqual(Array(fixture.expectedB).fill(scopeValue(fixture, "B")));
  });

  it("anon legge: 42501", async () => {
    await expectPgError(
      asAnon(db, (tx) => tx.query(`select * from ${t}`)),
      "42501",
    );
  });

  if (insertFor) {
    it("uA inserisce con practice_id di B: 42501", async () => {
      await expectPgError(
        asUserA(db, (tx) => insertFor(tx, PRACTICE_B)),
        "42501",
        fixture.answeredBy?.insert ?? rlsMessage(table),
      );
    });

    if (policies.includes("I") && fixture.oneRowPerPractice) {
      // Tabella 1:1 (`practice_id` è la chiave): lo studio ha già la sua riga, una seconda non entra.
      it("uA inserisce una seconda riga di A: 23505", async () => {
        await expectPgError(
          inRollback(db, "A", (tx) => insertFor(tx, PRACTICE_A)),
          "23505",
        );
      });
    } else if (policies.includes("I")) {
      it("uA inserisce una sua riga e la vede", async () => {
        const visible = await inRollback(db, "A", async (tx) => {
          await insertFor(tx, PRACTICE_A);
          return tx.query<{ s: string }>(`select ${scope}::text as s from ${t}`);
        });
        expect(visible.map((row) => row.s)).toEqual(Array(fixture.expectedA + 1).fill(PRACTICE_A));
      });
    }
  }

  if (updateColumn) {
    const column = ident(updateColumn.column);
    const value: SqlParam = updateColumn.value;

    it("uA aggiorna una riga di B: 0 righe, la riga di B è identica", async () => {
      const before = await snapshot(table, fixture.scope, scopeValue(fixture, "B"));
      const { rows, after } = await inRollback(db, "A", async (tx) => {
        const rows = await tx.query(`update ${t} set ${column} = $1 where ${scope} = $2 returning *`, [
          value,
          scopeValue(fixture, "B"),
        ]);
        // Senza where decide solo la policy di update. Tocca anche le righe di A, ma il rollback
        // le riporta come nelle fixture.
        await tx.query(`update ${t} set ${column} = $1`, [value]);
        return { rows, after: await snapshotBeforeRollback(tx, table, fixture.scope, scopeValue(fixture, "B")) };
      });
      expect(rows).toEqual([]);
      expect(after).toEqual(before);
    });

    it("uA cancella una riga di B: 0 righe, la riga esiste ancora", async () => {
      const before = await snapshot(table, fixture.scope, scopeValue(fixture, "B"));
      const { rows, after } = await inRollback(db, "A", async (tx) => {
        const rows = await tx.query(`delete from ${t} where ${scope} = $1 returning *`, [scopeValue(fixture, "B")]);
        return { rows, after: await snapshotBeforeRollback(tx, table, fixture.scope, scopeValue(fixture, "B")) };
      });
      expect(rows).toEqual([]);
      expect(after).toEqual(before);
    });

    if (policies.includes("U")) {
      it("uA sposta le sue righe su B: 42501", async () => {
        await expectPgError(
          asUserA(db, (tx) => tx.query(`update ${t} set ${scope} = $1`, [scopeValue(fixture, "B")])),
          "42501",
          fixture.answeredBy?.move ?? rlsMessage(table),
        );
      });

      it("uA aggiorna una sua riga: returning dà il valore scritto", async () => {
        const rows = await inRollback(db, "A", (tx) =>
          tx.query<{ v: unknown }>(`update ${t} set ${column} = $1 where ${scope} = $2 returning ${column} as v`, [
            value,
            scopeValue(fixture, "A"),
          ]),
        );
        expect(rows).toEqual(Array(fixture.expectedA).fill({ v: value }));
      });
    } else {
      it("senza policy U: uA aggiorna una sua riga e tocca 0 righe", async () => {
        const before = await snapshot(table, fixture.scope, scopeValue(fixture, "A"));
        const { rows, after } = await inRollback(db, "A", async (tx) => {
          const rows = await tx.query(`update ${t} set ${column} = $1 where ${scope} = $2 returning *`, [
            value,
            scopeValue(fixture, "A"),
          ]);
          return { rows, after: await snapshotBeforeRollback(tx, table, fixture.scope, scopeValue(fixture, "A")) };
        });
        expect(rows).toEqual([]);
        expect(after).toEqual(before);
      });
    }

    if (!policies.includes("D")) {
      it("senza policy D: uA cancella una sua riga e tocca 0 righe", async () => {
        const before = await snapshot(table, fixture.scope, scopeValue(fixture, "A"));
        const { rows, after } = await inRollback(db, "A", async (tx) => {
          const rows = await tx.query(`delete from ${t} where ${scope} = $1 returning *`, [scopeValue(fixture, "A")]);
          return { rows, after: await snapshotBeforeRollback(tx, table, fixture.scope, scopeValue(fixture, "A")) };
        });
        expect(rows).toEqual([]);
        expect(after).toEqual(before);
      });
    }
  }

  if (parent) {
    it(`uA collega un figlio di A a un genitore di B (${parent.table}): 23503`, async () => {
      const [parentOfB] = await asServiceFor(db, (tx) =>
        tx.query<{ id: string }>(`select id::text as id from public.${ident(parent.table)} where practice_id = $1 limit 1`, [
          PRACTICE_B,
        ]),
      );
      if (!parentOfB) throw new Error(`nessuna riga di B in ${parent.table}: aggiungila in loadFixtures`);
      // Se c'è `insertWithParent` se ne inserisce una riga nuova, con o senza policy U: serve dove un
      // trigger o un privilegio di colonna risponderebbe prima della chiave esterna a un update.
      // Altrimenti, con la policy U, il figlio esistente si sposta sul genitore di B. Se la chiave
      // esterna è giusta, nessuno dei due arriva a scrivere.
      const { insertWithParent } = parent;
      let link: ((tx: Tx) => Promise<unknown>) | undefined;
      if (insertWithParent) {
        if (!policies.includes("I")) throw new Error(`${table}: insertWithParent vuole la policy I`);
        link = (tx) => insertWithParent(tx, PRACTICE_A, parentOfB.id);
      } else if (policies.includes("U")) {
        link = (tx) =>
          tx.query(`update ${t} set ${ident(parent.column)} = $1 where ${scope} = $2`, [
            parentOfB.id,
            scopeValue(fixture, "A"),
          ]);
      }
      if (!link) throw new Error(`${table}: parent vuole la policy U oppure insertWithParent con la policy I`);
      await expectPgError(asUserA(db, link), "23503");
    });
  }

  // Ultimo caso della tabella: nessuna scrittura dei casi sopra è rimasta salvata.
  it("dopo tutti i casi le righe di A sono ancora quelle delle fixture", async () => {
    expect(await snapshot(table, fixture.scope, scopeValue(fixture, "A"))).toEqual(rowsOfA);
  });
});

describe("public.practices, casi propri", () => {
  it("uA rinomina lo studio A: returning dà il nome nuovo e updated_at avanza", async () => {
    const [before] = await asServiceFor(db, (tx) =>
      tx.query<{ updated_at: Date }>("select updated_at from public.practices where id = $1", [PRACTICE_A]),
    );
    const rows = await inRollback(db, "A", (tx) =>
      tx.query<{ name: string; updated_at: Date }>(
        "update public.practices set name = $1 where id = $2 returning name, updated_at",
        ["Studio A rinnovato", PRACTICE_A],
      ),
    );
    expect(rows.map((row) => row.name)).toEqual(["Studio A rinnovato"]);
    expect(rows[0]?.updated_at.getTime()).toBeGreaterThan(before?.updated_at.getTime() ?? Infinity);
  });

  it("uA non crea studi: 42501", async () => {
    await expectPgError(
      asUserA(db, (tx) => tx.query("insert into public.practices (name) values ('Studio nuovo')")),
      "42501",
    );
  });
});

describe("public.memberships, casi propri", () => {
  it("uA vede solo la sua riga", async () => {
    const rows = await asUserA(db, (tx) => tx.query("select practice_id, user_id, role from public.memberships"));
    expect(rows).toEqual([{ practice_id: PRACTICE_A, user_id: USER_A, role: "owner" }]);
  });

  it("uA non si aggiunge allo studio B: 42501", async () => {
    await expectPgError(
      asUserA(db, (tx) =>
        tx.query("insert into public.memberships (practice_id, user_id) values ($1, $2)", [PRACTICE_B, USER_A]),
      ),
      "42501",
    );
  });

  it("uA non modifica né cancella la sua riga: 0 righe", async () => {
    const before = await snapshot("memberships", "user_id", USER_A);
    // In una transazione che torna indietro: se una policy sbagliata lasciasse passare la scrittura,
    // la riga di uA non resterebbe cambiata per i test dopo questo.
    const { updated, deleted, after } = await inRollback(db, "A", async (tx) => {
      const updated = await tx.query("update public.memberships set role = 'owner' where user_id = $1 returning *", [
        USER_A,
      ]);
      const deleted = await tx.query("delete from public.memberships where user_id = $1 returning *", [USER_A]);
      return { updated, deleted, after: await snapshotBeforeRollback(tx, "memberships", "user_id", USER_A) };
    });
    expect([updated, deleted]).toEqual([[], []]);
    expect(after).toEqual(before);
  });
});
