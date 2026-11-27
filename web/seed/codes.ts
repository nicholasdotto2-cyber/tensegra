// Codici fiscali del seed: l'algoritmo standard (DM 23/12/1976) con un codice comune
// inventato, X999, che non è di nessun comune né stato estero, così nessun codice coincide con una persona
// reale. Solo lettere senza accenti: "De Luca" vale "DELUCA".

const MONTH_LETTERS = "ABCDEHLMPRST";
const VOWELS = new Set(["A", "E", "I", "O", "U"]);
const FEMALE_DAY_OFFSET = 40;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMUNE_PATTERN = /^[A-Z]\d{3}$/;

// Il valore di un carattere in posizione dispari (1, 3, ... 15); le cifre valgono come le prime dieci lettere.
const ODD_VALUES = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];

/** Le lettere del nome, maiuscole e senza accenti, spazi né apostrofi. */
function lettersOf(name: string): string[] {
  return [
    ...name
      .normalize("NFD")
      // I segni diacritici combinanti che NFD separa dalla lettera: "à" diventa "a" + U+0300.
      .replace(/[̀-ͯ]/g, "")
      .toUpperCase()
      .replace(/[^A-Z]/g, ""),
  ];
}

/** Consonanti, poi vocali, poi X fino a tre caratteri. */
function threeLetters(consonants: string[], vowels: string[]): string {
  return [...consonants, ...vowels, "X", "X", "X"].slice(0, 3).join("");
}

function split(name: string): { consonants: string[]; vowels: string[] } {
  const letters = lettersOf(name);
  return { consonants: letters.filter((c) => !VOWELS.has(c)), vowels: letters.filter((c) => VOWELS.has(c)) };
}

function surnamePart(lastName: string): string {
  const { consonants, vowels } = split(lastName);
  return threeLetters(consonants, vowels);
}

/** Con quattro consonanti o più, la prima, la terza e la quarta. */
function namePart(firstName: string): string {
  const { consonants, vowels } = split(firstName);
  if (consonants.length >= 4) return [consonants[0], consonants[2], consonants[3]].join("");
  return threeLetters(consonants, vowels);
}

/** Il valore 0-25 di una cifra o di una lettera, come nella tabella dei caratteri pari. */
function evenValue(char: string): number {
  const code = char.charCodeAt(0);
  return char >= "0" && char <= "9" ? code - 48 : code - 65;
}

function checkLetter(first15: string): string {
  let sum = 0;
  [...first15].forEach((char, index) => {
    // index 0 è la posizione 1, dispari.
    sum += index % 2 === 0 ? (ODD_VALUES[evenValue(char)] ?? 0) : evenValue(char);
  });
  return String.fromCharCode(65 + (sum % 26));
}

export function taxCode(p: {
  lastName: string;
  firstName: string;
  /** "AAAA-MM-GG". */
  birthDate: string;
  sex: "f" | "m";
  /** Il codice catastale del comune di nascita, per il seed "X999". */
  comune: string;
}): string {
  const date = DAY_PATTERN.exec(p.birthDate);
  if (!date) throw new RangeError("Data di nascita non valida: serve il formato AAAA-MM-GG.");
  if (!COMUNE_PATTERN.test(p.comune)) throw new RangeError("Codice comune non valido: una lettera e tre cifre.");
  const [, year = "", month = "", day = ""] = date;
  const monthLetter = MONTH_LETTERS[Number(month) - 1];
  if (monthLetter === undefined) throw new RangeError("Mese di nascita non valido.");
  const dayNumber = Number(day) + (p.sex === "f" ? FEMALE_DAY_OFFSET : 0);
  const first15 = `${surnamePart(p.lastName)}${namePart(p.firstName)}${year.slice(2)}${monthLetter}${String(dayNumber).padStart(2, "0")}${p.comune}`;
  return `${first15}${checkLetter(first15)}`;
}
