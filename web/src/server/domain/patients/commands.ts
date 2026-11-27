import { isMinor } from "@/lib/format";
import { type Clock, romeDayBounds } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { pgCode } from "@/server/db/errors";
import { BLOCKED_DELETE, DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import type { RegistryGuardian, RegistryView } from "./card";
import {
  ClinicalAlertInput,
  GuardianIdInput,
  INVALID,
  NewPatientInput,
  PatientGroupInput,
  PatientIdInput,
  RecallInput,
  SaveGuardianInput,
} from "./schemas";

// Comandi dei pazienti. `createPatient` è il mini modulo "Nuovo paziente"
// del dialogo dell'appuntamento: non scrive `archived_at`, `tax_code`, né
// le altre colonne dell'anagrafica. L'anagrafica completa si salva per gruppi con `updatePatientGroup`,
// i genitori o tutori con `saveGuardian` e `removeGuardian`. Archiviare, ripristinare ed
// eliminare un paziente, la cadenza del richiamo e l'avviso clinico chiudono il file.

const BIRTH_IN_FUTURE = "La data di nascita non può essere nel futuro.";
const BIRTH_TOO_OLD = "La data di nascita non può essere di più di 120 anni fa.";
const MINOR_NEEDS_GUARDIAN = "Per un minore servono nome e cognome di un genitore.";
const MINOR_NEEDS_CONTACT = "Per un minore serve un genitore di contatto.";
const TOO_MANY_GUARDIANS = "Un paziente ha al massimo due genitori o tutori.";
const PAYER_NEEDS_ADDRESS = "Per l'intestatario servono indirizzo, CAP e città.";
const MAX_GUARDIANS = 2;

const MAX_AGE_YEARS = 120;

/**
 * Il giorno più lontano ammesso come nascita: oggi meno 120 anni. Chi compie 120 anni oggi passa
 * (1906-11-04 con oggi 2026-11-04). Un 29 febbraio che 120 anni fa non c'era diventa il 28.
 */
function earliestBirthDate(today: string): string {
  const [year = "", month = "", date = ""] = today.split("-");
  const earlierYear = Number(year) - MAX_AGE_YEARS;
  const isLeap = (earlierYear % 4 === 0 && earlierYear % 100 !== 0) || earlierYear % 400 === 0;
  const day = month === "02" && date === "29" && !isLeap ? "28" : date;
  return `${String(earlierYear).padStart(4, "0")}-${month}-${day}`;
}

/** Nascita non futura e non oltre 120 anni fa, rispetto a `today` ("AAAA-MM-GG"). */
function checkBirthDate(birthDate: string, today: string): void {
  if (birthDate > today) throw new DomainError(BIRTH_IN_FUTURE, { field: "birthDate" });
  if (birthDate < earliestBirthDate(today)) throw new DomainError(BIRTH_TOO_OLD, { field: "birthDate" });
}

/** Il tono di default dello studio. Senza la riga delle impostazioni (o di un altro studio) è "Operazione non permessa". */
async function defaultAddressing(tx: Tx, practiceId: string): Promise<"tu" | "lei"> {
  const [row] = await tx.query<{ addressing: "tu" | "lei" }>(
    "select default_addressing as addressing from public.practice_settings where practice_id = $1",
    [practiceId],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return row.addressing;
}

/**
 * Crea un paziente dal dialogo dell'appuntamento. Un minore a oggi porta un genitore, che
 * nasce con `relationship = 'altro'` e fa da contatto e da intestatario; un adulto non ne ha. Le date
 * si controllano con l'orologio dato: nascita non futura e non oltre 120 anni fa. Paziente e genitore
 * stanno nella transazione di chi chiama, quindi insieme all'appuntamento che segue.
 */
export async function createPatient(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<{ id: string }> {
  const patient = NewPatientInput.parse(input);
  const today = clock.today();
  checkBirthDate(patient.birthDate, today);

  const minor = isMinor(patient.birthDate, today);
  if (minor && !patient.guardian) throw new DomainError(MINOR_NEEDS_GUARDIAN, { field: "guardian.firstName" });
  // Il modulo mostra il blocco del genitore solo per un minore: un genitore per un adulto non è un suo input.
  if (!minor && patient.guardian) throw new DomainError(INVALID, { field: "guardian" });

  const addressing = await defaultAddressing(tx, practiceId);
  const [row] = await tx.query<{ id: string }>(
    `insert into public.patients (practice_id, first_name, last_name, birth_date, phone, addressing)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [practiceId, patient.firstName, patient.lastName, patient.birthDate, patient.phone, addressing],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);

  if (patient.guardian) {
    await tx.query(
      `insert into public.patient_guardians
         (practice_id, patient_id, relationship, first_name, last_name, phone, is_contact, is_payer)
       values ($1, $2, 'altro', $3, $4, $5, true, true)`,
      [practiceId, row.id, patient.guardian.firstName, patient.guardian.lastName, patient.guardian.phone],
    );
  }
  return { id: row.id };
}

/** La data di nascita del paziente. Un paziente che non c'è, o è di un altro studio, è "Operazione non permessa". */
async function birthDateOf(tx: Tx, practiceId: string, patientId: string): Promise<string> {
  const [row] = await tx.query<{ birthDate: string }>(
    `select birth_date as "birthDate" from public.patients where practice_id = $1 and id = $2`,
    [practiceId, patientId],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return row.birthDate;
}

async function hasContactGuardian(tx: Tx, practiceId: string, patientId: string): Promise<boolean> {
  const rows = await tx.query(
    "select 1 from public.patient_guardians where practice_id = $1 and patient_id = $2 and is_contact",
    [practiceId, patientId],
  );
  return rows.length > 0;
}

/** Ogni medico scelto sta nella rubrica dello studio; uno di un altro studio è "Operazione non permessa". */
async function checkPhysicians(tx: Tx, practiceId: string, ids: readonly (string | null)[]): Promise<void> {
  const chosen = [...new Set(ids.filter((id): id is string => id !== null))];
  if (chosen.length === 0) return;
  const found = await tx.query("select id from public.physicians where practice_id = $1 and id = any($2::uuid[])", [
    practiceId,
    chosen,
  ]);
  if (found.length !== chosen.length) throw new DomainError(NOT_ALLOWED);
}

/** I valori salvati di ogni gruppo, come li legge `getRegistry`: "" per i vuoti, il telefono in E.164. */
export interface SavedGroups {
  personali: RegistryView["personali"];
  contatti: RegistryView["contatti"];
  indirizzo: RegistryView["indirizzo"];
  medici: RegistryView["medici"];
  note: RegistryView["note"];
}
export type SavedGroup = { [G in keyof SavedGroups]: { group: G; values: SavedGroups[G] } }[keyof SavedGroups];

const text = (value: string | null): string => value ?? "";

/** Il gruppo come è stato scritto, dopo gli schemi: spazi tolti, maiuscole, E.164, paese predefinito. */
function savedGroup(group: ReturnType<typeof PatientGroupInput.parse>): SavedGroup {
  switch (group.group) {
    case "personali":
      return {
        group: "personali",
        values: {
          firstName: group.firstName,
          lastName: group.lastName,
          birthDate: group.birthDate,
          sex: group.sex,
          birthPlace: text(group.birthPlace),
          taxCode: text(group.taxCode),
        },
      };
    case "contatti":
      return {
        group: "contatti",
        values: {
          phone: text(group.phone),
          email: text(group.email),
          preferredChannel: group.preferredChannel,
          addressing: group.addressing,
        },
      };
    case "indirizzo":
      return {
        group: "indirizzo",
        values: {
          addressLine: text(group.addressLine),
          postalCode: text(group.postalCode),
          city: text(group.city),
          province: text(group.province),
          country: group.country,
        },
      };
    case "medici":
      return {
        group: "medici",
        values: {
          gpPhysicianId: text(group.gpPhysicianId),
          defaultReferringPhysicianId: text(group.defaultReferringPhysicianId),
        },
      };
    case "note":
      return { group: "note", values: { adminNotes: text(group.adminNotes) } };
  }
}

/**
 * Salva un gruppo dell'anagrafica: solo le colonne del gruppo, l'ultimo che salva vince.
 * Dati personali: nascita non futura e non oltre 120 anni fa, e chi diventa minore a oggi deve avere
 * già un genitore di contatto. Medici: dalla rubrica dello studio.
 */
export async function updatePatientGroup(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<SavedGroup> {
  const group = PatientGroupInput.parse(input);
  await birthDateOf(tx, practiceId, group.patientId);

  let rows: unknown[];
  switch (group.group) {
    case "personali": {
      const today = clock.today();
      checkBirthDate(group.birthDate, today);
      if (isMinor(group.birthDate, today) && !(await hasContactGuardian(tx, practiceId, group.patientId))) {
        throw new DomainError(MINOR_NEEDS_CONTACT, { field: "birthDate" });
      }
      rows = await tx.query(
        `update public.patients
            set first_name = $3, last_name = $4, birth_date = $5, sex = $6, birth_place = $7, tax_code = $8
          where practice_id = $1 and id = $2
          returning id`,
        [
          practiceId,
          group.patientId,
          group.firstName,
          group.lastName,
          group.birthDate,
          group.sex,
          group.birthPlace,
          group.taxCode,
        ],
      );
      break;
    }
    case "contatti":
      rows = await tx.query(
        `update public.patients
            set phone = $3, email = $4, preferred_channel = $5, addressing = $6
          where practice_id = $1 and id = $2
          returning id`,
        [practiceId, group.patientId, group.phone, group.email, group.preferredChannel, group.addressing],
      );
      break;
    case "indirizzo":
      rows = await tx.query(
        `update public.patients
            set address_line = $3, postal_code = $4, city = $5, province = $6, country = $7
          where practice_id = $1 and id = $2
          returning id`,
        [practiceId, group.patientId, group.addressLine, group.postalCode, group.city, group.province, group.country],
      );
      break;
    case "medici":
      await checkPhysicians(tx, practiceId, [group.gpPhysicianId, group.defaultReferringPhysicianId]);
      rows = await tx.query(
        `update public.patients
            set gp_physician_id = $3, default_referring_physician_id = $4
          where practice_id = $1 and id = $2
          returning id`,
        [practiceId, group.patientId, group.gpPhysicianId, group.defaultReferringPhysicianId],
      );
      break;
    case "note":
      rows = await tx.query(
        `update public.patients
            set admin_notes = $3
          where practice_id = $1 and id = $2
          returning id`,
        [practiceId, group.patientId, group.adminNotes],
      );
      break;
  }
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
  return savedGroup(group);
}

interface GuardianFlags {
  id: string;
  isContact: boolean;
}

/**
 * Aggiunge o modifica un genitore o tutore. Nella transazione, in quest'ordine: i
 * controlli (al massimo due, per un minore a oggi esattamente un contatto, l'intestatario con
 * indirizzo, CAP e città), poi il flag tolto all'altro genitore se questo diventa contatto o
 * intestatario (gli indici unici sono immediati), poi l'insert o l'update di questo.
 */
export async function saveGuardian(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
): Promise<{ id: string; guardian: RegistryGuardian }> {
  const guardian = SaveGuardianInput.parse(input);
  const birthDate = await birthDateOf(tx, practiceId, guardian.patientId);
  const existing = await tx.query<GuardianFlags>(
    `select id, is_contact as "isContact"
       from public.patient_guardians
      where practice_id = $1 and patient_id = $2`,
    [practiceId, guardian.patientId],
  );
  const others = existing.filter((g) => g.id !== guardian.guardianId);
  // Un genitore da modificare sta fra quelli di questo paziente.
  if (guardian.guardianId !== undefined && others.length === existing.length) throw new DomainError(NOT_ALLOWED);

  const minor = isMinor(birthDate, clock.today());
  // Il gruppo c'è solo per i minori: come in `createPatient`, un genitore nuovo per un
  // adulto non è un input del modulo. Chi è appena diventato maggiorenne tiene i suoi e li modifica.
  if (guardian.guardianId === undefined && !minor) throw new DomainError(INVALID);
  if (guardian.guardianId === undefined && existing.length >= MAX_GUARDIANS) throw new DomainError(TOO_MANY_GUARDIANS);
  if (minor && !guardian.isContact && !others.some((g) => g.isContact)) {
    throw new DomainError(MINOR_NEEDS_CONTACT, { field: "isContact" });
  }
  if (guardian.isPayer) {
    const missing = (["addressLine", "postalCode", "city"] as const).find((field) => guardian[field] === null);
    if (missing !== undefined) throw new DomainError(PAYER_NEEDS_ADDRESS, { field: missing });
  }

  // Il nuovo contatto o intestatario toglie il flag all'altro genitore, prima della sua scrittura.
  const self = guardian.guardianId ?? null;
  if (guardian.isContact) {
    await tx.query(
      `update public.patient_guardians
          set is_contact = false
        where practice_id = $1 and patient_id = $2 and is_contact and ($3::uuid is null or id <> $3::uuid)`,
      [practiceId, guardian.patientId, self],
    );
  }
  if (guardian.isPayer) {
    await tx.query(
      `update public.patient_guardians
          set is_payer = false
        where practice_id = $1 and patient_id = $2 and is_payer and ($3::uuid is null or id <> $3::uuid)`,
      [practiceId, guardian.patientId, self],
    );
  }

  const values = [
    practiceId,
    guardian.patientId,
    guardian.relationship,
    guardian.firstName,
    guardian.lastName,
    guardian.taxCode,
    guardian.phone,
    guardian.email,
    guardian.addressLine,
    guardian.postalCode,
    guardian.city,
    guardian.province,
    guardian.country,
    guardian.hasParentalAuthority,
    guardian.isContact,
    guardian.isPayer,
  ];
  const [row] =
    guardian.guardianId === undefined
      ? await tx.query<{ id: string }>(
          `insert into public.patient_guardians
             (practice_id, patient_id, relationship, first_name, last_name, tax_code, phone, email,
              address_line, postal_code, city, province, country, has_parental_authority, is_contact, is_payer)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           returning id`,
          values,
        )
      : await tx.query<{ id: string }>(
          `update public.patient_guardians
              set relationship = $3, first_name = $4, last_name = $5, tax_code = $6, phone = $7, email = $8,
                  address_line = $9, postal_code = $10, city = $11, province = $12, country = $13,
                  has_parental_authority = $14, is_contact = $15, is_payer = $16
            where practice_id = $1 and patient_id = $2 and id = $17
            returning id`,
          [...values, guardian.guardianId],
        );
  if (!row) throw new DomainError(NOT_ALLOWED);
  // Il genitore come è stato scritto, per il modulo che lo ha mandato.
  return {
    id: row.id,
    guardian: {
      id: row.id,
      relationship: guardian.relationship,
      firstName: guardian.firstName,
      lastName: guardian.lastName,
      taxCode: text(guardian.taxCode),
      phone: text(guardian.phone),
      email: text(guardian.email),
      addressLine: text(guardian.addressLine),
      postalCode: text(guardian.postalCode),
      city: text(guardian.city),
      province: text(guardian.province),
      country: guardian.country,
      hasParentalAuthority: guardian.hasParentalAuthority,
      isContact: guardian.isContact,
      isPayer: guardian.isPayer,
    },
  };
}

/**
 * "Togli" su un genitore o tutore. L'unico contatto di un minore a oggi non si toglie (prima se ne
 * sceglie un altro); un genitore che ha firmato un consenso o è destinatario di una fattura resta
 * (controllo esplicito, poi la delete; 23001 e 23503 sono lo stesso blocco).
 */
export async function removeGuardian(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { guardianId } = GuardianIdInput.parse(input);
  const [guardian] = await tx.query<{ isContact: boolean; birthDate: string }>(
    `select g.is_contact as "isContact", p.birth_date as "birthDate"
       from public.patient_guardians g
       join public.patients p on p.practice_id = g.practice_id and p.id = g.patient_id
      where g.practice_id = $1 and g.id = $2`,
    [practiceId, guardianId],
  );
  if (!guardian) throw new DomainError(NOT_ALLOWED);
  if (guardian.isContact && isMinor(guardian.birthDate, clock.today())) throw new DomainError(MINOR_NEEDS_CONTACT);

  const [usage] = await tx.query<{ used: boolean }>(
    `select exists (select 1 from public.consent_records where practice_id = $1 and guardian_id = $2)
         or exists (select 1 from public.invoices where practice_id = $1 and guardian_id = $2) as used`,
    [practiceId, guardianId],
  );
  if (usage?.used) throw new DomainError(BLOCKED_DELETE);

  let rows: unknown[];
  try {
    rows = await tx.query("delete from public.patient_guardians where practice_id = $1 and id = $2 returning id", [
      practiceId,
      guardianId,
    ]);
  } catch (error) {
    const code = pgCode(error);
    if (code === "23001" || code === "23503") throw new DomainError(BLOCKED_DELETE);
    throw error;
  }
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

/** Il paziente c'è ed è di questo studio. Altrimenti (anche se è di un altro studio) è "Operazione non permessa". */
async function requirePatient(tx: Tx, practiceId: string, patientId: string): Promise<void> {
  const rows = await tx.query("select 1 from public.patients where practice_id = $1 and id = $2", [practiceId, patientId]);
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

/**
 * Gli appuntamenti futuri del paziente: prenotati o confermati dalle 00:00 di oggi. Uno di stamattina
 * già passato ma non ancora segnato conta, così il conto non cambia con l'ora (come in `listRecalls`).
 */
export async function futureCount(tx: Tx, practiceId: string, clock: Clock, patientId: string): Promise<number> {
  const [row] = await tx.query<{ n: number }>(
    `select count(*)::int as n
       from public.appointments
      where practice_id = $1 and patient_id = $2 and status in ('prenotato', 'confermato') and starts_at >= $3`,
    [practiceId, patientId, romeDayBounds(clock.today()).start],
  );
  return row?.n ?? 0;
}

/** Perché non si archivia: "Prima annulla i 2 appuntamenti futuri."; `null` se non ce ne sono. */
export function archiveBlockText(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "Prima annulla l'appuntamento futuro." : `Prima annulla i ${n} appuntamenti futuri.`;
}

/** Archivia il paziente all'istante del clock. Con appuntamenti futuri si ferma e dice quanti sono. */
export async function archivePatient(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { patientId } = PatientIdInput.parse(input);
  await requirePatient(tx, practiceId, patientId);
  const block = archiveBlockText(await futureCount(tx, practiceId, clock, patientId));
  if (block !== null) throw new DomainError(block);
  // Chi è già archiviato tiene il suo istante.
  await tx.query(`update public.patients set archived_at = $3 where practice_id = $1 and id = $2 and archived_at is null`, [
    practiceId,
    patientId,
    clock.now(),
  ]);
}

export async function restorePatient(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const { patientId } = PatientIdInput.parse(input);
  const rows = await tx.query(
    "update public.patients set archived_at = null where practice_id = $1 and id = $2 returning id",
    [practiceId, patientId],
  );
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

// Le tabelle che tengono il paziente con una chiave `on delete restrict`: una sola riga basta a fermare la delete.
// `consent_choices` ne fa parte anche senza informativa (una scelta registrata a voce).
const PATIENT_DATA_TABLES = [
  "appointments",
  "visits",
  "consent_records",
  "consent_choices",
  "invoices",
  "treatment_cycles",
  "patient_history_items",
  "patient_systems_review",
  "patient_lifestyle",
  "perinatal_histories",
  "patient_attachments",
  "referrals",
  "message_log",
] as const;

/** Vero se qualcosa collegato al paziente ferma la delete (il controllo viene prima). */
export async function deleteBlockers(tx: Tx, practiceId: string, patientId: string): Promise<boolean> {
  const checks = PATIENT_DATA_TABLES.map(
    (table) => `exists (select 1 from public.${table} where practice_id = $1 and patient_id = $2)`,
  );
  const [row] = await tx.query<{ blocked: boolean }>(`select ${checks.join("\n or ")} as blocked`, [
    practiceId,
    patientId,
  ]);
  return row?.blocked ?? false;
}

/**
 * Elimina un paziente che ha solo i suoi genitori o tutori (che spariscono con lui, `on delete cascade`).
 * Il controllo viene prima della delete; 23001 e 23503 della delete sono lo
 * stesso blocco, per una tabella che questo elenco non conosce ancora.
 */
export async function deletePatient(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const { patientId } = PatientIdInput.parse(input);
  await requirePatient(tx, practiceId, patientId);
  if (await deleteBlockers(tx, practiceId, patientId)) throw new DomainError(BLOCKED_DELETE);

  let rows: unknown[];
  try {
    rows = await tx.query("delete from public.patients where practice_id = $1 and id = $2 returning id", [
      practiceId,
      patientId,
    ]);
  } catch (error) {
    const code = pgCode(error);
    if (code === "23001" || code === "23503") throw new DomainError(BLOCKED_DELETE);
    throw error;
  }
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

/**
 * La cadenza del richiamo in settimane (`null` = nessuno) e la pausa. Una cadenza diversa
 * azzera il rinvio; la stessa cadenza, anche sospesa, lo conserva.
 */
export async function setRecall(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const recall = RecallInput.parse(input);
  const rows = await tx.query(
    `update public.patients
        set recall_snoozed_until = case when recall_interval_weeks is distinct from $3 then null else recall_snoozed_until end,
            recall_interval_weeks = $3, recall_paused = $4
      where practice_id = $1 and id = $2
      returning id`,
    [practiceId, recall.patientId, recall.weeks, recall.paused],
  );
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

/** L'avviso clinico breve della testata; vuoto lo toglie. */
export async function setClinicalAlert(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const alert = ClinicalAlertInput.parse(input);
  const rows = await tx.query(
    "update public.patients set clinical_alert = $3 where practice_id = $1 and id = $2 returning id",
    [practiceId, alert.patientId, alert.clinicalAlert],
  );
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}
