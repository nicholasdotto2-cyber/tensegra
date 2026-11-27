// Default del dialogo "Nuovo appuntamento" e delle voci nuove del Listino:
// riempiono da soli il passo 2 della demo. Sicuro per il client: lo usa
// anche il pannello del Listino.

export type ServiceKind = "prima_visita" | "seduta" | "controllo" | "altro";
export type CycleKind = "trattamento" | "mantenimento";
export type ServiceColor = "petrolio" | "salvia" | "oceano" | "ocra" | "corallo" | "ardesia";

/**
 * La prestazione proposta: prima visita se il paziente non ha appuntamenti fatti, seduta
 * se ha un ciclo di trattamento aperto, controllo se ha un mantenimento aperto o solo cicli chiusi.
 * Un paziente senza cicli comincia con la prima visita.
 */
export function defaultServiceKind(p: {
  hasDoneAppointment: boolean;
  openCycleKind: CycleKind | null;
  hasClosedCycle: boolean;
}): ServiceKind {
  if (!p.hasDoneAppointment) return "prima_visita";
  if (p.openCycleKind === "trattamento") return "seduta";
  if (p.openCycleKind === "mantenimento" || p.hasClosedCycle) return "controllo";
  return "prima_visita";
}

/** Il ciclo che si apre senza un ciclo aperto: il controllo apre un mantenimento. */
export function newCycleKind(service: ServiceKind): CycleKind {
  return service === "controllo" ? "mantenimento" : "trattamento";
}

export const NEW_CYCLE_LABEL: Record<CycleKind, string> = {
  trattamento: "Apri un nuovo ciclo di trattamento",
  mantenimento: "Apri un ciclo di mantenimento",
};

// "Numero di sedute in totale" va da 2 a 12.
const SERIES_MIN = 2;
const SERIES_MAX = 12;
const SERIES_WITHOUT_EXPECTED = 4;

/** Default della serie: previste meno appuntamenti attivi del ciclo, dentro 2-12; 4 senza previste. */
export function defaultSeriesCount(expected: number | null, activeInCycle: number): number {
  if (expected === null) return SERIES_WITHOUT_EXPECTED;
  return Math.min(SERIES_MAX, Math.max(SERIES_MIN, expected - activeInCycle));
}

export const KIND_LABEL: Record<ServiceKind, string> = {
  prima_visita: "Prima visita",
  seduta: "Seduta",
  controllo: "Controllo",
  altro: "Altro",
};

/** Durata e colore di una voce nuova del Listino per tipo. */
export const KIND_DEFAULTS: Record<ServiceKind, { durationMin: number; color: ServiceColor }> = {
  prima_visita: { durationMin: 60, color: "ocra" },
  seduta: { durationMin: 45, color: "petrolio" },
  controllo: { durationMin: 30, color: "salvia" },
  altro: { durationMin: 30, color: "ardesia" },
};
