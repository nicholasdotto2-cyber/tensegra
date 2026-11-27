import { MAX_FILE_BYTES } from "@/lib/files/messages";
import type { StoredMime } from "./keys";
import { sha256Of, sniffMime } from "./sniff";
import type { FileStore } from "./store";

// I file dei consensi: il PNG della firma dalla tela e il modulo firmato caricato (PDF,
// JPG o PNG fino a 10 MB, salvato così com'è). Il tipo viene dai primi byte, come per le foto, ma le frasi
// sono quelle della tab Consensi: le frasi globali delle foto (`@/lib/files/messages`) non cambiano.
// Ogni lettura confronta i byte con l'hash salvato in `files`: un file cambiato sul disco non si serve.

export const CONSENT_TOO_BIG_TEXT = "Il file supera i 10 MB.";
export const CONSENT_NOT_DOCUMENT_TEXT = "Il file non è un PDF o un'immagine.";

const UPLOAD_MIMES: readonly StoredMime[] = ["application/pdf", "image/jpeg", "image/png"];

export type ConsentFileCheck =
  | { ok: true; mime: StoredMime; sha256: string; size: number }
  | { ok: false; message: string };

function check(bytes: Uint8Array, allowed: readonly StoredMime[]): ConsentFileCheck {
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, message: CONSENT_TOO_BIG_TEXT };
  const mime = sniffMime(bytes);
  if (mime === null || !allowed.includes(mime)) return { ok: false, message: CONSENT_NOT_DOCUMENT_TEXT };
  return { ok: true, mime, sha256: sha256Of(bytes), size: bytes.length };
}

/** Il modulo firmato caricato: PDF, JPG o PNG, al più 10 MB. */
export function checkConsentUpload(bytes: Uint8Array): ConsentFileCheck {
  return check(bytes, UPLOAD_MIMES);
}

/** Il PNG della firma dalla tela. */
export function checkSignaturePng(bytes: Uint8Array): ConsentFileCheck {
  return check(bytes, ["image/png"]);
}

/** I byte salvati alla chiave, solo se il loro sha256 è quello registrato; altrimenti null. */
export async function readVerified(store: FileStore, file: { storageKey: string; sha256: string }): Promise<Uint8Array | null> {
  const bytes = await store.get(file.storageKey);
  return bytes !== null && sha256Of(bytes) === file.sha256 ? bytes : null;
}
