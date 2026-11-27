import { z } from "zod";
import { toE164 } from "@/lib/phone";

// L'input di "Nuovo medico": il mini dialogo dell'anagrafica con
// nome e titolo, ruolo, specialità, struttura, telefono, email e note. Lo schema è `.strict()`: una
// chiave in più (`archivedAt`, `practiceId`) è rifiutata. È una creazione, quindi un campo facoltativo
// può mancare: "", null o la chiave assente salvano null. I vincoli sono quelli dei check di `physicians`.

const FULL_NAME = "Scrivi da 2 a 120 caratteri.";
const maxChars = (n: number): string => `Massimo ${n} caratteri.`;
const PHONE = "Scrivi il numero con il prefisso, per esempio +39 051 000 0000.";
const EMAIL = "Scrivi un indirizzo email valido.";
// Un valore che il dialogo non produce (chiave in più, ruolo fuori elenco): lo stesso testo del 23514.
const INVALID = "Valore non valido";

// Gli stessi limiti e lo stesso pattern dei check di `physicians`.
const FULL_NAME_MIN = 2;
const FULL_NAME_MAX = 120;
const NOTES_MAX = 500;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const blankToNull = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

function optionalText(rule: z.ZodType<string, string> = z.string()) {
  return z.string({ error: INVALID }).nullish().transform(blankToNull).pipe(rule.nullable());
}

const PHYSICIAN_ROLES = ["mmg", "pediatra", "specialista", "altro"] as const;
export type PhysicianRole = (typeof PHYSICIAN_ROLES)[number];

export const NewPhysicianInput = z
  .object(
    {
      fullName: z
        .string({ error: FULL_NAME })
        .trim()
        .min(FULL_NAME_MIN, { error: FULL_NAME })
        .max(FULL_NAME_MAX, { error: FULL_NAME }),
      role: z.enum(PHYSICIAN_ROLES, { error: INVALID }),
      specialty: optionalText(),
      organization: optionalText(),
      /** Telefono: spazi ammessi, +39 se manca il prefisso, salvato in E.164. */
      phone: optionalText()
        .refine((value) => value === null || toE164(value) !== null, { error: PHONE })
        .transform((value) => (value === null ? null : toE164(value))),
      email: optionalText(z.string().regex(EMAIL_PATTERN, { error: EMAIL })),
      notes: optionalText(z.string().max(NOTES_MAX, { error: maxChars(NOTES_MAX) })),
    },
    { error: INVALID },
  )
  .strict();
export type NewPhysicianInput = z.input<typeof NewPhysicianInput>;
