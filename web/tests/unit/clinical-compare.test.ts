import { describe, expect, it } from "vitest";
import {
  compareMeasures,
  formatPrevious,
  formatValue,
  measureKey,
  painSeriesText,
  psfsSummary,
  severityChange,
  testsOverTime,
  type Measure,
} from "@/lib/clinical/compare";

function m(extra: Partial<Measure>): Measure {
  return {
    visitId: "v1",
    visitDate: "2026-10-01",
    testCode: "libero",
    customLabel: null,
    customUnit: null,
    side: null,
    valueBool: null,
    valueLateral: null,
    valueNumeric: null,
    valueOrdinal: null,
    ...extra,
  };
}

const num = (testCode: string, valueNumeric: number | null, side: "dx" | "sx" | null = null) =>
  m({ testCode, valueNumeric, side });

describe("compareMeasures", () => {
  it("numerico con meglio alto: l'unità ° attaccata, il segno e il lato in coda", () => {
    expect(compareMeasures(num("flessione_rotazione", 28, "dx"), num("flessione_rotazione", 38, "dx"))).toEqual({
      text: "+10° dx",
      trend: "improved",
    });
  });

  it("numerico con meglio basso: cm dopo uno spazio, il calo migliora", () => {
    expect(compareMeasures(num("dita_pavimento", 28), num("dita_pavimento", 10))).toEqual({
      text: "-18 cm",
      trend: "improved",
    });
  });

  it("numerico con meglio alto che cala peggiora", () => {
    expect(compareMeasures(num("slr", 60, "dx"), num("slr", 50, "dx"))).toEqual({ text: "-10° dx", trend: "worsened" });
  });

  it("differenza 0: invariato", () => {
    expect(compareMeasures(num("dita_pavimento", 18), num("dita_pavimento", 18))).toEqual({
      text: "0 cm",
      trend: "unchanged",
    });
  });

  it("numeri con la virgola e senza zeri inutili", () => {
    expect(compareMeasures(num("dita_pavimento", 10.2), num("dita_pavimento", 10.7))?.text).toBe("+0,5 cm");
    expect(compareMeasures(num("provocazione_si", 4), num("provocazione_si", 2))).toEqual({ text: "-2", trend: "improved" });
  });

  it("laterale: da positivo a negativo migliora, il contrario peggiora", () => {
    const tfe = (valueLateral: Measure["valueLateral"]) => m({ testCode: "flessione_in_piedi", valueLateral });
    expect(compareMeasures(tfe("dx"), tfe("neg"))).toEqual({ text: "Migliorato", trend: "improved" });
    expect(compareMeasures(tfe("neg"), tfe("sx"))).toEqual({ text: "Peggiorato", trend: "worsened" });
    expect(compareMeasures(tfe("neg"), tfe("neg"))).toEqual({ text: "Invariato", trend: "unchanged" });
    expect(compareMeasures(tfe("dx"), tfe("dx"))).toEqual({ text: "Invariato", trend: "unchanged" });
  });

  it("laterale positivo nelle due misure su un lato diverso: i due lati, senza verso", () => {
    const tfe = (valueLateral: Measure["valueLateral"]) => m({ testCode: "flessione_in_piedi", valueLateral });
    expect(compareMeasures(tfe("dx"), tfe("sx"))).toEqual({ text: "dx → sx", trend: null });
    expect(compareMeasures(tfe("dx"), tfe("bil"))).toEqual({ text: "dx → bilaterale", trend: null });
    expect(compareMeasures(tfe("bil"), tfe("dx"))).toEqual({ text: "bilaterale → dx", trend: null });
  });

  it("binario: positivo poi negativo migliora", () => {
    const spurling = (valueBool: boolean) => m({ testCode: "spurling", side: "dx", valueBool });
    expect(compareMeasures(spurling(true), spurling(false))).toEqual({ text: "Migliorato", trend: "improved" });
    expect(compareMeasures(spurling(false), spurling(true))).toEqual({ text: "Peggiorato", trend: "worsened" });
  });

  it("ordinale secondo betterDirection", () => {
    const aslr = (valueOrdinal: number) => m({ testCode: "aslr", valueOrdinal });
    expect(compareMeasures(aslr(3), aslr(1))).toEqual({ text: "-2", trend: "improved" });
    expect(compareMeasures(aslr(1), aslr(3))).toEqual({ text: "+2", trend: "worsened" });
  });

  it("valore mancante: nessun confronto", () => {
    expect(compareMeasures(num("dita_pavimento", 28), num("dita_pavimento", null))).toBeNull();
    expect(compareMeasures(m({ testCode: "flessione_in_piedi", valueLateral: null }), m({ testCode: "flessione_in_piedi", valueLateral: "neg" }))).toBeNull();
  });

  it("test libero numerico: confronto senza direzione, con la sua unità", () => {
    const first = m({ customLabel: "Rotazione Anca", customUnit: "°", side: "dx", valueNumeric: 30 });
    const current = m({ customLabel: "rotazione anca", customUnit: "°", side: "dx", valueNumeric: 40 });
    expect(compareMeasures(first, current)).toEqual({ text: "+10° dx", trend: null });
  });

  it("test libero binario come i binari del catalogo", () => {
    const first = m({ customLabel: "Test X", valueBool: true });
    const current = m({ customLabel: "Test X", valueBool: false });
    expect(compareMeasures(first, current)).toEqual({ text: "Migliorato", trend: "improved" });
  });
});

