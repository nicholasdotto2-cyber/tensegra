import type { AppointmentStatus } from "./status";

// Etichetta "Seduta N di M": N è la posizione fra gli appuntamenti del ciclo non
// annullati e non saltati, in ordine di orario; M sono le sedute previste del ciclo.

export interface CycleAppointment {
  id: string;
  startsAt: Date;
  status: AppointmentStatus;
}

const counts = (a: CycleAppointment) => a.status !== "annullato" && a.status !== "saltato";

// A parità di orario decide l'id, così la stessa lista dà sempre la stessa etichetta.
function byStart(a: CycleAppointment, b: CycleAppointment): number {
  const diff = a.startsAt.getTime() - b.startsAt.getTime();
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Posizione da 1 dell'appuntamento nel ciclo; null se è annullato, saltato o non è nella lista. */
export function sessionPosition(appointmentId: string, list: readonly CycleAppointment[]): number | null {
  const index = list.filter(counts).sort(byStart).findIndex((a) => a.id === appointmentId);
  return index === -1 ? null : index + 1;
}

/** "Seduta 2 di 4"; senza sedute previste "Seduta 2"; senza posizione nessuna etichetta. */
export function sessionLabel(position: number | null, expectedSessions: number | null): string | null {
  if (position === null) return null;
  return expectedSessions === null ? `Seduta ${position}` : `Seduta ${position} di ${expectedSessions}`;
}
