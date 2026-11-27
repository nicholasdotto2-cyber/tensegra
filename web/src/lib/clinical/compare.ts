// Confronti nel tempo della cartella: variazione dei test dalla prima misura del ciclo, serie per
// la tabella "Test nel tempo", severità, PSFS e dolore.
// Nessun database, nessun fuso. Sicuro per il client.

import { FREE_TEST, NEURO_TESTS, TESTS, testDefinition, type RegionCode, type TestDefinition } from "./catalog";
import { RESPONSE_LABEL, fold } from "./labels";

export interface Measure {
  visitId: string;
  visitDate: string;
  testCode: string;
  customLabel: string | null;
  customUnit: string | null;
  side: "dx" | "sx" | null;
  valueBool: boolean | null;
  valueLateral: "neg" | "dx" | "sx" | "bil" | null;
  valueNumeric: number | null;
  valueOrdinal: number | null;
}

export type Trend = "improved" | "worsened" | "unchanged";

export interface Change {
  text: string;
  trend: Trend | null;
}

const NEURO_CODES = new Set(NEURO_TESTS.map((t) => t.code));

/** Stesso test e lato; il test libero per etichetta, senza maiuscole né accenti. */
export function measureKey(m: Pick<Measure, "testCode" | "customLabel" | "side">): string {
  const side = m.side ?? "-";
  if (m.testCode === FREE_TEST) return `${FREE_TEST}|${fold((m.customLabel ?? "").trim())}|${side}`;
  return `${m.testCode}|${side}`;
}

// ---------------------------------------------------------------------------------------------------
// Numeri e valori scritti: virgola, niente zeri inutili, `°` attaccato, le altre unità dopo
// uno spazio.

/** I valori arrivano da `numeric(6,2)`: due decimali bastano e tolgono il rumore delle differenze. */
function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

function decimal(n: number): string {
  return String(round2(n)).replace(".", ",");
}

function withUnit(text: string, unit: string | null): string {
  if (!unit) return text;
  return unit === "°" ? `${text}°` : `${text} ${unit}`;
}

function signed(n: number): string {
  const r = round2(n);
  if (r > 0) return `+${decimal(r)}`;
  if (r < 0) return `-${decimal(-r)}`;
  return "0";
}

const LATERAL_TEXT: Record<NonNullable<Measure["valueLateral"]>, string> = {
  neg: "negativo",
  dx: "dx",
  sx: "sx",
  bil: "bilaterale",
};

type Kind = "binary" | "lateral" | "numeric" | "ordinal";

interface Shape {
  kind: Kind;
  unit: string | null;
  better: TestDefinition["betterDirection"];
}

/** Tipo, unità e direzione: dal catalogo, o per il test libero dal valore scritto. */
function shapeOf(m: Measure): Shape | null {
  if (m.testCode === FREE_TEST) {
    if (m.valueNumeric !== null) return { kind: "numeric", unit: m.customUnit, better: "none" };
    if (m.valueBool !== null) return { kind: "binary", unit: null, better: "none" };
    return null;
  }
  const def = testDefinition(m.testCode);
  if (!def) return null;
  return { kind: def.resultType, unit: def.unit, better: def.betterDirection };
}

/** Il valore come lo legge l'osteopata ("28 cm", "38°", "negativo", "dx"); null se manca. */
export function formatValue(m: Measure): string | null {
  const shape = shapeOf(m);
  if (!shape) return null;
  switch (shape.kind) {
    case "binary":
      return m.valueBool === null ? null : m.valueBool ? "positivo" : "negativo";
    case "lateral":
      return m.valueLateral === null ? null : LATERAL_TEXT[m.valueLateral];
    case "numeric":
      return m.valueNumeric === null ? null : withUnit(decimal(m.valueNumeric), shape.unit);
    case "ordinal":
      return m.valueOrdinal === null ? null : decimal(m.valueOrdinal);
  }
}

/** Il valore precedente di un test, come lo legge l'osteopata: per un test ordinale la parola ("2 un po' difficile"), non l'indice. */
export function formatPrevious(m: Measure): string | null {
  const text = formatValue(m);
  if (text === null || m.testCode === FREE_TEST || m.valueOrdinal === null) return text;
  return testDefinition(m.testCode)?.ordinalLabels?.[m.valueOrdinal] ?? text;
}

