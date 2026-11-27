import type { Band, WeekHours } from "@/lib/agenda/slots";
import { addDaysRome, isoWeekday } from "@/server/clock";

// Giorni aperti dello studio: un giorno è aperto se ha almeno una fascia.
// Uno studio senza orari non ha giorni aperti, e si contano i giorni di calendario (D0 + 1).

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** Le fasce del giorno di calendario, dal suo giorno della settimana ISO. */
export function bandsOf(week: WeekHours, day: string): readonly Band[] {
  return week[isoWeekday(day)];
}

function isOpen(week: WeekHours, day: string): boolean {
  return bandsOf(week, day).length > 0;
}

function hasOpenDay(week: WeekHours): boolean {
  return WEEKDAYS.some((weekday) => week[weekday].length > 0);
}

// L'n-esimo giorno aperto dopo (step 1) o prima (step -1) di `day`, escluso `day`.
function nthOpenDay(week: WeekHours, day: string, n: number, step: 1 | -1): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("Il numero di giorni aperti deve essere un intero da 1 in su.");
  if (!hasOpenDay(week)) return addDaysRome(day, step * n);
  let current = day;
  for (let found = 0; found < n; ) {
    current = addDaysRome(current, step);
    if (isOpen(week, current)) found += 1;
  }
  return current;
}

/** L'n-esimo giorno aperto dopo `day` (A(n) del seed); senza orari, `day` + n. */
export function openDayAfter(week: WeekHours, day: string, n: number): string {
  return nthOpenDay(week, day, n, 1);
}

/** L'n-esimo giorno aperto prima di `day` (P(n) del seed); senza orari, `day` - n. */
export function openDayBefore(week: WeekHours, day: string, n: number): string {
  return nthOpenDay(week, day, n, -1);
}

/** `day` se è aperto, altrimenti il giorno aperto prima; senza orari, `day`. */
export function openOnOrBefore(week: WeekHours, day: string): string {
  if (!hasOpenDay(week) || isOpen(week, day)) return day;
  return openDayBefore(week, day, 1);
}
