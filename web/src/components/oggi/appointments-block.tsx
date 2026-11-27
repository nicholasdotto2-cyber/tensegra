import {
  Ban,
  CalendarClock,
  CheckCheck,
  CircleCheck,
  ClipboardPen,
  FileWarning,
  IdCard,
  type LucideIcon,
  TimerOff,
  TriangleAlert,
  UserX,
} from "lucide-react";
import Link from "next/link";

import type { ServiceOption } from "@/components/agenda/appointment-dialog";
import { AppointmentRowActions } from "@/components/oggi/appointment-row-actions";
import { BlockCard } from "@/components/oggi/block-card";
import { BlockError } from "@/components/oggi/block-error";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { type AppointmentStatus, isActive, SIGNAL_LABEL, type Signal, STATUS_LABEL } from "@/lib/agenda/status";
import { datetimeAttr, timeOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Settled } from "@/server/db/settle";
import type { DayAppointmentRow } from "@/server/domain/appointments/queries";

// Blocco 1 di Oggi: la giornata per orario. Stato e segnali (anche «Consenso revocato il 20/10»)
// sono sempre testo più icona (WCAG 1.4.1); success e warning solo come sfondo con il loro -foreground. Le azioni di riga
// ("Segna come fatta", "Saltato", il menu con "Sposta", "Annulla appuntamento", "Apri la visita" e "Apri scheda paziente") stanno in
// `AppointmentRowActions`, un client component che riceve solo dati serializzabili.

const TITLE = "Appuntamenti di oggi";
const CONSENT_REFUSED = "Consenso al trattamento rifiutato";

const STATUS_ICON: Record<AppointmentStatus, LucideIcon> = {
  prenotato: CalendarClock,
  confermato: CircleCheck,
  fatto: CheckCheck,
  saltato: UserX,
  annullato: Ban,
};

const SIGNAL_ICON: Record<Signal, LucideIcon> = {
  consenso_mancante: FileWarning,
  anagrafica_da_completare: IdCard,
  visita_da_compilare: ClipboardPen,
  da_chiudere: TimerOff,
  avviso_clinico: TriangleAlert,
};

function StatusBadge({ status }: { status: AppointmentStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge
      variant={status === "confermato" || status === "fatto" ? "secondary" : "outline"}
      className={cn(status === "fatto" && "bg-success text-success-foreground")}
    >
      <Icon aria-hidden="true" />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

function SignalBadge({ signal }: { signal: Signal }) {
  const Icon = SIGNAL_ICON[signal];
  return (
    <Badge className="bg-warning text-warning-foreground">
      <Icon aria-hidden="true" />
      {SIGNAL_LABEL[signal]}
    </Badge>
  );
}

interface Booking {
  services: readonly ServiceOption[];
  defaultIntervalWeeks: number;
  defaultExpectedSessions: number;
}

function AppointmentItem({ row, booking }: { row: DayAppointmentRow; booking: Booking }) {
  const cancelled = row.status === "annullato";
  const detail = row.sessionLabel === null ? row.serviceName : `${row.serviceName} · ${row.sessionLabel}`;

  // La riga annullata è attenuata con opacity-60 su tutta la riga e resta testo da leggere, quindi
  // vale la WCAG 1.4.3 (4,5:1) sul colore già mescolato con la card. A quell'opacità il foreground tiene
  // (4,73:1 chiaro, 6,40 scuro), il muted-foreground no (2,56 e 3,40) e nemmeno il segnale warning
  // (2,85 chiaro): per questo la riga annullata scrive la prestazione in foreground e non mostra segnali.
  return (
    <li className={cn("grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 py-3 first:pt-0 last:pb-0", cancelled && "opacity-60")}>
      <p className="text-sm font-medium tabular-nums">
        <time dateTime={datetimeAttr(row.startsAt)}>{timeOf(row.startsAt)}</time>-
        <time dateTime={datetimeAttr(row.endsAt)}>{timeOf(row.endsAt)}</time>
      </p>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("font-medium", cancelled && "line-through")}>{row.patientLabel}</span>
          <StatusBadge status={row.status} />
        </div>
        <p className={cn("text-sm", cancelled ? "text-foreground line-through" : "text-muted-foreground")}>{detail}</p>
        {!cancelled && (row.signals.length > 0 || row.consentRevocationText !== null || row.consentRefused) ? (
          <div className="flex flex-wrap gap-1.5">
            {row.signals.map((signal) => (
              <SignalBadge key={signal} signal={signal} />
            ))}
            {/* Revoca (con la data) o rifiuto del consenso al trattamento del ciclo: il trattamento è
                bloccato, al posto di «Consenso mancante»; l'appuntamento resta. */}
            {row.consentRevocationText === null && !row.consentRefused ? null : (
              <Badge variant="destructive">
                <Ban aria-hidden="true" />
                {row.consentRevocationText ?? CONSENT_REFUSED}
              </Badge>
            )}
          </div>
        ) : null}
        {/* Sempre montato, anche senza pulsanti: tiene il pannello e i dialoghi che ha aperto quando la
            riga, aggiornata dopo l'azione, non ammette più le sue azioni (una seduta appena fatta). */}
        <AppointmentRowActions
          row={{
            id: row.id,
            patientId: row.patientId,
            actions: row.actions,
            doneQuestion: row.doneQuestion,
            canOpenVisit: row.canOpenVisit,
          }}
          {...booking}
        />
      </div>
    </li>
  );
}

export function AppointmentsBlock({
  state,
  closedDay,
  today,
  services,
  defaultIntervalWeeks,
  defaultExpectedSessions,
}: {
  state: Settled<DayAppointmentRow[]>;
  closedDay: boolean;
  today: string;
} & Booking) {
  if (!state.ok) {
    return (
      <BlockCard title={TITLE} count={null}>
        <BlockError />
      </BlockCard>
    );
  }

  const rows = state.value;
  const activeCount = rows.filter((row) => isActive(row.status)).length;

  return (
    <BlockCard title={TITLE} count={activeCount}>
      {rows.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground">{closedDay ? "Oggi lo studio è chiuso." : "Oggi non hai appuntamenti."}</p>
          {/* Pagina dinamica con i dati dello studio, come le voci della sidebar: niente prefetch. */}
          <Link
            href={`/agenda?vista=giorno&data=${today}`}
            prefetch={false}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            Apri l&apos;agenda
          </Link>
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <AppointmentItem key={row.id} row={row} booking={{ services, defaultIntervalWeeks, defaultExpectedSessions }} />
          ))}
        </ul>
      )}
    </BlockCard>
  );
}
