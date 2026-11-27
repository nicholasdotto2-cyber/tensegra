import { describe, expect, it } from "vitest";
import { EMPTY_WEEK, type WeekHours } from "@/lib/agenda/slots";
import { bandsOf, openDayAfter, openDayBefore, openOnOrBefore } from "@/server/domain/settings/opening-days";

// Giorni aperti: la settimana del seed, lun-ven 09:00-13:00 e
// 14:30-19:30, sab 09:00-13:00, dom chiuso. Il 25/10/2026 è la domenica di 25 ore.

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

describe("bandsOf", () => {
  it("le fasce del giorno della settimana", () => {
    expect(bandsOf(SEED_WEEK, "2026-10-22")).toEqual([MORNING, AFTERNOON]);
    expect(bandsOf(SEED_WEEK, "2026-10-24")).toEqual([MORNING]);
    expect(bandsOf(SEED_WEEK, "2026-10-25")).toEqual([]);
  });
});

describe("openDayAfter", () => {
  it("il giorno aperto dopo", () => {
    expect(openDayAfter(SEED_WEEK, "2026-10-22", 1)).toBe("2026-10-23");
    expect(openDayAfter(SEED_WEEK, "2026-10-24", 1)).toBe("2026-10-26");
  });

  it("conta solo i giorni aperti", () => {
    expect(openDayAfter(SEED_WEEK, "2026-10-23", 2)).toBe("2026-10-26");
    expect(openDayAfter(SEED_WEEK, "2026-11-04", 10)).toBe("2026-11-16");
  });

  it("senza orari, i giorni di calendario", () => {
    expect(openDayAfter(EMPTY_WEEK, "2026-10-22", 1)).toBe("2026-10-23");
    expect(openDayAfter(EMPTY_WEEK, "2026-10-24", 2)).toBe("2026-10-26");
  });
});

describe("openDayBefore", () => {
  it("il giorno aperto prima", () => {
    expect(openDayBefore(SEED_WEEK, "2026-10-26", 1)).toBe("2026-10-24");
    expect(openDayBefore(SEED_WEEK, "2026-11-04", 2)).toBe("2026-11-02");
  });

  it("senza orari, i giorni di calendario", () => {
    expect(openDayBefore(EMPTY_WEEK, "2026-10-26", 1)).toBe("2026-10-25");
  });
});

describe("openOnOrBefore", () => {
  it("un giorno chiuso porta al giorno aperto prima", () => {
    expect(openOnOrBefore(SEED_WEEK, "2026-10-25")).toBe("2026-10-24");
  });

  it("un giorno aperto resta lui", () => {
    expect(openOnOrBefore(SEED_WEEK, "2026-10-24")).toBe("2026-10-24");
  });

  it("senza orari resta il giorno", () => {
    expect(openOnOrBefore(EMPTY_WEEK, "2026-10-25")).toBe("2026-10-25");
  });
});

describe("numero di giorni", () => {
  it.each([0, -1, 1.5])("%j non è un numero di giorni aperti", (n) => {
    expect(() => openDayAfter(SEED_WEEK, "2026-10-22", n)).toThrow(RangeError);
    expect(() => openDayBefore(SEED_WEEK, "2026-10-22", n)).toThrow(RangeError);
  });
});
