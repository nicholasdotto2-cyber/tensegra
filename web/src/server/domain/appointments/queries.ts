import {
  type CycleKind,
  defaultSeriesCount,
  defaultServiceKind,
  newCycleKind,
  type ServiceColor,
  type ServiceKind,
} from "@/lib/agenda/defaults";
import { type CycleAppointment, sessionLabel, sessionPosition } from "@/lib/agenda/session-label";
import {
  type Band,
  type Busy,
  firstFreeStart,
  OUTSIDE_HOURS,
  overlapWarning,
  PICKER_FIRST_MIN,
  type SlotState,
  slotLabel,
  slotState,
} from "@/lib/agenda/slots";
import {
  type ActionContext,
  type AppointmentAction,
  type AppointmentStatus,
  allowedActions,
  canOpenVisit,
  doneQuestion,
  isActive,
  needsDoneConfirmation,
  type Signal,
} from "@/lib/agenda/status";
import { missingModules } from "@/lib/consents/required";
import { whatsappPhoneProblem } from "@/lib/messages/links";
import {
  age,
  dayLong,
  durationShort,
  firstLast,
  isMinor,
  lastFirst,
  minutesLabel,
  timeOf,
  timeRange,
  weekdayDay,
  weekdayDayMonth,
} from "@/lib/format";
import {
  addDaysRome,
  type Clock,
  daysBetween,
  endsSameRomeDay,
  romeDateTime,
  romeDayBounds,
  romeMinutes,
  todayRome,
  weeklyDays,
} from "@/server/clock";
import type { SqlParam, Tx } from "@/server/db/db";
import {
  blockText,
  consentTarget,
  loadConsentDecisions,
  loadConsentGuardians,
  revocationText,
} from "@/server/domain/consents/queries";
import type { ConsentTarget } from "@/server/domain/consents/schemas";
import { listCycleAppointments } from "@/server/domain/cycles/queries";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { invoiceOfAppointment } from "@/server/domain/invoices/queries";
import { listAppointmentMessages, type MessageLogRow, type PreparedMessage, prepareMessage } from "@/server/domain/messages/queries";
import type { MessageRecipient } from "@/server/domain/messages/recipient";
import {
  type BookingPatient,
  getPatientForBooking,
  incompleteRecordSql,
  type PatientHit,
} from "@/server/domain/patients/queries";
import { listActiveServices } from "@/server/domain/services/queries";
import { bandsOf, openDayAfter } from "@/server/domain/settings/opening-days";
import { type ClinicalSettingsView, getClinicalSettings, getOpeningHours } from "@/server/domain/settings/queries";
import {
  AppointmentIdInput,
  BookingDefaultsInput,
  INVALID,
  NextSessionInput,
  PreviewInput,
  SuggestStartInput,
} from "./schemas";

// Letture del dialogo "Nuovo appuntamento" e del pannello "Seduta fatta":
// gli appuntamenti che occupano un giorno, l'anteprima con i suoi avvisi,
// i default del paziente scelto, l'orario proposto e la prossima seduta; per i cambi di stato
// i blocchi di ogni appuntamento e le successive della serie; per Oggi gli
// appuntamenti del giorno e i promemoria per domani; per la griglia dell'agenda gli
// appuntamenti di un periodo. Le posizioni sono minuti dell'ora di Roma
// (`romeMinutes`); ogni lettura filtra lo studio anche oltre la RLS.

const MINUTE_MS = 60_000;
const QUARTER_MIN = 15;
const DAY_MIN = 24 * 60;
/** La proposta della prossima seduta cerca un orario libero fino a 28 giorni dopo il giorno di partenza. */
const LOOKAHEAD_DAYS = 28;

/** I minuti di Roma di adesso, arrotondati in su: a metà minuto (09:00:20) le 09:00 sono già passate. */
function minutesNotPassed(now: Date): number {
  return romeMinutes(now) + (now.getTime() % MINUTE_MS === 0 ? 0 : 1);
}

/**
 * L'istante dell'ora di Roma `time` del giorno `day`. Un orario che a Roma non esiste (le 02:30 del
 * passaggio all'ora legale) è un errore sul campo `time`, non un errore del server.
 */
export function appointmentStart(day: string, time: string): Date {
  try {
    return romeDateTime(day, time);
  } catch (error) {
    if (error instanceof RangeError) throw new DomainError(INVALID, { field: "time" });
    throw error;
  }
}

/**
 * Gli appuntamenti attivi (prenotato, confermato, fatto) di ogni giorno chiesto, per giorno di Roma e
 * in ordine di orario: `annullato` e `saltato` liberano l'orario. Ogni giorno chiesto ha
 * la sua voce, anche vuota. `ignoreId` lascia fuori l'appuntamento che si sta modificando.
 */
export async function loadBusy(
  tx: Tx,
  practiceId: string,
  days: readonly string[],
  ignoreId?: string,
): Promise<Map<string, Busy[]>> {
  const unique = [...new Set(days)];
  const busy = new Map<string, Busy[]>(unique.map((day) => [day, []]));
  if (unique.length === 0) return busy;

  // Un intervallo per giorno, dalle 00:00 di Roma alle 00:00 del giorno dopo.
  const params: SqlParam[] = [practiceId];
  const ranges = unique.map((day) => {
    const { start, end } = romeDayBounds(day);
    params.push(start, end);
    return `(a.starts_at >= $${params.length - 1} and a.starts_at < $${params.length})`;
  });
  let ignore = "";
  if (ignoreId !== undefined) {
    params.push(ignoreId);
    ignore = `and a.id <> $${params.length}`;
  }
  const rows = await tx.query<{
    id: string;
    startsAt: Date;
    endsAt: Date;
    durationMin: number;
    firstName: string;
    lastName: string;
  }>(
    `select a.id,
            a.starts_at as "startsAt",
            a.ends_at as "endsAt",
            a.duration_min as "durationMin",
            p.first_name as "firstName",
            p.last_name as "lastName"
       from public.appointments a
       join public.patients p on p.practice_id = a.practice_id and p.id = a.patient_id
      where a.practice_id = $1
        and a.status in ('prenotato', 'confermato', 'fatto')
        and (${ranges.join(" or ")})
        ${ignore}
      order by a.starts_at, a.id`,
    params,
  );
  for (const row of rows) {
    const startMin = romeMinutes(row.startsAt);
    busy.get(todayRome(row.startsAt))?.push({
      id: row.id,
      startMin,
      // La durata, non l'ora di fine: nei giorni del cambio d'ora l'orologio salta, i minuti no.
      endMin: startMin + row.durationMin,
      label: `${lastFirst(row)}, ${timeRange(row.startsAt, row.endsAt)}`,
    });
  }
  return busy;
}

/** Ciò che ferma un cambio di stato o l'eliminazione di un appuntamento. */
export interface Blockers {
  hasVisit: boolean;
  /** La visita è chiusa: il passo 3 del pannello "Seduta fatta" è fatto. */
  hasClosedVisit: boolean;
  /** Una riga di fattura qualsiasi, anche di una fattura annullata (`link_active` falso). */
  hasAnyInvoiceLine: boolean;
  /** Una riga con `link_active`: in una fattura emessa o pagata, o in una bozza. */
  hasActiveInvoiceLine: boolean;
  /** Il numero della fattura della riga attiva ("273/2026"); null per una bozza o senza riga attiva. */
  activeInvoiceLabel: string | null;
  /** Una riga di `message_log`, che non si cancella. */
  hasMessage: boolean;
}

