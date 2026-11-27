import { z } from "zod";
import { REGION_CODES, RISK_TAGS, SYSTEMS } from "@/lib/clinical/catalog";
import { INVALID } from "@/server/domain/patients/schemas";

// L'input dell'anamnesi. Ogni schema è `.strict()`: una chiave in più
// (`practiceId`, `lastReviewedOn`, `deletedAt`) è rifiutata. Come per l'anagrafica a gruppi, ogni
// chiave del gruppo c'è (con `null` per "non so"): una chiave che manca non deve diventare un null
// salvato. Le regole fra più campi che hanno una frase (la cicatrice, le settimane di gravidanza) sono
// del comando; i limiti dei check del database sono qui, così zod e database dicono la stessa cosa.

export { INVALID };

const REQUIRED = "Campo obbligatorio.";
const DATE = "Scrivi la data nel formato 22/10/2026.";
const YEAR = "Scrivi un anno fra 1900 e 2100.";
/** Il testo del 23514: lo stesso per un numero fuori limite e per le settimane. */
export const PREGNANCY_WEEKS_TEXT = "Scrivi le settimane, da 1 a 42.";
const maxChars = (n: number): string => `Massimo ${n} caratteri.`;

const patientId = z.uuid({ error: INVALID });

const blankToNull = (value: string | null): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

/** Campo facoltativo con la chiave presente: "" e null diventano null, un testo passa `rule` senza spazi ai lati. */
function optionalText(rule: z.ZodType<string, string> = z.string()) {
  return z.string({ error: INVALID }).nullable().transform(blankToNull).pipe(rule.nullable());
}

const limitedText = (max: number) => optionalText(z.string().max(max, { error: maxChars(max) }));

/** Un intero fra `min` e `max` o `null`, con lo stesso testo per un tipo sbagliato, un decimale o un valore fuori limite. */
function boundedInt(min: number, max: number, message: string = INVALID) {
  return z.number({ error: message }).int({ error: message }).min(min, { error: message }).max(max, { error: message }).nullable();
}

const triState = z.boolean({ error: INVALID }).nullable();

// Anamnesi remota ------------------------------------------------------------------------------------

/** I tipi con un pulsante "Aggiungi": allergie ed esami restano nel modello. */
export const HISTORY_KINDS = ["patologia", "farmaco", "intervento", "trauma"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

const LABEL_MAX = 200;
const NOTE_MAX = 500;
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;

/**
 * Una voce dell'anamnesi remota, nuova senza `itemId`, modificata con. `riskTags` assente: per un
 * farmaco nuovo si accendono da soli dalla lista TAO e NAO, per una voce modificata restano quelli
 * salvati; presente (anche vuoto) vince sempre, perché l'osteopata li toglie o li mette a mano.
 */
export const HistoryItemInput = z
  .object(
    {
      patientId,
      itemId: z.uuid({ error: INVALID }).optional(),
      kind: z.enum(HISTORY_KINDS, { error: INVALID }),
      label: z
        .string({ error: REQUIRED })
        .trim()
        .min(1, { error: REQUIRED })
        .max(LABEL_MAX, { error: maxChars(LABEL_MAX) }),
      region: z.enum(REGION_CODES as readonly [string, ...string[]], { error: INVALID }).nullable(),
      occurredOn: optionalText(z.iso.date({ error: DATE })),
      occurredYear: boundedInt(YEAR_MIN, YEAR_MAX, YEAR),
      ongoing: z.boolean({ error: INVALID }),
      riskTags: z
        .array(z.enum(RISK_TAGS, { error: INVALID }), { error: INVALID })
        .transform((tags) => [...new Set(tags)])
        .optional(),
      note: limitedText(NOTE_MAX),
    },
    { error: INVALID },
  )
  .strict();
export type HistoryItemInput = z.input<typeof HistoryItemInput>;

/** "Togli" su una voce. */
export const HistoryItemIdInput = z.object({ patientId, itemId: z.uuid({ error: INVALID }) }, { error: INVALID }).strict();
export type HistoryItemIdInput = z.input<typeof HistoryItemIdInput>;

// Anamnesi per apparati ------------------------------------------------------------------------------

const SYSTEM_NOTE_MAX = 300;
const SYSTEM_CODES = SYSTEMS.map((s) => s.code) as [string, ...string[]];

const SystemRow = z
  .object(
    {
      system: z.enum(SYSTEM_CODES, { error: INVALID }),
      status: z.enum(["nulla", "da_segnalare"], { error: INVALID }),
      note: limitedText(SYSTEM_NOTE_MAX),
    },
    { error: INVALID },
  )
  .strict();

/** Gli 8 apparati insieme, ciascuno una volta (`reviewedOn` è il giorno della visita). */
export const SystemsReviewInput = z
  .object(
    {
      patientId,
      reviewedOn: z.string({ error: REQUIRED }).trim().pipe(z.iso.date({ error: DATE })),
      rows: z.array(SystemRow, { error: INVALID }).length(SYSTEMS.length, { error: INVALID }),
    },
    { error: INVALID },
  )
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set(value.rows.map((row) => row.system));
    if (seen.size !== SYSTEMS.length) ctx.addIssue({ code: "custom", message: INVALID, path: ["rows"] });
  });
