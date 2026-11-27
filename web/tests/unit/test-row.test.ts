import { describe, expect, it } from "vitest";

import { FREE_TEST, NEURO_TESTS, TESTS, testDefinition } from "@/lib/clinical/catalog";
import {
  changeArrow,
  choiceItems,
  choiceKind,
  choiceOf,
  clearTestOp,
  keptOf,
  matchesSearch,
  NO_VALUE,
  previousFor,
  targetOf,
  testLabel,
  testOp,
  valueOfChoice,
} from "@/lib/visits/test-row";
import { VisitOpInput } from "@/server/domain/visits/schemas";

// Il risultato di un test nella sezione C: ogni scelta diventa
// l'operazione che il comando accetta, con la riga intera.

const def = (code: string) => {
  const found = testDefinition(code);
  if (!found) throw new Error(`test sconosciuto: ${code}`);
  return found;
};

describe("choiceKind", () => {
  it("binario, laterale e ordinale restano pulsanti; la scala intera corta anche; il resto è un campo", () => {
    expect(choiceKind(def("thomas_modificato"))).toBe("binary");
    expect(choiceKind(def("flessione_in_piedi"))).toBe("lateral");
    expect(choiceKind(def("aslr"))).toBe("ordinal");
    expect(choiceKind(def("provocazione_si"))).toBe("scale");
    expect(choiceKind(def("forza_c5"))).toBe("scale");
    expect(choiceKind(def("slr"))).toBe("number");
    expect(choiceKind(def("dita_pavimento"))).toBe("number");
    expect(choiceKind(def("cvai"))).toBe("number");
  });
});

describe("choiceItems, choiceOf e valueOfChoice", () => {
  it("i pulsanti di ogni test del catalogo e dell'esame neurologico portano un valore che il comando accetta", () => {
    for (const test of [...TESTS, ...NEURO_TESTS]) {
      for (const item of choiceItems(test)) {
        const value = valueOfChoice(test, item.value);
        // Ogni voce si rilegge come se stessa.
        expect(choiceOf(test, value), `${test.code} ${item.value}`).toBe(item.value);
        const op = testOp({ testCode: test.code, side: test.perSide ? "dx" : null, customLabel: null, customUnit: null }, value, {
          painProvoked: null,
          note: null,
        });
        const parsed = VisitOpInput.safeParse(op);
        expect(parsed.success, `${test.code} ${item.value}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
      }
    }
  });

  it("le etichette: Negativo e Positivo, la sensibilità Normale e Alterata, le parole dell'ASLR, la forza da 0 a 5", () => {
    expect(choiceItems(def("thomas_modificato")).map((i) => i.label)).toEqual(["Negativo", "Positivo"]);
    expect(choiceItems(def("sensibilita_as")).map((i) => i.label)).toEqual(["Normale", "Alterata"]);
    expect(choiceItems(def("flessione_in_piedi")).map((i) => i.label)).toEqual(["Negativo", "dx", "sx", "bilaterale"]);
    expect(choiceItems(def("aslr"))[2]?.label).toBe("2 un po' difficile");
    expect(choiceItems(def("forza_c5")).map((i) => i.label)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(choiceItems(def("slr"))).toEqual([]);
  });

  it("una riga senza valore non ha una voce scelta", () => {
    expect(choiceOf(def("thomas_modificato"), undefined)).toBeNull();
    expect(choiceOf(def("thomas_modificato"), NO_VALUE)).toBeNull();
    expect(choiceOf(def("aslr"), { ...NO_VALUE, valueOrdinal: 0 })).toBe("0");
  });
});

describe("testOp e clearTestOp", () => {
  const saved = {
    id: "00000000-0000-4000-8000-000000000001",
    testCode: "thomas_modificato",
    side: "dx" as const,
    customLabel: null,
    customUnit: null,
    painProvoked: null,
    note: null,
  };

  it("la riga intera: il valore nuovo con il dolore provocato e la nota già salvati", () => {
    const op = testOp(targetOf(saved), { ...NO_VALUE, valueBool: true }, keptOf({ painProvoked: true, note: "dolore in fondo" }));
    expect(op).toEqual({
      op: "test",
      testCode: "thomas_modificato",
      side: "dx",
      customLabel: null,
      customUnit: null,
      valueBool: true,
      valueLateral: null,
      valueNumeric: null,
      valueOrdinal: null,
      painProvoked: true,
      note: "dolore in fondo",
    });
    expect(VisitOpInput.safeParse(op).success).toBe(true);
  });

  it("il test libero porta il nome e l'unità e un valore numerico", () => {
    const op = testOp(
      { testCode: FREE_TEST, side: "dx", customLabel: "Prova libera", customUnit: "cm" },
      { ...NO_VALUE, valueNumeric: 12 },
      keptOf(undefined),
    );
    expect(VisitOpInput.safeParse(op).success).toBe(true);
  });

  it("togliere il valore toglie la riga se non tiene altro, altrimenti la lascia senza valore", () => {
    expect(clearTestOp(saved)).toEqual({ op: "togli_test", resultId: saved.id });
    const kept = clearTestOp({ ...saved, note: "non eseguibile per dolore" });
    expect(kept).toMatchObject({ op: "test", valueBool: null, note: "non eseguibile per dolore" });
    expect(VisitOpInput.safeParse(kept).success).toBe(true);
    expect(VisitOpInput.safeParse(clearTestOp(saved)).success).toBe(true);
  });
});

describe("testLabel, matchesSearch e changeArrow", () => {
  it("il nome con il lato", () => {
    expect(testLabel("Test di Ober", "dx")).toBe("Test di Ober dx");
    expect(testLabel("Schober modificato", null)).toBe("Schober modificato");
  });

  it("la ricerca ignora maiuscole e accenti e guarda il nome e la regione", () => {
    expect(matchesSearch("lasegue", "Test di Lasègue (sollevamento)", "Arto inferiore")).toBe(true);
    expect(matchesSearch("  ARTO ", "Test di Ober", "Arto inferiore")).toBe(true);
    expect(matchesSearch("spurling", "Test di Ober", "Arto inferiore")).toBe(false);
    expect(matchesSearch("", "Test di Ober")).toBe(true);
  });

  it("la freccia viene dal segno: su per «+10° dx», giù per «-4 cm», niente per le parole", () => {
    expect(changeArrow({ text: "+10° dx" })).toBe("up");
    expect(changeArrow({ text: "-4 cm" })).toBe("down");
    expect(changeArrow({ text: "0" })).toBeNull();
    expect(changeArrow({ text: "Migliorato" })).toBeNull();
    expect(changeArrow({ text: "dx → sx" })).toBeNull();
  });
});

describe("previousFor", () => {
  it("il valore precedente si cerca per test e lato, anche per un test libero senza maiuscole né accenti", () => {
    const previous = { "slr|dx": "70°", "libero|prova libera|dx": "10 cm" };
    expect(previousFor(previous, { testCode: "slr", side: "dx", customLabel: null, customUnit: null })).toBe("70°");
    expect(previousFor(previous, { testCode: "slr", side: "sx", customLabel: null, customUnit: null })).toBeUndefined();
    expect(previousFor(previous, { testCode: "libero", side: "dx", customLabel: " Prova Libera ", customUnit: null })).toBe("10 cm");
  });
});
