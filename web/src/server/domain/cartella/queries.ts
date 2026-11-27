import { sessionLabel } from "@/lib/agenda/session-label";
import { REGION_CODES, REGION_LABEL, type RegionCode } from "@/lib/clinical/catalog";
import { type Measure, type TestRow, testsOverTime } from "@/lib/clinical/compare";
import { CYCLE_OUTCOME_LABEL, REFERRAL_STATUS_LABEL, RECIPIENT_KIND_LABEL, VISIT_KIND_LABEL } from "@/lib/clinical/labels";
import { age, dayField, dayShort, romeDay } from "@/lib/format";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { latestAttachments, type PhotoRow } from "@/server/domain/attachments/queries";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { clinicalAlertText, patientBadges } from "@/server/domain/patients/card";
import { ageDay, type CycleFacts, consentCell, loadPatientFacts, recallCell } from "@/server/domain/patients/list";

// Le letture della tab Cartella: testata, ciclo aperto,
// cronologia dei cicli con le sedute, riquadri di rinvii, allegati e richiamo, e la tabella dei test nel
// tempo. Testata e celle sono quelle della scheda e della lista (`patients/card.ts`, `patients/list.ts`).
// "Visita da compilare" segue una sola regola: un appuntamento fatto senza visita chiusa. Ogni
// lettura filtra lo studio anche oltre la RLS.

export interface CartellaTab {
  header: {
    ageText: string;
    /** "TAO", "NAO", «Storia di tumore», «Osteoporosi», «Gravidanza in corso». */
    badges: string[];
    clinicalAlert: string | null;
    /** La cella Consensi della lista: "In regola", "Manca 1", «Manca 2», "Revocato", "Rifiutato". */
    consentText: string;
    /** Il medico curante dalla rubrica. */
    gp: string | null;
  };
  openCycle: {
    id: string;
    kind: "trattamento" | "mantenimento";
    title: string;
    goal: string | null;
    /** "Seduta 2 di 4" con le sedute fatte; null senza sedute fatte. */
    sessionText: string | null;
    /** Il dolore 0-10 a inizio seduta delle visite del ciclo che lo hanno, in ordine; `day` "AAAA-MM-GG". */
    pain: { day: string; value: number }[];
    psfs: { activity: string; initial: number | null }[];
  } | null;
  /** I cicli dal più recente, il ciclo aperto compreso. */
  history: CycleHistory[];
  /** Tutti i rinvii del paziente, dal più recente. */
  referrals: { id: string; text: string; statusLabel: string }[];
  /** Le ultime 3 foto non tolte. */
  attachments: PhotoRow[];
  /** La cella Richiamo della lista, «Nessun richiamo previsto.» senza cadenza. */
  recallText: string;
  /** "Nuovo rinvio": il paziente ha almeno un ciclo. */
  canStartReferral: boolean;
}

export interface CycleHistory {
  id: string;
  title: string;
  /** «Aperto», «Chiuso il 12/08/2026, Obiettivo raggiunto». */
  statusText: string;
  /** Visite e sedute fatte senza visita, in ordine di data e orario. */
  sessions: SessionLine[];
}

export type SessionLine =
  | {
      kind: "visita";
      visitId: string;
      /** "AAAA-MM-GG": per `<time datetime>`. */
      day: string;
      /** "gio 22 ott". */
      dateText: string;
      kindLabel: string;
      /** "7 → 4"; null senza dolore a inizio e a fine seduta. */
      painText: string | null;
      /** Le regioni trattate, "Cervicale, Dorsale"; "" senza tecniche. */
      regionsText: string;
      statusLabel: "Bozza" | "Chiusa";
      /** "Rettificata il 04/11/2026", dall'ultima rettifica. */
      amendedText: string | null;
      /** "Visita da compilare": l'appuntamento è fatto e la visita non è chiusa. */
      toFill: boolean;
    }
  | { kind: "senza_visita"; appointmentId: string; day: string; dateText: string; toFill: true };

const NO_RECALL = "Nessun richiamo previsto.";
const OPEN_TEXT = "Aperto";
const NOT_MEASURED = "non rilevato";

/** Il dolore di inizio e fine seduta: "7 → 4", "5 → non rilevato"; null se mancano tutti e due. */
function painText(pre: number | null, post: number | null): string | null {
  if (pre === null && post === null) return null;
  return `${pre ?? NOT_MEASURED} → ${post ?? NOT_MEASURED}`;
}

