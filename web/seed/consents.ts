import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Band, WeekHours } from "@/lib/agenda/slots";
import { type ConsentValues, renderConsent } from "@/lib/consents/render";
import type { ModuleKey } from "@/lib/consents/required";
import { type StudioConsentSettings, studioConsentValues } from "@/lib/consents/studio-values";
import { toE164 } from "@/lib/phone";
import { DEMO_PRACTICE_ID } from "@/server/auth/actor";
import { addDaysRome, type Clock, fixedClock, romeDateTime } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import type { StoredFileInput } from "@/server/domain/attachments/commands";
import { recordChoice, signConsent, uploadConsent } from "@/server/domain/consents/commands";
import { type ConsentPreview, freezeConsent, getConsentPreview } from "@/server/domain/consents/preview";
import type { ConsentFields, ConsentTarget } from "@/server/domain/consents/schemas";
import { DEFAULT_SERVICES } from "@/server/domain/services/commands";
import { setPractitionerSignature } from "@/server/domain/settings/commands";
import { checkConsentUpload, checkSignaturePng, readVerified } from "@/server/files/consents";
import { type FileKind, storageKey, type StoredMime } from "@/server/files/keys";
import type { FileStore } from "@/server/files/store";
import { resolveDay, seedHours } from "./dates";
import { birthDateOf, PATIENTS, PHYSICIANS, type SeedPatient, STUDIO, taxCodeOf } from "./people";
import type { Seeded } from "./demo";

// I consensi della demo scritti dai comandi veri. Prima della transazione
// `prepareSeedConsentAssets` mette nello store la firma inventata dell'osteopata, una copia dell'altra firma
// inventata per ogni consenso su tela e il modulo demo per ogni caricamento di Lorenzo, e compila il testo che ogni modulo deve
// avere con i valori del seed. Nella transazione `seedConsentRecords` salva la firma dell'osteopata con il
// comando delle impostazioni, così ogni firma la congela, poi rilegge l'anteprima vera, confronta
// il testo congelato con quello preparato e chiama `signConsent` o `uploadConsent`: il PDF della tela nasce al
// primo «Scarica PDF».

const P = DEMO_PRACTICE_ID;
/** Il default di `practice_settings.retention_years` (10 anni): il seed non lo cambia. */
const RETENTION_YEARS = 10;
/** La revoca di Martina arriva la sera, all'ora dei promemoria. */
const REVOKED_AT = "18:00";

// Percorso dalla cartella web, come `supabase/` in open.ts: dentro il bundle di Next un `new URL(..., import.meta.url)`
// non è un URL di Node e `readFile` lo rifiuta.
function seedAsset(name: string): string {
  return join(process.cwd(), "seed", "assets", name);
}

const SIGNATURE_PNG = seedAsset("demo-signature.png");
/** Una seconda firma inventata, con un tratto diverso: nel PDF quella dell'osteopata non è la copia del paziente. */
const PRACTITIONER_PNG = seedAsset("demo-signature-osteopata.png");
const UPLOAD_PDF = seedAsset("modulo-firmato-demo.pdf");

/** Un consenso del seed: il testo che deve risultare dalla firma e il file già nello store. */
export type SeedConsentAsset = {
  /** `firstName + " " + lastName` del SeedPatient. */
  patientKey: string;
  moduleKey: ModuleKey;
  renderedText: string;
  renderedHash: string;
  /** Il PNG della tela; null per un modulo caricato. */
  signature: StoredFileInput | null;
  /** Il modulo firmato caricato; null per la tela. */
  document: StoredFileInput | null;
  /** I byte di `document`. */
  bytes: Uint8Array | null;
  /** I byte di `signature`. */
  signatureBytes: Uint8Array | null;
};

/** I file preparati prima della transazione: la firma dell'osteopata e un file per consenso. */
export type SeedConsentAssets = {
  /** La firma inventata dell'osteopata, salvata in Impostazioni prima delle raccolte. */
  practitionerSignature: StoredFileInput;
  consents: SeedConsentAsset[];
};

