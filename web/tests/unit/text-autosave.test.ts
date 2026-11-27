import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTextAutosave,
  hasTypingText,
  markUnsaved,
  normalizeText,
  refusalText,
  subscribeTyping,
  TEXT_SAVE_DELAY_MS,
  textChange,
} from "@/lib/visits/text-autosave";
import type { RunOptions } from "@/lib/visits/save-queue";

// Il salvataggio automatico di un campo di testo: il timer riparte a ogni battuta,
// si salva solo ciò che è cambiato, il campo col focus non segue il server, un invio ancora in attesa non torna al
// testo di una vista più vecchia, una battuta in attesa parte quando il campo se ne va, un rifiuto lascia il testo.
// Timer finti: ogni passo si guarda al millisecondo.

describe("normalizeText e textChange", () => {
  it("toglie gli spazi ai lati e rende null il testo vuoto, come fa il server", () => {
    expect(normalizeText("  mal di schiena ")).toBe("mal di schiena");
    expect(normalizeText("")).toBeNull();
    expect(normalizeText("   \n ")).toBeNull();
  });

  it("non salva quando il testo normalizzato è quello già inviato", () => {
    expect(textChange("dolore", "dolore")).toBeNull();
    expect(textChange("dolore  ", "dolore")).toBeNull();
    expect(textChange("   ", null)).toBeNull();
  });

  it("salva il testo cambiato, già normalizzato, e null quando viene svuotato", () => {
    expect(textChange(" dolore al ginocchio ", "dolore")).toEqual({ value: "dolore al ginocchio" });
    expect(textChange("dolore", null)).toEqual({ value: "dolore" });
    expect(textChange("", "dolore")).toEqual({ value: null });
  });
});

describe("refusalText", () => {
  it("prende il messaggio del campo, altrimenti quello generale", () => {
    expect(refusalText({ ok: false, message: "Valore non valido", fieldErrors: { goal: "Massimo 300 caratteri." } })).toBe(
      "Massimo 300 caratteri.",
    );
    expect(refusalText({ ok: false, message: "Operazione non permessa", fieldErrors: {} })).toBe("Operazione non permessa");
  });
});

/** Un campo di prova: i valori inviati, i testi mostrati, le frasi di errore, i rifiuti da far arrivare a mano. */
function bench(initial: string | null = null, send?: (value: string | null) => boolean | void) {
  const sent: (string | null)[] = [];
  const shown: string[] = [];
  const errors: (string | undefined)[] = [];
  const refusals: (() => void)[] = [];
  let refused = 0;
  const autosave = createTextAutosave({
    value: initial,
    send: (value, options: RunOptions) => {
      sent.push(value);
      refusals.push(() => options.onRefused?.({ ok: false, message: "Valore non valido", refused: true }));
      return send?.(value);
    },
    onDraft: (draft) => shown.push(draft),
    onError: (message) => errors.push(message),
    onRefused: () => {
      refused += 1;
    },
  });
  return { autosave, sent, shown, errors, refusals, refusedCount: () => refused };
}

