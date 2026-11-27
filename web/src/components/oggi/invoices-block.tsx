"use client";

import { useState } from "react";

import { InvoiceEditorSheet } from "@/components/fatture/invoice-editor";
import { BlockCard } from "@/components/oggi/block-card";
import { BlockError } from "@/components/oggi/block-error";
import { Button } from "@/components/ui/button";
import { dayShort, money } from "@/lib/format";
import type { Settled } from "@/server/db/settle";
import type { ToInvoiceRow } from "@/server/domain/invoices/queries";

// Blocco 3 di Oggi: le sedute fatte da fatturare, dalla più vecchia. Ogni
// riga ha "Emetti", che apre l'editor della fattura sulla seduta come pannello laterale: uno solo
// per il blocco, montato anche quando l'elenco si svuota. Chiudere il pannello senza un'azione non salva niente
// e la seduta resta qui; dopo un'emissione la pagina si rilegge con l'azione. Client component:
// la pagina gli passa soli dati serializzabili.

const TITLE = "Fatture da emettere";

export function InvoicesBlock({ state }: { state: Settled<ToInvoiceRow[]> }) {
  const [appointmentId, setAppointmentId] = useState<string | null>(null);

  if (!state.ok) {
    return (
      <BlockCard title={TITLE} count={null}>
        <BlockError />
      </BlockCard>
    );
  }

  const rows = state.value;
  return (
    <BlockCard title={TITLE} count={rows.length}>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">Nessuna fattura da emettere.</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.appointmentId} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{row.patientName}</span>
                <span className="text-sm text-muted-foreground">
                  <time dateTime={row.day}>{dayShort(row.day)}</time>
                  {` · ${row.serviceName}`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="font-medium tabular-nums">{money(row.priceCents)}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => setAppointmentId(row.appointmentId)}>
                  Emetti
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <InvoiceEditorSheet
        start={appointmentId === null ? null : { kind: "appointment", appointmentId }}
        onClose={() => setAppointmentId(null)}
      />
    </BlockCard>
  );
}
