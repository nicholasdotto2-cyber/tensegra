import { overlaps } from "@/lib/agenda/slots";

// Regole del modulo Orari: al massimo 2 fasce per giorno, ore a
// passi di 15 da 00:00 a 23:45, fasce che si toccano ammesse. Le usano il modulo sul client e il
// comando sul server, così i due danno gli stessi messaggi sugli stessi campi. Sicuro per il
// client: nessun import dal server.

/** Un giorno come lo scrive il modulo: nessuna fascia vuol dire chiuso. */
export type OpeningDayDraft = { weekday: number; bands: { opens: string; closes: string }[] };

const END_AFTER_START = "L'ora di fine deve venire dopo l'inizio.";
const BANDS_OVERLAP = "Le due fasce si sovrappongono.";
const QUARTER_STEP = "Scegli un orario a passi di 15 minuti.";

const QUARTER_TIME = /^([01]\d|2[0-3]):(00|15|30|45)$/;

// "09:30" -> 570; null se non è un quarto d'ora fra 00:00 e 23:45.
function quarterMinutes(time: string): number | null {
  const m = QUARTER_TIME.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Gli errori del modulo per percorso, nell'ordine dei campi: `days.{i}.bands.{j}.opens` e
 * `.closes` per un orario fuori dai quarti d'ora o una fine non dopo l'inizio,
 * `days.{i}.bands.1.opens` per due fasce che si sovrappongono. Nessun errore: `{}`.
 */
export function validateOpeningDays(days: readonly OpeningDayDraft[]): Record<string, string> {
  const errors: Record<string, string> = {};
  days.forEach((day, i) => {
    // Le fasce senza errori, per posizione: solo due fasce valide si confrontano fra loro.
    const valid: ({ startMin: number; endMin: number } | null)[] = day.bands.map((band, j) => {
      const at = `days.${i}.bands.${j}`;
      const opens = quarterMinutes(band.opens);
      const closes = quarterMinutes(band.closes);
      if (opens === null) errors[`${at}.opens`] = QUARTER_STEP;
      if (closes === null) {
        errors[`${at}.closes`] = QUARTER_STEP;
      } else if (opens !== null && closes <= opens) {
        errors[`${at}.closes`] = END_AFTER_START;
      }
      return opens !== null && closes !== null && opens < closes ? { startMin: opens, endMin: closes } : null;
    });
    const [first, second] = valid;
    if (first && second && overlaps(first, second)) errors[`days.${i}.bands.1.opens`] = BANDS_OVERLAP;
  });
  return errors;
}

/** Dopo il salvataggio: quanti appuntamenti futuri restano fuori dai nuovi orari; null con 0. */
export function outsideHoursText(count: number): string | null {
  if (count === 0) return null;
  if (count === 1) return "1 appuntamento futuro cade fuori dai nuovi orari.";
  return `${count} appuntamenti futuri cadono fuori dai nuovi orari.`;
}
