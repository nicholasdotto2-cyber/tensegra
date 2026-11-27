import type { Band, WeekHours } from "@/lib/agenda/slots";
import { DEFAULT_RATES, type FiscalRates, type PaymentMethod, type Regime } from "@/lib/fiscal/types";
import { fiscalCodeProblem, ibanProblem, vatNumberProblem } from "@/lib/fiscal/validators";
import type { Tx } from "@/server/db/db";

export interface ConsentSettingsView {
  retentionYears: number;
  practitionerSignatureFileId: string | null;
  signature: { storageKey: string; sha256: string } | null;
}

/** La firma attuale dello studio, letta sotto RLS; non modifica le fotografie già raccolte. */
export async function getConsentSettings(tx: Tx, practiceId: string): Promise<ConsentSettingsView | null> {
  const [row] = await tx.query<{ retentionYears: number; practitionerSignatureFileId: string | null; storageKey: string | null; sha256: string | null }>(
    `select s.retention_years as "retentionYears", s.practitioner_signature_file_id as "practitionerSignatureFileId",
            f.storage_key as "storageKey", f.sha256
       from public.practice_settings s
       left join public.files f on f.practice_id=s.practice_id and f.id=s.practitioner_signature_file_id
         and f.kind='signature' and f.mime_type='image/png'
      where s.practice_id=$1`, [practiceId],
  );
  if (!row) return null;
  return { retentionYears: row.retentionYears, practitionerSignatureFileId: row.practitionerSignatureFileId,
    signature: row.storageKey && row.sha256 ? { storageKey: row.storageKey, sha256: row.sha256 } : null };
}

// Letture delle impostazioni: la shell, Oggi, l'agenda e le sezioni di Impostazioni.
// Ogni lettura filtra lo studio anche oltre la RLS.

export interface FiscalSettingsView {
  regime: Regime;
  vatNumber: string | null;
  taxCode: string | null;
  atecoCode: string | null;
  fiscalAddressLine: string | null;
  fiscalPostalCode: string | null;
  fiscalCity: string | null;
  fiscalProvince: string | null;
  fiscalCountry: string;
  inpsSurchargeEnabled: boolean;
  inpsSurchargeBp: number;
  withholdingBp: number;
  vatRateBp: number;
  stampChargedToClient: boolean;
  paperStampAuthorization: string | null;
  iban: string | null;
  ibanHolder: string | null;
  defaultPaymentMethod: PaymentMethod;
  bankTransferDueDays: number;
  warnings: { vatNumber: string | null; taxCode: string | null; iban: string | null };
}

/** Senza riga propone i default della tabella. I dati presenti portano gli avvisi di controllo. */
export async function getFiscalSettings(tx: Tx, practiceId: string): Promise<FiscalSettingsView> {
  const [row] = await tx.query<Omit<FiscalSettingsView, "warnings">>(
    `select regime,
            vat_number as "vatNumber",
            tax_code as "taxCode",
            ateco_code as "atecoCode",
            fiscal_address_line as "fiscalAddressLine",
            fiscal_postal_code as "fiscalPostalCode",
            fiscal_city as "fiscalCity",
            fiscal_province as "fiscalProvince",
            fiscal_country as "fiscalCountry",
            inps_surcharge_enabled as "inpsSurchargeEnabled",
            inps_surcharge_bp as "inpsSurchargeBp",
            withholding_bp as "withholdingBp",
            vat_rate_bp as "vatRateBp",
            stamp_charged_to_client as "stampChargedToClient",
            paper_stamp_authorization as "paperStampAuthorization",
            iban,
            iban_holder as "ibanHolder",
            default_payment_method as "defaultPaymentMethod",
            bank_transfer_due_days as "bankTransferDueDays"
       from public.fiscal_settings
      where practice_id = $1`,
    [practiceId],
  );
  const fiscal = row ?? {
    ...DEFAULT_RATES,
    regime: "forfettario" as const,
    vatNumber: null,
    taxCode: null,
    atecoCode: null,
    fiscalAddressLine: null,
    fiscalPostalCode: null,
    fiscalCity: null,
    fiscalProvince: null,
    fiscalCountry: "IT",
    paperStampAuthorization: null,
    iban: null,
    ibanHolder: null,
    defaultPaymentMethod: "carta" as const,
    bankTransferDueDays: 15,
  };
  return {
    ...fiscal,
    warnings: {
      vatNumber: fiscal.vatNumber === null ? null : vatNumberProblem(fiscal.vatNumber),
      taxCode: fiscal.taxCode === null ? null : fiscalCodeProblem(fiscal.taxCode),
      iban: fiscal.iban === null ? null : ibanProblem(fiscal.iban),
    },
  };
}

/** Le sole aliquote e scelte del calcolo, senza identità fiscale né avvisi. */
export function fiscalRatesOf(v: FiscalSettingsView): FiscalRates {
  return {
    vatRateBp: v.vatRateBp,
    inpsSurchargeEnabled: v.inpsSurchargeEnabled,
    inpsSurchargeBp: v.inpsSurchargeBp,
    withholdingBp: v.withholdingBp,
    stampChargedToClient: v.stampChargedToClient,
  };
}

