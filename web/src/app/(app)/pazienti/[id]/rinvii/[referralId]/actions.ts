"use server";

import type { ActionResult } from "@/server/actions/result";
import { runAction } from "@/server/actions/run";
import { markReferralDelivered, updateReferral } from "@/server/domain/referrals/commands";

// Le Server Action della lettera al medico. Corpo a una riga: il comando
// valida l'input col suo schema `.strict()`, e studio e utente arrivano dalla richiesta, mai dal client. Dopo il
// commit la pagina e la Cartella si rileggono (`runAction`).

/** "Salva": destinatario, motivo, urgenza, sintesi, richiesta e assenso del paziente. */
export async function updateReferralAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("updateReferral", ({ tx, practiceId, clock }) => updateReferral(tx, practiceId, clock, input));
}

/** "Segna come consegnata al paziente": vuole l'assenso e un giorno che non sia nel futuro. */
export async function markReferralDeliveredAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("markReferralDelivered", ({ tx, practiceId, clock }) =>
    markReferralDelivered(tx, practiceId, clock, input),
  );
}