/**
 * I blocchi degli appuntamenti chiesti, per id. Solo gli appuntamenti dello studio hanno una voce: un
 * id che non c'è (o di un altro studio) resta fuori, mai con i blocchi a falso.
 */
export async function loadBlockers(tx: Tx, practiceId: string, ids: readonly string[]): Promise<Map<string, Blockers>> {
  const blockers = new Map<string, Blockers>();
  if (ids.length === 0) return blockers;
  const rows = await tx.query<Blockers & { id: string }>(
    `select a.id,
            exists (select 1 from public.visits v
                     where v.practice_id = a.practice_id and v.appointment_id = a.id) as "hasVisit",
            exists (select 1 from public.visits v
                     where v.practice_id = a.practice_id and v.appointment_id = a.id
                       and v.status = 'closed') as "hasClosedVisit",
            exists (select 1 from public.invoice_lines l
                     where l.practice_id = a.practice_id and l.appointment_id = a.id) as "hasAnyInvoiceLine",
            exists (select 1 from public.invoice_lines l
                     where l.practice_id = a.practice_id and l.appointment_id = a.id
                       and l.link_active) as "hasActiveInvoiceLine",
            -- Una sola riga attiva per appuntamento (invoice_lines_appointment_once_idx); una bozza non ha numero.
            (select i.number_label
               from public.invoice_lines l
               join public.invoices i on i.practice_id = l.practice_id and i.id = l.invoice_id
              where l.practice_id = a.practice_id and l.appointment_id = a.id and l.link_active
              limit 1) as "activeInvoiceLabel",
            exists (select 1 from public.message_log m
                     where m.practice_id = a.practice_id and m.appointment_id = a.id) as "hasMessage"
       from public.appointments a
      where a.practice_id = $1 and a.id = any($2::uuid[])`,
    [practiceId, ids],
  );
  for (const { id, ...row } of rows) blockers.set(id, row);
  return blockers;
}

/**
 * Le successive della serie che "Annulla anche le N successive della serie" annulla:
 * stessa serie, inizio dopo, prenotate o confermate, in ordine di orario. Una con la visita resta
 * fuori: si annulla solo un appuntamento senza visita.
 */
export async function followingIdsInSeries(tx: Tx, practiceId: string, id: string): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(
    `select f.id
       from public.appointments a
       join public.appointments f
         on f.practice_id = a.practice_id and f.series_id = a.series_id and f.starts_at > a.starts_at
      where a.practice_id = $1 and a.id = $2
        and f.status in ('prenotato', 'confermato')
        and not exists (select 1 from public.visits v where v.practice_id = f.practice_id and v.appointment_id = f.id)
      order by f.starts_at, f.id`,
    [practiceId, id],
  );
  return rows.map((row) => row.id);
}

/** Quante successive annullerebbe "Annulla anche le N successive della serie"; 0 fuori da una serie. */
export async function followingInSeries(tx: Tx, practiceId: string, id: string): Promise<number> {
  return (await followingIdsInSeries(tx, practiceId, id)).length;
}

/** Una data della serie nell'anteprima: "Libero", "Si sovrappone a ...", "Fuori orario", "Giorno chiuso". */
export interface PreviewRow {
  day: string;
  time: string;
  state: SlotState["kind"];
  label: string;
}

export interface AppointmentPreview {
  /** Gli avvisi non bloccanti della data scelta: prima la sovrapposizione, poi gli orari chiusi. */
  warnings: string[];
  /** L'inizio della data scelta è già passato: il dialogo chiede "Lo segno già come fatto?". */
  pastStart: boolean;
  /** Una data finisce alle 00:00 o dopo: il comando la rifiuterà. */
  endsNextDay: boolean;
  /** Una riga per data con la ripetizione, nessuna senza. */
  rows: PreviewRow[];
}

/**
 * L'anteprima del dialogo: niente blocca, si avvisa soltanto. La sovrapposizione ignora
 * `annullato` e `saltato`; "Fuori dagli orari dello studio." vale per un giorno chiuso e per un
 * intervallo che non sta in una sola fascia.
 */
export async function previewAppointment(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
): Promise<AppointmentPreview> {
  const p = PreviewInput.parse(input);
  // La data scelta è la prima della serie.
  const days = p.repeat ? weeklyDays(p.day, p.repeat.intervalWeeks, p.repeat.count) : [p.day];
  const dated = days.map((day) => ({ day, start: appointmentStart(day, p.time) }));
  const week = await getOpeningHours(tx, practiceId);
  const busy = await loadBusy(tx, practiceId, days, p.ignoreAppointmentId);

  const stateOn = (day: string, start: Date, others: readonly Busy[]): SlotState => {
    const startMin = romeMinutes(start);
    return slotState(bandsOf(week, day), others, startMin, startMin + p.durationMin);
  };

  const firstStart = appointmentStart(p.day, p.time);
  const warnings: string[] = [];
  const first = stateOn(p.day, firstStart, busy.get(p.day) ?? []);
  if (first.kind === "sovrapposto") warnings.push(overlapWarning(first.with));
  // Gli orari si guardano anche quando c'è una sovrapposizione, senza gli altri appuntamenti.
  if (stateOn(p.day, firstStart, []).kind !== "libero") warnings.push(OUTSIDE_HOURS);

  const rows = p.repeat
    ? dated.map(({ day, start }) => {
        const state = stateOn(day, start, busy.get(day) ?? []);
        return { day, time: p.time, state: state.kind, label: slotLabel(state) };
      })
    : [];

  return {
    warnings,
    pastStart: firstStart.getTime() < clock.now().getTime(),
    endsNextDay: dated.some(({ start }) => !endsSameRomeDay(start, p.durationMin)),
    rows,
  };
}

/** Senza la riga delle impostazioni della cartella (o di un altro studio) è "Operazione non permessa". */
async function clinicalSettingsOf(tx: Tx, practiceId: string): Promise<ClinicalSettingsView> {
  const settings = await getClinicalSettings(tx, practiceId);
  if (!settings) throw new DomainError(NOT_ALLOWED);
  return settings;
}

async function activeInCycle(tx: Tx, practiceId: string, cycleId: string): Promise<number> {
  return (await listCycleAppointments(tx, practiceId, cycleId)).filter((a) => isActive(a.status)).length;
}

export interface BookingDefaults {
  patient: BookingPatient;
  /** La prima voce attiva del tipo proposto, nell'ordine del listino; null se non ce n'è. */
  serviceId: string | null;
  cycle: { kind: "existing"; cycleId: string; title: string; cycleKind: CycleKind } | { kind: "new" };
  /** "Numero di sedute in totale". */
  seriesCount: number;
  /** "Ripeti ogni", da `clinical_settings.default_session_interval_weeks`. */
  intervalWeeks: number;
}

