import { createHash } from "node:crypto";
import { CONSENT_MODULES } from "@/lib/consents/modules";
import { type ConsentRendered, type ConsentValues, numberPoints, renderConsent } from "@/lib/consents/render";
import { studioConsentValues } from "@/lib/consents/studio-values";
import { consentFitsAge, type ModuleKey } from "@/lib/consents/required";
import { dayField, firstLast, isMinor } from "@/lib/format";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { getRegistry } from "@/server/domain/patients/card";
import { listActiveServices } from "@/server/domain/services/queries";
import { getPracticeSettings } from "@/server/domain/settings/queries";
import { type ConsentFields, type ConsentTarget, ConsentTargetSchema } from "./schemas";

export type ConsentPreview = {
  target: ConsentTarget; rendered: ConsentRendered; hash: string; version: string;
  signerName: string; signerKind: "paziente" | "genitore" | "tutore";
  minorOpinionDefault: string | null; missingLinks: { key: string; label: string; href: string }[];
  practitionerSignatureFileId: string | null; demo: boolean; place: string;
};

/** Le etichette italiane dei segnaposto: per i link dei mancanti e per «Firmato con dati mancanti» nel PDF. */
export const LABELS: Record<string, string> = {
  "studio.nome": "nome dello studio", "studio.indirizzo": "indirizzo dello studio", "studio.telefono": "telefono dello studio",
  "studio.email": "email dello studio", "studio.pec": "PEC dello studio", "osteopata.nome_completo": "nome dell'osteopata",
  "osteopata.iscrizione": "iscrizione dell'osteopata", "polizza.compagnia": "compagnia assicurativa", "polizza.numero": "numero di polizza",
  "polizza.massimale": "massimale della polizza", "paziente.nome_completo": "nome del paziente", "paziente.data_nascita": "data di nascita del paziente",
  "paziente.luogo_nascita": "luogo di nascita del paziente", "paziente.codice_fiscale": "codice fiscale del paziente",
  "paziente.indirizzo": "indirizzo del paziente", "paziente.medico_curante": "medico curante", "paziente.medico_inviante": "medico inviante",
  "genitore.nome_completo": "nome del genitore o tutore", "genitore.codice_fiscale": "codice fiscale del genitore o tutore",
  "listino.prima_visita": "prezzo della prima visita", "listino.seduta": "prezzo della seduta", "listino.controllo": "prezzo del controllo",
  "conservazione.anni": "anni di conservazione", "documento.data": "data del documento", "documento.luogo": "luogo del documento",
};

/**
 * Rilegge nello stesso tx anagrafica, legami, impostazioni e listino. Non scrive eventi.
 * Chiave, firmatario e voce del minore seguono l'età al giorno della firma: oggi per la tela,
 * il giorno dichiarato per un documento caricato (la stessa regola di loadValidConsents).
 */
