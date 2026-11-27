import { describe, expect, it } from "vitest";
import {
  buildCloseCycleInput,
  type CloseFormState,
  type CloseFormView,
  defaultCadence,
  initialCadence,
  mapCloseErrors,
  parseOtherWeeks,
} from "@/lib/cartella/close-cycle-form";
import { REFERRAL_FIRST } from "@/lib/clinical/labels";

// La finestra "Chiudi ciclo": ciò che il modulo manda al comando e gli
// errori che rimanda ai campi. Nessun database né componente.

const CYCLE = "c1";
const ITEM_A = "i1";
const ITEM_B = "i2";

const view = (over: Partial<CloseFormView> = {}): CloseFormView => ({
  cycleId: CYCLE,
  psfs: [{ itemId: ITEM_A }, { itemId: ITEM_B }],
  canScoreFinal: true,
  hasReferral: false,
  ...over,
});

const state = (over: Partial<CloseFormState> = {}): CloseFormState => ({
  outcome: "raggiunto",
  note: "",
  closedOn: "2026-11-04",
  scores: { [ITEM_A]: "4", [ITEM_B]: "7" },
  notReturned: false,
  cadence: "6",
  other: "",
  ...over,
});

function built(v: CloseFormView, s: CloseFormState) {
  const result = buildCloseCycleInput(v, s);
  if (!result.ok) throw new Error(`atteso un input, errori: ${JSON.stringify(result.errors)}`);
  return result.input;
}

function refused(v: CloseFormView, s: CloseFormState) {
  const result = buildCloseCycleInput(v, s);
  if (result.ok) throw new Error("atteso un rifiuto");
  return result.errors;
}

describe("buildCloseCycleInput: punteggi finali", () => {
  it("con attività e una bozza libera manda un punteggio per attività, come numeri", () => {
    expect(built(view(), state()).finalScores).toEqual([
      { itemId: ITEM_A, score: 4 },
      { itemId: ITEM_B, score: 7 },
    ]);
  });

  it("con «Paziente non tornato» manda «non_tornato» e non guarda i punteggi", () => {
    expect(built(view(), state({ notReturned: true, scores: {} })).finalScores).toBe("non_tornato");
  });

  it("senza una bozza su cui scrivere (canScoreFinal falso) manda «non_tornato» anche con punteggi digitati", () => {
    expect(built(view({ canScoreFinal: false }), state()).finalScores).toBe("non_tornato");
  });

  it("senza attività manda un elenco vuoto", () => {
    expect(built(view({ psfs: [] }), state({ scores: {} })).finalScores).toEqual([]);
  });

  it("un punteggio mancante, fuori scala o non intero è rifiutato sul suo campo", () => {
    const errors = refused(view({ psfs: [{ itemId: ITEM_A }, { itemId: ITEM_B }, { itemId: "i3" }] }), state({ scores: { [ITEM_A]: "", [ITEM_B]: "11", i3: "1.5" } }));
    expect(errors).toEqual({
      [`score-${ITEM_A}`]: "Scrivi un punteggio da 0 a 10.",
      [`score-${ITEM_B}`]: "Scrivi un punteggio da 0 a 10.",
      "score-i3": "Scrivi un punteggio da 0 a 10.",
    });
  });

  it("0 e 10 sono punteggi validi", () => {
    expect(built(view(), state({ scores: { [ITEM_A]: "0", [ITEM_B]: "10" } })).finalScores).toEqual([
      { itemId: ITEM_A, score: 0 },
      { itemId: ITEM_B, score: 10 },
    ]);
  });
});

