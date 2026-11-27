import {
  FAMILIES,
  SCREENING_ITEMS,
  screeningItem,
  type Family,
  type Outcome,
  type RegionCode,
  type RiskTag,
  type ScreeningGroup,
} from "@/lib/clinical/catalog";
import {
  historyAnswers,
  needsOverrideNote,
  OVERRIDE_NOTE_MIN,
  suggestOutcomes,
  visibleGroups,
  visibleItems,
  type ScreeningAnswer,
  type ScreeningState,
} from "@/lib/clinical/rules";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { cycleVisitAt } from "@/server/domain/cycles/queries";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { activeRiskTags, pregnancyInProgress } from "@/server/domain/history/queries";
import { getClinicalSettings } from "@/server/domain/settings/queries";
import type { VisitOp } from "../schemas";

// La visita e il suo screening: la riga della visita,
// risposte, gruppi visibili, conferma con gli esiti, "Nessuna variazione" e la conferma tolta quando una
// tecnica cervicale apre il gruppo cervicale. Le operazioni passano da `applyVisitOp` (`../ops.ts`).

/** L'operazione `K` dell'unione `VisitOp`. */
export type OpOf<K extends VisitOp["op"]> = Extract<VisitOp, { op: K }>;

export const ANSWER_EVERY_ITEM = 'Rispondi a ogni voce o premi "Nessun\'altra voce".';
export const OVERRIDE_NOTE_TEXT = "Scrivi almeno 10 caratteri per spiegare l'esito.";

/** La visita com'è nel database. */
export interface VisitRow {
  id: string;
  patientId: string;
  cycleId: string;
  appointmentId: string;
  status: "draft" | "closed";
  /** "AAAA-MM-GG", il giorno di Roma dell'appuntamento. */
  visitDate: string;
  kind: string;
  copiedFromVisitId: string | null;
}

/** La visita dello studio; null se non c'è o è di un altro studio. */
export async function loadVisit(tx: Tx, practiceId: string, visitId: string): Promise<VisitRow | null> {
  const [row] = await tx.query<VisitRow>(
    `select id,
            patient_id as "patientId",
            cycle_id as "cycleId",
            appointment_id as "appointmentId",
            status,
            visit_date as "visitDate",
            kind,
            copied_from_visit_id as "copiedFromVisitId"
       from public.visits
      where practice_id = $1 and id = $2`,
    [practiceId, visitId],
  );
  return row ?? null;
}

// Risposte e gruppi visibili ------------------------------------------------------------------------

/** Le risposte salvate dello screening della visita, per voce. */
export async function loadAnswers(tx: Tx, practiceId: string, visitId: string): Promise<ScreeningAnswer[]> {
  return tx.query<ScreeningAnswer>(
    `select item_code as "itemCode",
            answer,
            regions,
            sub_answers as "subAnswers",
            from_history as "fromHistory",
            note
       from public.visit_screening_answers
      where practice_id = $1 and visit_id = $2
      order by item_code`,
    [practiceId, visitId],
  );
}

/** Scrive la risposta di una voce, al posto di quella salvata. */
export async function saveAnswer(tx: Tx, practiceId: string, visitId: string, a: ScreeningAnswer): Promise<void> {
  await tx.query(
    `insert into public.visit_screening_answers
       (practice_id, visit_id, item_code, answer, regions, sub_answers, from_history, note)
     values ($1, $2, $3, $4, $5::text[], $6::text[], $7, $8)
     on conflict (practice_id, visit_id, item_code) do update
       set answer = excluded.answer,
           regions = excluded.regions,
           sub_answers = excluded.sub_answers,
           from_history = excluded.from_history,
           note = excluded.note`,
    [practiceId, visitId, a.itemCode, a.answer, [...a.regions], [...a.subAnswers], a.fromHistory, a.note],
  );
}

export interface Visibility {
  groups: ScreeningGroup[];
  ageMonths: number;
}

/**
 * I gruppi visibili della visita con l'età in mesi al giorno della visita. Le risposte
 * date aprono il loro gruppo (`answeredGroups`): una risposta di un gruppo che si chiude (la gravidanza
 * finita) resta salvata e conta negli esiti, ma la conferma chiede solo le voci visibili. L'editor della
 * visita (`../editor.ts`) mostra i gruppi di questa stessa funzione.
 */
