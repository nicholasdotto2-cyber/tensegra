"use client";

import { useId } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import type { InvoiceComputation } from "@/lib/fiscal/calc";
import { regimeLabel, summaryRows } from "@/lib/fiscal/editor-state";
import { REFERENCES_2027_NOTE } from "@/lib/fiscal/references";
import type { Regime } from "@/lib/fiscal/types";
import { dayField } from "@/lib/format";
import { cn } from "@/lib/utils";

// Il riepilogo dal vivo dell'editor: l'etichetta del regime, ogni passo del calcolo
// fatto nel browser con `computeInvoice`, la data della fattura quando è quella dell'incasso e la nota sui
// riferimenti del 2027.

export const REGIME_CHANGED = "Regime cambiato: importi aggiornati";
const TOTALS = new Set(["Totale", "Netto a pagare"]);

export function EditorSummary({
  regime,
  regimeChanged,
  computation,
  issueDate,
  today,
}: {
  regime: Regime;
  regimeChanged: boolean;
  computation: InvoiceComputation;
  /** La data che avrà la fattura, "AAAA-MM-GG". */
  issueDate: string;
  today: string;
}) {
  const headingId = useId();
  const rows = summaryRows(computation, regime);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border p-4">
      <h3 id={headingId} className="font-medium">
        Riepilogo
      </h3>
      <p className="text-sm text-muted-foreground">{regimeLabel(regime)}</p>
      {regimeChanged ? (
        <Alert>
          <AlertDescription>{REGIME_CHANGED}</AlertDescription>
        </Alert>
      ) : null}
      <div role="status" aria-labelledby={headingId}>
        <dl className="flex flex-col gap-1">
          {rows.map((row) => (
            <div
              key={row.label}
              className={cn("flex justify-between gap-4", TOTALS.has(row.label) && "font-medium")}
            >
              <dt>{row.label}</dt>
              <dd className="tabular-nums">{row.amount}</dd>
            </div>
          ))}
        </dl>
        {issueDate === today ? null : (
          <p className="mt-2 text-sm">{`Data della fattura: ${dayField(issueDate)}, giorno dell'incasso`}</p>
        )}
      </div>
      {issueDate >= "2027-01-01" ? <p className="text-sm text-muted-foreground">{REFERENCES_2027_NOTE}</p> : null}
    </section>
  );
}