const keyOf = (p: { firstName: string; lastName: string }): string => `${p.firstName} ${p.lastName}`;
const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** L'informativa e il consenso al trattamento del ciclo, del minore se c'è un genitore. */
function modulesOf(patient: SeedPatient): readonly ModuleKey[] {
  return ["informativa", patient.contactGuardian ? "trattamento_minore" : "trattamento"];
}

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Gli orari che il seed salva (`seedHours`), come li rilegge `getOpeningHours`. */
function seedWeek(d0: string): WeekHours {
  const week: Record<keyof WeekHours, Band[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
  for (const day of seedHours(d0).days) {
    week[day.weekday as keyof WeekHours] = day.bands.map((band) => ({ opensMin: minutesOf(band.opens), closesMin: minutesOf(band.closes) }));
  }
  return week;
}

/** Le dichiarazioni del dialogo di firma: accetta, nessun rifiuto, le scelte dell'informativa, la fiduciaria di Giorgio. */
function declarationsOf(patient: SeedPatient, moduleKey: ModuleKey) {
  const consents = patient.consents;
  if (!consents) throw new Error(`${keyOf(patient)} non ha consensi nel seed.`);
  return {
    outcome: "accetta" as const,
    refusesInformation: false,
    refusalNote: null,
    trusteeName: moduleKey === "trattamento" ? (consents.trusteeName ?? null) : null,
    trusteeContact: null,
    minorOpinionNote: null,
    // Nessun secondo genitore firma: chi firma dichiara che l'altro è informato.
    singleGuardianDeclaration: moduleKey === "trattamento_minore",
    secondGuardianName: null,
    notes: null,
    choices: moduleKey === "informativa" ? { whatsapp: consents.whatsapp, richiami: consents.recalls } : null,
  };
}

const joined = (parts: readonly (string | null | undefined)[]): string => parts.filter(Boolean).join(", ");

/** Lo studio della demo come lo rilegge `getPracticeSettings` dopo i comandi delle impostazioni del seed. */
const STUDIO_SETTINGS: StudioConsentSettings = {
  practiceName: STUDIO.practiceName,
  addressLine: STUDIO.address.line,
  postalCode: STUDIO.address.postalCode,
  city: STUDIO.address.city,
  province: STUDIO.address.province,
  // Salvato in E.164 come ogni telefono (come in `StudioInput`).
  phone: toE164(STUDIO.phone),
  email: STUDIO.email,
  pec: null,
  practitionerFirstName: STUDIO.practitionerFirstName,
  practitionerLastName: STUDIO.practitionerLastName,
  registrationKind: STUDIO.registration.kind,
  registrationOrder: STUDIO.registration.order,
  registrationNumber: STUDIO.registration.number,
  registrationProvince: STUDIO.registration.province,
  insuranceCompany: STUDIO.insurance.company,
  insurancePolicyNumber: STUDIO.insurance.policyNumber,
  insuranceLimitCents: STUDIO.insurance.limitEuros * 100,
};

/**
 * I valori dei segnaposto con i dati inventati del seed: studio, listino e documento dalla stessa funzione
 * dell'anteprima (`studioConsentValues`), paziente e genitore come li compone l'anteprima dalla scheda.
 */
function seedConsentValues(patient: SeedPatient, d0: string, signedOn: string): ConsentValues {
  const guardian = patient.contactGuardian;
  const physician = (key: keyof typeof PHYSICIANS | undefined) => (key === undefined ? null : PHYSICIANS[key].fullName);
  const address = patient.address;
  return {
    ...studioConsentValues(STUDIO_SETTINGS, DEFAULT_SERVICES, signedOn),
    "paziente.nome_completo": keyOf(patient),
    "paziente.data_nascita": birthDateOf(patient, d0),
    "paziente.luogo_nascita": patient.birthPlace ?? null,
    "paziente.codice_fiscale": taxCodeOf(patient, d0),
    "paziente.indirizzo": address ? joined([address.line, address.postalCode, address.city, address.province]) : "",
    "paziente.medico_curante": physician(patient.physicians?.gp),
    "paziente.medico_inviante": physician(patient.physicians?.referring),
    "genitore.nome_completo": guardian ? keyOf(guardian) : null,
    "genitore.codice_fiscale": guardian ? taxCodeOf(guardian, d0) : null,
    "conservazione.anni": String(RETENTION_YEARS),
  };
}

/**
 * Il testo che la firma congela, dai soli valori del seed. `freezeConsent` legge dell'anteprima solo il testo
 * compilato e il luogo, e dei campi le dichiarazioni: gli id nascono nella transazione, e il confronto con
 * l'anteprima vera (`seedConsentRecords`) ferma il seed se i due testi divergono.
 */
function expectedText(patient: SeedPatient, moduleKey: ModuleKey, d0: string, signedOn: string): string {
  const preview = { rendered: renderConsent(moduleKey, seedConsentValues(patient, d0, signedOn)), place: STUDIO.address.city };
  const fields = { moduleKey, ...declarationsOf(patient, moduleKey) };
  return freezeConsent(preview as ConsentPreview, fields as ConsentFields, signedOn, null).text;
}

async function asset(file: string, check: (bytes: Uint8Array) => ReturnType<typeof checkSignaturePng>): Promise<{ bytes: Uint8Array; mime: StoredMime; size: number; sha256: string }> {
  const bytes = new Uint8Array(await readFile(file));
  const checked = check(bytes);
  if (!checked.ok) throw new Error(`Asset del seed non valido: ${basename(file)}`);
  return { bytes, mime: checked.mime, size: checked.size, sha256: checked.sha256 };
}

/** Toglie dallo store i file preparati da un tentativo di seed: quelli che c'erano prima restano. */
export async function removeSeedConsentAssets(store: FileStore, assets: SeedConsentAssets): Promise<void> {
  await store.remove(assets.practitionerSignature.storageKey);
  for (const a of assets.consents) {
    for (const file of [a.signature, a.document]) if (file) await store.remove(file.storageKey);
  }
}

/** Scrive i byte nello store e li rilegge con l'hash: un file del seed non verificato ferma il seed. */
async function putVerified(store: FileStore, file: StoredFileInput, bytes: Uint8Array): Promise<void> {
  await store.put(file.storageKey, bytes);
  if (!(await readVerified(store, file))) throw new Error(`Il file del seed ${file.storageKey} non è stato salvato.`);
}

/**
 * Prima della transazione: la firma dell'osteopata e, per ogni consenso del seed, un file nuovo
 * nello store, con i byte della firma inventata (tela), dell'osteopata o del modulo demo (Lorenzo), riletti e
 * verificati con l'hash; e il testo che la firma deve congelare. Un id per file: i comandi non lasciano due
 * pazienti sulla stessa riga di `files`. Se una scrittura fallisce toglie i file già scritti.
 */
export async function prepareSeedConsentAssets(d0: string, store: FileStore): Promise<SeedConsentAssets> {
  const png = await asset(SIGNATURE_PNG, checkSignaturePng);
  const pdf = await asset(UPLOAD_PDF, checkConsentUpload);
  const practitioner = await asset(PRACTITIONER_PNG, checkSignaturePng);
  const week = seedWeek(d0);
  const practitionerId = randomUUID();
  const practitionerSignature: StoredFileInput = {
    id: practitionerId,
    storageKey: storageKey(P, "signature", practitionerId, practitioner.mime),
    mime: practitioner.mime,
    size: practitioner.size,
    sha256: practitioner.sha256,
  };
  const prepared: SeedConsentAssets = { practitionerSignature, consents: [] };
  try {
    await putVerified(store, practitionerSignature, practitioner.bytes);
    for (const patient of PATIENTS) {
      const consents = patient.consents;
      const [first] = patient.appointments;
      if (!consents || !first) continue;
      const signedOn = resolveDay(week, d0, first.offset);
      for (const moduleKey of modulesOf(patient)) {
        const tela = consents.method === "tela";
        const source = tela ? png : pdf;
        const kind: FileKind = tela ? "signature" : "consent_upload";
        const id = randomUUID();
        const file: StoredFileInput = { id, storageKey: storageKey(P, kind, id, source.mime), mime: source.mime, size: source.size, sha256: source.sha256 };
        const renderedText = expectedText(patient, moduleKey, d0, signedOn);
        prepared.consents.push({
          patientKey: keyOf(patient),
          moduleKey,
          renderedText,
          renderedHash: sha256Hex(renderedText),
          signature: tela ? file : null,
          document: tela ? null : file,
          bytes: tela ? null : source.bytes,
          signatureBytes: tela ? source.bytes : null,
        });
        await putVerified(store, file, source.bytes);
      }
    }
  } catch (error) {
    await removeSeedConsentAssets(store, prepared).catch(() => {});
    throw error;
  }
  return prepared;
}

/** Dove due testi si separano, per capire quale valore del seed non torna con la scheda o le impostazioni. */
function firstDifference(actual: string, expected: string): string {
  let i = 0;
  while (i < actual.length && actual[i] === expected[i]) i++;
  return `«${actual.slice(Math.max(0, i - 40), i + 40)}» invece di «${expected.slice(Math.max(0, i - 40), i + 40)}»`;
}

async function contactGuardianId(tx: Tx, patientId: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    "select id from public.patient_guardians where practice_id = $1 and patient_id = $2 and is_contact",
    [P, patientId],
  );
  if (!row) throw new Error("Il minore del seed non ha un genitore di contatto.");
  return row.id;
}