export async function getConsentPreview(tx: Tx, practiceId: string, clock: Clock, input: ConsentTarget, signedOn: string = clock.today()): Promise<ConsentPreview | null> {
  const target = ConsentTargetSchema.parse({ patientId: input.patientId, appointmentId: input.appointmentId, guardianId: input.guardianId, moduleKey: input.moduleKey, cycleId: input.cycleId });
  const patient = await getRegistry(tx, practiceId, target.patientId);
  const settings = await getPracticeSettings(tx, practiceId);
  if (!patient || !settings) return null;
  if (target.cycleId !== null) {
    const [cycle] = await tx.query("select id from public.treatment_cycles where practice_id=$1 and id=$2 and patient_id=$3 and status='open'", [practiceId, target.cycleId, target.patientId]);
    if (!cycle) return null;
  }
  if (target.appointmentId !== null) {
    const [appointment] = await tx.query<{ cycleId: string }>("select cycle_id as \"cycleId\" from public.appointments where practice_id=$1 and id=$2 and patient_id=$3", [practiceId, target.appointmentId, target.patientId]);
    if (!appointment || (target.cycleId !== null && appointment.cycleId !== target.cycleId)) return null;
  }
  const birth = patient.personali.birthDate;
  const onDay = signedOn < birth ? birth : signedOn;
  const minor = isMinor(birth, onDay);
  if (!consentFitsAge(target.moduleKey, birth, signedOn)) return null;
  const guardian = patient.guardians.find(g => g.id === target.guardianId);
  if (target.guardianId !== null && (!guardian || (guardian.relationship !== "tutore" && (!minor || !guardian.hasParentalAuthority || !["madre", "padre"].includes(guardian.relationship))))) return null;
  if (minor && !guardian) return null;
  const signerKind: ConsentPreview["signerKind"] = guardian ? guardian.relationship === "tutore" ? "tutore" : "genitore" : "paziente";
  const signerName = guardian ? firstLast(guardian) : firstLast(patient.personali);
  const [extra] = await tx.query<{ retention: number; signature: string | null }>("select retention_years as retention, practitioner_signature_file_id as signature from public.practice_settings where practice_id=$1", [practiceId]);
  if (!extra) return null;
  if (extra.signature !== null) {
    const [file] = await tx.query("select id from public.files where practice_id=$1 and id=$2 and kind='signature' and mime_type='image/png'", [practiceId, extra.signature]);
    if (!file) return null;
  }
  const services = await listActiveServices(tx, practiceId);
  const physicians = await tx.query<{ id: string; fullName: string }>("select id, full_name as \"fullName\" from public.physicians where practice_id=$1 and id=any($2::uuid[])", [practiceId, [patient.medici.gpPhysicianId, patient.medici.defaultReferringPhysicianId].filter(Boolean)]);
  const physician = (id: string) => physicians.find(p => p.id === id)?.fullName ?? null;
  const place = settings.city?.trim() || "________";
  const values: ConsentValues = {
    ...studioConsentValues(settings, services, clock.today()),
    "paziente.nome_completo": firstLast(patient.personali), "paziente.data_nascita": birth, "paziente.luogo_nascita": patient.personali.birthPlace,
    "paziente.codice_fiscale": patient.personali.taxCode, "paziente.indirizzo": [patient.indirizzo.addressLine, patient.indirizzo.postalCode, patient.indirizzo.city, patient.indirizzo.province].filter(Boolean).join(", "),
    "paziente.medico_curante": physician(patient.medici.gpPhysicianId), "paziente.medico_inviante": physician(patient.medici.defaultReferringPhysicianId),
    "genitore.nome_completo": guardian ? firstLast(guardian) : null, "genitore.codice_fiscale": guardian?.taxCode ?? null,
    "conservazione.anni": String(extra.retention),
  };
  const rendered = renderConsent(target.moduleKey, values);
  if (!settings.city?.trim() && !rendered.missingFields.includes("documento.luogo")) rendered.missingFields.push("documento.luogo");
  const years = Number(onDay.slice(0, 4)) - Number(birth.slice(0, 4)) - (onDay.slice(5) < birth.slice(5) ? 1 : 0);
  const snapshot = { target, rendered, version: CONSENT_MODULES[target.moduleKey].version, signerName, signerKind, minorOpinionDefault: target.moduleKey === "trattamento_minore" && years < 6 ? "Non applicabile per l'età" : null, practitionerSignatureFileId: extra.signature, demo: settings.isDemo, place };
  const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const missingLinks = rendered.missingFields.map(key => ({ key, label: LABELS[key] ?? key, href: key.startsWith("paziente.") || key.startsWith("genitore.") ? `/pazienti/${target.patientId}?tab=anagrafica` : key.startsWith("listino.") ? "/listino" : key.startsWith("polizza.") || key === "osteopata.iscrizione" ? "/impostazioni/iscrizione-e-polizza" : key === "conservazione.anni" ? "/impostazioni/consensi" : "/impostazioni/studio" }));
  if (extra.signature === null) missingLinks.push({ key: "osteopata.firma", label: "firma dell'osteopata", href: "/impostazioni/consensi" });
  return { ...snapshot, hash, missingLinks };
}

const SINGLE_GUARDIAN = "Io sottoscritto/a dichiaro che l'altro genitore è informato e d'accordo, oppure che esercito da solo/a la responsabilità genitoriale.";

