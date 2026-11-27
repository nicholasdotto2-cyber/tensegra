import type { AppointmentStatus } from "@/lib/agenda/status";
import { isCurrentVersion } from "@/lib/consents/modules";
import { consentFitsAge, type ModuleKey, missingModules, missingText, type ValidConsents } from "@/lib/consents/required";
import { TREATMENT_CONSENT_REVOKED } from "@/lib/clinical/labels";
import { NO_CYCLE, NO_GUARDIAN, TREATMENT_CONSENT_REFUSED } from "@/lib/consents/messages";
import { age, dayField, dayShort, isMinor, timeOf } from "@/lib/format";
import { addDaysRome, type Clock, daysBetween, romeDayBounds, todayRome } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import type { StoredMime } from "@/server/files/keys";
import type { ConsentTarget } from "./schemas";

// Letture dei consensi: i consensi validi di ogni paziente, da cui la testata
// della cartella e la chiusura della visita leggono lo stato, e il blocco "Consensi mancanti" di Oggi.
// Ogni lettura filtra lo studio anche oltre la RLS.

type TreatmentKey = Exclude<ModuleKey, "informativa">;

/** Un consenso al trattamento deciso da una revoca o da un rifiuto: blocca la sezione Trattamento. */
export type TreatmentBlock = { kind: "revocato"; revokedOn: string } | { kind: "rifiutato" };

export interface ConsentDecisions {
  valid: Map<string, ValidConsents>;
  /** Per paziente e ciclo, la revoca (con il suo giorno) o il rifiuto che decide il consenso al trattamento. */
  blocked: Map<string, Map<string, TreatmentBlock>>;
}

/**
 * L'informativa usa l'ultima riga `valido`; per ciclo le due chiavi di trattamento formano un gruppo
 * deciso dall'ultima riga non sostituita con chiave coerente con l'età alla firma, che vale se
 * accettata e compatibile col catalogo.
 * Un consenso revocato, sostituito o rifiutato non vale. Ogni paziente chiesto ha la sua voce,
 * anche senza consensi. L'ordine non dipende dagli UUID, neppure con Clock fisso. Con la stessa
 * regola, il trattamento di un ciclo deciso da una revoca (col suo giorno) o da un rifiuto è bloccato.
 * Una sola lettura per entrambe le risposte.
 */
export async function loadConsentDecisions(tx: Tx, practiceId: string, patientIds: readonly string[]): Promise<ConsentDecisions> {
  const informativa = new Set<string>();
  const treatment = new Map<string, Map<string, Set<TreatmentKey>>>();
  const blocked = new Map<string, Map<string, TreatmentBlock>>();
  const unique = [...new Set(patientIds)];
  if (unique.length > 0) {
    const rows = await tx.query<{
      patientId: string; moduleKey: ModuleKey; cycleId: string | null;
      version: string; status: string; outcome: string; birthDate: string; signedOn: string; revokedOn: string | null;
    }>(
      `select r.patient_id as "patientId", r.module_key as "moduleKey", r.cycle_id as "cycleId",
              r.module_version as version, r.status, r.outcome,
              p.birth_date as "birthDate", r.signed_on as "signedOn", r.revoked_on as "revokedOn"
         from public.consent_records r
         join public.patients p on p.practice_id = r.practice_id and p.id = r.patient_id
        where r.practice_id = $1 and r.patient_id = any($2::uuid[])
          and (r.status = 'valido' or (r.module_key <> 'informativa' and r.status = 'revocato'))
        order by r.signed_on desc, r.record_order desc`,
      [practiceId, unique],
    );
    const decided = new Set<string>();
    for (const row of rows) {
      if (!consentFitsAge(row.moduleKey, row.birthDate, row.signedOn)) continue;
      const group = `${row.patientId}:${row.moduleKey === "informativa" ? "informativa" : "trattamento"}:${row.cycleId ?? ""}`;
      if (decided.has(group)) continue;
      decided.add(group);
      if (row.cycleId !== null && row.moduleKey !== "informativa") {
        const block: TreatmentBlock | null =
          row.status === "revocato" && row.revokedOn !== null
            ? { kind: "revocato", revokedOn: row.revokedOn }
            : row.status === "valido" && row.outcome === "rifiuta"
              ? { kind: "rifiutato" }
              : null;
        if (block !== null) {
          const byCycle = blocked.get(row.patientId) ?? new Map<string, TreatmentBlock>();
          blocked.set(row.patientId, byCycle.set(row.cycleId, block));
        }
      }
      if (row.status !== "valido" || row.outcome !== "accetta" || !isCurrentVersion(row.moduleKey, row.version)) continue;
      if (row.moduleKey === "informativa") {
        informativa.add(row.patientId);
      } else if (row.cycleId !== null) {
        const byCycle = treatment.get(row.patientId) ?? new Map<string, Set<TreatmentKey>>();
        byCycle.set(row.cycleId, (byCycle.get(row.cycleId) ?? new Set<TreatmentKey>()).add(row.moduleKey));
        treatment.set(row.patientId, byCycle);
      }
    }
  }
  return {
    valid: new Map(
      unique.map((id) => [id, { informativa: informativa.has(id), treatment: treatment.get(id) ?? new Map() }]),
    ),
    blocked,
  };
}

