"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { registerPaymentAction, undoPaymentAction } from "@/app/(app)/fatture/actions";
import { ChoiceSelect, described, Field } from "@/components/forms/form-parts";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { money } from "@/lib/format";
import { PAID_IN_FUTURE } from "@/lib/fiscal/issue-date";
import type { InvoiceRow } from "@/server/domain/invoices/queries";

export function PaymentDialog({ row, undo, today, onClose, returnFocus }: {
  row: InvoiceRow; undo: boolean; today: string; onClose: () => void; returnFocus: HTMLElement | null;
}) {
  const router = useRouter();
  const id = useId();
  const date = useRef<HTMLInputElement>(null);
  const [method, setMethod] = useState(row.paymentMethod);
  const [paidOn, setPaidOn] = useState(today);
  const [error, setError] = useState<string>();
  const [dateError, setDateError] = useState<string>();
  const [pending, start] = useTransition();
  function submit() {
    setError(undefined);
    if (!undo && (!paidOn || paidOn > today)) {
      setDateError(paidOn ? PAID_IN_FUTURE : "Scrivi la data dell'incasso.");
      date.current?.focus();
      return;
    }
    setDateError(undefined);
    start(async () => {
      try {
        const result = undo ? await undoPaymentAction({ invoiceId: row.id })
          : await registerPaymentAction({ invoiceId: row.id, method, paidOn });
        if (!result.ok) {
          setError(result.message);
          if (result.fieldErrors?.paidOn) { setDateError(result.fieldErrors.paidOn); date.current?.focus(); }
          return;
        }
        toast.success(undo ? "Incasso annullato." : "Incasso registrato.");
        onClose();
        router.refresh();
      } catch { setError("Non ho aggiornato l'incasso. Riprova."); }
    });
  }
  const title = `${undo ? "Annullare" : "Registrare"} l'incasso della fattura ${row.numberLabel}?`;
  if (undo) return <AlertDialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <AlertDialogContent finalFocus={() => returnFocus}>
      <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>La fattura torna da incassare.</AlertDialogDescription></AlertDialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialogFooter><AlertDialogCancel disabled={pending}>Torna indietro</AlertDialogCancel><Button disabled={pending} onClick={submit}>Annulla incasso</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <DialogContent finalFocus={() => returnFocus}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Un solo incasso, pari al netto da pagare.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <ChoiceSelect id={`${id}-metodo`} label="Metodo" value={method} onChange={setMethod} error={undefined}
          items={[{ value: "contanti", label: "Contanti" }, { value: "carta", label: "Carta" }, { value: "bonifico", label: "Bonifico" }]} />
        <Field id={`${id}-data`} label="Data dell'incasso" error={dateError}>
          <Input id={`${id}-data`} ref={date} type="date" value={paidOn} onChange={(e) => { setPaidOn(e.target.value); setDateError(undefined); }} {...described(`${id}-data`, dateError)} />
        </Field>
        <Field id={`${id}-importo`} label="Importo" error={undefined}><Input id={`${id}-importo`} value={money(row.netCents)} readOnly /></Field>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={onClose}>Torna indietro</Button><Button type="submit" disabled={pending}>Registra incasso</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
