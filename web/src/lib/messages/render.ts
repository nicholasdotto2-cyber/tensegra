import { templateProblem, type TemplateKey } from "./templates";

export type MessageValues = Record<string, string | null>;
export type MissingMessage = { key: string; message: string; href: string };

/** Compila una sola volta: eventuali graffe nei dati restano testo letterale. */
export function renderMessage(key: TemplateKey, template: string, values: MessageValues): { text: string; missing: string[] } {
  const problem = templateProblem(key, template);
  if (problem) throw new RangeError(problem);
  const missing = new Set<string>();
  const text = template.replace(/\{([^{}]+)\}/g, (_placeholder, name: string) => {
    const value = values[name];
    // I due prefissi sono intenzionalmente vuoti per l'adulto e conservano lo spazio iniziale.
    if (value === "" && (name === "per_paziente" || name === "di_paziente")) return "";
    if (value == null || !value.trim()) {
      missing.add(name);
      return "";
    }
    return value;
  });
  return { text, missing: [...missing] };
}

const MISSING: Readonly<Record<string, { message: string; href: string }>> = {
  indirizzo: { message: "Manca l'indirizzo dello studio", href: "/impostazioni/studio" },
  studio: { message: "Manca il nome dello studio", href: "/impostazioni/studio" },
  telefono_studio: { message: "Manca il telefono dello studio", href: "/impostazioni/studio" },
  osteopata: { message: "Manca il nome dell'osteopata", href: "/impostazioni/studio" },
  quando: { message: "Manca la data dell'appuntamento", href: "/agenda" },
  ora: { message: "Manca l'ora dell'appuntamento", href: "/agenda" },
  durata: { message: "Manca la durata dell'appuntamento", href: "/agenda" },
  // Non è un segnaposto: il link di un modello salvato che non si compila (il perché è copyDisabledReason).
  modello: { message: "Correggi il modello in Impostazioni, Messaggi", href: "/impostazioni/messaggi" },
};

/** patientId deve provenire dalla sorgente autorizzata sul server. */
export function missingMessage(key: string, patientId: string): MissingMessage {
  const patientHref = `/pazienti/${patientId}?tab=anagrafica`;
  if (key === "nome") return { key, message: "Manca il nome del destinatario", href: patientHref };
  if (key === "per_paziente" || key === "di_paziente") return { key, message: "Manca il nome del paziente", href: patientHref };
  // L'ultima seduta fatta sta negli appuntamenti della scheda, i consigli nella cartella.
  if (key === "settimane") return { key, message: "Manca la data dell'ultima seduta", href: `/pazienti/${patientId}?tab=appuntamenti` };
  if (key === "consigli") return { key, message: "Mancano i consigli della visita", href: `/pazienti/${patientId}?tab=cartella` };
  const entry = MISSING[key];
  if (!entry) throw new RangeError(`Segnaposto non riconosciuto: {${key}}.`);
  return { key, ...entry };
}