function cycleStatusText(c: { status: "open" | "closed"; closedOn: string | null; outcome: string | null }): string {
  if (c.status === "open") return OPEN_TEXT;
  const parts = [c.closedOn === null ? "Chiuso" : `Chiuso il ${dayField(c.closedOn)}`];
  const outcome = c.outcome === null ? undefined : CYCLE_OUTCOME_LABEL[c.outcome as keyof typeof CYCLE_OUTCOME_LABEL];
  if (outcome) parts.push(outcome);
  return parts.join(", ");
}

function regionsText(regions: readonly string[]): string {
  const set = new Set(regions);
  return REGION_CODES.filter((r) => set.has(r))
    .map((r) => REGION_LABEL[r])
    .join(", ");
}

/** "Rettificata il 04/11/2026": il giorno di Roma dell'ultima rettifica. */
export function amendedText(lastAmendedAt: Date | null): string | null {
  return lastAmendedAt === null ? null : `Rettificata il ${dayField(romeDay(lastAmendedAt))}`;
}

interface SessionRow {
  appointmentId: string;
  cycleId: string;
  startsAt: Date;
  appointmentStatus: string;
  visitId: string | null;
  visitDate: string | null;
  visitKind: keyof typeof VISIT_KIND_LABEL | null;
  visitStatus: "draft" | "closed" | null;
  nprsPre: number | null;
  nprsPost: number | null;
  amendedAt: Date | null;
  regions: string[];
}

/** Le visite e gli appuntamenti fatti senza visita del paziente, in ordine di orario. */
async function loadSessions(tx: Tx, practiceId: string, patientId: string): Promise<SessionRow[]> {
  return tx.query<SessionRow>(
    `select a.id as "appointmentId",
            a.cycle_id as "cycleId",
            a.starts_at as "startsAt",
            a.status as "appointmentStatus",
            v.id as "visitId",
            v.visit_date as "visitDate",
            v.kind as "visitKind",
            v.status as "visitStatus",
            v.nprs_pre as "nprsPre",
            v.nprs_post as "nprsPost",
            (select max(m.amended_at) from public.visit_amendments m
              where m.practice_id = v.practice_id and m.visit_id = v.id) as "amendedAt",
            coalesce((select array_agg(distinct t.region) from public.visit_treatments t
                       where t.practice_id = v.practice_id and t.visit_id = v.id), '{}') as regions
       from public.appointments a
       left join public.visits v on v.practice_id = a.practice_id and v.appointment_id = a.id
      where a.practice_id = $1 and a.patient_id = $2 and (v.id is not null or a.status = 'fatto')
      order by a.starts_at, a.id`,
    [practiceId, patientId],
  );
}

function sessionLine(r: SessionRow): SessionLine {
  if (r.visitId === null || r.visitDate === null || r.visitKind === null || r.visitStatus === null) {
    const day = romeDay(r.startsAt);
    return { kind: "senza_visita", appointmentId: r.appointmentId, day, dateText: dayShort(day), toFill: true };
  }
  return {
    kind: "visita",
    visitId: r.visitId,
    day: r.visitDate,
    dateText: dayShort(r.visitDate),
    kindLabel: VISIT_KIND_LABEL[r.visitKind],
    painText: painText(r.nprsPre, r.nprsPost),
    regionsText: regionsText(r.regions),
    statusLabel: r.visitStatus === "closed" ? "Chiusa" : "Bozza",
    amendedText: amendedText(r.amendedAt),
    toFill: r.appointmentStatus === "fatto" && r.visitStatus !== "closed",
  };
}

/** Le attività PSFS del ciclo in ordine, con il punteggio iniziale se c'è. */
export async function cyclePsfs(
  tx: Tx,
  practiceId: string,
  cycleId: string,
): Promise<{ id: string; activity: string; initial: number | null }[]> {
  return tx.query(
    `select i.id,
            i.activity,
            (select s.score
               from public.psfs_scores s
               join public.visits v on v.practice_id = s.practice_id and v.id = s.visit_id
              where s.practice_id = i.practice_id and s.item_id = i.id and s.phase = 'iniziale'
              order by v.visit_date, v.id
              limit 1) as initial
       from public.psfs_items i
      where i.practice_id = $1 and i.cycle_id = $2
      order by i.position, i.id`,
    [practiceId, cycleId],
  );
}

