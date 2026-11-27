import type { Tx } from "./db";
import { logDbError } from "./errors";

// Un blocco di una pagina dentro un savepoint: la pagina ha una sola transazione,
// e un errore di Postgres la abortisce per intero. Con il savepoint un blocco che fallisce torna
// indietro da solo, il resto della pagina continua e il blocco mostra "Non riesco a caricare questo
// elenco.".

export type Settled<T> = { ok: true; value: T } | { ok: false };

// Il nome entra nell'SQL (`savepoint <name>` non accetta parametri): solo identificatori semplici.
const SAVEPOINT_NAME = /^[a-z_][a-z0-9_]*$/;

export async function settle<T>(tx: Tx, name: string, fn: () => Promise<T>): Promise<Settled<T>> {
  if (!SAVEPOINT_NAME.test(name)) {
    throw new RangeError("Nome del savepoint non valido: servono minuscole, cifre e trattini bassi.");
  }
  await tx.query(`savepoint ${name}`);
  try {
    const value = await fn();
    // Il release sta nel try: se `fn` ha preso un errore del database e poi risolve, la transazione
    // è già abortita e il release lancia; il blocco conta come fallito, e il rollback la riapre.
    await tx.query(`release savepoint ${name}`);
    return { ok: true, value };
  } catch (err) {
    await tx.query(`rollback to savepoint ${name}`);
    logDbError(err, name);
    return { ok: false };
  }
}
