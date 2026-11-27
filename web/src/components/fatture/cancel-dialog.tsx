"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cancelInvoiceAction } from "@/app/(app)/fatture/actions";
import { described, Field } from "@/components/forms/form-parts";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { InvoiceRow } from "@/server/domain/invoices/queries";

export function CancelDialog({ row, onClose, returnFocus }: { row: InvoiceRow; onClose: () => void; returnFocus: HTMLElement | null }) {
  const router = useRouter();
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [noteError, setNoteError] = useState<string>();
  const [pending, start] = useTransition();
  function submit() {
    setError(undefined);
    start(async () => {
      try {
        const result = await cancelInvoiceAction({ invoiceId: row.id, note: note.trim() || null });
        if (!result.ok) {
          setError(result.message);
          if (result.fieldErrors?.note) { setNoteError(result.fieldErrors.note); field.current?.focus(); }
          return;
        }
        toast.success(`Nota di credito ${result.data.numberLabel} emessa.`);
        if (result.data.wasPaid) toast.info("Rimborso da gestire fuori dal gestionale");
        onClose();
        router.refresh();
      } catch { setError("Non ho annullato la fattura. Riprova."); }
    });
  }
  return <AlertDialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <AlertDialogContent finalFocus={() => returnFocus}>
      <AlertDialogHeader><AlertDialogTitle>Annullare la fattura {row.numberLabel}?</AlertDialogTitle>
        <AlertDialogDescription>{"Verrà emessa una nota di credito che la storna per intero. La fattura resta nell'archivio."}</AlertDialogDescription>
      </AlertDialogHeader>
      <Field id={id} label="Motivo interno (facoltativo)" error={noteError}>
        <Textarea ref={field} id={id} value={note} onChange={(e) => { setNote(e.target.value); setNoteError(undefined); }} {...described(id, noteError)} />
      </Field>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={pending}>Torna indietro</AlertDialogCancel><Button disabled={pending} onClick={submit}>Emetti la nota di credito</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
