import { ADVICE_TEMPLATES, NEURO_TESTS, technique, type Family, type RegionCode, type TechniqueCode } from "@/lib/clinical/catalog";
import { measureKey } from "@/lib/clinical/compare";
import { checkTreatment, techniqueFamily } from "@/lib/clinical/rules";
import type { SqlParam, Tx } from "@/server/db/db";
import { cycleIsOpen, writeCycleOpening } from "@/server/domain/cycles/commands";
import { openingVisitOf } from "@/server/domain/cycles/queries";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { getClinicalSettings } from "@/server/domain/settings/queries";
import { FREE_TEST } from "../schemas";
import { requireTreatmentConsent, TREATMENT_CONSENT_REVOKED, treatmentConsentRevoked } from "./consent";
import { clearIfCervicalGroupOpened, loadScreeningState, type OpOf, type VisitRow } from "./screening";

// La cartella della visita:
// campi, campi d'apertura del ciclo, PSFS iniziale, disfunzioni TART, test,
// tecniche con i blocchi dello screening, consigli e conferma dei copiati. Le operazioni passano da
// `applyVisitOp` (`../ops.ts`), che chiama prima i loro `validate...`: le regole che le altre operazioni
// della stessa rettifica non cambiano (consenso, prima visita del ciclo, righe della visita, test attivi).
// Il blocco dello screening sulla tecnica resta nella scrittura, perché legge gli esiti che una rettifica
// può aver cambiato poco prima, nella stessa lista.

type VisitFields = OpOf<"campi">["values"];

export const FIELD_COLUMNS: Record<keyof VisitFields, string> = {
  location: "location",
  othersPresent: "others_present",
  othersPresentConsented: "others_present_consented",
  nprsPre: "nprs_pre",
  nprsPost: "nprs_post",
  subjectiveUpdate: "subjective_update",
  radiationSites: "radiation_sites",
  radiationSide: "radiation_side",
  treatmentResponse: "treatment_response",
  adverseReaction: "adverse_reaction",
  adverseReactionNote: "adverse_reaction_note",
  observationNote: "observation_note",
  workingHypothesis: "working_hypothesis",
  planNext: "plan_next",
  bpSystolic: "bp_systolic",
  bpDiastolic: "bp_diastolic",
};

/** La risposta al trattamento è della sezione D: con il consenso revocato non si scrive. */
export async function validateFields(tx: Tx, practiceId: string, visit: VisitRow, values: VisitFields): Promise<void> {
  if (values.treatmentResponse !== undefined) await requireTreatmentConsent(tx, practiceId, visit);
}

/** I campi dati; una chiave assente non cambia la colonna. */
export async function writeFields(tx: Tx, practiceId: string, visit: VisitRow, values: VisitFields): Promise<void> {
  const params: SqlParam[] = [practiceId, visit.id];
  const sets: string[] = [];
  for (const key of Object.keys(FIELD_COLUMNS) as (keyof VisitFields)[]) {
    const value = values[key];
    if (value === undefined) continue;
    params.push(Array.isArray(value) ? [...value] : value);
    sets.push(`${FIELD_COLUMNS[key]} = $${params.length}${key === "radiationSites" ? "::text[]" : ""}`);
  }
  if (sets.length === 0) return;
  await tx.query(`update public.visits set ${sets.join(", ")} where practice_id = $1 and id = $2`, params);
}

// Campi d'apertura del ciclo ------------------------------------------------------

/**
 * La visita tiene l'apertura del ciclo (`openingVisitOf`): in bozza la prima visita di un ciclo senza visite chiuse,
 * in rettifica la prima visita chiusa del ciclo, anche quando una seduta precedente, compilata dopo, è diventata la
 * prima in ordine di data.
 */
async function requireOpeningVisit(tx: Tx, practiceId: string, visit: VisitRow): Promise<void> {
  if ((await openingVisitOf(tx, practiceId, visit.cycleId))?.id !== visit.id) throw new DomainError(NOT_ALLOWED);
}

/**
 * I campi d'apertura si scrivono dalla visita che tiene l'apertura, in bozza e in rettifica; in bozza solo
 * finché il ciclo è aperto, come `updateCycleOpening`. Dopo, solo con una rettifica.
 */
