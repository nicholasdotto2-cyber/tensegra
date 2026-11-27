import { DEMO_PRACTICE_ID } from "@/server/auth/actor";
import { type Clock, fixedClock } from "@/server/clock";
import type { Db } from "@/server/db/db";
import { asService } from "@/server/db/service";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import type { FileStore } from "@/server/files/store";
import { DEMO_PRACTICE_NAME, prepareSeedAssets, removeSeedAssets, seedPracticeData } from "../../../seed/demo";

// "Ricrea i dati di prova". L'unico modulo fuori da src/server/db che
// importa service.ts: in una sola transazione come servizio apre i trigger di immutabilità dello studio demo
// (`app.purge_practice`, mai per `authenticated`), cancella le sue righe dai figli ai genitori e rifà il seed
// con `seedPracticeData`. Utente, studio e membership restano. I file dei consensi e le sagome nuove vanno
// nello store prima della transazione; quelli vecchi si tolgono solo dopo il commit.

const P = DEMO_PRACTICE_ID;

/**
 * Le tabelle con `practice_id` che la purga svuota, dai figli ai genitori. `practices` e
 * `memberships` restano. Il test `purge_copre_ogni_tabella` lo confronta con il catalogo: una tabella nuova
 * senza voce lo rompe.
 */
export const PURGE_TABLES: readonly string[] = [
  "invoice_events",
  "invoice_lines",
  "invoices",
  "billing_parties",
  "fiscal_exports",
  "message_log",
  "consent_choices",
  "consent_records",
  "referrals",
  "patient_attachments",
  "psfs_scores",
  "visit_advice",
  "visit_amendments",
  "visit_region_findings",
  "visit_screening_answers",
  "visit_screening_outcomes",
  "visit_test_results",
  "visit_treatments",
  "visits",
  "psfs_items",
  "appointments",
  "appointment_series",
  "treatment_cycles",
  "patient_guardians",
  "patient_history_items",
  "patient_lifestyle",
  "patient_systems_review",
  "perinatal_histories",
  "patients",
  "physicians",
  "services",
  "practice_settings",
  "files",
  "message_templates",
  "opening_hours",
  "clinical_settings",
  "fiscal_settings",
  "number_series",
];

/**
 * Ricrea i dati dello studio demo per il giorno di `seedClock`. Ammessa solo con
 * `opts.demoMode` (`loadConfig().demoMode` di chi chiama) e lo studio demo segnato `is_demo`: altrimenti
 * `NOT_ALLOWED` senza aver scritto niente. Se la transazione fallisce i dati e i file di prima
 * restano, e si tolgono solo i file preparati da questo tentativo.
 */
export async function recreateDemoData(
  db: Db,
  store: FileStore,
  seedClock: Clock,
  opts: { demoMode: boolean },
): Promise<void> {
  if (!opts.demoMode) throw new DomainError(NOT_ALLOWED);
  const [settings] = await asService(db, (tx) =>
    tx.query<{ is_demo: boolean }>("select is_demo from public.practice_settings where practice_id = $1", [P]),
  );
  if (settings?.is_demo !== true) throw new DomainError(NOT_ALLOWED);

  // La prima lettura si congela per tutta la ricreazione, come in `seedDemo`.
  const clock = fixedClock(seedClock.now());
  const assets = await prepareSeedAssets(clock.today(), store);
  let oldKeys: string[];
  try {
    oldKeys = await asService(db, async (tx) => {
      await tx.query("select set_config('app.purge_practice', $1, true)", [P]);
      const files = await tx.query<{ storage_key: string }>(
        "select storage_key from public.files where practice_id = $1",
        [P],
      );
      // Le fatture e le note di credito si puntano a vicenda.
      await tx.query("update public.invoices set credit_note_id = null where practice_id = $1", [P]);
      for (const table of PURGE_TABLES) {
        await tx.query(`delete from public."${table}" where practice_id = $1`, [P]);
      }
      await tx.query("update public.practices set name = $2 where id = $1", [P, DEMO_PRACTICE_NAME]);
      await seedPracticeData(tx, clock, assets);
      return files.map((f) => f.storage_key);
    });
  } catch (error) {
    // Un errore della pulizia non nasconde quello della ricreazione: al più resta un file orfano.
    await removeSeedAssets(store, assets).catch(() => {});
    throw error;
  }

  // Dopo il commit, solo i file vecchi: quelli nuovi sono già nello store e nelle righe di `files`.
  for (const key of oldKeys) {
    try {
      await store.remove(key);
    } catch (error) {
      console.error(`[app] recreateDemoData: file vecchio non tolto: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
