import { useCallback, useEffect, useRef, useState } from "react";

import { visitEditorAction } from "@/app/(app)/pazienti/[id]/visite/[visitId]/actions";
import { createSaveQueue, type RunOptions, type SaveQueue, type SaveSnapshot, type SaveState } from "@/lib/visits/save-queue";
import type { ActionResult } from "@/server/actions/result";
import type { VisitEditor } from "@/server/domain/visits/editor";

// Il salvataggio automatico dell'editor della visita: un involucro sottile sulla
// coda di `src/lib/visits/save-queue.ts`, che fa tutto il lavoro e ha i suoi test. Qui la coda nasce una volta per
// editor, lo stato passa a React e, quando la scheda torna in primo piano, l'editor rilegge la visita (un'altra
// scheda può averla cambiata: vince l'ultima scrittura per campo, nessun token).

export type { SaveState };

export interface VisitSave {
  /** Mette in coda una chiamata che risponde con la vista riletta; `onRefused` riceve un rifiuto. */
  run: (call: (id: string) => Promise<ActionResult<VisitEditor>>, options?: RunOptions) => void;
  state: SaveState;
  /** Dopo un guasto rimanda la chiamata fallita, poi le altre. */
  retry: () => void;
  /** Il messaggio dell'ultimo rifiuto, finché un salvataggio non va a buon fine. */
  refusal: string | null;
  /** Una modifica non è ancora salvata (in coda, in corso o ferma dopo un guasto). */
  pending: boolean;
}

export function useVisitSave(visitId: string, onView: (v: VisitEditor) => void): VisitSave {
  const [snapshot, setSnapshot] = useState<SaveSnapshot>({ state: "idle", refusal: null, pending: false });
  const onViewRef = useRef(onView);
  useEffect(() => {
    onViewRef.current = onView;
  });

  // La coda nasce col montaggio (e con un'altra visita, che la pagina monta comunque come un altro editor).
  // Smontato l'editor, una coda che sta ancora salvando finisce il suo giro: la Server Action non si ferma.
  const queueRef = useRef<SaveQueue<VisitEditor> | null>(null);
  useEffect(() => {
    const queue = createSaveQueue<VisitEditor>({
      onView: (view) => onViewRef.current(view),
      onChange: setSnapshot,
      reread: () => visitEditorAction(visitId),
    });
    queueRef.current = queue;
    const onVisibility = () => {
      if (document.visibilityState === "visible") queue.refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [visitId]);

  const run = useCallback<VisitSave["run"]>((call, options) => queueRef.current?.run(call, options), []);
  const retry = useCallback(() => queueRef.current?.retry(), []);

  return { run, state: snapshot.state, retry, refusal: snapshot.refusal, pending: snapshot.pending };
}