/** Indicazioni per l'interfaccia scritte nel catalogo: escono dal documento firmato. */
const HINTS: Readonly<Record<ModuleKey, readonly { fragment: string; by: (fields: ConsentFields) => string }[]>> = {
  informativa: [{ fragment: ' Poi due scelte separate, non preselezionate, con "Sì" e "No": ', by: () => " " }],
  trattamento: [],
  trattamento_minore: [
    { fragment: " Secondo genitore (facoltativo): nome e firma.", by: () => "" },
    { fragment: ' Campo note. Sotto i 6 anni "Non applicabile per l\'età", modificabile.', by: () => "" },
    // Fuori elenco già nell'anteprima (numberPoints): qui passa nel blocco firmato, i punti restano in fila.
    { fragment: `\n\nDichiarazione sull'altro genitore (se firma uno solo). "${SINGLE_GUARDIAN}"\n\n`, by: () => "\n\n" },
    { fragment: ", eventuale secondo genitore", by: f => f.secondGuardianName ? ", firma del secondo genitore" : "" },
  ],
};

/** Un testo del catalogo cambiato non deve lasciare l'indicazione nel documento firmato: fallisce al caricamento. */
export function assertHintsInCatalog(catalog: Readonly<Record<ModuleKey, { body: string }>>): void {
  for (const key of Object.keys(HINTS) as ModuleKey[]) {
    const body = numberPoints(key, catalog[key].body);
    for (const { fragment } of HINTS[key]) {
      if (!body.includes(fragment)) throw new Error(`Indicazione non trovata nel modulo ${key}: ${fragment}`);
    }
  }
}
assertHintsInCatalog(CONSENT_MODULES);

/** Fotografia pura, condivisa con il seed: istruzioni UI fuori dal documento firmato. */
export function freezeConsent(preview: ConsentPreview, fields: ConsentFields, signedOn: string, signedAt: string | null): ConsentRendered {
  let text = preview.rendered.text;
  for (const { fragment, by } of HINTS[fields.moduleKey]) text = text.replace(fragment, () => by(fields));
  // La data dell'anteprima è oggi; quella del caricamento è il giorno dichiarato.
  // La riga conclusiva è unica, anche nei moduli che hanno già data e luogo nel corpo.
  if (fields.moduleKey !== "informativa") {
    const end = text.lastIndexOf(`, ${preview.place}`);
    const start = end - 10;
    if (start >= 0 && /^\d{2}\/\d{2}\/\d{4}$/.test(text.slice(start, end))) {
      // "{data}, {luogo}, firma del genitore" diventa "Firma del genitore": la frase riparte dopo la citazione.
      const rest = text.slice(end + preview.place.length + 3).trimStart();
      text = text.slice(0, start) + rest.charAt(0).toUpperCase() + rest.slice(1);
    }
  }
  const lines: string[] = [];
  if (fields.outcome === "rifiuta") lines.push("Esito: rifiuta il trattamento.");
  if (fields.refusesInformation && fields.refusalNote) lines.push(`Non desidera ricevere alcune informazioni: ${fields.refusalNote}`);
  if (fields.trusteeName || fields.trusteeContact) lines.push(`Persona indicata per ricevere le informazioni: ${[fields.trusteeName, fields.trusteeContact].filter(Boolean).join(", ")}`);
  if (fields.choices) lines.push(`Promemoria e comunicazioni su WhatsApp: ${fields.choices.whatsapp ? "Sì" : "No"}`, `Ricontatto per i controlli periodici: ${fields.choices.richiami ? "Sì" : "No"}`);
  if (fields.minorOpinionNote) lines.push(`Voce del minore: ${fields.minorOpinionNote}`);
  if (fields.moduleKey === "trattamento_minore" && fields.singleGuardianDeclaration && !fields.secondGuardianName) lines.push(SINGLE_GUARDIAN);
  if (fields.secondGuardianName) lines.push(`Secondo genitore: ${fields.secondGuardianName}`);
  if (fields.notes) lines.push(`Note: ${fields.notes}`);
  lines.push(`${dayField(signedOn)}, ${preview.place}`);
  // L'istante completo resta nella colonna signed_at e sarà stampato dal PDF del consenso.
  void signedAt;
  return { text: `${text}\n\n${lines.join("\n")}`, missingFields: [...preview.rendered.missingFields] };
}
