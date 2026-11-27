"use client";

import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { setClinicalAlertAction } from "@/app/(app)/pazienti/[id]/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// «Modifica avviso» della testata della Cartella: l'avviso clinico è un
// testo breve scritto a mano, fino a 200 caratteri, e vuoto lo toglie. Si scrive solo da qui.

const ALERT_MAX = 200;
const NOT_SAVED = "Non ho salvato l'avviso. Riprova.";
const SAVED = "Avviso salvato.";
const HINT = "Un testo breve, in testa alla scheda. Lascialo vuoto per toglierlo.";

function AlertForm({ patientId, alert, onClose }: { patientId: string; alert: string | null; onClose: () => void }) {
  const baseId = useId();
  const fieldId = `${baseId}-avviso`;
  const [text, setText] = useState(alert ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const submit = () => {
    startSaving(async () => {
      const result = await setClinicalAlertAction({ patientId, clinicalAlert: text });
      if (result.ok) {
        toast.success(SAVED);
        onClose();
        return;
      }
      setError(result.fieldErrors?.clinicalAlert ?? NOT_SAVED);
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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId}>Avviso clinico</Label>
        <Textarea
          id={fieldId}
          maxLength={ALERT_MAX}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? `${fieldId}-suggerimento` : `${fieldId}-suggerimento ${fieldId}-errore`}
        />
        <p id={`${fieldId}-suggerimento`} className="text-sm text-muted-foreground">
          {HINT}
        </p>
        {error === null ? null : (
          <p id={`${fieldId}-errore`} className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Torna indietro</DialogClose>
        <Button type="submit" disabled={saving}>
          Salva l&apos;avviso
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ClinicalAlertDialog({ patientId, alert }: { patientId: string; alert: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Modifica avviso
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifica avviso</DialogTitle>
          </DialogHeader>
          {/* Il modulo nasce a ogni apertura: il testo riparte da ciò che è salvato. */}
          <AlertForm patientId={patientId} alert={alert} onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
