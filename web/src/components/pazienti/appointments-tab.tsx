"use client";

import Link from "next/link";

import { STATUS_ICON } from "@/components/agenda/appointment-block";
import { OpenVisitButton } from "@/components/cartella/open-visit";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AppointmentLine, PatientAppointments } from "@/server/domain/patients/card";

// La tab Appuntamenti: i futuri in alto dal più vicino, i passati sotto dal
// più recente, annullati e saltati attenuati al loro posto; i contatori «3 fatti, 1 saltato, 0 annullati»; il
// link alla visita se c'è e quello alla fattura emessa della seduta («Fattura 273/2026»). Un
// `fatto` ancora senza visita offre "Compila ora", che apre la visita (o la crea) e porta all'editor.

const NO_FUTURE = "Nessun appuntamento futuro.";
const NO_PAST = "Nessun appuntamento passato.";

function Line({ line, patientId }: { line: AppointmentLine; patientId: string }) {
  const Icon = STATUS_ICON[line.status];
  return (
    <li className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0", line.muted && "text-muted-foreground")}>
      <time dateTime={line.at} className="min-w-40 font-medium tabular-nums">
        {`${line.dayText} alle ${line.timeText}`}
      </time>
      <span>{line.serviceName}</span>
      <span className="flex items-center gap-1">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {line.statusLabel}
      </span>
      {line.visit !== null ? (
        <Link
          href={`/pazienti/${patientId}/visite/${line.visit.id}`}
          prefetch={false}
          className={buttonVariants({ variant: "link", size: "sm" })}
        >
          {line.visit.status === "draft" ? "Apri la visita" : "Vedi la visita"}
        </Link>
      ) : line.status === "fatto" ? (
        <OpenVisitButton appointmentId={line.id} label="Compila ora" variant="link" />
      ) : null}
      {line.invoice === null ? null : (
        <Link
          href={`/fatture/${line.invoice.id}`}
          prefetch={false}
          className={buttonVariants({ variant: "link", size: "sm" })}
        >
          {`Fattura ${line.invoice.numberLabel}`}
        </Link>
      )}
    </li>
  );
}

function Group({
  title,
  empty,
  lines,
  patientId,
}: {
  title: string;
  empty: string;
  lines: AppointmentLine[];
  patientId: string;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="text-base font-medium">{title}</h2>
      {lines.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y">
          {lines.map((line) => (
            <Line key={line.id} line={line} patientId={patientId} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function AppointmentsTabView({ tab, patientId }: { tab: PatientAppointments; patientId: string }) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground">{tab.countsText}</p>
      <Group title="Futuri" empty={NO_FUTURE} lines={tab.future} patientId={patientId} />
      <Group title="Passati" empty={NO_PAST} lines={tab.past} patientId={patientId} />
    </div>
  );
}
