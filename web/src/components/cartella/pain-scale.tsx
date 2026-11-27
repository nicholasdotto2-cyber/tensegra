"use client";

import { type KeyboardEvent, useRef } from "react";

import { RADIO_ITEM, radioKeyTarget } from "@/components/cartella/scale-parts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// La scala del dolore 0-10: 11 pulsanti in un `role="radiogroup"`
// col nome dall'etichetta visibile. Tabindex mobile: si entra con Tab sul valore scelto (o sullo 0 se non c'è),
// le frecce passano al vicino e lo scelgono, Home e Fine vanno agli estremi, le cifre 0-9 scelgono quel
// valore, Canc toglie il valore. Il dolore è facoltativo (`nprs_*` null): con un valore
// scelto, fuori dal gruppo, «Togli» lo toglie anche col mouse o col tocco, e il focus torna sullo 0.

const VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const CLEAR = "Togli";

export function PainScale({
  id,
  label,
  value,
  onChange,
  disabled = false,
  describedBy,
  invalid = false,
}: {
  id: string;
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  /** L'id della frase di un errore sotto la scala: `aria-describedby` e `aria-invalid` del gruppo. */
  describedBy?: string;
  invalid?: boolean;
}) {
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const labelId = `${id}-label`;
  const tabStop = value ?? 0;

  const choose = (v: number) => {
    onChange(v);
    items.current[v]?.focus();
  };

  // Senza valore il punto d'ingresso del gruppo è lo 0: il focus va lì, non resta su un pulsante che sparisce.
  const clear = () => {
    onChange(null);
    items.current[0]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Delete") {
      event.preventDefault();
      clear();
      return;
    }
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      choose(Number(event.key));
      return;
    }
    const next = radioKeyTarget(event.key, index, VALUES.length);
    if (next !== null) {
      event.preventDefault();
      choose(next);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <div id={id} role="radiogroup" aria-labelledby={labelId} aria-disabled={disabled || undefined} aria-describedby={describedBy} aria-invalid={invalid || undefined} className="flex flex-wrap gap-1">
          {VALUES.map((v) => {
            const checked = value === v;
            return (
              <button
                key={v}
                ref={(el) => {
                  items.current[v] = el;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={v === tabStop ? 0 : -1}
                disabled={disabled}
                onClick={() => onChange(v)}
                onKeyDown={(event) => onKeyDown(event, v)}
                className={cn(
                  "inline-flex size-8 items-center justify-center rounded-md border text-sm tabular-nums",
                  checked
                    ? "border-primary bg-primary font-semibold text-primary-foreground"
                    : "border-border bg-background hover:bg-muted",
                  RADIO_ITEM,
                )}
              >
                {v}
              </button>
            );
          })}
        </div>
        {value !== null && !disabled ? (
          <Button type="button" variant="ghost" size="sm" aria-label={`Togli il valore: ${label}`} onClick={clear}>
            {CLEAR}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
