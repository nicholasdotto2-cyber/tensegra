// Stati e transizioni degli appuntamenti: una sola tabella per
// Oggi, l'agenda e i comandi, che la riapplicano sullo stato letto nel database. Sicuro per il
// client: nessun import dal server, nessun fuso e nessun orologio (adesso e oggi arrivano nel contesto).

export type AppointmentStatus = "prenotato" | "confermato" | "fatto" | "saltato" | "annullato";

export type AppointmentAction =
  | "segna_confermato"
  | "segna_fatta"
  | "saltato"
  | "annulla"
  | "annulla_fatto"
  | "ripristina"
  | "annulla_saltato"
  | "elimina"
  | "modifica";

export interface ActionContext {
  status: AppointmentStatus;
  startsAt: Date;
  /** Giorno di Roma dell'appuntamento, "AAAA-MM-GG". */
  day: string;
  /** Giorno di Roma di adesso, "AAAA-MM-GG". */
  today: string;
  now: Date;
  hasVisit: boolean;
  /** Una riga di fattura qualsiasi, attiva o no. */
  hasAnyInvoiceLine: boolean;
  /** Una riga di `message_log`, che non si cancella. */
  hasMessage: boolean;
}

const isOpen = (s: AppointmentStatus) => s === "prenotato" || s === "confermato";
const started = (c: ActionContext) => c.startsAt.getTime() <= c.now.getTime();
// I giorni "AAAA-MM-GG" in ordine di testo sono in ordine di calendario.
const dayUpToToday = (c: ActionContext) => c.day <= c.today;
const canMarkDone = (c: ActionContext) => isOpen(c.status) && dayUpToToday(c);

// Nell'ordine della tabella degli stati, con "Modifica" in fondo.
const RULES: readonly (readonly [AppointmentAction, (c: ActionContext) => boolean])[] = [
  ["segna_confermato", (c) => c.status === "prenotato"],
  ["segna_fatta", canMarkDone],
  // Con una visita la seduta c'è stata: non si salta.
  ["saltato", (c) => isOpen(c.status) && started(c) && !c.hasVisit],
  ["annulla", (c) => isOpen(c.status) && !c.hasVisit],
  // Visita e fattura non tolgono l'azione: il comando risponde "C'è già una visita" o
  // "C'è già la fattura n. ...".
  ["annulla_fatto", (c) => c.status === "fatto"],
  ["ripristina", (c) => (c.status === "saltato" || c.status === "annullato") && !started(c)],
  // Un "Saltato" dato per errore torna confermato; prima dell'inizio vale "Ripristina".
  ["annulla_saltato", (c) => c.status === "saltato" && started(c)],
  ["elimina", (c) => isOpen(c.status) && !c.hasVisit && !c.hasAnyInvoiceLine && !c.hasMessage],
  ["modifica", (c) => isOpen(c.status)],
];

/** Le azioni che l'interfaccia offre, nell'ordine della tabella. */
export function allowedActions(ctx: ActionContext): AppointmentAction[] {
  return RULES.filter(([, allowed]) => allowed(ctx)).map(([action]) => action);
}

/**
 * "Apri la visita": si può aprire per un prenotato, un confermato o un fatto il cui giorno di
 * Roma non è dopo oggi, anche prima del "fatto" per scrivere durante la seduta. Le stesse condizioni di
 * `startVisit`, che resta il presidio: la visita non nasce da un saltato, da un annullato né dal futuro.
 */
export function canOpenVisit(status: AppointmentStatus, day: string, today: string): boolean {
  return (status === "prenotato" || status === "confermato" || status === "fatto") && day <= today;
}

/**
 * "Modifica" di un appuntamento con una visita, in bozza o chiusa: l'ora cambia, il giorno no,
 * perché `visit_date` è il giorno dell'appuntamento. Il comando la risponde sul campo della data, il
 * dialogo la scrive sotto la data, disattivata.
 */
export const VISIT_KEEPS_DAY = "Questo appuntamento ha già una visita: non si sposta a un altro giorno.";

/** "Segna come fatta" su un appuntamento di oggi che non è ancora iniziato chiede conferma. */
export function needsDoneConfirmation(ctx: ActionContext): boolean {
  return canMarkDone(ctx) && !started(ctx);
}

/** La domanda di "Segna come fatta" prima dell'inizio, con l'ora di inizio ("17:00"). */
export function doneQuestion(startLabel: string): string {
  return `Inizia alle ${startLabel}. Segnarlo comunque come fatto?`;
}

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  prenotato: "Prenotato",
  confermato: "Confermato",
  fatto: "Fatto",
  saltato: "Saltato",
  annullato: "Annullato",
};

export const ACTION_LABEL: Record<AppointmentAction, string> = {
  segna_confermato: "Segna confermato",
  segna_fatta: "Segna come fatta",
  saltato: "Saltato",
  annulla: "Annulla appuntamento",
  annulla_fatto: "Annulla 'fatto'",
  ripristina: "Ripristina",
  annulla_saltato: "Annulla 'saltato'",
  elimina: "Elimina",
  modifica: "Modifica",
};

/** Attivi: contano nei titoli e nell'intestazione del giorno. */
export function isActive(s: AppointmentStatus): boolean {
  return s === "prenotato" || s === "confermato" || s === "fatto";
}

/** I segnali di una riga di Oggi. */
export type Signal =
  | "consenso_mancante"
  | "anagrafica_da_completare"
  | "visita_da_compilare"
  | "da_chiudere"
  | "avviso_clinico";

export const SIGNAL_LABEL: Record<Signal, string> = {
  consenso_mancante: "Consenso mancante",
  anagrafica_da_completare: "Anagrafica da completare",
  visita_da_compilare: "Visita da compilare",
  da_chiudere: "Da chiudere",
  avviso_clinico: "Avviso clinico",
};
