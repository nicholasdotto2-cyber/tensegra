import { slotState } from "@/lib/agenda/slots";
import { DEFAULT_ACTIVE_TEST_CODES } from "@/lib/clinical/catalog";
import { validateOpeningDays } from "@/lib/settings/opening-hours";
import { type Clock, romeDayBounds, romeMinutes, todayRome } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { storageKey } from "@/server/files/keys";
import { bandsOf } from "./opening-days";
import { getOpeningHours } from "./queries";
import { ClinicalInput, CommunicationSettingsInput, DemoTestPhoneInput, FiscalInput, OpeningHoursInput, PractitionerSignatureInput, RegistrationInput, StudioInput } from "./schemas";

// Comandi di Impostazioni: ogni sezione si salva da sola e scrive solo le sue
// colonne. Nessun comando scrive `is_demo`, `demo_seeded_at`, `demo_seed_version` (solo il seed) né
// `pediatric_red_flags_enabled`. La firma è quella di ogni comando, anche dove
// l'orologio non serve.

/**
 * Studio e osteopata. Upsert, perché la riga la crea questo comando (il seed lo chiama per primo):
 * la riga proposta porta i due nomi obbligatori, quindi è valida, e per un altro studio la policy
 * risponde 42501. Il nome dello studio si scrive solo se cambia, così il trigger di `updated_at`
 * di `practices` non scatta per niente.
 */
export async function saveStudio(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const studio = StudioInput.parse(input);
  await tx.query(
    `insert into public.practice_settings
       (practice_id, practitioner_first_name, practitioner_last_name, practitioner_title,
        address_line, postal_code, city, province, phone, email, pec)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (practice_id) do update set
       practitioner_first_name = excluded.practitioner_first_name,
       practitioner_last_name = excluded.practitioner_last_name,
       practitioner_title = excluded.practitioner_title,
       address_line = excluded.address_line,
       postal_code = excluded.postal_code,
       city = excluded.city,
       province = excluded.province,
       phone = excluded.phone,
       email = excluded.email,
       pec = excluded.pec`,
    [
      practiceId,
      studio.practitionerFirstName,
      studio.practitionerLastName,
      studio.practitionerTitle,
      studio.addressLine,
      studio.postalCode,
      studio.city,
      studio.province,
      studio.phone,
      studio.email,
      studio.pec,
    ],
  );
  // 0 righe non è un errore: il nome è già quello.
  await tx.query("update public.practices set name = $2 where id = $1 and name is distinct from $2", [
    practiceId,
    studio.practiceName,
  ]);
}

/**
 * Iscrizione e polizza, con il massimale in centesimi. Update e non upsert: Postgres controlla i
 * `not null` della riga proposta prima del conflitto, e senza i due nomi l'insert darebbe 23502.
 * Senza la riga (o per un altro studio) l'update vede 0 righe: "Operazione non permessa".
 */
