import { FAMILIES } from "@/lib/clinical/catalog";
import { AMEND_TARGET_TWICE } from "@/lib/clinical/labels";
import { type AmendRows, amendTargets } from "@/lib/visits/amend-targets";
import type { Tx } from "@/server/db/db";
import { DomainError } from "@/server/domain/errors";
import { OPENING_COLUMNS, openingTitleChange } from "@/server/domain/cycles/commands";
import type { VisitOp } from "../schemas";
import { copiedRowsCount, FIELD_COLUMNS, findAdvice, findTestRow, findTreatment } from "./record";
import type { VisitRow } from "./screening";

// Il "prima" di una rettifica: per ogni operazione i valori che
// cambierà, letti dalle tabelle prima della riga di `visit_amendments`, e `null` per una riga nuova. Il
// "dopo" sono i valori dell'operazione (`afterOf`). Le forme sono quelle dell'operazione, così prima e
// dopo si confrontano campo per campo. `changesFor` aggiunge le scritture che l'operazione fa fuori dal
// suo bersaglio: la primaria tolta a un'altra regione (una voce in più) e il titolo del ciclo rigenerato
// dalla regione principale (la chiave `title` nella stessa voce).

const FINDING_COLUMNS = `region, severity, tissue_texture as "tissueTexture", asymmetry, restriction, tenderness, side,
            segment_note as "segmentNote", is_primary as "isPrimary"`;

const TEST_COLUMNS = `test_code as "testCode", custom_label as "customLabel", custom_unit as "customUnit", side,
            value_bool as "valueBool", value_lateral as "valueLateral", value_numeric::float8 as "valueNumeric",
            value_ordinal as "valueOrdinal", pain_provoked as "painProvoked", note`;

const TREATMENT_COLUMNS = `region, technique_code as "techniqueCode", custom_technique as "customTechnique", approach,
            tolerance, response, note`;

const ADVICE_COLUMNS = `template_code as "templateCode", text, communicated_via as "communicatedVia"`;

type Before = Record<string, unknown> | Record<string, unknown>[] | null;

/** Le colonne delle chiavi date, col nome della chiave: `select col as "key", ...`. */
function selectList(columns: Record<string, string>, keys: readonly string[]): string {
  return keys.map((key) => `${columns[key]} as "${key}"`).join(", ");
}

async function one(tx: Tx, sql: string, params: readonly (string | null)[]): Promise<Record<string, unknown> | null> {
  const [row] = await tx.query<Record<string, unknown>>(sql, params);
  return row ?? null;
}

/** Una riga figlia della visita per id; l'id che non è della visita lo rifiuta già `validateVisitOp`. */
function childById(tx: Tx, practiceId: string, visit: VisitRow, table: string, columns: string, id: string) {
  return one(tx, `select ${columns} from public.${table} where practice_id = $1 and visit_id = $2 and id = $3`, [
    practiceId,
    visit.id,
    id,
  ]);
}

