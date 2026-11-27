import { RISK_TAGS, type RiskTag, SYSTEMS } from "@/lib/clinical/catalog";
import type { Tx } from "@/server/db/db";

// Letture dell'anamnesi. Ogni lettura filtra lo studio anche oltre la RLS. I numeri
// `numeric` tornano da PGlite come stringa: `labour_hours` si legge con `::float8`.

export interface HistoryItemRow {
  id: string;
  /** I quattro tipi con un pulsante, più `allergia` ed `esame` che restano nel modello. */
  kind: "patologia" | "farmaco" | "intervento" | "trauma" | "allergia" | "esame";
  label: string;
  region: string | null;
  /** "AAAA-MM-GG". */
  occurredOn: string | null;
  occurredYear: number | null;
  ongoing: boolean;
  riskTags: RiskTag[];
  note: string | null;
}

export type SystemStatus = "nulla" | "da_segnalare";

export interface LifestyleRow {
  occupation: string | null;
  sport: string | null;
  familyHistory: string | null;
  pregnancyStatus: "no" | "in_corso" | "post_partum" | null;
  pregnancyWeeks: number | null;
  /** "AAAA-MM-GG". */
  lastReviewedOn: string | null;
}

export interface PerinatalRow {
  gestationalAgeWeeks: number | null;
  birthWeightG: number | null;
  deliveryMode: "spontaneo" | "operativo_ventosa" | "operativo_forcipe" | "cesareo_programmato" | "cesareo_urgente" | null;
  presentation: "cefalica" | "podalica" | "trasversa" | "altro" | null;
  labourHours: number | null;
  apgar1: number | null;
  apgar5: number | null;
  nicuStay: boolean | null;
  suctionDifficulty: boolean | null;
  plagiocephalyNoted: boolean | null;
  torticollisNoted: boolean | null;
  colic: boolean | null;
  reflux: boolean | null;
  feeding: "seno" | "artificiale" | "misto" | null;
  preferredHeadSide: "dx" | "sx" | "nessuna" | null;
  notes: string | null;
}

export interface HistoryView {
  /** Le voci non tolte, per tipo e poi dalla più recente. */
  items: HistoryItemRow[];
  /** Sempre gli 8 apparati nell'ordine di `SYSTEMS`; uno mai salvato è «Niente da segnalare». */
  systems: { system: string; label: string; status: SystemStatus; note: string | null }[];
  lifestyle: LifestyleRow | null;
  perinatal: PerinatalRow | null;
}

export async function getHistory(tx: Tx, practiceId: string, patientId: string): Promise<HistoryView> {
  const items = await tx.query<HistoryItemRow>(
    `select id, kind, label, region,
            occurred_on as "occurredOn",
            occurred_year as "occurredYear",
            ongoing,
            risk_tags as "riskTags",
            note
       from public.patient_history_items
      where practice_id = $1 and patient_id = $2 and deleted_at is null
      order by array_position(array['patologia', 'farmaco', 'intervento', 'trauma', 'allergia', 'esame'], kind),
               coalesce(extract(year from occurred_on)::int, occurred_year) desc nulls last,
               created_at, id`,
    [practiceId, patientId],
  );

  const saved = await tx.query<{ system: string; status: SystemStatus; note: string | null }>(
    `select system, status, note
       from public.patient_systems_review
      where practice_id = $1 and patient_id = $2`,
    [practiceId, patientId],
  );
  const systems = SYSTEMS.map(({ code, label }) => {
    const row = saved.find((r) => r.system === code);
    return { system: code, label, status: row?.status ?? "nulla", note: row?.note ?? null };
  });

  const [lifestyle] = await tx.query<LifestyleRow>(
    `select occupation, sport,
            family_history as "familyHistory",
            pregnancy_status as "pregnancyStatus",
            pregnancy_weeks as "pregnancyWeeks",
            last_reviewed_on as "lastReviewedOn"
       from public.patient_lifestyle
      where practice_id = $1 and patient_id = $2`,
    [practiceId, patientId],
  );

  const [perinatal] = await tx.query<PerinatalRow>(
    `select gestational_age_weeks as "gestationalAgeWeeks",
            birth_weight_g as "birthWeightG",
            delivery_mode as "deliveryMode",
            presentation,
            labour_hours::float8 as "labourHours",
            apgar_1 as "apgar1",
            apgar_5 as "apgar5",
            nicu_stay as "nicuStay",
            suction_difficulty as "suctionDifficulty",
            plagiocephaly_noted as "plagiocephalyNoted",
            torticollis_noted as "torticollisNoted",
            colic, reflux, feeding,
            preferred_head_side as "preferredHeadSide",
            notes
       from public.perinatal_histories
      where practice_id = $1 and patient_id = $2`,
    [practiceId, patientId],
  );

  return { items, systems, lifestyle: lifestyle ?? null, perinatal: perinatal ?? null };
}

/**
 * Le etichette di rischio dell'anamnesi attiva: l'unione di quelle delle voci non tolte, nell'ordine
 * del vocabolario. Alimentano i badge della testata (TAO, NAO, «Storia di tumore», «Osteoporosi») e le
 * risposte dello screening proposte dall'anamnesi.
 */
export async function activeRiskTags(tx: Tx, practiceId: string, patientId: string): Promise<RiskTag[]> {
  const rows = await tx.query<{ tag: RiskTag }>(
    `select distinct unnest(risk_tags) as tag
       from public.patient_history_items
      where practice_id = $1 and patient_id = $2 and deleted_at is null`,
    [practiceId, patientId],
  );
  const active = new Set(rows.map((r) => r.tag));
  return RISK_TAGS.filter((tag) => active.has(tag));
}

/** Una gravidanza «In corso» (apre il gruppo gravidanza dello screening e il badge in testata). */
export async function pregnancyInProgress(tx: Tx, practiceId: string, patientId: string): Promise<boolean> {
  const [row] = await tx.query<{ inProgress: boolean }>(
    `select exists (
              select 1 from public.patient_lifestyle
               where practice_id = $1 and patient_id = $2 and pregnancy_status = 'in_corso'
            ) as "inProgress"`,
    [practiceId, patientId],
  );
  return row?.inProgress ?? false;
}
