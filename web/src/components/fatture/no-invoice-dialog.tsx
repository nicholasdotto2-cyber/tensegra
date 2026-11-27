"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { markNotToInvoiceAction } from "@/app/(app)/fatture/actions";
import { ChoiceSelect } from "@/components/forms/form-parts";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ToInvoiceRow } from "@/server/domain/invoices/queries";

export function NoInvoiceDialog({ row, onClose, returnFocus }: { row: ToInvoiceRow; onClose: () => void; returnFocus: HTMLElement | null }) {
  const router = useRouter();
  const id = useId();
  const field = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();
  const [pending, start] = useTransition();
  function submit() {
    setError(undefined);
    if (!reason) { setFieldError("Scegli un motivo."); field.current?.focus(); return; }
    start(async () => {
      try {
        const result = await markNotToInvoiceAction({ appointmentId: row.appointmentId, reason });
        if (!result.ok) {
          setError(result.message);
          if (result.fieldErrors?.reason) { setFieldError(result.fieldErrors.reason); field.current?.focus(); }
          return;
        }
        toast.success("Seduta segnata da non fatturare.");
        onClose();
        router.refresh();
      } catch { setError("Non ho aggiornato la seduta. Riprova."); }
    });
  }
  return <AlertDialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <AlertDialogContent finalFocus={() => returnFocus}>
      <AlertDialogHeader><AlertDialogTitle>Non fatturare questa seduta?</AlertDialogTitle>
        <AlertDialogDescription>La seduta di {row.patientName} esce da Da emettere.</AlertDialogDescription>
      </AlertDialogHeader>
      <ChoiceSelect id={id} label="Motivo" required triggerRef={field} value={reason}
        onChange={(value) => { setReason(value); setFieldError(undefined); }} error={fieldError}
        items={[{ value: "", label: "Scegli un motivo" }, { value: "compresa_in_altra", label: "Compresa in un'altra fattura" }, { value: "gratuita", label: "Gratuita" }, { value: "altro", label: "Altro" }]} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={pending}>Torna indietro</AlertDialogCancel><Button disabled={pending} onClick={submit}>Non fatturare</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