export async function validateOpening(tx: Tx, practiceId: string, visit: VisitRow, mode: "bozza" | "rettifica"): Promise<void> {
  await requireOpeningVisit(tx, practiceId, visit);
  if (mode === "bozza" && !(await cycleIsOpen(tx, practiceId, visit.cycleId))) throw new DomainError(NOT_ALLOWED);
}

/**
 * I campi d'apertura dati sul ciclo della visita, con il titolo che nasce dalla regione principale
 * (`writeCycleOpening`); una chiave assente non cambia la colonna.
 */
export async function writeOpening(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"apertura">): Promise<void> {
  // `writeCycleOpening` legge solo le chiavi dei campi d'apertura: il nome dell'operazione non conta.
  await writeCycleOpening(tx, practiceId, visit.cycleId, op);
}

// PSFS iniziale ----------------------------------------------------------------------------

/**
 * Il punteggio iniziale di un'attività del ciclo della visita, solo alla visita che tiene l'apertura
 * (`requireOpeningVisit`). Un punteggio di un'altra fase sulla stessa visita (il finale di `closeCycle`) non si
 * riscrive da qui.
 */
export async function validatePsfs(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"psfs">): Promise<void> {
  const items = await tx.query("select 1 from public.psfs_items where practice_id = $1 and id = $2 and cycle_id = $3", [
    practiceId,
    op.itemId,
    visit.cycleId,
  ]);
  if (items.length === 0) throw new DomainError(NOT_ALLOWED);
  await requireOpeningVisit(tx, practiceId, visit);
  const [saved] = await tx.query<{ phase: string }>(
    "select phase from public.psfs_scores where practice_id = $1 and item_id = $2 and visit_id = $3",
    [practiceId, op.itemId, visit.id],
  );
  if (saved && saved.phase !== "iniziale") throw new DomainError(NOT_ALLOWED);
}

/** Il punteggio iniziale al posto di quello salvato; `null` lo toglie. */
export async function scorePsfs(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"psfs">): Promise<void> {
  if (op.score === null) {
    await tx.query("delete from public.psfs_scores where practice_id = $1 and item_id = $2 and visit_id = $3", [
      practiceId,
      op.itemId,
      visit.id,
    ]);
    return;
  }
  await tx.query(
    `insert into public.psfs_scores (practice_id, item_id, visit_id, score, phase)
     values ($1, $2, $3, $4, 'iniziale')
     on conflict (practice_id, item_id, visit_id) do update set score = excluded.score`,
    [practiceId, op.itemId, visit.id, op.score],
  );
}

// Disfunzioni somatiche --------------------------------------------------------------

/** La regione con le sue lettere TART, al posto di quella salvata; "Primaria" la toglie prima all'altra. */
export async function saveFinding(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"disfunzione">): Promise<void> {
  if (op.isPrimary) {
    await tx.query(
      `update public.visit_region_findings set is_primary = false
        where practice_id = $1 and visit_id = $2 and is_primary and region <> $3`,
      [practiceId, visit.id, op.region],
    );
  }
  // Una scrittura su una riga copiata la conferma ("ogni riga si conferma anche toccandola").
  await tx.query(
    `insert into public.visit_region_findings
       (practice_id, visit_id, region, severity, tissue_texture, asymmetry, restriction, tenderness, side,
        segment_note, is_primary, copied, id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, coalesce($12::uuid, gen_random_uuid()))
     on conflict (practice_id, visit_id, region) do update
       set severity = excluded.severity,
           tissue_texture = excluded.tissue_texture,
           asymmetry = excluded.asymmetry,
           restriction = excluded.restriction,
           tenderness = excluded.tenderness,
           side = excluded.side,
           segment_note = excluded.segment_note,
           is_primary = excluded.is_primary,
           copied = false`,
    [
      practiceId,
      visit.id,
      op.region,
      op.severity,
      op.tissueTexture,
      op.asymmetry,
      op.restriction,
      op.tenderness,
      op.side,
      op.segmentNote,
      op.isPrimary,
      op.id ?? null,
    ],
  );
}

/** "Nessuna disfunzione" è l'assenza della riga: togliere una regione senza riga non cambia niente. */
export async function removeFinding(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"togli_disfunzione">): Promise<void> {
  await tx.query("delete from public.visit_region_findings where practice_id = $1 and visit_id = $2 and region = $3", [
    practiceId,
    visit.id,
    op.region,
  ]);
}

// Test -------------------------------------------------------------------------------------

