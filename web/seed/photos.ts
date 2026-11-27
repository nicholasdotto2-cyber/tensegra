import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEMO_PRACTICE_ID } from "@/server/auth/actor";
import { fixedClock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { addAttachment, type StoredFileInput } from "@/server/domain/attachments/commands";
import { readVerified } from "@/server/files/consents";
import { storageKey } from "@/server/files/keys";
import { checkUpload } from "@/server/files/sniff";
import type { FileStore } from "@/server/files/store";
import { endOf } from "./dates";
import type { Seeded } from "./demo";

// Le foto posturali di Giulia: anteriore e laterale destra alla prima visita e
// all'ultima seduta fatta. Sono sagome disegnate con forme semplici, mai foto di persone, JPEG senza
// EXIF e al più 2000 px di lato come le foto caricate. Come i file dei consensi:
// `prepareSeedPhotoAssets` le mette nello store prima della transazione, `seedPhotos` le registra con
// `addAttachment` dentro la transazione, e in errore chi chiama toglie solo i file di questo tentativo.

const P = DEMO_PRACTICE_ID;
const PATIENT = { firstName: "Giulia", lastName: "Ferrante" } as const;

// Percorso dalla cartella web, come `seedAsset` di consents.ts: dentro il bundle di Next un
// `new URL(..., import.meta.url)` non è un URL di Node e `readFile` lo rifiuta.
const assetPath = (name: string): string => join(process.cwd(), "seed", "assets", name);

/** Le quattro sagome: vista e visita (0 la prima visita, 1 l'ultima seduta fatta). */
const PHOTOS = [
  { name: "giulia-anteriore-1.jpg", view: "anteriore", visitIndex: 0 },
  { name: "giulia-laterale-1.jpg", view: "laterale_dx", visitIndex: 0 },
  { name: "giulia-anteriore-2.jpg", view: "anteriore", visitIndex: 1 },
  { name: "giulia-laterale-2.jpg", view: "laterale_dx", visitIndex: 1 },
] as const;

export type SeedPhotoAsset = {
  view: "anteriore" | "laterale_dx";
  visitIndex: 0 | 1;
  file: StoredFileInput;
  bytes: Uint8Array;
  width: number;
  height: number;
};

/** Larghezza e altezza dal primo marcatore SOF del JPEG (baseline o progressivo). */
function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) break;
    const marker = bytes[i + 1] ?? 0;
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
      const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
      return { width, height };
    }
    i += 2 + length;
  }
  throw new Error("Sagoma del seed senza misure.");
}

/** Toglie dallo store le sagome preparate da un tentativo di seed: i file che c'erano prima restano. */
export async function removeSeedPhotoAssets(store: FileStore, assets: readonly SeedPhotoAsset[]): Promise<void> {
  for (const a of assets) await store.remove(a.file.storageKey);
}

/**
 * Prima della transazione: ogni sagoma in un file nuovo dello store, riletto e verificato con l'hash. Un id per
 * file, come le foto caricate. Se una scrittura fallisce toglie quelle già scritte.
 */
export async function prepareSeedPhotoAssets(store: FileStore): Promise<SeedPhotoAsset[]> {
  const prepared: SeedPhotoAsset[] = [];
  try {
    for (const photo of PHOTOS) {
      const bytes = new Uint8Array(await readFile(assetPath(photo.name)));
      const checked = checkUpload(bytes, ["image/jpeg"]);
      if (!checked.ok) throw new Error(`Sagoma del seed non valida: ${photo.name}`);
      const { width, height } = jpegSize(bytes);
      if (Math.max(width, height) > 2000) throw new Error(`Sagoma del seed troppo grande: ${photo.name}`);
      const id = randomUUID();
      const file: StoredFileInput = {
        id,
        storageKey: storageKey(P, "posture_photo", id, checked.mime),
        mime: checked.mime,
        size: checked.size,
        sha256: checked.sha256,
      };
      prepared.push({ view: photo.view, visitIndex: photo.visitIndex, file, bytes, width, height });
      await store.put(file.storageKey, bytes);
      if (!(await readVerified(store, file))) throw new Error(`Il file del seed ${file.storageKey} non è stato salvato.`);
    }
  } catch (error) {
    await removeSeedPhotoAssets(store, prepared).catch(() => {});
    throw error;
  }
  return prepared;
}

/**
 * Le foto di Giulia con "Carica foto" (`addAttachment`), dopo la cartella: alla fine della prima visita e
 * dell'ultima seduta fatta, legate alla visita e al ciclo, con il giorno della visita.
 */
export async function seedPhotos(tx: Tx, seeded: readonly Seeded[], assets: readonly SeedPhotoAsset[]): Promise<void> {
  const s = seeded.find((x) => x.patient.firstName === PATIENT.firstName && x.patient.lastName === PATIENT.lastName);
  if (!s) throw new Error("Giulia non è nel seed.");
  const done = s.appointments.filter((a) => a.seed.status === "fatto");
  const visits = [done[0], done.at(-1)];
  for (const asset of assets) {
    const appointment = visits[asset.visitIndex];
    if (!appointment) throw new Error("Giulia non ha la seduta fatta della foto.");
    const [visit] = await tx.query<{ id: string }>(
      "select id from public.visits where practice_id = $1 and appointment_id = $2",
      [P, appointment.id],
    );
    if (!visit) throw new Error("La seduta della foto di Giulia non ha la visita.");
    await addAttachment(tx, P, fixedClock(endOf(appointment)), {
      fields: {
        patientId: s.patientId,
        view: asset.view,
        takenOn: appointment.day,
        cycleId: s.cycleId,
        visitId: visit.id,
        widthPx: asset.width,
        heightPx: asset.height,
      },
      file: asset.file,
    });
  }
}
