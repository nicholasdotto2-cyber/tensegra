import { resolve } from "node:path";
import { inspect } from "node:util";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor, createDb, type Db, InvalidActorError, NestedTransactionError, type Tx } from "@/server/db/db";
import { logDbError, pgCode } from "@/server/db/errors";
import { runMigrations } from "@/server/db/migrate";
import { createPglite } from "@/server/db/pglite";
import { asService, switchToUser } from "@/server/db/service";

const A: Actor = { userId: "a0000000-0000-4000-8000-00000000000a" };
const B: Actor = { userId: "b0000000-0000-4000-8000-00000000000b" };

let pg: PGlite;
let db: Db;

// Basta lo shim: i test leggono solo ruolo e auth.uid(), nessuna tabella di dominio.
beforeEach(async () => {
  pg = await createPglite();
  await runMigrations(pg, resolve("supabase"));
  db = createDb(pg);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await pg.close();
});

const currentUserAsService = () =>
  asService(db, async (tx) => (await tx.query<{ r: string }>("select current_user as r"))[0]?.r);

describe("Db.asUser", () => {
  it("dentro asUser: authenticated e auth.uid()", async () => {
    const rows = await db.asUser(A, (tx) =>
      tx.query<{ r: string; u: string }>("select current_user as r, auth.uid()::text as u"),
    );
    expect(rows).toEqual([{ r: "authenticated", u: "a0000000-0000-4000-8000-00000000000a" }]);
  });

  it("dopo asUser il ruolo torna postgres", async () => {
    await db.asUser(A, (tx) => tx.query("select 1"));
    expect(await currentUserAsService()).toBe("postgres");

    const boom = new Error("boom");
    await expect(
      db.asUser(A, async (tx) => {
        await tx.query("select 1");
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await currentUserAsService()).toBe("postgres");
  });

  // PGlite non è rientrante: senza il controllo, l'asUser interno aspetterebbe per sempre.
  it("asUser annidato lancia NestedTransactionError entro 1 s", { timeout: 1000 }, async () => {
    await expect(db.asUser(A, () => db.asUser(A, async () => 1))).rejects.toBeInstanceOf(NestedTransactionError);
    await expect(db.asUser(A, async () => 2)).resolves.toBe(2);
  });

  it("asService dentro asUser lancia NestedTransactionError", { timeout: 1000 }, async () => {
    await expect(db.asUser(A, () => asService(db, async () => 1))).rejects.toBeInstanceOf(NestedTransactionError);
  });

  it("asUser dentro asService lancia NestedTransactionError", { timeout: 1000 }, async () => {
    await expect(asService(db, () => db.asUser(A, async () => 1))).rejects.toBeInstanceOf(NestedTransactionError);
  });

  it("attore non valido", async () => {
    const transaction = vi.spyOn(pg, "transaction");
    await expect(db.asUser({ userId: "non-uuid" }, async () => 1)).rejects.toBeInstanceOf(InvalidActorError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("due asUser concorrenti vedono ciascuno il proprio utente", async () => {
    const uid = (actor: Actor) =>
      db.asUser(actor, async (tx) => (await tx.query<{ u: string }>("select auth.uid()::text as u"))[0]?.u);
    await expect(Promise.all([uid(A), uid(B)])).resolves.toEqual([A.userId, B.userId]);
  });
});

// `next build` compila db.ts una volta per bundle (la pagina /oggi e la route /api/health): il
// Db lo apre chi arriva prima, e le funzioni dell'altra copia devono lavorarci lo stesso.
describe("due copie di db.ts, come nei bundle di next build", () => {
  type DbModule = typeof import("@/server/db/db");
  type ServiceModule = typeof import("@/server/db/service");
  let one: DbModule;
  let two: DbModule;
  let serviceTwo: ServiceModule;

  beforeAll(async () => {
    vi.resetModules();
    one = await import("@/server/db/db");
    vi.resetModules();
    two = await import("@/server/db/db");
    serviceTwo = await import("@/server/db/service");
  });

  it("le copie sono davvero due (il test misura qualcosa)", () => {
    expect(two.pgOf).not.toBe(one.pgOf);
    expect(two.NestedTransactionError).not.toBe(one.NestedTransactionError);
  });

  it("pgOf e asService di una copia lavorano sul Db creato dall'altra", async () => {
    const dbOne = one.createDb(pg);
    expect(two.pgOf(dbOne)).toBe(pg);
    const role = await serviceTwo.asService(dbOne, async (tx) => (await tx.query<{ r: string }>("select current_user as r"))[0]?.r);
    expect(role).toBe("postgres");
  });

  it("annidamento fra copie: NestedTransactionError entro 1 s", { timeout: 1000 }, async () => {
    const dbOne = one.createDb(pg);
    const dbTwo = two.createDb(pg);
    const nested = { name: "NestedTransactionError" };
    await expect(dbOne.asUser(A, () => dbTwo.asUser(A, async () => 1))).rejects.toMatchObject(nested);
    await expect(dbOne.asUser(A, () => serviceTwo.asService(dbOne, async () => 1))).rejects.toMatchObject(nested);
    await expect(serviceTwo.asService(dbOne, () => dbOne.asUser(A, async () => 1))).rejects.toMatchObject(nested);
    // Il mutex di PGlite non è rimasto preso.
    await expect(dbTwo.asUser(A, async () => 2)).resolves.toBe(2);
  });
});

describe("asService", () => {
  it("resta postgres e ha exec", async () => {
    const result = await asService(db, async (tx) => {
      await tx.exec("create temporary table t_service (n int); insert into t_service values (1), (2);");
      return tx.query<{ r: string; n: number }>("select current_user as r, count(*)::int as n from t_service");
    });
    expect(result).toEqual([{ r: "postgres", n: 2 }]);
  });
});

// Il seed e "Ricrea": una sola transazione che scrive come servizio utente,
// studio e membership, e poi ogni dato di dominio come l'utente demo, con RLS e trigger.
describe("switchToUser", () => {
  const USER = "c0000000-0000-4000-8000-00000000000c";
  const PRACTICE = "c0000000-0000-4000-8000-000000000001";
  const OTHER_PRACTICE = "d0000000-0000-4000-8000-000000000001";
  const FILE = "c0000000-0000-4000-8000-0000000000f1";
  const SHA256 = "0123456789abcdef".repeat(4);

  const insertFile = (tx: Tx, id: string, practiceId: string) =>
    tx.query(
      `insert into public.files (id, practice_id, kind, storage_key, mime_type, size_bytes, sha256)
       values ($1, $2, 'posture_photo', $3, 'image/jpeg', 1024, $4)`,
      [id, practiceId, `${practiceId}/posture_photo/${id}.jpg`, SHA256],
    );

  const insertOwnerAsService = async (tx: Tx) => {
    await tx.query("insert into auth.users (id, email) values ($1, 'c@example.test')", [USER]);
    await tx.query("insert into public.practices (id, name) values ($1, 'Studio C'), ($2, 'Studio D')", [
      PRACTICE,
      OTHER_PRACTICE,
    ]);
    await tx.query("insert into public.memberships (practice_id, user_id) values ($1, $2)", [PRACTICE, USER]);
  };

  it("dentro asService: prima servizio, poi l'utente con RLS, trigger e app.next_number", async () => {
    const seen = await asService(db, async (tx) => {
      await insertOwnerAsService(tx);
      const [before] = await tx.query<{ r: string }>("select current_user as r");
      await switchToUser(tx, { userId: USER });
      const [after] = await tx.query<{ r: string; u: string }>("select current_user as r, auth.uid()::text as u");
      const [numbered] = await tx.query<{ n: number }>("select app.next_number($1, 'TD01', 2026) as n", [PRACTICE]);
      await insertFile(tx, FILE, PRACTICE);
      // Un errore abortisce la transazione: il caso rifiutato sta dentro un savepoint.
      await tx.query("savepoint other_practice");
      const denied = await insertFile(tx, "d0000000-0000-4000-8000-0000000000f1", OTHER_PRACTICE).then(
        () => "inserita",
        (error: unknown) => pgCode(error),
      );
      await tx.query("rollback to savepoint other_practice");
      return { before: before?.r, after, n: numbered?.n, denied };
    });
    expect(seen).toEqual({ before: "postgres", after: { r: "authenticated", u: USER }, n: 1, denied: "42501" });

    // Dopo il commit: le scritture ci sono, created_by è l'utente, e la connessione è di nuovo postgres.
    expect(await currentUserAsService()).toBe("postgres");
    const saved = await asService(db, async (tx) => ({
      file: await tx.query("select created_by::text as created_by from public.files where id = $1", [FILE]),
      counter: await tx.query("select last_number from public.number_series where practice_id = $1", [PRACTICE]),
    }));
    expect(saved).toEqual({ file: [{ created_by: USER }], counter: [{ last_number: 1 }] });
  });

  it("attore non valido: InvalidActorError e la transazione non lascia niente", async () => {
    await expect(
      asService(db, async (tx) => {
        await insertOwnerAsService(tx);
        await switchToUser(tx, { userId: "non-uuid" });
      }),
    ).rejects.toBeInstanceOf(InvalidActorError);
    const users = await asService(db, (tx) => tx.query("select 1 from auth.users where id = $1", [USER]));
    expect(users).toEqual([]);
  });
});

// Dopo un errore Postgres abortisce la transazione: se fn lo prende e risolve, il COMMIT di
// PGlite diventa un ROLLBACK senza errore e ogni scrittura di fn sparisce dietro un successo.
describe("errore di query preso dentro fn", () => {
  beforeEach(async () => {
    await asService(db, (tx) =>
      tx.exec("create table public.t_abort (n int primary key); grant select, insert on public.t_abort to authenticated;"),
    );
  });

  const savedRows = async () =>
    (await asService(db, (tx) => tx.query<{ n: number }>("select count(*)::int as n from public.t_abort")))[0]?.n;

  const insertThenCatchDuplicate = async (tx: Tx) => {
    await tx.query("insert into public.t_abort values (1)");
    const caught = await tx.query("insert into public.t_abort values (1)").then(
      () => undefined,
      (e: unknown) => pgCode(e),
    );
    expect(caught).toBe("23505");
    return "ok";
  };

  it("asUser rifiuta e non salva niente", async () => {
    await expect(db.asUser(A, insertThenCatchDuplicate)).rejects.toMatchObject({ code: "25P02" });
    expect(await savedRows()).toBe(0);
  });

  it("asService rifiuta e non salva niente", async () => {
    await expect(asService(db, insertThenCatchDuplicate)).rejects.toMatchObject({ code: "25P02" });
    expect(await savedRows()).toBe(0);
  });

  it("con un savepoint la transazione si riprende e salva", async () => {
    const result = db.asUser(A, async (tx) => {
      await tx.query("insert into public.t_abort values (1)");
      await tx.query("savepoint s");
      await tx.query("insert into public.t_abort values (1)").catch(() => tx.query("rollback to savepoint s"));
      return "ok";
    });
    await expect(result).resolves.toBe("ok");
    expect(await savedRows()).toBe(1);
  });
});

// Un errore che esce da asUser o asService può arrivare a Next, che lo stampa intero con
// util.inspect: niente parametri della query, niente dati dei pazienti.
describe("errori che escono dal livello db", () => {
  const SECRET = "RSSMRA85B30H501X";

  async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
    return p.then(
      (value: unknown) => expect.fail(`attesa una rifiutata, invece: ${JSON.stringify(value)}`),
      (error: unknown) => error,
    );
  }

  function expectScrubbed(error: unknown, code: string): void {
    expect(pgCode(error)).toBe(code);
    expect(error).not.toHaveProperty("params");
    expect(error).not.toHaveProperty("detail");
    expect(inspect(error, { depth: 5 })).not.toContain(SECRET);
  }

  it("asUser, 22P02: il valore era nel messaggio e nei parametri", async () => {
    expectScrubbed(await rejectionOf(db.asUser(A, (tx) => tx.query("select $1::uuid", [SECRET]))), "22P02");
  });

  it("asService, 23505: il valore era nel detail", async () => {
    const insert = (tx: Tx) =>
      tx.query("insert into auth.users (id, email) values (gen_random_uuid(), $1)", [`${SECRET}@example.test`]);
    const error = await rejectionOf(
      asService(db, async (tx) => {
        await insert(tx);
        await insert(tx);
      }),
    );
    expectScrubbed(error, "23505");
  });

  it("asService, 23514: la riga intera era nel detail", async () => {
    const error = await rejectionOf(
      asService(db, (tx) => tx.query("insert into public.practices (name) values ($1)", [SECRET.repeat(6)])),
    );
    expectScrubbed(error, "23514");
  });

  it("un errore preso dentro fn è già ripulito", async () => {
    let caught: unknown;
    const outcome = db.asUser(A, async (tx) => {
      caught = await tx.query("select $1::uuid", [SECRET]).catch((error: unknown) => error);
    });
    await expect(outcome).rejects.toMatchObject({ code: "25P02" });
    expectScrubbed(caught, "22P02");
  });
});

describe("logDbError con gli errori veri di PGlite", () => {
  // Gli errori della classe 22 portano il valore del parametro nel messaggio di Postgres.
  it("il log non contiene i parametri della query", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases = [
      { sql: "select $1::uuid", secret: "RSSMRA85B30H501X", line: '[db] q: 22P02 invalid input syntax for type uuid: "…"' },
      { sql: "select $1::date", secret: "1985-02-30", line: '[db] q: 22008 date/time field value out of range: "…"' },
      { sql: "select $1::uuid", secret: 'Rossi "Mario"', line: '[db] q: 22P02 invalid input syntax for type uuid: "…"' },
    ];
    for (const { sql, secret, line } of cases) {
      const err = await db.asUser(A, (tx) => tx.query(sql, [secret])).then(
        () => undefined,
        (e: unknown) => e,
      );
      error.mockClear();
      logDbError(err, "q");
      expect(error.mock.calls).toEqual([[line]]);
    }
  });
});