/**
 * I default del paziente scelto: la prestazione dal suo stato, il ciclo aperto o un
 * ciclo nuovo, e le sedute della serie = previste meno appuntamenti attivi del ciclo, dentro 2-12.
 * Per un ciclo nuovo le previste sono quelle che `openCycle` gli darà: il default dello studio per
 * il trattamento, nessuna per il mantenimento. Un paziente archiviato torna con `archived` vero: lo
 * rifiuta `createAppointment`.
 */
export async function bookingDefaults(
  tx: Tx,
  practiceId: string,
  _clock: Clock,
  input: { patientId: string },
): Promise<BookingDefaults> {
  const { patientId } = BookingDefaultsInput.parse(input);
  const patient = await getPatientForBooking(tx, practiceId, patientId);
  if (!patient) throw new DomainError(NOT_ALLOWED, { field: "patient" });
  const settings = await clinicalSettingsOf(tx, practiceId);

  const kind = defaultServiceKind({
    hasDoneAppointment: patient.hasDoneAppointment,
    openCycleKind: patient.openCycle?.kind ?? null,
    hasClosedCycle: patient.hasClosedCycle,
  });
  const services = await listActiveServices(tx, practiceId);
  const serviceId = services.find((s) => s.kind === kind)?.id ?? null;
  const intervalWeeks = settings.defaultSessionIntervalWeeks;

  const open = patient.openCycle;
  if (open) {
    return {
      patient,
      serviceId,
      cycle: { kind: "existing", cycleId: open.id, title: open.title, cycleKind: open.kind },
      seriesCount: defaultSeriesCount(open.expectedSessions, await activeInCycle(tx, practiceId, open.id)),
      intervalWeeks,
    };
  }
  const expected = newCycleKind(kind) === "trattamento" ? settings.defaultExpectedSessions : null;
  return { patient, serviceId, cycle: { kind: "new" }, seriesCount: defaultSeriesCount(expected, 0), intervalWeeks };
}

/** La prima apertura del giorno, in minuti; null per un giorno chiuso. */
function firstOpening(bands: readonly Band[]): number | null {
  return bands.reduce<number | null>((min, b) => (min === null || b.opensMin < min ? b.opensMin : min), null);
}

/**
 * L'orario proposto per "Nuovo appuntamento": il primo quarto d'ora da adesso,
 * arrotondato in su, in cui `[t, t + durata)` sta in una fascia di oggi senza sovrapposizioni; poi lo
 * stesso dalla prima apertura di A(1), il primo giorno aperto dopo oggi; altrimenti la prima apertura
 * di A(1). Uno studio senza orari non ha aperture: A(1) è domani e l'ora l'inizio della scelta, 07:00.
 */
export async function suggestStart(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: { durationMin: number },
): Promise<{ day: string; time: string }> {
  const { durationMin } = SuggestStartInput.parse(input);
  const week = await getOpeningHours(tx, practiceId);
  const today = clock.today();
  const next = openDayAfter(week, today, 1);
  const busy = await loadBusy(tx, practiceId, [today, next]);

  const nowMin = minutesNotPassed(clock.now());
  const todayStart = firstFreeStart(bandsOf(week, today), busy.get(today) ?? [], nowMin, durationMin);
  if (todayStart !== null) return { day: today, time: minutesLabel(todayStart) };

  const nextBands = bandsOf(week, next);
  const opening = firstOpening(nextBands) ?? PICKER_FIRST_MIN;
  const nextStart = firstFreeStart(nextBands, busy.get(next) ?? [], opening, durationMin);
  return { day: next, time: minutesLabel(nextStart ?? opening) };
}

export type NextSession =
  | { kind: "booked"; text: string }
  | {
      kind: "proposal";
      text: string;
      day: string;
      time: string;
      serviceId: string;
      durationMin: number;
      priceCents: number;
    }
  | { kind: "last" }
  | { kind: "none" };

/**
 * Il primo orario libero per la proposta: la stessa ora del giorno di partenza; se è
 * occupata o fuori orario, `firstFreeStart` da quell'ora su quel giorno; poi dalla prima apertura dei
 * giorni aperti seguenti, fino a 28 giorni dopo. Se non trova niente resta l'ora di partenza.
 */
async function proposedStart(
  tx: Tx,
  practiceId: string,
  target: string,
  fromMin: number,
  durationMin: number,
): Promise<{ day: string; time: string }> {
  const week = await getOpeningHours(tx, practiceId);
  const days = [target];
  let candidate = openDayAfter(week, target, 1);
  while (daysBetween(target, candidate) <= LOOKAHEAD_DAYS) {
    days.push(candidate);
    candidate = openDayAfter(week, candidate, 1);
  }
  const busy = await loadBusy(tx, practiceId, days);

  const targetBands = bandsOf(week, target);
  const targetBusy = busy.get(target) ?? [];
  if (slotState(targetBands, targetBusy, fromMin, fromMin + durationMin).kind === "libero") {
    return { day: target, time: minutesLabel(fromMin) };
  }
  const sameDay = firstFreeStart(targetBands, targetBusy, fromMin, durationMin);
  if (sameDay !== null) return { day: target, time: minutesLabel(sameDay) };
  for (const day of days.slice(1)) {
    const bands = bandsOf(week, day);
    const opening = firstOpening(bands);
    if (opening === null) continue;
    const start = firstFreeStart(bands, busy.get(day) ?? [], opening, durationMin);
    if (start !== null) return { day, time: minutesLabel(start) };
  }
  return { day: target, time: minutesLabel(fromMin) };
}

/**
 * Il punto di partenza della proposta, mai prima di adesso. Una seduta segnata fatta in ritardo
 * può avere giorno + intervallo già passato, e "Fissa" prenoterebbe nel passato: da
 * oggi allora vale la stessa ora se non è ancora passata, altrimenti il primo quarto d'ora che non lo
 * è; se oggi non ne resta nessuno, domani alla stessa ora.
 */
function notBeforeNow(clock: Clock, day: string, min: number): { day: string; min: number } {
  const today = clock.today();
  if (daysBetween(today, day) > 0) return { day, min };
  const nowQuarter = Math.ceil(minutesNotPassed(clock.now()) / QUARTER_MIN) * QUARTER_MIN;
  const fromMin = Math.max(min, nowQuarter);
  return fromMin < DAY_MIN ? { day: today, min: fromMin } : { day: addDaysRome(today, 1), min };
}

/**
 * La prossima seduta già fissata: il primo appuntamento prenotato o confermato dello
 * stesso ciclo che inizia dopo `after` e da 00:00 di oggi. La stessa regola fa "Prossima seduta
 * già fissata" e il passo 2 fatto del pannello e del dettaglio.
 */
async function firstBookedAfter(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  cycleId: string,
  after: Date,
): Promise<{ startsAt: Date } | null> {
  const [booked] = await tx.query<{ startsAt: Date }>(
    `select starts_at as "startsAt"
       from public.appointments
      where practice_id = $1
        and cycle_id = $2
        and status in ('prenotato', 'confermato')
        and starts_at > $3
        and starts_at >= $4
      order by starts_at, id
      limit 1`,
    [practiceId, cycleId, after, romeDayBounds(clock.today()).start],
  );
  return booked ?? null;
}

