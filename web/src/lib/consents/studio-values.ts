import { firstLast } from "@/lib/format";
import type { PracticeSettingsView } from "@/server/domain/settings/queries";
import { type ConsentValues, renderConsentBody } from "./render";
import type { ModuleKey } from "./required";

export type StudioConsentSettings = Pick<PracticeSettingsView,
  "practiceName" | "addressLine" | "postalCode" | "city" | "province" | "phone" | "email" | "pec"
  | "practitionerFirstName" | "practitionerLastName" | "registrationKind" | "registrationOrder" | "registrationNumber" | "registrationProvince"
  | "insuranceCompany" | "insurancePolicyNumber" | "insuranceLimitCents">;

/**
 * I segnaposto dello studio, dell'osteopata, della polizza, del listino e del documento. Unica fonte per
 * l'anteprima di Impostazioni e per quella della raccolta: il testo mostrato è quello che il paziente firma.
 */
export function studioConsentValues(settings: StudioConsentSettings, services: readonly { kind: string; priceCents: number }[], today: string): ConsentValues {
  // L'ordine è il nome intero ("Ordine TSRM PSTRP di Bologna"): la frase del modulo non lo ripete né aggiunge la provincia.
  const registration = settings.registrationKind === "in_attesa" ? "in attesa di iscrizione" : settings.registrationKind === "nessuna" ? "nessuna iscrizione" : settings.registrationOrder && settings.registrationNumber
    ? `${settings.registrationKind === "ese" ? "iscrizione all'elenco speciale ad esaurimento degli osteopati" : "iscrizione all'albo"} presso l'${settings.registrationOrder}, n. ${settings.registrationNumber}` : null;
  const price = (kind: string) => services.find(s => s.kind === kind)?.priceCents.toString() ?? null;
  return {
    "studio.nome": settings.practiceName, "studio.indirizzo": [settings.addressLine, settings.postalCode, settings.city, settings.province].filter(Boolean).join(", "),
    "studio.telefono": settings.phone, "studio.email": settings.email, "studio.pec": settings.pec,
    "osteopata.nome_completo": firstLast({ firstName: settings.practitionerFirstName, lastName: settings.practitionerLastName }), "osteopata.iscrizione": registration,
    "polizza.compagnia": settings.insuranceCompany, "polizza.numero": settings.insurancePolicyNumber, "polizza.massimale": settings.insuranceLimitCents?.toString() ?? null,
    "listino.prima_visita": price("prima_visita"), "listino.seduta": price("seduta"), "listino.controllo": price("controllo"),
    "documento.data": today, "documento.luogo": settings.city,
  };
}

/** La bozza degli anni di conservazione, se è un valore che si potrebbe salvare (intero da 1 a 30); altrimenti null. */
export function retentionDraftValue(draft: string): string | null {
  const value = Number(draft);
  return draft.trim() && Number.isInteger(value) && value >= 1 && value <= 30 ? String(value) : null;
}

/** Il corpo del modulo come in Impostazioni: una bozza non valida resta un vuoto, come ogni dato mancante. */
export function settingsConsentPreview(moduleKey: ModuleKey, values: ConsentValues, retentionDraft: string): string {
  return renderConsentBody(moduleKey, { ...values, "conservazione.anni": retentionDraftValue(retentionDraft) }).text;
}
