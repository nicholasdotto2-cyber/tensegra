"use client";

import { CircleCheck, Pencil } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type { VisitEditor } from "@/server/domain/visits/editor";

import { SaveIndicator } from "./save-indicator";
import type { SaveState } from "./use-visit-save";

// La barra in alto dell'editor della visita: la data nel formato dei titoli («lunedì 2 novembre 2026»),
// il paziente con il link alla sua Cartella, il tipo, il ciclo con la seduta, lo stato della visita e lo stato del
// salvataggio; accanto, le azioni della visita che l'editor sceglie per il suo modo (`actions`: in bozza "Copia dalla
// visita precedente" e "Chiudi la visita", chiusa «Rettifica»). Sotto i 768 px il pulsante a sinistra del titolo apre
// la sidebar, come nelle altre pagine.

export function TopBar({
  editor,
  saveState,
  onRetry,
  refusal,
  actions,
}: {
  editor: VisitEditor;
  saveState: SaveState;
  onRetry: () => void;
  /** Il messaggio dell'ultimo rifiuto, o null. */
  refusal: string | null;
  /** Le azioni sulla visita: copia e chiusura in bozza, «Rettifica» a visita chiusa. */
  actions?: ReactNode;
}) {
  const { visit, patient, cycle } = editor;
  const closed = visit.status === "closed";
  const StatusIcon = closed ? CircleCheck : Pencil;
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 items-start gap-2">
        <SidebarTrigger className="md:hidden" />
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            <time dateTime={visit.visitDate}>{visit.dateText}</time>
          </h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <Link
              href={`/pazienti/${visit.patientId}?tab=cartella`}
              prefetch={false}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {patient.name}
            </Link>
            <span>{visit.kindLabel}</span>
            <span>{cycle.title}</span>
            {cycle.sessionText === null ? null : <span>{cycle.sessionText}</span>}
            <Badge variant={closed ? "secondary" : "outline"}>
              <StatusIcon aria-hidden="true" data-icon="inline-start" />
              {closed ? "Chiusa" : "Bozza"}
            </Badge>
            {visit.amendedText === null ? null : <span>{visit.amendedText}</span>}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        {actions}
        <SaveIndicator state={saveState} onRetry={onRetry} message={refusal} />
      </div>
    </header>
  );
}
