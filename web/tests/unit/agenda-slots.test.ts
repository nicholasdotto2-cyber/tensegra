import { describe, expect, it } from "vitest";
import {
  clampToPicker,
  EMPTY_WEEK,
  firstFreeStart,
  floorToQuarter,
  insideOpening,
  OUTSIDE_HOURS,
  overlapWarning,
  overlaps,
  PICKER_FIRST_MIN,
  PICKER_LAST_MIN,
  slotLabel,
  slotState,
  type Band,
  type Busy,
} from "@/lib/agenda/slots";
import { minutesLabel } from "@/lib/format";

// Fasce del seed in un giorno feriale: 09:00-13:00 e 14:30-19:30.
const WEEKDAY: Band[] = [
  { opensMin: 540, closesMin: 780 },
  { opensMin: 870, closesMin: 1170 },
];

const ANNA: Busy = { id: "a", startMin: 600, endMin: 630, label: "Morelli Anna, 10:00-10:30" };

describe("overlaps", () => {
  it("intervalli che si toccano non si sovrappongono", () => {
    expect(overlaps({ startMin: 600, endMin: 630 }, { startMin: 630, endMin: 675 })).toBe(false);
    expect(overlaps({ startMin: 600, endMin: 630 }, { startMin: 615, endMin: 660 })).toBe(true);
  });
});

describe("insideOpening", () => {
  it("l'intervallo intero sta in una sola fascia: attraversare la pausa pranzo è fuori orario", () => {
    expect(insideOpening(WEEKDAY, 750, 810)).toBe(false);
    expect(insideOpening(WEEKDAY, 870, 915)).toBe(true);
  });

  it("fasce che si toccano valgono come una sola", () => {
    expect(
      insideOpening(
        [
          { opensMin: 540, closesMin: 780 },
          { opensMin: 780, closesMin: 900 },
        ],
        750,
        810,
      ),
    ).toBe(true);
  });
});

describe("slotState (parte pura)", () => {
  it("10:15 per 45 minuti si sovrappone a Morelli Anna 10:00-10:30", () => {
    const state = slotState(WEEKDAY, [ANNA], 615, 660);
    expect(state).toEqual({ kind: "sovrapposto", with: "Morelli Anna, 10:00-10:30" });
    expect(slotLabel(state)).toBe("Si sovrappone a Morelli Anna, 10:00-10:30");
    expect(overlapWarning("Morelli Anna, 10:00-10:30")).toBe("Si sovrappone a Morelli Anna, 10:00-10:30.");
  });

  it("10:30 è libero; l'appuntamento stesso non conta", () => {
    const state = slotState(WEEKDAY, [ANNA], 630, 675);
    expect(state).toEqual({ kind: "libero" });
    expect(slotLabel(state)).toBe("Libero");
    expect(slotState(WEEKDAY, [ANNA], 615, 660, "a")).toEqual({ kind: "libero" });
  });

  it("giorno senza fasce e intervallo fuori dalle fasce", () => {
    expect(slotLabel(slotState([], [], 600, 645))).toBe("Giorno chiuso");
    expect(slotLabel(slotState(WEEKDAY, [], 750, 810))).toBe("Fuori orario");
    expect(OUTSIDE_HOURS).toBe("Fuori dagli orari dello studio.");
  });

  it("la sovrapposizione vince anche in un giorno chiuso", () => {
    expect(slotState([], [ANNA], 615, 660)).toEqual({ kind: "sovrapposto", with: "Morelli Anna, 10:00-10:30" });
  });

  it("una settimana senza orari ha tutti i giorni chiusi", () => {
    for (const weekday of [1, 2, 3, 4, 5, 6, 7] as const) {
      expect(EMPTY_WEEK[weekday]).toEqual([]);
    }
  });
});

function busy(id: string, name: string, startMin: number, endMin: number): Busy {
  return { id, startMin, endMin, label: `${name}, ${minutesLabel(startMin)}-${minutesLabel(endMin)}` };
}

describe("firstFreeStart", () => {
  // Il D0 del seed: Marco 09:00-09:45, Anna 10:00-10:30, Sofia 11:00-12:00, Giulia 15:00-15:45,
  // Francesca 16:00-16:45.
  const day: Busy[] = [
    busy("marco", "Bellandi Marco", 540, 585),
    ANNA,
    busy("sofia", "Rinaldi Sofia", 660, 720),
    busy("giulia", "Ferrante Giulia", 900, 945),
    busy("francesca", "Longo Francesca", 960, 1005),
  ];

  it("trova il primo quarto d'ora con [t, t + durata) in una fascia e senza sovrapposizioni", () => {
    expect(firstFreeStart(WEEKDAY, day, 510, 45)).toBe(720);
    expect(firstFreeStart(WEEKDAY, day, 750, 45)).toBe(1005);
    expect(firstFreeStart(WEEKDAY, day, 1140, 45)).toBeNull();
  });

  it("parte dal quarto d'ora successivo", () => {
    expect(firstFreeStart(WEEKDAY, [], 871, 45)).toBe(885);
  });

  it("un giorno chiuso non ha orari liberi", () => {
    expect(firstFreeStart([], [], 540, 45)).toBeNull();
  });
});

describe("floorToQuarter", () => {
  it("porta i minuti dalle 00:00 al quarto d'ora precedente: 08:37 diventa 08:30", () => {
    expect(floorToQuarter(8 * 60 + 37)).toBe(8 * 60 + 30);
    expect(floorToQuarter(8 * 60 + 30)).toBe(8 * 60 + 30);
    expect(floorToQuarter(8 * 60 + 29)).toBe(8 * 60 + 15);
    expect(floorToQuarter(0)).toBe(0);
    expect(floorToQuarter(23 * 60 + 59)).toBe(23 * 60 + 45);
  });
});

describe("clampToPicker", () => {
  it("porta l'ora dentro 07:00-21:00 a passi di 15", () => {
    expect(PICKER_FIRST_MIN).toBe(420);
    expect(PICKER_LAST_MIN).toBe(1260);
    expect(clampToPicker(1395)).toBe(1260);
    expect(clampToPicker(360)).toBe(420);
    expect(clampToPicker(607)).toBe(600);
  });
});