/** Studio, osteopata, iscrizione e polizza, tono e dati della demo, come li mostrano le pagine. */
export interface PracticeSettingsView {
  practiceName: string;
  practitionerFirstName: string;
  practitionerLastName: string;
  practitionerTitle: string;
  addressLine: string | null;
  postalCode: string | null;
  city: string | null;
  province: string | null;
  /** E.164, "+390510000000": a schermo con `phoneDisplay`. */
  phone: string | null;
  email: string | null;
  pec: string | null;
  registrationKind: "nessuna" | "in_attesa" | "ese" | "albo";
  registrationOrder: string | null;
  registrationProvince: string | null;
  registrationNumber: string | null;
  /** "AAAA-MM-GG". */
  registrationDate: string | null;
  insuranceCompany: string | null;
  insurancePolicyNumber: string | null;
  insuranceLimitCents: number | null;
  /** "AAAA-MM-GG". */
  insuranceExpiresOn: string | null;
  defaultAddressing: "tu" | "lei";
  isDemo: boolean;
  demoSeededAt: Date | null;
  demoSeedVersion: number | null;
  demoTestPhone: string | null;
}

/** Le impostazioni dello studio; null se la riga non c'è (o è di un altro studio). */
export async function getPracticeSettings(tx: Tx, practiceId: string): Promise<PracticeSettingsView | null> {
  const [row] = await tx.query<PracticeSettingsView>(
    `select p.name as "practiceName",
            s.practitioner_first_name as "practitionerFirstName",
            s.practitioner_last_name as "practitionerLastName",
            s.practitioner_title as "practitionerTitle",
            s.address_line as "addressLine",
            s.postal_code as "postalCode",
            s.city,
            s.province,
            s.phone,
            s.email,
            s.pec,
            s.registration_kind as "registrationKind",
            s.registration_order as "registrationOrder",
            s.registration_province as "registrationProvince",
            s.registration_number as "registrationNumber",
            s.registration_date as "registrationDate",
            s.insurance_company as "insuranceCompany",
            s.insurance_policy_number as "insurancePolicyNumber",
            s.insurance_limit_cents as "insuranceLimitCents",
            s.insurance_expires_on as "insuranceExpiresOn",
            s.default_addressing as "defaultAddressing",
            s.is_demo as "isDemo",
            s.demo_seeded_at as "demoSeededAt",
            s.demo_seed_version as "demoSeedVersion",
            s.demo_test_phone as "demoTestPhone"
       from public.practice_settings s
       join public.practices p on p.id = s.practice_id
      where s.practice_id = $1`,
    [practiceId],
  );
  return row ?? null;
}

/**
 * Se lo studio ha almeno un paziente attivo, per l'anteprima Messaggi. Il paziente non si sceglie più da un
 * elenco intero: si cerca per nome con `searchPreviewPatientsAction`, così Impostazioni e
 * l'anteprima restano su un paziente qualsiasi, anche senza appuntamenti, con migliaia di pazienti.
 */
export async function hasMessagePreviewPatients(tx: Tx, practiceId: string): Promise<boolean> {
  const [row] = await tx.query<{ has: boolean }>(
    `select exists (select 1 from public.patients where practice_id = $1 and archived_at is null) as has`,
    [practiceId],
  );
  return row?.has ?? false;
}

type Weekday = keyof WeekHours;

/** Le fasce di ogni giorno in minuti dalle 00:00, ordinate per inizio; un giorno senza righe è chiuso. */
export async function getOpeningHours(tx: Tx, practiceId: string): Promise<WeekHours> {
  const rows = await tx.query<{ weekday: Weekday; opens_min: number; closes_min: number }>(
    `select weekday,
            (extract(epoch from opens_at) / 60)::int as opens_min,
            (extract(epoch from closes_at) / 60)::int as closes_min
       from public.opening_hours
      where practice_id = $1
      order by weekday, opens_at`,
    [practiceId],
  );
  const week: Record<Weekday, Band[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
  for (const row of rows) week[row.weekday].push({ opensMin: row.opens_min, closesMin: row.closes_min });
  return week;
}

/** Le impostazioni della cartella: cadenza, sedute previste, intervallo, rinvii, test attivi, red flag pediatriche. */
export interface ClinicalSettingsView {
  defaultRecallWeeks: number;
  defaultExpectedSessions: number;
  defaultSessionIntervalWeeks: number;
  referralPrompts: ("R1" | "R2" | "R3")[];
  /** Codici di `TESTS`, in ordine alfabetico. */
  activeTestCodes: string[];
  pediatricRedFlagsEnabled: boolean;
}

export async function getClinicalSettings(tx: Tx, practiceId: string): Promise<ClinicalSettingsView | null> {
  const [row] = await tx.query<ClinicalSettingsView>(
    `select default_recall_weeks as "defaultRecallWeeks",
            default_expected_sessions as "defaultExpectedSessions",
            default_session_interval_weeks as "defaultSessionIntervalWeeks",
            referral_prompts as "referralPrompts",
            active_test_codes as "activeTestCodes",
            pediatric_red_flags_enabled as "pediatricRedFlagsEnabled"
       from public.clinical_settings
      where practice_id = $1`,
    [practiceId],
  );
  return row ?? null;
}
