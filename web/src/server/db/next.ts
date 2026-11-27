import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { getActor } from "@/server/auth/actor";
import type { Actor, Db } from "./db";
import { getDb } from "./open";

// Il contesto di una richiesta di Next: database, utente e studio. `cache` di React lo
// calcola una volta per richiesta anche se layout e pagina lo chiedono entrambi.

export interface RequestContext {
  db: Db;
  actor: Actor;
  practiceId: string;
}

/** Il database è migrato ma l'utente demo non ha uno studio: manca il seed. */
export class NoPracticeError extends Error {
  constructor() {
    super("Nessun dato demo: esegui pnpm db:seed.");
    this.name = "NoPracticeError";
  }
}

export const getRequestContext: () => Promise<RequestContext> = cache(async () => {
  // Il codice dopo connection() gira solo con una richiesta vera, mai nel prerender.
  await connection();
  const db = await getDb();
  const actor = getActor();
  const [membership] = await db.asUser(actor, (tx) =>
    tx.query<{ practice_id: string }>("select practice_id from memberships order by created_at limit 1"),
  );
  if (!membership) throw new NoPracticeError();
  return { db, actor, practiceId: membership.practice_id };
});
