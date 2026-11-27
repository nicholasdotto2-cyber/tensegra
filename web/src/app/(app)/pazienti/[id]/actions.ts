"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { fixedClock, systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { type ActionResult, toActionFailure } from "@/server/actions/result";
import { runAction } from "@/server/actions/run";
import { removeAttachment } from "@/server/domain/attachments/commands";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { closeCycle } from "@/server/domain/cycles/commands";
import { type CycleClosingView, getCycleClosing } from "@/server/domain/cycles/queries";
import { INVALID } from "@/server/domain/cycles/schemas";
import type { RegistryGuardian } from "@/server/domain/patients/card";
import {
  archivePatient,
  deletePatient,
  removeGuardian,
  restorePatient,
  type SavedGroup,
  saveGuardian,
  setClinicalAlert,
  setRecall,
  updatePatientGroup,
} from "@/server/domain/patients/commands";
import { recallWeeksOf, snoozeRecall } from "@/server/domain/patients/recall-commands";
import { createPhysician } from "@/server/domain/physicians/commands";
import { createReferral } from "@/server/domain/referrals/commands";
import { startVisit } from "@/server/domain/visits/commands";
import { getFileStore } from "@/server/files/disk-store";
import { storePhoto } from "@/server/files/upload";

// Le Server Action della scheda paziente. Ognuna apre la sua transazione come l'utente con
// `runAction`; studio e utente arrivano dalla richiesta, mai dal client, e l'input passa dallo schema del
// comando. Dopo il commit la scheda e la lista si rileggono.

/** "Archivia", dopo la conferma. */
export async function archivePatientAction(patientId: string): Promise<ActionResult<void>> {
  return runAction("archivePatient", ({ tx, practiceId, clock }) => archivePatient(tx, practiceId, clock, { patientId }));
}

/** "Ripristina", senza conferma. */
export async function restorePatientAction(patientId: string): Promise<ActionResult<void>> {
  return runAction("restorePatient", ({ tx, practiceId, clock }) => restorePatient(tx, practiceId, clock, { patientId }));
}

/**
 * "Elimina definitivamente", dopo la conferma. Senza `revalidatePath`: la scheda che si rileggerebbe è
 * quella del paziente appena tolto (darebbe 404 per un istante); il client passa alla lista, che è dinamica.
 */
export async function deletePatientAction(patientId: string): Promise<ActionResult<void>> {
  return runAction(
    "deletePatient",
    ({ tx, practiceId, clock }) => deletePatient(tx, practiceId, clock, { patientId }),
    { revalidate: false },
  );
}

/** "Cambia" del richiamo: `{ patientId, weeks, paused }`. */
export async function setRecallAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("setRecall", ({ tx, practiceId, clock }) => setRecall(tx, practiceId, clock, input));
}

/** «Rimanda di 2 settimane» di una riga «Da richiamare»: la riga torna fra 14 giorni. */
export async function snoozeRecallAction(patientId: string): Promise<ActionResult<void>> {
  return runAction("snoozeRecall", ({ tx, practiceId, clock }) => snoozeRecall(tx, practiceId, clock, { patientId }));
}

/** «Sospendi i richiami»: `setRecall` con le settimane lette ora nella transazione, così la cadenza resta. */
export async function pauseRecallAction(patientId: string): Promise<ActionResult<void>> {
  return runAction("pauseRecall", async ({ tx, practiceId, clock }) => {
    const current = await recallWeeksOf(tx, practiceId, z.uuid({ error: INVALID }).parse(patientId));
    if (current === null) throw new DomainError(NOT_ALLOWED);
    await setRecall(tx, practiceId, clock, { patientId, weeks: current.weeks, paused: true });
  });
}

/** «Modifica avviso» (dalla Cartella): `{ patientId, clinicalAlert }`, vuoto lo toglie. */
export async function setClinicalAlertAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("setClinicalAlert", ({ tx, practiceId, clock }) => setClinicalAlert(tx, practiceId, clock, input));
}

/** La finestra "Chiudi ciclo", sola lettura: null per un ciclo chiuso o che non c'è. */
export async function cycleClosingAction(cycleId: string): Promise<ActionResult<CycleClosingView | null>> {
  return runAction(
    "cycleClosing",
    ({ tx, practiceId, clock }) => getCycleClosing(tx, practiceId, clock, z.uuid({ error: INVALID }).parse(cycleId)),
    { revalidate: false },
  );
}

/** «Chiudi ciclo» della finestra: esito, punteggi finali, cadenza e data di chiusura. */
export async function closeCycleAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("closeCycle", ({ tx, practiceId, clock }) => closeCycle(tx, practiceId, clock, input));
}

