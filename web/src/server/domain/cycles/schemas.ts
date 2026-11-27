import { z } from "zod";
import { REGION_CODES, type RegionCode } from "@/lib/clinical/catalog";

// L'input di "Apri un ciclo". Lo schema è `.strict()`:
// una chiave in più (`status`, `openedOn`, `practiceId`) è rifiutata, così il chiamante non arriva
// mai alle colonne che decide il comando. I vincoli sono quelli dei check di `treatment_cycles`,
// controllati prima con il testo del campo.

const REQUIRED = "Campo obbligatorio.";
const DAY = "Scrivi la data nel formato 22/10/2026.";
// Un valore che il chiamante non produce (scelta fuori elenco, numero fuori dai limiti, chiave in
// più): lo stesso testo del 23514.
export const INVALID = "Valore non valido";

const TITLE_MAX = 80;
const EXPECTED_SESSIONS_MAX = 20;

export const OpenCycleInput = z
  .object(
    {
      patientId: z.uuid({ error: INVALID }),
      kind: z.enum(["trattamento", "mantenimento"], { error: INVALID }),
      /** Il giorno del primo appuntamento: l'apertura del ciclo non lo supera. */
      firstAppointmentDay: z.iso.date({ error: DAY }),
      expectedSessions: z
        .int({ error: INVALID })
        .min(1, { error: INVALID })
        .max(EXPECTED_SESSIONS_MAX, { error: INVALID })
        .optional(),
      // Lo passa solo il seed; dall'agenda il titolo è "Nuovo ciclo, {mese anno}".
      title: z
        .string({ error: REQUIRED })
        .trim()
        .min(1, { error: REQUIRED })
        .max(TITLE_MAX, { error: `Massimo ${TITLE_MAX} caratteri.` })
        .optional(),
    },
    { error: INVALID },
  )
  .strict();
export type OpenCycleInput = z.input<typeof OpenCycleInput>;

// La parte clinica del ciclo: i campi
// d'apertura alla prima visita, le attività PSFS, la ricaduta e la chiusura. I limiti sono quelli dei
// check di `treatment_cycles`, `psfs_items` e `psfs_scores`; le regole che guardano lo stato del ciclo,
// le visite o la data di oggi sono dei comandi.

const maxChars = (n: number): string => `Massimo ${n} caratteri.`;

const blankToNull = (value: string | null): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

/** Un testo facoltativo: "" e null diventano null, il resto si salva senza spazi ai lati. */
const limitedText = (max: number) =>
  z
    .string({ error: INVALID })
    .nullable()
    .transform(blankToNull)
    .pipe(z.string().max(max, { error: maxChars(max) }).nullable());

const optionalDay = z.iso.date({ error: DAY }).nullable();

const cycleId = z.uuid({ error: INVALID });

/**
 * I campi d'apertura del ciclo. Ogni chiave è facoltativa: una chiave che manca non
 * cambia la colonna, `null` (o "" per un testo) la svuota. `planAgreedOn` è il giorno della visita in
 * cui si spunta "Piano spiegato e accettato dal paziente", mai l'orologio.
 */
export const CycleOpeningInput = z
  .object(
    {
      cycleId,
      chiefComplaint: limitedText(500).optional(),
      mainRegion: z.enum(REGION_CODES as readonly [RegionCode, ...RegionCode[]], { error: INVALID }).nullable().optional(),
      onsetOn: optionalDay.optional(),
      onsetMode: z.enum(["acuto", "graduale", "post_traumatico", "ricorrente"], { error: INVALID }).nullable().optional(),
      medicalDiagnosisText: limitedText(300).optional(),
      medicalDiagnosisSource: z
        .enum(["referto_allegato", "riferita_dal_paziente", "assente"], { error: INVALID })
        .optional(),
      referringPhysicianId: z.uuid({ error: INVALID }).nullable().optional(),
      selfReferred: z.boolean({ error: INVALID }).optional(),
      goal: limitedText(300).optional(),
      expectedSessions: z
        .int({ error: INVALID })
        .min(1, { error: INVALID })
        .max(EXPECTED_SESSIONS_MAX, { error: INVALID })
        .optional(),
      planNote: limitedText(1000).optional(),
      planAgreedOn: optionalDay.optional(),
    },
    { error: INVALID },
  )
  .strict();
