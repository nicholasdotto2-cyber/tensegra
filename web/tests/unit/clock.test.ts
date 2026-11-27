import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TZ,
  addDaysRome,
  daysBetween,
  endsSameRomeDay,
  fixedClock,
  isoWeekday,
  mondayOf,
  romeDateTime,
  romeDayBounds,
  romeMinutes,
  romeTime,
  systemClock,
  todayRome,
  weeklyDays,
} from "@/server/clock";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("clock", () => {
  it("usa il fuso di Roma", () => {
    expect(TZ).toBe("Europe/Rome");
  });

  it("converte un orario di Roma in istante UTC, ora legale compresa", () => {
    expect(romeDateTime("2026-10-23", "09:00").toISOString()).toBe("2026-10-23T07:00:00.000Z");
    // dopo la fine dell'ora legale (domenica 25/10/2026) lo stesso 09:00 vale un'ora in più in UTC
    expect(romeDateTime("2026-10-26", "09:00").toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  it("calcola i limiti del giorno a Roma, anche con 25 o 23 ore", () => {
    expect(romeDayBounds("2026-10-25")).toEqual({
      start: new Date("2026-10-24T22:00:00Z"),
      end: new Date("2026-10-25T23:00:00Z"),
    });
    expect(romeDayBounds("2027-03-28")).toEqual({
      start: new Date("2027-03-27T23:00:00Z"),
      end: new Date("2027-03-28T22:00:00Z"),
    });
  });

  it("todayRome dà il giorno di Roma, non quello UTC", () => {
    expect(todayRome(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
    expect(todayRome(new Date("2026-06-15T21:59:59Z"))).toBe("2026-06-15");
    expect(todayRome(new Date("2026-06-15T22:00:00Z"))).toBe("2026-06-16");
  });

  it("romeTime dà l'ora HH:mm di Roma, ora legale compresa", () => {
    expect(romeTime(new Date("2026-10-22T13:02:00Z"))).toBe("15:02");
    expect(romeTime(new Date("2026-11-04T13:02:00Z"))).toBe("14:02");
    expect(romeTime(new Date("2026-12-31T23:30:00Z"))).toBe("00:30");
  });

  it("somma giorni di calendario a un giorno di Roma", () => {
    expect(addDaysRome("2026-10-23", 3)).toBe("2026-10-26");
    expect(addDaysRome("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDaysRome("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDaysRome("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("rifiuta giorni e orari che a Roma non esistono o non hanno il formato giusto", () => {
    expect(() => romeDateTime("2026-02-30", "09:00")).toThrow(RangeError);
    expect(() => romeDateTime("2026-13-01", "09:00")).toThrow(RangeError);
    expect(() => romeDateTime("2026-10-23", "24:00")).toThrow(RangeError);
    expect(() => romeDateTime("2026-10-23", "9:00")).toThrow(RangeError);
    expect(() => romeDateTime("23/10/2026", "09:00")).toThrow(RangeError);
    // 02:30 del 28/03/2027 salta: alle 02:00 le lancette vanno alle 03:00
    expect(() => romeDateTime("2027-03-28", "02:30")).toThrow(RangeError);
    expect(() => romeDayBounds("domani")).toThrow(RangeError);
    expect(() => addDaysRome("2026-10-23", 1.5)).toThrow(RangeError);
    expect(() => addDaysRome("2026-02-30", 1)).toThrow(RangeError);
  });

  it("fixedClock restituisce sempre lo stesso istante", () => {
    const c = fixedClock("2026-11-04T08:30:00+01:00");
    expect(c.now().toISOString()).toBe("2026-11-04T07:30:00.000Z");
    expect(c.today()).toBe("2026-11-04");
    expect(fixedClock(new Date("2026-12-31T23:30:00Z")).today()).toBe("2027-01-01");
  });

  it("fixedClock rifiuta istanti senza fuso o non validi", () => {
    expect(() => fixedClock("2026-11-04T08:30:00")).toThrow(RangeError);
    expect(() => fixedClock("domani")).toThrow(RangeError);
    expect(() => fixedClock(new Date("non è una data"))).toThrow(RangeError);
  });

  it("fixedClock non cambia se si modifica la data restituita", () => {
    const c = fixedClock("2026-11-04T08:30:00+01:00");
    c.now().setUTCFullYear(1999);
    expect(c.now().toISOString()).toBe("2026-11-04T07:30:00.000Z");
  });

  it("systemClock rispetta APP_FIXED_NOW", () => {
    vi.stubEnv("APP_FIXED_NOW", "2027-01-01T00:30:00+01:00");
    expect(systemClock.now().toISOString()).toBe("2026-12-31T23:30:00.000Z");
    expect(systemClock.today()).toBe("2027-01-01");
  });

  it("isoWeekday conta da lunedì = 1 a domenica = 7, come opening_hours.weekday", () => {
    expect(isoWeekday("2026-10-22")).toBe(4);
    expect(isoWeekday("2026-10-25")).toBe(7);
    expect(isoWeekday("2026-10-26")).toBe(1);
  });

  it("daysBetween conta i giorni di calendario, anche attraverso i cambi d'ora", () => {
    expect(daysBetween("2026-10-12", "2026-10-22")).toBe(10);
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2027-03-27", "2027-03-29")).toBe(2);
    expect(daysBetween("2026-10-22", "2026-10-12")).toBe(-10);
  });

  it("mondayOf dà il lunedì della settimana del giorno", () => {
    expect(mondayOf("2026-10-25")).toBe("2026-10-19");
    expect(mondayOf("2026-10-26")).toBe("2026-10-26");
  });

  it("romeMinutes conta i minuti dalle 00:00 dell'ora di Roma, prima e dopo il cambio d'ora", () => {
    expect(romeMinutes(new Date("2026-10-24T08:00:00Z"))).toBe(600);
    expect(romeMinutes(new Date("2026-10-25T09:00:00Z"))).toBe(600);
  });

  it("weeklyDays ripete il giorno di calendario, quindi l'ora di Roma resta la stessa", () => {
    const at9 = (days: string[]) => days.map((d) => romeDateTime(d, "09:00").toISOString());

    const october = weeklyDays("2026-10-19", 1, 2);
    expect(october).toEqual(["2026-10-19", "2026-10-26"]);
    expect(at9(october)).toEqual(["2026-10-19T07:00:00.000Z", "2026-10-26T08:00:00.000Z"]);

    expect(at9(weeklyDays("2027-03-26", 1, 2))).toEqual([
      "2027-03-26T08:00:00.000Z",
      "2027-04-02T07:00:00.000Z",
    ]);

    expect(weeklyDays("2026-11-04", 2, 3)).toEqual(["2026-11-04", "2026-11-18", "2026-12-02"]);
  });

  it("endsSameRomeDay rifiuta una fine alle 00:00 o dopo, anche nei giorni di 25 e 23 ore", () => {
    expect(endsSameRomeDay(romeDateTime("2026-11-04", "23:15"), 45)).toBe(false);
    expect(endsSameRomeDay(romeDateTime("2026-11-04", "23:00"), 45)).toBe(true);
    expect(endsSameRomeDay(romeDateTime("2026-10-25", "23:15"), 45)).toBe(false);
    expect(endsSameRomeDay(romeDateTime("2026-10-25", "23:00"), 45)).toBe(true);
    expect(endsSameRomeDay(romeDateTime("2027-03-28", "23:00"), 60)).toBe(false);
  });

  it("rifiuta argomenti non validi nei calcoli di calendario", () => {
    expect(() => isoWeekday("2026-02-30")).toThrow(RangeError);
    expect(() => daysBetween("2026-10-22", "domani")).toThrow(RangeError);
    expect(() => mondayOf("22/10/2026")).toThrow(RangeError);
    expect(() => weeklyDays("2026-10-19", 0, 2)).toThrow(RangeError);
    expect(() => weeklyDays("2026-10-19", 1, 1.5)).toThrow(RangeError);
    expect(() => weeklyDays("2026-02-30", 1, 0)).toThrow(RangeError);
    expect(() => endsSameRomeDay(romeDateTime("2026-11-04", "09:00"), 0)).toThrow(RangeError);
  });

  it("systemClock senza APP_FIXED_NOW usa l'ora reale", () => {
    vi.stubEnv("APP_FIXED_NOW", "");
    const before = Date.now();
    const got = systemClock.now().getTime();
    const after = Date.now();
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(after);
  });
});
