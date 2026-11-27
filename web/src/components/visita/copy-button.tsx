"use client";

import { useId, useState } from "react";
import { toast } from "sonner";

import { copyVisitAction } from "@/app/(app)/pazienti/[id]/visite/[visitId]/actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { COPY_NEEDS_SCREENING } from "@/lib/clinical/labels";
import type { VisitEditor } from "@/server/domain/visits/editor";

import type { VisitSectionProps } from "./visit-editor";

// "Copia dalla visita precedente" nella barra dell'editor: c'è solo con una
// visita sorgente e in bozza (`copy.available`), ed è attiva solo con lo screening di oggi confermato, così la copia
// confronta le tecniche con gli esiti di oggi. Accanto, da dove copia («del 15/10», «dal ciclo precedente»). Premuta
// con copiati non ancora confermati chiede «Sostituire i dati copiati non confermati?»: «Sostituisci» li toglie e
// ricopia, le righe confermate restano. Le tecniche che oggi non si copiano le dice un avviso. La chiamata passa dalla
// coda dell'editor, dopo le modifiche in attesa.

const LABEL = "Copia dalla visita precedente";
const REPLACE_TITLE = "Sostituire i dati copiati non confermati?";
const REPLACE_TEXT = "Le righe copiate e non ancora confermate tornano quelle della visita precedente; quelle confermate restano.";

export function CopyButton({ editor, run }: { editor: VisitEditor; run: VisitSectionProps["run"] }) {
  const hintId = useId();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const visitId = editor.visit.id;
  const confirmed = editor.visit.screeningConfirmed;

  const copy = (replace: boolean) => {
    setBusy(true);
    run(
      async () => {
        let result: Awaited<ReturnType<typeof copyVisitAction>>;
        try {
          result = await copyVisitAction(visitId, replace);
        } catch (error) {
          // Un guasto lascia la chiamata in coda per «Riprova»: il pulsante torna usabile.
          setBusy(false);
          throw error;
        }
        if (!result.ok) {
          if (!result.refused) setBusy(false);
          return result;
        }
        setBusy(false);
        if (result.data.needsReplace) setAsking(true);
        if (result.data.skippedText !== null) toast(result.data.skippedText);
        return { ok: true, data: result.data.editor };
      },
      // Il messaggio del rifiuto lo mostra lo stato del salvataggio; il pulsante torna attivo.
      { onRefused: () => setBusy(false) },
    );
  };

  const hint = confirmed ? editor.copy.label : COPY_NEEDS_SCREENING;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!confirmed || busy}
        aria-describedby={hint === null ? undefined : hintId}
        onClick={() => copy(false)}
      >
        {LABEL}
      </Button>
      {hint === null ? null : (
        <span id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </span>
      )}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{REPLACE_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>{REPLACE_TEXT}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Torna indietro</AlertDialogCancel>
            <Button
              type="button"
              onClick={() => {
                setAsking(false);
                copy(true);
              }}
            >
              Sostituisci
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
