import { dayField, money } from "@/lib/format";
import { CONSENT_MODULES } from "./modules";
import type { ModuleKey } from "./required";

/** Chiavi senza graffe; date ISO AAAA-MM-GG e importi in centesimi interi come stringhe. */
export type ConsentValues = Record<string, string | null>;
export type ConsentRendered = { text: string; missingFields: string[] };

const OPTIONAL_DEFAULTS: Readonly<Record<string, string>> = {
  "paziente.medico_inviante": "accesso diretto",
  "studio.pec": "non indicata",
};
const MONEY_FIELDS = new Set(["listino.prima_visita", "listino.seduta", "listino.controllo", "polizza.massimale"]);
const DAY_FIELDS = new Set(["paziente.data_nascita", "documento.data"]);

/** Anteprima pura: segnala i mancanti senza decidere se sia possibile firmare. */
export function renderConsent(moduleKey: ModuleKey, values: ConsentValues): ConsentRendered {
  const { text: body, missingFields } = renderConsentBody(moduleKey, values);
  return {
    text: `${CONSENT_MODULES[moduleKey].title}\n\nTesto di esempio, da far verificare prima dell'uso con pazienti reali.\n\n${body}`,
    missingFields,
  };
}

/**
 * I paragrafi che nel testo firmato escono dall'elenco: la dichiarazione sull'altro genitore
 * va nel blocco firmato (freezeConsent). Prima della firma si leggono lo stesso, senza numero.
 */
const OUT_OF_LIST: Readonly<Partial<Record<ModuleKey, readonly string[]>>> = {
  trattamento_minore: ["Dichiarazione sull'altro genitore (se firma uno solo)."],
};

/**
 * L'unica numerazione dei moduli: i punti in fila, senza quelli fuori elenco. La leggono l'anteprima della
 * raccolta, quella di Impostazioni, la stampa senza firma e quindi il testo congelato.
 */
export function numberPoints(moduleKey: ModuleKey, body: string): string {
  let point = 0;
  return body.split("\n\n").map(part => {
    const rest = part.replace(/^\d+\. /, "");
    if (rest === part) return part;
    return OUT_OF_LIST[moduleKey]?.some(title => rest.startsWith(title)) ? rest : `${++point}. ${rest}`;
  }).join("\n\n");
}

/** Il solo corpo del modulo, senza titolo né avviso: per chi li mostra già altrove (Impostazioni). */
export function renderConsentBody(moduleKey: ModuleKey, values: ConsentValues): ConsentRendered {
  const form = CONSENT_MODULES[moduleKey];
  const missingFields = new Set<string>();
  // replace con callback percorre il solo modello originale: le graffe e i dollari
  // contenuti nei dati non diventano segnaposto né istruzioni di sostituzione.
  // La numerazione si fa sul modello, prima dei dati: un valore non diventa un punto.
  const body = numberPoints(moduleKey, form.body).replace(/\{([^{}]+)\}/g, (_placeholder, key: string) => {
    const value = values[key]?.trim();
    if (!value || (MONEY_FIELDS.has(key) && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))))) {
      if (OPTIONAL_DEFAULTS[key]) return OPTIONAL_DEFAULTS[key];
      missingFields.add(key);
      return "________";
    }
    if (MONEY_FIELDS.has(key)) return money(Number(value));
    if (DAY_FIELDS.has(key)) return dayField(value);
    return value;
  });
  return { text: body, missingFields: [...missingFields] };
}
