import { describe, expect, it } from "vitest";
import {
  defaultSeriesCount,
  defaultServiceKind,
  KIND_DEFAULTS,
  KIND_LABEL,
  NEW_CYCLE_LABEL,
  newCycleKind,
} from "@/lib/agenda/defaults";

describe("defaultServiceKind", () => {
  it("prima visita senza appuntamenti fatti, seduta col trattamento aperto, controllo altrimenti", () => {
    expect(defaultServiceKind({ hasDoneAppointment: false, openCycleKind: "trattamento", hasClosedCycle: false })).toBe(
      "prima_visita",
    );
    expect(defaultServiceKind({ hasDoneAppointment: true, openCycleKind: "trattamento", hasClosedCycle: false })).toBe(
      "seduta",
    );
    expect(defaultServiceKind({ hasDoneAppointment: true, openCycleKind: "mantenimento", hasClosedCycle: true })).toBe(
      "controllo",
    );
    expect(defaultServiceKind({ hasDoneAppointment: true, openCycleKind: null, hasClosedCycle: true })).toBe(
      "controllo",
    );
  });
});

describe("ciclo nuovo", () => {
  it("il controllo apre un mantenimento, le altre prestazioni un trattamento", () => {
    expect(newCycleKind("controllo")).toBe("mantenimento");
    expect(newCycleKind("altro")).toBe("trattamento");
    expect(newCycleKind("prima_visita")).toBe("trattamento");
    expect(newCycleKind("seduta")).toBe("trattamento");
    expect(NEW_CYCLE_LABEL).toEqual({
      trattamento: "Apri un nuovo ciclo di trattamento",
      mantenimento: "Apri un ciclo di mantenimento",
    });
  });
});

describe("defaultSeriesCount", () => {
  it("previste meno attive, almeno 2; 4 senza previste", () => {
    expect(defaultSeriesCount(4, 1)).toBe(3);
    expect(defaultSeriesCount(4, 4)).toBe(2);
    expect(defaultSeriesCount(null, 2)).toBe(4);
  });

  it("resta dentro il campo da 2 a 12", () => {
    expect(defaultSeriesCount(20, 1)).toBe(12);
  });
});

describe("prestazioni", () => {
  it("nomi dei tipi e default di una voce nuova", () => {
    expect(KIND_LABEL).toEqual({
      prima_visita: "Prima visita",
      seduta: "Seduta",
      controllo: "Controllo",
      altro: "Altro",
    });
    expect(KIND_DEFAULTS).toEqual({
      prima_visita: { durationMin: 60, color: "ocra" },
      seduta: { durationMin: 45, color: "petrolio" },
      controllo: { durationMin: 30, color: "salvia" },
      altro: { durationMin: 30, color: "ardesia" },
    });
  });
});