/**
 * Il passo 2 del pannello "Seduta fatta". "Prossima seduta già fissata": il
 * primo appuntamento prenotato o confermato dello stesso ciclo che inizia dopo questo e da 00:00 di
 * oggi. Senza: nel mantenimento nessuna proposta; con gli appuntamenti attivi del ciclo già pari alle
 * previste è l'ultima seduta; altrimenti la proposta con la seduta attiva del listino, giorno + 7 x
 * l'intervallo dello studio, stessa ora, mai prima di adesso, spostata al primo orario libero.
 */
export async function nextSession(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: { appointmentId: string },
): Promise<NextSession> {
  const { appointmentId } = NextSessionInput.parse(input);
  const [current] = await tx.query<{
    startsAt: Date;
    cycleId: string;
    cycleKind: CycleKind;
    expectedSessions: number | null;
  }>(
    `select a.starts_at as "startsAt",
            a.cycle_id as "cycleId",
            c.kind as "cycleKind",
            c.expected_sessions as "expectedSessions"
       from public.appointments a
       join public.treatment_cycles c on c.practice_id = a.practice_id and c.id = a.cycle_id
      where a.practice_id = $1 and a.id = $2`,
    [practiceId, appointmentId],
  );
  if (!current) throw new DomainError(NOT_ALLOWED);

  const booked = await firstBookedAfter(tx, practiceId, clock, current.cycleId, current.startsAt);
  if (booked) {
    const when = `${weekdayDayMonth(todayRome(booked.startsAt))} alle ${timeOf(booked.startsAt)}`;
    return { kind: "booked", text: `Prossima seduta già fissata: ${when}` };
  }
  if (current.cycleKind === "mantenimento") return { kind: "none" };
  if (
    current.expectedSessions !== null &&
    (await activeInCycle(tx, practiceId, current.cycleId)) >= current.expectedSessions
  ) {
    return { kind: "last" };
  }

  const settings = await clinicalSettingsOf(tx, practiceId);
  const session = (await listActiveServices(tx, practiceId)).find((s) => s.kind === "seduta");
  if (!session) return { kind: "none" };
  const target = addDaysRome(todayRome(current.startsAt), 7 * settings.defaultSessionIntervalWeeks);
  const from = notBeforeNow(clock, target, romeMinutes(current.startsAt));
  const { day, time } = await proposedStart(tx, practiceId, from.day, from.min, session.durationMin);
  return {
    kind: "proposal",
    text: `Prossima seduta: ${weekdayDayMonth(day)} alle ${time}`,
    day,
    time,
    serviceId: session.id,
    durationMin: session.durationMin,
    priceCents: session.priceCents,
  };
}

/** Una riga di "Appuntamenti di oggi". */
export interface DayAppointmentRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  patientId: string;
  /** "Cognome Nome"; per un minore con l'età alla data dell'appuntamento: "Rinaldi Sofia, 4 mesi". */
  patientLabel: string;
  serviceName: string;
  serviceKind: ServiceKind;
  /** "Seduta 2 di 4"; null per un annullato o un saltato. */
  sessionLabel: string | null;
  signals: Signal[];
  /**
   * «Consenso revocato il 20/10»: il consenso al trattamento del ciclo è deciso da una revoca, con la stessa
   * regola e la stessa data del dettaglio; null altrimenti, e per un annullato o un saltato.
   */
  consentRevocationText: string | null;
  /** Il consenso al trattamento del ciclo è deciso da un rifiuto: la riga lo segnala come bloccato. */
  consentRefused: boolean;
  /** Le azioni ammesse dallo stato che la riga offre. */
  actions: AppointmentAction[];
  /** "Inizia alle 10:00. Segnarlo comunque come fatto?" prima dell'inizio, altrimenti null. */
  doneQuestion: string | null;
  /** "Apri la visita" nel menu della riga: prenotato, confermato o fatto di un giorno fino a oggi. */
  canOpenVisit: boolean;
  seriesId: string | null;
}

/** "Da chiudere": la fine è passata da oltre 30 minuti. */
const CLOSE_AFTER_MS = 30 * MINUTE_MS;

/** Senza la riga dei blocchi (non succede per un appuntamento appena letto) la riga non offre azioni rischiose. */
const UNKNOWN_BLOCKERS: Blockers = {
  hasVisit: true,
  hasClosedVisit: false,
  hasAnyInvoiceLine: true,
  hasActiveInvoiceLine: true,
  activeInvoiceLabel: null,
  hasMessage: true,
};

/** Il giorno a cui si conta l'età: un appuntamento prima della nascita conta come il giorno della nascita. */
const ageDayOf = (birthDate: string, day: string): string => (day < birthDate ? birthDate : day);

/**
 * Gli appuntamenti di un giorno di Roma per Oggi: per orario, con l'annullato in fondo; il saltato
 * resta al suo orario. Per ogni riga la posizione nel ciclo (`sessionPosition`), le azioni
 * della tabella degli stati con i blocchi di `loadBlockers`, la domanda prima dell'inizio e i segnali. I segnali stanno
 * solo sugli appuntamenti attivi: "Consenso mancante" (informativa una volta per paziente, trattamento una
 * volta per ciclo per l'età alla data, sul primo), "Anagrafica da completare" (codice fiscale o indirizzo, CAP, città),
 * "Visita da compilare" (fatto senza visita chiusa), "Da chiudere" (prenotato o confermato
 * finito da oltre 30 minuti) e "Avviso clinico" (`clinical_alert` oppure un esito dello screening diverso da
 * "indicato" nella visita più recente del paziente che ha gli esiti, bozza compresa).
 */
