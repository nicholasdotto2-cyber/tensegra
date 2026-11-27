"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { closeVisitAction, editVisitAction } from "@/app/(app)/pazienti/[id]/visite/[visitId]/actions";
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
import type { ActionFailure } from "@/server/actions/result";
import type { VisitEditor } from "@/server/domain/visits/editor";

import { revealAnchor } from "./editor-section";
import type { VisitSectionProps } from "./visit-editor";

// La chiusura della visita nella barra dell'editor. "Chiudi la visita" resta
// sempre attivo: con voci bloccanti il comando risponde con la prima, lo stato del salvataggio la dice e il focus va
// al suo campo (lo stesso link della colonna "Per chiudere"). Con l'appuntamento ancora prenotato o confermato la
// chiusura chiede «Chiudere la visita?» con "Segna anche l'appuntamento come fatto" e «Chiudi solo la visita». Con
// righe copiate non confermate ci sono anche "Conferma tutti i copiati" e "Conferma tutti i copiati e chiudi" (una
// sola azione). Chiusa, un avviso «Visita chiusa.» e l'editor in sola lettura (la vista che torna è chiusa).

const CLOSE = "Chiudi la visita";
const CLOSED = "Visita chiusa.";
const ASK_TITLE = "Chiudere la visita?";
const ASK_TEXT = "L'appuntamento della visita non è ancora segnato come fatto.";
/** Gli stati dell'appuntamento per cui la chiusura chiede se segnarlo fatto. */
const NOT_DONE = ["prenotato", "confermato"];

/** Le righe copiate dalla visita precedente e non ancora confermate. */
export function copiedCount(editor: VisitEditor): number {
  return [...editor.findings, ...editor.tests, ...editor.treatments].filter((row) => row.copied).length;
}

/** «Chiudere la visita?»: segnare anche l'appuntamento come fatto, o chiudere solo la visita. */
export function CloseDialog({
  open,
  onOpenChange,
  onClose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: (alsoMarkDone: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{ASK_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{ASK_TEXT}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Torna indietro</AlertDialogCancel>
          <Button type="button" variant="outline" onClick={() => onClose(false)}>
            Chiudi solo la visita
          </Button>
          <Button type="button" onClick={() => onClose(true)}>
            Segna anche l&apos;appuntamento come fatto
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "Conferma tutti i copiati", "Conferma tutti i copiati e chiudi" e "Chiudi la visita", con la conferma. */
export function CloseActions({ editor, run }: { editor: VisitEditor; run: VisitSectionProps["run"] }) {
  const [asking, setAsking] = useState<{ confirmCopied: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // La vista più recente: il rifiuto arriva dopo, e il suo campo si cerca in "Per chiudere" di allora.
  const latest = useRef(editor);
  useEffect(() => {
    latest.current = editor;
  });
  const visitId = editor.visit.id;
  const copied = copiedCount(editor);

  /** Il focus al campo della voce che ha fermato la chiusura (la prima di "Per chiudere" se il testo non c'è). */
  const refused = (failure: ActionFailure) => {
    setBusy(false);
    const { blocking } = latest.current.closing;
    const item = blocking.find((b) => b.text === failure.message) ?? blocking[0];
    if (item !== undefined) revealAnchor(item.anchor);
  };

  const close = (confirmCopied: boolean, alsoMarkDone: boolean) => {
    setAsking(null);
    setBusy(true);
    run(
      async () => {
        try {
          const result = await closeVisitAction(visitId, { confirmCopied, alsoMarkDone });
          // Un guasto (non un rifiuto) lascia la chiamata in coda per «Riprova»: i pulsanti tornano usabili.
          if (result.ok || !result.refused) setBusy(false);
          if (result.ok) toast.success(CLOSED);
          return result;
        } catch (error) {
          setBusy(false);
          throw error;
        }
      },
      { onRefused: refused },
    );
  };

  const start = (confirmCopied: boolean) => {
    if (NOT_DONE.includes(editor.visit.appointmentStatus)) setAsking({ confirmCopied });
    else close(confirmCopied, false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {copied === 0 ? null : (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => run(() => editVisitAction(visitId, { op: "conferma", target: "tutti" }))}
          >
            Conferma tutti i copiati
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => start(true)}>
            Conferma tutti i copiati e chiudi
          </Button>
        </>
      )}
      <Button type="button" size="sm" disabled={busy} onClick={() => start(false)}>
        {CLOSE}
      </Button>
      <CloseDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        onClose={(alsoMarkDone) => close(asking?.confirmCopied ?? false, alsoMarkDone)}
      />
    </div>
  );
}