/** I consensi validi dei pazienti dati, con la regola di `loadConsentDecisions`. */
export async function loadValidConsents(
  tx: Tx,
  practiceId: string,
  patientIds: readonly string[],
): Promise<Map<string, ValidConsents>> {
  return (await loadConsentDecisions(tx, practiceId, patientIds)).valid;
}

/** «Consenso revocato il 20/10», per gli appuntamenti del ciclo. */
export function revocationText(revokedOn: string): string {
  // "20/10" da "20/10/2026".
  return `Consenso revocato il ${dayField(revokedOn).slice(0, 5)}`;
}

/** La frase che dice che il trattamento è bloccato: la stessa della sezione Trattamento della visita. */
export function blockText(block: TreatmentBlock): string {
  return block.kind === "revocato" ? TREATMENT_CONSENT_REVOKED : TREATMENT_CONSENT_REFUSED;
}

/**
 * Chi firma per un minore: il tutore, o la madre o il padre con la responsabilità
 * genitoriale; fra questi il contatto, poi il primo registrato. Null se nessuno può firmare. Per un adulto
 * il valore non si usa: firma il paziente.
 */
export async function loadConsentGuardians(
  tx: Tx,
  practiceId: string,
  patientIds: readonly string[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(patientIds)];
  const result = new Map<string, string | null>(ids.map((id) => [id, null]));
  if (ids.length === 0) return result;
  const rows = await tx.query<{ patientId: string; id: string }>(
    `select distinct on (patient_id) patient_id as "patientId", id
       from public.patient_guardians
      where practice_id = $1 and patient_id = any($2::uuid[])
        and (relationship = 'tutore' or (relationship in ('madre', 'padre') and has_parental_authority))
      order by patient_id, is_contact desc, created_at, id`,
    [practiceId, ids],
  );
  for (const row of rows) result.set(row.patientId, row.id);
  return result;
}

/** Il paziente per cui si costruisce un bersaglio di raccolta. */
export interface TargetPatient {
  id: string;
  birthDate: string;
}

const isMinorOn = (birthDate: string, day: string): boolean => isMinor(birthDate, day < birthDate ? birthDate : day);

/**
 * Il bersaglio di un dialogo di raccolta per un modulo che si firma oggi: la chiave del trattamento è
 * quella dell'età di oggi, l'unica che il comando accetta (`consentFitsAge`), e che vale anche per un
 * appuntamento dopo i 18 anni di un ciclo aperto da minore. Per un minore firma `guardianId`. Il server
 * ricontrolla tutto (`getConsentPreview` e i comandi).
 */
export function consentTarget(
  patient: TargetPatient,
  today: string,
  guardianId: string | null,
  module: { kind: "informativa" } | { kind: "trattamento"; cycleId: string },
  appointmentId: string | null = null,
): ConsentTarget {
  const minor = isMinorOn(patient.birthDate, today);
  const base = { patientId: patient.id, appointmentId, guardianId: minor ? guardianId : null };
  return module.kind === "informativa"
    ? { ...base, moduleKey: "informativa", cycleId: null }
    : { ...base, moduleKey: minor ? "trattamento_minore" : "trattamento", cycleId: module.cycleId };
}