export async function listDayAppointments(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  day: string,
): Promise<DayAppointmentRow[]> {
  const { start, end } = romeDayBounds(day);
  const rows = await tx.query<{
    id: string;
    startsAt: Date;
    endsAt: Date;
    status: AppointmentStatus;
    patientId: string;
    cycleId: string;
    seriesId: string | null;
    openedOn: string;
    firstName: string;
    lastName: string;
    birthDate: string;
    incompleteRecord: boolean;
    clinicalAlert: boolean;
    serviceName: string;
    serviceKind: ServiceKind;
    expectedSessions: number | null;
  }>(
    `select a.id,
            a.starts_at as "startsAt",
            a.ends_at as "endsAt",
            a.status,
            a.patient_id as "patientId",
            a.cycle_id as "cycleId",
            a.series_id as "seriesId",
            p.first_name as "firstName",
            p.last_name as "lastName",
            p.birth_date as "birthDate",
            ${incompleteRecordSql("p")} as "incompleteRecord",
            -- La visita più recente con esiti di screening, per data, poi created_at, poi id;
            -- una bozza conta se ha già gli esiti: una appena aperta non nasconde la cautela della precedente.
            (coalesce(btrim(p.clinical_alert), '') <> ''
              or exists (select 1
                           from public.visit_screening_outcomes o
                          where o.practice_id = p.practice_id
                            and o.outcome <> 'indicated'
                            and o.visit_id = (select v.id
                                                from public.visits v
                                               where v.practice_id = p.practice_id and v.patient_id = p.id
                                                 and exists (select 1
                                                               from public.visit_screening_outcomes o2
                                                              where o2.practice_id = v.practice_id and o2.visit_id = v.id)
                                               order by v.visit_date desc, v.created_at desc, v.id desc
                                               limit 1))) as "clinicalAlert",
            s.name as "serviceName",
            s.kind as "serviceKind",
            c.expected_sessions as "expectedSessions",
            c.opened_on as "openedOn"
       from public.appointments a
       join public.patients p on p.practice_id = a.practice_id and p.id = a.patient_id
       join public.services s on s.practice_id = a.practice_id and s.id = a.service_id
       join public.treatment_cycles c on c.practice_id = a.practice_id and c.id = a.cycle_id
      where a.practice_id = $1 and a.starts_at >= $2 and a.starts_at < $3
      order by (a.status = 'annullato'), a.starts_at, a.id`,
    [practiceId, start, end],
  );
  if (rows.length === 0) return [];

  const cycleIds = [...new Set(rows.map((row) => row.cycleId))];
  const inCycles = await tx.query<CycleAppointment & { cycleId: string }>(
    `select id, cycle_id as "cycleId", starts_at as "startsAt", status
       from public.appointments
      where practice_id = $1 and cycle_id = any($2::uuid[])
      order by starts_at, id`,
    [practiceId, cycleIds],
  );
  const byCycle = new Map<string, CycleAppointment[]>(cycleIds.map((id) => [id, []]));
  for (const a of inCycles) byCycle.get(a.cycleId)?.push(a);
  const blockers = await loadBlockers(
    tx,
    practiceId,
    rows.map((row) => row.id),
  );
  // Una lettura per validità e blocchi (revoca o rifiuto) del consenso al trattamento.
  const { valid: consents, blocked } = await loadConsentDecisions(
    tx,
    practiceId,
    rows.map((row) => row.patientId),
  );

  const now = clock.now();
  const today = clock.today();
  const informativaShown = new Set<string>();
  const treatmentShown = new Set<string>();
  return rows.map((row) => {
    const ageDay = ageDayOf(row.birthDate, day);
    const minor = isMinor(row.birthDate, ageDay);
    const b = blockers.get(row.id) ?? UNKNOWN_BLOCKERS;
    const ctx: ActionContext = {
      status: row.status,
      startsAt: row.startsAt,
      day,
      today,
      now,
      hasVisit: b.hasVisit,
      hasAnyInvoiceLine: b.hasAnyInvoiceLine,
      hasMessage: b.hasMessage,
    };

    const signals: Signal[] = [];
    const block = isActive(row.status) ? blocked.get(row.patientId)?.get(row.cycleId) : undefined;
    if (isActive(row.status)) {
      const minorAtOpening = isMinor(row.birthDate, ageDayOf(row.birthDate, row.openedOn));
      const missing = missingModules(consents.get(row.patientId), row.cycleId, minor, minorAtOpening);
      const showInformativa = missing.includes("informativa") && !informativaShown.has(row.patientId);
      const showTreatment = block === undefined && missing.some((module) => module !== "informativa") && !treatmentShown.has(row.cycleId);
      // Il blocco spiega solo il trattamento. I due fatti si deduplicano separatamente.
      if (showInformativa) informativaShown.add(row.patientId);
      if (showTreatment) treatmentShown.add(row.cycleId);
      if (showInformativa || showTreatment) signals.push("consenso_mancante");
      if (row.incompleteRecord) signals.push("anagrafica_da_completare");
      if (row.status === "fatto" && !b.hasClosedVisit) signals.push("visita_da_compilare");
      if (row.status !== "fatto" && now.getTime() - row.endsAt.getTime() > CLOSE_AFTER_MS) signals.push("da_chiudere");
      if (row.clinicalAlert) signals.push("avviso_clinico");
    }

    return {
      id: row.id,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      status: row.status,
      patientId: row.patientId,
      patientLabel: minor ? `${lastFirst(row)}, ${age(row.birthDate, ageDay)}` : lastFirst(row),
      serviceName: row.serviceName,
      serviceKind: row.serviceKind,
      sessionLabel: sessionLabel(sessionPosition(row.id, byCycle.get(row.cycleId) ?? []), row.expectedSessions),
      signals,
      consentRevocationText: block?.kind === "revocato" ? revocationText(block.revokedOn) : null,
      consentRefused: block?.kind === "rifiutato",
      actions: allowedActions(ctx),
      doneQuestion: needsDoneConfirmation(ctx) ? doneQuestion(timeOf(row.startsAt)) : null,
      canOpenVisit: canOpenVisit(row.status, day, today),
      seriesId: row.seriesId,
    };
  });
}

/** "Promemoria per domani": il giorno A(1), il titolo e una riga per appuntamento. */
export interface ReminderBlock {
  /** A(1), "AAAA-MM-GG". */
  day: string;
  /** "Promemoria per domani, venerdì 23" o "Promemoria per lunedì 26"; il conteggio lo aggiunge la pagina. */
  title: string;
  rows: {
    appointmentId: string;
    startsAt: Date;
    /** "Marco Bellandi"; per un minore il contatto: "Sofia Rinaldi, a Elena (madre)". */
    recipientText: string;
    /** Il promemoria compilato con destinatario e permessi, riletto come nel compositore. */
    prepared: PreparedMessage;
    /** L'ultima riga `promemoria` di questo appuntamento; conferma e spostamento non contano. */
    lastMessage: MessageLogRow | null;
    /** Lo stato del promemoria: "Da inviare", "Aperto alle 18:02, inviato?", "Inviato alle 18:03", ... */
    statusText: string;
  }[];
}

type ReminderRowValue = ReminderBlock["rows"][number];
type Relationship = "madre" | "padre" | "tutore" | "altro";

const NO_WHATSAPP_REMINDER = "Manca il consenso WhatsApp: telefona o usa Copia per un SMS";

/**
 * Lo stato del promemoria: numero, canale, consenso WhatsApp e solo poi lo storico, in quest'ordine.
 * Il numero è quello del destinatario, prima della sostituzione della demo. Da confermare dice
 * l'azione vera della riga: un'apertura non diventa una copia, né il contrario.
 */
function reminderStatus(recipient: MessageRecipient, last: MessageLogRow | null): string {
  const phone = whatsappPhoneProblem(recipient.phone);
  if (phone !== null) return phone;
  if (recipient.preferredChannel === "telefono") return "Preferisce una telefonata";
  if (recipient.preferredChannel === "nessuno") return "Nessun promemoria";
  if (!recipient.whatsappConsent) return NO_WHATSAPP_REMINDER;
  if (last === null) return "Da inviare";
  switch (last.outcome) {
    case "da_confermare":
      return `${last.action === "whatsapp_aperto" ? "Aperto" : "Copiato"} alle ${timeOf(last.createdAt)}, inviato?`;
    case "inviato":
      return `Inviato alle ${timeOf(last.outcomeAt ?? last.createdAt)}`;
    case "non_inviato":
      return "Non inviato";
  }
}

