import { dayField } from "@/lib/format";
import { addDaysRome, daysBetween } from "@/server/clock";

// Il richiamo: data dell'ultimo appuntamento fatto più la cadenza in
// settimane, calcolata e mai salvata; il testo della scadenza conta i giorni di calendario da oggi.
// Il rinvio dice solo «non mostrare prima di», mai la data clinica; dopo un
// richiamo inviato la riga resta 14 giorni in attesa, contati a giorni di calendario.

/** Il giorno del richiamo: `lastDoneDay` + `weeks` settimane, a giorni di calendario. */
export function recallDay(lastDoneDay: string, weeks: number): string {
  return addDaysRome(lastDoneDay, 7 * weeks);
}

/** "Scaduto da 10 giorni", "Scaduto ieri", "Scade oggi", "Scade domani", "Fra 3 giorni". */
export function recallDueText(dueDay: string, today: string): string {
  const days = daysBetween(today, dueDay);
  if (days < -1) return `Scaduto da ${-days} giorni`;
  if (days === -1) return "Scaduto ieri";
  if (days === 0) return "Scade oggi";
  if (days === 1) return "Scade domani";
  return `Fra ${days} giorni`;
}

const SNOOZE_DAYS = 14;
const WAIT_DAYS = 14;

/** «Rimanda di 2 settimane» da oggi: lo stesso giorno dà sempre lo stesso rinvio, non si accumula. */
export function snoozeDay(today: string): string {
  return addDaysRome(today, SNOOZE_DAYS);
}

/** Un richiamo rinviato non si mostra prima del giorno del rinvio; quel giorno torna. */
export function recallVisible(snoozedUntil: string | null, today: string): boolean {
  return snoozedUntil === null || today >= snoozedUntil;
}

// "22/10" da "22/10/2026".
const dayMonth = (day: string): string => dayField(day).slice(0, 5);

/**
 * L'attesa dopo un richiamo inviato il giorno `sentDay`: «In attesa di risposta» fino al
 * giorno prima di `sentDay` + 14 compreso (`waitingUntil`), poi «Richiamato il 22/10, nessuna risposta».
 */
export function recallWait(
  sentDay: string | null,
  today: string,
): { waitingUntil: string | null; waitingText: string | null } {
  if (sentDay === null) return { waitingUntil: null, waitingText: null };
  const lastWaitingDay = addDaysRome(sentDay, WAIT_DAYS - 1);
  if (today <= lastWaitingDay) return { waitingUntil: lastWaitingDay, waitingText: "In attesa di risposta" };
  return { waitingUntil: null, waitingText: `Richiamato il ${dayMonth(sentDay)}, nessuna risposta` };
}

export type GuardianRelationship = "madre" | "padre" | "tutore" | "altro";

const REVOKED_BY: Record<GuardianRelationship, string> = {
  madre: "dalla madre",
  padre: "dal padre",
  tutore: "dal tutore",
  altro: "dal genitore",
};

/**
 * «Consenso ai richiami revocato dalla madre il 15/09»: chi l'ha data si deduce dal genitore di contatto di
 * un minore alla data della revoca (`relationship`), non da una colonna; null per un adulto o un minore
 * senza contatto.
 */
export function recallRevokedText(revokedOn: string, relationship: GuardianRelationship | null): string {
  const by = relationship === null ? "" : ` ${REVOKED_BY[relationship]}`;
  return `Consenso ai richiami revocato${by} il ${dayMonth(revokedOn)}`;
}
