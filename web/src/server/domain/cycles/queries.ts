import type { CycleKind } from "@/lib/agenda/defaults";
import type { CycleAppointment } from "@/lib/agenda/session-label";
import type { RegionCode } from "@/lib/clinical/catalog";
import { dayField } from "@/lib/format";
import { type Clock, daysBetween, todayRome } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { recallDay } from "@/server/domain/patients/recall";
import { getClinicalSettings } from "@/server/domain/settings/queries";

// Letture dei cicli per l'agenda: il ciclo aperto di un paziente, che il dialogo
// "Nuovo appuntamento" preseleziona, e gli appuntamenti di un ciclo, da cui nasce "Seduta N di M".
// Ogni lettura filtra lo studio anche oltre la RLS.

/** Il ciclo aperto di un paziente. Ce n'è al più uno (indice unico parziale). */
export interface OpenCycle {
  id: string;
  kind: CycleKind;
  title: string;
  /** null per un mantenimento senza sedute previste. */
  expectedSessions: number | null;
  /** "AAAA-MM-GG". */
  openedOn: string;
}

export async function getOpenCycle(tx: Tx, practiceId: string, patientId: string): Promise<OpenCycle | null> {
  const [row] = await tx.query<OpenCycle>(
    `select id,
            kind,
            title,
            expected_sessions as "expectedSessions",
            opened_on as "openedOn"
       from public.treatment_cycles
      where practice_id = $1 and patient_id = $2 and status = 'open'`,
    [practiceId, patientId],
  );
  return row ?? null;
}

/** Gli appuntamenti del ciclo di ogni stato, in ordine di orario (a parità, per id). */
export function listCycleAppointments(tx: Tx, practiceId: string, cycleId: string): Promise<CycleAppointment[]> {
  return tx.query<CycleAppointment>(
    `select id, starts_at as "startsAt", status
       from public.appointments
      where practice_id = $1 and cycle_id = $2
      order by starts_at, id`,
    [practiceId, cycleId],
  );
}

// Letture della parte clinica del ciclo.

/** Entro quanti giorni dalla chiusura un ciclo con la stessa regione propone la ricaduta. */
const RELAPSE_DAYS = 90;
const RECALL_WEEKS_MIN = 2;
const RECALL_WEEKS_MAX = 52;
/** La cadenza proposta se il paziente non ne ha una e manca la riga delle impostazioni. */
const FALLBACK_RECALL_WEEKS = 6;

/** Una visita del ciclo con il suo stato. */
export interface CycleVisit {
  id: string;
  status: "draft" | "closed";
}

/**
 * La prima o la più recente visita del ciclo, per `visit_date`, poi per orario dell'appuntamento, poi
 * per `id` (la prima visita del ciclo, la "visita dell'ultima seduta").
 */
export async function cycleVisitAt(
  tx: Tx,
  practiceId: string,
  cycleId: string,
  which: "first" | "last",
): Promise<CycleVisit | null> {
  const direction = which === "first" ? "asc" : "desc";
  const [row] = await tx.query<CycleVisit>(
    `select v.id, v.status
       from public.visits v
       join public.appointments a on a.practice_id = v.practice_id and a.id = v.appointment_id
      where v.practice_id = $1 and v.cycle_id = $2
      order by v.visit_date ${direction}, a.starts_at ${direction}, v.id ${direction}
      limit 1`,
    [practiceId, cycleId],
  );
  return row ?? null;
}

/**
 * La visita che tiene l'apertura del ciclo: la visita chiusa per
 * prima nel tempo (`closed_at`, poi l'ordine di `cycleVisitAt`), altrimenti la prima visita per data. Così non cambia
 * più: con una visita chiusa l'apertura cambia solo con una rettifica di questa visita, anche quando una seduta
 * precedente, compilata e chiusa dopo, diventa la prima in ordine di data. In bozza l'apertura si scrive solo se
 * questa visita è la bozza stessa.
 */
export async function openingVisitOf(
  tx: Tx,
  practiceId: string,
  cycleId: string,
): Promise<(CycleVisit & { visitDate: string }) | null> {
  const [row] = await tx.query<CycleVisit & { visitDate: string }>(
    `select v.id, v.status, v.visit_date as "visitDate"
       from public.visits v
       join public.appointments a on a.practice_id = v.practice_id and a.id = v.appointment_id
      where v.practice_id = $1 and v.cycle_id = $2
      order by v.status = 'closed' desc, v.closed_at asc nulls last, v.visit_date asc, a.starts_at asc, v.id asc
      limit 1`,
    [practiceId, cycleId],
  );
  return row ?? null;
}

/** La visita ha già un punteggio di un'attività del ciclo (per esempio l'iniziale). */
export async function hasCycleScores(tx: Tx, practiceId: string, cycleId: string, visitId: string): Promise<boolean> {
  const rows = await tx.query(
    `select 1
       from public.psfs_scores s
       join public.psfs_items i on i.practice_id = s.practice_id and i.id = s.item_id
      where s.practice_id = $1 and i.cycle_id = $2 and s.visit_id = $3
      limit 1`,
    [practiceId, cycleId, visitId],
  );
  return rows.length > 0;
}

/**
 * Il ciclo chiuso dello stesso paziente con la stessa regione principale, chiuso da meno di 90 giorni
 * (`daysBetween(closed_on, oggi) < 90`), il più recente. Null se non c'è, se il ciclo
 * è già collegato a una ricaduta (la domanda ha già la risposta) o se non è dello studio.
 */
