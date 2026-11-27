import { describe, expect, it } from "vitest";
import {
  age,
  datetimeAttr,
  dayField,
  dayLong,
  dayShort,
  demoSeededText,
  durationShort,
  firstLast,
  isMinor,
  lastFirst,
  minutesLabel,
  money,
  monthYear,
  romeDay,
  timeOf,
  timeRange,
  weekdayDay,
  weekdayDayMonth,
  weekdayDayNumeric,
  weekdayShortDay,
} from "@/lib/format";

describe("format", () => {
  it("scrive i giorni nei formati a schermo", () => {
    expect(dayShort("2026-10-22")).toBe("gio 22 ott");
    expect(dayLong("2026-10-22")).toBe("giovedì 22 ottobre 2026");
    expect(dayField("2026-10-22")).toBe("22/10/2026");
    expect(weekdayDay("2026-10-23")).toBe("venerdì 23");
    expect(weekdayShortDay("2026-10-22")).toBe("gio 22");
    expect(weekdayDayMonth("2026-11-03")).toBe("martedì 3 novembre");
    expect(weekdayDayNumeric("2026-10-19")).toBe("lunedì 19/10");
    expect(monthYear("2026-10-22")).toBe("ottobre 2026");
  });

  it("scrive le ore di Roma, prima e dopo il cambio d'ora", () => {
    expect(timeOf(new Date("2026-10-23T07:00:00Z"))).toBe("09:00");
    expect(timeOf(new Date("2026-10-26T08:00:00Z"))).toBe("09:00");
    expect(timeRange(new Date("2026-10-23T07:00:00Z"), new Date("2026-10-23T07:45:00Z"))).toBe(
      "09:00-09:45",
    );
    expect(minutesLabel(570)).toBe("09:30");
    expect(datetimeAttr(new Date("2026-10-22T07:00:00Z"))).toBe("2026-10-22T09:00");
    expect(romeDay(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  });

  it("scrive importi e durate", () => {
    expect(money(5500)).toBe("55,00 €");
    expect(money(8000)).toBe("80,00 €");
    expect(money(0)).toBe("0,00 €");
    expect(durationShort(45)).toBe("45 min");
  });

  it("scrive l'età in giorni sotto i 28 giorni, in mesi sotto i 24 mesi, poi in anni", () => {
    expect(age("2026-06-12", "2026-10-22")).toBe("4 mesi");
    expect(age("2026-10-10", "2026-10-22")).toBe("12 giorni");
    expect(age("2026-09-24", "2026-10-22")).toBe("1 mese");
    expect(age("2024-11-22", "2026-10-22")).toBe("23 mesi");
    expect(age("2024-10-22", "2026-10-22")).toBe("2 anni");
    expect(age("1979-03-09", "2026-10-22")).toBe("47 anni");
    expect(age("2025-10-22", "2026-10-22")).toBe("12 mesi");
  });

  it("usa il singolare per 1 giorno, il plurale per 0", () => {
    expect(age("2026-10-21", "2026-10-22")).toBe("1 giorno");
    expect(age("2026-10-22", "2026-10-22")).toBe("0 giorni");
  });

  it("riconosce un minore fino al giorno prima dei 18 anni", () => {
    expect(isMinor("2008-10-23", "2026-10-22")).toBe(true);
    expect(isMinor("2008-10-22", "2026-10-22")).toBe(false);
    // nato il 29 febbraio: negli anni non bisestili il compleanno arriva il 1 marzo
    expect(isMinor("2008-02-29", "2026-02-28")).toBe(true);
    expect(isMinor("2008-02-29", "2026-03-01")).toBe(false);
  });

  it("rifiuta giorni non validi e una nascita dopo il giorno", () => {
    expect(() => dayShort("2026-02-30")).toThrow(RangeError);
    expect(() => dayLong("22/10/2026")).toThrow(RangeError);
    expect(() => age("2026-10-23", "2026-10-22")).toThrow(RangeError);
    expect(() => minutesLabel(-15)).toThrow(RangeError);
    expect(() => money(55.5)).toThrow(RangeError);
  });

  it("mette il nome nei due ordini", () => {
    const p = { firstName: "Marco", lastName: "Bellandi" };
    expect(lastFirst(p)).toBe("Bellandi Marco");
    expect(firstLast(p)).toBe("Marco Bellandi");
  });

  it("dice quando sono stati creati i dati di prova", () => {
    expect(demoSeededText(new Date("2026-10-22T06:12:00Z"), "2026-10-22")).toBe(
      "Creati oggi alle 08:12",
    );
    expect(demoSeededText(new Date("2026-10-19T06:12:00Z"), "2026-10-22")).toBe(
      "Creati lunedì 19/10",
    );
  });
});
