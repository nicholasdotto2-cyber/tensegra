import { riskTagsForDrug } from "@/lib/clinical/rules";
import { SYSTEMS, type RiskTag } from "@/lib/clinical/catalog";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { confirmedDraftGroups, followHistory, followRequiredGroups } from "@/server/domain/visits/ops/screening";
import { activeRiskTags, pregnancyInProgress } from "./queries";
import {
  HISTORY_KINDS,
  HistoryItemIdInput,
  HistoryItemInput,
  LifestyleInput,
  PerinatalInput,
  PREGNANCY_WEEKS_TEXT,
  SystemsReviewInput,
} from "./schemas";

// Comandi dell'anamnesi. Come gli altri comandi del paziente: il paziente
// si controlla prima (uno di un altro studio, o che non c'è, è "Operazione non permessa"), poi si scrive.
// Gli upsert usano le chiavi uniche delle tabelle, così salvare due volte lascia una sola riga. Una voce salvata o
// tolta cambia anche le risposte «da anamnesi» delle visite in bozza del paziente (`followHistory`).

const SCAR_NEEDS_REGION = "La cicatrice vale per interventi e traumi, con la regione.";
// I due tipi su cui vale `cicatrice`: chirurgia e trauma.
const SCAR_KINDS: readonly string[] = ["intervento", "trauma"];

