"use client";

import { Ellipsis } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  appointmentDetailAction,
  markDoneAction,
  markSkippedAction,
  undoSkippedAction,
} from "@/app/(app)/agenda/actions";
import { AppointmentDialog, type ServiceOption } from "@/components/agenda/appointment-dialog";
import { CancelDialog } from "@/components/agenda/cancel-dialog";
import { DoneConfirm } from "@/components/agenda/done-confirm";
import { SedutaFattaPanel } from "@/components/agenda/seduta-fatta-panel";
import { useOpenVisit } from "@/components/cartella/open-visit";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { overlapWarning } from "@/lib/agenda/slots";
import { ACTION_LABEL, type AppointmentAction } from "@/lib/agenda/status";
import { patientHref } from "@/lib/patients/params";
import type { AppointmentDetail } from "@/server/domain/appointments/queries";

// Le azioni di una riga di "Appuntamenti di oggi": "Segna come fatta" e "Saltato"
// quando la riga li ammette, "Annulla 'saltato'" su un saltato dato per errore (senza conferma, si torna
// indietro), poi il menu con "Sposta" e "Annulla appuntamento" quando ammessi, "Apri la visita" per un
// appuntamento su cui la visita si può aprire e "Apri scheda paziente" sempre. Ognuna apre da sé
// ciò che le serve: la domanda prima dell'inizio, il pannello "Seduta fatta", il dialogo di modifica (che
// legge l'appuntamento col dettaglio), quello di annullamento (che legge le successive della serie), l'editor
// della visita e la scheda. La riga arriva dal blocco server con soli dati serializzabili.

const MOVE = "Sposta";
const OPEN_VISIT = "Apri la visita";
const OPEN_PATIENT = "Apri scheda paziente";

export function AppointmentRowActions({
  row,
  services,
  defaultIntervalWeeks,
  defaultExpectedSessions,
}: {
  row: { id: string; patientId: string; actions: AppointmentAction[]; doneQuestion: string | null; canOpenVisit: boolean };
  services: readonly ServiceOption[];
  defaultIntervalWeeks: number;
  defaultExpectedSessions: number;
}) {
  const router = useRouter();
  const [askDone, setAskDone] = useState(false);
  const [doneId, setDoneId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // L'appuntamento letto per "Sposta": resta anche a dialogo chiuso, che si chiude col suo contenuto.
  const [moving, setMoving] = useState<AppointmentDetail | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [busy, startBusy] = useTransition();
  const visit = useOpenVisit(row.id);
  const booking = { services, defaultIntervalWeeks, defaultExpectedSessions };
  const can = (action: AppointmentAction) => row.actions.includes(action);

  const fail = (result: { message: string; conflict?: true }) => {
    toast.error(result.message);
    if (result.conflict) router.refresh();
  };

  const markDone = () =>
    startBusy(async () => {
      const result = await markDoneAction(row.id);
      if (result.ok) setDoneId(row.id);
      else fail(result);
    });

  const markSkipped = () =>
    startBusy(async () => {
      const result = await markSkippedAction(row.id);
      if (!result.ok) fail(result);
    });

  const undoSkipped = () =>
    startBusy(async () => {
      const result = await undoSkippedAction(row.id);
      if (!result.ok) fail(result);
      else if (result.data.overlap !== null) toast(overlapWarning(result.data.overlap));
    });

  const move = () =>
    startBusy(async () => {
      const result = await appointmentDetailAction(row.id);
      if (!result.ok) fail(result);
      else if (result.data === null) router.refresh();
      else {
        setMoving(result.data);
        setMoveOpen(true);
      }
    });

  // Il componente resta montato anche quando la riga non ha più pulsanti (dopo "Segna come fatta" la
  // seduta è fatta e ammette solo "Annulla 'fatto'", che sta nel dettaglio): così il pannello e i dialoghi
  // aperti da qui sopravvivono all'aggiornamento della riga. Il menu c'è sempre: "Apri scheda paziente".
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {can("segna_fatta") ? (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => (row.doneQuestion === null ? markDone() : setAskDone(true))}
          >
            {ACTION_LABEL.segna_fatta}
          </Button>
        ) : null}
        {can("saltato") ? (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={markSkipped}>
            {ACTION_LABEL.saltato}
          </Button>
        ) : null}
        {can("annulla_saltato") ? (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={undoSkipped}>
            {ACTION_LABEL.annulla_saltato}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" size="icon-sm" variant="ghost" aria-label="Menu" />}
            disabled={busy || visit.pending}
          >
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto">
            {can("modifica") ? <DropdownMenuItem onClick={move}>{MOVE}</DropdownMenuItem> : null}
            {can("annulla") ? (
              <DropdownMenuItem onClick={() => setCancelling(true)}>{ACTION_LABEL.annulla}</DropdownMenuItem>
            ) : null}
            {row.canOpenVisit ? <DropdownMenuItem onClick={visit.open}>{OPEN_VISIT}</DropdownMenuItem> : null}
            <DropdownMenuLinkItem render={<Link href={patientHref(row.patientId)} prefetch={false} />}>
              {OPEN_PATIENT}
            </DropdownMenuLinkItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {row.doneQuestion === null ? null : (
        <DoneConfirm open={askDone} question={row.doneQuestion} onOpenChange={setAskDone} onConfirm={markDone} />
      )}
      <SedutaFattaPanel appointmentId={doneId} onClose={() => setDoneId(null)} {...booking} />
      <CancelDialog appointmentId={cancelling ? row.id : null} onClose={() => setCancelling(false)} />
      {moving === null ? null : (
        <AppointmentDialog
          open={moveOpen}
          onOpenChange={setMoveOpen}
          {...booking}
          mode={{ kind: "edit", detail: moving }}
        />
      )}
    </>
  );
}