async function openCycleView(tx: Tx, practiceId: string, open: CycleFacts): Promise<NonNullable<CartellaTab["openCycle"]>> {
  const pain = await tx.query<{ day: string; value: number }>(
    `select v.visit_date as day, v.nprs_pre as value
       from public.visits v
       join public.appointments a on a.practice_id = v.practice_id and a.id = v.appointment_id
      where v.practice_id = $1 and v.cycle_id = $2 and v.nprs_pre is not null
      order by v.visit_date, a.starts_at, v.id`,
    [practiceId, open.id],
  );
  const psfs = await cyclePsfs(tx, practiceId, open.id);
  return {
    id: open.id,
    kind: open.kind,
    title: open.title,
    goal: open.goal,
    // "Seduta N di M" con le sedute fatte, come la cella Ciclo della lista.
    sessionText: sessionLabel(open.doneCount > 0 ? open.doneCount : null, open.expectedSessions),
    pain,
    psfs: psfs.map((p) => ({ activity: p.activity, initial: p.initial })),
  };
}

/** I rinvii del paziente, dal più recente: "Lettera del 27/10/2026: Dott. Neri, ortopedico" e lo stato. */
async function referralLines(tx: Tx, practiceId: string, patientId: string): Promise<CartellaTab["referrals"]> {
  const rows = await tx.query<{
    id: string;
    createdOn: string;
    status: keyof typeof REFERRAL_STATUS_LABEL;
    recipientKind: keyof typeof RECIPIENT_KIND_LABEL;
    physician: string | null;
    recipientFree: string | null;
  }>(
    `select r.id,
            r.created_on as "createdOn",
            r.status,
            r.recipient_kind as "recipientKind",
            ph.full_name as physician,
            r.recipient_free as "recipientFree"
       from public.referrals r
       left join public.physicians ph on ph.practice_id = r.practice_id and ph.id = r.physician_id
      where r.practice_id = $1 and r.patient_id = $2
      order by r.created_on desc, r.created_at desc, r.id desc`,
    [practiceId, patientId],
  );
  return rows.map((r) => ({
    id: r.id,
    text: `Lettera del ${dayField(r.createdOn)}: ${r.physician ?? r.recipientFree ?? RECIPIENT_KIND_LABEL[r.recipientKind]}`,
    statusLabel: REFERRAL_STATUS_LABEL[r.status],
  }));
}

/** La tab Cartella del paziente; un paziente che non c'è o di un altro studio è "Operazione non permessa". */
export async function getCartellaTab(tx: Tx, practiceId: string, clock: Clock, patientId: string): Promise<CartellaTab> {
  const [p] = await tx.query<{
    id: string;
    birthDate: string;
    clinicalAlert: string | null;
    gp: string | null;
    recallWeeks: number | null;
    recallPaused: boolean;
  }>(
    `select p.id,
            p.birth_date as "birthDate",
            p.clinical_alert as "clinicalAlert",
            gp.full_name as gp,
            p.recall_interval_weeks as "recallWeeks",
            p.recall_paused as "recallPaused"
       from public.patients p
       left join public.physicians gp on gp.practice_id = p.practice_id and gp.id = p.gp_physician_id
      where p.practice_id = $1 and p.id = $2`,
    [practiceId, patientId],
  );
  if (!p) throw new DomainError(NOT_ALLOWED);
  const facts = (await loadPatientFacts(tx, practiceId, clock, [p])).get(p.id);
  if (!facts) throw new DomainError(NOT_ALLOWED);
  const today = clock.today();

  const outcomes = await tx.query<{ id: string; outcome: string | null }>(
    "select id, outcome from public.treatment_cycles where practice_id = $1 and patient_id = $2",
    [practiceId, p.id],
  );
  const outcomeOf = new Map(outcomes.map((c) => [c.id, c.outcome]));
  const sessions = await loadSessions(tx, practiceId, p.id);
  // I cicli di `loadPatientFacts` sono già dal più recente (apertura, poi id).
  const history = facts.cycles.map(
    (c): CycleHistory => ({
      id: c.id,
      title: c.title,
      statusText: cycleStatusText({ status: c.status, closedOn: c.closedOn, outcome: outcomeOf.get(c.id) ?? null }),
      sessions: sessions.filter((s) => s.cycleId === c.id).map(sessionLine),
    }),
  );

  return {
    header: {
      ageText: age(p.birthDate, ageDay(p.birthDate, today)),
      badges: await patientBadges(tx, practiceId, p.id),
      clinicalAlert: clinicalAlertText(p.clinicalAlert),
      consentText: consentCell(facts.consents),
      gp: p.gp,
    },
    openCycle: facts.openCycle ? await openCycleView(tx, practiceId, facts.openCycle) : null,
    history,
    referrals: await referralLines(tx, practiceId, p.id),
    attachments: await latestAttachments(tx, practiceId, p.id, 3),
    recallText: p.recallWeeks === null ? NO_RECALL : recallCell(p, facts, today),
    canStartReferral: facts.cycles.length > 0,
  };
}

