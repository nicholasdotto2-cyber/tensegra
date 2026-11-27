import { TZDate, tz } from "@date-fns/tz";
import {
  addDays,
  addMinutes,
  differenceInCalendarDays,
  format,
  getHours,
  getISODay,
  getMinutes,
} from "date-fns";
import { z } from "zod";
import { loadConfig } from "./config";

// Unico punto in cui si ragiona in fuso di Roma: il database resta in UTC.
export const TZ = "Europe/Rome";

export interface Clock {
  now(): Date;
  /** Il giorno di Roma, "AAAA-MM-GG". */
  today(): string;
}

const DAY_FORMAT = "yyyy-MM-dd";
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const instantSchema = z.iso.datetime({ offset: true });

// "AAAA-MM-GG" -> [anno, mese 1-12, giorno]. Un giorno che non esiste (30 febbraio) lancia.
function parseDay(day: string): [year: number, month: number, date: number] {
  const m = DAY_PATTERN.exec(day);
  if (!m) throw new RangeError("Giorno non valido: serve il formato AAAA-MM-GG.");
  const year = Number(m[1]);
  const month = Number(m[2]);
  const date = Number(m[3]);
  if (format(new TZDate(year, month - 1, date, TZ), DAY_FORMAT) !== day) {
    throw new RangeError("Giorno inesistente.");
  }
  return [year, month, date];
}

// Il giorno come data di calendario a Roma (alle 00:00, che esiste in ogni giorno).
function romeCalendarDay(day: string): TZDate {
  const [y, mo, d] = parseDay(day);
  return new TZDate(y, mo - 1, d, TZ);
}

export function todayRome(at: Date): string {
  return format(at, DAY_FORMAT, { in: tz(TZ) });
}

/** L'ora di Roma di un istante, "HH:mm". */
export function romeTime(at: Date): string {
  return format(at, "HH:mm", { in: tz(TZ) });
}

// Giorno di calendario + n giorni: mai "n x 24 ore", che sbaglia nei giorni di cambio ora.
export function addDaysRome(day: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError("Il numero di giorni deve essere intero.");
  const [y, mo, d] = parseDay(day);
  return format(addDays(new TZDate(y, mo - 1, d, TZ), days), DAY_FORMAT);
}

// Orario a muro di Roma ("HH:MM") di un giorno -> istante. Un orario che a Roma
// non esiste (02:30 del passaggio all'ora legale) lancia.
export function romeDateTime(day: string, time: string): Date {
  const [y, mo, d] = parseDay(day);
  const t = TIME_PATTERN.exec(time);
  if (!t) throw new RangeError("Orario non valido: serve il formato HH:MM.");
  const local = new TZDate(y, mo - 1, d, Number(t[1]), Number(t[2]), TZ);
  if (format(local, "HH:mm") !== time || format(local, DAY_FORMAT) !== day) {
    throw new RangeError("Orario inesistente a Roma.");
  }
  return new Date(local.getTime());
}

// Dalle 00:00 di Roma del giorno alle 00:00 del giorno dopo (fine esclusa).
export function romeDayBounds(day: string): { start: Date; end: Date } {
  return {
    start: romeDateTime(day, "00:00"),
    end: romeDateTime(addDaysRome(day, 1), "00:00"),
  };
}

/** Giorno della settimana ISO: 1 = lunedì ... 7 = domenica, come `opening_hours.weekday`. */
export function isoWeekday(day: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  return getISODay(romeCalendarDay(day)) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

/** Giorni di calendario da `from` a `to` (`to - from`): i giorni di 23 o 25 ore contano uno. */
export function daysBetween(from: string, to: string): number {
  return differenceInCalendarDays(romeCalendarDay(to), romeCalendarDay(from));
}

/** Il lunedì della settimana del giorno. */
export function mondayOf(day: string): string {
  return addDaysRome(day, 1 - isoWeekday(day));
}

/** Minuti dalle 00:00 sull'orologio di Roma: la posizione nella griglia, mai una differenza di istanti. */
export function romeMinutes(at: Date): number {
  return getHours(at, { in: tz(TZ) }) * 60 + getMinutes(at, { in: tz(TZ) });
}

// I giorni di una serie: si ripete il giorno di calendario, così con romeDateTime l'ora di Roma
// resta la stessa anche dopo un cambio d'ora.
export function weeklyDays(firstDay: string, intervalWeeks: number, count: number): string[] {
  parseDay(firstDay);
  if (!Number.isInteger(intervalWeeks) || intervalWeeks < 1) {
    throw new RangeError("L'intervallo in settimane deve essere un intero da 1 in su.");
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError("Il numero di giorni deve essere un intero da 0 in su.");
  }
  return Array.from({ length: count }, (_, i) => addDaysRome(firstDay, i * 7 * intervalWeeks));
}

// Vero se `startsAt + durationMin` finisce prima delle 00:00 di Roma del giorno dopo: una fine
// alle 00:00 o dopo è un altro giorno, anche nei giorni di 25 e 23 ore.
export function endsSameRomeDay(startsAt: Date, durationMin: number): boolean {
  if (!Number.isInteger(durationMin) || durationMin < 1) {
    throw new RangeError("La durata deve essere un intero di minuti da 1 in su.");
  }
  const { end: nextMidnight } = romeDayBounds(todayRome(startsAt));
  return addMinutes(startsAt, durationMin).getTime() < nextMidnight.getTime();
}

export function fixedClock(at: Date | string): Clock {
  let instant: number;
  if (typeof at === "string") {
    if (!instantSchema.safeParse(at).success) {
      throw new RangeError("Istante non valido: serve una data ISO con fuso.");
    }
    instant = new Date(at).getTime();
  } else {
    instant = at.getTime();
  }
  if (Number.isNaN(instant)) throw new RangeError("Istante non valido.");
  return {
    now: () => new Date(instant),
    today: () => todayRome(new Date(instant)),
  };
}

// APP_FIXED_NOW (test e demo) se impostata, altrimenti l'ora reale. Si legge a ogni chiamata.
export const systemClock: Clock = {
  now: () => loadConfig().fixedNow ?? new Date(),
  today: () => todayRome(systemClock.now()),
};