/** I valori che l'operazione cambierà, com'erano prima della rettifica; `null` per una riga nuova. */
export async function readBefore(tx: Tx, practiceId: string, visit: VisitRow, op: VisitOp): Promise<Before> {
  switch (op.op) {
    case "campi": {
      const keys = Object.keys(op.values).filter((k) => op.values[k as keyof typeof op.values] !== undefined);
      if (keys.length === 0) return null;
      return one(tx, `select ${selectList(FIELD_COLUMNS, keys)} from public.visits where practice_id = $1 and id = $2`, [
        practiceId,
        visit.id,
      ]);
    }
    case "apertura": {
      const keys = Object.keys(op).filter((k) => k !== "op" && op[k as keyof typeof op] !== undefined);
      if (keys.length === 0) return null;
      return one(
        tx,
        `select ${selectList(OPENING_COLUMNS, keys)} from public.treatment_cycles where practice_id = $1 and id = $2`,
        [practiceId, visit.cycleId],
      );
    }
    case "risposta":
      return one(
        tx,
        `select answer, regions, sub_answers as "subAnswers", from_history as "fromHistory", note
           from public.visit_screening_answers
          where practice_id = $1 and visit_id = $2 and item_code = $3`,
        [practiceId, visit.id, op.itemCode],
      );
    case "esiti": {
      const rows = await tx.query<Record<string, unknown> & { family: string }>(
        `select family, suggested, outcome, local_contraindicated_regions as "localContraindicated",
                override_note as "overrideNote"
           from public.visit_screening_outcomes
          where practice_id = $1 and visit_id = $2`,
        [practiceId, visit.id],
      );
      if (rows.length === 0) return null;
      return FAMILIES.flatMap((family) => rows.filter((r) => r.family === family));
    }
    // Scrivono solo righe nuove ("no" sulle voci senza risposta) o non si rettificano.
    case "nessun_altra_voce":
    case "nessuna_variazione":
      return null;
    case "psfs":
      return one(tx, "select score from public.psfs_scores where practice_id = $1 and item_id = $2 and visit_id = $3", [
        practiceId,
        op.itemId,
        visit.id,
      ]);
    case "disfunzione":
    case "togli_disfunzione":
      return one(
        tx,
        `select ${FINDING_COLUMNS} from public.visit_region_findings where practice_id = $1 and visit_id = $2 and region = $3`,
        [practiceId, visit.id, op.region],
      );
    case "test": {
      const row = await findTestRow(tx, practiceId, visit, op);
      return row ? childById(tx, practiceId, visit, "visit_test_results", TEST_COLUMNS, row.id) : null;
    }
    case "togli_test":
      return childById(tx, practiceId, visit, "visit_test_results", TEST_COLUMNS, op.resultId);
    case "tecnica": {
      const row = await findTreatment(tx, practiceId, visit, op);
      return row ? childById(tx, practiceId, visit, "visit_treatments", TREATMENT_COLUMNS, row.id) : null;
    }
    case "togli_tecnica":
      return childById(tx, practiceId, visit, "visit_treatments", TREATMENT_COLUMNS, op.treatmentId);
    case "consiglio": {
      const row = await findAdvice(tx, practiceId, visit, op);
      return row ? childById(tx, practiceId, visit, "visit_advice", ADVICE_COLUMNS, row.id) : null;
    }
    case "togli_consiglio":
      return childById(tx, practiceId, visit, "visit_advice", ADVICE_COLUMNS, op.adviceId);
    case "conferma": {
      if (op.target === "tutti") {
        return { copiedRows: await copiedRowsCount(tx, practiceId, visit.id) };
      }
      const table = { findings: "visit_region_findings", tests: "visit_test_results", treatments: "visit_treatments" }[
        op.target.table
      ];
      return childById(tx, practiceId, visit, table, "copied", op.target.id);
    }
    default: {
      const unknown: never = op;
      throw new Error(`Operazione sulla visita sconosciuta: ${String((unknown as { op?: unknown }).op)}`);
    }
  }
}

// Una voce cambiata una volta sola -----------------------------------------------------------------------

// La frase e le chiavi stanno in `src/lib`: la lista della rettifica nel client le usa uguali.
export { AMEND_TARGET_TWICE };

/** Le righe della visita prima della rettifica, con cui le chiavi risolvono gli id e la primaria di prima. */
async function targetRows(tx: Tx, practiceId: string, visit: VisitRow): Promise<AmendRows> {
  const params = [practiceId, visit.id];
  return {
    findings: await tx.query(
      `select id, region, is_primary as "isPrimary" from public.visit_region_findings
        where practice_id = $1 and visit_id = $2 order by region`,
      params,
    ),
    tests: await tx.query(
      `select id, test_code as "testCode", custom_label as "customLabel", side from public.visit_test_results
        where practice_id = $1 and visit_id = $2 order by id`,
      params,
    ),
    treatments: await tx.query(
      `select id, region, technique_code as "techniqueCode", custom_technique as "customTechnique"
         from public.visit_treatments where practice_id = $1 and visit_id = $2 order by id`,
      params,
    ),
    // In ordine di id, come `findAdvice`: senza `adviceId` vale la prima riga del modello.
    advice: await tx.query(
      `select id, template_code as "templateCode" from public.visit_advice
        where practice_id = $1 and visit_id = $2 order by id`,
      params,
    ),
  };
}

