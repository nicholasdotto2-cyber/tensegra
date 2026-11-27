import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_PRACTICE_ID, DEMO_USER_EMAIL, DEMO_USER_ID } from "@/server/auth/actor";
import { type Clock, fixedClock, todayRome } from "@/server/clock";
import type { Db } from "@/server/db/db";
import { DEMO_PRACTICE_NAME, demoExists, seedDemo } from "../../seed/demo";
import { asServiceFor, expectPgError, openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

// Il seed della demo sopra il banco di prova a due studi: l'utente demo si aggiunge
// ai due utenti delle fixture senza toccarli, e i dati di dominio nascono nello studio demo.

const clock = fixedClock("2026-11-04T08:30:00+01:00");

let db: Db;
let pg: PGlite;
let store: MemoryFileStore;

beforeEach(async () => {
  ({ db, pg } = await openTestDb());
  store = new MemoryFileStore();
});

afterEach(async () => {
  await pg.close();
});

interface Counts {
  users: number;
  practices: number;
  memberships: number;
  /** Le righe dello studio demo. */
  patients: number;
  cycles: number;
  appointments: number;
  services: number;
  consents: number;
  physicians: number;
  visits: number;
  answers: number;
  outcomes: number;
  findings: number;
  tests: number;
  treatments: number;
  advice: number;
  amendments: number;
  referrals: number;
  psfsItems: number;
  psfsScores: number;
  history: number;
  systems: number;
  guardians: number;
  invoices: number;
  invoiceLines: number;
  invoiceEvents: number;
  billingParties: number;
  numberSeries: number;
}

function counts(): Promise<Counts> {
  return asServiceFor(db, async (tx) => {
    const [row] = await tx.query<Counts>(
      `select (select count(*)::int from auth.users) as users,
              (select count(*)::int from public.practices) as practices,
              (select count(*)::int from public.memberships) as memberships,
              (select count(*)::int from public.patients where practice_id = $1) as patients,
              (select count(*)::int from public.treatment_cycles where practice_id = $1) as cycles,
              (select count(*)::int from public.appointments where practice_id = $1) as appointments,
              (select count(*)::int from public.services where practice_id = $1) as services,
              (select count(*)::int from public.consent_records where practice_id = $1) as consents,
              (select count(*)::int from public.physicians where practice_id = $1) as physicians,
              (select count(*)::int from public.visits where practice_id = $1) as visits,
              (select count(*)::int from public.visit_screening_answers where practice_id = $1) as answers,
              (select count(*)::int from public.visit_screening_outcomes where practice_id = $1) as outcomes,
              (select count(*)::int from public.visit_region_findings where practice_id = $1) as findings,
              (select count(*)::int from public.visit_test_results where practice_id = $1) as tests,
              (select count(*)::int from public.visit_treatments where practice_id = $1) as treatments,
              (select count(*)::int from public.visit_advice where practice_id = $1) as advice,
              (select count(*)::int from public.visit_amendments where practice_id = $1) as amendments,
              (select count(*)::int from public.referrals where practice_id = $1) as referrals,
              (select count(*)::int from public.psfs_items where practice_id = $1) as "psfsItems",
              (select count(*)::int from public.psfs_scores where practice_id = $1) as "psfsScores",
              (select count(*)::int from public.patient_history_items where practice_id = $1) as history,
              (select count(*)::int from public.patient_systems_review where practice_id = $1) as systems,
              (select count(*)::int from public.patient_guardians where practice_id = $1) as guardians,
              (select count(*)::int from public.invoices where practice_id = $1) as invoices,
              (select count(*)::int from public.invoice_lines where practice_id = $1) as "invoiceLines",
              (select count(*)::int from public.invoice_events where practice_id = $1) as "invoiceEvents",
              (select count(*)::int from public.billing_parties where practice_id = $1) as "billingParties",
              (select count(*)::int from public.number_series where practice_id = $1) as "numberSeries"`,
      [DEMO_PRACTICE_ID],
    );
    if (!row) throw new Error("conteggi non letti");
    return row;
  });
}

/** Ciò che dipende da D0 e dall'istante del seed: orari, segni della demo, polizza, nascite, appuntamenti. */
function demoSnapshot(target: Db) {
  return asServiceFor(target, async (tx) => ({
    settings: await tx.query<{ seededAt: Date; sundayBands: number; saturdayBands: number }>(
      `select demo_seeded_at as "seededAt",
              (select count(*)::int from public.opening_hours where practice_id = $1 and weekday = 7) as "sundayBands",
              (select count(*)::int from public.opening_hours where practice_id = $1 and weekday = 6) as "saturdayBands"
         from public.practice_settings where practice_id = $1`,
      [DEMO_PRACTICE_ID],
    ),
    insurance: await tx.query(
      "select insurance_expires_on from public.practice_settings where practice_id = $1",
      [DEMO_PRACTICE_ID],
    ),
    births: await tx.query(
      "select last_name, first_name, birth_date from public.patients where practice_id = $1 order by last_name, first_name",
      [DEMO_PRACTICE_ID],
    ),
    cycles: await tx.query(
      "select opened_on, status from public.treatment_cycles where practice_id = $1 order by opened_on, status",
      [DEMO_PRACTICE_ID],
    ),
    appointments: await tx.query(
      `select starts_at, duration_min, status, status_changed_at
         from public.appointments where practice_id = $1 order by starts_at, status`,
      [DEMO_PRACTICE_ID],
    ),
  }));
}

// Il comando `pnpm db:seed` fa questo: guarda prima se lo studio demo c'è.
async function seedLikeTheCommand(): Promise<void> {
  if (!(await demoExists(db))) await seedDemo(db, clock, store);
}

describe("seedDemo", () => {
  it("seed due volte non cambia nessun conteggio", async () => {
    const before = await counts();
    expect(await demoExists(db)).toBe(false);

    await seedLikeTheCommand();
    const once = await counts();
    // 15 pazienti con un ciclo ciascuno, 37 appuntamenti, il listino, informativa
    // e consenso al trattamento per i 13 pazienti che li hanno firmati. La rubrica e le visite
    // della demo: Marco 1, Anna 2 chiuse e la bozza di oggi, Roberto 1, Giulia 3, Matteo 1,
    // Francesca 1, Valentina 2; Davide 3, Chiara 2, Giorgio 2, Martina 3, Lorenzo 1,
    // Paolo 1. Risposte dello screening: Marco, Francesca e Paolo i quattro gruppi
    // (6 + 21 + 11 + 5), Chiara i tre gruppi sempre visibili più la gravidanza (38 + 9), le altre diciannove
    // visite i tre gruppi (38); 3 esiti per visita; disfunzioni 2 + 3 + 0 + 6 + 1 (Matteo) + 3 (Davide) + 4
    // (Chiara) + 4 (Giorgio) + 3 (Martina) + 1 + 1; test 8 (Marco) + 6 (Giulia) + 2 (Matteo) + 2 (Francesca)
    // + 3 (Davide) + 2 (Chiara) + 4 (Martina) + 1 (Lorenzo) + 2 (Paolo); tecniche 3 + 4 + 0 + 3 + 3 + 4 + 4 + 3
    // + 1 + 1; il consiglio di Marco; i rinvii di Roberto e Valentina; nessuna rettifica. Le attività PSFS di
    // Marco, Giulia e Davide (3 + 3 + 3) e di Martina (2), con l'iniziale e i finali di Davide e Martina; il
    // Warfarin di Anna, la gravidanza di Chiara e l'osteoporosi di Giorgio; gli 8 apparati di Marco; i genitori
    // di Sofia (2), Martina e Lorenzo.
    expect(once).toEqual({
      users: before.users + 1,
      practices: before.practices + 1,
      memberships: before.memberships + 1,
      patients: 15,
      cycles: 15,
      appointments: 37,
      services: 3,
      consents: 26,
      physicians: 2,
      visits: 24,
      answers: 3 * 43 + 2 * 47 + 19 * 38,
      outcomes: 24 * 3,
      findings: 28,
      tests: 30,
      treatments: 26,
      advice: 1,
      amendments: 0,
      referrals: 2,
      psfsItems: 11,
      psfsScores: 16,
      history: 3,
      systems: 8,
      guardians: 4,
      invoices: 25,
      invoiceLines: 39,
      invoiceEvents: 72,
      billingParties: 1,
      numberSeries: 3,
    });
    expect(before).toMatchObject({
      patients: 0,
      cycles: 0,
      appointments: 0,
      services: 0,
      consents: 0,
      physicians: 0,
      visits: 0,
      answers: 0,
      outcomes: 0,
      findings: 0,
      tests: 0,
      treatments: 0,
      advice: 0,
      amendments: 0,
      referrals: 0,
      psfsItems: 0,
      psfsScores: 0,
      history: 0,
      systems: 0,
      guardians: 0,
      invoices: 0,
      invoiceLines: 0,
      invoiceEvents: 0,
      billingParties: 0,
      numberSeries: 0,
    });
    expect(await demoExists(db)).toBe(true);

    await seedLikeTheCommand();
    expect(await counts()).toEqual(once);
  });

  it("crea utente, studio e membership owner con gli id fissi", async () => {
    await seedDemo(db, clock, store);
    const rows = await asServiceFor(db, async (tx) => ({
      user: await tx.query("select id, email from auth.users where id = $1", [DEMO_USER_ID]),
      practice: await tx.query("select id, name from public.practices where id = $1", [DEMO_PRACTICE_ID]),
      membership: await tx.query("select practice_id, user_id, role from public.memberships where user_id = $1", [
        DEMO_USER_ID,
      ]),
    }));
    expect(rows.user).toEqual([{ id: DEMO_USER_ID, email: DEMO_USER_EMAIL }]);
    expect(rows.practice).toEqual([{ id: DEMO_PRACTICE_ID, name: DEMO_PRACTICE_NAME }]);
    expect(rows.membership).toEqual([{ practice_id: DEMO_PRACTICE_ID, user_id: DEMO_USER_ID, role: "owner" }]);
  });

  it("data le tre righe con l'orologio, non con l'ora vera", async () => {
    await seedDemo(db, clock, store);
    const dates = await asServiceFor(db, async (tx) => ({
      user: await tx.query<{ at: Date }>("select created_at as at from auth.users where id = $1", [DEMO_USER_ID]),
      practice: await tx.query<{ created: Date; updated: Date }>(
        "select created_at as created, updated_at as updated from public.practices where id = $1",
        [DEMO_PRACTICE_ID],
      ),
      membership: await tx.query<{ at: Date }>("select created_at as at from public.memberships where user_id = $1", [
        DEMO_USER_ID,
      ]),
    }));
    const instant = "2026-11-04T07:30:00.000Z";
    expect(dates.user.map((r) => r.at.toISOString())).toEqual([instant]);
    expect(dates.practice.map((r) => [r.created.toISOString(), r.updated.toISOString()])).toEqual([[instant, instant]]);
    expect(dates.membership.map((r) => r.at.toISOString())).toEqual([instant]);
  });

  it("una seconda seedDemo senza il controllo fallisce e non lascia righe a metà", async () => {
    await seedDemo(db, clock, store);
    const once = await counts();
    await expectPgError(seedDemo(db, clock, store), "23505");
    expect(await counts()).toEqual(once);
  });

  it("seed con RLS: l'utente demo vede solo il suo studio", async () => {
    await seedDemo(db, clock, store);
    const rows = await db.asUser({ userId: DEMO_USER_ID }, (tx) => tx.query("select name from practices"));
    expect(rows).toEqual([{ name: "Studio Osteopatico Borgo Tiglio" }]);
  });

  it("un orologio che passa la mezzanotte durante il seed dà un solo D0, quello della prima lettura", async () => {
    // Sabato 7/11/2026 alle 23:59:59 di Roma; ogni lettura va avanti di un secondo, come l'ora vera.
    const start = new Date("2026-11-07T23:59:59+01:00").getTime();
    let reads = 0;
    const advancing: Clock = {
      now: () => new Date(start + 1000 * reads++),
      today: () => todayRome(advancing.now()),
    };
    await seedDemo(db, advancing, store);
    const reference = await openTestDb();
    try {
      await seedDemo(reference.db, fixedClock(new Date(start)), new MemoryFileStore());
      const seeded = await demoSnapshot(db);
      expect(seeded.settings).toEqual([{ seededAt: new Date(start), sundayBands: 0, saturdayBands: 1 }]);
      expect(seeded).toEqual(await demoSnapshot(reference.db));
    } finally {
      await reference.pg.close();
    }
    // Il seed legge l'orologio una volta sola.
    expect(reads).toBe(1);
  });

  it("seed con RLS: le righe di dominio hanno created_by dell'utente demo", async () => {
    await seedDemo(db, clock, store);
    const authors = await asServiceFor(db, (tx) =>
      tx.query<{ table: string; created_by: string | null; n: number }>(
        `select 'patients' as table, created_by, count(*)::int as n
           from public.patients where practice_id = $1 group by created_by
         union all
         select 'appointments', created_by, count(*)::int
           from public.appointments where practice_id = $1 group by created_by
         order by 1`,
        [DEMO_PRACTICE_ID],
      ),
    );
    expect(authors).toEqual([
      { table: "appointments", created_by: DEMO_USER_ID, n: 37 },
      { table: "patients", created_by: DEMO_USER_ID, n: 15 },
    ]);
  });
});
