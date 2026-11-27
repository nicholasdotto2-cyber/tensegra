import { isRuleCode, logDbError, pgCode, toUserMessage } from "@/server/db/errors";
import { isConflictError, isDomainError } from "@/server/domain/errors";

// Il risultato di una Server Action: gli errori attesi tornano come valori, già in
// italiano, mai come eccezioni. Senza `server-only`: i client component importano da qui i tipi.

export type ActionFailure = {
  ok: false;
  message: string;
  /** Il messaggio di ogni campo in errore, per percorso (`days.0.bands.1.closes`). */
  fieldErrors?: Record<string, string>;
  /** Qualcuno ha modificato l'appuntamento: la pagina si ricarica. */
  conflict?: true;
  /**
   * Un rifiuto: una regola di dominio, un input non valido o una regola del database con il suo testo.
   * Rimandare la stessa richiesta darebbe lo stesso errore; senza la bandiera l'errore è imprevisto
   * (database, rete, bug) e riprovare ha senso.
   */
  refused?: true;
};

export type ActionResult<T> = { ok: true; data: T } | ActionFailure;

interface ZodLike {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}

// Per `name`, come gli errori di dominio: lo ZodError può nascere in un altro bundle.
function isZodError(err: unknown): err is ZodLike {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ZodError" &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

const textOf = (err: { message?: unknown }): string => (typeof err.message === "string" ? err.message : "");

/**
 * Trasforma ciò che ha lanciato un comando nella risposta per il client. Un errore del database o un
 * imprevisto vanno nel log del server (senza i parametri della query) e al client arriva un testo
 * generico: il messaggio originale non esce mai.
 */
export function toActionFailure(err: unknown, context: string): ActionFailure {
  if (isConflictError(err)) return { ok: false, message: textOf(err), conflict: true };

  if (isDomainError(err)) {
    const message = textOf(err);
    if (err.fieldErrors && Object.keys(err.fieldErrors).length > 0) {
      return { ok: false, message, fieldErrors: { ...err.fieldErrors }, refused: true };
    }
    if (typeof err.field === "string") return { ok: false, message, fieldErrors: { [err.field]: message }, refused: true };
    return { ok: false, message, refused: true };
  }

  if (isZodError(err)) {
    const [first] = err.issues;
    if (first) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of err.issues) {
        const path = issue.path.map(String).join(".");
        // Una issue senza percorso (una regola sull'intero oggetto) non ha un campo; la prima per
        // ogni percorso vince.
        if (path !== "" && !(path in fieldErrors)) fieldErrors[path] = issue.message;
      }
      return Object.keys(fieldErrors).length > 0
        ? { ok: false, message: first.message, fieldErrors, refused: true }
        : { ok: false, message: first.message, refused: true };
    }
  }

  const code = pgCode(err);
  if (code !== undefined) {
    logDbError(err, context);
    if (isRuleCode(code)) return { ok: false, message: toUserMessage(err), refused: true };
  } else {
    console.error(`[app] ${context}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: false, message: toUserMessage(err) };
}
