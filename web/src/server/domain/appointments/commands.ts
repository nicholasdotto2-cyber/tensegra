import type { z } from "zod";
import { newCycleKind, type ServiceKind } from "@/lib/agenda/defaults";
import { slotState } from "@/lib/agenda/slots";
import {
  type ActionContext,
  type AppointmentAction,
  type AppointmentStatus,
  allowedActions,
  VISIT_KEEPS_DAY,
} from "@/lib/agenda/status";
import { type Clock, endsSameRomeDay, isoWeekday, romeMinutes, todayRome, weeklyDays } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { pgCode } from "@/server/db/errors";
import { moveCycleOpeningBack, openCycle } from "@/server/domain/cycles/commands";
import { BLOCKED_DELETE, ConflictError, DomainError, isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { createPatient } from "@/server/domain/patients/commands";
import { clearRecallSnooze } from "@/server/domain/patients/recall-commands";
import { appointmentStart, type Blockers, followingIdsInSeries, loadBlockers, loadBusy } from "./queries";
import {
  AppointmentIdInput,
  CancelInput,
  EditAppointmentInput,
  NewAppointmentInput,
  PaymentMethodInput,
} from "./schemas";

// Creazione degli appuntamenti dal dialogo "Nuovo appuntamento".
// Prima tutte le letture e i controlli del comando, poi le scritture: un controllo che
// fallisce non lascia un paziente o un ciclo a metà. Le regole proprie del paziente nuovo e del ciclo
// nuovo le controllano `createPatient` e `openCycle` prima della loro insert. Sovrapposizioni e orari
// chiusi non bloccano: li mostra l'anteprima. Il comando non scrive `cancel_reason`, `payment_method` né `no_invoice_reason`, che
// sono dei cambi di stato e del pannello "Seduta fatta".

const ARCHIVED = "Paziente archiviato: ripristinalo dalla sua scheda.";
const SAME_DAY = "L'appuntamento deve finire entro la stessa giornata.";
const NO_DATES = "Scegli almeno una data.";

type ParsedAppointment = z.output<typeof NewAppointmentInput>;

export interface CreatedAppointments {
  /** In ordine di orario. */
  appointments: { id: string; startsAt: Date; status: AppointmentStatus }[];
  /** La serie, se le date create sono 2 o più. */
  seriesId: string | null;
  cycleId: string;
  patientId: string;
}

/** Un paziente esistente, non archiviato. Se non c'è (o è di un altro studio) è "Operazione non permessa". */
async function checkPatient(tx: Tx, practiceId: string, patientId: string): Promise<void> {
  const [row] = await tx.query<{ archived: boolean }>(
    "select archived_at is not null as archived from public.patients where practice_id = $1 and id = $2",
    [practiceId, patientId],
  );
  if (!row) throw new DomainError(NOT_ALLOWED, { field: "patient" });
  if (row.archived) throw new DomainError(ARCHIVED, { field: "patient" });
}

/** Il tipo di una voce attiva del listino dello studio; una voce archiviata non si sceglie più. */
async function activeServiceKind(tx: Tx, practiceId: string, serviceId: string): Promise<ServiceKind> {
  const [row] = await tx.query<{ kind: ServiceKind }>(
    "select kind from public.services where practice_id = $1 and id = $2 and archived_at is null",
    [practiceId, serviceId],
  );
  if (!row) throw new DomainError(NOT_ALLOWED, { field: "serviceId" });
  return row.kind;
}

/** Il ciclo aperto dello stesso paziente. Un paziente nuovo non ha cicli. */
async function checkOpenCycle(tx: Tx, practiceId: string, patientId: string | null, cycleId: string): Promise<void> {
  const rows =
    patientId === null
      ? []
      : await tx.query(
          `select 1
             from public.treatment_cycles
            where practice_id = $1 and id = $2 and patient_id = $3 and status = 'open'`,
          [practiceId, cycleId, patientId],
        );
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED, { field: "cycle" });
}

/** Le date da creare, in ordine: la serie meno le righe tolte dall'anteprima, o la sola data scelta. */
function datesOf(a: ParsedAppointment): [string, ...string[]] {
  if (!a.repeat) return [a.day];
  const excluded = new Set(a.repeat.excludedDays);
  const [first, ...rest] = weeklyDays(a.day, a.repeat.intervalWeeks, a.repeat.count).filter((day) => !excluded.has(day));
  if (first === undefined) throw new DomainError(NO_DATES, { field: "repeat.excludedDays" });
  return [first, ...rest];
}

