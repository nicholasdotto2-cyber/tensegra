// Che cosa mostra la riga del promemoria. Sicuro per il client: nessun import dal server.

const ASK = "Hai inviato il messaggio?";

export interface ReminderViewInput {
  /** Numero, canale o consenso fermano WhatsApp: resta la copia organizzativa. */
  blocked: boolean;
  statusText: string;
  lastMessage: { id: string; outcome: "da_confermare" | "inviato" | "non_inviato" } | null;
  /** La riga appena registrata da questa riga, se c'è. */
  recordedId: string | null;
  answer: { id: string; state: "saving" | "done" | "error" } | null;
}

export interface ReminderView {
  askId: string | null;
  question: string;
  answerLocked: boolean;
  showStatus: boolean;
  showCopy: boolean;
  showWhatsapp: boolean;
}

/**
 * Da confermare: l'ultima riga del server, o quella appena registrata finché la pagina non la porta. Dopo «Sì» o
 * «No» la domanda resta, coi pulsanti fermi, finché lo stato del server è quello vecchio: niente lampo dello stato
 * superato con le azioni. Senza WhatsApp «Copia» resta in ogni stato, accanto alla domanda; il link mai.
 */
export function reminderView({ blocked, statusText, lastMessage, recordedId, answer }: ReminderViewInput): ReminderView {
  const recorded = recordedId !== null && lastMessage?.id !== recordedId ? recordedId : null;
  const askId = recorded ?? (lastMessage?.outcome === "da_confermare" ? lastMessage.id : null);
  const question = recorded === null && !blocked && lastMessage?.outcome === "da_confermare" ? statusText : ASK;
  const open = askId === null && lastMessage?.outcome !== "inviato";
  return {
    askId,
    question,
    answerLocked: askId !== null && answer?.id === askId && answer.state !== "error",
    showStatus: askId === null || blocked,
    showCopy: blocked || open,
    showWhatsapp: !blocked && open,
  };
}
