import { randomUUID } from "node:crypto";
import type { Clock } from "@/server/clock";
import { DomainError } from "@/server/domain/errors";
import { setPractitionerSignature } from "@/server/domain/settings/commands";
import { storageKey } from "./keys";
import { checkUpload } from "./sniff";
import type { FileStore } from "./store";
import type { StoreContext } from "./upload";

/** Come storePhoto: byte fuori transazione, metadati e impostazione atomici sotto RLS. */
export async function storePractitionerSignature(ctx: StoreContext, clock: Clock, store: FileStore, bytes: Uint8Array): Promise<void> {
  const checked = checkUpload(bytes, ["image/png"]);
  if (!checked.ok) throw new DomainError(checked.message, { field: "file" });
  const id = randomUUID();
  const key = storageKey(ctx.practiceId, "signature", id, checked.mime);
  await store.put(key, bytes);
  try {
    await ctx.db.asUser(ctx.actor, tx => setPractitionerSignature(tx, ctx.practiceId, clock, {
      file: { id, storageKey: key, mime: checked.mime, size: checked.size, sha256: checked.sha256 },
    }));
  } catch (error) {
    await store.remove(key).catch(() => {});
    throw error;
  }
}
