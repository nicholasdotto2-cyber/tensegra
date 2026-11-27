"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// La domanda di "Segna come fatta" prima dell'inizio: "Inizia alle 17:00.
// Segnarlo comunque come fatto?" con "Segna come fatta" e "Torna indietro". La usano il dettaglio
// dell'agenda e le righe di Oggi, che tengono lo stato della domanda.

export function DoneConfirm({
  open,
  question,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  question: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{question}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Torna indietro</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Segna come fatta
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
