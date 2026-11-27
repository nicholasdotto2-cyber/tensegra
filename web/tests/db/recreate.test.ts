import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isActive } from "@/lib/agenda/status";
import { DEMO_PRACTICE_ID, getActor } from "@/server/auth/actor";
import { type Clock, fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { PURGE_TABLES, recreateDemoData } from "@/server/demo/recreate";
import { markDone } from "@/server/domain/appointments/commands";
import { listDayAppointments } from "@/server/domain/appointments/queries";
import { closeCycle } from "@/server/domain/cycles/commands";
import { revokeConsent } from "@/server/domain/consents/commands";
import { NOT_ALLOWED } from "@/server/domain/errors";
import { cancelWithCreditNote, issueInvoice } from "@/server/domain/invoices/commands";
import { createPatient } from "@/server/domain/patients/commands";
import { getOpeningHours } from "@/server/domain/settings/queries";
import { amendVisit, startVisit } from "@/server/domain/visits/commands";
import { seedDemo } from "../../seed/demo";
import { asServiceFor, expectPgError, ident, openTestDb, setPurge } from "./helpers";
import { MemoryFileStore } from "./memory-store";

// "Ricrea i dati di prova": una transazione come servizio che
// purga le righe dello studio demo e rifà il seed con l'orologio dato. I conteggi attesi vengono da un
// database seminato da zero, mai dallo stato che la ricreazione ha appena scritto.

// Una spia sull'emissione: il seed la usa per le 23 fatture, quindi farla fallire una volta ferma
// `seedPracticeData` a metà, dentro la transazione della ricreazione.
vi.mock("@/server/domain/invoices/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/domain/invoices/commands")>();
  return { ...actual, issueInvoice: vi.fn(actual.issueInvoice) };
});

const P = DEMO_PRACTICE_ID;
const seedClock = fixedClock("2026-11-04T07:00:00+01:00");

/** Lo store di memoria che fallisce alla `put` numero `n` da quando si arma. */
class FailingStore extends MemoryFileStore {
  private countdown = 0;

  failAtPut(n: number): void {
    this.countdown = n;
  }

  override async put(key: string, bytes: Uint8Array): Promise<void> {
    if (this.countdown > 0) {
      this.countdown -= 1;
      if (this.countdown === 0) throw new Error("Scrittura del file fallita (prova).");
    }
    await super.put(key, bytes);
  }
}

let db: Db;
let pg: PGlite;
let store: FailingStore;

beforeEach(async () => {
  ({ db, pg } = await openTestDb());
  store = new FailingStore();
  await seedDemo(db, seedClock, store);
});

afterEach(async () => {
  await pg.close();
  vi.mocked(issueInvoice).mockClear();
});

/** Le righe dello studio demo in ogni tabella di `PURGE_TABLES`. */
function countsOf(target: Db): Promise<Record<string, number>> {
  return asServiceFor(target, async (tx) => {
    const counts: Record<string, number> = {};
    for (const table of PURGE_TABLES) {
      const [row] = await tx.query<{ n: number }>(
        `select count(*)::int as n from public.${ident(table)} where practice_id = $1`,
        [P],
      );
      counts[table] = row?.n ?? -1;
    }
    return counts;
  });
}

function numberSeriesOf(target: Db) {
  return asServiceFor(target, (tx) =>
    tx.query<{ series: string; year: number; last_number: number }>(
      "select series, year, last_number from public.number_series where practice_id = $1 order by series, year",
      [P],
    ),
  );
}

function fileRows(target: Db) {
  return asServiceFor(target, (tx) =>
    tx.query<{ storage_key: string; sha256: string }>(
      "select storage_key, sha256 from public.files where practice_id = $1 order by storage_key",
      [P],
    ),
  );
}

/** Conteggi e numeratori di un database nuovo seminato con `clock`. */
async function cleanSeed(clock: Clock): Promise<{ counts: Record<string, number>; series: unknown[] }> {
  const fresh = await openTestDb();
  try {
    await seedDemo(fresh.db, clock, new MemoryFileStore());
    return { counts: await countsOf(fresh.db), series: await numberSeriesOf(fresh.db) };
  } finally {
    await fresh.pg.close();
  }
}

const asDemo = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => db.asUser(getActor(), fn);

