import path from "node:path";

// Chiavi dei file: `<practice_id>/<kind>/<file_id>.<ext>`, minuscolo, come il percorso
// dello Storage di Supabase e come il check di `files.storage_key`. Ogni percorso che lo
// store apre passa da `isValidStorageKey` e da `resolveInside`: un `..` non esce dalla cartella.

export type FileKind =
  | "posture_photo"
  | "clinical_doc"
  | "signature"
  | "consent_pdf"
  | "consent_upload"
  | "invoice_pdf"
  | "referral_pdf";

export type StoredMime = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

const KINDS: readonly FileKind[] = [
  "posture_photo",
  "clinical_doc",
  "signature",
  "consent_pdf",
  "consent_upload",
  "invoice_pdf",
  "referral_pdf",
];

const EXTENSION: Record<StoredMime, "jpg" | "png" | "webp" | "pdf"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID}$`);
const KEY_PATTERN = new RegExp(`^${UUID}/(${KINDS.join("|")})/${UUID}\\.(jpg|png|webp|pdf)$`);
const PREFIX_PATTERN = new RegExp(`^${UUID}(/(${KINDS.join("|")}))?/?$`);

export function extensionFor(mime: StoredMime): "jpg" | "png" | "webp" | "pdf" {
  return EXTENSION[mime];
}

/** La chiave del file. Lancia `RangeError` se studio o file non sono uuid in minuscolo. */
export function storageKey(practiceId: string, kind: FileKind, fileId: string, mime: StoredMime): string {
  if (!UUID_PATTERN.test(practiceId) || !UUID_PATTERN.test(fileId)) {
    throw new RangeError("Studio o file non validi per la chiave del file.");
  }
  return `${practiceId}/${kind}/${fileId}.${extensionFor(mime)}`;
}

export function isValidStorageKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** Un prefisso di `FileStore.removeAll`: `<practice_id>` o `<practice_id>/<kind>`, con o senza `/` finale. */
export function isValidStoragePrefix(prefix: string): boolean {
  return PREFIX_PATTERN.test(prefix);
}

/**
 * Il percorso di `key` sotto `root`. Lancia `RangeError` se, risolto, non sta strettamente dentro
 * `root` (`..`, un percorso assoluto altrove, la radice stessa).
 */
export function resolveInside(root: string, key: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, key);
  const rel = path.relative(base, resolved);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new RangeError("Il percorso del file esce dalla cartella dei file.");
  }
  return resolved;
}
