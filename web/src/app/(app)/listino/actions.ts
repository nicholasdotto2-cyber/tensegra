"use server";

import type { ActionResult } from "@/server/actions/result";
import { runAction } from "@/server/actions/run";
import {
  applyPriceToFuture,
  archiveService,
  createDefaultServices,
  createService,
  deleteService,
  restoreService,
  updateService,
} from "@/server/domain/services/commands";

// Le Server Action del Listino. Ognuna apre la sua transazione come l'utente
// con `runAction`; studio e utente arrivano dalla richiesta, mai dal client, e ogni input passa dallo
// schema del comando.

/** "Salva" di una voce nuova. */
export async function createServiceAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction("createService", ({ tx, practiceId, clock }) => createService(tx, practiceId, clock, input));
}

/** "Salva" di una voce esistente: risponde quanti appuntamenti futuri sono ancora al prezzo vecchio. */
export async function updateServiceAction(
  input: unknown,
): Promise<ActionResult<{ futureAtOldPrice: number; oldPriceCents: number }>> {
  return runAction("updateService", ({ tx, practiceId, clock }) => updateService(tx, practiceId, clock, input));
}

/** "Aggiorna": porta al prezzo attuale gli appuntamenti futuri rimasti al prezzo vecchio. */
export async function applyPriceToFutureAction(input: unknown): Promise<ActionResult<{ updated: number }>> {
  return runAction("applyPriceToFuture", ({ tx, practiceId, clock }) => applyPriceToFuture(tx, practiceId, clock, input));
}

/** "Archivia". */
export async function archiveServiceAction(id: string): Promise<ActionResult<void>> {
  return runAction("archiveService", ({ tx, practiceId, clock }) => archiveService(tx, practiceId, clock, { id }));
}

/** "Ripristina", senza conferma. */
export async function restoreServiceAction(id: string): Promise<ActionResult<void>> {
  return runAction("restoreService", ({ tx, practiceId, clock }) => restoreService(tx, practiceId, clock, { id }));
}

/** "Elimina", dopo la conferma. */
export async function deleteServiceAction(id: string): Promise<ActionResult<void>> {
  return runAction("deleteService", ({ tx, practiceId, clock }) => deleteService(tx, practiceId, clock, { id }));
}

/** "Crea le tre voci di partenza", solo a listino vuoto. */
export async function createDefaultServicesAction(): Promise<ActionResult<void>> {
  return runAction("createDefaultServices", ({ tx, practiceId, clock }) => createDefaultServices(tx, practiceId, clock));
}
