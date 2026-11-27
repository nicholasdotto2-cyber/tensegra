import { describe, expect, it } from "vitest";
import { type OpeningDayDraft, outsideHoursText, validateOpeningDays } from "@/lib/settings/opening-hours";

// Regole del modulo Orari: le stesse sul client e nel comando.

type Bands = OpeningDayDraft["bands"];

const END_AFTER_START = "L'ora di fine deve venire dopo l'inizio.";
const OVERLAP = "Le due fasce si sovrappongono.";
const QUARTER = "Scegli un orario a passi di 15 minuti.";

/** La settimana con le fasce date per lunedì e martedì, gli altri giorni chiusi. */
function week(monday: Bands, tuesday: Bands = []): OpeningDayDraft[] {
  return [
    { weekday: 1, bands: monday },
    { weekday: 2, bands: tuesday },
    ...[3, 4, 5, 6, 7].map((weekday) => ({ weekday, bands: [] })),
  ];
}

const band = (opens: string, closes: string) => ({ opens, closes });

describe("validateOpeningDays", () => {
  it("la fine prima dell'inizio", () => {
    expect(validateOpeningDays(week([band("09:00", "08:00")]))).toEqual({ "days.0.bands.0.closes": END_AFTER_START });
  });

  it("la fine uguale all'inizio è lo stesso errore", () => {
    expect(validateOpeningDays(week([band("09:00", "09:00")]))).toEqual({ "days.0.bands.0.closes": END_AFTER_START });
  });

  it("due fasce che si sovrappongono", () => {
    expect(validateOpeningDays(week([band("09:00", "13:00"), band("12:00", "15:00")]))).toEqual({
      "days.0.bands.1.opens": OVERLAP,
    });
  });

  it("la sovrapposizione si vede anche con le fasce in ordine inverso", () => {
    expect(validateOpeningDays(week([band("12:00", "15:00"), band("09:00", "13:00")]))).toEqual({
      "days.0.bands.1.opens": OVERLAP,
    });
  });

  it("fasce che si toccano sono ammesse", () => {
    expect(validateOpeningDays(week([band("09:00", "13:00"), band("13:00", "15:00")]))).toEqual({});
  });

  it("gli orari del seed e i giorni chiusi passano", () => {
    expect(validateOpeningDays(week([band("09:00", "13:00"), band("14:30", "19:30")], [band("00:00", "23:45")]))).toEqual(
      {},
    );
  });

  it("un orario fuori dai quarti d'ora", () => {
    expect(validateOpeningDays(week([band("09:10", "13:00")]))).toEqual({ "days.0.bands.0.opens": QUARTER });
  });

  it.each(["24:00", "9:00", "09:5", "", "abc", "23:60"])("%j non è un quarto d'ora fra 00:00 e 23:45", (time) => {
    expect(validateOpeningDays(week([band("09:00", time)]))).toEqual({ "days.0.bands.0.closes": QUARTER });
  });

  it("una fascia con un orario sbagliato non conta per la sovrapposizione", () => {
    expect(validateOpeningDays(week([band("09:10", "13:00"), band("12:00", "15:00")]))).toEqual({
      "days.0.bands.0.opens": QUARTER,
    });
  });

  it("le chiavi seguono la posizione del giorno, gli errori di più giorni restano tutti", () => {
    expect(
      validateOpeningDays(week([band("09:00", "08:00")], [band("09:00", "13:00"), band("12:00", "15:00")])),
    ).toEqual({
      "days.0.bands.0.closes": END_AFTER_START,
      "days.1.bands.1.opens": OVERLAP,
    });
  });
});

describe("outsideHoursText", () => {
  it("il conteggio dei futuri fuori orario", () => {
    expect(outsideHoursText(3)).toBe("3 appuntamenti futuri cadono fuori dai nuovi orari.");
    expect(outsideHoursText(1)).toBe("1 appuntamento futuro cade fuori dai nuovi orari.");
    expect(outsideHoursText(0)).toBeNull();
  });
});