describe("createTextAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("salva dopo 800 ms senza battute, e il timer riparte a ogni battuta", () => {
    const { autosave, sent } = bench();
    autosave.focus();
    autosave.input("a");
    vi.advanceTimersByTime(TEXT_SAVE_DELAY_MS - 1);
    autosave.input("ab");
    vi.advanceTimersByTime(TEXT_SAVE_DELAY_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["ab"]);
    // Il timer è finito: niente altri invii.
    vi.advanceTimersByTime(5 * TEXT_SAVE_DELAY_MS);
    expect(sent).toEqual(["ab"]);
  });

  it("alla perdita del focus salva subito e non salva una seconda volta quando scade il timer", () => {
    const { autosave, sent } = bench();
    autosave.focus();
    autosave.input("dolore");
    autosave.blur();
    expect(sent).toEqual(["dolore"]);
    vi.advanceTimersByTime(2 * TEXT_SAVE_DELAY_MS);
    expect(sent).toEqual(["dolore"]);
  });

  it("non salva un testo che non è cambiato, nemmeno se lo si scrive e lo si toglie", () => {
    const { autosave, sent } = bench("dolore");
    autosave.focus();
    autosave.input("dolore ");
    autosave.blur();
    autosave.focus();
    autosave.input("dolore e");
    autosave.input("dolore");
    vi.advanceTimersByTime(TEXT_SAVE_DELAY_MS);
    expect(sent).toEqual([]);
  });

  it("col focus nel campo una vista nuova non cambia il testo; senza focus sì", () => {
    const { autosave, shown } = bench("uno");
    autosave.focus();
    autosave.sync("due");
    expect(shown).toEqual([]);
    autosave.blur();
    autosave.sync("tre");
    expect(shown).toEqual(["tre"]);
  });

  it("dopo un invio una vista più vecchia non rimette il testo di prima; quella che lo porta sì", () => {
    const { autosave, sent, shown } = bench("a");
    autosave.focus();
    autosave.input("ab");
    autosave.blur();
    expect(sent).toEqual(["ab"]);
    autosave.sync("a");
    expect(shown).toEqual([]);
    autosave.sync("ab");
    expect(shown).toEqual(["ab"]);
    // Confermato l'invio, un valore diverso del server (un'altra scheda) si segue di nuovo.
    autosave.sync("altro");
    expect(shown).toEqual(["ab", "altro"]);
  });

  it("una battuta ancora in attesa parte quando il campo se ne va, e uno già partito non parte due volte", () => {
    const { autosave, sent } = bench();
    autosave.focus();
    autosave.input("ultima battuta");
    autosave.dispose();
    expect(sent).toEqual(["ultima battuta"]);
    vi.advanceTimersByTime(2 * TEXT_SAVE_DELAY_MS);
    autosave.dispose();
    expect(sent).toEqual(["ultima battuta"]);
  });

  it("un rifiuto lascia il testo scritto, mostra la frase, non riparte alla perdita del focus e sparisce alla battuta dopo", () => {
    const { autosave, sent, errors, refusals, shown, refusedCount } = bench("4");
    autosave.focus();
    autosave.input("21");
    autosave.blur();
    expect(sent).toEqual(["21"]);
    refusals[0]?.();
    expect(errors.at(-1)).toBe("Valore non valido");
    expect(refusedCount()).toBe(1);
    // La vista che torna dal server col valore di prima non cancella il testo scritto: il campo aspettava un invio.
    autosave.sync("4");
    expect(shown).toEqual([]);
    // Perdere di nuovo il focus senza scrivere non rimanda lo stesso valore.
    autosave.focus();
    autosave.blur();
    expect(sent).toEqual(["21"]);
    autosave.focus();
    autosave.input("4");
    expect(errors.at(-1)).toBeUndefined();
    autosave.blur();
    expect(sent).toEqual(["21", "4"]);
  });

  it("un valore non inviabile torna al salvato alla perdita del focus, ma non mentre si scrive", () => {
    const { autosave, sent, shown } = bench("4", () => false);
    autosave.focus();
    autosave.input("");
    vi.advanceTimersByTime(TEXT_SAVE_DELAY_MS);
    expect(sent).toEqual([null]);
    expect(shown).toEqual([]);
    autosave.blur();
    expect(shown).toEqual(["4"]);
  });

  it("una data scritta a metà non parte, né alla scadenza né alla perdita del focus", () => {
    const { autosave, sent } = bench("2026-10-01");
    autosave.focus();
    autosave.input("", { incomplete: true });
    vi.advanceTimersByTime(2 * TEXT_SAVE_DELAY_MS);
    autosave.blur({ incomplete: true });
    expect(sent).toEqual([]);
  });

  it("invia con l'ultima funzione data a `configure`", () => {
    const first: (string | null)[] = [];
    const second: (string | null)[] = [];
    const autosave = createTextAutosave({
      value: null,
      send: (value) => void first.push(value),
      onDraft: () => undefined,
      onError: () => undefined,
    });
    autosave.configure({ send: (value) => void second.push(value) });
    autosave.focus();
    autosave.input("nuovo");
    autosave.blur();
    expect({ first, second }).toEqual({ first: [], second: ["nuovo"] });
  });

  it("registra le battute non ancora partite, per chi sta per lasciare la pagina", () => {
    const calls: boolean[] = [];
    const unsubscribe = subscribeTyping(() => calls.push(hasTypingText()));
    const { autosave } = bench();
    expect(hasTypingText()).toBe(false);
    autosave.focus();
    autosave.input("a");
    expect(hasTypingText()).toBe(true);
    vi.advanceTimersByTime(TEXT_SAVE_DELAY_MS);
    expect(hasTypingText()).toBe(false);
    autosave.input("ab");
    expect(hasTypingText()).toBe(true);
    autosave.blur();
    expect(hasTypingText()).toBe(false);
    unsubscribe();
    expect(calls).toEqual([true, false, true, false]);
  });
});

describe("markUnsaved", () => {
  it("una scelta non ancora confermata conta come un testo non partito, una volta per chi la segna", () => {
    const outcomes = {};
    const seen: boolean[] = [];
    const unsubscribe = subscribeTyping(() => seen.push(hasTypingText()));
    markUnsaved(outcomes, true);
    markUnsaved(outcomes, true);
    expect(hasTypingText()).toBe(true);
    markUnsaved(outcomes, false);
    expect(hasTypingText()).toBe(false);
    unsubscribe();
    expect(seen).toEqual([true, false]);
  });
});
