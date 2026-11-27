"use server";

import type { ActionResult } from "@/server/actions/result";
import { runAction } from "@/server/actions/run";
import {
  type CreatedAppointments,
  cancelAppointment,
  createAppointment,
  deleteAppointment,
  markConfirmed,
  markDone,
  markSkipped,
  restoreAppointment,
  savePaymentMethod,
  undoDone,
  undoSkipped,
  updateAppointment,
} from "@/server/domain/appointments/commands";
import {
  type AppointmentDetail,
  type AppointmentPreview,
  type BookingDefaults,
  bookingDefaults,
  getAppointmentDetail,
  getSedutaFatta,
  previewAppointment,
  type SedutaFattaView,
  suggestStart,
} from "@/server/domain/appointments/queries";
import { type PatientHit, searchPatients } from "@/server/domain/patients/queries";

// Le Server Action del dialogo "Nuovo appuntamento", del dettaglio, dei cambi di
// stato e del pannello "Seduta fatta". Ognuna apre la sua
// transazione come l'utente con `runAction`; studio e utente arrivano dalla richiesta, mai dal client,
// e ogni input del client passa dallo schema del comando. Le letture non ricaricano la pagina.

const READ_ONLY = { revalidate: false } as const;

/** I pazienti per il selettore del dialogo, dalla terza lettera. */
export async function searchPatientsAction(text: string): Promise<ActionResult<PatientHit[]>> {
  // Dal client può arrivare qualsiasi valore: ciò che non è testo non cerca niente.
  const needle = typeof text === "string" ? text : "";
  return runAction("searchPatients", ({ tx, practiceId }) => searchPatients(tx, practiceId, needle), READ_ONLY);
}

/** Prestazione, ciclo e sedute proposti per il paziente scelto. */
export async function bookingDefaultsAction(patientId: string): Promise<ActionResult<BookingDefaults>> {
  return runAction(
    "bookingDefaults",
    ({ tx, practiceId, clock }) => bookingDefaults(tx, practiceId, clock, { patientId }),
    READ_ONLY,
  );
}

/** L'orario proposto per una durata. */
export async function suggestStartAction(durationMin: number): Promise<ActionResult<{ day: string; time: string }>> {
  return runAction(
    "suggestStart",
    ({ tx, practiceId, clock }) => suggestStart(tx, practiceId, clock, { durationMin }),
    READ_ONLY,
  );
}

/** Gli avvisi della data scelta e le righe della serie, prima di salvare. */
export async function previewAppointmentAction(input: unknown): Promise<ActionResult<AppointmentPreview>> {
  return runAction(
    "previewAppointment",
    ({ tx, practiceId, clock }) => previewAppointment(tx, practiceId, clock, input),
    READ_ONLY,
  );
}

/** Salva l'appuntamento o la serie; la pagina si ricarica dopo il commit. */
export async function createAppointmentAction(input: unknown): Promise<ActionResult<CreatedAppointments>> {
  return runAction("createAppointment", ({ tx, practiceId, clock }) => createAppointment(tx, practiceId, clock, input));
}

/** Il dettaglio di un appuntamento per il pannello laterale; null se non c'è. */
export async function appointmentDetailAction(id: string): Promise<ActionResult<AppointmentDetail | null>> {
  return runAction(
    "appointmentDetail",
    ({ tx, practiceId, clock }) => getAppointmentDetail(tx, practiceId, clock, id),
    READ_ONLY,
  );
}

/** Il pannello "Seduta fatta" di un appuntamento fatto; null se non c'è o non è fatto. */
export async function sedutaFattaAction(id: string): Promise<ActionResult<SedutaFattaView | null>> {
  return runAction("sedutaFatta", ({ tx, practiceId, clock }) => getSedutaFatta(tx, practiceId, clock, id), READ_ONLY);
}

/** "Segna confermato". */
export async function markConfirmedAction(id: string): Promise<ActionResult<void>> {
  return runAction("markConfirmed", ({ tx, practiceId, clock }) => markConfirmed(tx, practiceId, clock, { id }));
}

/** "Segna come fatta": la domanda prima dell'inizio la fa l'interfaccia. */
export async function markDoneAction(id: string): Promise<ActionResult<void>> {
  return runAction("markDone", ({ tx, practiceId, clock }) => markDone(tx, practiceId, clock, { id }));
}

/** "Saltato". */
export async function markSkippedAction(id: string): Promise<ActionResult<void>> {
  return runAction("markSkipped", ({ tx, practiceId, clock }) => markSkipped(tx, practiceId, clock, { id }));
}

/** "Annulla 'fatto'". */
export async function undoDoneAction(id: string): Promise<ActionResult<void>> {
  return runAction("undoDone", ({ tx, practiceId, clock }) => undoDone(tx, practiceId, clock, { id }));
}

/** "Elimina", dopo la conferma. */
export async function deleteAppointmentAction(id: string): Promise<ActionResult<void>> {
  return runAction("deleteAppointment", ({ tx, practiceId, clock }) => deleteAppointment(tx, practiceId, clock, { id }));
}

/** "Ripristina", senza conferma: `overlap` è l'appuntamento che ora tocca lo stesso orario, o null. */
export async function restoreAppointmentAction(id: string): Promise<ActionResult<{ overlap: string | null }>> {
  return runAction("restoreAppointment", ({ tx, practiceId, clock }) => restoreAppointment(tx, practiceId, clock, { id }));
}

/** "Annulla 'saltato'", senza conferma: `overlap` è l'appuntamento che ora tocca lo stesso orario, o null. */
export async function undoSkippedAction(id: string): Promise<ActionResult<{ overlap: string | null }>> {
  return runAction("undoSkipped", ({ tx, practiceId, clock }) => undoSkipped(tx, practiceId, clock, { id }));
}

/** "Annulla appuntamento" con il motivo e, in una serie, le successive. */
export async function cancelAppointmentAction(input: unknown): Promise<ActionResult<{ cancelled: number }>> {
  return runAction("cancelAppointment", ({ tx, practiceId, clock }) => cancelAppointment(tx, practiceId, clock, input));
}

/** "Modifica" e "Sposta". */
export async function updateAppointmentAction(input: unknown): Promise<ActionResult<{ movedFromConfirmed: boolean }>> {
  return runAction("updateAppointment", ({ tx, practiceId, clock }) => updateAppointment(tx, practiceId, clock, input));
}

/** Il metodo del passo 1 del pannello "Seduta fatta"; null è "Non ancora incassato". */
export async function savePaymentMethodAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("savePaymentMethod", ({ tx, practiceId, clock }) => savePaymentMethod(tx, practiceId, clock, input));
}