describe("measureKey e formatValue", () => {
  it("test libero: stessa chiave senza maiuscole né accenti, lato diverso chiave diversa", () => {
    const a = measureKey({ testCode: "libero", customLabel: "Rotazione Anca", side: "dx" });
    expect(measureKey({ testCode: "libero", customLabel: "rotazione anca", side: "dx" })).toBe(a);
    expect(measureKey({ testCode: "libero", customLabel: "Rotazione Ànca", side: "dx" })).toBe(a);
    expect(measureKey({ testCode: "libero", customLabel: "  Rotazione anca ", side: "dx" })).toBe(a);
    expect(measureKey({ testCode: "libero", customLabel: "Rotazione Anca", side: "sx" })).not.toBe(a);
  });

  it("test del catalogo: chiave per codice e lato", () => {
    const dx = measureKey({ testCode: "slr", customLabel: null, side: "dx" });
    expect(measureKey({ testCode: "slr", customLabel: null, side: "sx" })).not.toBe(dx);
    expect(measureKey({ testCode: "slump", customLabel: null, side: "dx" })).not.toBe(dx);
  });

  it("valori scritti", () => {
    expect(formatValue(num("dita_pavimento", 28))).toBe("28 cm");
    expect(formatValue(num("dita_pavimento", 0.5))).toBe("0,5 cm");
    expect(formatValue(num("flessione_rotazione", 38, "dx"))).toBe("38°");
    expect(formatValue(num("provocazione_si", 3))).toBe("3");
    expect(formatValue(m({ testCode: "spurling", side: "dx", valueBool: false }))).toBe("negativo");
    expect(formatValue(m({ testCode: "spurling", side: "dx", valueBool: true }))).toBe("positivo");
    expect(formatValue(m({ testCode: "flessione_in_piedi", valueLateral: "dx" }))).toBe("dx");
    expect(formatValue(m({ testCode: "flessione_in_piedi", valueLateral: "neg" }))).toBe("negativo");
    expect(formatValue(m({ testCode: "flessione_in_piedi", valueLateral: "bil" }))).toBe("bilaterale");
    expect(formatValue(m({ testCode: "aslr", side: "dx", valueOrdinal: 3 }))).toBe("3");
    expect(formatValue(m({ customLabel: "Rotazione anca", customUnit: "°", valueNumeric: 30 }))).toBe("30°");
    expect(formatValue(num("dita_pavimento", null))).toBeNull();
  });
});

