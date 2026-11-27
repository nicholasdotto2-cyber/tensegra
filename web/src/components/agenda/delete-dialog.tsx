"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { deleteAppointmentAction } from "@/app/(app)/agenda/actions";
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

// La conferma di "Elimina": "Eliminare l'appuntamento? Se il paziente ha disdetto, usa
// Annulla: resta traccia." con "Elimina" e "Torna indietro". Il dettaglio offre "Elimina" solo senza
// visita, righe di fattura e messaggi registrati; se nel frattempo ne è nato uno, lo dice il comando.

export function DeleteDialog({
  appointmentId,
  onClose,
  onDeleted,
}: {
  /** L'appuntamento da eliminare; null tiene chiusa la conferma. */
  appointmentId: string | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [deleting, startDeleting] = useTransition();

  const confirm = (id: string) => {
    startDeleting(async () => {
      const result = await deleteAppointmentAction(id);
      onClose();
      if (result.ok) {
        onDeleted();
        return;
      }
      toast.error(result.message);
      if (result.conflict) router.refresh();
    });
  };

  return (
    <AlertDialog
      open={appointmentId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Eliminare l&apos;appuntamento?</AlertDialogTitle>
          <AlertDialogDescription>Se il paziente ha disdetto, usa Annulla: resta traccia.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Torna indietro</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={deleting}
            onClick={() => {
              if (appointmentId !== null) confirm(appointmentId);
            }}
          >
            Elimina
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
