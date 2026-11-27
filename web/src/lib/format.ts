import { TZDate, tz } from "@date-fns/tz";
import { differenceInCalendarDays, format } from "date-fns";
import { it } from "date-fns/locale";

// Formati a schermo, uguali in ogni pagina. Sicuro per il client: nessun import dal
// server. Gli istanti si mostrano nell'ora di Roma; i giorni "AAAA-MM-GG" sono
// date di calendario e non passano da un istante.
const TZ = "Europe/Rome";

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINUTES_IN_DAY = 24 * 60;
const ADULT_AGE = 18;

interface Day {
  year: number;
  month: number;
  date: number;
}

// "AAAA-MM-GG" -> anno, mese 1-12, giorno. Un giorno che non esiste (30 febbraio) lancia.
function parseDay(day: string): Day {
  const m = DAY_PATTERN.exec(day);
  if (!m) throw new RangeError("Giorno non valido: serve il formato AAAA-MM-GG.");
  const parsed = { year: Number(m[1]), month: Number(m[2]), date: Number(m[3]) };
  if (format(calendarDate(parsed), "yyyy-MM-dd") !== day) {
    throw new RangeError("Giorno inesistente.");
  }
  return parsed;
}

function calendarDate({ year, month, date }: Day): TZDate {
  return new TZDate(year, month - 1, date, TZ);
}

function formatDay(day: string, pattern: string): string {
  return format(calendarDate(parseDay(day)), pattern, { locale: it });
}

function formatInstant(at: Date, pattern: string): string {
  return format(at, pattern, { in: tz(TZ), locale: it });
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "gio 22 ott", in liste e agenda. */
export function dayShort(day: string): string {
  return formatDay(day, "EEE d MMM");
}

/** "giovedì 22 ottobre 2026", nei titoli. */
export function dayLong(day: string): string {
  return formatDay(day, "EEEE d MMMM yyyy");
}

/** "22/10/2026", in campi e documenti. */
export function dayField(day: string): string {
  return formatDay(day, "dd/MM/yyyy");
}

/** "venerdì 23". */
export function weekdayDay(day: string): string {
  return formatDay(day, "EEEE d");
}

/** "gio 22". */
export function weekdayShortDay(day: string): string {
  return formatDay(day, "EEE d");
}

/** "martedì 3 novembre". */
export function weekdayDayMonth(day: string): string {
  return formatDay(day, "EEEE d MMMM");
}

/** "lunedì 19/10". */
export function weekdayDayNumeric(day: string): string {
  return formatDay(day, "EEEE dd/MM");
}

/** "ottobre 2026". */
export function monthYear(day: string): string {
  return formatDay(day, "MMMM yyyy");
}

/**
 * Il periodo di una settimana dell'agenda: "19-24 ottobre 2026", "30 novembre-5
 * dicembre 2026", "28 dicembre 2026-2 gennaio 2027". Mese e anno si scrivono una volta se sono uguali.
 */
export function weekRangeLabel(from: string, to: string): string {
  const [fromYear, toYear] = [formatDay(from, "yyyy"), formatDay(to, "yyyy")];
  const toPart = formatDay(to, "d MMMM yyyy");
  if (fromYear !== toYear) return `${formatDay(from, "d MMMM yyyy")}-${toPart}`;
  if (formatDay(from, "MM") !== formatDay(to, "MM")) return `${formatDay(from, "d MMMM")}-${toPart}`;
  return `${formatDay(from, "d")}-${toPart}`;
}

/** Il giorno di Roma di un istante, "AAAA-MM-GG". */
export function romeDay(at: Date): string {
  return formatInstant(at, "yyyy-MM-dd");
}

/** L'ora di Roma di un istante, "09:30". */
export function timeOf(at: Date): string {
  return formatInstant(at, "HH:mm");
}

/** "09:00-09:45". */
export function timeRange(start: Date, end: Date): string {
  return `${timeOf(start)}-${timeOf(end)}`;
}

/** Minuti dalle 00:00 -> "09:30"; 1440 è la fine della giornata, "24:00". */
export function minutesLabel(min: number): string {
  if (!Number.isInteger(min) || min < 0 || min > MINUTES_IN_DAY) {
    throw new RangeError("I minuti devono essere un intero da 0 a 1440.");
  }
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/** Valore dell'attributo `datetime` di `<time>`: "2026-10-22T09:00", ora di Roma. */
export function datetimeAttr(at: Date): string {
  return formatInstant(at, "yyyy-MM-dd'T'HH:mm");
}

const EURO = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

/** Centesimi -> "55,00 €" (con lo spazio non separabile prima di €). */
export function money(cents: number): string {
  if (!Number.isInteger(cents)) throw new RangeError("L'importo deve essere in centesimi interi.");
  return EURO.format(cents / 100);
}

/** "45 min", nelle liste. */
export function durationShort(min: number): string {
  return `${min} min`;
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Mesi interi fra due giorni di calendario: il mese si compie quando si arriva allo stesso giorno
// del mese (chi nasce il 29 febbraio compie gli anni il 1 marzo negli anni non bisestili).
function fullMonths(from: Day, to: Day): number {
  const months = (to.year - from.year) * 12 + (to.month - from.month);
  return to.date < from.date ? months - 1 : months;
}

function calendarDaysBetween(from: Day, to: Day): number {
  return differenceInCalendarDays(calendarDate(to), calendarDate(from));
}

function birthAndDay(birthDate: string, onDay: string): [Day, Day] {
  const birth = parseDay(birthDate);
  const day = parseDay(onDay);
  if (calendarDaysBetween(birth, day) < 0) {
    throw new RangeError("La data di nascita viene dopo il giorno.");
  }
  return [birth, day];
}

/** Età a un giorno: sotto i 28 giorni in giorni, sotto i 24 mesi in mesi (almeno 1), poi in anni. */
export function age(birthDate: string, onDay: string): string {
  const [birth, day] = birthAndDay(birthDate, onDay);
  const days = calendarDaysBetween(birth, day);
  if (days < 28) return counted(days, "giorno", "giorni");
  const months = fullMonths(birth, day);
  if (months < 24) return counted(Math.max(1, months), "mese", "mesi");
  return counted(Math.floor(months / 12), "anno", "anni");
}

/** Minore fino al giorno prima del diciottesimo compleanno. */
export function isMinor(birthDate: string, onDay: string): boolean {
  const [birth, day] = birthAndDay(birthDate, onDay);
  return Math.floor(fullMonths(birth, day) / 12) < ADULT_AGE;
}

interface PersonName {
  firstName: string;
  lastName: string;
}

/** "Cognome Nome", nelle liste ordinate per nome. */
export function lastFirst(p: PersonName): string {
  return `${p.lastName} ${p.firstName}`;
}

/** "Nome Cognome", altrove. */
export function firstLast(p: PersonName): string {
  return `${p.firstName} ${p.lastName}`;
}

/** Testo a destra del banner: "Creati oggi alle 08:12" o "Creati lunedì 19/10". */
export function demoSeededText(seededAt: Date, today: string): string {
  const seededDay = romeDay(seededAt);
  if (seededDay === today) return `Creati oggi alle ${timeOf(seededAt)}`;
  return `Creati ${weekdayDayNumeric(seededDay)}`;
}