describe("testsOverTime", () => {
  const visits = [
    { id: "v1", visitDate: "2026-10-01" },
    { id: "v2", visitDate: "2026-10-08" },
    { id: "v3", visitDate: "2026-10-15" },
  ];
  const at = (visitId: string, measure: Measure): Measure => ({
    ...measure,
    visitId,
    visitDate: visits.find((v) => v.id === visitId)?.visitDate ?? "",
  });

  it("dita-pavimento 28, 18, 10: una riga con i valori, la serie e la variazione dalla prima misura", () => {
    const rows = testsOverTime(visits, [
      at("v1", num("dita_pavimento", 28)),
      at("v2", num("dita_pavimento", 18)),
      at("v3", num("dita_pavimento", 10)),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: "Distanza dita-pavimento",
      region: "lumbar",
      values: ["28 cm", "18 cm", "10 cm"],
      numeric: [28, 18, 10],
    });
    expect(rows[0]?.change?.text).toBe("-18 cm");
    expect(rows[0]?.direction).toBe("down");
  });

  it("la direzione della variazione viene dai valori: su, giù, nessuna per parole, parità o una sola misura", () => {
    const up = testsOverTime(visits, [at("v1", num("flessione_rotazione", 28, "dx")), at("v2", num("flessione_rotazione", 38, "dx"))]);
    expect(up[0]?.direction).toBe("up");
    const flat = testsOverTime(visits, [at("v1", num("dita_pavimento", 20)), at("v2", num("dita_pavimento", 20))]);
    expect(flat[0]?.direction).toBeNull();
    const single = testsOverTime(visits, [at("v1", num("dita_pavimento", 20))]);
    expect(single[0]?.direction).toBeNull();
    const words = testsOverTime(visits, [
      at("v1", m({ testCode: "flessione_in_piedi", valueLateral: "dx" })),
      at("v3", m({ testCode: "flessione_in_piedi", valueLateral: "neg" })),
    ]);
    expect(words[0]?.direction).toBeNull();
  });

  it("i codici dell'esame neurologico non producono righe", () => {
    expect(testsOverTime(visits, [at("v1", m({ testCode: "riflesso_bicipitale", side: "dx", valueOrdinal: 1 }))])).toEqual([]);
  });

  it("una visita senza misura lascia null in quella colonna", () => {
    const rows = testsOverTime(visits, [at("v1", num("dita_pavimento", 28)), at("v3", num("dita_pavimento", 10))]);
    expect(rows[0]?.values).toEqual(["28 cm", null, "10 cm"]);
    expect(rows[0]?.numeric).toEqual([28, null, 10]);
    expect(rows[0]?.change?.text).toBe("-18 cm");
  });

  it("righe per test e lato; etichetta col lato; laterali senza serie numerica", () => {
    const rows = testsOverTime(visits, [
      at("v1", num("flessione_rotazione", 28, "dx")),
      at("v1", num("flessione_rotazione", 40, "sx")),
      at("v2", num("flessione_rotazione", 38, "dx")),
      at("v1", m({ testCode: "flessione_in_piedi", valueLateral: "dx" })),
      at("v3", m({ testCode: "flessione_in_piedi", valueLateral: "neg" })),
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      "TFE (test di flessione eretta)",
      "Flessione-rotazione cervicale (cefalea cervicogenica) dx",
      "Flessione-rotazione cervicale (cefalea cervicogenica) sx",
    ]);
    expect(rows[0]).toMatchObject({ values: ["dx", null, "negativo"], numeric: null, change: { text: "Migliorato" } });
    expect(rows[1]?.change).toEqual({ text: "+10° dx", trend: "improved" });
    expect(rows[2]?.change).toBeNull();
  });

  it("test libero: misure con la stessa etichetta in una riga, regione null", () => {
    const rows = testsOverTime(visits, [
      at("v1", m({ customLabel: "Rotazione Anca", customUnit: "°", side: "dx", valueNumeric: 30 })),
      at("v2", m({ customLabel: "rotazione anca", customUnit: "°", side: "dx", valueNumeric: 40 })),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: "Rotazione Anca dx",
      region: null,
      values: ["30°", "40°", null],
      numeric: [30, 40, null],
      change: { text: "+10° dx", trend: null },
    });
  });
});

describe("severità, PSFS e serie del dolore", () => {
  it("severityChange", () => {
    expect(severityChange(3, 2)).toEqual({ text: "3 → 2", trend: "improved" });
    expect(severityChange(null, 2)).toEqual({ text: "0 → 2", trend: "worsened" });
    expect(severityChange(2, 2)).toEqual({ text: "2 → 2", trend: "unchanged" });
  });

  it("psfsSummary: medie con la virgola e la differenza con il segno", () => {
    expect(
      psfsSummary([
        { initial: 4, final: 8 },
        { initial: 3, final: 7 },
        { initial: 5, final: 9 },
      ]),
    ).toEqual({ initialMean: "4,0", finalMean: "8,0", delta: "+4,0" });
    expect(psfsSummary([{ initial: 4, final: null }, { initial: 5, final: null }])).toEqual({
      initialMean: "4,5",
      finalMean: null,
      delta: null,
    });
    expect(psfsSummary([])).toEqual({ initialMean: null, finalMean: null, delta: null });
  });

  it("painSeriesText", () => {
    expect(painSeriesText([7, 5, null, 3])).toBe("7, 5, non rilevato, 3");
  });
});

describe("formatPrevious (il valore precedente dell'editor)", () => {
  it("come formatValue, ma un test ordinale dice la parola e non l'indice", () => {
    expect(formatPrevious(num("slr", 70, "dx"))).toBe("70°");
    expect(formatPrevious(m({ testCode: "aslr", side: "dx", valueOrdinal: 2 }))).toBe("2 un po' difficile");
    expect(formatValue(m({ testCode: "aslr", side: "dx", valueOrdinal: 2 }))).toBe("2");
    expect(formatPrevious(m({ testCode: "argenta", valueOrdinal: 1 }))).toBe("Tipo II");
    expect(formatPrevious(m({ testCode: "aslr", side: "dx" }))).toBeNull();
  });
});
