import { z } from "zod";

// L'input dei comandi del rinvio al medico. Ogni
// schema è `.strict()`: una chiave in più (`status`, `createdOn`, `letterFileId`, `practiceId`) è
// rifiutata, così il chiamante non arriva mai alle colonne che decide il comando. I limiti sono quelli
// dei check di `referrals`.

// Un valore che il chiamante non produce (scelta fuori elenco, chiave in più): lo stesso testo del 23514.
const INVALID = "Valore non valido";
const REQUIRED = "Campo obbligatorio.";
const DAY = "Scrivi la data nel formato 22/10/2026.";
const maxChars = (n: number): string => `Massimo ${n} caratteri.`;

const SUMMARY_MAX = 3000;
const REQUEST_MAX = 1000;
const RECIPIENT_FREE_MAX = 200;

export const REFERRAL_REASONS = [
  "red_flag",
  "sintomi_persistenti",
  "peggioramento",
  "fuori_competenza",
  "richiesta_paziente",
  "altro",
] as const;
export const URGENCIES = ["emergenza", "urgente", "programmato"] as const;
export const RECIPIENT_KINDS = ["medico_curante", "medico_inviante", "specialista", "pronto_soccorso", "altro"] as const;

const reason = z.enum(REFERRAL_REASONS, { error: INVALID });
const urgency = z.enum(URGENCIES, { error: INVALID });
const referralId = z.uuid({ error: INVALID });

/** Un testo obbligatorio della lettera, senza spazi ai lati; gli a capo dentro restano. */
const letterText = (max: number) =>
  z
    .string({ error: REQUIRED })
    .trim()
    .min(1, { error: REQUIRED })
    .max(max, { error: maxChars(max) });

const blankToNull = (value: string | null): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * "Nuovo rinvio" e «Prepara rinvio». Ciclo e visita facoltativi: con la visita il
 * ciclo è il suo; senza nessuno dei due il ciclo aperto del paziente, altrimenti l'ultimo. Motivo e
 * urgenza mancanti vengono dai promemoria della visita.
 */
export const NewReferralInput = z
  .object(
    {
      patientId: z.uuid({ error: INVALID }),
      cycleId: z.uuid({ error: INVALID }).optional(),
      visitId: z.uuid({ error: INVALID }).optional(),
      reason: reason.optional(),
      urgency: urgency.optional(),
    },
    { error: INVALID },
  )
  .strict();
export type NewReferralInput = z.input<typeof NewReferralInput>;

/** Il modulo della lettera: tutto il contenuto, salvato insieme. */
export const UpdateReferralInput = z
  .object(
    {
      referralId,
      recipientKind: z.enum(RECIPIENT_KINDS, { error: INVALID }),
      physicianId: z.uuid({ error: INVALID }).nullable(),
      /** Il destinatario scritto a mano, se il medico non è in rubrica: "" e null salvano null. */
      recipientFree: z
        .string({ error: INVALID })
        .nullable()
        .transform(blankToNull)
        .pipe(z.string().max(RECIPIENT_FREE_MAX, { error: maxChars(RECIPIENT_FREE_MAX) }).nullable()),
      reason,
      urgency,
      summaryText: letterText(SUMMARY_MAX),
      requestText: letterText(REQUEST_MAX),
      patientAgreedToShare: z.boolean({ error: INVALID }),
    },
    { error: INVALID },
  )
  .strict();
export type UpdateReferralInput = z.input<typeof UpdateReferralInput>;

/** "Segna come consegnata al paziente": il giorno della consegna, proposto oggi e scelto dall'utente. */
export const DeliveredInput = z
  .object({ referralId, deliveredOn: z.iso.date({ error: DAY }) }, { error: INVALID })
  .strict();
export type DeliveredInput = z.input<typeof DeliveredInput>;
