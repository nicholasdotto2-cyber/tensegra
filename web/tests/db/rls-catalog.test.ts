import type { PGlite, Transaction } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/db";
import {
  APPOINTMENT_A,
  CYCLE_A,
  FILE_A,
  PATIENT_A1,
  PRACTICE_B,
  PSFS_ITEM_A,
  TABLE_FIXTURES,
  type TableFixture,
  VISIT_A,
} from "./fixtures";
import { asUserA, expectPgError, openTestDb, publicTables } from "./helpers";

// Le regole di policy e di grant lette dal catalogo di Postgres: valgono per
// ogni tabella di `public`, anche per quelle che le migrazioni dopo aggiungono.

const OWN_SCOPE_TABLES = new Set(["practices", "memberships"]);

/**
 * La condizione di policy attesa nella forma in cui Postgres la ristampa in `pg_policies`:
 * la colonna della fixture fra gli studi dell'utente, o l'utente stesso per le tabelle legate a
 * `user_id`. Si confronta con la condizione intera, dall'inizio alla fine: cercarla dentro il testo
 * lascerebbe passare `(<condizione>) OR true`, che apre la tabella a ogni studio.
 */
function policyGuard(scope: TableFixture["scope"]): string {
  return scope === "user_id"
    ? "(user_id = ( SELECT auth.uid() AS uid))"
    : `(${scope} IN ( SELECT app.my_practice_ids() AS my_practice_ids))`;
}

/**
 * Le due policy con una condizione in più: delete di un appuntamento solo
 * prenotato o confermato, di una fattura solo in bozza. Il testo intero ristampato.
 */
const EXTENDED_POLICIES: Readonly<Record<string, string>> = {
  appointments_delete:
    "((practice_id IN ( SELECT app.my_practice_ids() AS my_practice_ids)) AND (status = ANY (ARRAY['prenotato'::text, 'confermato'::text])))",
  invoices_delete: "((practice_id IN ( SELECT app.my_practice_ids() AS my_practice_ids)) AND (status = 'bozza'::text))",
};

/** Le clausole di una policy per comando: using per leggere e cancellare, with check per inserire, tutte e due per aggiornare. */
const CLAUSES: Readonly<Record<string, { using: boolean; withCheck: boolean }>> = {
  SELECT: { using: true, withCheck: false },
  INSERT: { using: false, withCheck: true },
  UPDATE: { using: true, withCheck: true },
  DELETE: { using: true, withCheck: false },
};

/** La lettera di `TableFixture.policies` per il `cmd` di `pg_policies`; `ALL` resta com'è e non corrisponde a nessuna. */
const LETTERS: Readonly<Record<string, string>> = { SELECT: "S", INSERT: "I", UPDATE: "U", DELETE: "D" };

const LETTER_ORDER = ["S", "I", "U", "D"];

/** Le lettere senza doppioni, in ordine S, I, U, D e poi le altre, separate da uno spazio: "S I U D". */
function letterSet(letters: Iterable<string>): string {
  const set = new Set(letters);
  const known = LETTER_ORDER.filter((letter) => set.has(letter));
  const other = [...set].filter((letter) => !LETTER_ORDER.includes(letter)).sort();
  return [...known, ...other].join(" ");
}

interface PolicyRow {
  tablename: string;
  policyname: string;
  cmd: string;
  roles: string[];
  qual: string | null;
  with_check: string | null;
}

async function policyRows(): Promise<PolicyRow[]> {
  const { rows } = await pg.query<PolicyRow>(
    `select tablename, policyname, cmd, roles::text[] as roles, qual, with_check from pg_policies
      where schemaname = 'public' order by tablename, policyname`,
  );
  return rows;
}

let db: Db;
let pg: PGlite;
let tables: string[];

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  tables = await publicTables(pg);
});

afterAll(async () => {
  await pg?.close();
});

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const [row] = (await pg.query<T>(sql, params)).rows;
  if (!row) throw new Error(`nessuna riga da: ${sql}`);
  return row;
}

type Queryable = Pick<Transaction, "query">;

