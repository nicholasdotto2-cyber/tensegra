import { z } from "zod";
import { TESTS } from "@/lib/clinical/catalog";
import { toLatin1 } from "@/lib/fiscal/latin1";
import { toE164 } from "@/lib/phone";

// Gli input dei comandi di Impostazioni. Ogni schema è
// `.strict()`: una chiave in più (`isDemo`, `practiceId`) è rifiutata, così il modulo non arriva
// mai alle colonne che scrive solo il seed. Ogni chiave c'è, perché ogni sezione si salva intera.
// I campi facoltativi accettano "" (il campo vuoto) o null e salvano null; gli altri valori si
// salvano senza spazi ai lati. I vincoli sono quelli dei check del database, controllati prima con
// il testo del campo.

const REQUIRED = "Campo obbligatorio.";
const maxChars = (n: number): string => `Massimo ${n} caratteri.`;
const POSTAL_CODE = "Scrivi il CAP con 5 cifre.";
const PROVINCE = "Scrivi la sigla della provincia, per esempio BO.";
const PHONE = "Scrivi il numero con il prefisso, per esempio +39 051 000 0000.";
const EMAIL = "Scrivi un indirizzo email valido.";
const DATE = "Scrivi la data nel formato 22/10/2026.";
const INSURANCE_LIMIT = "Scrivi un importo intero in euro, da 1 a 21.474.836.";
// Un valore che il modulo non produce (chiave in più, scelta fuori elenco, numero fuori dai
// limiti del campo): lo stesso testo del 23514.
const INVALID = "Valore non valido";

// Gli stessi pattern dei check di practice_settings.
const POSTAL_CODE_PATTERN = /^\d{5}$/;
const PROVINCE_PATTERN = /^[A-Z]{2}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Il massimale più alto che `integer` tiene in centesimi: 2.147.483.647 / 100, per difetto.
const MAX_INSURANCE_LIMIT_EUROS = 21_474_836;

function requiredText(max?: number) {
  const text = z.string().min(1, { error: REQUIRED });
  return z.string({ error: REQUIRED }).trim().transform(toLatin1)
    .pipe(max === undefined ? text : text.max(max, { error: maxChars(max) }));
}

const blankToNull = (value: string | null): string | null => {
  const trimmed = value === null ? "" : value.trim();
  return trimmed === "" ? null : trimmed;
};

/** Campo facoltativo: "" e null diventano null, un testo passa `rule` senza spazi ai lati. */
function optionalText(rule: z.ZodType<string, string> = z.string()) {
  return z.string({ error: INVALID }).nullable().transform(blankToNull).pipe(rule.nullable());
}

const province = optionalText(z.string().regex(PROVINCE_PATTERN, { error: PROVINCE }));
const email = optionalText(z.string().regex(EMAIL_PATTERN, { error: EMAIL }));
const upTo60 = optionalText(z.string().max(60, { error: maxChars(60) }));
const date = optionalText(z.iso.date({ error: DATE }));

/** Telefono: spazi ammessi, +39 se manca il prefisso, salvato in E.164. */
const phone = optionalText()
  .refine((value) => value === null || toE164(value) !== null, { error: PHONE })
  .transform((value) => (value === null ? null : toE164(value)));

export const StudioInput = z
  .object(
    {
      practiceName: requiredText(80),
      practitionerFirstName: requiredText(60),
      practitionerLastName: requiredText(60),
      practitionerTitle: requiredText(),
      addressLine: optionalText(z.string().transform(toLatin1)),
      postalCode: optionalText(z.string().regex(POSTAL_CODE_PATTERN, { error: POSTAL_CODE })),
      city: optionalText(z.string().transform(toLatin1)),
      province,
      phone,
      email,
      pec: email,
    },
    { error: INVALID },
  )
  .strict();
export type StudioInput = z.input<typeof StudioInput>;

