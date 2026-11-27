"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { amendVisitAction, editVisitAction, visitEditorAction } from "@/app/(app)/pazienti/[id]/visite/[visitId]/actions";
import { UnsavedGuard } from "@/components/forms/unsaved-guard";
import { Button } from "@/components/ui/button";
import { type AmendOp, amendCount, amendLine, applyAmendOps, mergeAmendOp, toAmendOp } from "@/lib/visits/amend-list";
import type { RunOptions } from "@/lib/visits/save-queue";
import { hasTypingText, refusalText, subscribeTyping } from "@/lib/visits/text-autosave";
import type { ActionResult } from "@/server/actions/result";
import type { VisitEditor } from "@/server/domain/visits/editor";

import { AmendBar, AmendDialog } from "./amend-dialog";
import { useUnsavedDraft } from "./choice-group";
import { CloseActions } from "./close-dialog";
import { CopyButton } from "./copy-button";
import { EditorSection } from "./editor-section";
import { RightColumn } from "./right-column";
import { SectionA } from "./section-a";
import { SectionB } from "./section-b";
import { SectionC } from "./section-c";
import { SectionD } from "./section-d";
import { SectionE, type VisitBooking } from "./section-e";
import { TopBar } from "./top-bar";
import { useVisitSave } from "./use-visit-save";

// L'editor della visita: la barra in alto, le cinque sezioni
// richiudibili nella colonna principale e la colonna destra fissa. La vista arriva dalla pagina e poi vive qui: ogni
// modifica passa dalla coda di `useVisitSave` e la risposta la sostituisce. Tre modi:
// - bozza: ogni operazione parte subito in coda; nella barra la copia e la chiusura;
// - lettura (visita chiusa): niente si cambia; nella barra «Rettifica», che chiede il motivo;
// - rettifica: le operazioni delle sezioni vanno in una lista nel client (`src/lib/visits/amend-list.ts`: la stessa riga
//   riscritta sostituisce la sua operazione, ogni altra sovrapposizione si rifiuta sotto il controllo con `onRefused`),
//   la vista la mostra (`applyAmendOps`), il riquadro della rettifica la elenca con «Togli» per riga, e «Salva la
//   rettifica» la manda tutta con il motivo (`amendVisitAction`). Un rifiuto resta nel riquadro e la lista pure; dopo
//   un guasto di rete «Riprova» (o di nuovo «Salva la rettifica») rimanda lo stesso contenuto con lo stesso id.
//   Salvata o annullata la rettifica, o tolta una riga dall'elenco, le sezioni ripartono dalla vista.
// Finché una modifica non è salvata (in coda, in corso, ferma dopo un guasto, o nella lista della rettifica) uscire
// dalla pagina chiede conferma (nessun dato perso se si cambia pagina).

/** Cosa dice il dialogo di uscita: l'editor salva a ogni campo, quindi si perde solo l'ultima modifica. */
const UNSAVED_TEXT = "L'ultima modifica non è ancora salvata.";
/** In rettifica si perde tutta la lista con il motivo, non solo l'ultima modifica. */
const AMEND_UNSAVED_TEXT = "La rettifica non è ancora salvata: le modifiche andranno perse.";
const AMENDED = "Rettifica salvata.";

/** Le props di ogni sezione dell'editor e della colonna destra. */
export interface VisitSectionProps {
  editor: VisitEditor;
  mode: "bozza" | "rettifica" | "lettura";
  /**
   * Un'operazione sulla visita (`VisitOp`): in bozza parte subito in coda, in rettifica va nella lista della
   * rettifica, in lettura non fa niente. Un rifiuto (regola, valore non valido) arriva a `onRefused`, per mostrarlo
   * sotto il campo e tornare al valore del server.
   */
  op: (op: unknown, options?: RunOptions) => void;
  /** Una chiamata qualsiasi che risponde con la vista riletta, in coda come le altre. */
  run: (call: (id: string) => Promise<ActionResult<VisitEditor>>, options?: RunOptions) => void;
}

/** Una rettifica aperta: il motivo, la lista delle operazioni, l'invio in corso e la frase dell'ultimo rifiuto. */
interface Amendment {
  reason: string;
  ops: AmendOp[];
  saving: boolean;
  error: string | null;
}

