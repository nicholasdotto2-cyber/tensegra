import { describe, expect, it } from "vitest";
import type { WeekHours } from "@/lib/agenda/slots";
import { birthDate, placeOnDay, resolveDay, seedHours } from "../../seed/dates";

// Le regole di posizionamento del seed: giorni relativi a D0 con i giorni di apertura,
// file dalle 09:00 nei giorni con la sola mattina, un'ora dopo in caso di conflitto. La settimana è
// quella del seed: lun-ven 09:00-13:00 e 14:30-19:30, sab 09:00-13:00, dom chiuso.

const MORNING = { opensMin: 540, closesMin: 780 };
const AFTERNOON = { opensMin: 870, closesMin: 1170 };
const SEED_WEEK: WeekHours = {
  1: [MORNING, AFTERNOON],
  2: [MORNING, AFTERNOON],
  3: [MORNING, AFTERNOON],
  4: [MORNING, AFTERNOON],
  5: [MORNING, AFTERNOON],
  6: [MORNING],
  7: [],
};

describe("resolveDay", () => {
  it("D0 è il giorno stesso", () => {
    expect(resolveDay(SEED_WEEK, "2026-11-04", { at: "D0" })).toBe("2026-11-04");
  });

  it("P(n) e A(n) contano i giorni aperti", () => {
    expect(resolveDay(SEED_WEEK, "2026-11-04", { at: "P", n: 2 })).toBe("2026-11-02");
    expect(resolveDay(SEED_WEEK, "2026-11-04", { at: "A", n: 10 })).toBe("2026-11-16");
  });

  it("uno scarto in giorni che cade di domenica va al giorno aperto prima", () => {
    // 30/08/2026 è domenica.
    expect(resolveDay(SEED_WEEK, "2026-11-04", { at: "D", days: -66 })).toBe("2026-08-29");
    expect(resolveDay(SEED_WEEK, "2026-11-04", { at: "D", days: -21 })).toBe("2026-10-14");
  });
});

describe("placeOnDay", () => {
  const D0_SLOTS = [
    { key: "marco", time: "09:00", durationMin: 45 },
    { key: "anna", time: "10:00", durationMin: 30 },
    { key: "sofia", time: "11:00", durationMin: 60 },
    { key: "giulia", time: "15:00", durationMin: 45 },
    { key: "francesca", time: "16:00", durationMin: 45 },
  ];

  it("di sabato, in fila dalle 09:00 nello stesso ordine e senza buchi", () => {
    const placed = placeOnDay(SEED_WEEK, "2026-11-07", D0_SLOTS);
    expect([...placed.entries()]).toEqual([
      ["marco", "09:00"],
      ["anna", "09:45"],
      ["sofia", "10:15"],
      ["giulia", "11:15"],
      ["francesca", "12:00"],
    ]);
  });

  it("in un feriale le ore restano quelle della tabella", () => {
    const placed = placeOnDay(SEED_WEEK, "2026-11-04", D0_SLOTS);
    expect(D0_SLOTS.map((s) => placed.get(s.key))).toEqual(["09:00", "10:00", "11:00", "15:00", "16:00"]);
  });

  it("in un feriale due appuntamenti alle 10:00: il secondo va un'ora dopo", () => {
    const placed = placeOnDay(SEED_WEEK, "2026-11-04", [
      { key: "primo", time: "10:00", durationMin: 45 },
      { key: "secondo", time: "10:00", durationMin: 30 },
    ]);
    expect(placed.get("primo")).toBe("10:00");
    expect(placed.get("secondo")).toBe("11:00");
  });

  it("si sposta anche chi si accavalla senza la stessa ora", () => {
    const placed = placeOnDay(SEED_WEEK, "2026-10-23", [
      { key: "prima-visita", time: "09:00", durationMin: 60 },
      { key: "seduta", time: "09:30", durationMin: 45 },
    ]);
    expect(placed.get("seduta")).toBe("10:30");
  });
});

describe("seedHours", () => {
  const bandsOf = (d0: string, weekday: number) => seedHours(d0).days.find((d) => d.weekday === weekday)?.bands;

  it("lun-ven mattina e pomeriggio, sabato mattina, domenica chiusa", () => {
    const hours = seedHours("2026-11-04");
    expect(hours.days.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const weekday of [1, 2, 3, 4, 5]) {
      expect(bandsOf("2026-11-04", weekday)).toEqual([
        { opens: "09:00", closes: "13:00" },
        { opens: "14:30", closes: "19:30" },
      ]);
    }
    expect(bandsOf("2026-11-04", 6)).toEqual([{ opens: "09:00", closes: "13:00" }]);
    expect(bandsOf("2026-11-04", 7)).toEqual([]);
  });

  it("con D0 di domenica apre anche la domenica 09:00-13:00", () => {
    expect(bandsOf("2026-11-08", 7)).toEqual([{ opens: "09:00", closes: "13:00" }]);
    expect(bandsOf("2026-11-08", 6)).toEqual([{ opens: "09:00", closes: "13:00" }]);
  });
});

describe("birthDate", () => {
  it("D0 meno l'età meno lo scarto", () => {
    expect(birthDate("2026-11-04", { months: 4 }, 10)).toBe("2026-06-24");
    expect(birthDate("2026-11-04", { years: 47 }, 240)).toBe("1979-03-09");
  });

  it("un 29 febbraio di D0 diventa il 28 in un anno non bisestile", () => {
    expect(birthDate("2028-02-29", { years: 1 }, 10)).toBe("2027-02-18");
  });

  it.each([9, 301, 1.5])("uno scarto di %j giorni non è fra 10 e 300", (offset) => {
    expect(() => birthDate("2026-11-04", { years: 30 }, offset)).toThrow(RangeError);
  });
});
