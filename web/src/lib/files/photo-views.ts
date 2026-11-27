import { VIEW_LABEL } from "@/lib/clinical/labels";
import type { PhotoRow } from "@/server/domain/attachments/queries";

// Le viste di una foto posturale e il testo alternativo delle miniature,
// in un posto solo per la griglia, il confronto e il dialogo di caricamento.

export type PhotoViewCode = keyof typeof VIEW_LABEL;

/** I codici delle viste nell'ordine delle etichette: anteriore, posteriore, laterali, altro. */
export const VIEW_CODES = Object.keys(VIEW_LABEL) as PhotoViewCode[];

/**
 * Il testo alternativo di ogni foto, per id: «Foto posteriore del mer 4 nov». Due foto della stessa vista nello
 * stesso giorno si distinguono con «, foto 2» (nell'ordine in cui arrivano), così un lettore di schermo non
 * legge due immagini uguali.
 */
export function photoAltTexts(photos: readonly PhotoRow[]): Map<string, string> {
  const base = (photo: PhotoRow): string => `Foto ${photo.viewLabel.toLowerCase()} del ${photo.dateText}`;
  const total = new Map<string, number>();
  for (const photo of photos) total.set(base(photo), (total.get(base(photo)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const texts = new Map<string, string>();
  for (const photo of photos) {
    const text = base(photo);
    const position = (seen.get(text) ?? 0) + 1;
    seen.set(text, position);
    texts.set(photo.id, (total.get(text) ?? 1) > 1 ? `${text}, foto ${position}` : text);
  }
  return texts;
}
