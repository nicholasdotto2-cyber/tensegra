"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { startVisitAction } from "@/app/(app)/pazienti/[id]/actions";
import { AppointmentDialog, createdDone, type ServiceOption } from "@/components/agenda/appointment-dialog";
import { Button } from "@/components/ui/button";

// "Nuova visita" della Cartella: apre "Nuovo appuntamento" con il
// paziente, oggi e l'ora attuale al quarto d'ora precedente. L'appuntamento nasce già fatto
// (`prefill.done`), poi `startVisitAction` crea la visita e si va all'editor, al posto del pannello
// "Seduta fatta". Se la visita non parte, l'appuntamento fatto resta e la cronologia offre "Compila ora".

export interface NewVisitBooking {
  services: readonly ServiceOption[];
  defaultIntervalWeeks: number;
  defaultExpectedSessions: number;
  /** "AAAA-MM-GG": oggi a Roma. */
  today: string;
  /** "HH:MM": l'ora di Roma al quarto d'ora precedente. */
  nowTime: string;
}

export function NewVisitButton({ patientId, booking }: { patientId: string; booking: NewVisitBooking }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [starting, startStarting] = useTransition();
  const { today, nowTime, ...rest } = booking;

  return (
    <>
      <Button type="button" disabled={starting} onClick={() => setOpen(true)}>
        Nuova visita
      </Button>
      <AppointmentDialog
        open={open}
        onOpenChange={setOpen}
        {...rest}
        prefill={{ patientId, day: today, time: nowTime, done: true }}
        onCreated={(created) => {
          const appointmentId = createdDone(created);
          if (appointmentId === null) return;
          startStarting(async () => {
            const result = await startVisitAction(appointmentId);
            if (result.ok) router.push(`/pazienti/${result.data.patientId}/visite/${result.data.visitId}`);
            else toast.error(result.message);
          });
        }}
      />
    </>
  );
}
