// Orari dello studio e sovrapposizioni in minuti dalle 00:00 di Roma.
// I minuti arrivano da `romeMinutes`, mai da differenze di istanti.
// Sicuro per il client: nessun import dal server.

const QUARTER = 15;
const MINUTES_IN_DAY = 24 * 60;

/** Una fascia di apertura, fine esclusa. */
export interface Band {
  opensMin: number;
  closesMin: number;
}

/** Le fasce per giorno della settimana ISO, 1 = lunedì ... 7 = domenica. */
export type WeekHours = Readonly<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, readonly Band[]>>;

/** Uno studio senza orari: ogni giorno è chiuso. */
export const EMPTY_WEEK: WeekHours = Object.freeze({ 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] });

/**
 * Un appuntamento che occupa la giornata. Chi costruisce l'elenco lascia fuori `annullato` e
 * `saltato`, che liberano l'orario.
 */
export interface Busy {
  id: string;
  startMin: number;
  endMin: number;
  /** "Morelli Anna, 10:00-10:30" */
  label: string;
}

interface Span {
  startMin: number;
  endMin: number;
}

/** Intervalli con la fine esclusa: 10:00-10:30 e 10:30-11:15 si toccano e non si sovrappongono. */
export function overlaps(a: Span, b: Span): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

// Fasce che si toccano (o si accavallano) valgono come una sola.
function mergeBands(bands: readonly Band[]): Band[] {
  const merged: Band[] = [];
  for (const band of [...bands].sort((a, b) => a.opensMin - b.opensMin)) {
    const last = merged.at(-1);
    if (last && band.opensMin <= last.closesMin) {
      last.closesMin = Math.max(last.closesMin, band.closesMin);
    } else {
      merged.push({ ...band });
    }
  }
  return merged;
}

/** Vero se l'intervallo intero sta in una sola fascia: attraversare la pausa pranzo è fuori orario. */
export function insideOpening(bands: readonly Band[], startMin: number, endMin: number): boolean {
  return mergeBands(bands).some((b) => b.opensMin <= startMin && endMin <= b.closesMin);
}

export type SlotState =
  | { kind: "libero" }
  | { kind: "sovrapposto"; with: string }
  | { kind: "giorno_chiuso" }
  | { kind: "fuori_orario" };

/**
 * Lo stato di un orario, in quest'ordine: "Si sovrappone a ..." (il primo
 * appuntamento che tocca, per inizio), poi "Giorno chiuso", poi "Fuori orario", poi "Libero".
 * `ignoreId` lascia fuori l'appuntamento che si sta modificando o ripristinando.
 */
export function slotState(
  bands: readonly Band[],
  busy: readonly Busy[],
  startMin: number,
  endMin: number,
  ignoreId?: string,
): SlotState {
  const slot = { startMin, endMin };
  let first: Busy | undefined;
  for (const b of busy) {
    if (b.id === ignoreId || !overlaps(slot, b)) continue;
    if (!first || b.startMin < first.startMin) first = b;
  }
  if (first) return { kind: "sovrapposto", with: first.label };
  if (bands.length === 0) return { kind: "giorno_chiuso" };
  if (!insideOpening(bands, startMin, endMin)) return { kind: "fuori_orario" };
  return { kind: "libero" };
}

/** Il testo di una riga dell'anteprima della serie. */
export function slotLabel(s: SlotState): string {
  switch (s.kind) {
    case "libero":
      return "Libero";
    case "sovrapposto":
      return `Si sovrappone a ${s.with}`;
    case "giorno_chiuso":
      return "Giorno chiuso";
    case "fuori_orario":
      return "Fuori orario";
  }
}

/** L'avviso del dialogo: "Si sovrappone a Morelli Anna, 10:00-10:30." */
export function overlapWarning(label: string): string {
  return `Si sovrappone a ${label}.`;
}

/** L'avviso non bloccante per un orario fuori dalle fasce o in un giorno chiuso. */
export const OUTSIDE_HOURS = "Fuori dagli orari dello studio.";

/**
 * Il primo quarto d'ora da `fromMin` (arrotondato in su) in cui `[t, t + durata)` sta in una fascia
 * senza sovrapposizioni e finisce entro la giornata; null se nel giorno non ce n'è.
 */
export function firstFreeStart(
  bands: readonly Band[],
  busy: readonly Busy[],
  fromMin: number,
  durationMin: number,
): number | null {
  if (!Number.isInteger(durationMin) || durationMin < 1) {
    throw new RangeError("La durata deve essere un intero di minuti da 1 in su.");
  }
  for (let t = Math.ceil(fromMin / QUARTER) * QUARTER; t + durationMin <= MINUTES_IN_DAY; t += QUARTER) {
    if (slotState(bands, busy, t, t + durationMin).kind === "libero") return t;
  }
  return null;
}

/** La scelta dell'ora va dalle 07:00 alle 21:00 a passi di 15. */
export const PICKER_FIRST_MIN = 420;
export const PICKER_LAST_MIN = 1260;

/** Minuti dalle 00:00 -> il quarto d'ora che li contiene (08:37 diventa 08:30). */
export function floorToQuarter(min: number): number {
  return Math.floor(min / QUARTER) * QUARTER;
}

/** Un orario precompilato -> il quarto d'ora che lo contiene, portato al limite più vicino se è fuori. */
export function clampToPicker(min: number): number {
  return Math.min(PICKER_LAST_MIN, Math.max(PICKER_FIRST_MIN, floorToQuarter(min)));
}
