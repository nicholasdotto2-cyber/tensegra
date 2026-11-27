"use client";

import { CircleCheck, Clock, type LucideIcon, TriangleAlert } from "lucide-react";
import { useId } from "react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { dayShort } from "@/lib/format";
import type { PreviewRow } from "@/server/domain/appointments/queries";

// L'anteprima della serie: una riga per data con "Libero", "Si
// sovrappone a ...", "Fuori orario" o "Giorno chiuso" e una casella per includerla. Le righe nascono
// tutte spuntate; "Salva" crea solo le date spuntate. Lo stato è sempre testo più icona; quelli che
// chiedono attenzione stanno su sfondo `warning` col suo testo.

const STATE_ICON: Record<PreviewRow["state"], LucideIcon> = {
  libero: CircleCheck,
  sovrapposto: TriangleAlert,
  giorno_chiuso: Clock,
  fuori_orario: Clock,
};

export function SeriesPreview({
  rows,
  excluded,
  invalid = false,
  onToggle,
}: {
  rows: readonly PreviewRow[];
  /** Le date tolte dall'utente. */
  excluded: ReadonlySet<string>;
  /** Nessuna data spuntata: «Scegli almeno una data.» sta sotto l'elenco. */
  invalid?: boolean;
  onToggle: (day: string, included: boolean) => void;
}) {
  const baseId = useId();
  return (
    <ul className="divide-y rounded-lg border">
      {rows.map((row) => {
        const Icon = STATE_ICON[row.state];
        const free = row.state === "libero";
        const dateId = `${baseId}-${row.day}`;
        return (
          <li key={row.day} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <Label className="min-h-6 font-normal">
              <Checkbox
                checked={!excluded.has(row.day)}
                aria-labelledby={dateId}
                aria-invalid={invalid || undefined}
                onCheckedChange={(checked) => onToggle(row.day, checked)}
              />
              <time id={dateId} dateTime={`${row.day}T${row.time}`} className="tabular-nums">
                {`${dayShort(row.day)}, ${row.time}`}
              </time>
            </Label>
            {free ? (
              <span className="ml-auto flex items-center gap-1 text-sm">
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                {row.label}
              </span>
            ) : (
              <Badge className="ml-auto bg-warning text-warning-foreground">
                <Icon aria-hidden="true" />
                {row.label}
              </Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}