/** L'ultima riga `promemoria` di ogni appuntamento, in una sola lettura. */
async function lastReminderMessages(tx: Tx, practiceId: string, ids: readonly string[]): Promise<Map<string, MessageLogRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.query<MessageLogRow & { appointmentId: string }>(
    `select distinct on (appointment_id)
            id, patient_id as "patientId", appointment_id as "appointmentId", visit_id as "visitId",
            template_key as "templateKey", recipient_name as "recipientName", recipient_phone as "recipientPhone",
            body, action, outcome, created_at as "createdAt", outcome_at as "outcomeAt"
       from public.message_log
      where practice_id = $1 and appointment_id = any($2::uuid[]) and template_key = 'promemoria'
      order by appointment_id, created_at desc, record_order desc`,
    [practiceId, ids],
  );
  return new Map(rows.map((row) => [row.appointmentId, row]));
}

/**
 * Le righe dei promemoria del primo giorno aperto dopo oggi (A(1); senza orari il giorno dopo):
 * gli appuntamenti prenotati e confermati, per orario; con `only` soltanto quell'appuntamento. Per un minore
 * alla data dell'appuntamento il destinatario è il genitore contatto, con la relazione fra parentesi (`altro`
 * senza).
 */
async function reminderRows(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  only: string | null,
): Promise<{ today: string; day: string; rows: ReminderRowValue[] }> {
  const today = clock.today();
  const day = openDayAfter(await getOpeningHours(tx, practiceId), today, 1);
  const { start, end } = romeDayBounds(day);
  const params: SqlParam[] = [practiceId, start, end];
  if (only !== null) params.push(only);
  const rows = await tx.query<{
    appointmentId: string;
    startsAt: Date;
    firstName: string;
    lastName: string;
    birthDate: string;
    guardianFirstName: string | null;
    relationship: Relationship | null;
  }>(
    `select a.id as "appointmentId",
            a.starts_at as "startsAt",
            p.first_name as "firstName",
            p.last_name as "lastName",
            p.birth_date as "birthDate",
            g.first_name as "guardianFirstName",
            g.relationship
       from public.appointments a
       join public.patients p on p.practice_id = a.practice_id and p.id = a.patient_id
       left join public.patient_guardians g
         on g.practice_id = a.practice_id and g.patient_id = a.patient_id and g.is_contact
      where a.practice_id = $1
        and a.status in ('prenotato', 'confermato')
        and a.starts_at >= $2 and a.starts_at < $3
        ${only === null ? "" : "and a.id = $4"}
      order by a.starts_at, a.id`,
    params,
  );

  const recipient = (row: (typeof rows)[number]): string => {
    const patient = firstLast(row);
    if (row.guardianFirstName === null || !isMinor(row.birthDate, ageDayOf(row.birthDate, day))) return patient;
    const relation = row.relationship === null || row.relationship === "altro" ? "" : ` (${row.relationship})`;
    return `${patient}, a ${row.guardianFirstName}${relation}`;
  };
  const last = await lastReminderMessages(tx, practiceId, rows.map((row) => row.appointmentId));
  const out: ReminderRowValue[] = [];
  for (const row of rows) {
    // Testo, destinatario e permessi come nel compositore e nel registro: una sola regola.
    const prepared = await prepareMessage(tx, practiceId, clock, {
      kind: "appointment",
      appointmentId: row.appointmentId,
      templateKey: "promemoria",
    });
    if (prepared === null) throw new Error("Il promemoria di un appuntamento dello studio non si prepara.");
    const lastMessage = last.get(row.appointmentId) ?? null;
    out.push({
      appointmentId: row.appointmentId,
      startsAt: row.startsAt,
      recipientText: recipient(row),
      prepared,
      lastMessage,
      statusText: reminderStatus(prepared.recipient, lastMessage),
    });
  }
  return { today, day, rows: out };
}

/** I promemoria di A(1) con il loro stato e le loro azioni. */
export async function listReminders(tx: Tx, practiceId: string, clock: Clock): Promise<ReminderBlock> {
  const { today, day, rows } = await reminderRows(tx, practiceId, clock, null);
  const date = weekdayDay(day);
  return {
    day,
    title: daysBetween(today, day) === 1 ? `Promemoria per domani, ${date}` : `Promemoria per ${date}`,
    rows,
  };
}

/**
 * Il promemoria di un appuntamento per il suo dettaglio: la stessa riga di Oggi, null se l'appuntamento non è
 * fra i promemoria di A(1) (un altro giorno, annullato, fatto) o non è dello studio.
 */
export async function getAppointmentReminder(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  appointmentId: string,
): Promise<ReminderRowValue | null> {
  AppointmentIdInput.parse({ id: appointmentId });
  const { rows } = await reminderRows(tx, practiceId, clock, appointmentId);
  return rows[0] ?? null;
}

/** Un appuntamento della griglia dell'agenda, prima di `toBlock`. */
export interface AgendaAppointment {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  patientFirstName: string;
  patientLastName: string;
  serviceName: string;
  color: ServiceColor;
}

/**
 * Gli appuntamenti di ogni stato da `fromDay` incluso a `toDayExclusive` escluso, per orario. I limiti
 * sono le 00:00 di Roma di quei giorni: la domenica di 25 ore del 25/10/2026 resta tutta
 * nella sua settimana e il lunedì alle 00:30 sta nella successiva. Gli annullati ci sono: la pagina
 * decide se mostrarli ("Mostra annullati").
 */
export async function listRange(
  tx: Tx,
  practiceId: string,
  fromDay: string,
  toDayExclusive: string,
): Promise<AgendaAppointment[]> {
  return tx.query<AgendaAppointment>(
    `select a.id,
            a.starts_at as "startsAt",
            a.ends_at as "endsAt",
            a.status,
            p.first_name as "patientFirstName",
            p.last_name as "patientLastName",
            s.name as "serviceName",
            s.color
       from public.appointments a
       join public.patients p on p.practice_id = a.practice_id and p.id = a.patient_id
       join public.services s on s.practice_id = a.practice_id and s.id = a.service_id
      where a.practice_id = $1 and a.starts_at >= $2 and a.starts_at < $3
      order by a.starts_at, a.id`,
    [practiceId, romeDayBounds(fromDay).start, romeDayBounds(toDayExclusive).start],
  );
}

// Il dettaglio dell'appuntamento e il pannello "Seduta fatta":
// letture di un appuntamento solo, per il pannello laterale dell'agenda e per le azioni delle righe di
// Oggi. Le azioni sono quelle della tabella degli stati con i blocchi letti nel database, come in Oggi.

type PaymentMethod = "contanti" | "carta" | "bonifico";

/**
 * La fattura con la riga attiva sulla seduta: il numero fuori dalla bozza, null in bozza.
 * La riga «Fattura» del dettaglio e il passo 1 del pannello "Seduta fatta" la mostrano col link.
 */
export interface AppointmentInvoice {
  id: string;
  numberLabel: string | null;
  status: "bozza" | "emessa" | "pagata" | "annullata";
}

const INVOICE_STATUSES: readonly AppointmentInvoice["status"][] = ["bozza", "emessa", "pagata", "annullata"];

/** La fattura della seduta, se c'è; uno stato che non conosciamo è un errore del database, non un dato. */
async function appointmentInvoice(tx: Tx, practiceId: string, appointmentId: string): Promise<AppointmentInvoice | null> {
  const row = await invoiceOfAppointment(tx, practiceId, appointmentId);
  if (row === null) return null;
  const status = INVOICE_STATUSES.find((s) => s === row.status);
  if (status === undefined) throw new Error(`Stato della fattura sconosciuto: ${row.status}`);
  return { id: row.id, numberLabel: row.numberLabel, status };
}

