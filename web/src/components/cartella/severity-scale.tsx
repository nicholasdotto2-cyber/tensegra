"use client";

import { Check } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";

import { RADIO_ITEM, radioKeyTarget, SeverityBadge } from "@/components/cartella/scale-parts";
import type { SeverityLevel } from "@/lib/clinical/body-map";
import { SEVERITY_LABEL } from "@/lib/clinical/labels";
import { cn } from "@/lib/utils";

// La severità della regione nel pannello: un `role="radiogroup"` di 4
// voci, «0 Assente o di fondo» ... «3 Marcata (disfunzione primaria)», con le etichette di `SEVERITY_LABEL`.
// Tastiera come `PainScale`: tabindex mobile, le frecce passano alla voce vicina e la scelgono, Home e Fine
// vanno agli estremi. Ogni voce ha il numero nel colore del suo livello, come nella sagoma; la voce scelta ha
// anche la spunta, così la scelta non si legge dal solo colore.

const LEVELS: readonly SeverityLevel[] = [0, 1, 2, 3];

const GROUP_LABEL = "Severità";

export function SeverityScale({
  id,
  value,
  onChange,
  disabled = false,
  describedBy,
  invalid = false,
}: {
  id: string;
  value: SeverityLevel | null;
  onChange: (v: SeverityLevel) => void;
  disabled?: boolean;
  /** L'id della frase di un errore sotto la scala: `aria-describedby` e `aria-invalid` del gruppo, come `PainScale`. */
  describedBy?: string;
  invalid?: boolean;
}) {
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const labelId = `${id}-label`;
  const tabStop = value ?? 0;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const next = radioKeyTarget(event.key, index, LEVELS.length);
    if (next === null) return;
    event.preventDefault();
    const level = LEVELS[next];
    if (level === undefined) return;
    onChange(level);
    items.current[next]?.focus();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium">
        {GROUP_LABEL}
      </span>
      <div
        id={id}
        role="radiogroup"
        aria-labelledby={labelId}
        aria-disabled={disabled || undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className="flex flex-col gap-1"
      >
        {LEVELS.map((level) => {
          const checked = value === level;
          return (
            <button
              key={level}
              ref={(el) => {
                items.current[level] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={level === tabStop ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(level)}
              onKeyDown={(event) => onKeyDown(event, level)}
              className={cn(
                "flex min-h-10 items-center gap-2 rounded-lg border px-2 text-left text-sm",
                checked ? "border-primary bg-muted font-medium ring-1 ring-primary" : "border-border bg-background hover:bg-muted",
                RADIO_ITEM,
              )}
            >
              <SeverityBadge severity={level} />
              <span className="min-w-0 flex-1">
                <span className="sr-only">{`${level} `}</span>
                {SEVERITY_LABEL[level]}
              </span>
              {checked ? <Check aria-hidden="true" className="size-4 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