export async function relapseCandidate(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  cycleId: string,
  mainRegion: RegionCode,
): Promise<{ id: string; title: string } | null> {
  const rows = await tx.query<{ id: string; title: string; closedOn: string }>(
    `select p.id, p.title, p.closed_on as "closedOn"
       from public.treatment_cycles c
       join public.treatment_cycles p on p.practice_id = c.practice_id and p.patient_id = c.patient_id
      where c.practice_id = $1 and c.id = $2 and c.previous_cycle_id is null
        and p.id <> c.id and p.status = 'closed' and p.main_region = $3
      order by p.closed_on desc, p.id desc`,
    [practiceId, cycleId, mainRegion],
  );
  const today = clock.today();
  const found = rows.find((row) => daysBetween(row.closedOn, today) < RELAPSE_DAYS);
  return found ? { id: found.id, title: found.title } : null;
}

/** La finestra "Chiudi ciclo". */
export interface CycleClosingView {
  cycleId: string;
  /** Il paziente del ciclo: serve a «Prepara la lettera». */
  patientId: string;
  kind: "trattamento" | "mantenimento";
  title: string;
  /** "AAAA-MM-GG": la chiusura non lo precede. */
  openedOn: string;
  /** "AAAA-MM-GG": la chiusura predefinita e la più lontana ammessa. */
  today: string;
  /** Le attività del ciclo in ordine, con il punteggio iniziale se c'è. */
  psfs: { itemId: string; activity: string; initial: number | null }[];
  /** La visita più recente del ciclo è in bozza. */
  hasDraftVisit: boolean;
  /** Ci sono attività, la visita più recente è in bozza e non ha ancora punteggi di quelle attività. */
  canScoreFinal: boolean;
  /** La cadenza del paziente, altrimenti `clinical_settings.default_recall_weeks`. */
  proposedWeeks: number;
  /** Da 2 a 52 settimane con "Richiamo il 03/12/2026" dall'ultimo fatto del paziente; null senza fatti. */
  recallChoices: { weeks: number; text: string }[] | null;
  /** Il ciclo ha un rinvio al medico: serve per chiudere come "rinviato al medico". */
  hasReferral: boolean;
}

/** I dati della finestra "Chiudi ciclo" per un ciclo aperto; null per un ciclo chiuso o che non c'è. */
export async function getCycleClosing(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  cycleId: string,
): Promise<CycleClosingView | null> {
  const [cycle] = await tx.query<{
    patientId: string;
    kind: "trattamento" | "mantenimento";
    title: string;
    openedOn: string;
    recallWeeks: number | null;
    lastDoneAt: Date | null;
    hasReferral: boolean;
  }>(
    `select c.patient_id as "patientId",
            c.kind,
            c.title,
            c.opened_on as "openedOn",
            p.recall_interval_weeks as "recallWeeks",
            (select max(a.starts_at)
               from public.appointments a
              where a.practice_id = c.practice_id and a.patient_id = c.patient_id and a.status = 'fatto') as "lastDoneAt",
            exists (select 1 from public.referrals r where r.practice_id = c.practice_id and r.cycle_id = c.id)
              as "hasReferral"
       from public.treatment_cycles c
       join public.patients p on p.practice_id = c.practice_id and p.id = c.patient_id
      where c.practice_id = $1 and c.id = $2 and c.status = 'open'`,
    [practiceId, cycleId],
  );
  if (!cycle) return null;

  const psfs = await tx.query<{ itemId: string; activity: string; initial: number | null }>(
    `select i.id as "itemId",
            i.activity,
            (select s.score
               from public.psfs_scores s
               join public.visits v on v.practice_id = s.practice_id and v.id = s.visit_id
              where s.practice_id = i.practice_id and s.item_id = i.id and s.phase = 'iniziale'
              order by v.visit_date, v.id
              limit 1) as initial
       from public.psfs_items i
      where i.practice_id = $1 and i.cycle_id = $2
      order by i.position`,
    [practiceId, cycleId],
  );

  const last = await cycleVisitAt(tx, practiceId, cycleId, "last");
  const hasDraftVisit = last?.status === "draft";
  const canScoreFinal =
    last !== null && hasDraftVisit && psfs.length > 0 && !(await hasCycleScores(tx, practiceId, cycleId, last.id));

  const proposedWeeks =
    cycle.recallWeeks ?? (await getClinicalSettings(tx, practiceId))?.defaultRecallWeeks ?? FALLBACK_RECALL_WEEKS;

  const lastDone = cycle.lastDoneAt === null ? null : todayRome(cycle.lastDoneAt);
  const recallChoices =
    lastDone === null
      ? null
      : Array.from({ length: RECALL_WEEKS_MAX - RECALL_WEEKS_MIN + 1 }, (_, i) => {
          const weeks = RECALL_WEEKS_MIN + i;
          return { weeks, text: `Richiamo il ${dayField(recallDay(lastDone, weeks))}` };
        });

  return {
    cycleId,
    patientId: cycle.patientId,
    kind: cycle.kind,
    title: cycle.title,
    openedOn: cycle.openedOn,
    today: clock.today(),
    psfs,
    hasDraftVisit,
    canScoreFinal,
    proposedWeeks,
    recallChoices,
    hasReferral: cycle.hasReferral,
  };
}
