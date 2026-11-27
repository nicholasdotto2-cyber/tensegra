"use client";

import { type ReactNode, useRef, useState } from "react";

import { AppointmentDetailSheet } from "@/components/agenda/appointment-detail";
import {
  AppointmentDialog,
  type AppointmentDialogProps,
  createdDone,
  type ServiceOption,
} from "@/components/agenda/appointment-dialog";
import { SedutaFattaPanel } from "@/components/agenda/seduta-fatta-panel";
import { AgendaToolbar } from "@/components/agenda/toolbar";
import { WeekGrid } from "@/components/agenda/week-grid";
import { MessageComposer } from "@/components/messaggi/message-composer";
import { Button } from "@/components/ui/button";
import type { AgendaBlock } from "@/lib/agenda/grid";
import type { Band } from "@/lib/agenda/slots";
import { minutesLabel } from "@/lib/format";

// La parte interattiva dell'agenda: barra, griglia e lo stato del dialogo
// "Nuovo appuntamento". La pagina server legge i dati e li passa già pronti; le callback della griglia
// nascono qui, perché un Server Component non passa funzioni ai client component. Si apre il dialogo
// dalla barra, dal vuoto della settimana e con un clic su una cella o su una fascia "Chiuso", che
// precompila giorno e ora. Un clic (o Invio) su un blocco apre il dettaglio; dopo "Segna come
// fatta" dal dettaglio, o dopo un appuntamento creato già fatto, si apre il pannello "Seduta fatta".

type View = "giorno" | "settimana";
type Prefill = NonNullable<AppointmentDialogProps["prefill"]>;

const NEW_APPOINTMENT = "Nuovo appuntamento";

export function AgendaView({
  view,
  day,
  label,
  prevDay,
  nextDay,
  today,
  showCancelled,
  days,
  window,
  nowMin,
  todayDay,
  services,
  defaultIntervalWeeks,
  defaultExpectedSessions,
  children,
}: {
  view: View;
  day: string;
  label: string;
  prevDay: string;
  nextDay: string;
  today: string;
  showCancelled: boolean;
  days: { day: string; header: string; bands: readonly Band[]; blocks: AgendaBlock[] }[];
  window: { startMin: number; endMin: number };
  nowMin: number | null;
  todayDay: string;
  services: readonly ServiceOption[];
  defaultIntervalWeeks: number;
  defaultExpectedSessions: number;
  /** Ciò che la pagina mostra fra la barra e la griglia (l'invito a impostare gli orari). */
  children?: ReactNode;
}) {
  const [dialog, setDialog] = useState<{ open: boolean; prefill: Prefill }>({ open: false, prefill: {} });
  const agendaRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const openDialog = (prefill: Prefill, control: HTMLElement | null) => {
    returnFocus.current = control;
    setDialog({ open: true, prefill });
  };
  const [detailId, setDetailId] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const booking = { services, defaultIntervalWeeks, defaultExpectedSessions };
  const emptyWeek = view === "settimana" && days.every((d) => d.blocks.length === 0);

  return (
    <div ref={agendaRef} className="flex min-h-0 flex-1 flex-col gap-4">
      <AgendaToolbar
        view={view}
        day={day}
        label={label}
        prevDay={prevDay}
        nextDay={nextDay}
        today={today}
        showCancelled={showCancelled}
        actions={
          <Button type="button" onClick={(event) => openDialog({}, event.currentTarget)}>
            {NEW_APPOINTMENT}
          </Button>
        }
      />
      {children}
      {emptyWeek ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-muted-foreground">Nessun appuntamento questa settimana.</p>
          <Button type="button" variant="outline" onClick={(event) => openDialog({}, event.currentTarget)}>
            {NEW_APPOINTMENT}
          </Button>
        </div>
      ) : null}
      <WeekGrid
        days={days}
        window={window}
        nowMin={nowMin}
        todayDay={todayDay}
        onCellClick={(cellDay, startMin) => {
          const cell = agendaRef.current?.querySelector<HTMLElement>(`[data-day="${cellDay}"]`) ?? null;
          if (cell) cell.tabIndex = -1;
          openDialog({ day: cellDay, time: minutesLabel(startMin) }, cell);
        }}
        onBlockClick={setDetailId}
      />
      <AppointmentDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))}
        {...booking}
        prefill={dialog.prefill}
        onCreated={(created) => setDoneId(createdDone(created))}
        onConfirmMessage={(created) => setConfirmId(created.appointments[0]?.id ?? null)}
      />
      <AppointmentDetailSheet
        appointmentId={detailId}
        onClose={() => setDetailId(null)}
        onMarkedDone={(id) => {
          setDetailId(null);
          setDoneId(id);
        }}
        {...booking}
      />
      <SedutaFattaPanel appointmentId={doneId} onClose={() => setDoneId(null)} {...booking} />
      {confirmId === null ? null : (
        <MessageComposer
          source={{ kind: "appointment", appointmentId: confirmId, templateKey: "conferma" }}
          onClose={() => {
            setConfirmId(null);
            // Il compositore viene smontato prima di spostare il focus fuori dal suo dialogo.
            requestAnimationFrame(() => {
              const savedDay = days.find((d) => d.blocks.some((b) => b.id === confirmId));
              const saved = savedDay?.blocks.find((b) => b.id === confirmId);
              const column = agendaRef.current?.querySelector<HTMLElement>(`[data-day="${savedDay?.day}"]`);
              const block = saved === undefined ? undefined : Array.from(column?.querySelectorAll<HTMLButtonElement>("button[aria-label]") ?? [])
                .find((button) => button.getAttribute("aria-label")?.startsWith(`${saved.timeRange}, ${saved.patientLabel}, ${saved.serviceName}, `));
              (block ?? (returnFocus.current?.isConnected ? returnFocus.current : null))?.focus();
            });
          }}
        />
      )}
    </div>
  );
}
