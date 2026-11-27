import { type Actor, type Db, pgOf, runTransaction, setActorClaims, type Tx, toTx } from "./db";
import { scrubDbError } from "./errors";

// Transazione da superutente: solo script, test e src/server/demo/recreate.ts.
// Resta `postgres`, quindi ignora le policy RLS. Ha lo stesso controllo di annidamento di
// `asUser` e in più `exec`, per eseguire SQL senza parametri (più istruzioni insieme).
export function asService<T>(
  db: Db,
  fn: (tx: Tx & { exec(sql: string): Promise<void> }) => Promise<T>,
): Promise<T> {
  return runTransaction(pgOf(db), (tx) =>
    fn({
      ...toTx(tx),
      async exec(sql: string): Promise<void> {
        try {
          await tx.exec(sql);
        } catch (error) {
          throw scrubDbError(error);
        }
      },
    }),
  );
}

/**
 * Dentro `asService`: da qui al commit la transazione gira come `actor`, con gli stessi claim di
 * `asUser`, quindi RLS, trigger e `app.next_number` lavorano come nell'app. Serve al seed e a
 * "Ricrea": utente, studio, membership e contatori come servizio, poi ogni
 * scrittura di dominio come l'utente demo, tutto in una transazione. Va in una sola direzione:
 * dopo non si torna `postgres` fino al commit.
 */
export function switchToUser(tx: Tx, actor: Actor): Promise<void> {
  return setActorClaims(tx, actor);
}
