"use server";

import type { ActionResult } from "@/server/actions/result";
import { runAction } from "@/server/actions/run";
import { createPatient } from "@/server/domain/patients/commands";

// La Server Action del dialogo "Nuovo paziente". Apre la sua transazione come l'utente con
// `runAction`; studio e utente arrivano dalla richiesta, mai dal client, e l'input passa dallo schema
// del comando. Dopo il commit la lista si rilegge.

/** Salva un paziente nuovo, con il genitore se è minore; restituisce l'id per aprire la scheda. */
export async function createPatientAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction("createPatient", ({ tx, practiceId, clock }) => createPatient(tx, practiceId, clock, input));
}
