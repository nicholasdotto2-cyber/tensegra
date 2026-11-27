import { z } from "zod";
import { AGENDA_FIRST_DAY, AGENDA_LAST_DAY } from "@/lib/agenda/grid";
import { NewPatientInput } from "@/server/domain/patients/schemas";

// Gli input del dialogo "Nuovo appuntamento" e della sua anteprima.
// Ogni schema è `.strict()`, anche negli oggetti annidati: una chiave in più (`practiceId`,
// `seriesId`, `statusChangedAt`, `taxCode` del paziente nuovo) è rifiutata, così il modulo non
// arriva mai alle colonne che scrive solo il comando. I vincoli sono quelli dei check di
// `appointments` e `appointment_series`, controllati prima con il testo del campo; le regole che
// guardano la data di oggi o il database (fatto nel passato, fine nello stesso giorno, paziente
// archiviato) sono del comando, che riceve il `Clock`.

const PATIENT = "Scegli il paziente.";
const SERVICE = "Scegli la prestazione.";
const DAY = "Scrivi la data nel formato 22/10/2026.";
const QUARTER_STEP = "Scegli un orario a passi di 15 minuti.";
const maxChars = (n: number): string => `Massimo ${n} caratteri.`;
// Un valore che il modulo non produce (scelta fuori elenco, numero fuori dai limiti, chiave in
// più): lo stesso testo del 23514.
export const INVALID = "Valore non valido";

// Gli stessi limiti dei check del database: durata a passi di 15 (il dialogo arriva a 120),
// prezzo come in `services`, note organizzative di 300 caratteri, serie da 2 a 12 ogni 1-4 settimane.
const DURATIONS = [15, 30, 45, 60, 75, 90, 105, 120] as const;
const PRICE_MAX_CENTS = 999_999;
const NOTES_MAX = 300;
const INTERVAL_WEEKS_MAX = 4;
const SERIES_MIN = 2;
const SERIES_MAX = 12;

// "HH:MM" a quarti d'ora da 00:00 a 23:45: la fine alle 00:00 la rifiuta il comando.
const QUARTER_TIME = /^([01]\d|2[0-3]):(00|15|30|45)$/;

const between = (min: number, max: number) =>
  z.int({ error: INVALID }).min(min, { error: INVALID }).max(max, { error: INVALID });

const uuid = z.uuid({ error: INVALID });
// Gli stessi limiti del dialogo e dell'agenda: un giorno fuori non si vedrebbe mai in agenda.
const day = z.iso
  .date({ error: DAY })
  .refine((d) => d >= AGENDA_FIRST_DAY && d <= AGENDA_LAST_DAY, { error: DAY });
const time = z.string({ error: QUARTER_STEP }).regex(QUARTER_TIME, { error: QUARTER_STEP });
const durationMin = z.literal(DURATIONS, { error: INVALID });

/** Un paziente scelto dal selettore, o il mini modulo "Nuovo paziente". */
const PatientChoice = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("existing"), patientId: z.uuid({ error: PATIENT }) }, { error: INVALID }).strict(),
    NewPatientInput.extend({ kind: z.literal("new") }),
  ],
  { error: PATIENT },
);

/** Il ciclo aperto del paziente, o un ciclo nuovo che il comando apre. */
const CycleChoice = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("existing"), cycleId: uuid }, { error: INVALID }).strict(),
    z.object({ kind: z.literal("new") }, { error: INVALID }).strict(),
  ],
  { error: INVALID },
);

/** Note organizzative, mai cliniche: "" e solo spazi diventano null. */
const notes = z
  .string({ error: INVALID })
  .trim()
  .max(NOTES_MAX, { error: maxChars(NOTES_MAX) })
  .transform((value) => (value === "" ? null : value))
  .optional();

/**
 * L'appuntamento del dialogo. Con `repeat` è una serie: stesso giorno della settimana ogni
 * `intervalWeeks` settimane per `count` date in totale, meno `excludedDays` (le righe
 * dell'anteprima tolte). Gli errori dei campi del paziente nuovo stanno sotto `patient.` (per
 * esempio `patient.birthDate`), «Scegli almeno una data.» sta su `repeat.excludedDays`.
 */
export const NewAppointmentInput = z
  .object(
    {
      patient: PatientChoice,
      serviceId: z.uuid({ error: SERVICE }),
      day,
      time,
      durationMin,
      cycle: CycleChoice,
      priceCents: between(0, PRICE_MAX_CENTS),
      status: z.enum(["prenotato", "confermato", "fatto"], { error: INVALID }),
      notes,
      repeat: z
        .object(
          {
            intervalWeeks: between(1, INTERVAL_WEEKS_MAX),
            count: between(SERIES_MIN, SERIES_MAX),
            excludedDays: z.array(day, { error: INVALID }),
          },
          { error: INVALID },
        )
        .strict()
        .optional(),
    },
    { error: INVALID },
  )
  .strict();
