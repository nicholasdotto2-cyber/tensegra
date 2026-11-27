"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { appointmentDetailAction, cancelAppointmentAction } from "@/app/(app)/agenda/actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// "Annulla appuntamento": il motivo è obbligatorio e in una serie la
// casella annulla anche le successive, con lo stesso motivo. Il dettaglio passa le successive che ha già
// letto; le righe di Oggi no, e il dialogo le legge quando si apre. Il motivo mancante lo dice il comando
// («Scegli il motivo.»), sotto il campo, col focus sul campo.

type Reason = "paziente" | "studio" | "altro";

const REASONS: readonly { value: Reason; label: string }[] = [
  { value: "paziente", label: "Paziente" },
  { value: "studio", label: "Studio" },
  { value: "altro", label: "Altro" },
];

/** "Annulla anche le 3 successive della serie", per 1 «Annulla anche la successiva della serie». */
function alsoFollowingLabel(n: number): string {
  return n === 1 ? "Annulla anche la successiva della serie" : `Annulla anche le ${n} successive della serie`;
}

function CancelForm({
  appointmentId,
  seriesFollowing,
  onClose,
  onCancelled,
  firstRef,
}: {
  appointmentId: string;
  seriesFollowing: number | undefined;
  onClose: () => void;
  onCancelled?: () => void;
  firstRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const router = useRouter();
  const baseId = useId();
  const reasonLabelId = `${baseId}-motivo`;
  const reasonErrorId = `${baseId}-motivo-errore`;
  const [reason, setReason] = useState<Reason | null>(null);
  const [alsoFollowing, setAlsoFollowing] = useState(false);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  // Dalle righe di Oggi le successive della serie si leggono all'apertura.
  useEffect(() => {
    if (seriesFollowing !== undefined) return;
    let current = true;
    void appointmentDetailAction(appointmentId).then((result) => {
      if (current && result.ok && result.data) setLoaded(result.data.seriesFollowing);
    });
    return () => {
      current = false;
    };
  }, [appointmentId, seriesFollowing]);

  const following = seriesFollowing ?? loaded ?? 0;

  const submit = () => {
    startSaving(async () => {
      const result = await cancelAppointmentAction({
        id: appointmentId,
        ...(reason === null ? {} : { reason }),
        alsoFollowing: following > 0 && alsoFollowing,
      });
      if (result.ok) {
        onClose();
        onCancelled?.();
        return;
      }
      const reasonError = result.fieldErrors?.reason;
      if (reasonError !== undefined) {
        setError(reasonError);
        firstRef.current?.focus();
        return;
      }
      toast.error(result.message);
      if (result.conflict) router.refresh();
    });
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-2">
        <span id={reasonLabelId} className="text-sm leading-none font-medium">
          Motivo <span className="font-normal text-muted-foreground">(obbligatorio)</span>
        </span>
        <RadioGroup
          aria-labelledby={reasonLabelId}
          aria-describedby={error === null ? undefined : reasonErrorId}
          value={reason}
          onValueChange={(value) => {
            setReason(value === "paziente" || value === "studio" || value === "altro" ? value : null);
            setError(null);
          }}
          className="flex flex-wrap gap-x-6"
        >
          {REASONS.map((item, index) => (
            <Label key={item.value} className="min-h-6 font-normal">
              <RadioGroupItem
                value={item.value}
                ref={index === 0 ? firstRef : undefined}
                aria-invalid={error === null ? undefined : true}
              />
              {item.label}
            </Label>
          ))}
        </RadioGroup>
        {error === null ? null : (
          <p id={reasonErrorId} className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      {following > 0 ? (
        <Label className="min-h-6 font-normal">
          <Checkbox checked={alsoFollowing} onCheckedChange={(checked) => setAlsoFollowing(checked)} />
          {alsoFollowingLabel(following)}
        </Label>
      ) : null}
      <AlertDialogFooter>
        <AlertDialogCancel>Torna indietro</AlertDialogCancel>
        <Button type="submit" variant="destructive" disabled={saving}>
          Annulla appuntamento
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

export function CancelDialog({
  appointmentId,
  seriesFollowing,
  onClose,
  onCancelled,
}: {
  /** L'appuntamento da annullare; null tiene chiuso il dialogo. */
  appointmentId: string | null;
  /** Le successive della serie già lette dal dettaglio; senza, il dialogo le legge. */
  seriesFollowing?: number;
  onClose: () => void;
  onCancelled?: () => void;
}) {
  const firstRef = useRef<HTMLButtonElement>(null);
  // Il modulo resta a schermo mentre il dialogo si chiude e nasce di nuovo a ogni apertura: motivo e
  // casella ripartono vuoti.
  const [shown, setShown] = useState<{ id: string; opening: number } | null>(null);
  const [previousId, setPreviousId] = useState<string | null>(null);
  if (appointmentId !== previousId) {
    setPreviousId(appointmentId);
    if (appointmentId !== null) setShown({ id: appointmentId, opening: (shown?.opening ?? 0) + 1 });
  }

  return (
    <AlertDialog
      open={appointmentId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent initialFocus={firstRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>Annullare l&apos;appuntamento?</AlertDialogTitle>
        </AlertDialogHeader>
        {shown === null ? null : (
          <CancelForm
            key={shown.opening}
            appointmentId={shown.id}
            seriesFollowing={seriesFollowing}
            onClose={onClose}
            onCancelled={onCancelled}
            firstRef={firstRef}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
