import type { z } from "zod";
import { REGION_LABEL, type RegionCode } from "@/lib/clinical/catalog";
import { REFERRAL_FIRST } from "@/lib/clinical/labels";
import { monthYear } from "@/lib/format";
import { type Clock, romeDayBounds } from "@/server/clock";
import type { SqlParam, Tx } from "@/server/db/db";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { archiveBlockText, setRecall } from "@/server/domain/patients/commands";
import { getClinicalSettings } from "@/server/domain/settings/queries";
import { cycleVisitAt, getOpenCycle, hasCycleScores, openingVisitOf, relapseCandidate } from "./queries";
import {
  CloseCycleInput,
  CycleOpeningInput,
  INVALID,
  OpenCycleInput,
  PsfsAddInput,
  PsfsItemIdInput,
  PsfsRenameInput,
  RelapseInput,
} from "./schemas";

// Comandi dei cicli per l'agenda. Il ciclo si apre quando
// l'osteopata fissa un appuntamento a un paziente che non ne ha uno: la chiusura, la modifica del
// motivo e dell'obiettivo sono comandi a parte. Il comando non scrive `status`, `closed_on` né `outcome`
// (un ciclo nasce aperto) e non tocca `created_by` né `created_at`.

const ALREADY_OPEN = "Il paziente ha già un ciclo aperto.";

async function patientExists(tx: Tx, practiceId: string, patientId: string): Promise<boolean> {
  const rows = await tx.query("select 1 from public.patients where practice_id = $1 and id = $2", [
    practiceId,
    patientId,
  ]);
  return rows.length > 0;
}

/**
 * Porta `opened_on` di un ciclo aperto indietro a `day` ("AAAA-MM-GG"), solo se `day` viene prima
 * della sua apertura attuale: così la visita di un appuntamento fissato prima
 * dell'apertura non cade prima del ciclo, cosa che il database rifiuta. Indietro è sempre ammesso; in
 * avanti non si sposta mai, e un ciclo chiuso non si tocca. Va chiamato dopo i controlli del comando
 * e prima della scrittura dell'appuntamento.
 */
export async function moveCycleOpeningBack(tx: Tx, practiceId: string, cycleId: string, day: string): Promise<void> {
  await tx.query(
    `update public.treatment_cycles
        set opened_on = $3
      where practice_id = $1 and id = $2 and status = 'open' and opened_on > $3`,
    [practiceId, cycleId, day],
  );
}

/**
 * Apre un ciclo per un paziente senza ciclo aperto. `opened_on` è il minore fra oggi e il giorno del
 * primo appuntamento: così una visita nel passato (che l'app permette) non cade prima
 * dell'apertura, e una nel futuro non fa partire il ciclo dopo oggi. Le sedute previste vengono
 * dall'input, altrimenti da `clinical_settings.default_expected_sessions` per il trattamento e null
 * per il mantenimento. Il titolo è "Nuovo ciclo, {mese anno di opened_on}" salvo quello dato dal seed.
 */
