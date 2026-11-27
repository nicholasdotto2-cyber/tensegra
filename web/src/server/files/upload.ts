import { randomUUID } from "node:crypto";
import type { Clock } from "@/server/clock";
import type { Actor, Db } from "@/server/db/db";
import { addAttachment } from "@/server/domain/attachments/commands";
import { PhotoFieldsInput } from "@/server/domain/attachments/schemas";
import { DomainError } from "@/server/domain/errors";
import { storageKey, type StoredMime } from "./keys";
import { checkUpload } from "./sniff";
import type { FileStore } from "./store";

// Caricamento di una foto posturale: controllo dei byte, chiave, file nello store, poi la
// transazione con `files` e `patient_attachments`. Se la transazione fallisce (doppione, paziente di
// un altro studio, errore del database) il file si toglie e l'errore risale. Se il processo muore fra
// la scrittura e la transazione resta un file orfano, innocuo, che sparisce al reset. Questo helper
// apre la sua transazione: riceve `db`, mai `tx`, e non si chiama dentro un'altra `asUser`.

export interface StoreContext {
  db: Db;
  actor: Actor;
  practiceId: string;
}

const PHOTO_MIMES: readonly StoredMime[] = ["image/jpeg", "image/png", "image/webp"];

export async function storePhoto(
  ctx: StoreContext,
  clock: Clock,
  store: FileStore,
  input: { bytes: Uint8Array; fields: unknown },
): Promise<{ id: string }> {
  const checked = checkUpload(input.bytes, PHOTO_MIMES);
  if (!checked.ok) throw new DomainError(checked.message, { field: "file" });
  // I campi prima di scrivere: un modulo sbagliato non scrive niente su disco.
  PhotoFieldsInput.parse(input.fields);

  const fileId = randomUUID();
  const key = storageKey(ctx.practiceId, "posture_photo", fileId, checked.mime);
  await store.put(key, input.bytes);
  try {
    return await ctx.db.asUser(ctx.actor, (tx) =>
      addAttachment(tx, ctx.practiceId, clock, {
        fields: input.fields,
        file: { id: fileId, storageKey: key, mime: checked.mime, size: checked.size, sha256: checked.sha256 },
      }),
    );
  } catch (error) {
    // Un errore della pulizia non nasconde quello della transazione: al più resta un orfano.
    await store.remove(key).catch(() => {});
    throw error;
  }
}