/**
 * I consensi della demo con i comandi della firma, all'inizio del primo appuntamento: informativa con le due
 * scelte e consenso al trattamento del ciclo (del genitore per un minore). Prima della prima raccolta salva la
 * firma dell'osteopata con il comando di Impostazioni, all'istante della prima firma: ogni consenso
 * su tela la congela. Prima di ogni firma rilegge
 * l'anteprima nella transazione e confronta il testo congelato con quello preparato; dopo, rilegge testo e
 * hash salvati. Poi la revoca dei richiami di Martina, con un messaggio della madre la sera di D0-3.
 */
export async function seedConsentRecords(tx: Tx, clock: Clock, seeded: readonly Seeded[], assets: SeedConsentAssets): Promise<void> {
  const signings = seeded.flatMap((s) => (s.patient.consents && s.appointments[0] ? [s.appointments[0].startsAt.getTime()] : []));
  await setPractitionerSignature(tx, P, fixedClock(new Date(Math.min(...signings))), { file: assets.practitionerSignature });
  const used = new Set<SeedConsentAsset>();
  for (const s of seeded) {
    const consents = s.patient.consents;
    const [first] = s.appointments;
    if (!consents || !first) continue;
    const patientKey = keyOf(s.patient);
    const guardianId = s.patient.contactGuardian ? await contactGuardianId(tx, s.patientId) : null;
    const signerName = s.patient.contactGuardian ? keyOf(s.patient.contactGuardian) : patientKey;
    const signClock = fixedClock(first.startsAt);
    for (const moduleKey of modulesOf(s.patient)) {
      const prepared = assets.consents.find((a) => a.patientKey === patientKey && a.moduleKey === moduleKey);
      if (!prepared) throw new Error(`Manca il file preparato per ${moduleKey} di ${patientKey}.`);
      used.add(prepared);
      const target = {
        patientId: s.patientId,
        cycleId: moduleKey === "informativa" ? null : s.cycleId,
        moduleKey,
        appointmentId: first.id,
        guardianId,
      } as ConsentTarget;
      const preview = await getConsentPreview(tx, P, signClock, target, first.day);
      if (!preview) throw new Error(`Nessuna anteprima del modulo ${moduleKey} per ${patientKey}.`);
      const fields = { id: randomUUID(), ...target, signerName, previewHash: preview.hash, ...declarationsOf(s.patient, moduleKey) } as ConsentFields;
      const frozen = freezeConsent(preview, fields, first.day, signClock.now().toISOString()).text;
      if (frozen !== prepared.renderedText) {
        throw new Error(`Il modulo ${moduleKey} di ${patientKey} non è quello preparato dal seed: ${firstDifference(frozen, prepared.renderedText)}`);
      }

      if (prepared.signature) {
        await signConsent(tx, P, signClock, { fields, signature: prepared.signature, secondSignature: null });
      } else if (prepared.document) {
        await uploadConsent(tx, P, signClock, { fields, signedOn: first.day, document: prepared.document });
      } else {
        throw new Error(`Il consenso ${moduleKey} di ${patientKey} non ha un file.`);
      }
      const [row] = await tx.query<{ text: string; hash: string }>(
        "select rendered_text as text, rendered_hash as hash from public.consent_records where practice_id = $1 and id = $2",
        [P, fields.id],
      );
      if (row?.text !== prepared.renderedText || row.hash !== prepared.renderedHash) {
        throw new Error(`Il testo salvato del modulo ${moduleKey} di ${patientKey} non è quello preparato.`);
      }
    }
    if (consents.recallsRevokedDaysBeforeD0 !== undefined) {
      const decidedOn = addDaysRome(clock.today(), -consents.recallsRevokedDaysBeforeD0);
      await recordChoice(tx, P, fixedClock(romeDateTime(decidedOn, REVOKED_AT)), {
        patientId: s.patientId,
        choice: "richiami",
        value: false,
        decidedOn,
        mode: "messaggio",
        note: null,
      });
    }
  }
  if (used.size !== assets.consents.length) throw new Error("Il seed ha preparato file per consensi che non ha firmato.");
}
