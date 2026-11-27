import { z } from "zod";
import { toLatin1 } from "@/lib/fiscal/latin1";
import { taxCodeProblem } from "@/lib/patients/tax-code";
import { toE164 } from "@/lib/phone";

// L'input del mini modulo "Nuovo paziente". Lo schema è
// `.strict()`, anche nel genitore: una chiave in più (`taxCode`, `practiceId`, `archivedAt`) è
// rifiutata, così il modulo non arriva mai alle colonne dell'anagrafica completa.
// Le regole che guardano la data di oggi (nascita non futura, non oltre 120 anni, minore) sono del
// comando, che riceve il `Clock`. Nomi e indirizzi si convertono al salvataggio; un carattere che
// resta fuori dal Latin-1 blocca solo l'emissione della fattura.

const REQUIRED = "Campo obbligatorio.";
const maxChars = (n: number): string => `Massimo ${n} caratteri.`;
const DATE = "Scrivi la data nel formato 22/10/2026.";
const PHONE = "Scrivi il numero con il prefisso, per esempio +39 051 000 0000.";
// Un valore che il modulo non produce (chiave in più, genitore per un adulto): lo stesso testo del 23514.
export const INVALID = "Valore non valido";

// Gli stessi limiti dei check di `patients` e `patient_guardians`.
const NAME_MAX = 60;

function requiredText(max: number) {
  return z
    .string({ error: REQUIRED })
    .trim()
    .transform(toLatin1)
    .pipe(z.string().min(1, { error: REQUIRED }).max(max, { error: maxChars(max) }));
}

const blankToNull = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

/** Telefono: facoltativo, spazi ammessi, +39 se manca il prefisso, salvato in E.164. */
const phone = z
  .string({ error: INVALID })
  .nullish()
  .transform(blankToNull)
  .refine((value) => value === null || toE164(value) !== null, { error: PHONE })
  .transform((value) => (value === null ? null : toE164(value)));

const birthDate = z
  .string({ error: REQUIRED })
  .trim()
  .min(1, { error: REQUIRED })
  .pipe(z.iso.date({ error: DATE }));

/** Il genitore o tutore di un minore: nome e cognome obbligatori, il telefono no. */
const GuardianInput = z
  .object({ firstName: requiredText(NAME_MAX), lastName: requiredText(NAME_MAX), phone }, { error: INVALID })
  .strict();

export const NewPatientInput = z
  .object(
    {
      firstName: requiredText(NAME_MAX),
      lastName: requiredText(NAME_MAX),
      birthDate,
      phone,
      guardian: GuardianInput.optional(),
    },
    { error: INVALID },
  )
  .strict();
export type NewPatientInput = z.input<typeof NewPatientInput>;

// Anagrafica per gruppi: ogni gruppo si salva da solo con
// `updatePatientGroup`, l'ultimo che salva vince. Ogni chiave del gruppo c'è, perché il gruppo si salva
// intero: una chiave che manca non deve diventare un null salvato. I campi facoltativi accettano ""
// (il campo vuoto) o null e salvano null; gli altri si salvano senza spazi ai lati. Le regole che
// guardano oggi o altre righe (nascita, minore con il genitore di contatto, medici dello studio,
// numero dei genitori, intestatario) sono del comando.

const EMAIL = "Scrivi un indirizzo email valido.";
const POSTAL_CODE = "Scrivi il CAP con 5 cifre.";
const PROVINCE = "Scrivi la sigla della provincia, per esempio BO.";
const COUNTRY = "Scrivi il codice del paese di 2 lettere, per esempio IT.";

// Gli stessi pattern dei check del database e di Impostazioni.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const POSTAL_CODE_PATTERN = /^\d{5}$/;
const PROVINCE_PATTERN = /^[A-Z]{2}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const ITALY = "IT";
const ADMIN_NOTES_MAX = 500;

/** Campo facoltativo con la chiave presente: "" e null diventano null, un testo passa `rule` senza spazi ai lati. */
function optionalText(rule: z.ZodType<string, string> = z.string()) {
  return z.string({ error: INVALID }).nullable().transform(blankToNull).pipe(rule.nullable());
}

const email = optionalText(z.string().regex(EMAIL_PATTERN, { error: EMAIL }));

/** Il telefono del gruppo Contatti e del genitore: come `phone`, ma la chiave c'è sempre. */
const savedPhone = optionalText()
  .refine((value) => value === null || toE164(value) !== null, { error: PHONE })
  .transform((value) => (value === null ? null : toE164(value)));

/** Il codice fiscale: maiuscolo e senza spazi, poi carattere di controllo e omocodie. */
const taxCode = z
  .string({ error: INVALID })
  .nullable()
  .transform((value) => blankToNull(value?.replace(/\s+/g, "").toUpperCase()))
  .superRefine((value, ctx) => {
    const problem = value === null ? null : taxCodeProblem(value);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });

/** Una sigla di due lettere va in maiuscolo ("bo" è BO); il resto (una regione estera) resta com'è scritto. */
const province = optionalText().transform((value) =>
  value !== null && /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : value,
);
/** Il paese in maiuscolo; vuoto è l'Italia (default IT). */
const country = z
  .string({ error: INVALID })
  .transform((value) => value.trim().toUpperCase() || ITALY)
  .pipe(z.string().regex(COUNTRY_PATTERN, { error: COUNTRY }));

