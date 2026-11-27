import type { ServiceColor } from "@/lib/agenda/defaults";
import type { Band, WeekHours } from "@/lib/agenda/slots";
import type { AppointmentStatus } from "@/lib/agenda/status";

// Regole della griglia dell'agenda: la finestra verticale,
// le posizioni in pixel, i blocchi affiancati, i giorni visibili e le fasce chiuse. Tutto in minuti
// dalle 00:00 dell'orologio di Roma (`romeMinutes`), mai da differenze di istanti: così il giorno di
// 25 ore del cambio d'ora disegna le 10:00 alle 10:00. Sicuro per il client: nessun import dal server.

/** Un appuntamento come lo disegna la griglia: il server lo prepara (`toBlock`), il client lo riceve così. */
export interface AgendaBlock {
  id: string;
  /** Il giorno di Roma, "AAAA-MM-GG". */
  day: string;
  startMin: number;
  endMin: number;
  /** "09:00-09:45". */
  timeRange: string;
  /** "Cognome Nome". */
  patientLabel: string;
  serviceName: string;
  color: ServiceColor;
  status: AppointmentStatus;
  startsAtIso: string;
}

/** Un'ora alta 96 px, quindi 15 minuti = 24 px (bersagli di almeno 24 x 24 px). */
export const PX_PER_HOUR = 96;

const HOUR = 60;
const QUARTER = 15;
const MINUTES_IN_DAY = 24 * HOUR;
const QUARTER_PX = (QUARTER * PX_PER_HOUR) / HOUR;
/** Un'ora prima della prima apertura e dopo l'ultima chiusura. */
const MARGIN_MIN = HOUR;
/** Senza orari la griglia va dalle 07:00 alle 21:00. */
const WITHOUT_HOURS = { startMin: 7 * HOUR, endMin: 21 * HOUR } as const;

/** Gli anni che l'agenda mostra: una data fuori (nell'URL o nel campo) si ignora come un valore non valido. */
export const AGENDA_FIRST_DAY = "2000-01-01";
export const AGENDA_LAST_DAY = "2099-12-31";

interface Span {
  startMin: number;
  endMin: number;
}

const isWeekday = (n: number): n is keyof WeekHours => Number.isInteger(n) && n >= 1 && n <= 7;

/**
 * La finestra verticale: dalla prima apertura dei giorni dati meno 1 ora all'ultima chiusura più 1
 * ora (seed: 08:00-20:30); senza fasce in quei giorni 07:00-21:00. Un appuntamento fuori la allarga
 * fino all'ora intera che lo contiene, sempre dentro la giornata.
 */
export function gridWindow(
  week: WeekHours,
  weekdays: readonly number[],
  blocks: readonly { startMin: number; endMin: number }[],
): Span {
  const bands = weekdays.filter(isWeekday).flatMap((weekday) => week[weekday]);
  let startMin: number = WITHOUT_HOURS.startMin;
  let endMin: number = WITHOUT_HOURS.endMin;
  if (bands.length > 0) {
    startMin = Math.min(...bands.map((b) => b.opensMin)) - MARGIN_MIN;
    endMin = Math.max(...bands.map((b) => b.closesMin)) + MARGIN_MIN;
  }
  for (const block of blocks) {
    if (block.startMin < startMin) startMin = Math.floor(block.startMin / HOUR) * HOUR;
    if (block.endMin > endMin) endMin = Math.ceil(block.endMin / HOUR) * HOUR;
  }
  return { startMin: Math.max(0, startMin), endMin: Math.min(MINUTES_IN_DAY, endMin) };
}

/** La distanza in pixel di un minuto dall'inizio della finestra. */
export function blockTop(startMin: number, windowStartMin: number): number {
  return ((startMin - windowStartMin) * PX_PER_HOUR) / HOUR;
}

/** L'altezza in pixel di un intervallo: 45 minuti = 72 px. */
export function blockHeight(startMin: number, endMin: number): number {
  return ((endMin - startMin) * PX_PER_HOUR) / HOUR;
}

/** Il quarto d'ora che contiene un punto della colonna, a `offsetPx` dall'inizio della finestra. */
export function quarterAt(offsetPx: number, windowStartMin: number): number {
  return windowStartMin + Math.max(0, Math.floor(offsetPx / QUARTER_PX)) * QUARTER;
}

/**
 * Blocchi sovrapposti affiancati: ogni gruppo di blocchi collegati da sovrapposizioni
 * ha tante colonne quante ne servono al punto più affollato, e ogni blocco prende la prima colonna
 * libera. Intervalli che si toccano (10:00-10:30 e 10:30) non si sovrappongono.
 */
export function layoutColumns(
  blocks: readonly { id: string; startMin: number; endMin: number }[],
): Map<string, { column: number; columns: number }> {
  const sorted = [...blocks].sort(
    (a, b) => a.startMin - b.startMin || a.endMin - b.endMin || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const layout = new Map<string, { column: number; columns: number }>();
  let group: { id: string; column: number }[] = [];
  // La fine dell'ultimo blocco di ogni colonna del gruppo aperto.
  let columnEnds: number[] = [];
  let groupEnd = -1;

  const closeGroup = () => {
    for (const { id, column } of group) layout.set(id, { column, columns: columnEnds.length });
    group = [];
    columnEnds = [];
  };

  for (const block of sorted) {
    if (block.startMin >= groupEnd) closeGroup();
    let column = columnEnds.findIndex((end) => end <= block.startMin);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(block.endMin);
    } else {
      columnEnds[column] = block.endMin;
    }
    group.push({ id: block.id, column });
    groupEnd = Math.max(groupEnd, block.endMin);
  }
  closeGroup();
  return layout;
}

/** Da lunedì a sabato; la domenica solo se è un giorno di apertura o ha appuntamenti. */
export function visibleWeekdays(week: WeekHours, weekdaysWithBlocks: ReadonlySet<number>): number[] {
  const weekdays = [1, 2, 3, 4, 5, 6];
  if (week[7].length > 0 || weekdaysWithBlocks.has(7)) weekdays.push(7);
  return weekdays;
}

/**
 * Le fasce "Chiuso" di un giorno nella finestra: ciò che resta fuori dalle fasce di apertura. Fasce che
 * si toccano o si accavallano valgono come una sola; un giorno senza fasce è chiuso per
 * tutta la finestra.
 */
export function closedBands(bands: readonly Band[], window: Span): Span[] {
  const closed: Span[] = [];
  let cursor = window.startMin;
  for (const band of [...bands].sort((a, b) => a.opensMin - b.opensMin)) {
    if (cursor >= window.endMin) break;
    const gapEnd = Math.min(band.opensMin, window.endMin);
    if (gapEnd > cursor) closed.push({ startMin: cursor, endMin: gapEnd });
    cursor = Math.max(cursor, band.closesMin);
  }
  if (cursor < window.endMin) closed.push({ startMin: cursor, endMin: window.endMin });
  return closed;
}
