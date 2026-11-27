"use client";

import { type ChangeEvent, type ReactNode, type Ref, useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

// I pezzi che i moduli a sezioni hanno in comune, quelli di Impostazioni e quelli dell'anagrafica
// del paziente, con le regole di accessibilità: etichetta, campo ed errore con i loro id, l'elenco a discesa
// con l'etichetta, il "Salva" con l'errore generale, e lo stato di un modulo (valori, errori per campo, focus
// al primo campo in errore, modifiche non salvate). Ogni modulo salva da solo la sua sezione.

export const REQUIRED = "Campo obbligatorio.";
const NOT_SAVED = "Non ho salvato le modifiche. Riprova.";
const SAVED = "Modifiche salvate.";

/** Gli attributi del campo per la sua nota e il suo errore: `aria-describedby` punta a entrambi. */
export function described(id: string, error: string | undefined, hasHint = false) {
  const ids = [hasHint ? `${id}-nota` : null, error === undefined ? null : `${id}-errore`].filter(Boolean);
  return {
    "aria-invalid": error === undefined ? undefined : true,
    "aria-describedby": ids.length === 0 ? undefined : ids.join(" "),
  } as const;
}

/** Etichetta visibile sopra il campo, "(obbligatorio)" scritto, nota facoltativa e l'errore sotto il campo. */
export function Field({
  id,
  label,
  error,
  required = false,
  optional = false,
  hint,
  srOnlyLabel,
  className,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  required?: boolean;
  optional?: boolean;
  hint?: string;
  /** Il seguito dell'etichetta solo per i lettori di schermo: "Inizio" e " della prima fascia". */
  srOnlyLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {srOnlyLabel === undefined ? null : <span className="sr-only">{srOnlyLabel}</span>}
        {required ? <span className="font-normal text-muted-foreground">(obbligatorio)</span> : null}
        {optional ? <span className="font-normal text-muted-foreground">(facoltativo)</span> : null}
      </Label>
      {children}
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

/** Un elenco a discesa con la sua etichetta e il suo errore: il pulsante porta l'id del campo. */
export function ChoiceSelect<T extends string>({
  id,
  label,
  items,
  value,
  onChange,
  error,
  required = false,
  readOnly = false,
  triggerRef,
}: {
  id: string;
  label: string;
  items: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  error: string | undefined;
  required?: boolean;
  /** Il valore si vede ma non si cambia (la lettera già salvata). */
  readOnly?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <Field id={id} label={label} required={required} error={error}>
      <Select
        items={items}
        value={value}
        readOnly={readOnly}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger id={id} ref={triggerRef} className="w-full" {...described(id, error)}>
          <SelectValue />
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

/** Il "Salva" della sezione, con l'errore generale (quello che non appartiene a un campo) sopra. */
export function SaveBar({
  saving,
  formError,
  label = "Salva",
  failTitle = NOT_SAVED,
}: {
  saving: boolean;
  formError: string | null;
  label?: string;
  failTitle?: string;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      {formError === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>{failTitle}</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={saving}>
        {label}
      </Button>
    </div>
  );
}

type StringKeys<V> = { [K in keyof V]: V[K] extends string ? K : never }[keyof V] & string;

/**
 * Lo stato di un modulo di sezione, più il ref del `<form>` per il focus al primo errore. `values` parte da `initial`; `dirty` dice se differiscono dall'ultimo
 * stato salvato (i valori sono tutti serializzabili in JSON). `fail` mostra gli errori del comando sotto
 * i campi e porta il focus sul primo; `done` registra i valori salvati come nuovo punto di partenza.
 */
export function useSectionForm<V extends object>(initial: V) {
  const baseId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<V>(initial);
  const [saved, setSaved] = useState<V>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [errorsShown, setErrorsShown] = useState(0);
  const [saving, startSaving] = useTransition();

  // Dopo un salvataggio rifiutato il focus va al primo campo in errore, nell'ordine della pagina.
  useEffect(() => {
    if (errorsShown === 0) return;
    formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [errorsShown]);

  const idOf = (field: string) => `${baseId}-${field.replaceAll(".", "-")}`;
  const set = <K extends keyof V>(key: K, value: V[K]) => setValues((current) => ({ ...current, [key]: value }));

  const showErrors = (next: Record<string, string>) => {
    setErrors(next);
    setFormError(null);
    setErrorsShown((n) => n + 1);
  };

  const form = {
    values,
    set,
    setValues,
    errors,
    formError,
    saving,
    startSaving,
    idOf,
    dirty: JSON.stringify(values) !== JSON.stringify(saved),
    showErrors,
    /** Toglie l'errore di un campo che chi scrive ha appena corretto, senza spostare il focus. */
    clearError(key: string) {
      setErrors((current) => {
        if (!(key in current)) return current;
        return Object.fromEntries(Object.entries(current).filter(([field]) => field !== key));
      });
    },
    fail(result: { message: string; fieldErrors?: Record<string, string> }) {
      if (result.fieldErrors !== undefined && Object.keys(result.fieldErrors).length > 0) {
        showErrors(result.fieldErrors);
      } else {
        setErrors({});
        setFormError(result.message);
      }
    },
    /** Cambia i valori che il server ha cambiato da solo (un altro genitore diventa contatto): vale anche come stato salvato, il resto resta com'è. */
    patch(part: Partial<V>) {
      setValues((current) => ({ ...current, ...part }));
      setSaved((current) => ({ ...current, ...part }));
    },
    done(next: V) {
      setValues(next);
      setSaved(next);
      setErrors({});
      setFormError(null);
      toast.success(SAVED);
    },
    /** Gli attributi di un campo di testo: id, valore, modifica e descrizione dell'errore. */
    text<K extends StringKeys<V>>(key: K, hasHint = false) {
      return {
        id: idOf(key),
        value: values[key] as string,
        onChange: (event: ChangeEvent<HTMLInputElement>) => set(key, event.target.value as V[K]),
        ...described(idOf(key), errors[key], hasHint),
      };
    },
  };
  // Il riferimento al `form` HTML sta fuori dall'oggetto: chi lo legge in render lo scambierebbe per un ref.
  return [form, formRef] as const;
}

/**
 * Dice a chi sta sopra se questo modulo è modificato, per un solo `UnsavedGuard` su più moduli: `report`
 * (stabile) riceve la chiave del modulo e il suo `dirty`; quando il modulo sparisce torna `false`.
 */
export function useReportDirty(report: (key: string, dirty: boolean) => void, key: string, dirty: boolean) {
  useEffect(() => {
    report(key, dirty);
  }, [report, key, dirty]);
  useEffect(() => () => report(key, false), [report, key]);
}