describe("buildCloseCycleInput: richiamo", () => {
  it("una cadenza scelta manda le settimane", () => {
    expect(built(view({ psfs: [] }), state({ cadence: "12" })).recall).toEqual({ weeks: 12 });
  });

  it("«Altra» manda il numero scritto", () => {
    expect(built(view({ psfs: [] }), state({ cadence: "altra", other: " 10 " })).recall).toEqual({ weeks: 10 });
  });

  it("«Nessun richiamo» manda «nessuno»", () => {
    expect(built(view({ psfs: [] }), state({ cadence: "nessuno" })).recall).toBe("nessuno");
  });

  it("«Altra» vuota, fuori da 2-52 o non intera è rifiutata sul campo delle settimane", () => {
    for (const other of ["", "1", "53", "2.5", "abc"]) {
      expect(refused(view({ psfs: [] }), state({ cadence: "altra", other }))).toEqual({
        weeks: "Scrivi un numero di settimane da 2 a 52.",
      });
    }
    expect(built(view({ psfs: [] }), state({ cadence: "altra", other: "2" })).recall).toEqual({ weeks: 2 });
    expect(built(view({ psfs: [] }), state({ cadence: "altra", other: "52" })).recall).toEqual({ weeks: 52 });
  });

  it("parseOtherWeeks: il numero o null", () => {
    expect(parseOtherWeeks("8")).toBe(8);
    expect(parseOtherWeeks("")).toBeNull();
    expect(parseOtherWeeks("1")).toBeNull();
  });

  it("la cadenza di partenza è la proposta: un valore dell'elenco o «Altra» con il numero", () => {
    expect(initialCadence(8)).toEqual({ cadence: "8", other: "" });
    expect(initialCadence(10)).toEqual({ cadence: "altra", other: "10" });
  });

  it("«Rinviato al medico» propone «Nessun richiamo»; ogni altro esito la cadenza di partenza", () => {
    expect(defaultCadence("rinviato_al_medico", "6")).toBe("nessuno");
    expect(defaultCadence("raggiunto", "6")).toBe("6");
    expect(defaultCadence(null, "altra")).toBe("altra");
  });
});

describe("buildCloseCycleInput: esito, nota, data e lettera", () => {
  it("senza esito: errore sull'esito e nessun input", () => {
    expect(refused(view({ psfs: [] }), state({ outcome: null }))).toEqual({ outcome: "Scegli l'esito del ciclo." });
  });

  it("l'input porta ciclo, esito, data scelta e la nota senza spazi ai lati; la nota vuota non c'è", () => {
    const input = built(view({ psfs: [] }), state({ note: "  prova  ", closedOn: "2026-11-02" }));
    expect(input).toMatchObject({ cycleId: CYCLE, outcome: "raggiunto", closedOn: "2026-11-02", outcomeNote: "prova" });
    expect("outcomeNote" in built(view({ psfs: [] }), state({ note: "   " }))).toBe(false);
  });

  it("«Rinviato al medico» senza rinvio è rifiutato prima del server, con la frase sul campo «letter»", () => {
    expect(refused(view({ psfs: [] }), state({ outcome: "rinviato_al_medico", cadence: "nessuno" }))).toEqual({
      letter: REFERRAL_FIRST,
    });
  });

  it("«Rinviato al medico» con il rinvio passa", () => {
    expect(
      built(view({ psfs: [], hasReferral: true }), state({ outcome: "rinviato_al_medico", cadence: "nessuno" })),
    ).toMatchObject({ outcome: "rinviato_al_medico", recall: "nessuno" });
  });

  it("più errori insieme: esito e settimane", () => {
    expect(refused(view({ psfs: [] }), state({ outcome: null, cadence: "altra", other: "" }))).toEqual({
      outcome: "Scegli l'esito del ciclo.",
      weeks: "Scrivi un numero di settimane da 2 a 52.",
    });
  });
});

describe("mapCloseErrors", () => {
  it("i percorsi del comando tornano sui campi della finestra; il primo messaggio di ogni campo vince", () => {
    expect(
      mapCloseErrors({
        outcome: "Per chiudere come rinviato al medico prepara prima la lettera.",
        closedOn: "La chiusura non può essere nel futuro.",
        finalScores: "Scrivi il punteggio finale di ogni attività.",
        "finalScores.0.score": "Valore non valido",
        "recall.weeks": "Valore non valido",
        outcomeNote: "Massimo 1000 caratteri.",
      }),
    ).toEqual({
      outcome: "Per chiudere come rinviato al medico prepara prima la lettera.",
      closedOn: "La chiusura non può essere nel futuro.",
      scores: "Scrivi il punteggio finale di ogni attività.",
      weeks: "Valore non valido",
      outcomeNote: "Massimo 1000 caratteri.",
    });
  });

  it("senza errori di campo è vuoto", () => {
    expect(mapCloseErrors(undefined)).toEqual({});
  });
});
