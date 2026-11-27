import { VIEW_LABEL } from "@/lib/clinical/labels";
import { dayShort } from "@/lib/format";
import type { Tx } from "@/server/db/db";

// Letture delle foto posturali: la griglia della vista Foto e
// il riquadro "Ultimi allegati" della Cartella. Le foto tolte non escono. Ordine per giorno della
// foto, dal più recente; a parità `created_at` e poi `id`, così l'ordine non si ferma all'ora del
// database.

type View = keyof typeof VIEW_LABEL;

export interface PhotoRow {
  /** L'allegato: lo usa "Togli la foto". */
  id: string;
  /** Il file: `/api/files/<fileId>`. */
  fileId: string;
  view: string;
  viewLabel: string;
  /** "AAAA-MM-GG". */
  takenOn: string;
  /** "lun 2 nov". */
  dateText: string;
  caption: string | null;
  widthPx: number | null;
  heightPx: number | null;
}

interface PhotoDbRow {
  id: string;
  fileId: string;
  view: View;
  takenOn: string;
  caption: string | null;
  widthPx: number | null;
  heightPx: number | null;
}

async function photos(tx: Tx, practiceId: string, patientId: string, limit: number | null): Promise<PhotoRow[]> {
  const rows = await tx.query<PhotoDbRow>(
    `select id,
            file_id as "fileId",
            view,
            taken_on as "takenOn",
            caption,
            width_px as "widthPx",
            height_px as "heightPx"
       from public.patient_attachments
      where practice_id = $1 and patient_id = $2 and kind = 'foto_posturale' and deleted_at is null
      order by taken_on desc, created_at desc, id desc
      limit $3`,
    [practiceId, patientId, limit],
  );
  return rows.map((row) => ({
    ...row,
    viewLabel: VIEW_LABEL[row.view],
    dateText: dayShort(row.takenOn),
  }));
}

/** Tutte le foto non tolte del paziente. */
export function listPhotos(tx: Tx, practiceId: string, patientId: string): Promise<PhotoRow[]> {
  return photos(tx, practiceId, patientId, null);
}

/** Le ultime `limit` foto non tolte del paziente, per "Ultimi allegati". */
export function latestAttachments(tx: Tx, practiceId: string, patientId: string, limit = 3): Promise<PhotoRow[]> {
  return photos(tx, practiceId, patientId, limit);
}