export function VisitEditorView({ initial, booking }: { initial: VisitEditor; booking: VisitBooking | null }) {
  const [editor, setEditor] = useState(initial);
  const visitId = initial.visit.id;
  const { run, state, retry, refusal, pending } = useVisitSave(visitId, setEditor);
  // Un testo scritto che non è ancora partito (meno di 800 ms): chiudere la scheda prima chiede conferma.
  const typing = useSyncExternalStore(subscribeTyping, hasTypingText, () => false);
  const [amendment, setAmendment] = useState<Amendment | null>(null);
  // La rettifica di adesso, anche fra due render: due modifiche di fila (una perdita del focus e un clic) si sommano.
  const amendRef = useRef<Amendment | null>(null);
  const updateAmendment = useCallback((next: Amendment | null) => {
    amendRef.current = next;
    setAmendment(next);
  }, []);
  // «Salva la rettifica» è in coda (in corso, o ferma dopo un guasto): un altro clic la riprova, non ne accoda un'altra.
  const amendQueued = useRef(false);
  const [asking, setAsking] = useState(false);
  // Cambia quando una rettifica si salva o si annulla, o una sua riga si toglie: le sezioni ripartono dalla vista,
  // senza le scelte che tenevano da sé.
  const [generation, setGeneration] = useState(0);
  useUnsavedDraft(amendment !== null && amendment.ops.length > 0);

  const closed = editor.visit.status !== "draft";
  const mode: VisitSectionProps["mode"] = !closed ? "bozza" : amendment === null ? "lettura" : "rettifica";
  const shown = useMemo(() => (amendment === null ? editor : applyAmendOps(editor, amendment.ops)), [editor, amendment]);
  // La vista del server, con cui la lista risolve gli id delle righe: `op` resta lo stesso a ogni vista nuova.
  const server = useRef(editor);
  useEffect(() => {
    server.current = editor;
  });

  const op = useCallback(
    (operation: unknown, options?: RunOptions) => {
      if (mode === "bozza") {
        run((id) => {
          const value = operation as { op?: string } | null;
          const inserts = ["disfunzione", "test", "tecnica", "consiglio"];
          return editVisitAction(visitId, value && inserts.includes(value.op ?? "") ? { ...value, id } : operation);
        }, options);
        return;
      }
      const current = amendRef.current;
      const parsed = mode === "rettifica" ? toAmendOp(operation) : null;
      if (current === null || parsed === null) return;
      const merged = mergeAmendOp(current.ops, parsed, server.current);
      if (!merged.ok) {
        // Come un rifiuto del server: la sezione torna al valore mostrato e dice la frase sotto il controllo.
        options?.onRefused?.({ ok: false, message: merged.message, refused: true });
        return;
      }
      updateAmendment({ ...current, ops: merged.list, error: null });
    },
    [mode, run, visitId, updateAmendment],
  );
  const section: VisitSectionProps = { editor: shown, mode, op, run };

  const restart = () => {
    updateAmendment(null);
    setGeneration((g) => g + 1);
  };

  const removeOp = (target: AmendOp) => {
    const current = amendRef.current;
    if (current === null) return;
    updateAmendment({ ...current, ops: current.ops.filter((o) => o !== target), error: null });
    setGeneration((g) => g + 1);
  };

  /** La rettifica non è più in volo: le sezioni e «Annulla la rettifica» tornano usabili. */
  const settled = (error: string | null = null) => {
    const current = amendRef.current;
    if (current !== null) updateAmendment({ ...current, saving: false, error });
  };

  const saveAmendment = () => {
    const current = amendRef.current;
    if (current === null || current.saving) return;
    updateAmendment({ ...current, saving: true, error: null });
    if (amendQueued.current) {
      retry();
      return;
    }
    amendQueued.current = true;
    // Anche il contenuto resta quello messo in coda: un retry non è una rettifica nuova.
    const payload = { reason: current.reason, ops: current.ops };
    run(
      async (id) => {
        const latest = amendRef.current;
        if (latest === null || latest.ops.length === 0) {
          amendQueued.current = false;
          return visitEditorAction(visitId);
        }
        if (!latest.saving) updateAmendment({ ...latest, saving: true, error: null });
        try {
          const result = await amendVisitAction(visitId, { ...payload, id });
          if (result.ok) {
            amendQueued.current = false;
            restart();
            toast.success(AMENDED);
          } else if (result.refused) {
            amendQueued.current = false;
          } else {
            settled();
          }
          return result;
        } catch (error) {
          settled();
          throw error;
        }
      },
      // Il rifiuto lo dice il riquadro della rettifica, una volta sola.
      { quietRefusal: true, onRefused: (failure) => settled(refusalText(failure)) },
    );
  };

  const actions =
    mode === "bozza" ? (
      <>
        {editor.copy.available ? <CopyButton editor={editor} run={run} /> : null}
        <CloseActions editor={editor} run={run} />
      </>
    ) : mode === "lettura" ? (
      <Button type="button" variant="outline" size="sm" onClick={() => setAsking(true)}>
        Rettifica
      </Button>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <UnsavedGuard dirty={pending || typing} description={mode === "rettifica" ? AMEND_UNSAVED_TEXT : UNSAVED_TEXT} />
      <TopBar editor={shown} saveState={state} onRetry={retry} refusal={refusal} actions={actions} />
      <AmendDialog
        open={asking}
        onOpenChange={setAsking}
          onStart={(reason) => {
          setAsking(false);
          updateAmendment({ reason, ops: [], saving: false, error: null });
        }}
      />
      {amendment === null ? null : (
        <AmendBar
          reason={amendment.reason}
          count={amendCount(amendment.ops)}
          lines={amendment.ops.map((o) => ({ text: amendLine(o, editor), onRemove: () => removeOp(o) }))}
          saving={amendment.saving || pending}
          error={amendment.error}
          onSave={saveAmendment}
          onCancel={restart}
        />
      )}
      {/* Anche dopo un guasto la rettifica resta in coda: «Riprova» rimanda lo stesso contenuto. */}
      <div
        key={generation}
        inert={amendment !== null && (amendment.saving || pending)}
        className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]"
      >
        <div className="flex min-w-0 flex-col gap-4">
          {/* Le ancore `sezione-a` ... `sezione-e` sono quelle dei link di "Per chiudere" (`closingCheck`). */}
          <EditorSection id="sezione-a" title="A. Come sta">
            <SectionA {...section} />
          </EditorSection>
          <EditorSection id="sezione-b" title="B. Screening">
            <SectionB {...section} />
          </EditorSection>
          <EditorSection id="sezione-c" title="C. Valutazione">
            <SectionC {...section} />
          </EditorSection>
          <EditorSection id="sezione-d" title="D. Trattamento">
            <SectionD {...section} />
          </EditorSection>
          <EditorSection id="sezione-e" title="E. Chiusura">
            <SectionE {...section} booking={booking} />
          </EditorSection>
        </div>
        <RightColumn {...section} />
      </div>
    </div>
  );
}
