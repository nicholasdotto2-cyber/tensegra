// Limiti e frasi comuni dei messaggi, usati dal server e da compositore,
// righe dei promemoria e dei richiami. Sicuro per il client: nessun import dal server.

/** Il limite del testo finale, in code point come `char_length` di Postgres. */
export const MESSAGE_MAX = 700;
export const MESSAGE_TOO_LONG = "Il messaggio supera i 700 caratteri: accorcialo prima di copiare.";
/** Accanto a ogni link WhatsApp della demo. */
export const DEMO_NOTICE = "Dati di prova: il messaggio va al numero per le prove.";

// Copia, apertura e dichiarazione dell'invio: le stesse frasi nel compositore
// e nelle righe dei richiami.
export const MESSAGE_COPIED = "Messaggio copiato. Incollalo in WhatsApp.";
export const COPY_FAILED = "Copia non riuscita: premi Ctrl+C per copiare il testo selezionato.";
export const COPY_NOT_LOGGED = "Messaggio copiato, ma non registrato. Riprova a registrarlo.";
export const OPEN_NOT_LOGGED = "WhatsApp aperto, ma non registrato. Riprova a registrarlo.";
export const MANUAL_LOGGED = "Copia registrata.";
export const SENT_QUESTION = "Hai inviato il messaggio?";
export const MARKED_SENT = "Segnato come inviato.";
export const MARKED_NOT_SENT = "Segnato come non inviato.";
export const OUTCOME_NOT_SAVED = "Non ho salvato la risposta. Riprova.";

/** Il motivo della rettifica che la copia dei consigli scrive da sé su una visita chiusa. */
export const ADVICE_MESSAGE_REASON = "Registrata la preparazione del messaggio con i consigli.";

/** Perché copia e link sono fermi: solo la lunghezza si rivaluta sul testo ritoccato, il resto vale comunque. */
export type CopyDisabledCode = "troppo_lungo" | "non_ammesso";

export function messageLength(text: string): number {
  return Array.from(text).length;
}
