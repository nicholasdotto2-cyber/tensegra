import { z } from "zod";
import { REGION_CODES, type RegionCode } from "@/lib/clinical/catalog";

// I parametri dell'URL della lista dei pazienti e della scheda.
// Un valore che non conosciamo torna al predefinito, mai un errore: l'URL si
// scrive anche a mano. Sicuro per il client: nessun import dal server.

export type PatientFilter =
  | "tutti"
  | "in_ciclo"
  | "da_richiamare"
  | "consensi_mancanti"
  | "senza_prossimo_passo"
  | "archiviati";

/** I filtri della lista, nell'ordine della barra. */
export const PATIENT_FILTERS: readonly { code: PatientFilter; label: string }[] = [
  { code: "tutti", label: "Tutti" },
  { code: "in_ciclo", label: "In ciclo" },
  { code: "da_richiamare", label: "Da richiamare" },
  { code: "consensi_mancanti", label: "Consensi mancanti" },
  { code: "senza_prossimo_passo", label: "Senza prossimo passo" },
  { code: "archiviati", label: "Archiviati" },
];

export interface PatientListParams {
  /** Il testo cercato, come è scritto: la lista lo usa senza spazi ai lati. */
  q: string;
  filtro: PatientFilter;
  ordina: "paziente" | "prossimo";
  verso: "asc" | "desc";
}

export type PatientTab = "riepilogo" | "cartella" | "appuntamenti" | "consensi" | "fatture" | "messaggi" | "anagrafica";
export type CartellaView = "cronologia" | "test" | "foto";

const TABS: readonly PatientTab[] = ["riepilogo", "cartella", "appuntamenti", "consensi", "fatture", "messaggi", "anagrafica"];
const VIEWS: readonly CartellaView[] = ["cronologia", "test", "foto"];
const SORTS: readonly PatientListParams["ordina"][] = ["paziente", "prossimo"];
const DIRECTIONS: readonly PatientListParams["verso"][] = ["asc", "desc"];
const FILTER_CODES: readonly PatientFilter[] = PATIENT_FILTERS.map((f) => f.code);

const DEFAULT_TAB: PatientTab = "riepilogo";
const DEFAULT_VIEW: CartellaView = "cronologia";

type SearchParams = Record<string, string | string[] | undefined>;

/** Il primo valore di un parametro: `?q=a&q=b` vale "a". */
function first(sp: SearchParams, key: string): string | undefined {
  const value = sp[key];
  return Array.isArray(value) ? value[0] : value;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === value) ?? fallback;
}

export function parsePatientListParams(sp: SearchParams): PatientListParams {
  return {
    q: first(sp, "q") ?? "",
    filtro: oneOf(first(sp, "filtro"), FILTER_CODES, "tutti"),
    ordina: oneOf(first(sp, "ordina"), SORTS, "paziente"),
    verso: oneOf(first(sp, "verso"), DIRECTIONS, "asc"),
  };
}

const cycleId = z.uuid();

/** La tab della scheda, la sotto-vista della Cartella e i filtri «Ciclo» e «Regione» dei test nel tempo. */
export function parsePatientTabParams(sp: SearchParams): {
  tab: PatientTab;
  vista: CartellaView;
  ciclo: string | null;
  regione: RegionCode | null;
} {
  const ciclo = cycleId.safeParse(first(sp, "ciclo"));
  return {
    tab: oneOf(first(sp, "tab"), TABS, DEFAULT_TAB),
    vista: oneOf(first(sp, "vista"), VIEWS, DEFAULT_VIEW),
    ciclo: ciclo.success ? ciclo.data : null,
    regione: REGION_CODES.find((r) => r === first(sp, "regione")) ?? null,
  };
}

/**
 * Il link alla scheda: "/pazienti/x?tab=cartella&vista=test". I valori predefiniti non si scrivono; i filtri
 * «Ciclo» e «Regione» dei test nel tempo, se ci sono, vengono dopo la vista.
 */
export function patientHref(
  id: string,
  p: Partial<{ tab: PatientTab; vista: CartellaView; ciclo: string | null; regione: RegionCode | null }> = {},
): string {
  const query = new URLSearchParams();
  if (p.tab !== undefined && p.tab !== DEFAULT_TAB) query.set("tab", p.tab);
  if (p.vista !== undefined && p.vista !== DEFAULT_VIEW) query.set("vista", p.vista);
  if (p.ciclo) query.set("ciclo", p.ciclo);
  if (p.regione) query.set("regione", p.regione);
  const search = query.toString();
  return `/pazienti/${encodeURIComponent(id)}${search === "" ? "" : `?${search}`}`;
}
