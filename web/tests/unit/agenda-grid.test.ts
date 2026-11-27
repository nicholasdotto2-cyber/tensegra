import { describe, expect, it } from "vitest";
import {
  blockHeight,
  blockTop,
  closedBands,
  gridWindow,
  layoutColumns,
  PX_PER_HOUR,
  quarterAt,
  visibleWeekdays,
} from "@/lib/agenda/grid";
import { EMPTY_WEEK, type WeekHours } from "@/lib/agenda/slots";
import { weekRangeLabel } from "@/lib/format";
import { parseAgendaParams } from "@/server/domain/appointments/schemas";

// Le regole della griglia dell'agenda: finestra
// verticale, posizioni in pixel dai minuti di Roma, blocchi affiancati, giorni visibili, fasce chiuse,
// etichetta della settimana e stato nell'URL.

const MORNING = { opensMin: 540, closesMin: 780 };
const AFTERNOON = { opensMin: 870, closesMin: 1170 };
const FULL_DAY = [MORNING, AFTERNOON];

/** Gli orari del seed: lun-ven 09:00-13:00 e 14:30-19:30, sab 09:00-13:00, dom chiuso. */
const SEED_WEEK: WeekHours = { 1: FULL_DAY, 2: FULL_DAY, 3: FULL_DAY, 4: FULL_DAY, 5: FULL_DAY, 6: [MORNING], 7: [] };
const MON_SAT = [1, 2, 3, 4, 5, 6];

describe("gridWindow", () => {
  it("dalla prima apertura meno 1 ora all'ultima chiusura più 1 ora: il seed va dalle 08:00 alle 20:30", () => {
    expect(gridWindow(SEED_WEEK, MON_SAT, [])).toEqual({ startMin: 480, endMin: 1230 });
  });

  it("si allarga per un appuntamento fuori dalla finestra", () => {
    expect(gridWindow(SEED_WEEK, MON_SAT, [{ startMin: 420, endMin: 450 }]).startMin).toBe(420);
    // Un blocco dentro la finestra non la cambia.
    expect(gridWindow(SEED_WEEK, MON_SAT, [{ startMin: 600, endMin: 645 }])).toEqual({ startMin: 480, endMin: 1230 });
  });

  it("allargata, parte e finisce su un'ora intera, sempre dentro la giornata", () => {
    expect(gridWindow(SEED_WEEK, MON_SAT, [{ startMin: 435, endMin: 465 }]).startMin).toBe(420);
    expect(gridWindow(SEED_WEEK, MON_SAT, [{ startMin: 1215, endMin: 1260 }]).endMin).toBe(1260);
    expect(gridWindow(SEED_WEEK, MON_SAT, [{ startMin: 30, endMin: 75 }]).startMin).toBe(0);
    expect(gridWindow(SEED_WEEK, MON_SAT, [{ startMin: 1380, endMin: 1425 }]).endMin).toBe(1440);
  });

  it("senza orari va dalle 07:00 alle 21:00", () => {
    expect(gridWindow(EMPTY_WEEK, MON_SAT, [])).toEqual({ startMin: 420, endMin: 1260 });
  });

  it("guarda solo i giorni dati: il sabato del seed va dalle 08:00 alle 14:00, la domenica come senza orari", () => {
    expect(gridWindow(SEED_WEEK, [6], [])).toEqual({ startMin: 480, endMin: 840 });
    expect(gridWindow(SEED_WEEK, [7], [])).toEqual({ startMin: 420, endMin: 1260 });
  });
});

describe("posizioni in pixel", () => {
  it("un'ora è alta 96 px, quindi un quarto d'ora 24 px", () => {
    expect(PX_PER_HOUR).toBe(96);
    expect(blockTop(600, 480)).toBe(192);
    expect(blockHeight(540, 585)).toBe(72);
    expect(blockHeight(540, 570)).toBe(48);
    expect(blockHeight(540, 600)).toBe(96);
    expect(blockHeight(540, 555)).toBe(24);
  });

  it("un clic sulla colonna cade nel quarto d'ora che lo contiene", () => {
    expect(quarterAt(0, 480)).toBe(480);
    expect(quarterAt(23.9, 480)).toBe(480);
    expect(quarterAt(24, 480)).toBe(495);
    expect(quarterAt(192, 480)).toBe(600);
    expect(quarterAt(-5, 480)).toBe(480);
  });
});

