"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { type ActionResult, toActionFailure } from "@/server/actions/result";
import { runAction } from "@/server/actions/run";
import { fixedClock, systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { recordChoice, revokeConsent } from "@/server/domain/consents/commands";
import { getConsentCollection, type ConsentCollection } from "@/server/domain/consents/collection";
import { type ConsentPreview, getConsentPreview } from "@/server/domain/consents/preview";
import { type ConsentTarget, ConsentTargetSchema } from "@/server/domain/consents/schemas";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { getFileStore } from "@/server/files/disk-store";
import { blankConsentData, storeConsent, storeConsentUpload } from "@/server/pdf/consent-file";
import { renderConsentPdf } from "@/server/pdf/render";

// Le Server Action del dialogo di raccolta dei consensi. Studio, utente e destinatario arrivano
// dalla richiesta, mai dal client: il client manda il bersaglio (paziente, ciclo, genitore), i campi del modulo
// in JSON e i byte, mai path o metadati dei file. Firma e caricamento scrivono file e aprono da soli le loro
// transazioni (`storeConsent`, `storeConsentUpload`): come «Carica foto» non passano da `runAction`, che ne
// aprirebbe una annidata.

const CHOOSE_DOCUMENT = "Scegli il modulo firmato.";
const SIGN_FIRST = "La firma sembra incompleta. Firma di nuovo.";

const SignedOnSchema = z.iso.date();

/** Carta: modulo e firmatario alla data dichiarata. Senza data usa l'età di oggi (tela). */
export async function consentCollectionAction(target: ConsentTarget, signedOn?: string, guardianId?: string): Promise<ActionResult<ConsentCollection | null>> {
  return runAction("consentCollection", ({ tx, practiceId, clock }) =>
    getConsentCollection(tx, practiceId, clock, target, signedOn, guardianId), { revalidate: false });
}

/**
 * Il testo compilato da mostrare prima della firma; null se il bersaglio non vale (paziente o ciclo che non
 * c'è, modulo che non va con l'età). `signedOn` è il giorno dichiarato di un modulo caricato: l'hash
 * dell'anteprima dipende dall'età a quel giorno, come nel comando. Non scrive niente.
 */
export async function consentPreviewAction(target: ConsentTarget, signedOn?: string): Promise<ActionResult<ConsentPreview | null>> {
  return runAction(
    "consentPreview",
    ({ tx, practiceId, clock }) =>
      getConsentPreview(
        tx,
        practiceId,
        clock,
        ConsentTargetSchema.parse(target),
        signedOn === undefined ? undefined : SignedOnSchema.parse(signedOn),
      ),
    { revalidate: false },
  );
}

/** I campi del modulo (JSON dello schema dei campi); un testo che non è JSON non è un modulo. */
function fieldsOf(form: FormData): unknown {
  const raw = form.get("fields");
  if (typeof raw !== "string") throw new DomainError(NOT_ALLOWED);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new DomainError(NOT_ALLOWED);
  }
}

async function bytesOf(form: FormData, name: string): Promise<Uint8Array | null> {
  const value = form.get(name);
  return value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : null;
}

/** Il corpo comune delle azioni con file: errori come valori, la pagina riletta dopo il commit. */
async function withFiles<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    revalidatePath("/", "layout"); // dopo il commit
    return { ok: true, data };
  } catch (err) {
    // redirect() e notFound() lanciano: Next li gestisce lui, non sono errori da mostrare.
    unstable_rethrow(err);
    return toActionFailure(err, name);
  }
}

/**
 * «Firma e salva»: `fields` (JSON), `signature` (il PNG della tela) e `secondSignature` facoltativo. Il server
 * riconosce il PNG dai primi byte; il conteggio dei tratti è un controllo del browser. Se il PDF non si crea la
 * firma resta e `pdfReady` è false: si riprova con il documento, senza firmare di nuovo.
 */
export async function signConsentAction(data: FormData): Promise<ActionResult<{ id: string; pdfReady: boolean }>> {
  return withFiles("signConsent", async () => {
    const fields = fieldsOf(data);
    const signaturePng = await bytesOf(data, "signature");
    if (signaturePng === null) throw new DomainError(SIGN_FIRST, { field: "signature" });
    const secondSignaturePng = await bytesOf(data, "secondSignature");
    const ctx = await getRequestContext();
    const clock = fixedClock(systemClock.now()); // un istante per tutta l'azione
    return storeConsent(ctx, clock, getFileStore(), { fields, signaturePng, secondSignaturePng });
  });
}

/** «Carica il modulo firmato»: `fields` (JSON), `document` (PDF, JPG o PNG fino a 10 MB) e `signedOn`. */
export async function uploadConsentAction(data: FormData): Promise<ActionResult<{ id: string }>> {
  return withFiles("uploadConsent", async () => {
    const fields = fieldsOf(data);
    const bytes = await bytesOf(data, "document");
    if (bytes === null || bytes.length === 0) throw new DomainError(CHOOSE_DOCUMENT, { field: "document" });
    const signedOn = data.get("signedOn");
    if (typeof signedOn !== "string" || !SignedOnSchema.safeParse(signedOn).success) {
      throw new DomainError("Indica la data della firma.", { field: "signedOn" });
    }
    const ctx = await getRequestContext();
    const clock = fixedClock(systemClock.now());
    return storeConsentUpload(ctx, clock, getFileStore(), { fields, signedOn, bytes });
  });
}

/** «Registra revoca» di un documento: `{ id, revokedOn, mode, note }`. */
export async function revokeConsentAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("revokeConsent", ({ tx, practiceId, clock }) => revokeConsent(tx, practiceId, clock, input));
}

/** La revoca di una scelta dell'informativa (WhatsApp o richiami): `{ patientId, choice, value: false, ... }`. */
export async function recordChoiceAction(input: unknown): Promise<ActionResult<void>> {
  return runAction("recordChoice", ({ tx, practiceId, clock }) => recordChoice(tx, practiceId, clock, input));
}

/**
 * «Stampa il modulo»: il PDF compilato senza firma, da firmare su carta. Nessuna riga di consenso, nessun
 * evento, nessun file: si legge l'anteprima come l'utente, poi si disegna fuori dalla transazione.
 */
export async function printConsentAction(target: ConsentTarget, signedOn?: string): Promise<ActionResult<{ pdfBase64: string }>> {
  try {
    const parsed = ConsentTargetSchema.parse(target);
    const ctx = await getRequestContext();
    const clock = fixedClock(systemClock.now());
    const day = signedOn === undefined ? clock.today() : SignedOnSchema.parse(signedOn);
    const preview = await ctx.db.asUser(ctx.actor, (tx) => getConsentPreview(tx, ctx.practiceId, clock, parsed, day));
    if (preview === null) throw new DomainError(NOT_ALLOWED);
    const pdf = await renderConsentPdf(blankConsentData(preview, day));
    return { ok: true, data: { pdfBase64: Buffer.from(pdf).toString("base64") } };
  } catch (err) {
    unstable_rethrow(err);
    return toActionFailure(err, "printConsent");
  }
}
