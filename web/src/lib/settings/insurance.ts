import { dayField } from "@/lib/format";

// Avviso della polizza in Iscrizione e polizza: scaduta, o in scadenza entro 30 giorni.
// Sicuro per il client: nessun import dal server. I giorni "AAAA-MM-GG" sono date di calendario,
// quindi la distanza si conta in giorni UTC, che non hanno cambi d'ora.

const WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(day: string): number {
  const m = DAY_PATTERN.exec(day);
  if (!m) throw new RangeError("Giorno non valido: serve il formato AAAA-MM-GG.");
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

/** "La polizza è scaduta il 14/11/2026." dal giorno dopo la scadenza, "La polizza scade il 14/11/2026." nei 30 giorni prima. */
export function insuranceWarning(expiresOn: string | null, today: string): string | null {
  if (expiresOn === null) return null;
  const daysLeft = dayNumber(expiresOn) - dayNumber(today);
  if (daysLeft < 0) return `La polizza è scaduta il ${dayField(expiresOn)}.`;
  if (daysLeft <= WARNING_DAYS) return `La polizza scade il ${dayField(expiresOn)}.`;
  return null;
}