/**
 * Perché un bersaglio non si può raccogliere, con le frasi del dialogo: un minore senza chi firmi, un
 * trattamento senza ciclo aperto. `cycleOpen` è null per l'informativa. Null se si può.
 */
export function targetProblem(
  patient: TargetPatient,
  today: string,
  guardianId: string | null,
  cycleOpen: boolean | null,
): string | null {
  if (isMinorOn(patient.birthDate, today) && guardianId === null) return NO_GUARDIAN;
  if (cycleOpen === false) return NO_CYCLE;
  return null;
}

/** Lo stato dei consensi di un paziente: per la testata della cartella e la chiusura della visita. */
export async function getConsentStatus(tx: Tx, practiceId: string, patientId: string): Promise<ValidConsents> {
  return (await loadValidConsents(tx, practiceId, [patientId])).get(patientId) ?? { informativa: false, treatment: new Map() };
}

/** Ultima scelta esplicita e informativa valida, con la stessa regola per letture singole e batch. */
export async function getChannelConsents(
  tx: Tx,
  practiceId: string,
  patientIds: readonly string[],
  choice: "whatsapp" | "richiami",
): Promise<Map<string, boolean>> {
  const ids = [...new Set(patientIds)];
  const result = new Map(ids.map((id) => [id, false]));
  if (ids.length === 0) return result;
  const valid = await loadValidConsents(tx, practiceId, ids);
  const rows = await tx.query<{ patientId: string; value: boolean }>(
    `select distinct on (patient_id) patient_id as "patientId", value
       from public.consent_choices
      where practice_id = $1 and patient_id = any($2::uuid[]) and choice = $3
      order by patient_id, decided_on desc, created_at desc, record_order desc`,
    [practiceId, ids, choice],
  );
  for (const row of rows) result.set(row.patientId, row.value && (valid.get(row.patientId)?.informativa ?? false));
  return result;
}

export async function getChannelConsent(
  tx: Tx,
  practiceId: string,
  patientId: string,
  choice: "whatsapp" | "richiami",
): Promise<boolean> {
  return (await getChannelConsents(tx, practiceId, [patientId], choice)).get(patientId) ?? false;
}

/** Una riga di "Consensi mancanti". */
export interface MissingConsentRow {
  patientId: string;
  firstName: string;
  lastName: string;
  /** "4 mesi" per un minore, a oggi; null per un adulto. */
  ageText: string | null;
  /** "Informativa e consenso del genitore". */
  missingText: string;
  /** "oggi alle 11:00", "domani alle 11:00", "gio 29 ott alle 11:00"; con soli fatti "seduta del 20/10". */
  whenText: string;
  /**
   * Che cosa apre «Raccogli»: prima il trattamento che manca per l'appuntamento della riga, nel
   * suo ciclo; quando c'è già, o il ciclo è chiuso e manca anche l'informativa, l'informativa. Un modulo alla
   * volta: la riga, riletta dopo la firma, propone il secondo.
   */
  target: ConsentTarget;
  /** Perché «Raccogli» non si può usare (ciclo chiuso, minore senza chi firmi); null se si può. */
  targetProblem: string | null;
}

/** I giorni di "Consensi mancanti": da oggi al settimo giorno dopo, compreso. */
const WINDOW_DAYS = 8;

/**
 * Minore alla data dell'appuntamento. Un appuntamento segnato prima della nascita conta come il
 * giorno della nascita: l'età non è mai negativa.
 */
function ageDayOf(birthDate: string, day: string): string {
  return day < birthDate ? birthDate : day;
}

interface Pending {
  startsAt: Date;
  /** Prenotato o confermato: un appuntamento che arriva; altrimenti un fatto. */
  future: boolean;
  missing: ModuleKey[];
  minor: boolean;
}

function whenText(p: Pending, today: string): string {
  const day = todayRome(p.startsAt);
  // "20/10" da "20/10/2026".
  if (!p.future) return `seduta del ${dayField(day).slice(0, 5)}`;
  const days = daysBetween(today, day);
  const date = days === 0 ? "oggi" : days === 1 ? "domani" : dayShort(day);
  return `${date} alle ${timeOf(p.startsAt)}`;
}