describe("layoutColumns", () => {
  it("due blocchi che si sovrappongono stanno affiancati, uno dopo da solo", () => {
    const columns = layoutColumns([
      { id: "a", startMin: 600, endMin: 645 },
      { id: "b", startMin: 615, endMin: 660 },
      { id: "c", startMin: 700, endMin: 730 },
    ]);
    expect(columns.get("a")).toEqual({ column: 0, columns: 2 });
    expect(columns.get("b")).toEqual({ column: 1, columns: 2 });
    expect(columns.get("c")).toEqual({ column: 0, columns: 1 });
  });

  it("intervalli che si toccano non si sovrappongono", () => {
    const columns = layoutColumns([
      { id: "a", startMin: 600, endMin: 630 },
      { id: "b", startMin: 630, endMin: 675 },
    ]);
    expect(columns.get("a")).toEqual({ column: 0, columns: 1 });
    expect(columns.get("b")).toEqual({ column: 0, columns: 1 });
  });

  it("un gruppo collegato tiene il numero di colonne più alto e riusa la colonna libera", () => {
    const columns = layoutColumns([
      { id: "c", startMin: 640, endMin: 700 },
      { id: "a", startMin: 600, endMin: 645 },
      { id: "b", startMin: 615, endMin: 630 },
    ]);
    expect(columns.get("a")).toEqual({ column: 0, columns: 2 });
    expect(columns.get("b")).toEqual({ column: 1, columns: 2 });
    expect(columns.get("c")).toEqual({ column: 1, columns: 2 });
  });
});

describe("visibleWeekdays", () => {
  it("da lunedì a sabato; la domenica solo se è aperta o ha appuntamenti", () => {
    expect(visibleWeekdays(SEED_WEEK, new Set())).toEqual([1, 2, 3, 4, 5, 6]);
    expect(visibleWeekdays(SEED_WEEK, new Set([7]))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(visibleWeekdays({ ...SEED_WEEK, 7: [MORNING] }, new Set())).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("closedBands", () => {
  it("le fasce chiuse del lunedì del seed nella finestra 08:00-20:30", () => {
    expect(closedBands(FULL_DAY, { startMin: 480, endMin: 1230 })).toEqual([
      { startMin: 480, endMin: 540 },
      { startMin: 780, endMin: 870 },
      { startMin: 1170, endMin: 1230 },
    ]);
  });

  it("fasce che si toccano valgono come una sola", () => {
    expect(
      closedBands(
        [
          { opensMin: 540, closesMin: 780 },
          { opensMin: 780, closesMin: 900 },
        ],
        { startMin: 480, endMin: 960 },
      ),
    ).toEqual([
      { startMin: 480, endMin: 540 },
      { startMin: 900, endMin: 960 },
    ]);
  });

  it("un giorno chiuso è chiuso per tutta la finestra; le fasce si tagliano ai bordi", () => {
    expect(closedBands([], { startMin: 420, endMin: 1260 })).toEqual([{ startMin: 420, endMin: 1260 }]);
    expect(closedBands([{ opensMin: 0, closesMin: 600 }], { startMin: 480, endMin: 720 })).toEqual([
      { startMin: 600, endMin: 720 },
    ]);
    expect(closedBands([{ opensMin: 400, closesMin: 1300 }], { startMin: 420, endMin: 1260 })).toEqual([]);
  });
});

describe("weekRangeLabel", () => {
  it("scrive il periodo della settimana", () => {
    expect(weekRangeLabel("2026-10-19", "2026-10-24")).toBe("19-24 ottobre 2026");
    expect(weekRangeLabel("2026-10-26", "2026-10-31")).toBe("26-31 ottobre 2026");
    expect(weekRangeLabel("2026-10-26", "2026-11-01")).toBe("26 ottobre-1 novembre 2026");
    expect(weekRangeLabel("2026-11-30", "2026-12-05")).toBe("30 novembre-5 dicembre 2026");
    expect(weekRangeLabel("2026-12-28", "2027-01-02")).toBe("28 dicembre 2026-2 gennaio 2027");
  });
});

describe("parseAgendaParams", () => {
  const today = "2026-11-04";
  const defaults = { view: "settimana", day: today, showCancelled: false };

  it("senza parametri: la settimana di oggi, annullati nascosti", () => {
    expect(parseAgendaParams({}, today)).toEqual(defaults);
  });

  it("valori non validi si ignorano", () => {
    expect(parseAgendaParams({ vista: "mese", data: "2026-02-30" }, today)).toEqual(defaults);
    expect(parseAgendaParams({ vista: ["giorno", "settimana"], data: ["2026-11-10"], annullati: ["1"] }, today)).toEqual(
      defaults,
    );
    expect(parseAgendaParams({ data: "10/11/2026", annullati: "si" }, today)).toEqual(defaults);
    // Fuori dagli anni dell'agenda (dal 2000 al 2099) la data non vale.
    expect(parseAgendaParams({ data: "1999-12-31" }, today)).toEqual(defaults);
    expect(parseAgendaParams({ data: "2100-01-01" }, today)).toEqual(defaults);
  });

  it("legge vista, data e annullati", () => {
    expect(parseAgendaParams({ vista: "giorno", data: "2026-11-10", annullati: "1" }, today)).toEqual({
      view: "giorno",
      day: "2026-11-10",
      showCancelled: true,
    });
    expect(parseAgendaParams({ vista: "settimana", data: "2028-02-29" }, today)).toEqual({
      view: "settimana",
      day: "2028-02-29",
      showCancelled: false,
    });
  });
});
