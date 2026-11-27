"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { RADIO_ITEM, radioKeyTarget } from "@/components/cartella/scale-parts";
import { described, Field } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { RunOptions } from "@/lib/visits/save-queue";
import { markUnsaved, refusalText } from "@/lib/visits/text-autosave";

import { refocusIfIdle } from "./refocus";

// Una scelta fra poche voci scritte («Come è iniziato», le reazioni, il lato, la fonte della diagnosi):
// un `role="radiogroup"` col nome dall'etichetta visibile, come `PainScale`: tabindex mobile (si entra con Tab sulla
// voce scelta, o sulla prima), le frecce passano alla voce vicina e la scelgono, Home e Fine vanno agli estremi. La
// scelta salva subito. Con `onClear` una scelta già fatta si toglie con «Togli», anche col mouse.

export interface ChoiceItem<T extends string> {
  value: T;
  label: string;
  /** La voce non si sceglie (un approccio che lo screening blocca): il motivo lo dice chi usa il gruppo, in `hint`. */
  disabled?: boolean;
}

export function ChoiceGroup<T extends string>({
  id,
  label,
  items,
  value,
  onChange,
  onClear,
  disabled = false,
  required = false,
  hideLabel = false,
  error,
  hint,
}: {
  id: string;
  label: string;
  items: readonly ChoiceItem<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** Toglie la scelta: senza questa prop la scelta, una volta fatta, si cambia ma non si toglie. */
  onClear?: () => void;
  disabled?: boolean;
  required?: boolean;
  /** L'etichetta solo per i lettori di schermo: la tabella compatta dell'esame neurologico ha già le sue intestazioni. */
  hideLabel?: boolean;
  error?: string;
  hint?: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const labelId = `${id}-label`;
  const chosenIndex = items.findIndex((item) => item.value === value);
  // Senza una scelta il punto d'ingresso è la prima voce che si può scegliere.
  const tabStop = chosenIndex === -1 ? Math.max(items.findIndex((item) => item.disabled !== true), 0) : chosenIndex;

  const choose = (index: number) => {
    const item = items[index];
    if (item === undefined || item.disabled) return;
    onChange(item.value);
    buttons.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const next = radioKeyTarget(event.key, index, items.length);
    if (next === null) return;
    event.preventDefault();
    choose(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className={cn("text-sm font-medium", hideLabel && "sr-only")}>
        {label}
        {required ? <span className="font-normal text-muted-foreground"> (obbligatorio)</span> : null}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <div
          id={id}
          role="radiogroup"
          aria-labelledby={labelId}
          aria-disabled={disabled || undefined}
          {...described(id, error, hint !== undefined)}
          className="flex flex-wrap gap-1"
        >
          {items.map((item, index) => {
            const checked = item.value === value;
            return (
              <button
                key={item.value}
                ref={(el) => {
                  buttons.current[index] = el;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={index === tabStop ? 0 : -1}
                disabled={disabled || item.disabled}
                onClick={() => onChange(item.value)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={cn(
                  "inline-flex min-h-8 items-center justify-center rounded-md border px-3 text-sm",
                  checked
                    ? "border-primary bg-primary font-semibold text-primary-foreground"
                    : "border-border bg-background hover:bg-muted",
                  RADIO_ITEM,
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        {onClear !== undefined && value !== null && !disabled ? (
          <Button type="button" variant="ghost" size="sm" aria-label={`Togli il valore: ${label}`} onClick={onClear}>
            Togli
          </Button>
        ) : null}
      </div>
      {hint === undefined ? null : (
        <p id={`${id}-nota`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={`${id}-errore`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Una scelta fatta e non ancora nella vista: si vede subito, e vale finché la vista porta il valore di prima;
 * se il server rifiuta (`reset`) o la vista porta un altro valore, vale il server.
 */
export function useChosen<V>(value: V) {
  const [chosen, setChosen] = useState<{ value: V; since: V } | null>(null);
  return {
    shown: chosen !== null && chosen.since === value ? chosen.value : value,
    choose: (next: V) => setChosen({ value: next, since: value }),
    reset: () => setChosen(null),
  };
}

/**
 * Una riga che si modifica a pezzi e si salva intera a ogni pezzo (la risposta di una voce dello screening, la
 * disfunzione di una regione): ogni modifica parte dalla riga mostrata, non dalla vista, così due modifiche di fila
 * non si cancellano a vicenda mentre la prima è ancora in coda. La riga mostrata torna quella della vista quando la
 * vista porta l'ultima riga inviata (`same`, come la riscrive il server), quando non c'è niente in volo, o dopo un
 * rifiuto (`reset`). `source` è il dato della vista: una vista nuova è un oggetto nuovo. `initial` cambia solo la riga
 * mostrata all'inizio (una proposta, come il lato toccato sulla sagoma), che parte col primo gesto.
 */
export function useRowDraft<S, R>(
  source: S,
  toRow: (source: S) => R,
  same: (a: R, b: R) => boolean,
  initial: (row: R) => R = (row) => row,
) {
  const [state, setState] = useState(() => ({ source, row: initial(toRow(source)), sent: null as R | null }));
  let current = state;
  if (state.source !== source) {
    const server = toRow(source);
    current = state.sent === null || same(server, state.sent) ? { source, row: server, sent: null } : { ...state, source };
    setState(current);
  }
  return {
    row: current.row,
    /** Una riga inviata: si vede finché la vista non la porta. */
    send: (row: R) => setState((s) => ({ ...s, row, sent: row })),
    /** Una riga tenuta qui senza invio (una regione nuova che non si salva ancora). */
    edit: (row: R) => setState((s) => ({ ...s, row })),
    /** Dopo un rifiuto: torna la riga della vista. */
    reset: () => setState((s) => ({ ...s, row: toRow(s.source), sent: null })),
  };
}

/**
 * Una bozza che vive solo nella pagina (il modulo di un test libero, il nome di un'altra tecnica) e non è ancora partita:
 * finché `dirty` è vero, uscire dalla pagina chiede conferma, come per un testo scritto da meno di 800 ms.
 */
export function useUnsavedDraft(dirty: boolean): void {
  const [owner] = useState(() => ({}));
  useEffect(() => markUnsaved(owner, dirty), [owner, dirty]);
  useEffect(() => () => markUnsaved(owner, false), [owner]);
}

/**
 * Una scelta che salva subito e tiene da sé la frase del rifiuto: `onSave` riceve il valore scelto (`null` per
 * «Togli») e le opzioni per la chiamata in coda. Dopo un rifiuto il focus torna sulla voce che tiene il punto d'ingresso.
 */
export function ChoiceField<T extends string>({
  onSave,
  clearable,
  value,
  ...props
}: {
  id: string;
  label: string;
  items: readonly ChoiceItem<T>[];
  value: T | null;
  disabled?: boolean;
  required?: boolean;
  hideLabel?: boolean;
  hint?: string;
} & (
  | { clearable: true; onSave: (value: T | null, options: RunOptions) => void }
  | { clearable?: false; onSave: (value: T, options: RunOptions) => void }
)) {
  const [error, setError] = useState<string | undefined>(undefined);
  const { shown, choose, reset } = useChosen<T | null>(value);

  const save = (next: T | null) => {
    setError(undefined);
    choose(next);
    // Senza `clearable` il valore non è mai `null`: la scelta si cambia, non si toglie.
    (onSave as (value: T | null, options: RunOptions) => void)(next, {
      onRefused: (failure) => {
        reset();
        setError(refusalText(failure));
        const group = document.getElementById(props.id);
        refocusIfIdle(group, group?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ?? null);
      },
    });
  };

  return (
    <ChoiceGroup
      {...props}
      value={shown}
      error={error}
      onChange={save}
      onClear={clearable ? () => save(null) : undefined}
    />
  );
}

/** «Sì» e «No»: due voci per i campi vero o falso. */
export const YES_NO = [
  { value: "si", label: "Sì" },
  { value: "no", label: "No" },
] as const;

/**
 * Un elenco a discesa che salva subito (la regione principale, il medico inviante): etichetta visibile, scelta
 * subito visibile, frase del rifiuto sotto il campo e focus sul pulsante dopo un rifiuto.
 */
export function SelectField<T extends string>({
  id,
  label,
  items,
  value,
  placeholder,
  onSave,
  disabled = false,
  required = false,
  hint,
}: {
  id: string;
  label: string;
  items: readonly ChoiceItem<T>[];
  value: T | null;
  placeholder: string;
  onSave: (value: T, options: RunOptions) => void;
  disabled?: boolean;
  required?: boolean;
  hint?: string;
}) {
  const [error, setError] = useState<string | undefined>(undefined);
  const { shown, choose, reset } = useChosen<T | null>(value);

  return (
    <Field id={id} label={label} required={required} error={error} hint={hint}>
      <Select
        items={items}
        value={shown}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === null) return;
          setError(undefined);
          choose(next);
          onSave(next, {
            onRefused: (failure) => {
              reset();
              setError(refusalText(failure));
              refocusIfIdle(document.getElementById(id));
            },
          });
        }}
      >
        <SelectTrigger id={id} className="w-full" {...described(id, error, hint !== undefined)}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