// ---------------------------------------------------------------------------------------------------
// Test nel tempo.

export interface TestsOverTime {
  /** I cicli del paziente per il filtro «Ciclo», dal più recente. */
  cycles: { id: string; title: string }[];
  /** Il ciclo mostrato: quello scelto se è del paziente, altrimenti l'aperto, altrimenti l'ultimo chiuso. */
  cycleId: string | null;
  region: RegionCode | null;
  /** Le visite del ciclo in ordine; `dateText` "gio 22 ott". */
  columns: { visitId: string; dateText: string }[];
  rows: TestRow[];
}

/**
 * La tabella dei test del ciclo: una colonna per visita (bozze comprese), una riga per test e lato
 * (`testsOverTime`), la variazione dalla prima misura; con `region` solo i test del catalogo di quella
 * regione. I valori numerici si leggono con `::float8`.
 */
export async function getTestsOverTime(
  tx: Tx,
  practiceId: string,
  patientId: string,
  filters: { cycleId: string | null; region: RegionCode | null },
): Promise<TestsOverTime> {
  const cycles = await tx.query<{ id: string; title: string; status: "open" | "closed"; closedOn: string | null }>(
    `select id, title, status, closed_on as "closedOn"
       from public.treatment_cycles
      where practice_id = $1 and patient_id = $2
      order by opened_on desc, id`,
    [practiceId, patientId],
  );
  const chosen =
    cycles.find((c) => c.id === filters.cycleId) ??
    cycles.find((c) => c.status === "open") ??
    [...cycles].filter((c) => c.closedOn !== null).sort((a, b) => (b.closedOn ?? "").localeCompare(a.closedOn ?? ""))[0] ??
    null;
  const view: TestsOverTime = {
    cycles: cycles.map((c) => ({ id: c.id, title: c.title })),
    cycleId: chosen?.id ?? null,
    region: filters.region,
    columns: [],
    rows: [],
  };
  if (!chosen) return view;

  const visits = await cycleVisitsInOrder(tx, practiceId, chosen.id);
  const rows = testsOverTime(visits, await cycleMeasures(tx, practiceId, chosen.id));
  return {
    ...view,
    columns: visits.map((v) => ({ visitId: v.id, dateText: dayShort(v.visitDate) })),
    rows: filters.region === null ? rows : rows.filter((r) => r.region === filters.region),
  };
}

/**
 * Le visite del ciclo, bozze comprese, per giorno della visita, poi orario dell'appuntamento, poi id:
 * l'ordine delle colonne di "Test nel tempo" e della misura di riferimento (`changeFromFirst`).
 */
export function cycleVisitsInOrder(tx: Tx, practiceId: string, cycleId: string): Promise<{ id: string; visitDate: string }[]> {
  return tx.query<{ id: string; visitDate: string }>(
    `select v.id, v.visit_date as "visitDate"
       from public.visits v
       join public.appointments a on a.practice_id = v.practice_id and a.id = v.appointment_id
      where v.practice_id = $1 and v.cycle_id = $2
      order by v.visit_date, a.starts_at, v.id`,
    [practiceId, cycleId],
  );
}

/** Le misure dei test di tutte le visite del ciclo, con i numeri letti con `::float8`. */
export function cycleMeasures(tx: Tx, practiceId: string, cycleId: string): Promise<Measure[]> {
  return tx.query<Measure>(
    `select r.visit_id as "visitId",
            v.visit_date as "visitDate",
            r.test_code as "testCode",
            r.custom_label as "customLabel",
            r.custom_unit as "customUnit",
            r.side,
            r.value_bool as "valueBool",
            r.value_lateral as "valueLateral",
            r.value_numeric::float8 as "valueNumeric",
            r.value_ordinal as "valueOrdinal"
       from public.visit_test_results r
       join public.visits v on v.practice_id = r.practice_id and v.id = r.visit_id
      where r.practice_id = $1 and v.cycle_id = $2
      order by r.id`,
    [practiceId, cycleId],
  );
}