/** I privilegi di `anon` sulle tabelle date, anche su una sola colonna: non deve averne nessuno. */
async function anonPrivileges(q: Queryable, names: readonly string[]): Promise<string[]> {
  const granted: string[] = [];
  for (const table of names) {
    for (const privilege of ["select", "insert", "update", "delete"]) {
      const { rows } = await q.query<{ ok: boolean }>(
        "select has_table_privilege('anon', ('public.' || quote_ident($1))::regclass, $2) as ok",
        [table, privilege],
      );
      if (rows[0]?.ok) granted.push(`${table}: ${privilege}`);
    }
    // has_table_privilege non vede i grant di colonna (`grant select (name) on ... to anon`).
    for (const privilege of ["select", "insert", "update"]) {
      const { rows } = await q.query<{ ok: boolean }>(
        "select has_any_column_privilege('anon', ('public.' || quote_ident($1))::regclass, $2) as ok",
        [table, privilege],
      );
      if (rows[0]?.ok && !granted.includes(`${table}: ${privilege}`)) granted.push(`${table}: ${privilege} su una colonna`);
    }
  }
  return granted;
}

/** I quattro privilegi di ogni tabella per `authenticated` e `service_role`. */
const FOUR = "select, insert, update, delete";

/**
 * Le tabelle con privilegi ridotti per `authenticated`: `number_series` si legge soltanto,
 * perché il numero passa da `app.next_number`; di `message_log` si aggiornano solo l'esito, la sua data
 * e `updated_at`. Il servizio ha i quattro privilegi anche qui.
 */
const REDUCED_GRANTS: Readonly<Record<string, readonly string[]>> = {
  number_series: ["authenticated: select", `service_role: ${FOUR}`],
  message_log: [
    "authenticated: select, insert, delete",
    "authenticated: update (outcome, outcome_at, updated_at)",
    `service_role: ${FOUR}`,
  ],
};

const PRIVILEGE_ORDER = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN", "EXECUTE"];

function privilegeRank(privilege: string): number {
  const rank = PRIVILEGE_ORDER.indexOf(privilege);
  return rank === -1 ? PRIVILEGE_ORDER.length : rank;
}

/**
 * I grant di ogni tabella di `public` e di ogni funzione di `app` ai ruoli che non ne sono il
 * proprietario, letti dalle ACL del catalogo: `ruolo: privilegi` (`PUBLIC` per il grant a tutti) e, per
 * un grant su alcune colonne, `ruolo: privilegio (colonne)`, in ordine. Una ACL null vale i privilegi di
 * default: nessuno su una tabella, l'esecuzione a `PUBLIC` su una funzione, che solo `revoke all ...
 * from public` toglie. Ogni oggetto ha la sua voce, anche senza grant, così un grant dimenticato si vede.
 */
async function grantsOf(q: Queryable): Promise<Record<string, string[]>> {
  const { rows } = await q.query<{ object: string; grantee: string | null; privilege: string | null; columns: string | null }>(
    `with objects as (
       select 'public.' || c.relname as object, c.oid, 'r' as kind, c.relowner as owner,
              coalesce(c.relacl, acldefault('r', c.relowner)) as acl
         from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       union all
       select p.oid::regprocedure::text, p.oid, 'f', p.proowner, coalesce(p.proacl, acldefault('f', p.proowner))
         from pg_proc p
        where p.pronamespace = 'app'::regnamespace
     ),
     entries as (
       select o.object, a.grantee, a.privilege_type, null::text as columns
         from objects o cross join lateral aclexplode(o.acl) a
        where a.grantee <> o.owner
       union all
       select o.object, a.grantee, a.privilege_type, string_agg(att.attname::text, ', ' order by att.attnum)
         from objects o
         join pg_attribute att on att.attrelid = o.oid and att.attnum > 0 and not att.attisdropped
         cross join lateral aclexplode(att.attacl) a
        where o.kind = 'r' and a.grantee <> o.owner
        group by o.object, a.grantee, a.privilege_type
     )
     select o.object, case e.grantee when 0 then 'PUBLIC' else pg_get_userbyid(e.grantee)::text end as grantee,
            e.privilege_type as privilege, e.columns
       from objects o left join entries e on e.object = o.object
      order by 1`,
  );
  const grants: Record<string, string[]> = {};
  const tableLevel = new Map<string, { object: string; grantee: string; privileges: string[] }>();
  for (const row of rows) {
    const list = (grants[row.object] ??= []);
    if (row.grantee === null || row.privilege === null) continue;
    if (row.columns !== null) {
      list.push(`${row.grantee}: ${row.privilege.toLowerCase()} (${row.columns})`);
      continue;
    }
    const key = `${row.object} ${row.grantee}`;
    const entry = tableLevel.get(key) ?? { object: row.object, grantee: row.grantee, privileges: [] };
    entry.privileges.push(row.privilege);
    tableLevel.set(key, entry);
  }
  for (const { object, grantee, privileges } of tableLevel.values()) {
    const ordered = privileges.sort((a, b) => privilegeRank(a) - privilegeRank(b)).map((p) => p.toLowerCase());
    grants[object]?.push(`${grantee}: ${ordered.join(", ")}`);
  }
  for (const list of Object.values(grants)) list.sort();
  return grants;
}

