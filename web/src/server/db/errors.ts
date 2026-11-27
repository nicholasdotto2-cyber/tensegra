// Errori del database verso l'utente: il messaggio a schermo è in italiano,
// senza codici né dettagli di Postgres; l'originale va solo nel log del server, e mai con
// i parametri della query (gli errori di PGlite li portano in `params`, e quelli della
// classe 22 anche nel messaggio).

// 23001 è la delete bloccata da una chiave `on delete restrict` (Postgres 18, PGlite). Su Postgres 17
// (Supabase) la stessa delete risponde 23503: i comandi di cancellazione trattano i due codici allo
// stesso modo, e il testo di 23503 è quello dell'insert verso un genitore che non c'è.
const USER_MESSAGES: Readonly<Record<string, string>> = {
  "42501": "Operazione non permessa",
  "23505": "Esiste già",
  "23503": "Collegato a un dato che non esiste o non è dello studio",
  "23001": "È collegato ad altri dati: non si può eliminare.",
  "23514": "Valore non valido",
};

const GENERIC_MESSAGE = "Qualcosa non ha funzionato. I dati già salvati sono al sicuro. Ricarica la pagina.";

// SQLSTATE: cinque caratteri fra cifre e lettere maiuscole. Esclude i `code` di Node (ENOENT).
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Un codice con il suo testo per l'utente: una regola del database (23514, 23505, 23503, 23001, 42501).
 * Rimandare la stessa scrittura dà lo stesso errore, quindi per l'azione è un rifiuto, non un guasto.
 */
export function isRuleCode(code: string): boolean {
  return code in USER_MESSAGES;
}

/** Il codice SQLSTATE di un errore di Postgres, o `undefined`. */
export function pgCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && SQLSTATE.test(code) ? code : undefined;
}

export function toUserMessage(err: unknown): string {
  const code = pgCode(err);
  return (code === undefined ? undefined : USER_MESSAGES[code]) ?? GENERIC_MESSAGE;
}

// Negli errori della classe 22 (data exception) Postgres mette il valore del parametro nel
// messaggio, fra virgolette e senza escape di quelle interne: `invalid input syntax for type
// uuid: "a"b"`. Si toglie tutto dalla prima all'ultima virgoletta. Gli altri codici restano
// interi, perché fra virgolette hanno solo nomi di vincoli, colonne e tabelle.
const QUOTED = /"[\s\S]*"/;

/**
 * Toglie da un errore di PGlite i dati della query, sullo stesso oggetto: `params`, il `detail`
 * di Postgres ("Key (email)=(…) already exists", "Failing row contains (…)") e, per la classe 22,
 * il valore citato nel messaggio e nello stack. `db.ts` la chiama su ogni errore che esce da una
 * query o da una transazione: Next stampa gli errori interi con util.inspect, e così non vede
 * nessun dato. Restano codice, messaggio e testo SQL (con i segnaposto `$1`).
 */
export function scrubDbError<T>(err: T): T {
  if (typeof err !== "object" || err === null) return err;
  const fields = err as Record<string, unknown>;
  if (!("params" in fields) && pgCode(err) === undefined) return err;
  delete fields.params;
  delete fields.detail;
  if (err instanceof Error && pgCode(err)?.startsWith("22")) {
    const redacted = err.message.replace(QUOTED, '"…"');
    if (err.stack) err.stack = err.stack.replace(err.message, redacted);
    err.message = redacted;
  }
  return err;
}

/** Scrive solo contesto, codice e messaggio: mai l'oggetto errore, che contiene query e parametri. */
export function logDbError(err: unknown, context: string): void {
  const code = pgCode(err);
  const raw = err instanceof Error ? err.message : String(err);
  const message = code?.startsWith("22") ? raw.replace(QUOTED, '"…"') : raw;
  console.error(`[db] ${context}: ${code ?? "-"} ${message}`);
}