/** "Nuovo rinvio" e «Prepara la lettera»: il rinvio in bozza; la pagina della lettera apre dopo. */
export async function createReferralAction(input: unknown): Promise<ActionResult<{ id: string; patientId: string }>> {
  return runAction("createReferral", ({ tx, practiceId, clock }) => createReferral(tx, practiceId, clock, input));
}

/** "Apri la visita": la visita dell'appuntamento, creata se manca (idempotente). */
export async function startVisitAction(
  appointmentId: string,
): Promise<ActionResult<{ visitId: string; patientId: string }>> {
  return runAction("startVisit", ({ tx, practiceId, clock }) => startVisit(tx, practiceId, clock, { appointmentId }));
}

/** "Salva" di un gruppo dell'anagrafica: `{ group, patientId, ...campi del gruppo }`. Risponde coi valori salvati. */
export async function updatePatientGroupAction(input: unknown): Promise<ActionResult<SavedGroup>> {
  return runAction("updatePatientGroup", ({ tx, practiceId, clock }) => updatePatientGroup(tx, practiceId, clock, input));
}

/** "Salva" di un genitore o tutore: nuovo senza `guardianId`, modificato con. Risponde con il genitore salvato. */
export async function saveGuardianAction(
  input: unknown,
): Promise<ActionResult<{ id: string; guardian: RegistryGuardian }>> {
  return runAction("saveGuardian", ({ tx, practiceId, clock }) => saveGuardian(tx, practiceId, clock, input));
}

/** "Togli" su un genitore o tutore: `{ guardianId }`. */
export async function removeGuardianAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("removeGuardian", ({ tx, practiceId, clock }) => removeGuardian(tx, practiceId, clock, input));
}

/** «Salva il medico» del dialogo "Nuovo medico": entra nella rubrica dello studio. */
export async function createPhysicianAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction("createPhysician", ({ tx, practiceId, clock }) => createPhysician(tx, practiceId, clock, input));
}

const CHOOSE_FILE = "Scegli la foto.";

/** Un campo di testo del modulo; assente o vuoto vale "non scritto". */
function textField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * «Salva» di "Carica foto": `file` (la foto già ridotta dal browser) e i campi `patientId`, `view`,
 * `takenOn`, `caption`, `widthPx`, `heightPx` e, dall'editor, `visitId` e `cycleId`. Eccezione al corpo a una
 * riga: legge il `FormData`, passa a `storePhoto` solo le chiavi dello schema dei campi (`.strict()`)
 * e, perché scrive un file e poi apre la sua transazione, non passa da `runAction`. Studio e utente arrivano dalla
 * richiesta; il tipo del file lo decidono i primi byte, mai il nome né il tipo dichiarato.
 */
export async function uploadPhotoAction(form: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const file = form.get("file");
    if (!(file instanceof File)) throw new DomainError(CHOOSE_FILE, { field: "file" });
    const bytes = new Uint8Array(await file.arrayBuffer());

    const width = textField(form, "widthPx");
    const height = textField(form, "heightPx");
    const fields = {
      patientId: textField(form, "patientId"),
      view: textField(form, "view"),
      takenOn: textField(form, "takenOn"),
      caption: textField(form, "caption"),
      cycleId: textField(form, "cycleId"),
      visitId: textField(form, "visitId"),
      widthPx: width === undefined ? undefined : Number(width),
      heightPx: height === undefined ? undefined : Number(height),
    };

    const ctx = await getRequestContext();
    const clock = fixedClock(systemClock.now()); // un istante per tutta l'azione
    const data = await storePhoto(ctx, clock, getFileStore(), { bytes, fields: dropUndefined(fields) });
    revalidatePath("/", "layout"); // dopo il commit
    return { ok: true, data };
  } catch (err) {
    // redirect() e notFound() lanciano: Next li gestisce lui, non sono errori da mostrare.
    unstable_rethrow(err);
    return toActionFailure(err, "uploadPhoto");
  }
}

/** Un oggetto senza le chiavi vuote: lo schema dei campi è `.strict()` e un campo assente non è un campo vuoto. */
function dropUndefined(fields: Record<string, string | number | undefined>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string | number] => entry[1] !== undefined));
}

/** «Togli la foto», dopo la conferma: cancellazione morbida dell'allegato, senza ripristino nell'interfaccia. */
export async function removeAttachmentAction(attachmentId: string): Promise<ActionResult<void>> {
  return runAction("removeAttachment", ({ tx, practiceId, clock }) =>
    removeAttachment(tx, practiceId, clock, { attachmentId }),
  );
}