/**
 * Crea il paziente del mini modulo. Le sue regole (nascita, genitore del minore) rispondono sui campi
 * del modulo, che nel dialogo stanno sotto `patient.`.
 */
async function createNewPatient(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  p: Extract<ParsedAppointment["patient"], { kind: "new" }>,
): Promise<string> {
  const fields = {
    firstName: p.firstName,
    lastName: p.lastName,
    birthDate: p.birthDate,
    phone: p.phone,
    ...(p.guardian ? { guardian: p.guardian } : {}),
  };
  try {
    return (await createPatient(tx, practiceId, clock, fields)).id;
  } catch (error) {
    if (isDomainError(error) && error.field !== undefined) {
      throw new DomainError(error.message, { field: `patient.${error.field}` });
    }
    throw error;
  }
}

/**
 * Prenota un appuntamento o una serie nell'ora di Roma. In quest'ordine, senza scrivere niente:
 * paziente esistente non archiviato, voce attiva del listino, ciclo aperto dello stesso paziente,
 * date (con la ripetizione almeno una), ogni inizio un orario di Roma che finisce prima delle 00:00
 * (prima del trigger del database), `fatto` solo fino a oggi e senza ripetizione. Poi
 * le scritture: il paziente nuovo, il ciclo nuovo (`opened_on` non dopo la prima data), la serie con
 * 2 date o più (`count` = date create), gli appuntamenti con `status_changed_at` dal clock.
 */