// ---------------------------------------------------------------------------------------------------
// Confronto fra due misure.

function positive(m: Measure, kind: "binary" | "lateral"): boolean | null {
  if (kind === "binary") return m.valueBool;
  return m.valueLateral === null ? null : m.valueLateral !== "neg";
}

function lateralText(m: Measure): string {
  return m.valueLateral === null ? "" : LATERAL_TEXT[m.valueLateral];
}

function wordChange(before: boolean, after: boolean): Change {
  if (before && !after) return { text: RESPONSE_LABEL.migliorato, trend: "improved" };
  if (!before && after) return { text: RESPONSE_LABEL.peggiorato, trend: "worsened" };
  return { text: RESPONSE_LABEL.invariato, trend: "unchanged" };
}

function numberTrend(diff: number, better: Shape["better"]): Trend | null {
  if (better === "none") return null;
  if (round2(diff) === 0) return "unchanged";
  return (diff > 0) === (better === "higher") ? "improved" : "worsened";
}

/** Variazione da `first` (la prima misura del ciclo per lo stesso test e lato) a `current`. */
export function compareMeasures(first: Measure, current: Measure): Change | null {
  const shape = shapeOf(current) ?? shapeOf(first);
  if (!shape) return null;
  if (shape.kind === "binary" || shape.kind === "lateral") {
    const before = positive(first, shape.kind);
    const after = positive(current, shape.kind);
    if (before === null || after === null) return null;
    // Positivo nelle due misure ma su un lato diverso: il reperto si è spostato, nessun verso.
    if (before && after && shape.kind === "lateral" && first.valueLateral !== current.valueLateral) {
      return { text: `${lateralText(first)} → ${lateralText(current)}`, trend: null };
    }
    return wordChange(before, after);
  }
  const before = shape.kind === "numeric" ? first.valueNumeric : first.valueOrdinal;
  const after = shape.kind === "numeric" ? current.valueNumeric : current.valueOrdinal;
  if (before === null || after === null) return null;
  const diff = after - before;
  const unit = shape.kind === "numeric" ? shape.unit : null;
  const side = current.side ? ` ${current.side}` : "";
  return { text: `${withUnit(signed(diff), unit)}${side}`, trend: numberTrend(diff, shape.better) };
}

/**
 * La variazione di una misura dalla misura di riferimento del ciclo: la prima misura con lo stesso
 * test e lato (`measureKey`) e un valore, nelle visite del ciclo (bozze comprese) nell'ordine dato, cioè
 * per giorno della visita e poi orario dell'appuntamento. Null se la misura non ha un valore o se la prima
 * misura è della visita confrontata. La usano la tabella "Test nel tempo" e l'editor della visita.
 */
export function changeFromFirst(
  visitOrder: readonly string[],
  measures: readonly Measure[],
  current: Measure,
): Change | null {
  if (formatValue(current) === null) return null;
  const position = new Map(visitOrder.map((id, i) => [id, i]));
  const key = measureKey(current);
  const [first] = measures
    .filter((m) => position.has(m.visitId) && measureKey(m) === key && formatValue(m) !== null)
    .sort((a, b) => (position.get(a.visitId) ?? 0) - (position.get(b.visitId) ?? 0));
  if (!first || first.visitId === current.visitId) return null;
  return compareMeasures(first, current);
}

// ---------------------------------------------------------------------------------------------------
// Tabella "Test nel tempo".

export interface TestRow {
  key: string;
  label: string;
  region: RegionCode | null;
  values: (string | null)[];
  numeric: (number | null)[] | null;
  change: Change | null;
  /** Il verso della variazione dai valori (numerici e ordinali): su, giù; null per le parole, la parità o una sola misura. */
  direction: "up" | "down" | null;
}

const TEST_ORDER = new Map(TESTS.map((t, i) => [t.code, i]));
const SIDE_ORDER = { "-": 0, dx: 1, sx: 2 } as const;

