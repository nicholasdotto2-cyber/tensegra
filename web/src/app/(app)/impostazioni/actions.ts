"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock, systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { DomainError } from "@/server/domain/errors";
import { getFileStore } from "@/server/files/disk-store";
import { storePractitionerSignature } from "@/server/files/practitioner-signature";
import type { ActionResult } from "@/server/actions/result";
import { runAction } from "@/server/actions/run";
import { restoreMessageTemplate, saveMessageTemplate } from "@/server/domain/messages/commands";
import { previewMessageTemplate } from "@/server/domain/messages/queries";
import { type PatientHit, searchPatients } from "@/server/domain/patients/queries";
import {
  saveClinicalSettings,
  saveCommunicationSettings,
  saveDemoTestPhone,
  saveFiscalSettings,
  saveOpeningHours,
  saveRegistration,
  saveStudio,
} from "@/server/domain/settings/commands";

// Le Server Action di Impostazioni: una per sezione con il suo "Salva". Ognuna apre la sua
// transazione come l'utente con `runAction`; studio e utente arrivano dalla richiesta, mai dal client, e
// ogni input passa dallo schema `.strict()` del comando. Aspetto non ha azioni: il tema vive nel browser.

/** "Salva" di Studio. */
export async function saveStudioAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("saveStudio", ({ tx, practiceId, clock }) => saveStudio(tx, practiceId, clock, input));
}

/** "Salva" di Fisco. */
export async function saveFiscalSettingsAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("saveFiscalSettings", ({ tx, practiceId, clock }) => saveFiscalSettings(tx, practiceId, clock, input));
}

/** "Salva" di Iscrizione e polizza. */
export async function saveRegistrationAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("saveRegistration", ({ tx, practiceId, clock }) => saveRegistration(tx, practiceId, clock, input));
}

/** "Salva" di Orari: risponde quanti appuntamenti futuri restano fuori dai nuovi orari e il giorno del primo. */
export async function saveOpeningHoursAction(
  input: unknown,
): Promise<ActionResult<{ outsideCount: number; firstOutsideDay: string | null }>> {
  return runAction("saveOpeningHours", ({ tx, practiceId, clock }) => saveOpeningHours(tx, practiceId, clock, input));
}

/** "Salva" di Cartella. */
export async function saveClinicalSettingsAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("saveClinicalSettings", ({ tx, practiceId, clock }) =>
    saveClinicalSettings(tx, practiceId, clock, input),
  );
}

/** "Salva" del numero per le prove WhatsApp di Dati di prova. */
export async function saveDemoTestPhoneAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("saveDemoTestPhone", ({ tx, practiceId, clock }) => saveDemoTestPhone(tx, practiceId, clock, input));
}

export async function saveMessageTemplateAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("saveMessageTemplate", ({ tx, practiceId, clock }) => saveMessageTemplate(tx, practiceId, clock, input));
}

export async function restoreMessageTemplateAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("restoreMessageTemplate", ({ tx, practiceId, clock }) => restoreMessageTemplate(tx, practiceId, clock, input));
}

export async function saveCommunicationSettingsAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("saveCommunicationSettings", ({ tx, practiceId, clock }) => saveCommunicationSettings(tx, practiceId, clock, input));
}

export async function previewMessageTemplateAction(input: unknown): Promise<ActionResult<{ text: string; missing: string[] }>> {
  return runAction("previewMessageTemplate", ({ tx, practiceId, clock }) => previewMessageTemplate(tx, practiceId, clock, input), { revalidate: false });
}

/** Il paziente dell'anteprima Messaggi, cercato dalla terza lettera come nell'agenda; solo gli attivi, come l'elenco di prima. */
export async function searchPreviewPatientsAction(text: string): Promise<ActionResult<PatientHit[]>> {
  // Dal client può arrivare qualsiasi valore: ciò che non è testo non cerca niente.
  const needle = typeof text === "string" ? text : "";
  return runAction(
    "searchPreviewPatients",
    async ({ tx, practiceId }) => (await searchPatients(tx, practiceId, needle)).filter((hit) => !hit.archived),
    { revalidate: false },
  );
}

/** L'orchestratore dei file apre da sé la transazione: fuori da runAction, come uploadPhotoAction. */
export async function storePractitionerSignatureAction(data: FormData): Promise<ActionResult<void>> {
  try {
    const file = data.get("file");
    if (!(file instanceof File)) throw new DomainError("Disegna la firma prima di salvarla.", { field: "file" });
    const ctx = await getRequestContext();
    const clock = fixedClock(systemClock.now());
    await storePractitionerSignature(ctx, clock, getFileStore(), new Uint8Array(await file.arrayBuffer()));
    revalidatePath("/", "layout");
    return { ok: true, data: undefined };
  } catch (error) {
    unstable_rethrow(error);
    return toActionFailure(error, "storePractitionerSignature");
  }
}
