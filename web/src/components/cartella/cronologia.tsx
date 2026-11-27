import { CircleCheck, Pencil, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId } from "react";

import { OpenVisitButton } from "@/components/cartella/open-visit";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import type { CartellaTab, SessionLine } from "@/server/domain/cartella/queries";

// La vista "Cronologia" della Cartella: i cicli dal più recente, ciascuno con il
// titolo, lo stato e le sue sedute in ordine di data. Una visita ha data, tipo, dolore a inizio e fine seduta, le
// regioni trattate, "Bozza" o "Chiusa" e "Rettificata il ..."; un appuntamento fatto senza visita è una «Seduta
// senza visita» con "Visita da compilare" e "Compila ora". La regola di "Visita da compilare" è una sola
// (fatto senza visita chiusa); la sceglie la query, qui si mostra.

const NO_HISTORY = "Nessun ciclo.";
const NO_SESSIONS = "Nessuna seduta.";

function ToFill() {
  return (
    <Badge className="bg-warning text-warning-foreground">
      <TriangleAlert aria-hidden="true" data-icon="inline-start" />
      Visita da compilare
    </Badge>
  );
}

function Session({ line, patientId }: { line: SessionLine; patientId: string }) {
  if (line.kind === "senza_visita") {
    return (
      <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0">
        <time dateTime={line.day} className="min-w-24 font-medium tabular-nums">
          {line.dateText}
        </time>
        <span>Seduta senza visita</span>
        <ToFill />
        <OpenVisitButton appointmentId={line.appointmentId} label="Compila ora" variant="outline" />
      </li>
    );
  }
  const closed = line.statusLabel === "Chiusa";
  const StatusIcon = closed ? CircleCheck : Pencil;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0">
      <time dateTime={line.day} className="min-w-24 font-medium tabular-nums">
        {line.dateText}
      </time>
      <span>{line.kindLabel}</span>
      {line.painText === null ? null : (
        <span>
          <span className="text-muted-foreground">Dolore 0-10: </span>
          <span className="tabular-nums">{line.painText}</span>
        </span>
      )}
      {line.regionsText === "" ? null : <span>{line.regionsText}</span>}
      <Badge variant={closed ? "secondary" : "outline"}>
        <StatusIcon aria-hidden="true" data-icon="inline-start" />
        {line.statusLabel}
      </Badge>
      {line.amendedText === null ? null : <span className="text-muted-foreground">{line.amendedText}</span>}
      {line.toFill ? <ToFill /> : null}
      <Link
        href={`/pazienti/${patientId}/visite/${line.visitId}`}
        prefetch={false}
        className={buttonVariants({ variant: "link", size: "sm" })}
      >
        {closed ? "Vedi la visita" : "Apri la visita"}
      </Link>
    </li>
  );
}

export function CronologiaView({ history, patientId }: { history: CartellaTab["history"]; patientId: string }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      <h2 id={headingId} className="text-base font-medium">
        Cronologia
      </h2>
      {history.length === 0 ? <p className="text-muted-foreground">{NO_HISTORY}</p> : null}
      {history.map((cycle) => (
        <div key={cycle.id} className="flex flex-col gap-3 rounded-xl p-4 ring-1 ring-foreground/10">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="font-medium">{cycle.title}</h3>
            <p className="text-muted-foreground">{cycle.statusText}</p>
          </div>
          {cycle.sessions.length === 0 ? (
            <p className="text-muted-foreground">{NO_SESSIONS}</p>
          ) : (
            <ul className="divide-y">
              {cycle.sessions.map((line) => (
                <Session key={line.kind === "visita" ? line.visitId : line.appointmentId} line={line} patientId={patientId} />
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