/** Su o giù fra due misure numeriche od ordinali; null per le altre o se non cambia. */
function directionOf(first: Measure, last: Measure, kind: Kind | undefined): "up" | "down" | null {
  if (kind !== "numeric" && kind !== "ordinal") return null;
  const before = kind === "numeric" ? first.valueNumeric : first.valueOrdinal;
  const after = kind === "numeric" ? last.valueNumeric : last.valueOrdinal;
  if (before === null || after === null) return null;
  const diff = round2(after - before);
  return diff > 0 ? "up" : diff < 0 ? "down" : null;
}

/**
 * Una riga per test e lato, una colonna per visita nell'ordine dato; i codici dell'esame
 * neurologico non compaiono. Prima i test del catalogo nel loro ordine, poi i test liberi.
 */
export function testsOverTime(
  visits: readonly { id: string; visitDate: string }[],
  measures: readonly Measure[],
): TestRow[] {
  const column = new Map(visits.map((v, i) => [v.id, i]));
  const groups = new Map<string, (Measure | null)[]>();
  for (const m of measures) {
    const col = column.get(m.visitId);
    if (col === undefined || NEURO_CODES.has(m.testCode) || formatValue(m) === null) continue;
    const key = measureKey(m);
    let cells = groups.get(key);
    if (!cells) {
      cells = visits.map(() => null);
      groups.set(key, cells);
    }
    cells[col] = m;
  }

  const rows = [...groups.entries()].map(([key, cells]) => {
    const measured = cells.filter((c): c is Measure => c !== null);
    const first = measured[0] as Measure;
    const last = measured[measured.length - 1] as Measure;
    const shape = shapeOf(first);
    const def = first.testCode === FREE_TEST ? undefined : testDefinition(first.testCode);
    const name = def ? def.name : (first.customLabel ?? "").trim();
    const change = changeFromFirst(
      visits.map((v) => v.id),
      measured,
      last,
    );
    const row: TestRow = {
      key,
      label: first.side ? `${name} ${first.side}` : name,
      region: def ? def.region : null,
      values: cells.map((c) => (c ? formatValue(c) : null)),
      numeric: shape?.kind === "numeric" ? cells.map((c) => c?.valueNumeric ?? null) : null,
      change,
      direction: change === null ? null : directionOf(first, last, shape?.kind),
    };
    const order = def ? (TEST_ORDER.get(def.code) ?? 0) : TESTS.length;
    return { row, order, label: fold(name), side: SIDE_ORDER[first.side ?? "-"] };
  });

  rows.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label) || a.side - b.side);
  return rows.map((r) => r.row);
}

// ---------------------------------------------------------------------------------------------------
// Severità, PSFS e dolore.

/** Severità di una regione fra due visite; una regione senza riga vale 0 (nessuna disfunzione). */
export function severityChange(before: number | null, after: number | null): Change {
  const b = before ?? 0;
  const a = after ?? 0;
  const trend: Trend = a < b ? "improved" : a > b ? "worsened" : "unchanged";
  return { text: `${b} → ${a}`, trend };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function oneDecimal(n: number): string {
  const r = Math.round(n * 10) / 10;
  return (r === 0 ? 0 : r).toFixed(1).replace(".", ",");
}

/** Medie iniziale e finale con una cifra decimale e la differenza con il segno. */
export function psfsSummary(items: readonly { initial: number | null; final: number | null }[]): {
  initialMean: string | null;
  finalMean: string | null;
  delta: string | null;
} {
  const initial = mean(items.flatMap((i) => (i.initial === null ? [] : [i.initial])));
  const final = mean(items.flatMap((i) => (i.final === null ? [] : [i.final])));
  let delta: string | null = null;
  if (initial !== null && final !== null) {
    const d = Math.round((final - initial) * 10) / 10;
    delta = d > 0 ? `+${oneDecimal(d)}` : d < 0 ? `-${oneDecimal(-d)}` : oneDecimal(0);
  }
  return {
    initialMean: initial === null ? null : oneDecimal(initial),
    finalMean: final === null ? null : oneDecimal(final),
    delta,
  };
}

/** "7, 5, non rilevato, 3": il dolore 0-10 delle visite in ordine. */
export function painSeriesText(values: readonly (number | null)[]): string {
  return values.map((v) => (v === null ? "non rilevato" : decimal(v))).join(", ");
}