export type SystemsReviewInput = z.input<typeof SystemsReviewInput>;

// Stile di vita --------------------------------------------------------------------------------------

const LIFESTYLE_TEXT_MAX = 500;

/** `reviewedOn` è il giorno della visita (scelto dall'utente, come negli apparati). Le settimane stanno fra 1 e 42 (lo stesso check del database); che ci sia una gravidanza «In corso» lo controlla il comando. */
export const LifestyleInput = z
  .object(
    {
      patientId,
      reviewedOn: z.string({ error: REQUIRED }).trim().pipe(z.iso.date({ error: DATE })),
      occupation: limitedText(LIFESTYLE_TEXT_MAX),
      sport: limitedText(LIFESTYLE_TEXT_MAX),
      familyHistory: limitedText(LIFESTYLE_TEXT_MAX),
      pregnancyStatus: z.enum(["no", "in_corso", "post_partum"], { error: INVALID }).nullable(),
      pregnancyWeeks: boundedInt(1, 42, PREGNANCY_WEEKS_TEXT),
    },
    { error: INVALID },
  )
  .strict();
export type LifestyleInput = z.input<typeof LifestyleInput>;

// Anamnesi perinatale --------------------------------------------------------------------------------

const NOTES_MAX = 1000;

/** `numeric(4, 1)`: da 0 a 72 con al massimo un decimale (altrimenti il database arrotonderebbe in silenzio). */
const labourHours = z
  .number({ error: INVALID })
  .min(0, { error: INVALID })
  .max(72, { error: INVALID })
  .refine((hours) => Math.round(hours * 10) / 10 === hours, { error: INVALID })
  .nullable();

/** Gli stessi limiti e vocabolari dei check di `perinatal_histories`. */
export const PerinatalInput = z
  .object(
    {
      patientId,
      gestationalAgeWeeks: boundedInt(22, 44),
      birthWeightG: boundedInt(300, 6500),
      deliveryMode: z
        .enum(["spontaneo", "operativo_ventosa", "operativo_forcipe", "cesareo_programmato", "cesareo_urgente"], { error: INVALID })
        .nullable(),
      presentation: z.enum(["cefalica", "podalica", "trasversa", "altro"], { error: INVALID }).nullable(),
      labourHours,
      apgar1: boundedInt(0, 10),
      apgar5: boundedInt(0, 10),
      nicuStay: triState,
      suctionDifficulty: triState,
      plagiocephalyNoted: triState,
      torticollisNoted: triState,
      colic: triState,
      reflux: triState,
      feeding: z.enum(["seno", "artificiale", "misto"], { error: INVALID }).nullable(),
      preferredHeadSide: z.enum(["dx", "sx", "nessuna"], { error: INVALID }).nullable(),
      notes: limitedText(NOTES_MAX),
    },
    { error: INVALID },
  )
  .strict();
export type PerinatalInput = z.input<typeof PerinatalInput>;
