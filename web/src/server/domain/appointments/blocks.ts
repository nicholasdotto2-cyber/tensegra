import type { AgendaBlock } from "@/lib/agenda/grid";
import { lastFirst, timeRange } from "@/lib/format";
import { romeMinutes, todayRome } from "@/server/clock";
import type { AgendaAppointment } from "./queries";

// Da appuntamento a blocco della griglia, sul server: il client riceve
// solo `AgendaBlock`. Giorno e inizio vengono dall'orologio di Roma, così nel giorno di 25 ore del
// 25/10/2026 le 10:00 restano alle 10:00; la fine è l'inizio più la durata, perché nei giorni del cambio
// d'ora l'orologio salta e i minuti no.

const MINUTE_MS = 60_000;

export function toBlock(a: AgendaAppointment): AgendaBlock {
  const startMin = romeMinutes(a.startsAt);
  // Una durata, non una posizione: `ends_at` è `starts_at` più `duration_min`.
  const durationMin = Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / MINUTE_MS);
  return {
    id: a.id,
    day: todayRome(a.startsAt),
    startMin,
    endMin: startMin + durationMin,
    timeRange: timeRange(a.startsAt, a.endsAt),
    patientLabel: lastFirst({ firstName: a.patientFirstName, lastName: a.patientLastName }),
    serviceName: a.serviceName,
    color: a.color,
    status: a.status,
    startsAtIso: a.startsAt.toISOString(),
  };
}
