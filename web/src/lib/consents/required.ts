// Moduli richiesti per un appuntamento: l'informativa una volta per paziente,
// il consenso al trattamento per ciclo; per un minore il consenso del genitore (`trattamento_minore`).
// L'età si valuta alla data dell'appuntamento e all'apertura del ciclo. Sicuro per il client: nessun
// import dal server.

import { isMinor } from "@/lib/format";

export type ModuleKey = "informativa" | "trattamento" | "trattamento_minore";

/** Solo la chiave coerente con l'età alla firma può decidere la validità del trattamento. */
export function consentFitsAge(key: ModuleKey, birthDate: string, signedOn: string): boolean {
  if (key === "informativa") return true;
  const minor = isMinor(birthDate, signedOn < birthDate ? birthDate : signedOn);
  return key === (minor ? "trattamento_minore" : "trattamento");
}

/** I consensi validi di un paziente: riga `valido` con esito `accetta`, il trattamento per ciclo. */
export interface ValidConsents {
  informativa: boolean;
  /** Per id del ciclo, i moduli al trattamento validi. */
  treatment: ReadonlyMap<string, ReadonlySet<"trattamento" | "trattamento_minore">>;
}

/** I moduli che mancano per un appuntamento del ciclo, nell'ordine informativa e poi trattamento. */
export function missingModules(
  c: ValidConsents | undefined,
  cycleId: string,
  minorAtAppointment: boolean,
  minorAtCycleOpening: boolean,
): ModuleKey[] {
  const treatmentKey = minorAtAppointment ? "trattamento_minore" : "trattamento";
  const missing: ModuleKey[] = [];
  if (!c?.informativa) missing.push("informativa");
  const treatment = c?.treatment.get(cycleId);
  if (!treatment?.has(treatmentKey) && !(minorAtCycleOpening && treatment?.has("trattamento_minore"))) {
    missing.push(treatmentKey);
  }
  return missing;
}

/** Il nome di ogni modulo, come lo mostrano Oggi e la scheda del paziente. */
export const MODULE_LABEL: Record<ModuleKey, string> = {
  informativa: "Informativa",
  trattamento: "Consenso al trattamento",
  trattamento_minore: "Consenso del genitore",
};

const TREATMENT_TEXT = { adult: MODULE_LABEL.trattamento, minor: MODULE_LABEL.trattamento_minore } as const;
const BOTH_TEXT = {
  adult: "Informativa e consenso al trattamento",
  minor: "Informativa e consenso del genitore",
} as const;

/** Cosa manca, come lo mostra "Consensi mancanti": "Informativa e consenso del genitore"; "" se non manca niente. */
export function missingText(missing: readonly ModuleKey[], minor: boolean): string {
  const age = minor ? "minor" : "adult";
  const informativa = missing.includes("informativa");
  const treatment = missing.some((m) => m !== "informativa");
  if (informativa && treatment) return BOTH_TEXT[age];
  if (informativa) return MODULE_LABEL.informativa;
  if (treatment) return TREATMENT_TEXT[age];
  return "";
}