/** Il massimale in euro interi, o vuoto; il comando lo salva in centesimi. */
const insuranceLimitEuros = z
  .union([z.number(), z.literal(""), z.null()], { error: INSURANCE_LIMIT })
  .transform((value) => (value === "" ? null : value))
  .refine(
    (value) => value === null || (Number.isInteger(value) && value >= 1 && value <= MAX_INSURANCE_LIMIT_EUROS),
    { error: INSURANCE_LIMIT },
  );

export const RegistrationInput = z
  .object(
    {
      registrationKind: z.enum(["nessuna", "in_attesa", "ese", "albo"], { error: INVALID }),
      registrationOrder: upTo60,
      registrationProvince: province,
      registrationNumber: upTo60,
      registrationDate: date,
      insuranceCompany: optionalText(),
      insurancePolicyNumber: optionalText(),
      insuranceLimitEuros,
      insuranceExpiresOn: date,
    },
    { error: INVALID },
  )
  .strict();
export type RegistrationInput = z.input<typeof RegistrationInput>;

// Fisco: forma uguale ai check SQL. Le cifre di controllo e le lettere
// rimaste fuori dal Latin-1 non impediscono il salvataggio; si controllano prima dell'emissione.
const VAT_NUMBER = "Scrivi la partita IVA con 11 cifre.";
const TAX_CODE = "Scrivi il codice fiscale con 16 caratteri, o 11 cifre per una società.";
const ATECO_CODE = "Scrivi il codice ATECO nel formato 86.96.09.";
const IBAN = "Scrivi l'IBAN con il codice del paese, per esempio IT80N0000001000000000123456.";
const DUE_DAYS = "Scrivi un numero di giorni da 0 a 120.";

function fiscalText(rule: z.ZodType<string, string> = z.string()) {
  return optionalText(z.string().transform(toLatin1).pipe(rule));
}

const uppercaseWithoutSpaces = (value: string): string => value.replace(/\s/g, "").toUpperCase();

export const FiscalInput = z
  .object(
    {
      regime: z.enum(["ordinario", "forfettario", "esente_sanitario"], { error: INVALID }),
      vatNumber: fiscalText(z.string().regex(/^\d{11}$/, { error: VAT_NUMBER })),
      taxCode: fiscalText(z.string().transform(uppercaseWithoutSpaces)
        .pipe(z.string().regex(/^([A-Z0-9]{16}|\d{11})$/, { error: TAX_CODE }))),
      atecoCode: fiscalText(z.string().regex(/^\d{2}\.\d{2}\.\d{2}$/, { error: ATECO_CODE })),
      fiscalAddressLine: fiscalText(z.string().max(60, { error: maxChars(60) })),
      fiscalPostalCode: fiscalText(z.string().regex(POSTAL_CODE_PATTERN, { error: POSTAL_CODE })),
      fiscalCity: fiscalText(z.string().max(60, { error: maxChars(60) })),
      fiscalProvince: fiscalText(z.string().regex(PROVINCE_PATTERN, { error: PROVINCE })),
      fiscalCountry: z.string({ error: INVALID }).trim().transform(toLatin1)
        .pipe(z.string().regex(/^[A-Z]{2}$/, { error: INVALID })).default("IT"),
      inpsSurchargeEnabled: z.boolean({ error: INVALID }),
      stampChargedToClient: z.boolean({ error: INVALID }),
      paperStampAuthorization: fiscalText(z.string().max(60, { error: maxChars(60) })),
      iban: fiscalText(z.string().transform(uppercaseWithoutSpaces)
        .pipe(z.string().regex(/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/, { error: IBAN }))),
      ibanHolder: fiscalText(z.string().max(200, { error: maxChars(200) })),
      defaultPaymentMethod: z.enum(["contanti", "carta", "bonifico"], { error: INVALID }),
      bankTransferDueDays: z.int({ error: DUE_DAYS }).min(0, { error: DUE_DAYS }).max(120, { error: DUE_DAYS }),
    },
    { error: INVALID },
  )
  .strict();
export type FiscalInput = z.input<typeof FiscalInput>;