export async function visibility(tx: Tx, practiceId: string, visit: VisitRow, answers: readonly ScreeningAnswer[]): Promise<Visibility> {
  const [row] = await tx.query<{ mainRegion: RegionCode | null; ageMonths: number; cervicalDirectOrThrust: boolean }>(
    `select c.main_region as "mainRegion",
            greatest(0, extract(year from age(v.visit_date::timestamp, p.birth_date::timestamp)) * 12
                        + extract(month from age(v.visit_date::timestamp, p.birth_date::timestamp)))::int as "ageMonths",
            exists (select 1
                      from public.visit_treatments t
                     where t.practice_id = v.practice_id and t.visit_id = v.id
                       and t.region = 'cervical' and t.family in ('thrust', 'direct')) as "cervicalDirectOrThrust"
       from public.visits v
       join public.treatment_cycles c on c.practice_id = v.practice_id and c.id = v.cycle_id
       join public.patients p on p.practice_id = v.practice_id and p.id = v.patient_id
      where v.practice_id = $1 and v.id = $2`,
    [practiceId, visit.id],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);

  const first = await cycleVisitAt(tx, practiceId, visit.cycleId, "first");
  const settings = await getClinicalSettings(tx, practiceId);
  const answeredGroups = [...new Set(answers.flatMap((a) => screeningItem(a.itemCode)?.group ?? []))];
  const groups = visibleGroups({
    firstVisit: first?.id === visit.id,
    mainRegion: row.mainRegion,
    cervicalDirectOrThrust: row.cervicalDirectOrThrust,
    pregnancyInProgress: await pregnancyInProgress(tx, practiceId, visit.patientId),
    ageMonths: row.ageMonths,
    pediatricEnabled: settings?.pediatricRedFlagsEnabled ?? false,
    answeredGroups,
  });
  return { groups, ageMonths: row.ageMonths };
}

function visibleItemCodes(v: Visibility): string[] {
  return v.groups.flatMap((g) => visibleItems(g, v.ageMonths).map((i) => i.code));
}

export type OpMode = "bozza" | "rettifica";

/**
 * I gruppi che si aprono dallo stato di oggi del paziente (gravidanza in corso, red flag pediatriche), non
 * da ciò che valeva alla data della visita. In rettifica di una visita chiusa senza risposte in quel gruppo
 * non si chiedono: una gravidanza di oggi non riguarda una visita di mesi fa.
 * Con una risposta già data, o in bozza (la visita è di oggi), si chiedono come gli altri.
 */
const TODAY_STATE_GROUPS: readonly ScreeningGroup[] = ["rf_gravidanza", "rf_pediatrico"];

/**
 * I gruppi visibili che la visita chiede nel modo dato: in bozza tutti; in rettifica i gruppi dello stato di
 * oggi (`TODAY_STATE_GROUPS`) solo se la visita ha già risposte lì. La conferma, la chiusura e la rettifica
 * li controllano con `allVisibleAnswered`; l'editor (`../editor.ts`) mostra questi stessi gruppi.
 */
export function requiredGroups(v: Visibility, answers: readonly ScreeningAnswer[], mode: OpMode): ScreeningGroup[] {
  const answeredGroups = new Set(answers.flatMap((a) => screeningItem(a.itemCode)?.group ?? []));
  return v.groups.filter((g) => mode === "bozza" || !TODAY_STATE_GROUPS.includes(g) || answeredGroups.has(g));
}

function allVisibleAnswered(v: Visibility, answers: readonly ScreeningAnswer[], mode: OpMode): boolean {
  const answered = new Set(answers.map((a) => a.itemCode));
  return requiredGroups(v, answers, mode)
    .flatMap((g) => visibleItems(g, v.ageMonths))
    .every((item) => answered.has(item.code));
}

function requireEveryVisibleAnswered(v: Visibility, answers: readonly ScreeningAnswer[], mode: OpMode): void {
  if (!allVisibleAnswered(v, answers, mode)) throw new DomainError(ANSWER_EVERY_ITEM);
}

/**
 * Ogni voce visibile ha una risposta salvata. La conferma lo chiede, ma un gruppo può aprirsi dopo
 * (la regione principale cervicale, una riga copiata diretta sulla cervicale): la chiusura e la
 * rettifica lo richiedono di nuovo insieme a `screening_reviewed_at`; in
 * rettifica senza i gruppi dello stato di oggi ancora senza risposte (`TODAY_STATE_GROUPS`).
 */
