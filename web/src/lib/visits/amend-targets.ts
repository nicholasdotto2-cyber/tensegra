import { SCREENING_ITEMS } from "@/lib/clinical/catalog";
import { measureKey } from "@/lib/clinical/compare";

// Le voci che un'operazione di rettifica scrive, in un solo
// posto per il server e il client: `requireUniqueTargets` (visits/ops/before.ts) rifiuta una rettifica che scrive due
// volte la stessa voce, e la lista della rettifica nel client (`amend-list.ts`) usa le stesse chiavi per non mandarne
// mai una così. Gli id delle righe si risolvono sulle righe della visita prima della rettifica (`AmendRows`): il server
// le legge dalle tabelle, il client dalla vista della visita chiusa. Le scritture fuori dal bersaglio contano come voci:
// la primaria tolta a un'altra regione, e «Nessun'altra voce», che scrive le voci del suo gruppo. Il titolo del ciclo
// rigenerato da `apertura` lo aggiunge il server (dipende dal ciclo nel database); nel client `apertura` è sempre una
// sola operazione.

/** Un'operazione sulla visita come la mandano le sezioni o come l'ha letta lo schema (`VisitOp`). */
export type AmendOp = Readonly<Record<string, unknown>> & { readonly op: string };

/** Le righe della visita con cui si risolvono gli id e la primaria di prima. */
export interface AmendRows {
  findings: readonly { id: string; region: string; isPrimary: boolean }[];
  tests: readonly { id: string; testCode: string; customLabel: string | null; side: string | null }[];
  treatments: readonly { id: string; region: string; techniqueCode: string; customTechnique: string | null }[];
  /** In ordine di id dentro lo stesso modello: senza `adviceId` vale la prima del modello, come `findAdvice`. */
  advice: readonly { id: string; templateCode: string | null }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Le chiavi date (non `undefined`) di un oggetto. */
export const definedKeys = (values: Readonly<Record<string, unknown>>, skip?: string): string[] =>
  Object.keys(values).filter((key) => key !== skip && values[key] !== undefined);

/** Una tecnica: regione, tecnica e nome di «Altra tecnica» senza maiuscole (l'indice unico di `visit_treatments`). */
export const treatmentTarget = (row: Readonly<Record<string, unknown>>): string =>
  `tecnica:${text(row.region) ?? ""}:${text(row.techniqueCode) ?? ""}:${(text(row.customTechnique) ?? "").trim().toLowerCase()}`;

/** Un test per lato (`measureKey`). */
export const testTarget = (row: Readonly<Record<string, unknown>>): string =>
  `test:${measureKey({
    testCode: text(row.testCode) ?? "",
    customLabel: text(row.customLabel),
    side: (text(row.side) as "dx" | "sx" | null) ?? null,
  })}`;

/** La riga di consiglio che l'operazione scrive: quella con `adviceId`, altrimenti la prima del modello. */
export function adviceRowOf<T extends AmendRows["advice"][number]>(op: AmendOp, advice: readonly T[]): T | undefined {
  const adviceId = text(op.adviceId);
  return advice.find((a) => a.templateCode === op.templateCode && (adviceId === null || a.id === adviceId));
}

/** Le voci che l'operazione scrive; la prima è la sua riga (`mainTarget`), tranne per «Nessun'altra voce». */
export function amendTargets(op: AmendOp, rows: AmendRows): string[] {
  switch (op.op) {
    case "campi":
      return isRecord(op.values) ? definedKeys(op.values).map((k) => `campo:${k}`) : [];
    case "apertura":
      return definedKeys(op, "op").map((k) => `ciclo:${k}`);
    case "risposta":
      return [`risposta:${text(op.itemCode) ?? ""}`];
    case "nessun_altra_voce":
      return SCREENING_ITEMS.filter((i) => i.group === op.group).map((i) => `risposta:${i.code}`);
    case "esiti":
      return ["esiti"];
    case "nessuna_variazione":
      return ["nessuna_variazione"];
    case "psfs":
      return [`psfs:${text(op.itemId) ?? ""}`];
    case "disfunzione": {
      const region = text(op.region) ?? "";
      const keys = [`disfunzione:${region}`];
      if (op.isPrimary === true) {
        // La primaria è una sola per visita: due operazioni primarie si toglierebbero a vicenda,
        // e la primaria tolta a un'altra regione è una scrittura su quella regione.
        keys.push("disfunzione:primaria");
        const demoted = rows.findings.find((f) => f.isPrimary && f.region !== region);
        if (demoted) keys.push(`disfunzione:${demoted.region}`);
      }
      return keys;
    }
    case "togli_disfunzione":
      return [`disfunzione:${text(op.region) ?? ""}`];
    case "test":
      return [testTarget(op)];
    case "togli_test": {
      const row = rows.tests.find((t) => t.id === op.resultId);
      return [row ? testTarget(row) : `test-id:${text(op.resultId) ?? ""}`];
    }
    case "tecnica":
      return [treatmentTarget(op)];
    case "togli_tecnica": {
      const row = rows.treatments.find((t) => t.id === op.treatmentId);
      return [row ? treatmentTarget(row) : `tecnica-id:${text(op.treatmentId) ?? ""}`];
    }
    case "consiglio": {
      const row = adviceRowOf(op, rows.advice);
      return [row ? `consiglio:${row.id}` : `consiglio-modello:${text(op.templateCode) ?? ""}`];
    }
    case "togli_consiglio":
      return [`consiglio:${text(op.adviceId) ?? ""}`];
    case "conferma": {
      if (!isRecord(op.target)) return ["conferma:tutti"];
      const { table, id } = op.target;
      if (table === "tests") {
        const row = rows.tests.find((t) => t.id === id);
        return [row ? testTarget(row) : `test-id:${text(id) ?? ""}`];
      }
      if (table === "treatments") {
        const row = rows.treatments.find((t) => t.id === id);
        return [row ? treatmentTarget(row) : `tecnica-id:${text(id) ?? ""}`];
      }
      const finding = rows.findings.find((f) => f.id === id);
      return [finding ? `disfunzione:${finding.region}` : `disfunzione-id:${text(id) ?? ""}`];
    }
    default:
      return [`operazione:${op.op}`];
  }
}

/**
 * La riga che l'operazione riscrive: due operazioni con la stessa famiglia (`familyOf`) e la stessa riga sono la stessa
 * modifica detta due volte. «Nessun'altra voce» ha come riga il suo gruppo.
 */
export function mainTarget(op: AmendOp, rows: AmendRows): string {
  if (op.op === "nessun_altra_voce") return `gruppo:${text(op.group) ?? ""}`;
  return amendTargets(op, rows)[0] ?? `operazione:${op.op}`;
}

const FAMILY: Readonly<Record<string, string>> = {
  togli_disfunzione: "disfunzione",
  togli_test: "test",
  togli_tecnica: "tecnica",
  togli_consiglio: "consiglio",
};

/** La famiglia dell'operazione: scrivere una riga e toglierla sono la stessa famiglia. */
export const familyOf = (op: AmendOp): string => FAMILY[op.op] ?? op.op;
