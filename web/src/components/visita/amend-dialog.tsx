"use client";

import { type RefObject, useEffect, useId, useRef, useState } from "react";

import { described, Field } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { AMEND_REASON_MAX, AMEND_REASON_MIN, AMEND_REASON_SHORT } from "@/lib/clinical/labels";

// La rettifica di una visita chiusa. «Rettifica» apre `AmendDialog`: il «Motivo
// della rettifica», da 10 a 500 caratteri («Scrivi almeno 10 caratteri.»), poi l'editor raccoglie le modifiche senza
// salvarle. `AmendBar` sta sotto la barra finché la rettifica è aperta: il motivo, le modifiche che aspettano, una
// per riga con «Togli» (la via d'uscita da ogni rifiuto), «Salva la rettifica», che le manda tutte con il motivo in
// una sola azione, e «Annulla la rettifica». Se la rettifica non si salva, la frase resta qui e la lista pure.

const TITLE = "Rettifica la visita";
const DESCRIPTION = "Scrivi perché cambi una visita chiusa: il motivo resta con le modifiche, con i valori di prima e di dopo.";
const REASON = "Motivo della rettifica";

export function AmendDialog({
  open,
  onOpenChange,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (reason: string) => void;
}) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={fieldRef} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{TITLE}</DialogTitle>
          <DialogDescription>{DESCRIPTION}</DialogDescription>
        </DialogHeader>
        {/* Il modulo nasce a ogni apertura: il motivo riparte vuoto. */}
        {open ? <ReasonForm fieldRef={fieldRef} onStart={onStart} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ReasonForm({
  fieldRef,
  onStart,
}: {
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  onStart: (reason: string) => void;
}) {
  const id = `${useId()}-motivo`;
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = reason.trim();
        if (trimmed.length < AMEND_REASON_MIN) {
          setError(AMEND_REASON_SHORT);
          fieldRef.current?.focus();
          return;
        }
        onStart(trimmed);
      }}
    >
      <Field id={id} label={REASON} required error={error}>
        <Textarea
          ref={fieldRef}
          id={id}
          value={reason}
          maxLength={AMEND_REASON_MAX}
          onChange={(event) => {
            setReason(event.target.value);
            setError(undefined);
          }}
          {...described(id, error)}
        />
      </Field>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Torna indietro</DialogClose>
        <Button type="submit">Inizia la rettifica</Button>
      </DialogFooter>
    </form>
  );
}

/** «1 modifica da salvare.», «3 modifiche da salvare.». */
function countText(count: number): string {
  if (count === 0) return "Nessuna modifica ancora: cambia i campi della visita.";
  return count === 1 ? "1 modifica da salvare." : `${count} modifiche da salvare.`;
}

export function AmendBar({
  reason,
  count,
  lines,
  saving,
  error,
  onSave,
  onCancel,
}: {
  reason: string;
  /** Le voci cambiate della lista (`amendCount`). */
  count: number;
  /** Una riga per operazione della lista, con il suo «Togli». */
  lines: readonly { text: string; onRemove: () => void }[];
  /** La rettifica è partita e non ha ancora una risposta. */
  saving: boolean;
  /** La frase del rifiuto dell'ultima «Salva la rettifica». */
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  const errorId = useId();
  // Il riquadro nasce dal dialogo del motivo, che si chiude: il focus viene qui (il pulsante «Rettifica» non c'è più).
  const boxRef = useRef<HTMLElement>(null);
  useEffect(() => boxRef.current?.focus(), []);
  return (
    <section
      ref={boxRef}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border border-primary bg-card p-4 text-sm text-card-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <h2 id={headingId} className="text-base font-medium">
        Rettifica in corso
      </h2>
      <p>
        <span className="font-medium">{REASON}:</span> {reason}
      </p>
      <p>{countText(count)}</p>
      {lines.length === 0 ? null : (
        <ul aria-label="Modifiche da salvare" className="flex flex-col gap-1">
          {lines.map((line, index) => (
            <li key={`${index}-${line.text}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span>{line.text}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                aria-label={`Togli: ${line.text}`}
                onClick={() => {
                  line.onRemove();
                  // La riga se ne va col suo pulsante: il focus resta nel riquadro.
                  boxRef.current?.focus();
                }}
              >
                Togli
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error === null ? null : (
        <p id={errorId} role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={saving || count === 0}
          aria-describedby={error === null ? undefined : errorId}
          onClick={onSave}
        >
          Salva la rettifica
        </Button>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Annulla la rettifica
        </Button>
      </div>
    </section>
  );
}