export type CycleOpeningInput = z.input<typeof CycleOpeningInput>;

const PSFS_ACTIVITY_MAX = 120;

const activity = z
  .string({ error: REQUIRED })
  .trim()
  .min(1, { error: REQUIRED })
  .max(PSFS_ACTIVITY_MAX, { error: maxChars(PSFS_ACTIVITY_MAX) });

/** "Aggiungi attività" (PSFS): fino a 3 per ciclo. */
export const PsfsAddInput = z.object({ id: z.uuid({ error: INVALID }).optional(), cycleId, activity }, { error: INVALID }).strict();
export type PsfsAddInput = z.input<typeof PsfsAddInput>;

/** Rinomina di un'attività. */
export const PsfsRenameInput = z.object({ itemId: z.uuid({ error: INVALID }), activity }, { error: INVALID }).strict();
export type PsfsRenameInput = z.input<typeof PsfsRenameInput>;

/** "Togli" su un'attività. */
export const PsfsItemIdInput = z.object({ itemId: z.uuid({ error: INVALID }) }, { error: INVALID }).strict();
export type PsfsItemIdInput = z.input<typeof PsfsItemIdInput>;

/** «Sì, è una ricaduta»: il ciclo aperto e il ciclo chiuso che riprende. */
export const RelapseInput = z
  .object({ cycleId, previousCycleId: z.uuid({ error: INVALID }) }, { error: INVALID })
  .strict();
export type RelapseInput = z.input<typeof RelapseInput>;

const RECALL_WEEKS_MIN = 2;
const RECALL_WEEKS_MAX = 52;
const PSFS_SCORE_MAX = 10;

const FinalScore = z
  .object(
    {
      itemId: z.uuid({ error: INVALID }),
      score: z.int({ error: INVALID }).min(0, { error: INVALID }).max(PSFS_SCORE_MAX, { error: INVALID }),
    },
    { error: INVALID },
  )
  .strict();

/**
 * "Chiudi ciclo". `finalScores` sono i punteggi finali delle attività PSFS
 * del ciclo, oppure "non_tornato" ("Paziente non tornato": nessun punteggio finale). `recall` è la
 * cadenza in settimane (2-52) oppure "nessuno" («Nessun richiamo»: pausa, cadenza invariata).
 * `closedOn` lo sceglie l'utente (predefinito oggi), mai l'orologio.
 */
export const CloseCycleInput = z
  .object(
    {
      cycleId,
      outcome: z.enum(
        ["raggiunto", "parzialmente_raggiunto", "non_raggiunto", "interrotto_dal_paziente", "rinviato_al_medico"],
        { error: INVALID },
      ),
      outcomeNote: limitedText(1000).optional(),
      closedOn: z.iso.date({ error: DAY }),
      finalScores: z.union([z.array(FinalScore, { error: INVALID }), z.literal("non_tornato", { error: INVALID })], {
        error: INVALID,
      }),
      recall: z.union(
        [
          z
            .object(
              {
                weeks: z
                  .int({ error: INVALID })
                  .min(RECALL_WEEKS_MIN, { error: INVALID })
                  .max(RECALL_WEEKS_MAX, { error: INVALID }),
              },
              { error: INVALID },
            )
            .strict(),
          z.literal("nessuno", { error: INVALID }),
        ],
        { error: INVALID },
      ),
    },
    { error: INVALID },
  )
  .strict();
export type CloseCycleInput = z.input<typeof CloseCycleInput>;
