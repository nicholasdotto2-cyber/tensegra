import type { ActionFailure } from "@/server/actions/result";

import type { RunOptions } from "./save-queue";

// Il salvataggio automatico di un campo di testo dell'editor della visita, senza
// React: `VisitTextField` è un involucro sottile, i test unitari la provano da sola con i timer finti. Un testo si
// salva alla perdita del focus e dopo 800 ms senza battute, solo se è cambiato rispetto all'ultimo valore inviato.
// Finché il campo ha il focus tiene il suo valore: una vista nuova non lo sovrascrive. Dopo un invio una vista più
// vecchia (di un invio precedente ancora in coda) non rimette il testo di prima: si accetta solo la vista che
// porta il valore inviato. Un rifiuto lascia il testo scritto e la sua frase; la battuta dopo la toglie.

/** I millisecondi senza battute dopo cui un testo si salva. */
export const TEXT_SAVE_DELAY_MS = 800;

/** Il testo come lo salva il server: senza spazi ai lati, `null` se resta vuoto. */
export function normalizeText(draft: string): string | null {
  const trimmed = draft.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Cosa mandare per `draft`, dato l'ultimo valore inviato (già normalizzato): `null` se non c'è niente da
 * salvare, altrimenti il valore nuovo (anche `null`, che svuota il campo).
 */
export function textChange(draft: string, lastSent: string | null): { value: string | null } | null {
  const value = normalizeText(draft);
  return value === lastSent ? null : { value };
}

/** La frase sotto il campo dopo un rifiuto: il messaggio del campo, altrimenti quello generale. */
export function refusalText(failure: ActionFailure): string {
  return Object.values(failure.fieldErrors ?? {})[0] ?? failure.message;
}

// Le battute che non sono ancora partite: chi sta per uscire dalla pagina deve saperlo (`UnsavedGuard`). Un solo
// registro per la pagina, perché in una pagina c'è un solo editor.
const typing = new Set<object>();
const listeners = new Set<() => void>();
const markTyping = (owner: object, on: boolean) => {
  if (on === typing.has(owner)) return;
  if (on) typing.add(owner);
  else typing.delete(owner);
  for (const listener of [...listeners]) listener();
};

/**
 * Segna (o toglie) una modifica dell'editor che non è ancora partita e non è un testo: le scelte degli esiti dello
 * screening che aspettano «Conferma lo screening». Lo stesso registro dei testi, così `UnsavedGuard` chiede prima di uscire.
 */
export function markUnsaved(owner: object, on: boolean): void {
  markTyping(owner, on);
}

/** Per `useSyncExternalStore`: c'è un testo scritto che non è ancora partito. */
export function subscribeTyping(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const hasTypingText = (): boolean => typing.size > 0;

export interface TextAutosaveOptions {
  /** Il valore salvato all'inizio. */
  value: string | null;
  /**
   * Invia il valore (già normalizzato). Risponde `false` se non è inviabile (un campo che non si svuota): alla perdita
   * del focus il campo torna al valore salvato. `options.onRefused` va passato alla chiamata in coda.
   */
  send: (value: string | null, options: RunOptions) => boolean | void;
  /** Il testo mostrato è cambiato per decisione del campo (un valore nuovo del server, un ritorno al valore salvato). */
  onDraft: (draft: string) => void;
  /** La frase del rifiuto, o `undefined` quando sparisce. */
  onError: (message: string | undefined) => void;
  /** Dopo un rifiuto, con la frase già impostata: qui si decide se riportare il focus sul campo. */
  onRefused?: () => void;
  delay?: number;
}

export interface TextAutosave {
  /** Una battuta. `incomplete`: il valore non è ancora un valore (una data scritta a metà): non parte niente. */
  input: (draft: string, options?: { incomplete?: boolean }) => void;
  focus: () => void;
  blur: (options?: { incomplete?: boolean }) => void;
  /** Il valore salvato dal server è cambiato. */
  sync: (value: string | null) => void;
  /** Il campo se ne va: una battuta ancora in attesa parte subito. */
  dispose: () => void;
  /** Cambia la funzione che invia (a ogni render ne nasce una nuova, con i valori di quel render). */
  configure: (patch: { send: TextAutosaveOptions["send"] }) => void;
}

export function createTextAutosave(options: TextAutosaveOptions): TextAutosave {
  const delay = options.delay ?? TEXT_SAVE_DELAY_MS;
  const owner = {};
  let send = options.send;
  let saved = options.value;
  let draft = saved ?? "";
  let sent = normalizeText(draft);
  // Un invio che la vista non ha ancora confermato: finché dura, una vista che non lo porta è più vecchia.
  let awaiting = false;
  let focused = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stopTimer = (): boolean => {
    if (timer === null) return false;
    clearTimeout(timer);
    timer = null;
    markTyping(owner, false);
    return true;
  };

  const commit = (): boolean => {
    stopTimer();
    const change = textChange(draft, sent);
    if (change === null) return true;
    const previous = { sent, awaiting };
    sent = change.value;
    awaiting = true;
    const accepted = send(change.value, {
      onRefused: (failure) => {
        awaiting = false;
        options.onError(refusalText(failure));
        options.onRefused?.();
      },
    });
    if (accepted === false) {
      ({ sent, awaiting } = previous);
      return false;
    }
    return true;
  };

  return {
    input(next, { incomplete = false } = {}) {
      draft = next;
      options.onError(undefined);
      stopTimer();
      if (incomplete) return;
      timer = setTimeout(() => {
        timer = null;
        markTyping(owner, false);
        commit();
      }, delay);
      markTyping(owner, true);
    },
    focus() {
      focused = true;
    },
    blur({ incomplete = false } = {}) {
      focused = false;
      if (incomplete) return;
      if (commit()) return;
      draft = saved ?? "";
      sent = normalizeText(draft);
      options.onDraft(draft);
    },
    sync(value) {
      // Una vista che porta il valore già noto non dice niente di nuovo (e non cancella un testo rifiutato).
      if (value === saved) return;
      saved = value;
      const normalized = normalizeText(value ?? "");
      if (awaiting && normalized === sent) awaiting = false;
      if (focused || awaiting) return;
      draft = value ?? "";
      sent = normalized;
      options.onDraft(draft);
    },
    dispose() {
      if (stopTimer()) commit();
    },
    configure(patch) {
      send = patch.send;
    },
  };
}
