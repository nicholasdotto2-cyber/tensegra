import { describe, expect, it } from "vitest";
import { reminderView } from "@/lib/messages/reminder-view";

// Che cosa mostra la riga del promemoria: la copia organizzativa resta per le
// righe senza WhatsApp in ogni stato, e dopo «Sì» o «No» la domanda resta ferma finché non arriva lo stato nuovo.
const X = "a0000000-0000-4000-8000-0000000000aa";
const ASK = "Hai inviato il messaggio?";
const pending = { id: X, outcome: "da_confermare" as const };
const base = { blocked: false, statusText: "Aperto alle 08:30, inviato?", lastMessage: pending, recordedId: null, answer: null };

describe("reminderView", () => {
  it("copia_organizzativa_sempre: senza WhatsApp «Copia» resta in ogni stato, il link mai", () => {
    const blocked = { ...base, blocked: true, statusText: "Manca il consenso WhatsApp: telefona o usa Copia per un SMS" };
    for (const lastMessage of [null, pending, { id: X, outcome: "inviato" as const }, { id: X, outcome: "non_inviato" as const }]) {
      expect(reminderView({ ...blocked, lastMessage })).toMatchObject({ showCopy: true, showWhatsapp: false, showStatus: true });
    }
    // Da confermare: la domanda accanto alla copia, con la sua frase (lo stato resta il motivo).
    expect(reminderView(blocked)).toMatchObject({ askId: X, question: ASK, showCopy: true });
    // Appena registrata, prima che la pagina porti la riga: stessa cosa.
    expect(reminderView({ ...blocked, lastMessage: null, recordedId: X })).toMatchObject({ askId: X, showCopy: true });
  });

  it("nessun_lampo_dopo_si: dopo la risposta la domanda resta, ferma, finché lo stato del server è vecchio", () => {
    expect(reminderView(base)).toMatchObject({
      askId: X, question: "Aperto alle 08:30, inviato?", answerLocked: false, showStatus: false, showCopy: false, showWhatsapp: false,
    });
    for (const state of ["saving", "done"] as const) {
      expect(reminderView({ ...base, answer: { id: X, state } })).toMatchObject({
        askId: X, answerLocked: true, showStatus: false, showCopy: false, showWhatsapp: false,
      });
    }
    // Un errore riapre i pulsanti.
    expect(reminderView({ ...base, answer: { id: X, state: "error" } })).toMatchObject({ askId: X, answerLocked: false });
    // Arriva lo stato nuovo: «Inviato» senza azioni, «Non inviato» con le azioni.
    const done = { id: X, state: "done" as const };
    expect(reminderView({ ...base, statusText: "Inviato alle 08:30", lastMessage: { id: X, outcome: "inviato" }, answer: done }))
      .toMatchObject({ askId: null, showStatus: true, showCopy: false, showWhatsapp: false });
    expect(reminderView({ ...base, statusText: "Non inviato", lastMessage: { id: X, outcome: "non_inviato" }, answer: done }))
      .toMatchObject({ askId: null, showStatus: true, showCopy: true, showWhatsapp: true });
  });

  it("registrata qui: la domanda di conferma finché la pagina non porta la riga, poi lo stato del server", () => {
    const fresh = { ...base, statusText: "Da inviare", lastMessage: null, recordedId: X };
    expect(reminderView(fresh)).toMatchObject({ askId: X, question: ASK, showStatus: false, showCopy: false });
    expect(reminderView({ ...base, recordedId: X })).toMatchObject({ askId: X, question: "Aperto alle 08:30, inviato?" });
    expect(reminderView({ ...base, statusText: "Da inviare", lastMessage: null })).toMatchObject({
      askId: null, showStatus: true, showCopy: true, showWhatsapp: true,
    });
  });
});
