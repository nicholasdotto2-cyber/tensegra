import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { snoozeDay } from "./recall";
import { PatientIdInput } from "./schemas";

// Rinvio e sospensione dei richiami. «Rimanda di 2 settimane»
// scrive soltanto «non mostrare prima di» (`recall_snoozed_until`), mai la data clinica, che resta l'ultimo
// fatto più la cadenza. «Sospendi i richiami» non ha un comando suo: è `setRecall` con le settimane attuali.
// Un nuovo fatto (appuntamenti) o una cadenza diversa (`setRecall`) azzerano il rinvio con `clearRecallSnooze`.

/** «Rimanda di 2 settimane»: oggi + 14 giorni; ripetuto lo stesso giorno scrive lo stesso giorno. */
export async function snoozeRecall(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { patientId } = PatientIdInput.parse(input);
  const rows = await tx.query(
    "update public.patients set recall_snoozed_until = $3 where practice_id = $1 and id = $2 returning id",
    [practiceId, patientId, snoozeDay(clock.today())],
  );
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

/** Le settimane attuali del richiamo, per sospendere senza perderle; null se il paziente non c'è o è di un altro studio. */
export async function recallWeeksOf(tx: Tx, practiceId: string, patientId: string): Promise<{ weeks: number | null } | null> {
  const [row] = await tx.query<{ weeks: number | null }>(
    "select recall_interval_weeks as weeks from public.patients where practice_id = $1 and id = $2",
    [practiceId, patientId],
  );
  return row ?? null;
}

/** Un nuovo fatto ricalcola la data del richiamo: il rinvio di prima non vale più. */
export async function clearRecallSnooze(tx: Tx, practiceId: string, patientId: string): Promise<void> {
  await tx.query(
    "update public.patients set recall_snoozed_until = null where practice_id = $1 and id = $2 and recall_snoozed_until is not null",
    [practiceId, patientId],
  );
}