/**
 * I grant attesi per gli oggetti dati: i quattro privilegi ad `authenticated` e a `service_role`
 * su ogni tabella, salvo `REDUCED_GRANTS`, e l'esecuzione a tutti e due su ogni funzione di `app`.
 * Niente ad `anon` né a `PUBLIC`.
 */
function expectedGrants(objects: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(
    objects.map((object) => {
      if (!object.startsWith("public.")) return [object, ["authenticated: execute", "service_role: execute"]];
      const reduced = REDUCED_GRANTS[object.slice("public.".length)];
      return [object, [...(reduced ?? [`authenticated: ${FOUR}`, `service_role: ${FOUR}`])].sort()];
    }),
  );
}

/**
 * Le chiavi esterne fra due tabelle di `public` che hanno entrambe `practice_id` e che non sono
 * composte `(practice_id, ...)` verso `(practice_id, ...)`: con una chiave su
 * `x_id` sola, una riga di A potrebbe puntare a un genitore di B. Restano fuori, perché la
 * colonna `practice_id` non c'è dall'altra parte, le chiavi verso `practices(id)` e `auth.users(id)`.
 */
async function nonCompositeForeignKeys(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ name: string; child: string; parent: string; childCols: string[]; parentCols: string[] }>(
    `select c.conname as name, src.relname as child, dst.relname as parent,
            array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum, ord)
                    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum order by k.ord) as "childCols",
            array(select a.attname::text from unnest(c.confkey) with ordinality k(attnum, ord)
                    join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum order by k.ord) as "parentCols"
       from pg_constraint c
       join pg_class src on src.oid = c.conrelid
       join pg_namespace sn on sn.oid = src.relnamespace
       join pg_class dst on dst.oid = c.confrelid
       join pg_namespace dn on dn.oid = dst.relnamespace
      where c.contype = 'f' and sn.nspname = 'public' and dn.nspname = 'public'
        and exists (select 1 from pg_attribute a
                     where a.attrelid = c.conrelid and a.attname = 'practice_id' and not a.attisdropped)
        and exists (select 1 from pg_attribute a
                     where a.attrelid = c.confrelid and a.attname = 'practice_id' and not a.attisdropped)
      order by 2, 1`,
  );
  return rows
    .filter((fk) => fk.childCols.length < 2 || fk.childCols[0] !== "practice_id" || fk.parentCols[0] !== "practice_id")
    .map((fk) => `${fk.child}.${fk.name}: (${fk.childCols.join(", ")}) -> ${fk.parent} (${fk.parentCols.join(", ")})`);
}

/**
 * Le colonne `created_by` senza un trigger `before insert for each row` su `app.set_created_by()` e
 * le colonne `updated_at` senza uno `before update for each row` su `app.set_updated_at()`, come
 * `tabella: colonna`. Senza il trigger il valore passato dal client resterebbe: un
 * `created_by` falsificato, un `updated_at` mai aggiornato. `tgtype & 95` tiene i bit riga (1),
 * before (2), insert (4), delete (8), update (16) e instead of (64): 7 = before insert row, 19 =
 * before update row, e un trigger che scatta anche su altri comandi non conta.
 */
