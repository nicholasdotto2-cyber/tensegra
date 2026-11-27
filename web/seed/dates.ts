import { overlaps, type WeekHours } from "@/lib/agenda/slots";
import { minutesLabel } from "@/lib/format";
import { addDaysRome, isoWeekday } from "@/server/clock";
import { bandsOf, openDayAfter, openDayBefore, openOnOrBefore } from "@/server/domain/settings/opening-days";
import type { OpeningHoursInput } from "@/server/domain/settings/schemas";

// Le date del seed, tutte relative a D0 come giorno di calendario più ora di Roma: P(n) e A(n)
// sono l'n-esimo giorno aperto prima e dopo D0, uno scarto in giorni che cade in un giorno chiuso va al
// giorno aperto prima; nei giorni con la sola mattina gli appuntamenti stanno in fila dall'apertura, negli
// altri restano all'ora della tabella e un conflitto li sposta di un'ora. Il fuso non compare qui: ogni
// conto passa da clock.ts.

/** Dove cade un appuntamento rispetto a D0: il giorno stesso, l'n-esimo giorno aperto dopo o prima, uno scarto in giorni. */
export type Offset = { at: "D0" } | { at: "A" | "P"; n: number } | { at: "D"; days: number };

const MINUTE_MS = 60_000;

/** La fine di un appuntamento: l'istante di un fatto, della sua visita chiusa e della chiusura del ciclo. */
export function endOf(a: { startsAt: Date; service: { durationMin: number } }): Date {
  return new Date(a.startsAt.getTime() + a.service.durationMin * MINUTE_MS);
}

export function resolveDay(week: WeekHours, d0: string, offset: Offset): string {
  switch (offset.at) {
    case "D0":
      return d0;
    case "A":
      return openDayAfter(week, d0, offset.n);
    case "P":
      return openDayBefore(week, d0, offset.n);
    case "D":
      return openOnOrBefore(week, addDaysRome(d0, offset.days));
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HOUR_MIN = 60;
const MINUTES_IN_DAY = 24 * 60;

function minutesOf(time: string): number {
  const m = TIME_PATTERN.exec(time);
  if (!m) throw new RangeError("Orario non valido: serve il formato HH:MM.");
  return Number(m[1]) * HOUR_MIN + Number(m[2]);
}

/**
 * Le ore degli appuntamenti di un giorno, per chiave. In un giorno con una sola fascia stanno in fila
 * dall'apertura, nell'ordine delle ore della tabella e senza buchi (D0 di sabato: 09:00, 09:45, 10:15, ...).
 * Negli altri giorni restano all'ora della tabella; uno che si accavalla con uno già messo si sposta di
 * un'ora, finché non ne tocca nessuno. A parità di ora vale l'ordine dato.
 */
export function placeOnDay(
  week: WeekHours,
  day: string,
  slots: readonly { key: string; time: string; durationMin: number }[],
): Map<string, string> {
  // `sort` è stabile: a parità di ora resta l'ordine dato.
  const ordered = [...slots].sort((a, b) => minutesOf(a.time) - minutesOf(b.time));
  const bands = bandsOf(week, day);
  const [onlyBand] = bands;
  const placed = new Map<string, string>();

  if (bands.length === 1 && onlyBand) {
    let next = onlyBand.opensMin;
    for (const slot of ordered) {
      placed.set(slot.key, minutesLabel(next));
      next += slot.durationMin;
    }
    return placed;
  }

  const taken: { startMin: number; endMin: number }[] = [];
  for (const slot of ordered) {
    let startMin = minutesOf(slot.time);
    while (taken.some((span) => overlaps(span, { startMin, endMin: startMin + slot.durationMin }))) {
      startMin += HOUR_MIN;
    }
    if (startMin + slot.durationMin >= MINUTES_IN_DAY) {
      throw new RangeError(`L'appuntamento ${slot.key} del ${day} non sta più nella giornata.`);
    }
    taken.push({ startMin, endMin: startMin + slot.durationMin });
    placed.set(slot.key, minutesLabel(startMin));
  }
  return placed;
}

const MORNING = { opens: "09:00", closes: "13:00" };
const AFTERNOON = { opens: "14:30", closes: "19:30" };
const SUNDAY = 7;

/**
 * Gli orari dello studio: lun-ven 09:00-13:00 e 14:30-19:30, sabato 09:00-13:00, domenica chiuso.
 * Con D0 di domenica apre anche la domenica 09:00-13:00, così Oggi non è vuota.
 */
export function seedHours(d0: string): OpeningHoursInput {
  const sundayOpen = isoWeekday(d0) === SUNDAY;
  return {
    days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
      if (weekday <= 5) return { weekday, bands: [MORNING, AFTERNOON] };
      if (weekday === 6 || sundayOpen) return { weekday, bands: [MORNING] };
      return { weekday, bands: [] };
    }),
  };
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_OFFSET_DAYS = 10;
const MAX_OFFSET_DAYS = 300;

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * La data di nascita: D0 meno l'età meno uno scarto fisso fra 10 e 300 giorni, così a D0 l'età è
 * quella della tabella. L'età in anni o in mesi si toglie sul calendario; un giorno che nel mese di
 * arrivo non c'è (29 febbraio, 31) diventa l'ultimo del mese.
 */
export function birthDate(d0: string, age: { years: number } | { months: number }, offsetDays: number): string {
  if (!Number.isInteger(offsetDays) || offsetDays < MIN_OFFSET_DAYS || offsetDays > MAX_OFFSET_DAYS) {
    throw new RangeError("Lo scarto della data di nascita è un intero fra 10 e 300 giorni.");
  }
  const m = DAY_PATTERN.exec(d0);
  if (!m) throw new RangeError("Giorno non valido: serve il formato AAAA-MM-GG.");
  const months = "years" in age ? age.years * 12 : age.months;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) - months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(Number(m[3]), daysInMonth(year, month));
  return addDaysRome(`${pad(year, 4)}-${pad(month)}-${pad(day)}`, -offsetDays);
}