const addressFields = {
  addressLine: optionalText(z.string().transform(toLatin1)),
  postalCode: optionalText(),
  city: optionalText(z.string().transform(toLatin1)),
  province,
  country,
};

/** In Italia il CAP ha 5 cifre (lo stesso check del database) e la provincia è la sigla. */
function checkItalianAddress(
  value: { postalCode: string | null; province: string | null; country: string },
  ctx: z.RefinementCtx,
): void {
  if (value.country !== ITALY) return;
  if (value.postalCode !== null && !POSTAL_CODE_PATTERN.test(value.postalCode)) {
    ctx.addIssue({ code: "custom", message: POSTAL_CODE, path: ["postalCode"] });
  }
  if (value.province !== null && !PROVINCE_PATTERN.test(value.province)) {
    ctx.addIssue({ code: "custom", message: PROVINCE, path: ["province"] });
  }
}

const patientId = z.uuid({ error: INVALID });
const physicianId = z.uuid({ error: INVALID }).nullable();

export const PatientGroupInput = z.discriminatedUnion(
  "group",
  [
    z
      .object(
        {
          group: z.literal("personali"),
          patientId,
          firstName: requiredText(NAME_MAX),
          lastName: requiredText(NAME_MAX),
          birthDate,
          sex: z.enum(["f", "m", "nd"], { error: INVALID }),
          birthPlace: optionalText(z.string().transform(toLatin1)),
          taxCode,
        },
        { error: INVALID },
      )
      .strict(),
    z
      .object(
        {
          group: z.literal("contatti"),
          patientId,
          phone: savedPhone,
          email,
          preferredChannel: z.enum(["whatsapp", "telefono", "nessuno"], { error: INVALID }),
          addressing: z.enum(["tu", "lei"], { error: INVALID }),
        },
        { error: INVALID },
      )
      .strict(),
    z
      .object({ group: z.literal("indirizzo"), patientId, ...addressFields }, { error: INVALID })
      .strict()
      .superRefine(checkItalianAddress),
    z
      .object(
        { group: z.literal("medici"), patientId, gpPhysicianId: physicianId, defaultReferringPhysicianId: physicianId },
        { error: INVALID },
      )
      .strict(),
    z
      .object(
        {
          group: z.literal("note"),
          patientId,
          adminNotes: optionalText(z.string().max(ADMIN_NOTES_MAX, { error: maxChars(ADMIN_NOTES_MAX) })),
        },
        { error: INVALID },
      )
      .strict(),
  ],
  { error: INVALID },
);
export type PatientGroupInput = z.input<typeof PatientGroupInput>;

/**
 * Un genitore o tutore del gruppo "Genitori o tutori": nuovo senza `guardianId`, modificato con. I
 * flag li mette in ordine il comando: il nuovo contatto o intestatario toglie il flag all'altro, prima.
 */
export const SaveGuardianInput = z
  .object(
    {
      patientId,
      guardianId: z.uuid({ error: INVALID }).optional(),
      relationship: z.enum(["madre", "padre", "tutore", "altro"], { error: INVALID }),
      firstName: requiredText(NAME_MAX),
      lastName: requiredText(NAME_MAX),
      taxCode,
      phone: savedPhone,
      email,
      ...addressFields,
      hasParentalAuthority: z.boolean({ error: INVALID }),
      isContact: z.boolean({ error: INVALID }),
      isPayer: z.boolean({ error: INVALID }),
    },
    { error: INVALID },
  )
  .strict()
  .superRefine(checkItalianAddress);
export type SaveGuardianInput = z.input<typeof SaveGuardianInput>;

/** "Togli" su un genitore o tutore. */
export const GuardianIdInput = z.object({ guardianId: z.uuid({ error: INVALID }) }, { error: INVALID }).strict();
export type GuardianIdInput = z.input<typeof GuardianIdInput>;

// Archivio, richiamo e avviso clinico.

const RECALL_WEEKS_MIN = 2;
const RECALL_WEEKS_MAX = 52;
const CLINICAL_ALERT_MAX = 200;

/** Archivia, ripristina o elimina: basta il paziente. */
export const PatientIdInput = z.object({ patientId }, { error: INVALID }).strict();
export type PatientIdInput = z.input<typeof PatientIdInput>;

/**
 * La cadenza del richiamo: da 2 a 52 settimane intere (lo stesso check del database), oppure `null`
 * per nessun richiamo; `paused` ferma i richiami senza perdere la cadenza.
 */
export const RecallInput = z
  .object(
    {
      patientId,
      weeks: z
        .number({ error: INVALID })
        .int({ error: INVALID })
        .min(RECALL_WEEKS_MIN, { error: INVALID })
        .max(RECALL_WEEKS_MAX, { error: INVALID })
        .nullable(),
      paused: z.boolean({ error: INVALID }),
    },
    { error: INVALID },
  )
  .strict();
export type RecallInput = z.input<typeof RecallInput>;

/** L'avviso clinico breve: "" e null lo tolgono, il testo non supera i 200 caratteri. */
export const ClinicalAlertInput = z
  .object(
    {
      patientId,
      clinicalAlert: optionalText(z.string().max(CLINICAL_ALERT_MAX, { error: maxChars(CLINICAL_ALERT_MAX) })),
    },
    { error: INVALID },
  )
  .strict();
export type ClinicalAlertInput = z.input<typeof ClinicalAlertInput>;