/** Il paziente c'è ed è di questo studio. Altrimenti (anche se è di un altro studio) è "Operazione non permessa". */
async function requirePatient(tx: Tx, practiceId: string, patientId: string): Promise<void> {
  const rows = await tx.query("select 1 from public.patients where practice_id = $1 and id = $2", [practiceId, patientId]);
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

/**
 * Salva una voce dell'anamnesi remota: nuova senza `itemId`, modificata con. Le etichette di rischio di
 * un farmaco nuovo vengono dalle liste TAO e NAO (nome o principio) se l'input non le dà; una voce
 * modificata senza `riskTags` tiene quelle salvate, perché chi le ha tolte a mano non le ritrovi accese.
 * `cicatrice` vale per interventi e traumi, con la regione.
 */
export async function saveHistoryItem(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<{ id: string }> {
  const item = HistoryItemInput.parse(input);
  await requirePatient(tx, practiceId, item.patientId);
  const tagsBefore = await activeRiskTags(tx, practiceId, item.patientId);

  let storedTags: RiskTag[] | null = null;
  if (item.itemId !== undefined) {
    // Una voce tolta, di un altro paziente, o un'allergia o un esame (senza pulsante) non si riscrive.
    const [stored] = await tx.query<{ riskTags: RiskTag[] }>(
      `select risk_tags as "riskTags"
         from public.patient_history_items
        where practice_id = $1 and patient_id = $2 and id = $3 and deleted_at is null and kind = any($4::text[])`,
      [practiceId, item.patientId, item.itemId, HISTORY_KINDS],
    );
    if (!stored) throw new DomainError(NOT_ALLOWED);
    storedTags = stored.riskTags;
  }

  const riskTags: readonly RiskTag[] =
    item.riskTags ?? storedTags ?? (item.kind === "farmaco" ? riskTagsForDrug(item.label) : []);
  if (riskTags.includes("cicatrice") && !(SCAR_KINDS.includes(item.kind) && item.region !== null)) {
    throw new DomainError(SCAR_NEEDS_REGION, { field: "riskTags" });
  }

  const values = [item.kind, item.label, item.region, item.occurredOn, item.occurredYear, item.ongoing, riskTags, item.note];
  const [row] =
    item.itemId === undefined
      ? await tx.query<{ id: string }>(
          `insert into public.patient_history_items
             (practice_id, patient_id, kind, label, region, occurred_on, occurred_year, ongoing, risk_tags, note)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10)
           returning id`,
          [practiceId, item.patientId, ...values],
        )
      : await tx.query<{ id: string }>(
          `update public.patient_history_items
              set kind = $4, label = $5, region = $6, occurred_on = $7, occurred_year = $8, ongoing = $9,
                  risk_tags = $10::text[], note = $11
            where practice_id = $1 and patient_id = $2 and id = $3
            returning id`,
          [practiceId, item.patientId, item.itemId, ...values],
        );
  if (!row) throw new DomainError(NOT_ALLOWED);
  await followHistory(tx, practiceId, item.patientId, tagsBefore);
  return { id: row.id };
}

/** "Togli" su una voce: scrive `deleted_at` all'istante del clock; chi è già tolta tiene il suo istante. */
export async function removeHistoryItem(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { patientId, itemId } = HistoryItemIdInput.parse(input);
  const tagsBefore = await activeRiskTags(tx, practiceId, patientId);
  const rows = await tx.query(
    `update public.patient_history_items
        set deleted_at = coalesce(deleted_at, $4)
      where practice_id = $1 and patient_id = $2 and id = $3
      returning id`,
    [practiceId, patientId, itemId, clock.now()],
  );
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
  await followHistory(tx, practiceId, patientId, tagsBefore);
}

/** Salva gli 8 apparati insieme, nell'ordine di `SYSTEMS`; salvando di nuovo aggiorna le stesse righe. */
export async function saveSystemsReview(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const review = SystemsReviewInput.parse(input);
  await requirePatient(tx, practiceId, review.patientId);
  const order = SYSTEMS.map((s) => s.code);
  const rows = [...review.rows].sort((a, b) => order.indexOf(a.system) - order.indexOf(b.system));
  for (const row of rows) {
    await tx.query(
      `insert into public.patient_systems_review (practice_id, patient_id, system, status, note, reviewed_on)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (practice_id, patient_id, system)
       do update set status = excluded.status, note = excluded.note, reviewed_on = excluded.reviewed_on`,
      [practiceId, review.patientId, row.system, row.status, row.note, review.reviewedOn],
    );
  }
}

/**
 * Salva lo stile di vita. Le settimane di gravidanza ci sono solo con «In corso»;
 * «In corso» senza settimane si salva (non sempre si sanno). `last_reviewed_on` è il giorno della visita, dato dall'input.
 * Una gravidanza che inizia o finisce apre o chiude il suo gruppo dello screening: le bozze confermate che ora chiedono
 * gruppi diversi perdono la conferma (`followRequiredGroups`).
 */
export async function saveLifestyle(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const lifestyle = LifestyleInput.parse(input);
  await requirePatient(tx, practiceId, lifestyle.patientId);
  if (lifestyle.pregnancyWeeks !== null && lifestyle.pregnancyStatus !== "in_corso") {
    throw new DomainError(PREGNANCY_WEEKS_TEXT, { field: "pregnancyWeeks" });
  }
  const pregnancyChanges =
    (await pregnancyInProgress(tx, practiceId, lifestyle.patientId)) !== (lifestyle.pregnancyStatus === "in_corso");
  const groupsBefore = pregnancyChanges ? await confirmedDraftGroups(tx, practiceId, lifestyle.patientId) : null;
  await tx.query(
    `insert into public.patient_lifestyle
       (practice_id, patient_id, occupation, sport, family_history, pregnancy_status, pregnancy_weeks, last_reviewed_on)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (practice_id, patient_id)
     do update set occupation = excluded.occupation, sport = excluded.sport, family_history = excluded.family_history,
                   pregnancy_status = excluded.pregnancy_status, pregnancy_weeks = excluded.pregnancy_weeks,
                   last_reviewed_on = excluded.last_reviewed_on`,
    [
      practiceId,
      lifestyle.patientId,
      lifestyle.occupation,
      lifestyle.sport,
      lifestyle.familyHistory,
      lifestyle.pregnancyStatus,
      lifestyle.pregnancyWeeks,
      lifestyle.reviewedOn,
    ],
  );
  if (groupsBefore !== null) await followRequiredGroups(tx, practiceId, lifestyle.patientId, groupsBefore);
}

/** Salva l'anamnesi perinatale: un gruppo solo, riscritto intero (una chiave a `null` è un dato non noto). */
export async function savePerinatal(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const p = PerinatalInput.parse(input);
  await requirePatient(tx, practiceId, p.patientId);
  await tx.query(
    `insert into public.perinatal_histories
       (practice_id, patient_id, gestational_age_weeks, birth_weight_g, delivery_mode, presentation, labour_hours,
        apgar_1, apgar_5, nicu_stay, suction_difficulty, plagiocephaly_noted, torticollis_noted, colic, reflux,
        feeding, preferred_head_side, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     on conflict (practice_id, patient_id)
     do update set gestational_age_weeks = excluded.gestational_age_weeks, birth_weight_g = excluded.birth_weight_g,
                   delivery_mode = excluded.delivery_mode, presentation = excluded.presentation,
                   labour_hours = excluded.labour_hours, apgar_1 = excluded.apgar_1, apgar_5 = excluded.apgar_5,
                   nicu_stay = excluded.nicu_stay, suction_difficulty = excluded.suction_difficulty,
                   plagiocephaly_noted = excluded.plagiocephaly_noted, torticollis_noted = excluded.torticollis_noted,
                   colic = excluded.colic, reflux = excluded.reflux, feeding = excluded.feeding,
                   preferred_head_side = excluded.preferred_head_side, notes = excluded.notes`,
    [
      practiceId,
      p.patientId,
      p.gestationalAgeWeeks,
      p.birthWeightG,
      p.deliveryMode,
      p.presentation,
      p.labourHours,
      p.apgar1,
      p.apgar5,
      p.nicuStay,
      p.suctionDifficulty,
      p.plagiocephalyNoted,
      p.torticollisNoted,
      p.colic,
      p.reflux,
      p.feeding,
      p.preferredHeadSide,
      p.notes,
    ],
  );
}
