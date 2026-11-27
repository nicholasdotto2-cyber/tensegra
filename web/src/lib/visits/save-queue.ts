import type { ActionFailure, ActionResult } from "@/server/actions/result";

// La coda del salvataggio automatico dell'editor della visita, senza React:
// `useVisitSave` la avvolge, i test unitari la provano da sola. Ogni chiamata risponde con la vista riletta; le
// chiamate partono una alla volta, in ordine, e ogni risposta buona sostituisce la vista.
//
// - Un guasto (la richiesta non arriva, una risposta 500, un `ok: false` senza `refused`) ferma la coda: la chiamata
//   fallita resta in testa, quelle dopo aspettano dietro, lo stato è `error` e `retry` rimanda proprio quella,
//   poi le altre in ordine.
// - Un rifiuto (`refused`: regola, input non valido, regola del database) non si riprova: la chiamata esce dalla
//   coda, il suo messaggio resta in `refusal` finché un salvataggio non va a buon fine, `onRefused` lo riceve, e se
//   dietro non aspetta un'altra scrittura parte una rilettura silenziosa, così la vista torna quella del server.
// - Una rilettura silenziosa (dopo un rifiuto, o `refresh` quando la scheda torna in primo piano) non mostra
//   «Salvo...» né "Salvato"; se fallisce si lascia cadere, senza fermare niente e senza un'altra rilettura.

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface SaveSnapshot {
  state: SaveState;
  /** Il messaggio dell'ultimo rifiuto, finché un salvataggio non va a buon fine. */
  refusal: string | null;
  /** Una scrittura aspetta in coda, è in corso o è ferma dopo un guasto: uscire adesso la perderebbe. */
  pending: boolean;
}

export type SaveCall<V> = (id: string) => Promise<ActionResult<V>>;

export interface RunOptions {
  onRefused?: (failure: ActionFailure) => void;
  /** Il rifiuto lo mostra chi ha chiamato (il riquadro della rettifica): lo stato non lo ripete. */
  quietRefusal?: boolean;
}

export interface SaveQueueOptions<V> {
  /** La vista nuova di ogni risposta buona. */
  onView: (view: V) => void;
  /** Ogni cambio di stato, rifiuto o attesa. */
  onChange: (snapshot: SaveSnapshot) => void;
  /** La rilettura della vista, senza scritture. */
  reread: () => Promise<ActionResult<V>>;
}

export interface SaveQueue<V> {
  /** Mette in coda una scrittura. */
  run: (call: SaveCall<V>, options?: RunOptions) => void;
  /** Dopo un guasto: rimanda la chiamata fallita, poi le altre. Senza guasto non fa niente. */
  retry: () => void;
  /** Una rilettura silenziosa, solo a coda vuota e non ferma. */
  refresh: () => void;
  snapshot: () => SaveSnapshot;
}

interface Entry<V> {
  call: () => Promise<ActionResult<V>>;
  silent: boolean;
  onRefused?: (failure: ActionFailure) => void;
  quietRefusal?: boolean;
}

/** La risposta di una chiamata, o null se la richiesta non è arrivata (rete, risposta 500). */
async function attempt<V>(call: () => Promise<ActionResult<V>>): Promise<ActionResult<V> | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}

export function createSaveQueue<V>({ onView, onChange, reread }: SaveQueueOptions<V>): SaveQueue<V> {
  const queue: Entry<V>[] = [];
  let running = false;
  let stopped = false;
  let current: SaveSnapshot = { state: "idle", refusal: null, pending: false };

  const publish = (next: Partial<Omit<SaveSnapshot, "pending">>) => {
    const snapshot: SaveSnapshot = {
      state: next.state ?? current.state,
      refusal: next.refusal === undefined ? current.refusal : next.refusal,
      pending: stopped || queue.some((entry) => !entry.silent),
    };
    if (snapshot.state === current.state && snapshot.refusal === current.refusal && snapshot.pending === current.pending) {
      return;
    }
    current = snapshot;
    onChange(snapshot);
  };

  const pump = async () => {
    if (running || stopped) return;
    running = true;
    // L'ultima scrittura di questo giro è andata a buon fine: a coda vuota lo stato è "Salvato".
    let saved = false;
    try {
      for (let entry = queue[0]; entry !== undefined; entry = queue[0]) {
        if (!entry.silent) publish({ state: "saving" });
        const result = await attempt(entry.call);
        if (result?.ok) {
          queue.shift();
          onView(result.data);
          if (!entry.silent) {
            saved = true;
            publish({ refusal: null });
          } else {
            publish({});
          }
        } else if (entry.silent) {
          queue.shift();
          publish({});
        } else if (result !== null && result.refused) {
          queue.shift();
          saved = false;
          entry.onRefused?.(result);
          // La vista torna quella del server; una scrittura che aspetta dietro la riporta comunque.
          if (!queue.some((waiting) => !waiting.silent)) queue.push({ call: reread, silent: true });
          // Nessun «Salvo...» durante la rilettura: la scrittura è finita, con un rifiuto.
          publish({ state: "idle", refusal: entry.quietRefusal ? null : result.message });
        } else {
          stopped = true;
          publish({ state: "error" });
          return;
        }
      }
      if (saved) publish({ state: "saved" });
    } finally {
      running = false;
    }
  };

  return {
    run(call, options) {
      // L'identità nasce all'ingresso in coda: una risposta persa non crea una scrittura nuova.
      const id = crypto.randomUUID();
      queue.push({ call: () => call(id), silent: false, onRefused: options?.onRefused, quietRefusal: options?.quietRefusal });
      publish({});
      void pump();
    },
    retry() {
      if (!stopped) return;
      stopped = false;
      void pump();
    },
    refresh() {
      if (running || stopped || queue.length > 0) return;
      queue.push({ call: reread, silent: true });
      void pump();
    },
    snapshot: () => current,
  };
}
