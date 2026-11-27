import { addDays } from "./calendar";
import type { InvoiceSnapshot, SnapshotLine } from "./snapshot";

export interface EseDocument {
  snapshot: InvoiceSnapshot;
  status: "emessa" | "pagata" | "annullata";
  paidOn: string | null;
  /** Allineate a `snapshot.lines`, bollo compreso (null per le righe libere e per il bollo). */
  standardDescriptions: (string | null)[];
}

// Export oscurato per l'elenco speciale: le righe libere e quelle la cui voce non è più in listino
// non hanno una descrizione standard, e il PDF stampa "Prestazione osteopatica". La riga del bollo ha il suo
// testo fisso e non passa di qui.

/**
 * La descrizione in fattura attuale della voce di listino di ogni riga, nello stesso ordine di `lines`
 * (anche la riga del bollo, che vale null): null per le righe libere e per le voci non più in listino.
 */
export function standardDescriptionsFor(
  lines: readonly SnapshotLine[],
  services: ReadonlyMap<string, string>,
): (string | null)[] {
  return lines.map((line) =>
    line.kind === "prestazione" && line.serviceId !== null ? (services.get(line.serviceId) ?? null) : null,
  );
}

/** Il periodo massimo di un export: 24 mesi compresi gli estremi. */
export const ESE_MAX_MONTHS = 24;

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Il primo e l'ultimo giorno dei mesi da `from` a `to` ("AAAA-MM"); null se formato, ordine o durata non vanno. */
export function esePeriod(from: string, to: string): { start: string; end: string } | null {
  const a = MONTH_PATTERN.exec(from);
  const b = MONTH_PATTERN.exec(to);
  if (!a || !b) return null;
  const months = (Number(b[1]) - Number(a[1])) * 12 + Number(b[2]) - Number(a[2]) + 1;
  if (months < 1 || months > ESE_MAX_MONTHS) return null;
  const nextYear = Number(b[2]) === 12 ? Number(b[1]) + 1 : Number(b[1]);
  const nextMonth = Number(b[2]) === 12 ? 1 : Number(b[2]) + 1;
  const next = `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;
  return { start: `${from}-01`, end: addDays(next, -1) };
}