export async function everyVisibleAnswered(tx: Tx, practiceId: string, visit: VisitRow, mode: OpMode): Promise<boolean> {
  const answers = await loadAnswers(tx, practiceId, visit.id);
  return allVisibleAnswered(await visibility(tx, practiceId, visit, answers), answers, mode);
}

// Conferma ---------------------------------------------------------------------------------------------

/**
 * Una risposta nuova su uno screening confermato toglie la conferma e i tre esiti: lo
 * screening va riconfermato, e fino ad allora nessuna tecnica nuova si salva e la visita non chiude.
 */
async function clearConfirmation(tx: Tx, practiceId: string, visitId: string): Promise<void> {
  await tx.query("delete from public.visit_screening_outcomes where practice_id = $1 and visit_id = $2", [practiceId, visitId]);
  await tx.query(
    `update public.visits set screening_reviewed_at = null
      where practice_id = $1 and id = $2 and screening_reviewed_at is not null`,
    [practiceId, visitId],
  );
}

interface OutcomeRow {
  family: Family;
  suggested: Outcome;
  outcome: Outcome;
  localContraindicated: readonly RegionCode[];
  overrideNote: string | null;
}

/** I tre esiti al posto di quelli salvati, e la conferma all'istante del clock. */
async function confirmScreening(tx: Tx, practiceId: string, clock: Clock, visitId: string, rows: readonly OutcomeRow[]): Promise<void> {
  for (const r of rows) {
    await tx.query(
      `insert into public.visit_screening_outcomes
         (practice_id, visit_id, family, suggested, outcome, local_contraindicated_regions, override_note)
       values ($1, $2, $3, $4, $5, $6::text[], $7)
       on conflict (practice_id, visit_id, family) do update
         set suggested = excluded.suggested,
             outcome = excluded.outcome,
             local_contraindicated_regions = excluded.local_contraindicated_regions,
             override_note = excluded.override_note`,
      [practiceId, visitId, r.family, r.suggested, r.outcome, [...r.localContraindicated], r.overrideNote],
    );
  }
  await tx.query("update public.visits set screening_reviewed_at = $3 where practice_id = $1 and id = $2", [
    practiceId,
    visitId,
    clock.now(),
  ]);
}

/**
 * Gli esiti salvati e il suggerimento dalle risposte salvate, che `checkTreatment` confronta con la
 * tecnica. Null se lo screening non è confermato (o la visita non è dello studio).
 */
export async function loadScreeningState(tx: Tx, practiceId: string, visitId: string): Promise<ScreeningState | null> {
  const [visit] = await tx.query<{ reviewedAt: Date | null }>(
    'select screening_reviewed_at as "reviewedAt" from public.visits where practice_id = $1 and id = $2',
    [practiceId, visitId],
  );
  if (!visit?.reviewedAt) return null;

  const rows = await tx.query<{ family: Family; outcome: Outcome; localContraindicated: RegionCode[] }>(
    `select family, outcome, local_contraindicated_regions as "localContraindicated"
       from public.visit_screening_outcomes
      where practice_id = $1 and visit_id = $2`,
    [practiceId, visitId],
  );
  const outcomes: Partial<ScreeningState["outcomes"]> = {};
  for (const r of rows) outcomes[r.family] = { outcome: r.outcome, localContraindicated: r.localContraindicated };
  if (!FAMILIES.every((f) => outcomes[f] !== undefined)) return null;

  return {
    outcomes: outcomes as ScreeningState["outcomes"],
    suggestion: suggestOutcomes(await loadAnswers(tx, practiceId, visitId)),
  };
}

/**
 * La visita da cui copiare: l'ultima visita chiusa dello stesso ciclo prima di questa,
 * altrimenti l'ultima chiusa del paziente prima di questa (`otherCycle`, «dal ciclo precedente»).
 * "Prima" per giorno e orario dell'appuntamento: una visita chiusa dopo questa non fa da sorgente.
 */
