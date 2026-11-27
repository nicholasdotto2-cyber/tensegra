const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(day: string): Date {
  return new Date(Date.UTC(
    Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)),
  ));
}

function formatDay(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(day: string, n: number): string {
  const date = utcDay(day);
  return formatDay(new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + n,
  )));
}

export function daysBetween(from: string, to: string): number {
  return (utcDay(to).getTime() - utcDay(from).getTime()) / DAY_MS;
}

export function isoWeekday(day: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  return (utcDay(day).getUTCDay() || 7) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

/** Algoritmo gregoriano di Meeus. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return formatDay(new Date(Date.UTC(year, month - 1, day)));
}

const FIXED_HOLIDAYS = new Set([
  "01-01", "01-06", "04-25", "05-01", "06-02", "08-15",
  "11-01", "12-08", "12-25", "12-26",
]);

export function isItalianHoliday(day: string): boolean {
  return FIXED_HOLIDAYS.has(day.slice(5))
    || day === addDays(easterSunday(Number(day.slice(0, 4))), 1);
}

export function quarterOf(day: string): 1 | 2 | 3 | 4 {
  return (Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1) as 1 | 2 | 3 | 4;
}

export function monthOf(day: string): string {
  return day.slice(0, 7);
}