export const TEST_NOT_ACTIVE = "Test non attivo nello studio.";

const NEURO_CODES = new Set(NEURO_TESTS.map((t) => t.code));

/**
 * Il risultato di un test. Stesso test e lato (`measureKey`: il test libero per nome, senza maiuscole né
 * accenti) = la stessa riga, aggiornata; che un test nuovo sia attivo lo guarda `validateTest`. Solo un
 * valore salvato conferma la riga copiata: una nota o il dolore provocato senza valore la
 * lasciano "da confermare", e `conferma` la toglie se resta senza valore.
 */
export async function saveTest(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"test">): Promise<void> {
  const existing = await findTestRow(tx, practiceId, visit, op);
  const values = [
    op.customLabel,
    op.customUnit,
    op.side,
    op.valueBool,
    op.valueLateral,
    op.valueNumeric,
    op.valueOrdinal,
    op.painProvoked,
    op.note,
  ];
  if (existing) {
    const hasValue = [op.valueBool, op.valueLateral, op.valueNumeric, op.valueOrdinal].some((v) => v !== null);
    await tx.query(
      `update public.visit_test_results
          set custom_label = $3, custom_unit = $4, side = $5, value_bool = $6, value_lateral = $7,
              value_numeric = $8, value_ordinal = $9, pain_provoked = $10, note = $11,
              copied = copied and not $12::boolean
        where practice_id = $1 and id = $2`,
      [practiceId, existing.id, ...values, hasValue],
    );
    return;
  }
  await tx.query(
    `insert into public.visit_test_results
       (practice_id, visit_id, test_code, custom_label, custom_unit, side, value_bool, value_lateral,
        value_numeric, value_ordinal, pain_provoked, note, id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, coalesce($13::uuid, gen_random_uuid()))`,
    [practiceId, visit.id, op.testCode, ...values, op.id ?? null],
  );
}

/** La riga dello stesso test e lato (`measureKey`) nella visita, se c'è. */
export async function findTestRow(
  tx: Tx,
  practiceId: string,
  visit: VisitRow,
  op: { testCode: string; customLabel: string | null; side: "dx" | "sx" | null },
): Promise<{ id: string } | undefined> {
  const rows = await tx.query<{ id: string; testCode: string; customLabel: string | null; side: "dx" | "sx" | null }>(
    `select id, test_code as "testCode", custom_label as "customLabel", side
       from public.visit_test_results
      where practice_id = $1 and visit_id = $2 and test_code = $3`,
    [practiceId, visit.id, op.testCode],
  );
  const key = measureKey(op);
  return rows.find((r) => measureKey(r) === key);
}

/** Il test è attivo nello studio; l'esame neurologico e il test libero lo sono sempre. */
export async function testActive(tx: Tx, practiceId: string, testCode: string): Promise<boolean> {
  if (testCode === FREE_TEST || NEURO_CODES.has(testCode)) return true;
  return (await getClinicalSettings(tx, practiceId))?.activeTestCodes.includes(testCode) ?? false;
}

/** Un test nuovo deve essere attivo; una riga già salvata di un test poi spento si aggiorna ancora. */
export async function validateTest(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"test">): Promise<void> {
  if (await findTestRow(tx, practiceId, visit, op)) return;
  if (!(await testActive(tx, practiceId, op.testCode))) throw new DomainError(TEST_NOT_ACTIVE);
}

export type ChildTable = "visit_region_findings" | "visit_test_results" | "visit_treatments" | "visit_advice";

/** Un id già scritto appartiene alla stessa visita: il retry non riapplica l'operazione. */
export async function visitWriteExists(
  tx: Tx,
  practiceId: string,
  visitId: string,
  table: ChildTable | "visit_amendments",
  id: string | undefined,
): Promise<boolean> {
  if (id === undefined) return false;
  const [row] = await tx.query<{ visitId: string }>(
    `select visit_id as "visitId" from public.${table} where practice_id = $1 and id = $2`,
    [practiceId, id],
  );
  if (!row) return false;
  if (row.visitId !== visitId) throw new DomainError(NOT_ALLOWED);
  return true;
}