/**
 * "Consensi mancanti". Contano i prenotati e i confermati dalle 00:00 di oggi alle
 * 00:00 di oggi + 8 giorni, e ogni fatto senza finestra; i pazienti archiviati restano fuori. Per ogni
 * appuntamento i moduli che mancano per il suo ciclo e l'età alla sua data. La riga descrive il primo
 * appuntamento futuro a cui manca qualcosa, o il fatto più vecchio: prima le righe con un appuntamento
 * futuro, per orario, poi quelle con soli fatti, dal più vecchio.
 */
export async function listMissingConsents(tx: Tx, practiceId: string, clock: Clock): Promise<MissingConsentRow[]> {
  const today = clock.today();
  const { start } = romeDayBounds(today);
  const { start: end } = romeDayBounds(addDaysRome(today, WINDOW_DAYS));
  const rows = await tx.query<{
    id: string;
    patientId: string;
    cycleId: string;
    startsAt: Date;
    status: AppointmentStatus;
    firstName: string;
    lastName: string;
    birthDate: string;
    openedOn: string;
    cycleOpen: boolean;
  }>(
    `select a.id,
            a.patient_id as "patientId",
            a.cycle_id as "cycleId",
            a.starts_at as "startsAt",
            a.status,
            p.first_name as "firstName",
            p.last_name as "lastName",
            p.birth_date as "birthDate",
            c.opened_on as "openedOn",
            c.status = 'open' as "cycleOpen"
       from public.appointments a
       join public.patients p on p.practice_id = a.practice_id and p.id = a.patient_id
       join public.treatment_cycles c on c.practice_id = a.practice_id and c.id = a.cycle_id
      where a.practice_id = $1
        and p.archived_at is null
        and (a.status = 'fatto'
             or (a.status in ('prenotato', 'confermato') and a.starts_at >= $2 and a.starts_at < $3))
      order by a.starts_at, a.id`,
    [practiceId, start, end],
  );
  const consents = await loadValidConsents(
    tx,
    practiceId,
    rows.map((row) => row.patientId),
  );
  const guardians = await loadConsentGuardians(
    tx,
    practiceId,
    rows.map((row) => row.patientId),
  );

  // Il primo appuntamento che conta di ogni paziente: un futuro vince su un fatto, a parità il più vecchio.
  const first = new Map<string, { pending: Pending; row: (typeof rows)[number] }>();
  for (const row of rows) {
    const minor = isMinor(row.birthDate, ageDayOf(row.birthDate, todayRome(row.startsAt)));
    const minorAtOpening = isMinor(row.birthDate, ageDayOf(row.birthDate, row.openedOn));
    const missing = missingModules(consents.get(row.patientId), row.cycleId, minor, minorAtOpening);
    if (missing.length === 0) continue;
    const pending: Pending = { startsAt: row.startsAt, future: row.status !== "fatto", missing, minor };
    const seen = first.get(row.patientId);
    // Le righe arrivano in ordine di orario: un fatto già visto lascia il posto solo a un futuro.
    if (!seen || (pending.future && !seen.pending.future)) first.set(row.patientId, { pending, row });
  }

  return [...first.values()]
    .sort((a, b) => {
      if (a.pending.future !== b.pending.future) return a.pending.future ? -1 : 1;
      return a.pending.startsAt.getTime() - b.pending.startsAt.getTime();
    })
    .map(({ pending, row }) => {
      const ageDay = ageDayOf(row.birthDate, today);
      const patient = { id: row.patientId, birthDate: row.birthDate };
      const guardianId = guardians.get(row.patientId) ?? null;
      const treatment = pending.missing.some((m) => m !== "informativa");
      // Il trattamento di un ciclo chiuso non si raccoglie: resta l'informativa, se manca anche quella.
      const collectTreatment = treatment && (row.cycleOpen || !pending.missing.includes("informativa"));
      return {
        patientId: row.patientId,
        firstName: row.firstName,
        lastName: row.lastName,
        ageText: isMinor(row.birthDate, ageDay) ? age(row.birthDate, ageDay) : null,
        missingText: missingText(pending.missing, pending.minor),
        whenText: whenText(pending, today),
        target: consentTarget(
          patient,
          today,
          guardianId,
          collectTreatment ? { kind: "trattamento", cycleId: row.cycleId } : { kind: "informativa" },
          row.id,
        ),
        targetProblem: targetProblem(patient, today, guardianId, collectTreatment ? row.cycleOpen : null),
      };
    });
}