/** Il dettaglio di un appuntamento, con il promemoria se è fra quelli di A(1). */
export interface AppointmentDetail {
  id: string;
  /** Per il link alla scheda del paziente (patientHref). */
  patientId: string;
  /** Il paziente come lo mostra il selettore: nel modo "Modifica" del dialogo resta in sola lettura. */
  patient: PatientHit;
  /** "Nome Cognome". */
  patientName: string;
  serviceId: string;
  serviceName: string;
  /** "mercoledì 4 novembre 2026". */
  dayText: string;
  /** "17:00-17:45". */
  timeText: string;
  /** "45 min". */
  durationText: string;
  cycleId: string;
  cycleTitle: string;
  /** "Seduta 2 di 4"; null per un annullato o un saltato. */
  sessionLabel: string | null;
  status: AppointmentStatus;
  /** Le azioni ammesse dallo stato che il dettaglio offre, nell'ordine della tabella. */
  actions: AppointmentAction[];
  /** "Inizia alle 17:00. Segnarlo comunque come fatto?" prima dell'inizio, altrimenti null. */
  doneQuestion: string | null;
  priceCents: number;
  notes: string | null;
  /** Manca il consenso al trattamento di questo ciclo, per l'età alla data dell'appuntamento. */
  consentMissing: boolean;
  /** «Raccogli ora»: il consenso al trattamento che manca, per il ciclo aperto dell'appuntamento; null altrimenti. */
  consentTarget: ConsentTarget | null;
  /** «Consenso revocato il 20/10» se una revoca decide il consenso del ciclo; null altrimenti. */
  consentRevocationText: string | null;
  /** Revoca o rifiuto bloccano il trattamento: «Consenso al trattamento revocato: puoi solo annotare il colloquio.». */
  consentBlockText: string | null;
  /** I passi fatti del pannello "Seduta fatta" ("1 passo su 3"); null se l'appuntamento non è fatto. */
  stepsDone: number | null;
  /** La visita dell'appuntamento, se c'è (la riga «Visita» del dettaglio). */
  visit: { id: string; status: "draft" | "closed" } | null;
  /** La fattura della seduta, se c'è (la riga «Fattura» del dettaglio). */
  invoice: AppointmentInvoice | null;
  /** "Apri la visita" crea la visita che manca: prenotato, confermato o fatto di un giorno fino a oggi. */
  canOpenVisit: boolean;
  /** Le successive della serie che "Annulla appuntamento" può annullare insieme; 0 fuori da una serie. */
  seriesFollowing: number;
  /** I valori del dialogo in modo "Modifica"; `updatedAt` è il token ottimistico, in ISO. */
  edit: { day: string; time: string; durationMin: number; updatedAt: string };
  /** La riga del promemoria di Oggi per questo appuntamento; null fuori dai promemoria di A(1). */
  reminder: ReminderBlock["rows"][number] | null;
  /** Solo i log legati esplicitamente a questo appuntamento. */
  messages: MessageLogRow[];
}

/** Il pannello "Seduta fatta" di un appuntamento fatto. */
export interface SedutaFattaView {
  appointmentId: string;
  /** "Seduta fatta: Marco Bellandi". */
  title: string;
  consentMissing: boolean;
  /** «Raccogli ora» del banner: il consenso al trattamento che manca, per il ciclo aperto; null altrimenti. */
  consentTarget: ConsentTarget | null;
  /** «Consenso revocato il 20/10» se una revoca decide il consenso del ciclo; null altrimenti. */
  consentRevocationText: string | null;
  /** Revoca o rifiuto bloccano il trattamento; null se il consenso manca soltanto o c'è. */
  consentBlockText: string | null;
  /** Il metodo scelto nel passo 1, un suggerimento per la fattura; null è "Non ancora incassato". */
  paymentMethod: PaymentMethod | null;
  steps: { incasso: boolean; prossima: boolean; visita: boolean };
  next: NextSession;
  patient: PatientHit;
  cycleId: string;
  /** La visita dell'appuntamento, bozza o chiusa; null se non c'è ("Compila ora" la crea). */
  visitId: string | null;
  /** Il tipo del ciclo dell'appuntamento: "Chiudi il ciclo" per un trattamento, "Chiudi il mantenimento" per l'altro. */
  cycleKind: CycleKind;
  /** Il ciclo dell'appuntamento è aperto: il passo 2 offre di chiuderlo. */
  canCloseCycle: boolean;
  /** La fattura della seduta, se c'è: il passo 1 fatto mostra «Fattura 273/2026» col link. */
  invoice: AppointmentInvoice | null;
}

interface PatientFields {
  patientId: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  phone: string | null;
  archived: boolean;
}

interface AppointmentCore {
  id: string;
  startsAt: Date;
  endsAt: Date;
  durationMin: number;
  updatedAt: Date;
  status: AppointmentStatus;
  priceCents: number;
  notes: string | null;
  paymentMethod: PaymentMethod | null;
  noInvoiceReason: boolean;
  serviceId: string;
  serviceName: string;
  cycleId: string;
  cycleTitle: string;
  expectedSessions: number | null;
  cycleKind: CycleKind;
  cycleClosed: boolean;
  openedOn: string;
  patient: PatientHit;
  blockers: Blockers;
}

/**
 * L'appuntamento con paziente, prestazione, ciclo e blocchi; null se non c'è o è di un altro studio.
 * `updated_at` torna al millisecondo, com'è il token del comando di modifica.
 */
async function appointmentCore(tx: Tx, practiceId: string, id: string): Promise<AppointmentCore | null> {
  const [row] = await tx.query<Omit<AppointmentCore, "patient" | "blockers"> & PatientFields>(
    `select a.id,
            a.starts_at as "startsAt",
            a.ends_at as "endsAt",
            a.duration_min as "durationMin",
            date_trunc('milliseconds', a.updated_at) as "updatedAt",
            a.status,
            a.price_cents as "priceCents",
            a.notes,
            a.payment_method as "paymentMethod",
            a.no_invoice_reason is not null as "noInvoiceReason",
            a.service_id as "serviceId",
            s.name as "serviceName",
            a.cycle_id as "cycleId",
            c.title as "cycleTitle",
            c.expected_sessions as "expectedSessions",
            c.kind as "cycleKind",
            c.status = 'closed' as "cycleClosed",
            c.opened_on as "openedOn",
            p.id as "patientId",
            p.first_name as "firstName",
            p.last_name as "lastName",
            p.birth_date as "birthDate",
            p.phone,
            p.archived_at is not null as archived
       from public.appointments a
       join public.patients p on p.practice_id = a.practice_id and p.id = a.patient_id
       join public.services s on s.practice_id = a.practice_id and s.id = a.service_id
       join public.treatment_cycles c on c.practice_id = a.practice_id and c.id = a.cycle_id
      where a.practice_id = $1 and a.id = $2`,
    [practiceId, id],
  );
  if (!row) return null;
  const blockers = (await loadBlockers(tx, practiceId, [id])).get(id) ?? UNKNOWN_BLOCKERS;
  const { patientId, firstName, lastName, birthDate, phone, archived, ...appointment } = row;
  return { ...appointment, patient: { id: patientId, firstName, lastName, birthDate, phone, archived }, blockers };
}