/** Uno scenario sporco con i comandi veri, come l'utente demo nell'app. */
async function dirtyScenario(): Promise<void> {
  const clock = fixedClock("2026-11-04T18:00:00+01:00");
  await asDemo(async (tx) => {
    // Emissione e nota di credito: due fatture che si puntano a vicenda.
    const [draft] = await tx.query<{ id: string }>(
      "select id from public.invoices where practice_id = $1 and status = 'bozza'",
      [P],
    );
    if (!draft) throw new Error("il seed non ha la bozza del committente");
    await issueInvoice(tx, P, clock, { invoiceId: draft.id });
    await cancelWithCreditNote(tx, P, clock, { invoiceId: draft.id, note: null });

    // Rettifica di una visita chiusa.
    const [visit] = await tx.query<{ id: string }>(
      `select v.id from public.visits v join public.patients p on p.id = v.patient_id
        where v.practice_id = $1 and v.status = 'closed' and p.first_name = 'Marco'`,
      [P],
    );
    if (!visit) throw new Error("il seed non ha la visita chiusa di Marco");
    await amendVisit(tx, P, clock, {
      visitId: visit.id,
      reason: "Piano scritto nella visita sbagliata",
      ops: [{ op: "campi", values: { planNext: "Controllo fra un mese" } }],
    });

    // Chiusura del ciclo di Giulia con i punteggi PSFS finali: la seduta di oggi alle 15:00 è passata, si segna
    // fatta e la sua visita, aperta in bozza, riceve i punteggi.
    const [cycle] = await tx.query<{ id: string }>(
      `select c.id from public.treatment_cycles c join public.patients p on p.id = c.patient_id
        where c.practice_id = $1 and c.status = 'open' and p.first_name = 'Giulia'`,
      [P],
    );
    if (!cycle) throw new Error("il seed non ha il ciclo aperto di Giulia");
    const [today] = await tx.query<{ id: string }>(
      `select id from public.appointments
        where practice_id = $1 and cycle_id = $2 and status = 'confermato' and starts_at < $3`,
      [P, cycle.id, clock.now()],
    );
    if (!today) throw new Error("il seed non ha la seduta di oggi di Giulia");
    await markDone(tx, P, clock, { id: today.id });
    await startVisit(tx, P, clock, { appointmentId: today.id });
    const items = await tx.query<{ id: string }>(
      "select id from public.psfs_items where practice_id = $1 and cycle_id = $2",
      [P, cycle.id],
    );
    expect(items.length).toBeGreaterThan(0);
    await closeCycle(tx, P, clock, {
      cycleId: cycle.id,
      outcome: "raggiunto",
      closedOn: clock.today(),
      finalScores: items.map((i) => ({ itemId: i.id, score: 9 })),
      recall: "nessuno",
    });

    // Revoca di un consenso.
    const [consent] = await tx.query<{ id: string }>(
      "select id from public.consent_records where practice_id = $1 and status = 'valido' order by id limit 1",
      [P],
    );
    if (!consent) throw new Error("il seed non ha un consenso valido");
    await revokeConsent(tx, P, clock, { id: consent.id, revokedOn: clock.today(), mode: "verbale", note: null });

    // Un nuovo paziente.
    await createPatient(tx, P, clock, {
      firstName: "Prova",
      lastName: "Ricrea",
      birthDate: "1990-05-12",
      phone: "333 000 9911",
    });
  });
}