export async function screeningSource(
  tx: Tx,
  practiceId: string,
  visit: VisitRow,
): Promise<{ visitId: string; visitDate: string; otherCycle: boolean } | null> {
  const [row] = await tx.query<{ visitId: string; visitDate: string; otherCycle: boolean }>(
    `select v.id as "visitId", v.visit_date as "visitDate", v.cycle_id <> cur.cycle_id as "otherCycle"
       from public.visits cur
       join public.appointments ca on ca.practice_id = cur.practice_id and ca.id = cur.appointment_id
       join public.visits v on v.practice_id = cur.practice_id and v.patient_id = cur.patient_id
       join public.appointments a on a.practice_id = v.practice_id and a.id = v.appointment_id
      where cur.practice_id = $1 and cur.id = $2
        and v.id <> cur.id and v.status = 'closed'
        and (v.visit_date, a.starts_at) < (cur.visit_date, ca.starts_at)
      order by v.cycle_id = cur.cycle_id desc, v.visit_date desc, a.starts_at desc, v.id desc
      limit 1`,
    [practiceId, visit.id],
  );
  return row ?? null;
}

/** Una risposta su una voce visibile (gruppo e età), dopo aver tolto la conferma. */
export async function answerItem(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"risposta">): Promise<void> {
  const v = await visibility(tx, practiceId, visit, await loadAnswers(tx, practiceId, visit.id));
  if (!visibleItemCodes(v).includes(op.itemCode)) throw new DomainError(NOT_ALLOWED);
  await clearConfirmation(tx, practiceId, visit.id);
  await saveAnswer(tx, practiceId, visit.id, {
    itemCode: op.itemCode,
    answer: op.answer,
    regions: op.regions,
    subAnswers: op.subAnswers,
    fromHistory: false,
    note: op.note ?? null,
  });
}

/** "Nessun'altra voce" su un gruppo visibile: "no" sulle voci senza risposta, dopo aver tolto la conferma. */
export async function noOtherItem(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"nessun_altra_voce">): Promise<void> {
  const answers = await loadAnswers(tx, practiceId, visit.id);
  const v = await visibility(tx, practiceId, visit, answers);
  if (!v.groups.includes(op.group)) throw new DomainError(NOT_ALLOWED);
  const answered = new Set(answers.map((a) => a.itemCode));
  await clearConfirmation(tx, practiceId, visit.id);
  for (const item of visibleItems(op.group, v.ageMonths)) {
    if (answered.has(item.code)) continue;
    await saveAnswer(tx, practiceId, visit.id, {
      itemCode: item.code,
      answer: "no",
      regions: [],
      subAnswers: [],
      fromHistory: false,
      note: null,
    });
  }
}

/**
 * «Conferma lo screening»: ogni voce visibile ha una risposta (in rettifica senza i gruppi dello stato di
 * oggi ancora senza risposte), e un esito più lieve del suggerito ha la nota.
 */
export async function confirmOutcomes(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  visit: VisitRow,
  op: OpOf<"esiti">,
  mode: OpMode,
): Promise<void> {
  const answers = await loadAnswers(tx, practiceId, visit.id);
  requireEveryVisibleAnswered(await visibility(tx, practiceId, visit, answers), answers, mode);

  const suggestion = suggestOutcomes(answers);
  const fieldErrors: Record<string, string> = {};
  const rows = op.outcomes.map((o, i): OutcomeRow => {
    const s = suggestion[o.family];
    const note = o.overrideNote ?? null;
    if (needsOverrideNote(s.suggested, o.outcome) && (note?.length ?? 0) < OVERRIDE_NOTE_MIN) {
      fieldErrors[`outcomes.${i}.overrideNote`] = OVERRIDE_NOTE_TEXT;
    }
    return {
      family: o.family,
      suggested: s.suggested,
      outcome: o.outcome,
      localContraindicated: s.localContraindicated,
      overrideNote: note,
    };
  });
  if (Object.keys(fieldErrors).length > 0) throw new DomainError(OVERRIDE_NOTE_TEXT, { fieldErrors });
  await confirmScreening(tx, practiceId, clock, visit.id, rows);
}

/**
 * "Nessuna variazione dal 15/10": le risposte della visita sorgente sulle voci senza risposta
 * oggi, sempre senza la nota, poi gli esiti ricalcolati senza note (esito = suggerito) e la conferma.
 * Una risposta data oggi dall'osteopata resta com'è: un red flag appena segnato non sparisce. Un "si"
 * proposto oggi dall'anamnesi resta se la sorgente non ha un "si" sulla stessa voce: un
 * farmaco aggiunto dopo la visita sorgente non sparisce dallo screening. Come la conferma, vuole una risposta
 * per ogni voce visibile oggi (un gruppo aperto dopo la sorgente, come la gravidanza, va risposto).
 */