export async function saveRegistration(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const r = RegistrationInput.parse(input);
  const rows = await tx.query(
    `update public.practice_settings
        set registration_kind = $2,
            registration_order = $3,
            registration_province = $4,
            registration_number = $5,
            registration_date = $6,
            insurance_company = $7,
            insurance_policy_number = $8,
            insurance_limit_cents = $9,
            insurance_expires_on = $10
      where practice_id = $1
      returning practice_id`,
    [
      practiceId,
      r.registrationKind,
      r.registrationOrder,
      r.registrationProvince,
      r.registrationNumber,
      r.registrationDate,
      r.insuranceCompany,
      r.insurancePolicyNumber,
      r.insuranceLimitEuros === null ? null : r.insuranceLimitEuros * 100,
      r.insuranceExpiresOn,
    ],
  );
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

/** Fisco: una sezione intera, senza scrivere le tre aliquote né i dati di creazione. */
export async function saveFiscalSettings(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const f = FiscalInput.parse(input);
  await tx.query(
    `insert into public.fiscal_settings
       (practice_id, regime, vat_number, tax_code, ateco_code, fiscal_address_line,
        fiscal_postal_code, fiscal_city, fiscal_province, fiscal_country,
        inps_surcharge_enabled, stamp_charged_to_client, paper_stamp_authorization,
        iban, iban_holder, default_payment_method, bank_transfer_due_days)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     on conflict (practice_id) do update set
       regime = excluded.regime,
       vat_number = excluded.vat_number,
       tax_code = excluded.tax_code,
       ateco_code = excluded.ateco_code,
       fiscal_address_line = excluded.fiscal_address_line,
       fiscal_postal_code = excluded.fiscal_postal_code,
       fiscal_city = excluded.fiscal_city,
       fiscal_province = excluded.fiscal_province,
       fiscal_country = excluded.fiscal_country,
       inps_surcharge_enabled = excluded.inps_surcharge_enabled,
       stamp_charged_to_client = excluded.stamp_charged_to_client,
       paper_stamp_authorization = excluded.paper_stamp_authorization,
       iban = excluded.iban,
       iban_holder = excluded.iban_holder,
       default_payment_method = excluded.default_payment_method,
       bank_transfer_due_days = excluded.bank_transfer_due_days
     where fiscal_settings.practice_id = $1`,
    [
      practiceId, f.regime, f.vatNumber, f.taxCode, f.atecoCode, f.fiscalAddressLine,
      f.fiscalPostalCode, f.fiscalCity, f.fiscalProvince, f.fiscalCountry,
      f.inpsSurchargeEnabled, f.stampChargedToClient, f.paperStampAuthorization,
      f.iban, f.ibanHolder, f.defaultPaymentMethod, f.bankTransferDueDays,
    ],
  );
}

/**
 * Gli orari: prima i controlli del modulo, con un errore per campo; poi le righe
 * dello studio sostituite nella stessa transazione, con le fasce numerate per inizio. Risponde con
 * gli appuntamenti prenotati o confermati da 00:00 di oggi che restano fuori dalle nuove fasce
 * (le sovrapposizioni non contano) e il giorno del primo.
 */
export async function saveOpeningHours(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
): Promise<{ outsideCount: number; firstOutsideDay: string | null }> {
  const { days } = OpeningHoursInput.parse(input);
  const errors = validateOpeningDays(days);
  const [first] = Object.entries(errors);
  if (first) throw new DomainError(first[1], { field: first[0], fieldErrors: errors });

  await tx.query("delete from public.opening_hours where practice_id = $1", [practiceId]);
  for (const day of days) {
    // Orari già controllati, "HH:MM" a due cifre: l'ordine del testo è quello dell'ora.
    const bands = [...day.bands].sort((a, b) => (a.opens < b.opens ? -1 : a.opens > b.opens ? 1 : 0));
    for (const [index, band] of bands.entries()) {
      await tx.query(
        `insert into public.opening_hours (practice_id, weekday, slot, opens_at, closes_at)
         values ($1, $2, $3, $4, $5)`,
        [practiceId, day.weekday, index + 1, band.opens, band.closes],
      );
    }
  }
  return countOutsideHours(tx, practiceId, clock);
}

async function countOutsideHours(
  tx: Tx,
  practiceId: string,
  clock: Clock,
): Promise<{ outsideCount: number; firstOutsideDay: string | null }> {
  // Le fasce rilette dal database: le stesse che vedranno agenda e Oggi.
  const week = await getOpeningHours(tx, practiceId);
  const rows = await tx.query<{ starts_at: Date; duration_min: number }>(
    `select starts_at, duration_min
       from public.appointments
      where practice_id = $1
        and status in ('prenotato', 'confermato')
        and starts_at >= $2
      order by starts_at, id`,
    [practiceId, romeDayBounds(clock.today()).start],
  );
  let outsideCount = 0;
  let firstOutsideDay: string | null = null;
  for (const row of rows) {
    const day = todayRome(row.starts_at);
    const startMin = romeMinutes(row.starts_at);
    if (slotState(bandsOf(week, day), [], startMin, startMin + row.duration_min).kind !== "libero") {
      outsideCount += 1;
      firstOutsideDay ??= day;
    }
  }
  return { outsideCount, firstOutsideDay };
}

/**
 * Cadenza, sedute previste, intervallo, promemoria di rinvio e test attivi. Upsert: `active_test_codes`
 * è not null senza default, quindi alla prima riga il campo mancante diventa i 24 test di default;
 * in aggiornamento senza il campo la colonna non cambia. Le red flag pediatriche
 * non le scrive nessun comando.
 */
export async function saveClinicalSettings(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const c = ClinicalInput.parse(input);
  await tx.query(
    `insert into public.clinical_settings
       (practice_id, default_recall_weeks, default_expected_sessions, default_session_interval_weeks,
        referral_prompts, active_test_codes)
     values ($1, $2, $3, $4, $5, coalesce($6::text[], $7::text[]))
     on conflict (practice_id) do update set
       default_recall_weeks = excluded.default_recall_weeks,
       default_expected_sessions = excluded.default_expected_sessions,
       default_session_interval_weeks = excluded.default_session_interval_weeks,
       referral_prompts = excluded.referral_prompts,
       active_test_codes = coalesce($6::text[], clinical_settings.active_test_codes)`,
    [
      practiceId,
      c.defaultRecallWeeks,
      c.defaultExpectedSessions,
      c.defaultSessionIntervalWeeks,
      c.referralPrompts,
      c.activeTestCodes ?? null,
      [...DEFAULT_ACTIVE_TEST_CODES].sort(),
    ],
  );
}

/** Il numero per le prove WhatsApp: solo in uno studio demo, "" lo toglie. */
export async function saveDemoTestPhone(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const { demoTestPhone } = DemoTestPhoneInput.parse(input);
  const rows = await tx.query(
    `update public.practice_settings
        set demo_test_phone = $2
      where practice_id = $1 and is_demo
      returning practice_id`,
    [practiceId, demoTestPhone],
  );
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

/** Tono dei nuovi pazienti o conservazione dei nuovi consensi: solo le colonne della sezione. */
export async function saveCommunicationSettings(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const settings = CommunicationSettingsInput.parse(input);
  switch (settings.section) {
    case "consensi": {
      const rows = await tx.query(
        "update public.practice_settings set retention_years = $2 where practice_id = $1 returning practice_id",
        [practiceId, settings.retentionYears],
      );
      if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
      return;
    }
    case "messaggi": {
      const rows = await tx.query(
        "update public.practice_settings set default_addressing = $2 where practice_id = $1 returning practice_id",
        [practiceId, settings.defaultAddressing],
      );
      if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
      return;
    }
  }
}

/** Collega una nuova firma senza eliminare quelle congelate nei consensi o nei PDF. */
export async function setPractitionerSignature(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { file } = PractitionerSignatureInput.parse(input);
  if (file.storageKey !== storageKey(practiceId, "signature", file.id, file.mime)) throw new DomainError(NOT_ALLOWED);
  const rows = await tx.query("select practice_id from public.practice_settings where practice_id=$1 for update", [practiceId]);
  if (!rows.length) throw new DomainError(NOT_ALLOWED);
  await tx.query(
    `insert into public.files (id, practice_id, kind, storage_key, mime_type, size_bytes, sha256, created_at)
     values ($1,$2,'signature',$3,$4,$5,$6,$7)`,
    [file.id, practiceId, file.storageKey, file.mime, file.size, file.sha256, clock.now()],
  );
  await tx.query("update public.practice_settings set practitioner_signature_file_id=$2 where practice_id=$1", [practiceId, file.id]);
}
