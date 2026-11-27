import { z } from "zod";
import { VIEW_LABEL } from "@/lib/clinical/labels";

// I campi di "Carica foto": vista obbligatoria, data scelta
// dall'utente, didascalia fino a 200 caratteri come il check di `patient_attachments.caption`.
// `.strict()`: il chiamante non arriva a studio, tipo né file, che decide il comando.

const DAY = "Scrivi la data nel formato 22/10/2026.";
const CHOOSE_VIEW = "Scegli la vista.";
// Un valore che il chiamante non produce: lo stesso testo del 23514.
const INVALID = "Valore non valido";
const CAPTION_MAX = 200;

const VIEWS = Object.keys(VIEW_LABEL) as [keyof typeof VIEW_LABEL, ...(keyof typeof VIEW_LABEL)[]];

const pixels = z.int({ error: INVALID }).min(1, { error: INVALID }).optional();

export const PhotoFieldsInput = z
  .object(
    {
      patientId: z.uuid({ error: INVALID }),
      view: z.enum(VIEWS, { error: (issue) => (issue.input === undefined ? CHOOSE_VIEW : INVALID) }),
      takenOn: z.iso.date({ error: DAY }),
      // Vuota vale come assente.
      caption: z
        .string({ error: INVALID })
        .trim()
        .max(CAPTION_MAX, { error: `Massimo ${CAPTION_MAX} caratteri.` })
        .transform((text) => (text === "" ? null : text))
        .optional(),
      cycleId: z.uuid({ error: INVALID }).optional(),
      visitId: z.uuid({ error: INVALID }).optional(),
      widthPx: pixels,
      heightPx: pixels,
    },
    { error: INVALID },
  )
  .strict();
export type PhotoFieldsInput = z.input<typeof PhotoFieldsInput>;

export const RemoveAttachmentInput = z.object({ attachmentId: z.uuid({ error: INVALID }) }, { error: INVALID }).strict();
export type RemoveAttachmentInput = z.input<typeof RemoveAttachmentInput>;