export type NewAppointmentInput = z.input<typeof NewAppointmentInput>;

/**
 * L'anteprima del dialogo: gli avvisi della data scelta e, con `repeat`, una riga per
 * ogni data della serie. `ignoreAppointmentId` lascia fuori l'appuntamento che si sta modificando.
 */
export const PreviewInput = z
  .object(
    {
      day,
      time,
      durationMin,
      repeat: z
        .object({ intervalWeeks: between(1, INTERVAL_WEEKS_MAX), count: between(SERIES_MIN, SERIES_MAX) }, { error: INVALID })
        .strict()
        .optional(),
      ignoreAppointmentId: uuid.optional(),
    },
    { error: INVALID },
  )
  .strict();
export type PreviewInput = z.input<typeof PreviewInput>;

/** I default del paziente scelto nel dialogo. */
export const BookingDefaultsInput = z.object({ patientId: uuid }, { error: INVALID }).strict();

/** L'orario proposto per "Nuovo appuntamento" con una durata. */
export const SuggestStartInput = z.object({ durationMin }, { error: INVALID }).strict();

/** La prossima seduta del pannello "Seduta fatta" di un appuntamento. */
export const NextSessionInput = z.object({ appointmentId: uuid }, { error: INVALID }).strict();

// I cambi di stato, la modifica e il metodo di pagamento.

const CHOOSE_REASON = "Scegli il motivo.";

/** Un appuntamento: "Segna confermato", "Segna come fatta", "Saltato", "Annulla 'fatto'", "Ripristina", "Annulla 'saltato'", "Elimina". */
export const AppointmentIdInput = z.object({ id: uuid }, { error: INVALID }).strict();

/** "Annulla appuntamento": il motivo è obbligatorio; `alsoFollowing` annulla anche le successive della serie. */
export const CancelInput = z
  .object(
    {
      id: uuid,
      reason: z.enum(["paziente", "studio", "altro"], { error: CHOOSE_REASON }),
      alsoFollowing: z.boolean({ error: INVALID }),
    },
    { error: INVALID },
  )
  .strict();

/**
 * "Modifica": paziente e ciclo restano quelli dell'appuntamento (una chiave in più,
 * come `patientId` o `cycleId`, è rifiutata), nessuna ripetizione, stato solo prenotato o confermato.
 * `expectedUpdatedAt` è l'`updated_at` letto quando il dialogo si è aperto, in ISO. Le note
 * sostituiscono quelle salvate: assenti, "" o solo spazi tolgono la nota.
 */
export const EditAppointmentInput = z
  .object(
    {
      id: uuid,
      expectedUpdatedAt: z.iso.datetime({ offset: true, error: INVALID }),
      serviceId: z.uuid({ error: SERVICE }),
      day,
      time,
      durationMin,
      priceCents: between(0, PRICE_MAX_CENTS),
      status: z.enum(["prenotato", "confermato"], { error: INVALID }),
      notes,
    },
    { error: INVALID },
  )
  .strict();
export type EditAppointmentInput = z.input<typeof EditAppointmentInput>;

/** Il metodo scelto nel passo 1 del pannello "Seduta fatta"; null è "Non ancora incassato". */
export const PaymentMethodInput = z
  .object(
    { id: uuid, method: z.enum(["contanti", "carta", "bonifico"], { error: INVALID }).nullable() },
    { error: INVALID },
  )
  .strict();

// Lo stato dell'agenda nell'URL: `/agenda?vista=settimana&data=2026-10-22`,
// più `annullati=1` per "Mostra annullati". Un valore non valido (una vista che non c'è, un giorno che
// non esiste, un parametro ripetuto) si ignora e vale il default: la settimana di oggi, annullati nascosti.

type SearchParams = Record<string, string | string[] | undefined>;

const AGENDA_VIEWS = ["giorno", "settimana"] as const;
const agendaDay = z.iso
  .date()
  .refine((d) => d >= AGENDA_FIRST_DAY && d <= AGENDA_LAST_DAY);

/** Il solo valore di un parametro scritto una volta; ripetuto (`?data=a&data=b`) non vale. */
const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

export function parseAgendaParams(
  sp: SearchParams,
  today: string,
): { view: "giorno" | "settimana"; day: string; showCancelled: boolean } {
  const view = z.enum(AGENDA_VIEWS).safeParse(single(sp.vista));
  const day = agendaDay.safeParse(single(sp.data));
  return {
    view: view.success ? view.data : "settimana",
    day: day.success ? day.data : today,
    showCancelled: single(sp.annullati) === "1",
  };
}