async function auditTriggerGaps(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ gap: string }>(
    `select c.relname || ': ' || a.attname as gap
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attname in ('created_by', 'updated_at')
        and not exists (
          select 1 from pg_trigger t
           where t.tgrelid = c.oid and not t.tgisinternal and t.tgenabled <> 'D'
             and t.tgfoid = (case a.attname when 'created_by' then 'app.set_created_by'::regproc
                                            else 'app.set_updated_at'::regproc end)
             and (t.tgtype & 95) = (case a.attname when 'created_by' then 7 else 19 end)
        )
      order by c.relname, a.attname`,
  );
  return rows.map((row) => row.gap);
}

describe("catalogo di public", () => {
  it("ogni tabella ha la sua TableFixture, e ogni fixture una tabella", () => {
    expect(tables.length).toBeGreaterThan(0);
    expect(Object.keys(TABLE_FIXTURES).sort()).toEqual(tables);
  });

  // Il modello completo ha 40 tabelle in public: 4 del core più 36.
  it("il modello completo ha 40 tabelle in public", () => {
    expect(tables).toHaveLength(40);
  });

  it("ogni tabella ha la RLS attiva", async () => {
    const { rows } = await pg.query<{ name: string; rls: boolean }>(
      `select c.relname as name, c.relrowsecurity as rls
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p')`,
    );
    expect(rows.filter((row) => !row.rls).map((row) => row.name)).toEqual([]);
  });

  it("ogni tabella di dominio ha practice_id uuid not null e un indice che inizia con practice_id", async () => {
    const missing: string[] = [];
    for (const table of tables.filter((t) => !OWN_SCOPE_TABLES.has(t))) {
      const column = await one<{ ok: boolean }>(
        `select exists (
           select 1 from pg_attribute a
            where a.attrelid = ('public.' || quote_ident($1))::regclass
              and a.attname = 'practice_id' and a.atttypid = 'uuid'::regtype
              and a.attnotnull and not a.attisdropped
         ) as ok`,
        [table],
      );
      if (!column.ok) missing.push(`${table}: practice_id uuid not null`);
      const index = await one<{ ok: boolean }>(
        `select exists (
           select 1 from pg_index i
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
            where i.indrelid = ('public.' || quote_ident($1))::regclass and a.attname = 'practice_id'
         ) as ok`,
        [table],
      );
      if (!index.ok) missing.push(`${table}: indice che inizia con practice_id`);
    }
    expect(missing).toEqual([]);
  });

  it("ogni tabella ha una policy di select to authenticated", async () => {
    const { rows } = await pg.query<{ name: string }>(
      `select tablename as name from pg_policies
        where schemaname = 'public' and cmd = 'SELECT' and 'authenticated' = any (roles)`,
    );
    const withSelect = new Set(rows.map((row) => row.name));
    expect(tables.filter((t) => !withSelect.has(t))).toEqual([]);
  });

  // Una delete o un update con where o returning passa anche dalla policy di select, che nasconde
  // una policy di delete o di update troppo larga (isolation.test.ts): per questo le condizioni si
  // controllano qui, dal loro testo intero, senza cancellare niente.
  it("ogni policy ha per condizione esattamente il legame con gli studi dell'utente, in using e in with check", async () => {
    const rows = await policyRows();
    expect(rows.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const row of rows) {
      const guard = policyGuard(TABLE_FIXTURES[row.tablename]?.scope ?? "practice_id");
      const clauses = CLAUSES[row.cmd];
      const using = clauses?.using ? (EXTENDED_POLICIES[row.policyname] ?? guard) : null;
      const withCheck = clauses?.withCheck ? guard : null;
      if (row.qual !== using) wrong.push(`${row.tablename}.${row.policyname} using: ${row.qual}`);
      if (row.with_check !== withCheck) wrong.push(`${row.tablename}.${row.policyname} with check: ${row.with_check}`);
    }
    expect(wrong).toEqual([]);
    // Ogni voce di EXTENDED_POLICIES è una policy che c'è: un nome cambiato non la lascia senza controllo.
    expect(rows.map((row) => row.policyname).filter((name) => name in EXTENDED_POLICIES)).toEqual(
      Object.keys(EXTENDED_POLICIES).sort(),
    );
  });

  // Una policy D mancante non dà errori: la delete tocca 0 righe, come quella di una riga di un altro
  // studio. Solo il confronto con le lettere della fixture la vede.
  it("le policy di ogni tabella sono le lettere della sua TableFixture", async () => {
    const rows = await policyRows();
    const actual: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const table of tables) {
      actual[table] = letterSet(rows.filter((row) => row.tablename === table).map((row) => LETTERS[row.cmd] ?? row.cmd));
      expected[table] = letterSet(TABLE_FIXTURES[table]?.policies ?? []);
    }
    expect(actual).toEqual(expected);
  });

  it("ogni policy è solo to authenticated", async () => {
    const rows = await policyRows();
    const wrong = rows
      .filter((row) => row.roles.length !== 1 || row.roles[0] !== "authenticated")
      .map((row) => `${row.tablename}.${row.policyname}: ${row.roles.join(", ")}`);
    expect(wrong).toEqual([]);
  });

  it("ogni chiave esterna fra tabelle con practice_id è composta e inizia con practice_id", async () => {
    expect(await nonCompositeForeignKeys(pg)).toEqual([]);
  });

  it("il controllo delle chiavi esterne trova una chiave su x_id sola (tabelle di prova, poi rollback)", async () => {
    let found: string[] = [];
    await pg.transaction(async (tx) => {
      await tx.exec(`
        create table public.t_fk_wrong (practice_id uuid not null, file_id uuid references public.files (id));
        create table public.t_fk_right (
          practice_id uuid not null,
          file_id uuid,
          foreign key (practice_id, file_id) references public.files (practice_id, id)
        );
      `);
      found = await nonCompositeForeignKeys(tx);
      await tx.rollback();
    });
    expect(found).toEqual(["t_fk_wrong.t_fk_wrong_file_id_fkey: (file_id) -> files (id)"]);
    expect(await publicTables(pg)).toEqual(tables);
  });

  it("ogni created_by e ogni updated_at hanno il loro trigger", async () => {
    expect(await auditTriggerGaps(pg)).toEqual([]);
  });

  it("il controllo dei trigger trova una tabella senza (tabella di prova, poi rollback)", async () => {
    let found: string[] = [];
    await pg.transaction(async (tx) => {
      await tx.exec(
        "create table public.t_no_trigger (practice_id uuid not null, created_by uuid, updated_at timestamptz);",
      );
      found = await auditTriggerGaps(tx);
      await tx.rollback();
    });
    expect(found).toEqual(["t_no_trigger: created_by", "t_no_trigger: updated_at"]);
    expect(await publicTables(pg)).toEqual(tables);
  });

  it("anon non ha nessun privilegio sulle tabelle", async () => {
    expect(await anonPrivileges(pg, tables)).toEqual([]);
  });

  it("il controllo di anon vede anche un grant su una sola colonna (poi rollback)", async () => {
    let found: string[] = [];
    await pg.transaction(async (tx) => {
      await tx.exec("grant select (name) on public.practices to anon;");
      found = await anonPrivileges(tx, ["practices"]);
      await tx.rollback();
    });
    expect(found).toEqual(["practices: select su una colonna"]);
    expect(await anonPrivileges(pg, ["practices"])).toEqual([]);
  });

  // In locale il servizio (`asService`: `asServiceFor` dei test e il seed) gira come postgres, non come
  // service_role: un grant mancante a service_role non fa fallire nessun altro test, e su Supabase darebbe 42501.
  it("ogni tabella e ogni funzione di app hanno i grant attesi, nessuno ad anon o a PUBLIC", async () => {
    const grants = await grantsOf(pg);
    expect(Object.keys(grants).filter((object) => object.startsWith("public.")).sort()).toEqual(
      tables.map((t) => `public.${t}`).sort(),
    );
    expect(Object.keys(grants).some((object) => object.startsWith("app."))).toBe(true);
    expect(grants).toEqual(expectedGrants(Object.keys(grants)));
  });

  it("il controllo dei grant vede un privilegio mancante, uno in più, un grant di colonna e una funzione senza revoke (poi rollback)", async () => {
    let found: Record<string, string[]> = {};
    await pg.transaction(async (tx) => {
      await tx.exec(`
        revoke delete on public.opening_hours from service_role;
        grant truncate on public.opening_hours to authenticated;
        grant select (name) on public.practices to anon;
        create function app.t_no_revoke() returns integer language sql as 'select 1';
      `);
      found = await grantsOf(tx);
      await tx.rollback();
    });
    expect(found["public.opening_hours"]).toEqual([`authenticated: ${FOUR}, truncate`, "service_role: select, insert, update"]);
    expect(found["public.practices"]).toEqual(["anon: select (name)", `authenticated: ${FOUR}`, `service_role: ${FOUR}`]);
    expect(found["app.t_no_revoke()"]).toEqual(["PUBLIC: execute"]);
    const restored = await grantsOf(pg);
    expect(restored).toEqual(expectedGrants(Object.keys(restored)));
    expect(restored).not.toHaveProperty(["app.t_no_revoke()"]);
  });

  it("ogni funzione security definer sta in app con search_path vuoto", async () => {
    const { rows } = await pg.query<{ schema: string; name: string; config: string[] | null }>(
      `select n.nspname as schema, p.proname as name, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const wrong = rows
      .filter((row) => row.schema !== "app" || !(row.config ?? []).includes('search_path=""'))
      .map((row) => `${row.schema}.${row.name} ${JSON.stringify(row.config)}`);
    expect(wrong).toEqual([]);
  });
});

/**
 * Insert diretti come uA con lo studio B e i genitori di A, per le tabelle il cui caso generico
 * "uA inserisce con practice_id di B" si ferma prima, al genitore che il loro `insertFor` scrive
 * (`TableFixture.answeredBy.insert`): così risponde la with check della tabella stessa. I genitori
 * non si trovano con lo studio B, e i trigger lasciano rispondere alla RLS, che viene prima delle chiavi.
 */
const DIRECT_INSERTS: Readonly<Record<string, { sql: string; params: string[] }>> = {
  visits: {
    sql: `insert into public.visits (practice_id, patient_id, cycle_id, appointment_id, visit_date, kind, screening_catalog_version)
          values ($1, $2, $3, $4, '2026-10-12', 'seduta', 1)`,
    params: [PRACTICE_B, PATIENT_A1, CYCLE_A, APPOINTMENT_A],
  },
  psfs_scores: {
    sql: "insert into public.psfs_scores (practice_id, item_id, visit_id, score, phase) values ($1, $2, $3, 4, 'iniziale')",
    params: [PRACTICE_B, PSFS_ITEM_A, VISIT_A],
  },
  patient_attachments: {
    sql: `insert into public.patient_attachments (practice_id, patient_id, file_id, kind, view, taken_on)
          values ($1, $2, $3, 'foto_posturale', 'posteriore', '2026-10-05')`,
    params: [PRACTICE_B, PATIENT_A1, FILE_A],
  },
};

describe("with check delle insert che l'isolamento prova su un'altra tabella", () => {
  it("ogni tabella con answeredBy.insert ha qui il suo insert diretto", () => {
    expect(Object.keys(DIRECT_INSERTS).sort()).toEqual(tables.filter((t) => TABLE_FIXTURES[t]?.answeredBy?.insert));
  });

  it.each(Object.entries(DIRECT_INSERTS))(
    "uA inserisce in %s con practice_id di B e i genitori di A: 42501 dalla sua policy",
    async (table, { sql, params }) => {
      await expectPgError(
        asUserA(db, (tx) => tx.query(sql, params)),
        "42501",
        new RegExp(`row-level security policy for table "${table}"`),
      );
    },
  );
});
