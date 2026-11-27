import { isActive } from "@/lib/agenda/status";
import { timeOf, weekdayDayNumeric } from "@/lib/format";
import { DEMO_PRACTICE_ID, getActor } from "@/server/auth/actor";
import { type Clock, fixedClock, todayRome } from "@/server/clock";
import type { Db } from "@/server/db/db";
import { listDayAppointments, listReminders } from "@/server/domain/appointments/queries";
import { listMissingConsents } from "@/server/domain/consents/queries";
import { listToInvoice } from "@/server/domain/invoices/queries";
import { listTodayRecalls } from "@/server/domain/patients/queries";
import { getPracticeSettings } from "@/server/domain/settings/queries";
import { getShellStatus } from "@/server/domain/shell/queries";

export interface DemoCheckCounts {
  appointments: number;
  missingConsents: number;
  toInvoice: number;
  reminders: number;
  recalls: number;
}

export const DEMO_EXPECTED: DemoCheckCounts = {
  appointments: 5, missingConsents: 2, toInvoice: 2, reminders: 3, recalls: 2,
};

const LABELS: Record<keyof DemoCheckCounts, string> = {
  appointments: "Appuntamenti di oggi",
  missingConsents: "Consensi mancanti",
  toInvoice: "Fatture da emettere",
  reminders: "Promemoria per domani",
  recalls: "Da richiamare",
};

/** Messaggio pronto per il comando, senza dettagli tecnici. */
export class DemoCheckError extends Error {}

/** Le stesse letture di Oggi, come utente demo e a un solo istante. */
export async function demoCheck(db: Db, clock: Clock): Promise<{ lines: string[]; ok: boolean }> {
  const at = fixedClock(clock.now());
  return db.asUser(getActor(), async (tx) => {
    const practiceId = DEMO_PRACTICE_ID;
    if (!(await getPracticeSettings(tx, practiceId))) {
      throw new DemoCheckError("Nessun dato demo: esegui pnpm db:seed.");
    }
    const { demoSeededAt } = await getShellStatus(tx, practiceId, at);
    if (!demoSeededAt) throw new DemoCheckError("Nessun dato demo: esegui pnpm db:seed.");
    const counts: DemoCheckCounts = {
      appointments: (await listDayAppointments(tx, practiceId, at, at.today())).filter((row) => isActive(row.status)).length,
      missingConsents: (await listMissingConsents(tx, practiceId, at)).length,
      toInvoice: (await listToInvoice(tx, practiceId, at)).length,
      reminders: (await listReminders(tx, practiceId, at)).rows.length,
      recalls: (await listTodayRecalls(tx, practiceId, at)).rows.length,
    };
    const seededDay = todayRome(demoSeededAt);
    const fresh = seededDay === at.today();
    const lines = [fresh
      ? `Dati di prova creati oggi alle ${timeOf(demoSeededAt)}.`
      : `I dati di prova sono di ${weekdayDayNumeric(seededDay)}: esegui pnpm demo:prep oppure "Ricrea per oggi".`];
    let ok = fresh;
    const differences: string[] = [];
    for (const key of Object.keys(LABELS) as (keyof DemoCheckCounts)[]) {
      lines.push(`${LABELS[key]}: ${counts[key]}`);
      if (counts[key] !== DEMO_EXPECTED[key]) {
        ok = false;
        differences.push(`Atteso ${DEMO_EXPECTED[key]}, trovato ${counts[key]}: ${LABELS[key]}.`);
      }
    }
    lines.push(...differences);
    if (ok) lines.push("Pronto per la demo.");
    return { lines, ok };
  });
}