/** Un file collegato a un consenso, con l'hash con cui i byte riletti si confrontano. */
export interface ConsentSourceFile {
  id: string;
  storageKey: string;
  mimeType: StoredMime;
  sha256: string;
}

/**
 * La fotografia di un consenso per il suo documento: testo, firmatari, giorno e istante
 * della firma, versione, mancanti e i file delle firme e del documento. Un file vale solo col tipo atteso
 * (`signature` per le firme, `consent_pdf` o `consent_upload` per il documento, secondo il metodo): con un
 * tipo diverso è null. Le firme si leggono qui e non da `getStoredFile`, che non le serve. Null se il
 * consenso non c'è o è di un altro studio.
 */
export interface ConsentDocumentSource {
  id: string;
  patientId: string;
  method: "tela" | "pdf_caricato";
  status: "valido" | "revocato" | "sostituito";
  text: string;
  version: string;
  missingFields: string[];
  signerName: string;
  secondGuardianName: string | null;
  signedOn: string;
  signedAt: Date | null;
  demo: boolean;
  /** Le colonne dei file: un id senza file del tipo atteso dice che il file non è servibile. */
  signatureFileId: string | null;
  secondSignatureFileId: string | null;
  practitionerSignatureFileId: string | null;
  documentFileId: string | null;
  signature: ConsentSourceFile | null;
  secondSignature: ConsentSourceFile | null;
  practitionerSignature: ConsentSourceFile | null;
  document: ConsentSourceFile | null;
}

const fileColumns = (alias: string, name: string) =>
  `case when ${alias}.id is null then null else json_build_object('id', ${alias}.id, 'storageKey', ${alias}.storage_key,
     'mimeType', ${alias}.mime_type, 'sha256', ${alias}.sha256) end as "${name}"`;

export async function getConsentDocumentSource(tx: Tx, practiceId: string, consentId: string): Promise<ConsentDocumentSource | null> {
  const [row] = await tx.query<ConsentDocumentSource>(
    `select r.id, r.patient_id as "patientId", r.method, r.status, r.rendered_text as text, r.module_version as version,
            r.missing_fields as "missingFields", r.signer_name as "signerName", r.second_guardian_name as "secondGuardianName",
            r.signed_on as "signedOn", r.signed_at as "signedAt", coalesce(r.demo, s.is_demo, false) as demo,
            r.signature_file_id as "signatureFileId", r.second_signature_file_id as "secondSignatureFileId",
            r.practitioner_signature_file_id as "practitionerSignatureFileId", r.document_file_id as "documentFileId",
            ${fileColumns("sf", "signature")}, ${fileColumns("ssf", "secondSignature")},
            ${fileColumns("pf", "practitionerSignature")}, ${fileColumns("df", "document")}
       from public.consent_records r
       join public.patients p on p.practice_id = r.practice_id and p.id = r.patient_id
       left join public.practice_settings s on s.practice_id = r.practice_id
       left join public.files sf on sf.practice_id = r.practice_id and sf.id = r.signature_file_id
            and sf.kind = 'signature' and sf.mime_type = 'image/png'
       left join public.files ssf on ssf.practice_id = r.practice_id and ssf.id = r.second_signature_file_id
            and ssf.kind = 'signature' and ssf.mime_type = 'image/png'
       left join public.files pf on pf.practice_id = r.practice_id and pf.id = r.practitioner_signature_file_id
            and pf.kind = 'signature' and pf.mime_type = 'image/png'
       left join public.files df on df.practice_id = r.practice_id and df.id = r.document_file_id
            and df.kind = case r.method when 'tela' then 'consent_pdf' else 'consent_upload' end
      where r.practice_id = $1 and r.id = $2`,
    [practiceId, consentId],
  );
  return row ?? null;
}