type TreatmentConsent = Pick<
  AppointmentDetail,
  "consentMissing" | "consentTarget" | "consentRevocationText" | "consentBlockText"
>;

/**
 * Il consenso al trattamento del ciclo: se manca, per l'età alla data
 * dell'appuntamento (lo stato di `getConsentStatus`); il bersaglio di «Raccogli ora» se il ciclo è aperto e chi
 * firma c'è; la revoca (con la data) o il rifiuto che lo decide e lo blocca. Una sola lettura (`loadConsentDecisions`).
 */
async function treatmentConsent(tx: Tx, practiceId: string, clock: Clock, a: AppointmentCore): Promise<TreatmentConsent> {
  const day = todayRome(a.startsAt);
  const minor = isMinor(a.patient.birthDate, ageDayOf(a.patient.birthDate, day));
  const decisions = await loadConsentDecisions(tx, practiceId, [a.patient.id]);
  const minorAtOpening = isMinor(a.patient.birthDate, ageDayOf(a.patient.birthDate, a.openedOn));
  const missing = missingModules(decisions.valid.get(a.patient.id), a.cycleId, minor, minorAtOpening).some(
    (module) => module !== "informativa",
  );
  const block = decisions.blocked.get(a.patient.id)?.get(a.cycleId);
  let target: ConsentTarget | null = null;
  if (missing && !a.cycleClosed) {
    const today = clock.today();
    const guardianId = (await loadConsentGuardians(tx, practiceId, [a.patient.id])).get(a.patient.id) ?? null;
    // Un minore senza chi firmi non ha un modulo da raccogliere: resta solo «L'ho raccolto su carta».
    const signerMissing = isMinor(a.patient.birthDate, ageDayOf(a.patient.birthDate, today)) && guardianId === null;
    if (!signerMissing) target = consentTarget(a.patient, today, guardianId, { kind: "trattamento", cycleId: a.cycleId }, a.id);
  }
  return {
    consentMissing: missing,
    consentTarget: target,
    consentRevocationText: block?.kind === "revocato" ? revocationText(block.revokedOn) : null,
    consentBlockText: block === undefined ? null : blockText(block),
  };
}

/**
 * I passi del pannello: 1 fatto con una riga di fattura attiva o con `no_invoice_reason`;
 * 2 fatto con la prossima seduta già fissata o con il ciclo chiuso; 3 fatto con la visita chiusa.
 */
async function stepsOf(tx: Tx, practiceId: string, clock: Clock, a: AppointmentCore): Promise<SedutaFattaView["steps"]> {
  return {
    incasso: a.blockers.hasActiveInvoiceLine || a.noInvoiceReason,
    prossima: a.cycleClosed || (await firstBookedAfter(tx, practiceId, clock, a.cycleId, a.startsAt)) !== null,
    visita: a.blockers.hasClosedVisit,
  };
}

const countDone = (steps: SedutaFattaView["steps"]): number => Object.values(steps).filter(Boolean).length;

/** La visita di un appuntamento (una sola per appuntamento); null se non c'è. */
async function visitOf(
  tx: Tx,
  practiceId: string,
  appointmentId: string,
): Promise<{ id: string; status: "draft" | "closed" } | null> {
  const [visit] = await tx.query<{ id: string; status: "draft" | "closed" }>(
    "select id, status from public.visits where practice_id = $1 and appointment_id = $2",
    [practiceId, appointmentId],
  );
  return visit ?? null;
}

/** Il dettaglio di un appuntamento dello studio; null se non c'è (o è di un altro studio). */
export async function getAppointmentDetail(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  id: string,
): Promise<AppointmentDetail | null> {
  AppointmentIdInput.parse({ id });
  const a = await appointmentCore(tx, practiceId, id);
  if (!a) return null;

  const day = todayRome(a.startsAt);
  const ctx: ActionContext = {
    status: a.status,
    startsAt: a.startsAt,
    day,
    today: clock.today(),
    now: clock.now(),
    hasVisit: a.blockers.hasVisit,
    hasAnyInvoiceLine: a.blockers.hasAnyInvoiceLine,
    hasMessage: a.blockers.hasMessage,
  };
  const inCycle = await listCycleAppointments(tx, practiceId, a.cycleId);

  return {
    id: a.id,
    patientId: a.patient.id,
    patient: a.patient,
    patientName: firstLast(a.patient),
    serviceId: a.serviceId,
    serviceName: a.serviceName,
    dayText: dayLong(day),
    timeText: timeRange(a.startsAt, a.endsAt),
    durationText: durationShort(a.durationMin),
    cycleId: a.cycleId,
    cycleTitle: a.cycleTitle,
    sessionLabel: sessionLabel(sessionPosition(a.id, inCycle), a.expectedSessions),
    status: a.status,
    actions: allowedActions(ctx),
    doneQuestion: needsDoneConfirmation(ctx) ? doneQuestion(timeOf(a.startsAt)) : null,
    priceCents: a.priceCents,
    notes: a.notes,
    ...(await treatmentConsent(tx, practiceId, clock, a)),
    stepsDone: a.status === "fatto" ? countDone(await stepsOf(tx, practiceId, clock, a)) : null,
    visit: await visitOf(tx, practiceId, a.id),
    invoice: await appointmentInvoice(tx, practiceId, a.id),
    canOpenVisit: canOpenVisit(a.status, day, clock.today()),
    seriesFollowing: await followingInSeries(tx, practiceId, a.id),
    edit: { day, time: timeOf(a.startsAt), durationMin: a.durationMin, updatedAt: a.updatedAt.toISOString() },
    reminder: await getAppointmentReminder(tx, practiceId, clock, a.id),
    messages: await listAppointmentMessages(tx, practiceId, a.id),
  };
}

/**
 * Il pannello "Seduta fatta" di un appuntamento fatto; null se non c'è, è di un altro studio o non è
 * fatto. Con il ciclo chiuso non c'è una prossima seduta da proporre: il passo 2 è già fatto.
 */
export async function getSedutaFatta(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  id: string,
): Promise<SedutaFattaView | null> {
  AppointmentIdInput.parse({ id });
  const a = await appointmentCore(tx, practiceId, id);
  if (!a || a.status !== "fatto") return null;
  return {
    appointmentId: a.id,
    title: `Seduta fatta: ${firstLast(a.patient)}`,
    ...(await treatmentConsent(tx, practiceId, clock, a)),
    paymentMethod: a.paymentMethod,
    steps: await stepsOf(tx, practiceId, clock, a),
    next: a.cycleClosed ? { kind: "none" } : await nextSession(tx, practiceId, clock, { appointmentId: a.id }),
    patient: a.patient,
    cycleId: a.cycleId,
    visitId: (await visitOf(tx, practiceId, a.id))?.id ?? null,
    cycleKind: a.cycleKind,
    canCloseCycle: !a.cycleClosed,
    invoice: await appointmentInvoice(tx, practiceId, a.id),
  };
}
