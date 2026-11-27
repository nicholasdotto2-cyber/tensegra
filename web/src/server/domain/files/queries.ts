import type { Tx } from "@/server/db/db";
import { extensionFor, type FileKind, type StoredMime } from "@/server/files/keys";

// La riga di un file per `GET /api/files/[id]`. Nessuna riga (id
// che non c'è, file di un altro studio, foto tolta, file senza una riga di dominio che lo punta) vale
// 404. Il giorno del nome scaricato viene dalla riga di dominio, mai da `files.created_at`, che è
// l'ora vera del database.

export interface StoredFileRow {
  id: string;
  storageKey: string;
  mimeType: StoredMime;
  kind: FileKind;
  /** "AAAA-MM-GG": `taken_on` dell'allegato o `created_on` del rinvio. */
  day: string;
}

export async function getStoredFile(tx: Tx, practiceId: string, fileId: string): Promise<StoredFileRow | null> {
  const [row] = await tx.query<StoredFileRow>(
    `select f.id,
            f.storage_key as "storageKey",
            f.mime_type as "mimeType",
            f.kind,
            coalesce(a.taken_on, r.created_on) as day
       from public.files f
       left join public.patient_attachments a
         on a.practice_id = f.practice_id and a.file_id = f.id and a.deleted_at is null
       left join public.referrals r
         on r.practice_id = f.practice_id and r.letter_file_id = f.id
      where f.practice_id = $1 and f.id = $2
        and (a.id is not null or r.id is not null)
      limit 1`,
    [practiceId, fileId],
  );
  return row ?? null;
}

/** Il nome del file scaricato: il tipo e il giorno, mai il nome del paziente. */
export function downloadName(row: StoredFileRow): string {
  const ext = extensionFor(row.mimeType);
  if (row.kind === "posture_photo") return `foto-${row.day}.${ext}`;
  if (row.kind === "referral_pdf") return `lettera-medico-${row.day}.pdf`;
  return `allegato-${row.day}.${ext}`;
}