export async function copyScreening(tx: Tx, practiceId: string, clock: Clock, visit: VisitRow): Promise<void> {
  const source = await screeningSource(tx, practiceId, visit);
  if (!source) throw new DomainError(NOT_ALLOWED);

  const merged = new Map((await loadAnswers(tx, practiceId, visit.id)).map((a) => [a.itemCode, a]));
  const copied: ScreeningAnswer[] = [];
  for (const src of await loadAnswers(tx, practiceId, source.visitId)) {
    const today = merged.get(src.itemCode);
    // Una risposta data oggi resta; un "si" proposto oggi dall'anamnesi cede solo a un "si" della
    // sorgente, che porta le regioni già ristrette dall'osteopata.
    const takeSource = !today || (today.fromHistory && today.answer === "si" && src.answer === "si");
    if (!takeSource) continue;
    // La nota non si copia mai: l'INR di sei settimane fa non è quello di oggi.
    const answer = { ...src, note: null };
    merged.set(src.itemCode, answer);
    copied.push(answer);
  }
  const answers = [...merged.values()];
  requireEveryVisibleAnswered(await visibility(tx, practiceId, visit, answers), answers, "bozza");

  for (const a of copied) await saveAnswer(tx, practiceId, visit.id, a);

  const suggestion = suggestOutcomes(answers);
  await confirmScreening(
    tx,
    practiceId,
    clock,
    visit.id,
    FAMILIES.map((family) => ({
      family,
      suggested: suggestion[family].suggested,
      outcome: suggestion[family].suggested,
      localContraindicated: suggestion[family].localContraindicated,
      overrideNote: null,
    })),
  );
}

// Proposte dall'anamnesi nelle bozze -------------------------------------------------------

/**
 * Dopo una scrittura dell'anamnesi del paziente: le risposte «da anamnesi» delle sue visite in bozza seguono le
 * etichette di rischio di adesso, non solo quelle dell'avvio della visita. `before` sono le etichette attive prima
 * della scrittura. Un'etichetta nuova propone il suo "si" (`historyAnswers`) al posto di una risposta che non è già
 * "si": il farmaco è un'informazione nuova, anche dopo un "no" di "Nessun'altra voce". Un'etichetta tolta toglie la
 * sua risposta solo se è ancora quella proposta (`from_history`) senza nota, sottovoci né regioni cambiate; con questo
 * dettaglio la risposta resta e non è più «da anamnesi», e una risposta data dall'osteopata resta comunque. Se una
 * risposta cambia, la conferma e i tre esiti si tolgono come per una `risposta`: il TAO aggiunto
 * durante la visita pesa sulle famiglie solo dopo una nuova conferma. Le visite chiuse non cambiano.
 */
export async function followHistory(
  tx: Tx,
  practiceId: string,
  patientId: string,
  before: readonly RiskTag[],
): Promise<void> {
  const after = await activeRiskTags(tx, practiceId, patientId);
  const added = after.filter((tag) => !before.includes(tag));
  const removed = new Set(before.filter((tag) => !after.includes(tag)));
  if (added.length === 0 && removed.size === 0) return;

  const proposals = historyAnswers(added);
  const withdrawn = SCREENING_ITEMS.filter((item) => item.linkedRiskTag !== null && removed.has(item.linkedRiskTag));
  const drafts = await tx.query<{ id: string }>(
    "select id from public.visits where practice_id = $1 and patient_id = $2 and status = 'draft' order by id",
    [practiceId, patientId],
  );
  for (const { id: visitId } of drafts) {
    const saved = new Map((await loadAnswers(tx, practiceId, visitId)).map((a) => [a.itemCode, a]));
    let changed = false;
    for (const proposal of proposals) {
      const prior = saved.get(proposal.itemCode);
      if (prior?.answer === "si") continue;
      // Il "si" proposto prende il posto della risposta, ma il dettaglio scritto dall'osteopata resta: la nota, le
      // sottovoci e, per una voce locale, le regioni già scelte.
      await saveAnswer(tx, practiceId, visitId, {
        ...proposal,
        regions: proposal.regions.length > 0 && (prior?.regions.length ?? 0) > 0 ? (prior?.regions ?? []) : proposal.regions,
        subAnswers: prior?.subAnswers ?? [],
        note: prior?.note ?? null,
      });
      changed = true;
    }
    for (const item of withdrawn) {
      const prior = saved.get(item.code);
      if (prior?.fromHistory !== true) continue;
      // Con una nota, delle sottovoci o regioni diverse da quelle proposte la risposta porta il lavoro dell'osteopata:
      // resta com'è e non è più «da anamnesi». Senza, la proposta si ritira.
      const sameRegions =
        prior.regions.length === item.proposedRegions.length && prior.regions.every((r) => item.proposedRegions.includes(r));
      const detailed = prior.note !== null || prior.subAnswers.length > 0 || (item.scope === "local" && !sameRegions);
      if (detailed) {
        await saveAnswer(tx, practiceId, visitId, { ...prior, fromHistory: false });
      } else {
        await tx.query(
          "delete from public.visit_screening_answers where practice_id = $1 and visit_id = $2 and item_code = $3",
          [practiceId, visitId, item.code],
        );
      }
      changed = true;
    }
    if (changed) await clearConfirmation(tx, practiceId, visitId);
  }
}