/**
 * Nessuna voce si scrive due volte nella stessa rettifica: così il "prima" letto
 * per tutte le operazioni prima della riga di `visit_amendments` (`changesFor`) è esatto, perché
 * nessuna operazione precedente della lista ha già cambiato il bersaglio. `esiti` dopo una `risposta`
 * resta ammesso: sono voci diverse. Le chiavi sono quelle di `amendTargets`
 * (`src/lib/visits/amend-targets.ts`), più il titolo del ciclo che un'`apertura` rigenera.
 */
export async function requireUniqueTargets(tx: Tx, practiceId: string, visit: VisitRow, ops: readonly VisitOp[]): Promise<void> {
  const rows = await targetRows(tx, practiceId, visit);
  const seen = new Set<string>();
  for (const op of ops) {
    const keys = amendTargets(op, rows);
    if (op.op === "apertura" && (await openingTitleChange(tx, practiceId, visit.cycleId, op))) keys.push("ciclo:title");
    for (const key of keys) {
      if (seen.has(key)) throw new DomainError(AMEND_TARGET_TWICE);
      seen.add(key);
    }
  }
}

/** Una voce di `visit_amendments.changes`. */
export interface Change {
  op: VisitOp["op"];
  before: unknown;
  after: unknown;
}

/**
 * Le voci di `changes` per un'operazione: la sua (prima e dopo) e quelle delle scritture che fa fuori dal
 * suo bersaglio, perché la rettifica sia la traccia esatta della visita chiusa.
 * Si leggono tutte prima di scrivere, sullo stato prima della rettifica: è esatto perché
 * `requireUniqueTargets` ha già rifiutato due operazioni sulla stessa voce.
 * - `disfunzione` primaria che toglie la primaria a un'altra regione: una seconda voce `disfunzione` con
 *   la riga di quella regione, prima e dopo (`isPrimary` false).
 * - `apertura` con la regione principale su un titolo generato: `title` nel prima e nel dopo della voce.
 */
export async function changesFor(tx: Tx, practiceId: string, visit: VisitRow, op: VisitOp): Promise<Change[]> {
  const main: Change = { op: op.op, before: await readBefore(tx, practiceId, visit, op), after: afterOf(op) };
  if (op.op === "apertura") {
    const title = await openingTitleChange(tx, practiceId, visit.cycleId, op);
    if (title) {
      main.before = { ...((main.before as Record<string, unknown> | null) ?? {}), title: title.before };
      main.after = { ...(main.after as Record<string, unknown>), title: title.after };
    }
    return [main];
  }
  if (op.op === "disfunzione" && op.isPrimary) {
    const demoted = await one(
      tx,
      `select ${FINDING_COLUMNS} from public.visit_region_findings
        where practice_id = $1 and visit_id = $2 and is_primary and region <> $3`,
      [practiceId, visit.id, op.region],
    );
    if (demoted) return [main, { op: "disfunzione", before: demoted, after: { ...demoted, isPrimary: false } }];
  }
  return [main];
}

/** Il "dopo" di una rettifica: i valori dell'operazione, senza il suo nome (che sta già in `op`). */
export function afterOf(op: VisitOp): Record<string, unknown> {
  if (op.op === "campi") return { ...op.values };
  return Object.fromEntries(Object.entries(op).filter(([key]) => key !== "op"));
}
