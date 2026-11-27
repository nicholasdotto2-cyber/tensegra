import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { expect } from "vitest";
import { createDb, type Db, pgOf, runTransaction, type SqlParam, toTx, type Tx } from "@/server/db/db";
import { pgCode } from "@/server/db/errors";
import { createPglite } from "@/server/db/pglite";
import { asService } from "@/server/db/service";
import { USER_A, USER_B } from "./fixtures";
import { TEMPLATE_PATH } from "./global-setup";

/**
 * Un PGlite in memoria clonato dal modello di `global-setup.ts`: shim, migrazioni e fixture dei
 * due studi. Si apre con la fabbrica dell'app: sessione in UTC e `date` come stringa.
 */
export async function openTestDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = await createPglite({ loadDataDir: new Blob([new Uint8Array(readFileSync(TEMPLATE_PATH))]) });
  return { db: createDb(pg), pg };
}

export function asUserA<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.asUser({ userId: USER_A }, fn);
}

export function asUserB<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.asUser({ userId: USER_B }, fn);
}

/** Ruolo `anon` senza nessun claim, come una richiesta a Supabase senza login. */
export function asAnon<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runTransaction(pgOf(db), async (tx) => {
    await tx.query("select set_config('role', 'anon', true)");
    return fn(toTx(tx));
  });
}

/** Come servizio (`postgres`, ignora la RLS): per preparare dati e per rileggere ciò che un utente non vede. */
export function asServiceFor<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return asService(db, fn);
}

const ROLLBACK = new Error("rollback voluto dal test");

/**
 * Esegue `fn` come uA, uB o servizio, restituisce il suo risultato e annulla la transazione: nessuna
 * scrittura di `fn` resta salvata, quindi ogni test parte dalle fixture. Un errore di `fn` arriva
 * al chiamante (per `expectPgError`), e anche allora la transazione torna indietro.
 */
export async function inRollback<T>(db: Db, who: "A" | "B" | "service", fn: (tx: Tx) => Promise<T>): Promise<T> {
  const run = who === "A" ? asUserA : who === "B" ? asUserB : asServiceFor;
  let result: { value: T } | undefined;
  await run(db, async (tx) => {
    result = { value: await fn(tx) };
    throw ROLLBACK;
  }).catch((error: unknown) => {
    if (error !== ROLLBACK) throw error;
  });
  if (!result) throw new Error("fn non ha restituito niente");
  return result.value;
}

/**
 * Come servizio (`postgres`: salta la RLS e i privilegi di colonna) e poi torna indietro. Serve a preparare
 * dati e alle regole che valgono anche per il servizio; non prova niente su ciò che un utente può fare.
 */
export function inService<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inRollback(db, "service", fn);
}

/**
 * Come uA (`authenticated`, con la RLS e i privilegi veri) e poi torna indietro: per provare ciò che un
 * utente dello studio A può o non può fare.
 */
export function inUserA<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inRollback(db, "A", fn);
}

/**
 * Come il passo 1 di "Ricrea i dati di prova": fino alla fine della transazione i trigger
 * di immutabilità lasciano scrivere le righe di `practiceId`, ma solo a chi non è `authenticated`
 * (`app.purging`).
 */
export async function setPurge(tx: Tx, practiceId: string): Promise<void> {
  await tx.query("select set_config('app.purge_practice', $1, true)", [practiceId]);
}

/** L'errore con cui la promessa fallisce. Se si risolve il test fallisce, e `expected` dice cosa ci si aspettava. */
async function rejectionOf(p: Promise<unknown>, expected: string): Promise<unknown> {
  const outcome = await p.then(
    (value: unknown) => ({ resolved: true as const, value }),
    (error: unknown) => ({ resolved: false as const, error }),
  );
  if (outcome.resolved) {
    expect.fail(`atteso ${expected}, invece la promessa è risolta con ${JSON.stringify(outcome.value)}`);
  }
  return outcome.error;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * La promessa deve fallire con l'errore Postgres `code` (per esempio "42501") e, se c'è `message`, con
 * un messaggio che lo soddisfa. Il codice da solo non dice chi ha risposto: `42501` è lo stesso per la
 * RLS, per un privilegio mancante e per ogni trigger di immutabilità.
 */
export async function expectPgError(p: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  const error = await rejectionOf(p, `l'errore ${code}`);
  expect(pgCode(error), String(error)).toBe(code);
  if (message) expect(messageOf(error)).toMatch(message);
}

// Una delete bloccata da una chiave esterna risponde 23001 su Postgres 18 (PGlite, `on delete restrict`) e
// 23503 su Postgres 17 (Supabase, restrict e no action). Il 23503 è anche il codice dell'insert o dell'update
// verso un genitore che non c'è ("insert or update on table ..."): il messaggio della delete comincia invece
// con "update or delete on table ...", e il controllo evita che un errore dell'altro tipo passi per una delete.
const BLOCKED_DELETE_CODES = ["23001", "23503"];
const BLOCKED_DELETE_MESSAGE = /update or delete on table "[^"]+" violates /;

/** La promessa deve fallire perché una chiave esterna ferma la delete: 23001 (Postgres 18) o 23503 (Postgres 17). */
export async function expectBlockedDelete(p: Promise<unknown>): Promise<void> {
  const error = await rejectionOf(p, "una delete bloccata da una chiave esterna (23001 o 23503)");
  expect(BLOCKED_DELETE_CODES, String(error)).toContain(pgCode(error));
  expect(messageOf(error)).toMatch(BLOCKED_DELETE_MESSAGE);
}

/** Le colonne di una riga da inserire, con il loro valore. */
export type Values = Record<string, SqlParam>;

/** Un caso di `it.each` sui vincoli di una colonna: nome della colonna e valore da provare. */
export type Case = [column: string, value: SqlParam];

/** Il nome di una tabella o di una colonna tra virgolette doppie, pronto per essere scritto in una query. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** L'`id` di una riga appena inserita: `insertRow` la restituisce senza tipi. */
export function idOf(row: Record<string, unknown>): string {
  if (typeof row.id !== "string") throw new Error("la riga inserita non ha un id");
  return row.id;
}

/** Inserisce una riga in `public.<table>` con le sole colonne date e rilegge la riga intera. */
export async function insertRow(tx: Tx, table: string, values: Values): Promise<Record<string, unknown>> {
  const columns = Object.keys(values);
  const rows = await tx.query<Record<string, unknown>>(
    `insert into public.${ident(table)} (${columns.map(ident).join(", ")})
     values (${columns.map((_, index) => `$${index + 1}`).join(", ")})
     returning *`,
    Object.values(values),
  );
  const [row] = rows;
  if (!row) throw new Error(`nessuna riga restituita da public.${table}`);
  return row;
}

/** Le tabelle di `public` lette dal catalogo, in ordine di nome: una tabella nuova entra da sola nei test. */
export async function publicTables(pg: PGlite): Promise<string[]> {
  const { rows } = await pg.query<{ name: string }>(
    `select c.relname as name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname`,
  );
  return rows.map((row) => row.name);
}
