// Gli importi scritti nei campi ("Prezzo concordato"): si scrive come in Italia, con la
// virgola per i decimali e il punto per le migliaia, ma "80.5" con il punto vale 80,50. Sicuro per il
// client: nessun import dal server. A schermo gli importi si mostrano con `money` di `@/lib/format`.

const CENTS_PER_EURO = 100;

// "1.234,50": il punto separa gruppi di tre cifre, la virgola i decimali.
const WITH_THOUSANDS = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/;
// "55,00" o "55".
const COMMA_DECIMALS = /^(\d+)(?:,(\d{1,2}))?$/;
// "80.5" o "80.50".
const DOT_DECIMALS = /^(\d+)\.(\d{1,2})$/;

/**
 * Il testo di un campo importo in centesimi: "55,00" e "55" -> 5500, "80.5" -> 8050, "1.234,50" ->
 * 123450. Spazi ed euro intorno si ignorano. Null per ciò che non è un importo da zero in su con al
 * più due decimali ("abc", "-1", "1,234").
 */
export function parseEuroCents(text: string): number | null {
  const compact = text.replace(/[\s €]/g, "");
  const match = WITH_THOUSANDS.exec(compact) ?? COMMA_DECIMALS.exec(compact) ?? DOT_DECIMALS.exec(compact);
  if (!match) return null;
  const euros = Number((match[1] ?? "").replaceAll(".", ""));
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const total = euros * CENTS_PER_EURO + cents;
  return Number.isSafeInteger(total) ? total : null;
}

/** Centesimi -> il testo del campo, "55,00": senza punto delle migliaia, così si rilegge uguale. */
export function centsToInput(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError("L'importo deve essere in centesimi interi da zero in su.");
  }
  const euros = Math.floor(cents / CENTS_PER_EURO);
  return `${euros},${String(cents % CENTS_PER_EURO).padStart(2, "0")}`;
}
