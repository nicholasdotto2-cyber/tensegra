"use server";

import type { ActionResult } from "@/server/actions/result";
import { runAction } from "@/server/actions/run";
import { recordMessage, setMessageOutcome } from "@/server/domain/messages/commands";
import { prepareMessage, type PreparedMessage } from "@/server/domain/messages/queries";
import { type MessageSource, MessageSourceSchema } from "@/server/domain/messages/schemas";
import { getMessageRecipient, type MessageRecipient } from "@/server/domain/messages/recipient";
import { z } from "zod";

// Le Server Action del compositore dei messaggi. Il browser manda solo la
// sorgente, il testo finale e l'id del tentativo: paziente, destinatario e permessi si rileggono sul server.

/** Il contatto senza testo della testata, riletto con RLS come per il compositore. */
export async function messageRecipientAction(patientId: string): Promise<ActionResult<MessageRecipient | null>> {
  return runAction("messageRecipient", ({ tx, practiceId, clock }) =>
    getMessageRecipient(tx, practiceId, clock, z.uuid().parse(patientId)), { revalidate: false });
}

/** L'anteprima: una lettura, nessuna riga e niente da rileggere nella pagina. */
export async function prepareMessageAction(source: MessageSource): Promise<ActionResult<PreparedMessage | null>> {
  return runAction(
    "prepareMessage",
    ({ tx, practiceId, clock }) => prepareMessage(tx, practiceId, clock, MessageSourceSchema.parse(source)),
    { revalidate: false },
  );
}

/** Una copia riuscita, una copia manuale dichiarata o l'apertura di WhatsApp; il retry riusa lo stesso id. */
export async function recordMessageAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction("recordMessage", ({ tx, practiceId, clock }) => recordMessage(tx, practiceId, clock, input));
}

/** «Sì» o «No» a «Hai inviato il messaggio?»: cambia l'esito di quella riga, non ne crea un'altra. */
export async function setMessageOutcomeAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("setMessageOutcome", ({ tx, practiceId, clock }) => setMessageOutcome(tx, practiceId, clock, input));
}
