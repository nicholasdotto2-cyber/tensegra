import type { TestDefinition } from "@/lib/clinical/catalog";
import { type Change, measureKey } from "@/lib/clinical/compare";
import { fold } from "@/lib/clinical/labels";
import type { EditorTest } from "@/server/domain/visits/editor";

// Il risultato di un test come lo modifica la sezione C dell'editor della visita,
// senza React: `TestsBlock` e `NeuroExam` la usano, i test unitari la provano da sola. Un test ha
// un valore nel campo del suo tipo (binario, laterale, numerico, ordinale): le scelte fra poche voci diventano
// pulsanti, un numero con molti valori resta un campo. Ogni scrittura porta la riga intera, quindi il dolore provocato
// e la nota già salvati (che questa interfaccia non scrive) ripartono con il valore nuovo.

/** "Test di Ober dx": il nome del test con il lato. */
export const testLabel = (name: string, side: "dx" | "sx" | null): string => (side === null ? name : `${name} ${side}`);

/** Il valore di un risultato: uno solo dei quattro campi, gli altri null. */
export interface TestValue {
  valueBool: boolean | null;
  valueLateral: "neg" | "dx" | "sx" | "bil" | null;
  valueNumeric: number | null;
  valueOrdinal: number | null;
}

export const NO_VALUE: TestValue = { valueBool: null, valueLateral: null, valueNumeric: null, valueOrdinal: null };

/** Quale test e quale lato: il codice, il lato e, per il test libero, il nome e l'unità. */
export interface TestTarget {
  testCode: string;
  side: "dx" | "sx" | null;
  customLabel: string | null;
  customUnit: string | null;
}

export function targetOf(test: Pick<EditorTest, "testCode" | "side" | "customLabel" | "customUnit">): TestTarget {
  return { testCode: test.testCode, side: test.side, customLabel: test.customLabel, customUnit: test.customUnit };
}

/** Il valore precedente di un test e lato (`VisitEditor.previousByKey`), anche senza una riga di oggi. */
export const previousFor = (previousByKey: Readonly<Record<string, string>>, target: TestTarget): string | undefined =>
  previousByKey[measureKey(target)];

/** Quello che la riga salvata tiene e questa interfaccia non scrive. */
export interface KeptFields {
  painProvoked: boolean | null;
  note: string | null;
}

export const keptOf = (saved: Pick<EditorTest, "painProvoked" | "note"> | undefined): KeptFields => ({
  painProvoked: saved?.painProvoked ?? null,
  note: saved?.note ?? null,
});

/** L'operazione `test` con la riga intera. */
export function testOp(target: TestTarget, value: TestValue, kept: KeptFields) {
  return { op: "test" as const, ...target, ...value, ...kept };
}

/**
 * Togliere il valore: una riga con altro (dolore provocato, nota) resta senza valore; una riga solo col valore si
 * toglie (`togli_test`). Senza riga salvata non c'è niente da inviare.
 */
export function clearTestOp(saved: Pick<EditorTest, "id" | "painProvoked" | "note"> & TestTarget) {
  if (saved.painProvoked !== null || saved.note !== null) return testOp(targetOf(saved), NO_VALUE, keptOf(saved));
  return { op: "togli_test" as const, resultId: saved.id };
}

// Le scelte ----------------------------------------------------------------------------------------------------

export type ChoiceKind = "binary" | "lateral" | "ordinal" | "scale" | "number";

type Shape = Pick<TestDefinition, "code" | "resultType" | "min" | "max" | "step" | "ordinalLabels">;

/** Una scala intera corta (forza 0-5, Laslett 0-5) è una scelta fra pulsanti, come il dolore; il resto è un campo. */
const SCALE_MAX_STEPS = 5;

export function choiceKind(def: Shape): ChoiceKind {
  if (def.resultType !== "numeric") return def.resultType;
  const { min, max, step } = def;
  const scale = min !== null && max !== null && step === 1 && Number.isInteger(min) && max - min <= SCALE_MAX_STEPS;
  return scale ? "scale" : "number";
}

/** I test binari che non si leggono «Negativo» e «Positivo»: la sensibilità è normale o alterata. */
const BINARY_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  sensibilita_as: ["Normale", "Alterata"],
  sensibilita_ai: ["Normale", "Alterata"],
};

export interface ChoiceItem {
  value: string;
  label: string;
}

/** I pulsanti di un test che non è un campo; vuoto per il campo numerico. */
export function choiceItems(def: Shape): ChoiceItem[] {
  switch (choiceKind(def)) {
    case "binary": {
      const [negative, positive] = BINARY_LABELS[def.code] ?? ["Negativo", "Positivo"];
      return [
        { value: "neg", label: negative },
        { value: "pos", label: positive },
      ];
    }
    case "lateral":
      return [
        { value: "neg", label: "Negativo" },
        { value: "dx", label: "dx" },
        { value: "sx", label: "sx" },
        { value: "bil", label: "bilaterale" },
      ];
    case "ordinal":
      return (def.ordinalLabels ?? []).map((label, index) => ({ value: String(index), label }));
    case "scale": {
      const min = def.min ?? 0;
      const count = (def.max ?? min) - min + 1;
      return Array.from({ length: count }, (_, i) => ({ value: String(min + i), label: String(min + i) }));
    }
    case "number":
      return [];
  }
}

/** La voce scelta di un risultato salvato; null se non ha valore. */
export function choiceOf(def: Shape, row: TestValue | undefined): string | null {
  if (row === undefined) return null;
  switch (choiceKind(def)) {
    case "binary":
      return row.valueBool === null ? null : row.valueBool ? "pos" : "neg";
    case "lateral":
      return row.valueLateral;
    case "ordinal":
      return row.valueOrdinal === null ? null : String(row.valueOrdinal);
    case "scale":
      return row.valueNumeric === null ? null : String(row.valueNumeric);
    case "number":
      return null;
  }
}

/** Il valore di una voce scelta, nel campo del tipo del test. */
export function valueOfChoice(def: Shape, choice: string): TestValue {
  switch (choiceKind(def)) {
    case "binary":
      return { ...NO_VALUE, valueBool: choice === "pos" };
    case "lateral":
      return { ...NO_VALUE, valueLateral: choice as NonNullable<TestValue["valueLateral"]> };
    case "ordinal":
      return { ...NO_VALUE, valueOrdinal: Number(choice) };
    case "scale":
    case "number":
      return { ...NO_VALUE, valueNumeric: Number(choice) };
  }
}

// Elenco e variazione ------------------------------------------------------------------------------------------

/** La ricerca nell'elenco degli altri test: senza maiuscole né accenti, sul nome e sulla regione. */
export function matchesSearch(query: string, ...texts: readonly string[]): boolean {
  const needle = fold(query.trim());
  return needle === "" || texts.some((text) => fold(text).includes(needle));
}

/**
 * La freccia accanto alla variazione dalla prima misura: dal segno del numero ("+10° dx" sale, "-4 cm" scende); le
 * variazioni a parole ("Migliorato") non hanno un verso.
 */
export function changeArrow(change: Pick<Change, "text">): "up" | "down" | null {
  if (change.text.startsWith("+")) return "up";
  if (change.text.startsWith("-")) return "down";
  return null;
}
