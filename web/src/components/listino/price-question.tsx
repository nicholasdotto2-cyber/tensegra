"use client";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

// La domanda dopo un cambio di prezzo: se ci sono appuntamenti futuri ancora al
// prezzo vecchio, "Aggiornare anche i 3 appuntamenti futuri con questa prestazione?", per 1 «Aggiornare
// anche l'appuntamento futuro con questa prestazione?». «Aggiorna» li porta al prezzo nuovo, «Lascia come
// sono» (e Esc) non li tocca. Con 0 la domanda non si fa: il chiamante non la apre.

export function priceQuestionText(count: number): string {
  return count === 1
    ? "Aggiornare anche l'appuntamento futuro con questa prestazione?"
    : `Aggiornare anche i ${count} appuntamenti futuri con questa prestazione?`;
}

export function PriceQuestion({
  open,
  count,
  pending,
  onUpdate,
  onKeep,
}: {
  open: boolean;
  /** Gli appuntamenti futuri ancora al prezzo vecchio: resta scritto mentre la domanda si chiude. */
  count: number;
  pending: boolean;
  onUpdate: () => void;
  onKeep: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeep();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{priceQuestionText(count)}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Lascia come sono</AlertDialogCancel>
          <Button type="button" disabled={pending} onClick={onUpdate}>
            Aggiorna
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
