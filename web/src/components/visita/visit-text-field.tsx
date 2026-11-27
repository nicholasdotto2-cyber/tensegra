"use client";

import { type ChangeEvent, useEffect, useRef, useState } from "react";

import { described, Field } from "@/components/forms/form-parts";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { RunOptions } from "@/lib/visits/save-queue";
import { createTextAutosave } from "@/lib/visits/text-autosave";

import { refocusIfIdle } from "./refocus";

// Il campo di testo dell'editor della visita, uno solo per le sezioni A-E. Un
// involucro sottile su `createTextAutosave` (src/lib/visits/text-autosave.ts, che ha i suoi test): lì stanno il
// salvataggio alla perdita del focus e dopo 800 ms, il valore locale col focus e il rifiuto. Qui ci sono solo il
// testo mostrato, la frase del rifiuto sotto il campo (`aria-invalid`, `aria-describedby`) e il focus che torna sul
// campo se nessun altro l'ha preso. Anche il campo data (`type="date"`) e quello numerico (`type="number"`) passano
// di qui: salvano come testo, e chi li usa converte nel suo `onSave`.

export interface VisitTextFieldProps {
  id: string;
  label: string;
  /** Il valore salvato (della vista). */
  value: string | null;
  /**
   * Salva il valore (già senza spazi ai lati, `null` se vuoto). `options` porta `onRefused`: va passato alla
   * chiamata in coda. Risponde `false` se il valore non si può inviare (per esempio un campo che non si svuota):
   * alla perdita del focus il campo torna al valore salvato.
   */
  onSave: (value: string | null, options: RunOptions) => boolean | void;
  disabled?: boolean;
  multiline?: boolean;
  type?: "text" | "number" | "date";
  required?: boolean;
  optional?: boolean;
  hint?: string;
  maxLength?: number;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  /** Una frase che arriva da fuori (un rifiuto di più campi insieme): si mostra finché il campo non ne ha una sua. */
  externalError?: string;
}

export function VisitTextField({
  id,
  label,
  value,
  onSave,
  disabled = false,
  multiline = false,
  type = "text",
  required = false,
  optional = false,
  hint,
  maxLength,
  min,
  max,
  step,
  className,
  externalError,
}: VisitTextFieldProps) {
  const [draft, setDraft] = useState(value ?? "");
  const [ownError, setError] = useState<string | undefined>(undefined);
  const error = ownError ?? externalError;
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [autosave] = useState(() =>
    createTextAutosave({
      value,
      send: onSave,
      onDraft: setDraft,
      onError: setError,
      onRefused: () => refocusIfIdle(document.getElementById(id)),
    }),
  );

  // `onSave` cambia a ogni render: la macchina chiama sempre l'ultimo.
  useEffect(() => autosave.configure({ send: onSave }));
  useEffect(() => autosave.sync(value), [autosave, value]);
  useEffect(() => () => autosave.dispose(), [autosave]);

  // Una data scritta a metà ha il valore vuoto ma non è un campo svuotato.
  const incomplete = () => inputRef.current?.validity.badInput === true;

  const onChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setDraft(event.target.value);
    autosave.input(event.target.value, { incomplete: incomplete() });
  };

  const shared = {
    id,
    value: draft,
    disabled,
    onChange,
    onFocus: autosave.focus,
    onBlur: () => autosave.blur({ incomplete: incomplete() }),
    ...described(id, error, hint !== undefined),
  };

  return (
    <Field id={id} label={label} required={required} optional={optional} error={error} hint={hint} className={className}>
      {multiline ? (
        <Textarea {...shared} ref={areaRef} maxLength={maxLength} />
      ) : (
        <Input {...shared} ref={inputRef} type={type} maxLength={maxLength} min={min} max={max} step={step} autoComplete="off" />
      )}
    </Field>
  );
}