export async function createAppointment(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
): Promise<CreatedAppointments> {
  const a = NewAppointmentInput.parse(input);

  if (a.patient.kind === "existing") await checkPatient(tx, practiceId, a.patient.patientId);
  const serviceKind = await activeServiceKind(tx, practiceId, a.serviceId);
  if (a.cycle.kind === "existing") {
    const patientId = a.patient.kind === "existing" ? a.patient.patientId : null;
    await checkOpenCycle(tx, practiceId, patientId, a.cycle.cycleId);
  }
  const days = datesOf(a);
  const [firstDay] = days;
  const starts = days.map((day) => appointmentStart(day, a.time));
  if (starts.some((start) => !endsSameRomeDay(start, a.durationMin))) {
    throw new DomainError(SAME_DAY, { field: "time" });
  }
  // I giorni "AAAA-MM-GG" in ordine di testo sono in ordine di calendario.
  const today = clock.today();
  if (a.status === "fatto" && (a.repeat !== undefined || days.some((day) => day > today))) {
    throw new DomainError(NOT_ALLOWED, { field: "status" });
  }

  const patientId =
    a.patient.kind === "existing" ? a.patient.patientId : await createNewPatient(tx, practiceId, clock, a.patient);
  const cycleId =
    a.cycle.kind === "existing"
      ? a.cycle.cycleId
      : (
          await openCycle(tx, practiceId, clock, {
            patientId,
            kind: newCycleKind(serviceKind),
            firstAppointmentDay: firstDay,
          })
        ).id;
  // Un ciclo esistente si apre al più tardi nel giorno del primo appuntamento. Quello
  // appena aperto ha già `opened_on` non dopo la prima data: la update non lo tocca.
  await moveCycleOpeningBack(tx, practiceId, cycleId, firstDay);

  let seriesId: string | null = null;
  if (a.repeat && days.length >= 2) {
    const [series] = await tx.query<{ id: string }>(
      `insert into public.appointment_series (practice_id, weekday, local_time, interval_weeks, count)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [practiceId, isoWeekday(firstDay), a.time, a.repeat.intervalWeeks, days.length],
    );
    if (!series) throw new DomainError(NOT_ALLOWED);
    seriesId = series.id;
  }

  const changedAt = clock.now();
  const appointments: CreatedAppointments["appointments"] = [];
  for (const startsAt of starts) {
    const [row] = await tx.query<{ id: string; startsAt: Date; status: AppointmentStatus }>(
      `insert into public.appointments
         (practice_id, patient_id, service_id, cycle_id, series_id, starts_at, duration_min, price_cents,
          status, status_changed_at, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id, starts_at as "startsAt", status`,
      [
        practiceId,
        patientId,
        a.serviceId,
        cycleId,
        seriesId,
        startsAt,
        a.durationMin,
        a.priceCents,
        a.status,
        changedAt,
        a.notes ?? null,
      ],
    );
    if (!row) throw new DomainError(NOT_ALLOWED);
    appointments.push(row);
  }
  // Un appuntamento che nasce fatto ricalcola il richiamo: il rinvio di prima non vale più.
  if (a.status === "fatto") await clearRecallSnooze(tx, practiceId, patientId);
  return { appointments, seriesId, cycleId, patientId };
}

// Cambi di stato, modifica ed eliminazione. Ogni comando legge la riga e riapplica la
// tabella degli stati in due tempi: prima stato e
// orario (`allowedActions` senza i blocchi, altrimenti "Operazione non permessa"), poi i blocchi di
// `loadBlockers` con la loro frase. La scrittura porta nella where lo stato letto: se nel mezzo
// un'altra finestra lo ha cambiato, 0 righe e `ConflictError`. `status_changed_at` viene dal clock.

const HAS_VISIT = "C'è già una visita";
const DRAFT_INVOICE = "C'è già una fattura in bozza.";
const issuedInvoice = (label: string): string => `C'è già la fattura n. ${label}`;

type CancelReason = z.output<typeof CancelInput>["reason"];

interface CurrentAppointment {
  status: AppointmentStatus;
  startsAt: Date;
  durationMin: number;
}

/** L'appuntamento com'è nel database. Se non c'è (o è di un altro studio) è "Operazione non permessa". */
async function currentOf(tx: Tx, practiceId: string, id: string): Promise<CurrentAppointment> {
  const [row] = await tx.query<CurrentAppointment>(
    `select status, starts_at as "startsAt", duration_min as "durationMin"
       from public.appointments
      where practice_id = $1 and id = $2`,
    [practiceId, id],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return row;
}

/**
 * Stato e orario dalla tabella degli stati, senza i blocchi: una visita, una riga di fattura o un
 * messaggio rispondono dopo, ciascuno con la sua frase, e non con "Operazione non permessa".
 */
function requireAction(current: CurrentAppointment, clock: Clock, action: AppointmentAction): void {
  const ctx: ActionContext = {
    status: current.status,
    startsAt: current.startsAt,
    day: todayRome(current.startsAt),
    today: clock.today(),
    now: clock.now(),
    hasVisit: false,
    hasAnyInvoiceLine: false,
    hasMessage: false,
  };
  if (!allowedActions(ctx).includes(action)) throw new DomainError(NOT_ALLOWED);
}

async function blockersOf(tx: Tx, practiceId: string, id: string): Promise<Blockers> {
  const blockers = (await loadBlockers(tx, practiceId, [id])).get(id);
  if (!blockers) throw new DomainError(NOT_ALLOWED);
  return blockers;
}

/** Il cambio di stato, solo se lo stato è ancora quello letto; il motivo c'è solo per `annullato`. */
async function changeStatus(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  id: string,
  from: AppointmentStatus,
  to: AppointmentStatus,
  cancelReason: CancelReason | null = null,
): Promise<void> {
  const rows = await tx.query(
    `update public.appointments
        set status = $4, status_changed_at = $5, cancel_reason = $6
      where id = $1 and practice_id = $2 and status = $3
      returning id`,
    [id, practiceId, from, to, clock.now(), cancelReason],
  );
  if (rows.length === 0) throw new ConflictError();
}

/** Un cambio di stato senza blocchi: legge, controlla stato e orario, scrive. */
async function plainTransition(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
  action: AppointmentAction,
  to: AppointmentStatus,
): Promise<void> {
  const { id } = AppointmentIdInput.parse(input);
  const current = await currentOf(tx, practiceId, id);
  requireAction(current, clock, action);
  await changeStatus(tx, practiceId, clock, id, current.status, to);
}

/** "Segna confermato": da prenotato, senza nessun messaggio automatico. */
export async function markConfirmed(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  await plainTransition(tx, practiceId, clock, input, "segna_confermato", "confermato");
}

/**
 * "Segna come fatta": da prenotato o confermato, in un giorno fino a oggi, anche prima dell'inizio
 * (la domanda "Inizia alle 17:00..." la fa l'interfaccia). Mai automatico. Il nuovo fatto azzera il
 * rinvio del richiamo, anche dalla chiusura della visita con `alsoMarkDone`.
 */
export async function markDone(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  await plainTransition(tx, practiceId, clock, input, "segna_fatta", "fatto");
  const { id } = AppointmentIdInput.parse(input);
  const [row] = await tx.query<{ patientId: string }>(
    `select patient_id as "patientId" from public.appointments where practice_id = $1 and id = $2`,
    [practiceId, id],
  );
  if (row) await clearRecallSnooze(tx, practiceId, row.patientId);
}

/** "Saltato": da prenotato o confermato, solo dopo l'inizio e senza una visita; l'orario si libera. */
export async function markSkipped(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { id } = AppointmentIdInput.parse(input);
  const current = await currentOf(tx, practiceId, id);
  requireAction(current, clock, "saltato");
  if ((await blockersOf(tx, practiceId, id)).hasVisit) throw new DomainError(HAS_VISIT);
  await changeStatus(tx, practiceId, clock, id, current.status, "saltato");
}

/**
 * "Annulla 'fatto'": torna confermato se non c'è una visita né una riga di fattura attiva, emessa o
 * in bozza. Una riga di una fattura annullata (`link_active` falso) non blocca.
 */
export async function undoDone(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { id } = AppointmentIdInput.parse(input);
  const current = await currentOf(tx, practiceId, id);
  requireAction(current, clock, "annulla_fatto");
  const blockers = await blockersOf(tx, practiceId, id);
  if (blockers.hasVisit) throw new DomainError(HAS_VISIT);
  if (blockers.hasActiveInvoiceLine) {
    const label = blockers.activeInvoiceLabel;
    throw new DomainError(label === null ? DRAFT_INVOICE : issuedInvoice(label));
  }
  await changeStatus(tx, practiceId, clock, id, current.status, "confermato");
}

/**
 * "Annulla appuntamento" con il motivo, da prenotato o confermato, se non c'è una visita.
 * Con `alsoFollowing` annulla con lo stesso motivo anche le successive della serie
 * (`followingIdsInSeries`); restituisce quanti appuntamenti ha annullato.
 */
export async function cancelAppointment(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
): Promise<{ cancelled: number }> {
  const { id, reason, alsoFollowing } = CancelInput.parse(input);
  const current = await currentOf(tx, practiceId, id);
  requireAction(current, clock, "annulla");
  if ((await blockersOf(tx, practiceId, id)).hasVisit) throw new DomainError(HAS_VISIT);
  const following = alsoFollowing ? await followingIdsInSeries(tx, practiceId, id) : [];
  await changeStatus(tx, practiceId, clock, id, current.status, "annullato", reason);
  if (following.length === 0) return { cancelled: 1 };
  const rows = await tx.query(
    `update public.appointments
        set status = 'annullato', status_changed_at = $3, cancel_reason = $4
      where practice_id = $1 and id = any($2::uuid[]) and status in ('prenotato', 'confermato')
      returning id`,
    [practiceId, following, clock.now(), reason],
  );
  return { cancelled: 1 + rows.length };
}

/**
 * Il primo appuntamento attivo che tocca l'orario di `current` ("Bianchi Carla, 09:00-09:45"), o null.
 * Senza le fasce dello studio: la sovrapposizione viene prima di ogni altro stato.
 */
async function overlapOf(tx: Tx, practiceId: string, id: string, current: CurrentAppointment): Promise<string | null> {
  const day = todayRome(current.startsAt);
  const busy = (await loadBusy(tx, practiceId, [day], id)).get(day) ?? [];
  const startMin = romeMinutes(current.startsAt);
  const state = slotState([], busy, startMin, startMin + current.durationMin);
  return state.kind === "sovrapposto" ? state.with : null;
}

/**
 * "Ripristina": un saltato o un annullato che non è ancora iniziato torna prenotato, senza motivo.
 * Non blocca una sovrapposizione: la restituisce in `overlap`.
 */
export async function restoreAppointment(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
): Promise<{ overlap: string | null }> {
  const { id } = AppointmentIdInput.parse(input);
  const current = await currentOf(tx, practiceId, id);
  requireAction(current, clock, "ripristina");
  await changeStatus(tx, practiceId, clock, id, current.status, "prenotato");
  return { overlap: await overlapOf(tx, practiceId, id, current) };
}

/**
 * "Annulla 'saltato'": un saltato già iniziato, dato per errore, torna confermato, senza
 * conferma perché si torna indietro. L'orario si era liberato: come "Ripristina" non blocca una
 * sovrapposizione e la restituisce in `overlap`.
 */
export async function undoSkipped(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
): Promise<{ overlap: string | null }> {
  const { id } = AppointmentIdInput.parse(input);
  const current = await currentOf(tx, practiceId, id);
  requireAction(current, clock, "annulla_saltato");
  await changeStatus(tx, practiceId, clock, id, current.status, "confermato");
  return { overlap: await overlapOf(tx, practiceId, id, current) };
}

/**
 * "Elimina": un prenotato o un confermato senza visita, senza righe di
 * fattura (anche di una fattura annullata) e senza messaggi registrati, che non si cancellano;
 * altrimenti resta "Annulla". Prima il controllo esplicito, poi la delete; se arriva
 * comunque al database, `23001` (Postgres 18) e `23503` (Postgres 17) sono lo stesso blocco.
 */
export async function deleteAppointment(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { id } = AppointmentIdInput.parse(input);
  const current = await currentOf(tx, practiceId, id);
  requireAction(current, clock, "elimina");
  const blockers = await blockersOf(tx, practiceId, id);
  if (blockers.hasVisit || blockers.hasAnyInvoiceLine || blockers.hasMessage) throw new DomainError(BLOCKED_DELETE);
  let rows: unknown[];
  try {
    rows = await tx.query(
      "delete from public.appointments where id = $1 and practice_id = $2 and status = $3 returning id",
      [id, practiceId, current.status],
    );
  } catch (error) {
    const code = pgCode(error);
    if (code === "23001" || code === "23503") throw new DomainError(BLOCKED_DELETE);
    throw error;
  }
  if (rows.length === 0) throw new ConflictError();
}

/**
 * "Modifica" di un prenotato o di un confermato, con paziente e ciclo invariati. Il
 * token è l'`updated_at` letto all'apertura del dialogo, al millisecondo: se non combacia, un'altra
 * finestra ha scritto, e risponde `ConflictError` prima di ogni altra regola. Poi stato, prestazione
 * (quella già scelta, anche se archiviata, o una voce attiva del listino) e fine entro la giornata.
 * Con una visita, in bozza o chiusa, il giorno resta quello della visita (`VISIT_KEEPS_DAY`):
 * cambia solo l'ora. Spostare data o ora porta un confermato a prenotato e lo dice con
 * `movedFromConfirmed` (il messaggio di spostamento).
 */
export async function updateAppointment(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
): Promise<{ movedFromConfirmed: boolean }> {
  const e = EditAppointmentInput.parse(input);
  const [current] = await tx.query<CurrentAppointment & { serviceId: string; cycleId: string; fresh: boolean }>(
    `select status, starts_at as "startsAt", duration_min as "durationMin", service_id as "serviceId",
            cycle_id as "cycleId",
            date_trunc('milliseconds', updated_at) = $3::timestamptz as fresh
       from public.appointments
      where practice_id = $1 and id = $2`,
    [practiceId, e.id, e.expectedUpdatedAt],
  );
  if (!current) throw new DomainError(NOT_ALLOWED);
  if (!current.fresh) throw new ConflictError();
  requireAction(current, clock, "modifica");
  if (e.serviceId !== current.serviceId) await activeServiceKind(tx, practiceId, e.serviceId);
  const startsAt = appointmentStart(e.day, e.time);
  if (!endsSameRomeDay(startsAt, e.durationMin)) throw new DomainError(SAME_DAY, { field: "time" });
  if (e.day !== todayRome(current.startsAt) && (await blockersOf(tx, practiceId, e.id)).hasVisit) {
    throw new DomainError(VISIT_KEEPS_DAY, { field: "day" });
  }

  // Spostato prima dell'apertura del suo ciclo, lo porta indietro.
  await moveCycleOpeningBack(tx, practiceId, current.cycleId, e.day);

  const movedFromConfirmed = current.status === "confermato" && startsAt.getTime() !== current.startsAt.getTime();
  const status: AppointmentStatus = movedFromConfirmed ? "prenotato" : e.status;
  const rows = await tx.query(
    `update public.appointments
        set service_id = $5,
            starts_at = $6,
            duration_min = $7,
            price_cents = $8,
            status = $9,
            status_changed_at = coalesce($10::timestamptz, status_changed_at),
            notes = $11
      where id = $1 and practice_id = $2 and status = $3
        and date_trunc('milliseconds', updated_at) = $4::timestamptz
      returning id`,
    [
      e.id,
      practiceId,
      current.status,
      e.expectedUpdatedAt,
      e.serviceId,
      startsAt,
      e.durationMin,
      e.priceCents,
      status,
      status === current.status ? null : clock.now(),
      e.notes ?? null,
    ],
  );
  if (rows.length === 0) throw new ConflictError();
  return { movedFromConfirmed };
}

/**
 * Il metodo del passo 1 del pannello "Seduta fatta", solo su un fatto: un
 * suggerimento per la fattura, l'incasso vero sta sulla fattura. null è "Non ancora incassato".
 */
export async function savePaymentMethod(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const { id, method } = PaymentMethodInput.parse(input);
  const current = await currentOf(tx, practiceId, id);
  if (current.status !== "fatto") throw new DomainError(NOT_ALLOWED);
  const rows = await tx.query(
    `update public.appointments
        set payment_method = $4
      where id = $1 and practice_id = $2 and status = $3
      returning id`,
    [id, practiceId, current.status, method],
  );
  if (rows.length === 0) throw new ConflictError();
}