// Gli orari arrivano come testo: quarti d'ora, fine dopo l'inizio e sovrapposizioni li controlla
// `validateOpeningDays`, con i messaggi sui campi. Qui solo la forma: 7 giorni, 0-2 fasce.
const OpeningBandInput = z
  .object({ opens: z.string({ error: INVALID }), closes: z.string({ error: INVALID }) }, { error: INVALID })
  .strict();

const OpeningDayInput = z
  .object(
    {
      weekday: z.int({ error: INVALID }).min(1, { error: INVALID }).max(7, { error: INVALID }),
      bands: z.array(OpeningBandInput, { error: INVALID }).max(2, { error: INVALID }),
    },
    { error: INVALID },
  )
  .strict();

export const OpeningHoursInput = z
  .object(
    {
      days: z
        .array(OpeningDayInput, { error: INVALID })
        .length(7, { error: INVALID })
        .refine((days) => new Set(days.map((day) => day.weekday)).size === 7, { error: INVALID }),
    },
    { error: INVALID },
  )
  .strict();
export type OpeningHoursInput = z.input<typeof OpeningHoursInput>;

const between = (min: number, max: number) =>
  z.int({ error: INVALID }).min(min, { error: INVALID }).max(max, { error: INVALID });

const TEST_CODES: ReadonlySet<string> = new Set(TESTS.map((test) => test.code));
const UNKNOWN_TEST = "Test non presente nel catalogo.";

export const ClinicalInput = z
  .object(
    {
      defaultRecallWeeks: between(2, 52),
      defaultExpectedSessions: between(1, 20),
      defaultSessionIntervalWeeks: between(1, 4),
      // Un interruttore per promemoria: si salvano una volta sola, in ordine.
      referralPrompts: z
        .array(z.enum(["R1", "R2", "R3"], { error: INVALID }), { error: INVALID })
        .transform((prompts) => [...new Set(prompts)].sort()),
      // I test attivi: solo codici di `TESTS`. Senza il campo la colonna non cambia.
      activeTestCodes: z
        .array(z.string({ error: INVALID }), { error: INVALID })
        .refine((codes) => codes.every((code) => TEST_CODES.has(code)), { error: UNKNOWN_TEST })
        .transform((codes) => [...new Set(codes)].sort())
        .optional(),
    },
    { error: INVALID },
  )
  .strict();
export type ClinicalInput = z.input<typeof ClinicalInput>;

export const DemoTestPhoneInput = z.object({ demoTestPhone: phone }, { error: INVALID }).strict();
export type DemoTestPhoneInput = z.input<typeof DemoTestPhoneInput>;

// Ogni sezione accetta soltanto i propri campi.
export const CommunicationSettingsInput = z.discriminatedUnion("section", [
  z.object({ section: z.literal("messaggi"), defaultAddressing: z.enum(["tu", "lei"], { error: INVALID }) }).strict(),
  z.object({ section: z.literal("consensi"), retentionYears: z.int({ error: "Scrivi un numero di anni da 1 a 30." }).min(1, { error: "Scrivi un numero di anni da 1 a 30." }).max(30, { error: "Scrivi un numero di anni da 1 a 30." }) }).strict(),
]);

export const PractitionerSignatureInput = z.object({
  file: z.object({
    id: z.uuid(), storageKey: z.string().min(1), mime: z.literal("image/png"),
    size: z.int().min(1).max(10485760), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict();

export const MessageTemplateIdentityInput = z.object({
  key: z.enum(["conferma", "promemoria", "spostamento", "richiamo", "consigli"], { error: INVALID }),
  variant: z.enum(["tu", "lei"], { error: INVALID }),
}).strict();
export const MessageTemplateInput = MessageTemplateIdentityInput.extend({ body: z.string({ error: INVALID }) }).strict();
export const MessageTemplatePreviewInput = MessageTemplateInput.extend({ patientId: z.uuid({ error: INVALID }) }).strict();
