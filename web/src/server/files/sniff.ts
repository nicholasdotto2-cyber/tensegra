import { createHash } from "node:crypto";
import { HEIC_TEXT, MAX_FILE_BYTES, NOT_IMAGE_TEXT, TOO_BIG_TEXT } from "@/lib/files/messages";
import type { StoredMime } from "./keys";

// Il tipo di un file dai primi byte, non dal nome né dal tipo che dichiara il browser:
// JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF....WEBP`, PDF `%PDF-`. HEIC si riconosce
// a parte per dire all'utente come esportare la foto.

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");
const PDF = ascii("%PDF-");
const FTYP = ascii("ftyp");
// I marchi ISO BMFF di HEIC e HEIF (immagini e sequenze), come li scrivono i telefoni.
const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"].map(ascii);

export function sniffMime(bytes: Uint8Array): StoredMime | null {
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
  if (startsWith(bytes, PDF)) return "application/pdf";
  return null;
}

/** `ftyp` all'offset 4 seguito da un marchio HEIC o HEIF. */
export function looksLikeHeic(bytes: Uint8Array): boolean {
  return startsWith(bytes, FTYP, 4) && HEIF_BRANDS.some((brand) => startsWith(bytes, brand, 8));
}

/** L'hash esadecimale in minuscolo, come il check di `files.sha256`. */
export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type UploadCheck =
  | { ok: true; mime: StoredMime; sha256: string; size: number }
  | { ok: false; message: string };

/** Peso, poi HEIC, poi tipo fra quelli ammessi: il primo che non va dà la frase per l'utente. */
export function checkUpload(bytes: Uint8Array, allowed: readonly StoredMime[]): UploadCheck {
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, message: TOO_BIG_TEXT };
  if (looksLikeHeic(bytes)) return { ok: false, message: HEIC_TEXT };
  const mime = sniffMime(bytes);
  if (mime === null || !allowed.includes(mime)) return { ok: false, message: NOT_IMAGE_TEXT };
  return { ok: true, mime, sha256: sha256Of(bytes), size: bytes.length };
}
