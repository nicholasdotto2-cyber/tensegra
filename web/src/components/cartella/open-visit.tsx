"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { startVisitAction } from "@/app/(app)/pazienti/[id]/actions";
import { Button } from "@/components/ui/button";

// Aprire la visita di un appuntamento da qualunque schermata: Oggi, il dettaglio e il pannello
// "Seduta fatta" dell'agenda, la tab Appuntamenti e la Cronologia della Cartella.

/**
 * Apre la visita di un appuntamento, creandola se manca (idempotente), e porta all'editor.
 * Il pulsante e la voce di menu di Oggi usano lo stesso passaggio.
 */
export function useOpenVisit(appointmentId: string): { open: () => void; pending: boolean } {
  const router = useRouter();
  const [pending, startPending] = useTransition();
  const open = () =>
    startPending(async () => {
      const result = await startVisitAction(appointmentId);
      if (result.ok) router.push(`/pazienti/${result.data.patientId}/visite/${result.data.visitId}`);
      else toast.error(result.message);
    });
  return { open, pending };
}

export function OpenVisitButton({
  appointmentId,
  label,
  variant = "default",
}: {
  appointmentId: string;
  label: string;
  variant?: "default" | "outline" | "link";
}) {
  const { open, pending } = useOpenVisit(appointmentId);
  return (
    <Button type="button" variant={variant} size="sm" disabled={pending} onClick={open}>
      {label}
    </Button>
  );
}
