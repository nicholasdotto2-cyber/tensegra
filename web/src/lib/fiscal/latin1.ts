/** Converte la tipografia senza perdere le lettere che richiedono una correzione manuale. */
export function toLatin1(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u20ac/g, "EUR")
    .replace(/\u2026/g, "...")
    .replace(/[\u00a0\u2007\u2009\u202f]/g, " ");
}

export function latin1Offender(text: string): string | null {
  return text.match(/[^\u0020-\u007e\u00a0-\u00ff]/u)?.[0] ?? null;
}

const LOCATIONS = {
  anagrafica: "in anagrafica",
  fattura: "nella fattura",
  impostazioni: "in Impostazioni",
} as const;

export function latin1Message(subject: string, where: "anagrafica" | "fattura" | "impostazioni"): string {
  return `${subject} contiene una lettera che la fattura elettronica non accetta: correggila ${LOCATIONS[where]}`;
}