/** Le sole operazioni che possono creare una riga con un id nuovo. */
export async function visitOpExists(tx: Tx, practiceId: string, visitId: string, op: import("../schemas").VisitOp): Promise<boolean> {
  switch (op.op) {
    case "disfunzione": return visitWriteExists(tx, practiceId, visitId, "visit_region_findings", op.id);
    case "test": return visitWriteExists(tx, practiceId, visitId, "visit_test_results", op.id);
    case "tecnica": return visitWriteExists(tx, practiceId, visitId, "visit_treatments", op.id);
    case "consiglio": return visitWriteExists(tx, practiceId, visitId, "visit_advice", op.id);
    default: return false;
  }
}

/** La riga figlia è della visita; un id che non lo è è "Operazione non permessa". */
export async function requireChild(tx: Tx, practiceId: string, visit: VisitRow, table: ChildTable, id: string): Promise<void> {
  const rows = await tx.query(`select 1 from public.${table} where practice_id = $1 and visit_id = $2 and id = $3`, [
    practiceId,
    visit.id,
    id,
  ]);
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

/** Toglie una riga figlia della visita, già controllata da `requireChild`. */
export async function removeChild(tx: Tx, practiceId: string, visit: VisitRow, table: ChildTable, id: string): Promise<void> {
  await tx.query(`delete from public.${table} where practice_id = $1 and visit_id = $2 and id = $3`, [practiceId, visit.id, id]);
}

// Tecniche -------------------------------------------------------------

/** La famiglia di screening e l'approccio da salvare per la tecnica dell'operazione. */
function techniqueRow(op: OpOf<"tecnica">): { family: Family; approach: string | null } {
  const family = techniqueFamily(op.techniqueCode, op.approach);
  // Craniale e viscerale senza approccio dichiarato: l'approccio è quello della famiglia predefinita.
  return { family, approach: technique(op.techniqueCode)?.variableApproach ? (op.approach ?? family) : null };
}

/** La riga della stessa regione e tecnica ("Altra tecnica" per nome, senza maiuscole), se c'è. */
export async function findTreatment(
  tx: Tx,
  practiceId: string,
  visit: VisitRow,
  op: { region: string; techniqueCode: string; customTechnique: string | null },
) {
  const [row] = await tx.query<{
    id: string;
    family: Family;
    approach: string | null;
    tolerance: string;
    response: string | null;
    copied: boolean;
  }>(
    `select id, family, approach, tolerance, response, copied
       from public.visit_treatments
      where practice_id = $1 and visit_id = $2 and region = $3 and technique_code = $4
        and coalesce(lower(custom_technique), '') = coalesce(lower($5), '')`,
    [practiceId, visit.id, op.region, op.techniqueCode, op.customTechnique],
  );
  return row;
}

/**
 * Con il consenso al trattamento revocato si annota soltanto: passa la sola nota di una riga già salvata
 * e confermata; ogni altro cambio, o la conferma di una riga copiata, è
 * trattamento.
 */
export async function validateTechnique(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"tecnica">): Promise<void> {
  if (!(await treatmentConsentRevoked(tx, practiceId, visit))) return;
  const { approach } = techniqueRow(op);
  const existing = await findTreatment(tx, practiceId, visit, op);
  const noteOnly =
    existing !== undefined &&
    !existing.copied &&
    existing.approach === approach &&
    existing.tolerance === op.tolerance &&
    existing.response === op.response;
  if (!noteOnly) throw new DomainError(TREATMENT_CONSENT_REVOKED);
}

/**
 * Una tecnica in una regione: una riga per regione e tecnica ("Altra tecnica" per nome), con la famiglia
 * di screening calcolata e salvata; il consenso revocato lo guarda `validateTechnique`. Il blocco
 * dello screening (`checkTreatment`) vale per una riga nuova o per un cambio di famiglia (l'approccio), non
 * per la sola nota, tolleranza o risposta di una riga già salvata (la riga eseguita prima di un red
 * flag resta e prende la nota).
 *
 * Una tecnica diretta o thrust sulla cervicale apre il gruppo dei red flag cervicali: se lo
 * apre con voci senza risposta su uno screening confermato, la riga si salva e la conferma si toglie con i
 * tre esiti, come una risposta nuova. Da lì nessuna tecnica nuova si salva e la
 * visita non chiude finché l'osteopata non risponde al gruppo e riconferma.
 */
export async function saveTechnique(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"tecnica">): Promise<void> {
  const { family, approach } = techniqueRow(op);
  const existing = await findTreatment(tx, practiceId, visit, op);
  if (!existing || existing.family !== family) {
    const check = checkTreatment(
      { region: op.region, techniqueCode: op.techniqueCode, approach: op.approach, customTechnique: op.customTechnique },
      await loadScreeningState(tx, practiceId, visit.id),
    );
    if (check.kind === "blocked") throw new DomainError(check.text);
  }

  if (existing) {
    await tx.query(
      `update public.visit_treatments
          set approach = $3, family = $4, tolerance = $5, response = $6, note = $7, copied = false
        where practice_id = $1 and id = $2`,
      [practiceId, existing.id, approach, family, op.tolerance, op.response, op.note],
    );
  } else {
    await tx.query(
      `insert into public.visit_treatments
         (practice_id, visit_id, region, technique_code, custom_technique, approach, family, tolerance, response, note, id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11::uuid, gen_random_uuid()))`,
      [practiceId, visit.id, op.region, op.techniqueCode, op.customTechnique, approach, family, op.tolerance, op.response, op.note, op.id ?? null],
    );
  }

  await clearIfCervicalGroupOpened(tx, practiceId, visit, [{ region: op.region, family }]);
}

// Consigli ---------------------------------------------------------------------------

/** La riga del consiglio: quella con `adviceId`, altrimenti la prima del modello nella visita. */
export async function findAdvice(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"consiglio">) {
  const [row] = await tx.query<{ id: string }>(
    `select id from public.visit_advice
      where practice_id = $1 and visit_id = $2 and template_code = $3 and ($4::uuid is null or id = $4::uuid)
      order by id
      limit 1`,
    [practiceId, visit.id, op.templateCode, op.adviceId ?? null],
  );
  return row;
}

/** Un `adviceId` deve essere una riga di quel modello nella visita. */
export async function validateAdvice(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"consiglio">): Promise<void> {
  if (op.adviceId !== undefined && !(await findAdvice(tx, practiceId, visit, op))) throw new DomainError(NOT_ALLOWED);
}

/**
 * Un consiglio dato: il testo copiato dal modello (o quello modificato) e i canali. Con `adviceId` la riga
 * della visita di quel modello; senza, la riga del modello se c'è già (la spunta è un interruttore).
 */
export async function saveAdvice(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"consiglio">): Promise<void> {
  const template = ADVICE_TEMPLATES.find((t) => t.code === op.templateCode);
  if (!template) throw new DomainError(NOT_ALLOWED);
  const text = op.text ?? template.body;

  const existing = await findAdvice(tx, practiceId, visit, op);
  if (existing) {
    await tx.query("update public.visit_advice set text = $3, communicated_via = $4::text[] where practice_id = $1 and id = $2", [
      practiceId,
      existing.id,
      text,
      [...op.communicatedVia],
    ]);
    return;
  }
  await tx.query(
    `insert into public.visit_advice (practice_id, visit_id, template_code, text, communicated_via, id)
     values ($1, $2, $3, $4, $5::text[], coalesce($6::uuid, gen_random_uuid()))`,
    [practiceId, visit.id, op.templateCode, text, [...op.communicatedVia], op.id ?? null],
  );
}

// Conferma dei copiati -----------------------------------------------------------

/** Le tabelle che hanno righe copiate dalla visita precedente (i consigli non si copiano). */
export const COPIED_TABLES = ["visit_region_findings", "visit_test_results", "visit_treatments"] as const;
export type CopiedTable = (typeof COPIED_TABLES)[number];

/** Le righe copiate e non ancora confermate della visita, nelle tabelle date (predefinito: tutte e tre). */
export async function copiedRowsCount(
  tx: Tx,
  practiceId: string,
  visitId: string,
  tables: readonly CopiedTable[] = COPIED_TABLES,
): Promise<number> {
  const sum = tables
    .map((t) => `(select count(*) from public.${t} where practice_id = $1 and visit_id = $2 and copied)`)
    .join(" + ");
  const [row] = await tx.query<{ n: number }>(`select (${sum})::int as n`, [practiceId, visitId]);
  return row?.n ?? 0;
}

const CONFIRM_TABLE = {
  findings: "visit_region_findings",
  tests: "visit_test_results",
  treatments: "visit_treatments",
} as const;

const NO_TEST_VALUE = "num_nonnulls(value_bool, value_lateral, value_numeric, value_ordinal) = 0";

/**
 * Una riga sola da confermare deve essere della visita. Confermare una tecnica copiata è trattamento: con
 * il consenso revocato no, né da sola né con "tutti" quando ci sono tecniche copiate.
 */
export async function validateConfirm(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"conferma">): Promise<void> {
  if (op.target === "tutti") {
    if ((await copiedRowsCount(tx, practiceId, visit.id, ["visit_treatments"])) > 0) {
      await requireTreatmentConsent(tx, practiceId, visit);
    }
    return;
  }
  await requireChild(tx, practiceId, visit, CONFIRM_TABLE[op.target.table], op.target.id);
  if (op.target.table === "treatments") await requireTreatmentConsent(tx, practiceId, visit);
}

/**
 * Confermare una tecnica copiata la registra come eseguita oggi: valgono gli stessi controlli di una
 * `tecnica` nuova, cioè lo screening confermato (`SCREENING_FIRST`) e il blocco di `checkTreatment`
 * con il suo testo. Una riga copiata bloccata non si conferma: l'osteopata la toglie.
 * Con `target` null valgono tutte le tecniche copiate della visita.
 */
async function requireCopiedTreatmentsAllowed(
  tx: Tx,
  practiceId: string,
  visit: VisitRow,
  target: { table: "findings" | "tests" | "treatments"; id: string } | null,
): Promise<void> {
  if (target !== null && target.table !== "treatments") return;
  const rows = await tx.query<{
    region: RegionCode;
    techniqueCode: TechniqueCode;
    customTechnique: string | null;
    approach: "direct" | "indirect" | null;
  }>(
    `select region, technique_code as "techniqueCode", custom_technique as "customTechnique", approach
       from public.visit_treatments
      where practice_id = $1 and visit_id = $2 and copied and ($3::uuid is null or id = $3::uuid)
      order by region, technique_code, id`,
    [practiceId, visit.id, target?.id ?? null],
  );
  if (rows.length === 0) return;
  const state = await loadScreeningState(tx, practiceId, visit.id);
  for (const row of rows) {
    const check = checkTreatment(row, state);
    if (check.kind === "blocked") throw new DomainError(check.text);
  }
}

/**
 * Conferma una riga copiata, o tutte: `copied` torna false. Un test copiato rimasto senza valore si toglie,
 * perché un test non misurato oggi non è un risultato. Una tecnica cervicale diretta o thrust confermata
 * qui toglie la conferma dello screening come in `saveTechnique`, se apre il gruppo cervicale.
 */
export async function confirmCopied(tx: Tx, practiceId: string, visit: VisitRow, op: OpOf<"conferma">): Promise<void> {
  await requireCopiedTreatmentsAllowed(tx, practiceId, visit, op.target === "tutti" ? null : op.target);
  if (op.target === "tutti") {
    await tx.query(
      `delete from public.visit_test_results where practice_id = $1 and visit_id = $2 and copied and ${NO_TEST_VALUE}`,
      [practiceId, visit.id],
    );
    for (const table of [CONFIRM_TABLE.findings, CONFIRM_TABLE.tests]) {
      await tx.query(`update public.${table} set copied = false where practice_id = $1 and visit_id = $2 and copied`, [
        practiceId,
        visit.id,
      ]);
    }
    const treatments = await tx.query<{ region: string; family: Family }>(
      `update public.visit_treatments set copied = false
        where practice_id = $1 and visit_id = $2 and copied
        returning region, family`,
      [practiceId, visit.id],
    );
    await clearIfCervicalGroupOpened(tx, practiceId, visit, treatments);
    return;
  }

  const table = CONFIRM_TABLE[op.target.table];
  if (op.target.table === "tests") {
    const removed = await tx.query(
      `delete from public.visit_test_results
        where practice_id = $1 and visit_id = $2 and id = $3 and copied and ${NO_TEST_VALUE}
        returning id`,
      [practiceId, visit.id, op.target.id],
    );
    if (removed.length > 0) return;
  }
  const rows = await tx.query<{ region: string; family: Family | null }>(
    `update public.${table} set copied = false where practice_id = $1 and visit_id = $2 and id = $3
     returning ${op.target.table === "treatments" ? "region, family" : "id as region, null as family"}`,
    [practiceId, visit.id, op.target.id],
  );
  const treatments = rows.flatMap((r) => (r.family === null ? [] : [{ region: r.region, family: r.family }]));
  await clearIfCervicalGroupOpened(tx, practiceId, visit, treatments);
}
