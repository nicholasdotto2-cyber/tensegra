"use client";

import { type ComponentProps, useState } from "react";

import { CloseLoader } from "@/components/cartella/cycle-close-loader";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// La finestra "Chiudi ciclo". Si legge da sé
// (`CloseLoader`) e si apre da tre posti: la Cartella, il dialogo dell'appuntamento ("Chiudi il mantenimento") e
// il pannello "Seduta fatta". Il modulo è in `cycle-close-form.tsx`; cosa manda al comando, in
// `lib/cartella/close-cycle-form.ts`.

export function CycleCloseDialog({
  cycleId,
  onClose,
  onClosed,
  finalFocus,
}: {
  /** Il ciclo da chiudere; null tiene chiusa la finestra. */
  cycleId: string | null;
  onClose: () => void;
  /** Il ciclo è chiuso: chi ha aperto la finestra rilegge ciò che dipende da lui. */
  onClosed?: () => void;
  /** Dove va il focus alla chiusura: di norma torna a chi ha aperto la finestra, che dopo una chiusura può non esserci più. */
  finalFocus?: ComponentProps<typeof DialogContent>["finalFocus"];
}) {
  // Mentre la finestra si chiude tiene il ciclo che mostrava.
  const [shownId, setShownId] = useState(cycleId);
  if (cycleId !== null && cycleId !== shownId) setShownId(cycleId);

  return (
    <Dialog
      open={cycleId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent finalFocus={finalFocus} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Chiudi ciclo</DialogTitle>
        </DialogHeader>
        {shownId === null ? null : <CloseLoader cycleId={shownId} onClose={onClose} onClosed={onClosed} />}
      </DialogContent>
    </Dialog>
  );
}
