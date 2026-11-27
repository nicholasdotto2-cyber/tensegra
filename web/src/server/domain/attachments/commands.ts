import { dayField } from "@/lib/format";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { storageKey, type StoredMime } from "@/server/files/keys";
import { PhotoFieldsInput, RemoveAttachmentInput } from "./schemas";

// Comandi degli allegati. La foto arriva già scritta
// nello store da `storePhoto`: qui si scrivono, nella stessa transazione, la riga di `files` e quella
// di `patient_attachments` che la punta. "Togli la foto" è una cancellazione morbida (`deleted_at`).
// Nessun comando tocca `created_by` né `created_at`.

/** Il file appena scritto nello store, con i dati che `checkUpload` ha letto dai suoi byte. */
export interface StoredFileInput {
  id: string;
  storageKey: string;
  mime: StoredMime;
  size: number;
  sha256: string;
}

/** Come la chiusura del ciclo e la consegna del rinvio, il giorno della foto non va oltre oggi. */
const PHOTO_IN_FUTURE = "La foto non può essere nel futuro.";

const duplicateText = (takenOn: string): string => `Questa foto è già nella cartella del ${dayField(takenOn).slice(0, 5)}`;

async function patientExists(tx: Tx, practiceId: string, patientId: string): Promise<boolean> {
  const rows = await tx.query("select 1 from public.patients where practice_id = $1 and id = $2", [
    practiceId,
    patientId,
  ]);
  return rows.length > 0;
}

/** Ciclo e visita, se ci sono, sono di questo paziente: le chiavi esterne guardano solo lo studio. */
async function belongsToPatient(
  tx: Tx,
  practiceId: string,
  patientId: string,
  table: "treatment_cycles" | "visits",
  id: string | undefined,
): Promise<boolean> {
  if (id === undefined) return true;
  const rows = await tx.query(`select 1 from public.${table} where practice_id = $1 and id = $2 and patient_id = $3`, [
    practiceId,
    id,
    patientId,
  ]);
  return rows.length > 0;
}

/**
 * Registra una foto posturale. Il giorno della foto non è dopo oggi (`PHOTO_IN_FUTURE`). Il doppione si
 * cerca prima di scrivere, fra le foto non tolte dello stesso paziente con lo stesso sha256 (la stessa foto
 * su un altro paziente passa), e risponde con il giorno della foto già in cartella.
 */
export async function addAttachment(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: { fields: unknown; file: StoredFileInput },
): Promise<{ id: string }> {
  const photo = PhotoFieldsInput.parse(input.fields);
  const { file } = input;
  // Un paziente, ciclo o visita che non c'è, o è di un altro studio o paziente, si ferma qui.
  if (!(await patientExists(tx, practiceId, photo.patientId))) throw new DomainError(NOT_ALLOWED);
  if (!(await belongsToPatient(tx, practiceId, photo.patientId, "treatment_cycles", photo.cycleId))) {
    throw new DomainError(NOT_ALLOWED);
  }
  if (!(await belongsToPatient(tx, practiceId, photo.patientId, "visits", photo.visitId))) {
    throw new DomainError(NOT_ALLOWED);
  }
  // La chiave è quella che `storePhoto` ha calcolato per questo studio e questo file.
  if (file.storageKey !== storageKey(practiceId, "posture_photo", file.id, file.mime)) throw new DomainError(NOT_ALLOWED);
  // I giorni "AAAA-MM-GG" in ordine di testo sono in ordine di calendario.
  if (photo.takenOn > clock.today()) throw new DomainError(PHOTO_IN_FUTURE, { field: "takenOn" });

  const [duplicate] = await tx.query<{ takenOn: string }>(
    `select a.taken_on as "takenOn"
       from public.patient_attachments a
       join public.files f on f.practice_id = a.practice_id and f.id = a.file_id
      where a.practice_id = $1 and a.patient_id = $2 and a.kind = 'foto_posturale' and a.deleted_at is null
        and f.sha256 = $3
      order by a.taken_on, a.created_at, a.id
      limit 1`,
    [practiceId, photo.patientId, file.sha256],
  );
  if (duplicate) throw new DomainError(duplicateText(duplicate.takenOn), { field: "file" });

  await tx.query(
    `insert into public.files (id, practice_id, kind, storage_key, mime_type, size_bytes, sha256)
     values ($1, $2, 'posture_photo', $3, $4, $5, $6)`,
    [file.id, practiceId, file.storageKey, file.mime, file.size, file.sha256],
  );
  const [row] = await tx.query<{ id: string }>(
    `insert into public.patient_attachments
       (practice_id, patient_id, visit_id, cycle_id, file_id, kind, view, taken_on, width_px, height_px, caption)
     values ($1, $2, $3, $4, $5, 'foto_posturale', $6, $7, $8, $9, $10)
     returning id`,
    [
      practiceId,
      photo.patientId,
      photo.visitId ?? null,
      photo.cycleId ?? null,
      file.id,
      photo.view,
      photo.takenOn,
      photo.widthPx ?? null,
      photo.heightPx ?? null,
      photo.caption ?? null,
    ],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return { id: row.id };
}

/**
 * "Togli la foto": `deleted_at` = l'istante del comando. Un allegato già tolto resta com'è; uno che
 * non c'è, o è di un altro studio, risponde "Operazione non permessa".
 */
export async function removeAttachment(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { attachmentId } = RemoveAttachmentInput.parse(input);
  const [current] = await tx.query<{ removed: boolean }>(
    `select deleted_at is not null as removed from public.patient_attachments where practice_id = $1 and id = $2`,
    [practiceId, attachmentId],
  );
  if (!current) throw new DomainError(NOT_ALLOWED);
  if (current.removed) return;
  await tx.query(
    "update public.patient_attachments set deleted_at = $3 where practice_id = $1 and id = $2 and deleted_at is null",
    [practiceId, attachmentId, clock.now()],
  );
}
