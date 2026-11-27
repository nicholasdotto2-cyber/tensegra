import { AsyncLocalStorage } from "node:async_hooks";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { z } from "zod";
import { scrubDbError } from "./errors";

// Interfaccia Db: ogni query di dominio gira in una transazione come
// `authenticated`, con il claim dell'utente demo, come su Supabase. Le policy RLS sono
// quindi le stesse nei due posti.

export type SqlParam = string | number | boolean | null | Date | readonly string[];
export interface Tx {
  query<T = Record<string, unknown>>(text: string, params?: readonly SqlParam[]): Promise<T[]>;
}
export interface Actor {
  readonly userId: string;
}
export interface Db {
  asUser<T>(actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** `asUser` o `asService` chiamati mentre una transazione è già aperta nello stesso contesto asincrono. */
export class NestedTransactionError extends Error {
  constructor() {
    super(
      "Transazione annidata: asUser o asService chiamati dentro un'altra transazione. Passa tx alle funzioni di dominio, mai db.",
    );
    this.name = "NestedTransactionError";
  }
}

/** L'attore non ha uno `userId` uuid valido. Il valore non entra nel messaggio. */
export class InvalidActorError extends Error {
  constructor() {
    super("Attore non valido: userId non è un uuid.");
    this.name = "InvalidActorError";
  }
}

const userIdSchema = z.uuid();

// I tre set_config valgono solo dentro la transazione (`is_local` = true), come `set local
// role` nella doc Supabase: al commit o al rollback la connessione torna `postgres`.
const CLAIMS_SQL = `select set_config('role', 'authenticated', true),
       set_config('request.jwt.claim.sub', $1, true),
       set_config('request.jwt.claims', $2, true)`;

// `next build` compila questo modulo una volta per bundle (la pagina /oggi, la route
// /api/health), e così fa l'HMR di `next dev` a ogni modifica: ogni copia avrebbe il suo store e
// la sua WeakMap, e il Db aperto da una copia non funzionerebbe con le funzioni dell'altra. Come
// la Promise di apertura (open.ts), i due stanno su `globalThis`: uno solo per processo.
function processWide<T>(key: string, create: () => T): T {
  const store = globalThis as unknown as Record<symbol, T | undefined>;
  return (store[Symbol.for(key)] ??= create());
}

// Il mutex delle transazioni di PGlite non è rientrante: un `pg.transaction` chiamato
// dentro un'altra aspetta per sempre, e con lui ogni altra richiesta. Questo store segna
// la transazione aperta nel contesto asincrono corrente, così l'annidamento fallisce subito.
const openTransaction = processWide("app.db.openTransaction", () => new AsyncLocalStorage<true>());

const pgByDb = processWide("app.db.pgByDb", () => new WeakMap<Db, PGlite>());

/**
 * Solo per `service.ts`: apre `pg.transaction` con lo stesso controllo di annidamento di
 * `asUser`. Il controllo avviene prima di toccare il mutex di PGlite.
 */
export async function runTransaction<T>(pg: PGlite, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  if (openTransaction.getStore()) throw new NestedTransactionError();
  try {
    return await pg.transaction((tx) =>
      openTransaction.run(true, async () => {
        const result = await fn(tx);
        // Se fn ha preso l'errore di una query e poi risolve, Postgres ha già abortito la
        // transazione e il COMMIT di PGlite diventa un ROLLBACK senza errore: il chiamante
        // vedrebbe un successo con le scritture perse. In una transazione abortita questa
        // query lancia 25P02, quindi PGlite fa rollback e la chiamata rifiuta. Una transazione
        // ripresa con `rollback to savepoint` passa.
        await tx.query("select 1");
        return result;
      }),
    );
  } catch (error) {
    // Ogni errore che esce dal livello db, senza i dati della query.
    throw scrubDbError(error);
  }
}

/** Solo per `service.ts`: la `Tx` che le funzioni di dominio vedono, sopra una transazione di PGlite. */
export function toTx(tx: Transaction): Tx {
  return {
    async query<T = Record<string, unknown>>(text: string, params?: readonly SqlParam[]): Promise<T[]> {
      try {
        return (await tx.query<T>(text, params ? [...params] : undefined)).rows;
      } catch (error) {
        // Già qui: anche una funzione di dominio che prende l'errore non vede i parametri.
        throw scrubDbError(error);
      }
    },
  };
}

function assertValidActor(actor: Actor): void {
  if (!userIdSchema.safeParse(actor.userId).success) throw new InvalidActorError();
}

/**
 * Solo per `asUser` e per `switchToUser` di `service.ts`: da qui al commit la transazione aperta
 * gira come `authenticated`, con il claim di `actor`.
 */
export async function setActorClaims(tx: Tx, actor: Actor): Promise<void> {
  assertValidActor(actor);
  await tx.query(CLAIMS_SQL, [actor.userId, JSON.stringify({ sub: actor.userId, role: "authenticated" })]);
}

export function createDb(pg: PGlite): Db {
  const db: Db = {
    async asUser<T>(actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
      // Prima di toccare il mutex di PGlite: un attore non valido non apre la transazione.
      assertValidActor(actor);
      return runTransaction(pg, async (pgTx) => {
        const tx = toTx(pgTx);
        await setActorClaims(tx, actor);
        return fn(tx);
      });
    },
  };
  pgByDb.set(db, pg);
  return db;
}

/** Solo per `service.ts`: il PGlite dietro un `Db` creato da `createDb`. */
export function pgOf(db: Db): PGlite {
  const pg = pgByDb.get(db);
  if (!pg) throw new Error("Questo Db non è stato creato da createDb.");
  return pg;
}