export async function openCycle(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<{ id: string }> {
  const cycle = OpenCycleInput.parse(input);
  // Un paziente che non c'è, o è di un altro studio, si ferma qui: non è un caso da frase precisa.
  if (!(await patientExists(tx, practiceId, cycle.patientId))) throw new DomainError(NOT_ALLOWED);
  if ((await getOpenCycle(tx, practiceId, cycle.patientId)) !== null) throw new DomainError(ALREADY_OPEN);

  // I giorni "AAAA-MM-GG" in ordine di testo sono in ordine di calendario.
  const today = clock.today();
  const openedOn = cycle.firstAppointmentDay < today ? cycle.firstAppointmentDay : today;

  let expectedSessions: number | null = cycle.expectedSessions ?? null;
  if (expectedSessions === null && cycle.kind === "trattamento") {
    const settings = await getClinicalSettings(tx, practiceId);
    if (!settings) throw new DomainError(NOT_ALLOWED);
    expectedSessions = settings.defaultExpectedSessions;
  }

  const [row] = await tx.query<{ id: string }>(
    `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      practiceId,
      cycle.patientId,
      cycle.kind,
      openedOn,
      cycle.title ?? `Nuovo ciclo, ${monthYear(openedOn)}`,
      expectedSessions,
    ],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return { id: row.id };
}

// La parte clinica del ciclo:
// i campi d'apertura e il titolo, le attività PSFS, la ricaduta e la chiusura con i
// punteggi finali e il richiamo. Ogni comando legge il ciclo con lo studio, quindi un id di un altro
// studio è "Operazione non permessa" come un ciclo che non c'è.

const MAX_PSFS_ITEMS = 3;
const PSFS_POSITIONS = [1, 2, 3] as const;
const TOO_MANY_PSFS = "Al massimo 3 attività.";
const SCORED_IN_CLOSED_VISIT = "L'attività ha già un punteggio in una visita chiusa: aggiungine una nuova.";
const FINAL_NEEDS_OPEN_VISIT =
  'Il punteggio finale si scrive mentre la visita dell\'ultima seduta è aperta. Scegli "Paziente non tornato".';
const EVERY_FINAL_SCORE = "Scrivi il punteggio finale di ogni attività.";
const CLOSE_IN_FUTURE = "La chiusura non può essere nel futuro.";
const CLOSE_BEFORE_OPENING = "La chiusura non può precedere l'apertura del ciclo.";
/** Il titolo provvisorio dell'agenda: la regione principale lo sostituisce. */
const PROVISIONAL_TITLE_PREFIX = "Nuovo ciclo, ";

interface CycleState {
  patientId: string;
  status: "open" | "closed";
  /** "AAAA-MM-GG". */
  openedOn: string;
  title: string;
  mainRegion: RegionCode | null;
}

async function readCycle(tx: Tx, practiceId: string, cycleId: string): Promise<CycleState | null> {
  const [row] = await tx.query<CycleState>(
    `select patient_id as "patientId", status, opened_on as "openedOn", title, main_region as "mainRegion"
       from public.treatment_cycles
      where practice_id = $1 and id = $2`,
    [practiceId, cycleId],
  );
  return row ?? null;
}

/** Il ciclo aperto dello studio; chiuso o assente è "Operazione non permessa". */
async function requireOpenCycle(tx: Tx, practiceId: string, cycleId: string): Promise<CycleState> {
  const cycle = await readCycle(tx, practiceId, cycleId);
  if (cycle?.status !== "open") throw new DomainError(NOT_ALLOWED);
  return cycle;
}

/**
 * I campi d'apertura e le attività PSFS si scrivono finché il ciclo è aperto e non ha visite chiuse:
 * con una visita chiusa passano dall'operazione `apertura` di
 * `amendVisit` sulla visita che tiene l'apertura (`openingVisitOf`), anche se una seduta precedente,
 * compilata dopo, è diventata la prima del ciclo.
 */
async function requireOpeningEditable(tx: Tx, practiceId: string, cycleId: string): Promise<CycleState> {
  const cycle = await requireOpenCycle(tx, practiceId, cycleId);
  if ((await openingVisitOf(tx, practiceId, cycleId))?.status === "closed") throw new DomainError(NOT_ALLOWED);
  return cycle;
}

/** I campi d'apertura senza il ciclo: ciò che scrive `writeCycleOpening`. */
export type CycleOpeningValues = Omit<z.output<typeof CycleOpeningInput>, "cycleId">;

export const OPENING_COLUMNS: Record<keyof CycleOpeningValues, string> = {
  chiefComplaint: "chief_complaint",
  mainRegion: "main_region",
  onsetOn: "onset_on",
  onsetMode: "onset_mode",
  medicalDiagnosisText: "medical_diagnosis_text",
  medicalDiagnosisSource: "medical_diagnosis_source",
  referringPhysicianId: "referring_physician_id",
  selfReferred: "self_referred",
  goal: "goal",
  expectedSessions: "expected_sessions",
  planNote: "plan_note",
  planAgreedOn: "plan_agreed_on",
};

/** Il titolo che nasce dalla regione principale: «Lombare, novembre 2026». */
function regionTitle(region: RegionCode, openedOn: string): string {
  return `${REGION_LABEL[region]}, ${monthYear(openedOn)}`;
}

/**
 * Il titolo non l'ha scelto nessuno: è quello provvisorio dell'agenda ("Nuovo ciclo, ...") o quello
 * nato dalla regione principale di adesso. Un titolo scelto dall'osteopata o dal seed resta.
 */
function hasGeneratedTitle(cycle: CycleState): boolean {
  if (cycle.title.startsWith(PROVISIONAL_TITLE_PREFIX)) return true;
  return cycle.mainRegion !== null && cycle.title === regionTitle(cycle.mainRegion, cycle.openedOn);
}

/**
 * Scrive i campi d'apertura dati (una chiave assente non cambia la colonna) e, quando arriva una
 * regione principale su un ciclo col titolo provvisorio "Nuovo ciclo, ..." o con quello nato dalla
 * regione di prima, il titolo «{Regione}, {mese anno di apertura}». Non controlla lo stato del ciclo né della prima visita: lo
 * fa `updateCycleOpening`, mentre l'operazione `apertura` di `amendVisit` la chiama dentro una rettifica.
 */
export async function writeCycleOpening(
  tx: Tx,
  practiceId: string,
  cycleId: string,
  values: CycleOpeningValues,
): Promise<void> {
  const cycle = await readCycle(tx, practiceId, cycleId);
  if (!cycle) throw new DomainError(NOT_ALLOWED);

  const params: SqlParam[] = [practiceId, cycleId];
  const sets: string[] = [];
  const set = (column: string, value: SqlParam) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  for (const key of Object.keys(OPENING_COLUMNS) as (keyof CycleOpeningValues)[]) {
    const value = values[key];
    if (value !== undefined) set(OPENING_COLUMNS[key], value);
  }
  const title = nextTitle(cycle, values);
  if (title !== null) set("title", title);
  if (sets.length === 0) return;

  await tx.query(`update public.treatment_cycles set ${sets.join(", ")} where practice_id = $1 and id = $2`, params);
}

/** Il titolo che `writeCycleOpening` scriverebbe con questi valori; null se il titolo non cambia. */
function nextTitle(cycle: CycleState, values: CycleOpeningValues): string | null {
  return values.mainRegion && hasGeneratedTitle(cycle) ? regionTitle(values.mainRegion, cycle.openedOn) : null;
}

/**
 * Il titolo prima e dopo i campi d'apertura dati, quando la regione principale lo rigenera; null se resta
 * com'è. Serve al "prima e dopo" della rettifica.
 */
export async function openingTitleChange(
  tx: Tx,
  practiceId: string,
  cycleId: string,
  values: CycleOpeningValues,
): Promise<{ before: string; after: string } | null> {
  const cycle = await readCycle(tx, practiceId, cycleId);
  if (!cycle) throw new DomainError(NOT_ALLOWED);
  const after = nextTitle(cycle, values);
  return after === null ? null : { before: cycle.title, after };
}

/** Il ciclo è aperto: i campi d'apertura in bozza si scrivono solo finché lo è. */
export async function cycleIsOpen(tx: Tx, practiceId: string, cycleId: string): Promise<boolean> {
  return (await readCycle(tx, practiceId, cycleId))?.status === "open";
}

/** I campi d'apertura dalla sezione A della prima visita, finché il ciclo non ha visite chiuse. */
export async function updateCycleOpening(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const { cycleId, ...values } = CycleOpeningInput.parse(input);
  await requireOpeningEditable(tx, practiceId, cycleId);
  await writeCycleOpening(tx, practiceId, cycleId, values);
}

/** Aggiunge un'attività PSFS al ciclo aperto senza visite chiuse, nella prima posizione libera fra 1 e 3. */
export async function addPsfsItem(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<{ id: string }> {
  const item = PsfsAddInput.parse(input);
  if (item.id !== undefined) {
    const [existing] = await tx.query<{ cycleId: string }>(
      'select cycle_id as "cycleId" from public.psfs_items where practice_id = $1 and id = $2',
      [practiceId, item.id],
    );
    if (existing) {
      if (existing.cycleId !== item.cycleId) throw new DomainError(NOT_ALLOWED);
      return { id: item.id };
    }
  }
  await requireOpeningEditable(tx, practiceId, item.cycleId);
  const taken = await tx.query<{ position: number }>(
    "select position from public.psfs_items where practice_id = $1 and cycle_id = $2",
    [practiceId, item.cycleId],
  );
  const position = PSFS_POSITIONS.find((p) => !taken.some((t) => t.position === p));
  if (taken.length >= MAX_PSFS_ITEMS || position === undefined) throw new DomainError(TOO_MANY_PSFS);

  const [row] = await tx.query<{ id: string }>(
    `insert into public.psfs_items (practice_id, cycle_id, position, activity, id)
     values ($1, $2, $3, $4, coalesce($5::uuid, gen_random_uuid()))
     returning id`,
    [practiceId, item.cycleId, position, item.activity, item.id ?? null],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return { id: row.id };
}

interface DraftScore {
  visitId: string;
  score: number;
  phase: "iniziale" | "intermedia" | "finale";
}

/**
 * L'attività di un ciclo aperto dello studio con i suoi punteggi, tutti in visite in bozza:
 * un punteggio in una visita chiusa ferma la modifica con la sua frase, perché solo una rettifica
 * scrive i figli di una visita chiusa. Poi, come i campi d'apertura, un ciclo con una visita chiusa
 * non cambia le sue attività.
 */
async function editableItem(tx: Tx, practiceId: string, itemId: string): Promise<{ activity: string; drafts: DraftScore[] }> {
  const [item] = await tx.query<{ activity: string; status: "open" | "closed"; cycleId: string }>(
    `select i.activity, c.status, i.cycle_id as "cycleId"
       from public.psfs_items i
       join public.treatment_cycles c on c.practice_id = i.practice_id and c.id = i.cycle_id
      where i.practice_id = $1 and i.id = $2`,
    [practiceId, itemId],
  );
  if (item?.status !== "open") throw new DomainError(NOT_ALLOWED);

  const scores = await tx.query<DraftScore & { visitStatus: "draft" | "closed" }>(
    `select s.visit_id as "visitId", s.score, s.phase, v.status as "visitStatus"
       from public.psfs_scores s
       join public.visits v on v.practice_id = s.practice_id and v.id = s.visit_id
      where s.practice_id = $1 and s.item_id = $2
      order by s.visit_id`,
    [practiceId, itemId],
  );
  if (scores.some((s) => s.visitStatus === "closed")) throw new DomainError(SCORED_IN_CLOSED_VISIT);
  await requireOpeningEditable(tx, practiceId, item.cycleId);
  return {
    activity: item.activity,
    drafts: scores.map(({ visitId, score, phase }) => ({ visitId, score, phase })),
  };
}

async function deleteItemScores(tx: Tx, practiceId: string, itemId: string): Promise<void> {
  await tx.query("delete from public.psfs_scores where practice_id = $1 and item_id = $2", [practiceId, itemId]);
}

/**
 * Rinomina un'attività: il database non rinomina un'attività con punteggi, quindi con
 * punteggi solo in bozza li cancella, rinomina e li riscrive uguali, nella stessa transazione.
 */
export async function renamePsfsItem(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const rename = PsfsRenameInput.parse(input);
  const { activity, drafts } = await editableItem(tx, practiceId, rename.itemId);
  if (activity === rename.activity) return;

  await deleteItemScores(tx, practiceId, rename.itemId);
  await tx.query("update public.psfs_items set activity = $3 where practice_id = $1 and id = $2", [
    practiceId,
    rename.itemId,
    rename.activity,
  ]);
  for (const draft of drafts) {
    await tx.query(
      `insert into public.psfs_scores (practice_id, item_id, visit_id, score, phase)
       values ($1, $2, $3, $4, $5)`,
      [practiceId, rename.itemId, draft.visitId, draft.score, draft.phase],
    );
  }
}

/** Toglie un'attività con i suoi punteggi in bozza; le altre tengono la loro posizione. */
export async function removePsfsItem(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const { itemId } = PsfsItemIdInput.parse(input);
  await editableItem(tx, practiceId, itemId);
  await deleteItemScores(tx, practiceId, itemId);
  await tx.query("delete from public.psfs_items where practice_id = $1 and id = $2", [practiceId, itemId]);
}

/**
 * «Sì, è una ricaduta»: collega il ciclo che `relapseCandidate` propone e ne copia
 * l'obiettivo e le attività PSFS se il ciclo aperto non li ha ancora. Come i campi d'apertura, vale
 * finché il ciclo non ha visite chiuse.
 */
export async function linkRelapse(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const relapse = RelapseInput.parse(input);
  const cycle = await requireOpeningEditable(tx, practiceId, relapse.cycleId);
  // Solo il ciclo che la domanda propone: stessa regione, chiuso da meno di 90 giorni, nessun
  // collegamento già scritto.
  const candidate =
    cycle.mainRegion === null ? null : await relapseCandidate(tx, practiceId, clock, relapse.cycleId, cycle.mainRegion);
  if (candidate?.id !== relapse.previousCycleId) throw new DomainError(NOT_ALLOWED);

  await tx.query(
    `update public.treatment_cycles c
        set previous_cycle_id = p.id,
            goal = coalesce(c.goal, p.goal)
       from public.treatment_cycles p
      where c.practice_id = $1 and c.id = $2 and p.practice_id = $1 and p.id = $3`,
    [practiceId, relapse.cycleId, relapse.previousCycleId],
  );
  await tx.query(
    `insert into public.psfs_items (practice_id, cycle_id, position, activity)
     select practice_id, $2, position, activity
       from public.psfs_items
      where practice_id = $1 and cycle_id = $3
        and not exists (select 1 from public.psfs_items mine where mine.practice_id = $1 and mine.cycle_id = $2)
      order by position`,
    [practiceId, relapse.cycleId, relapse.previousCycleId],
  );
}

/**
 * I punteggi finali: uno per ogni attività del ciclo, scritti sulla visita più
 * recente del ciclo se è in bozza e non ha ancora punteggi di quelle attività (la visita dell'iniziale
 * ne ha già uno per attività). Senza attività non c'è niente da scrivere. Restituisce la visita, o null.
 */
async function finalScoresVisit(
  tx: Tx,
  practiceId: string,
  cycleId: string,
  finalScores: readonly { itemId: string; score: number }[],
): Promise<string | null> {
  const items = await tx.query<{ id: string }>("select id from public.psfs_items where practice_id = $1 and cycle_id = $2", [
    practiceId,
    cycleId,
  ]);
  const ids = new Set(items.map((i) => i.id));
  const given = new Set(finalScores.map((s) => s.itemId));
  if (given.size !== finalScores.length || [...given].some((id) => !ids.has(id))) {
    throw new DomainError(INVALID, { field: "finalScores" });
  }
  if (given.size < ids.size) throw new DomainError(EVERY_FINAL_SCORE, { field: "finalScores" });
  if (ids.size === 0) return null;

  const last = await cycleVisitAt(tx, practiceId, cycleId, "last");
  if (last?.status !== "draft" || (await hasCycleScores(tx, practiceId, cycleId, last.id))) {
    throw new DomainError(FINAL_NEEDS_OPEN_VISIT, { field: "finalScores" });
  }
  return last.id;
}

/**
 * Gli appuntamenti futuri del ciclo: prenotati o confermati dalle 00:00 di oggi, la stessa definizione di
 * `futureCount` del paziente. Solo un ciclo aperto riceve appuntamenti, quindi uno che resta in un
 * ciclo chiuso romperebbe la regola (e la sua visita finirebbe in un ciclo già chiuso).
 */
async function futureInCycle(tx: Tx, practiceId: string, clock: Clock, cycleId: string): Promise<number> {
  const [row] = await tx.query<{ n: number }>(
    `select count(*)::int as n
       from public.appointments
      where practice_id = $1 and cycle_id = $2 and status in ('prenotato', 'confermato') and starts_at >= $3`,
    [practiceId, cycleId, romeDayBounds(clock.today()).start],
  );
  return row?.n ?? 0;
}

/**
 * "Chiudi ciclo". In quest'ordine: il ciclo aperto; gli appuntamenti futuri
 * (come l'archivio del paziente: «Prima annulla i 2 appuntamenti futuri.»); i controlli (data, esito,
 * rinvio, punteggi); i punteggi finali sulla bozza più recente (figli di una bozza: ammessi);
 * la cadenza del paziente o la pausa con «Nessun richiamo» (cadenza invariata); infine il ciclo chiuso.
 * `closed_on` è il giorno scelto dall'utente, mai oltre oggi né prima dell'apertura.
 */
export async function closeCycle(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const close = CloseCycleInput.parse(input);
  const cycle = await requireOpenCycle(tx, practiceId, close.cycleId);
  const futureBlock = archiveBlockText(await futureInCycle(tx, practiceId, clock, close.cycleId));
  if (futureBlock !== null) throw new DomainError(futureBlock);

  // I giorni "AAAA-MM-GG" in ordine di testo sono in ordine di calendario.
  if (close.closedOn > clock.today()) throw new DomainError(CLOSE_IN_FUTURE, { field: "closedOn" });
  if (close.closedOn < cycle.openedOn) throw new DomainError(CLOSE_BEFORE_OPENING, { field: "closedOn" });
  if (close.outcome === "rinviato_al_medico") {
    const referrals = await tx.query("select 1 from public.referrals where practice_id = $1 and cycle_id = $2 limit 1", [
      practiceId,
      close.cycleId,
    ]);
    if (referrals.length === 0) throw new DomainError(REFERRAL_FIRST, { field: "outcome" });
  }
  const finals = close.finalScores === "non_tornato" ? [] : close.finalScores;
  const visitId = close.finalScores === "non_tornato" ? null : await finalScoresVisit(tx, practiceId, close.cycleId, finals);

  if (visitId !== null) {
    for (const final of finals) {
      await tx.query(
        `insert into public.psfs_scores (practice_id, item_id, visit_id, score, phase)
         values ($1, $2, $3, $4, 'finale')`,
        [practiceId, final.itemId, visitId, final.score],
      );
    }
  }

  if (close.recall === "nessuno") {
    await tx.query("update public.patients set recall_paused = true where practice_id = $1 and id = $2", [
      practiceId,
      cycle.patientId,
    ]);
  } else {
    await setRecall(tx, practiceId, clock, { patientId: cycle.patientId, weeks: close.recall.weeks, paused: false });
  }

  const closed = await tx.query(
    `update public.treatment_cycles
        set status = 'closed', closed_on = $3, outcome = $4, outcome_note = $5
      where practice_id = $1 and id = $2 and status = 'open'
      returning id`,
    [practiceId, close.cycleId, close.closedOn, close.outcome, close.outcomeNote ?? null],
  );
  if (closed.length === 0) throw new DomainError(NOT_ALLOWED);
}
