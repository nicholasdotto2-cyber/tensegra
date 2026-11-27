// Codice fiscale delle persone fisiche: 16 caratteri con il carattere di
// controllo del DM 12/03/1974 e le omocodie, dove le cifre delle posizioni 7, 8, 10, 11, 13, 14 e 15
// (da 1) possono essere scritte con le lettere LMNPQRSTUV (L = 0 ... V = 9). Il carattere di controllo
// si calcola sui caratteri come sono scritti, lettere di omocodia comprese. Il codice serve per
// emettere fattura, non per salvare: qui si controlla solo che sia scritto bene. Sicuro per il client.

const INVALID_TAX_CODE = "Il codice fiscale non è valido: controlla lettere e cifre.";

// Il valore di un carattere in posizione dispari (1, 3, ... 15), per le lettere A-Z; le cifre 0-9
// valgono come le lettere A-J.
const ODD_VALUES = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];

// Cognome e nome (6 lettere), anno (2), mese (1 delle 12 lettere), giorno (2), comune (lettera e 3),
// controllo (1). Ogni cifra può essere una lettera di omocodia.
const DIGIT = "[0-9LMNPQRSTUV]";
const STRUCTURE = new RegExp(`^[A-Z]{6}${DIGIT}{2}[ABCDEHLMPRST]${DIGIT}{2}[A-Z]${DIGIT}{3}[A-Z]$`);
const FIRST_15 = /^[A-Z0-9]{15}$/;

/** Il valore 0-25 di una cifra o di una lettera nella tabella dei caratteri pari. */
function evenValue(char: string): number {
  const code = char.charCodeAt(0);
  return char >= "0" && char <= "9" ? code - 48 : code - 65;
}

/** Il carattere di controllo dei primi 15 caratteri (lettere maiuscole e cifre). */
export function taxCodeCheckChar(first15: string): string {
  if (!FIRST_15.test(first15)) throw new RangeError("Servono 15 lettere maiuscole o cifre.");
  let sum = 0;
  for (let index = 0; index < first15.length; index += 1) {
    const value = evenValue(first15.charAt(index));
    // index 0 è la posizione 1, dispari.
    sum += index % 2 === 0 ? (ODD_VALUES[value] ?? 0) : value;
  }
  return String.fromCharCode(65 + (sum % 26));
}

/** Null se il codice è scritto bene, altrimenti il messaggio per il campo. Vuole maiuscole senza spazi. */
export function taxCodeProblem(code: string): string | null {
  if (!STRUCTURE.test(code)) return INVALID_TAX_CODE;
  return taxCodeCheckChar(code.slice(0, 15)) === code.charAt(15) ? null : INVALID_TAX_CODE;
}

/**
 * Il controllo dei moduli sul testo scritto nel campo: maiuscolo e senza spazi come lo legge lo schema,
 * poi `taxCodeProblem`. Null se il campo è vuoto (il codice serve solo per fatturare) o scritto bene.
 */
export function checkTaxCode(text: string): string | null {
  const code = text.replace(/\s+/g, "").toUpperCase();
  return code === "" ? null : taxCodeProblem(code);
}