describe("recreateDemoData", () => {
  it("purge_copre_ogni_tabella", async () => {
    const catalog = await asServiceFor(db, (tx) =>
      tx.query<{ name: string }>(
        `select distinct table_name as name from information_schema.columns
          where table_schema = 'public' and column_name = 'practice_id'
            and table_name not in ('practices', 'memberships')`,
      ),
    );
    expect(new Set(PURGE_TABLES)).toEqual(new Set(catalog.map((r) => r.name)));
    expect(PURGE_TABLES).toHaveLength(new Set(PURGE_TABLES).size);
  });

  it("ricrea_come_seed_pulito", async () => {
    const expected = await cleanSeed(seedClock);
    await dirtyScenario();
    expect(await countsOf(db)).not.toEqual(expected.counts);

    await recreateDemoData(db, store, seedClock, { demoMode: true });

    expect(await countsOf(db)).toEqual(expected.counts);
    expect(await numberSeriesOf(db)).toEqual(expected.series);
    const [practice] = await asServiceFor(db, (tx) =>
      tx.query<{ n: number }>(
        `select (select count(*)::int from public.practices where id = $1)
              + (select count(*)::int from public.memberships where practice_id = $1) as n`,
        [P],
      ),
    );
    expect(practice?.n).toBe(2);
  });

  it("ricrea_contatori_azzerati", async () => {
    const before = await numberSeriesOf(db);
    await dirtyScenario();
    const td01 = (rows: typeof before) => rows.find((r) => r.series === "TD01" && r.year === 2026)?.last_number;
    expect(td01(await numberSeriesOf(db))).toBeGreaterThan(td01(before) ?? Infinity);

    await recreateDemoData(db, store, seedClock, { demoMode: true });

    const [first] = await asServiceFor(db, (tx) =>
      tx.query<{ number_label: string }>(
        `select number_label from public.invoices
          where practice_id = $1 and doc_type = 'TD01' and number is not null order by number limit 1`,
        [P],
      ),
    );
    expect(first?.number_label).toBe("280/2026");
  });

  it("ricrea_due_volte_di_fila", async () => {
    const expected = await cleanSeed(seedClock);
    await dirtyScenario();
    await recreateDemoData(db, store, seedClock, { demoMode: true });
    await recreateDemoData(db, store, seedClock, { demoMode: true });
    expect(await countsOf(db)).toEqual(expected.counts);
    expect(await numberSeriesOf(db)).toEqual(expected.series);
  });

  it("ricrea_rollback_conserva con lo store che fallisce alla seconda put", async () => {
    await dirtyScenario();
    const counts = await countsOf(db);
    const files = await fileRows(db);
    const keys = store.keys();

    store.failAtPut(2);
    await expect(recreateDemoData(db, store, seedClock, { demoMode: true })).rejects.toThrow(
      "Scrittura del file fallita (prova).",
    );

    expect(await countsOf(db)).toEqual(counts);
    expect(await fileRows(db)).toEqual(files);
    expect(store.keys()).toEqual(keys);
  });

  it("ricrea_rollback_conserva con un comando del seed che lancia", async () => {
    await dirtyScenario();
    const counts = await countsOf(db);
    const files = await fileRows(db);
    const keys = store.keys();

    vi.mocked(issueInvoice).mockRejectedValueOnce(new Error("Emissione fallita (prova)."));
    await expect(recreateDemoData(db, store, seedClock, { demoMode: true })).rejects.toThrow(
      "Emissione fallita (prova).",
    );

    expect(vi.mocked(issueInvoice)).toHaveBeenCalled();
    expect(await countsOf(db)).toEqual(counts);
    expect(await fileRows(db)).toEqual(files);
    // I file di prima ci sono ancora, con i loro byte; quelli preparati dal tentativo sono stati tolti.
    expect(store.keys()).toEqual(keys);
    for (const row of files) {
      const bytes = await store.get(row.storage_key);
      expect(bytes && createHash("sha256").update(bytes).digest("hex")).toBe(row.sha256);
    }
  });

  it("ricrea_file_vecchi_tolti", async () => {
    const old = await fileRows(db);
    expect(old.length).toBeGreaterThan(0);

    await recreateDemoData(db, store, seedClock, { demoMode: true });

    const fresh = await fileRows(db);
    expect(fresh).toHaveLength(old.length);
    const keys = new Set(store.keys());
    for (const row of old) expect(keys.has(row.storage_key)).toBe(false);
    for (const row of fresh) {
      const bytes = await store.get(row.storage_key);
      expect(bytes, row.storage_key).not.toBeNull();
      expect(createHash("sha256").update(bytes!).digest("hex")).toBe(row.sha256);
    }
    expect(store.keys()).toEqual(fresh.map((r) => r.storage_key).sort());
  });

  it("ricrea_domenica", async () => {
    const sunday = fixedClock("2026-11-08T10:00:00+01:00");
    await recreateDemoData(db, store, sunday, { demoMode: true });

    const { hours, today } = await asDemo(async (tx) => ({
      hours: await getOpeningHours(tx, P),
      today: await listDayAppointments(tx, P, sunday, "2026-11-08"),
    }));
    expect(hours[7]).toEqual([{ opensMin: 9 * 60, closesMin: 13 * 60 }]);
    expect(today.filter((a) => isActive(a.status))).toHaveLength(5);
  });

  it("ricrea_rifiuti", async () => {
    await dirtyScenario();
    const counts = await countsOf(db);
    const keys = store.keys();

    await expect(recreateDemoData(db, store, seedClock, { demoMode: false })).rejects.toMatchObject({
      name: "DomainError",
      message: NOT_ALLOWED,
    });
    expect(await countsOf(db)).toEqual(counts);
    expect(store.keys()).toEqual(keys);

    await asServiceFor(db, (tx) =>
      tx.query("update public.practice_settings set is_demo = false where practice_id = $1", [P]),
    );
    await expect(recreateDemoData(db, store, seedClock, { demoMode: true })).rejects.toMatchObject({
      name: "DomainError",
      message: NOT_ALLOWED,
    });
    expect(await countsOf(db)).toEqual(counts);
    expect(store.keys()).toEqual(keys);
  });

  it("purge_chiuso_per_authenticated", async () => {
    await expectPgError(
      asDemo(async (tx) => {
        await setPurge(tx, P);
        await tx.query("update public.invoices set status = 'bozza' where practice_id = $1 and status = 'pagata'", [P]);
      }),
      "42501",
      /Questo cambio di stato della fattura non è ammesso/,
    );
  });
});
