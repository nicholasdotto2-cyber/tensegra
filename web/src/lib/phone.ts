// Telefoni: nel database E.164 senza spazi, a schermo "+39 051 000 0000".
// Sicuro per il client: nessun import dal server.

// La stessa regola dei check del database su ogni colonna `phone`.
const E164 = /^\+[1-9]\d{6,14}$/;
const ITALY = "+39";

/** Il numero scritto in un campo -> E.164, o null se non lo è. Accetta spazi; senza `+` aggiunge +39. */
export function toE164(input: string): string | null {
  const compact = input.replace(/\s+/g, "");
  const withPrefix = compact.startsWith("+") ? compact : `${ITALY}${compact}`;
  return E164.test(withPrefix) ? withPrefix : null;
}

/** "+390510000000" -> "+39 051 000 0000": prefisso, poi gruppi di 3, 3 e il resto. Gli altri prefissi restano come sono. */
export function phoneDisplay(e164: string): string {
  if (!e164.startsWith(ITALY) || !E164.test(e164)) return e164;
  const national = e164.slice(ITALY.length);
  const groups = [national.slice(0, 3), national.slice(3, 6), national.slice(6)].filter(Boolean);
  return [ITALY, ...groups].join(" ");
}