// Gravidanza cambiata nello stile di vita ------------------------------------------------

/** Per ogni bozza del paziente con lo screening confermato, i gruppi che la conferma chiede (`requiredGroups`). */
export async function confirmedDraftGroups(tx: Tx, practiceId: string, patientId: string): Promise<Map<string, string>> {
  const drafts = await tx.query<{ id: string }>(
    `select id from public.visits
      where practice_id = $1 and patient_id = $2 and status = 'draft' and screening_reviewed_at is not null
      order by id`,
    [practiceId, patientId],
  );
  const groups = new Map<string, string>();
  for (const { id } of drafts) {
    const visit = await loadVisit(tx, practiceId, id);
    if (visit === null) continue;
    const answers = await loadAnswers(tx, practiceId, id);
    groups.set(id, requiredGroups(await visibility(tx, practiceId, visit, answers), answers, "bozza").join(","));
  }
  return groups;
}

/**
 * Dopo un cambio di gravidanza (`saveLifestyle`): il gruppo della gravidanza si apre o si chiude, quindi una bozza
 * confermata che ora chiede gruppi diversi da `before` (`confirmedDraftGroups` letto prima della scrittura) perde la
 * conferma e i tre esiti, come per un'etichetta di rischio (`followHistory`). Le visite chiuse non cambiano.
 */
export async function followRequiredGroups(
  tx: Tx,
  practiceId: string,
  patientId: string,
  before: ReadonlyMap<string, string>,
): Promise<void> {
  const after = await confirmedDraftGroups(tx, practiceId, patientId);
  for (const [visitId, groups] of after) {
    if (before.get(visitId) !== groups) await clearConfirmation(tx, practiceId, visitId);
  }
}

// Gruppo cervicale aperto da una tecnica -------------------------------------------------

const CERVICAL_GROUP: ScreeningGroup = "rf_cervicale_vascolare";

/**
 * Dopo aver scritto o confermato righe di trattamento: se una è diretta o thrust sulla cervicale e il gruppo
 * cervicale, ora visibile, ha voci senza risposta, toglie la conferma dello screening.
 */
export async function clearIfCervicalGroupOpened(
  tx: Tx,
  practiceId: string,
  visit: VisitRow,
  rows: readonly { region: string; family: Family }[],
): Promise<void> {
  if (!rows.some((r) => r.region === "cervical" && r.family !== "indirect")) return;
  const [row] = await tx.query<{ reviewedAt: Date | null }>(
    'select screening_reviewed_at as "reviewedAt" from public.visits where practice_id = $1 and id = $2',
    [practiceId, visit.id],
  );
  if (!row?.reviewedAt) return;
  const answers = await loadAnswers(tx, practiceId, visit.id);
  const v = await visibility(tx, practiceId, visit, answers);
  if (!v.groups.includes(CERVICAL_GROUP)) return;
  const answered = new Set(answers.map((a) => a.itemCode));
  if (visibleItems(CERVICAL_GROUP, v.ageMonths).some((item) => !answered.has(item.code))) {
    await clearConfirmation(tx, practiceId, visit.id);
  }
}
