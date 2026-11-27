import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, SqlParam, Tx } from "@/server/db/db";
import {
  APPOINTMENT_A,
  CYCLE_A,
  CYCLE_B,
  FILE_A,
  FILE_B,
  PATIENT_A1,
  PATIENT_A2,
  PATIENT_B1,
  PHYSICIAN_A,
  PRACTICE_A,
  PRACTICE_B,
  PSFS_ITEM_A,
  PSFS_ITEM_B,
  REFERRAL_A,
  SERVICE_A,
  SERVICE_B,
  VISIT_A,
} from "./fixtures";
import {
  asAnon,
  asServiceFor,
  asUserA,
  type Case,
  expectBlockedDelete,
  expectPgError,
  ident,
  idOf,
  inRollback,
  insertRow,
  inService,
  openTestDb,
  setPurge,
  type Values,
} from "./helpers";

// Vincoli, default e trigger della visita e della cartella: visits, le sette
// tabelle figlie, visit_amendments, referrals e patient_attachments. Nelle fixture A1 ha la prima
// visita in bozza (VISIT_A, 5/10/2026, su APPOINTMENT_A e sul ciclo CYCLE_A aperto dal 1/10) con una
// riga in ogni figlia, e un rinvio in bozza (REFERRAL_A). Questo file aggiunge in `beforeAll`, per A e
// per B, una visita chiusa con una riga in ogni figlia e un rinvio con la lettera congelata. Ogni test
// gira in una transazione che torna indietro, tranne quello della rettifica per transazione, che vuole due commit;
// un caso che fallisce per transazione, con il codice Postgres esatto.

let db: Db;
let pg: PGlite;

/** I genitori di una visita nuova in uno studio: primo paziente, suo ciclo aperto, seduta, prima attività PSFS, file. */
interface Studio {
  practiceId: string;
  patientId: string;
  cycleId: string;
  serviceId: string;
  psfsItemId: string;
  fileId: string;
}

const STUDIO_A: Studio = {
  practiceId: PRACTICE_A,
  patientId: PATIENT_A1,
  cycleId: CYCLE_A,
  serviceId: SERVICE_A,
  psfsItemId: PSFS_ITEM_A,
  fileId: FILE_A,
};
const STUDIO_B: Studio = {
  practiceId: PRACTICE_B,
  patientId: PATIENT_B1,
  cycleId: CYCLE_B,
  serviceId: SERVICE_B,
  psfsItemId: PSFS_ITEM_B,
  fileId: FILE_B,
};

/**
 * Una visita chiusa con una riga in ogni figlia e un rinvio con la lettera congelata, salvati in
 * `beforeAll`: nessun test li cambia.
 */
interface Frozen {
  practiceId: string;
  visitId: string;
  referralId: string;
}
let frozenA: Frozen;
let frozenB: Frozen;
/** La seconda attività PSFS del ciclo di A1, salvata in `beforeAll`: un punteggio su di lei non urta quello della prima. */
let secondItemA: string;

/** Un appuntamento nuovo del paziente sul suo ciclo: ogni visita nuova ne vuole uno suo (una visita per appuntamento). */
async function newAppointment(tx: Tx, studio: Studio, startsAt: string): Promise<string> {
  return idOf(
    await insertRow(tx, "appointments", {
      practice_id: studio.practiceId,
      patient_id: studio.patientId,
      service_id: studio.serviceId,
      cycle_id: studio.cycleId,
      starts_at: startsAt,
      duration_min: 45,
      price_cents: 6000,
    }),
  );
}

/** Un file nuovo dello studio: un file sta in un solo allegato, e la lettera congelata non passa a un altro file. */
async function newFile(tx: Tx, practiceId: string): Promise<string> {
  const id = randomUUID();
  await insertRow(tx, "files", {
    id,
    practice_id: practiceId,
    kind: "referral_pdf",
    storage_key: `${practiceId}/referral_pdf/${id}.pdf`,
    mime_type: "application/pdf",
    size_bytes: 2048,
    sha256: "f".repeat(64),
  });
  return id;
}

/** Una visita in bozza di A1 del 19/10/2026, sul ciclo aperto e sull'appuntamento dato. */
const visit = (appointmentId: string, extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  patient_id: PATIENT_A1,
  cycle_id: CYCLE_A,
  appointment_id: appointmentId,
  visit_date: "2026-10-19",
  kind: "seduta",
  screening_catalog_version: 1,
  ...extra,
});

/** Una visita nuova di A1 con il suo appuntamento, lunedì 19/10/2026 alle 09:00 di Roma, riletta. */
async function insertVisit(tx: Tx, extra: Values = {}): Promise<Record<string, unknown>> {
  return insertRow(tx, "visits", visit(await newAppointment(tx, STUDIO_A, "2026-10-19T07:00:00Z"), extra));
}

/** Una riga di `table` su una visita nuova di A1, riletta: nessuna unique della fixture in mezzo. */
async function insertOnNewVisit(tx: Tx, table: string, values: Values): Promise<Record<string, unknown>> {
  const visitId = idOf(await insertVisit(tx));
  return insertRow(tx, table, { practice_id: PRACTICE_A, visit_id: visitId, ...values });
}

/** Una riga di `table` sulla visita in bozza della fixture, accanto alla riga della fixture. */
function insertOnVisitA(tx: Tx, table: string, values: Values): Promise<Record<string, unknown>> {
  return insertRow(tx, table, { practice_id: PRACTICE_A, visit_id: VISIT_A, ...values });
}

/**
 * La rettifica di una visita nella transazione `tx`: per il resto di `tx` la
 * visita chiusa e le sue figlie si scrivono, e solo loro.
 */
function amend(tx: Tx, practiceId: string, visitId: string): Promise<unknown[]> {
  return tx.query(
    `insert into public.visit_amendments (practice_id, visit_id, amended_at, reason, changes)
     values ($1, $2, '2026-10-13T09:00:00Z', 'Corretto il piano dopo la telefonata', $3)`,
    [practiceId, visitId, JSON.stringify({ plan_next: { before: null, after: "Controllo fra un mese" } })],
  );
}

/** Un rinvio in bozza di A1 al medico curante, senza lettera. */
const referral = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  patient_id: PATIENT_A1,
  cycle_id: CYCLE_A,
  created_on: "2026-10-19",
  recipient_kind: "medico_curante",
  reason: "sintomi_persistenti",
  urgency: "programmato",
  summary_text: "Lombalgia da tre settimane, senza segni neurologici",
  request_text: "Si chiede una valutazione clinica",
  ...extra,
});

/**
 * Una tabella figlia della visita. `first` è la riga della visita chiusa di `beforeAll`, con le chiavi
 * uniche della fixture; `second` una riga di A che non urta né `first` né la fixture; `update` la
 * colonna dei test di update.
 */
interface Child {
  table: string;
  first: (studio: Studio) => Values;
  second: () => Values;
  update: [column: string, value: SqlParam];
}

const CHILDREN: Child[] = [
  {
    table: "psfs_scores",
    first: (studio) => ({ item_id: studio.psfsItemId, score: 3, phase: "iniziale" }),
    second: () => ({ item_id: secondItemA, score: 6, phase: "intermedia" }),
    update: ["score", 5],
  },
  {
    table: "visit_screening_answers",
    first: () => ({ item_code: "anticoagulanti", answer: "no" }),
    second: () => ({ item_code: "osteoporosi", answer: "si" }),
    update: ["note", "Densitometria del 2025 nella norma"],
  },
  {
    table: "visit_screening_outcomes",
    first: () => ({ family: "thrust", suggested: "indicated", outcome: "indicated" }),
    second: () => ({ family: "direct", suggested: "caution", outcome: "caution" }),
    update: ["override_note", "Nessuna controindicazione emersa"],
  },
  {
    table: "visit_region_findings",
    first: () => ({ region: "lumbar", severity: 2, restriction: true, is_primary: true }),
    second: () => ({ region: "thoracic", severity: 1, tenderness: true }),
    update: ["segment_note", "L4"],
  },
  {
    table: "visit_test_results",
    first: () => ({ test_code: "slump", side: "dx", value_bool: true }),
    second: () => ({ test_code: "slump", side: "sx", value_bool: false }),
    update: ["note", "Tensione senza dolore"],
  },
  {
    table: "visit_treatments",
    first: () => ({ region: "lumbar", technique_code: "articolatoria", family: "direct" }),
    second: () => ({ region: "lumbar", technique_code: "tessuti_molli", family: "direct" }),
    update: ["note", "Ben tollerata"],
  },
  {
    table: "visit_advice",
    first: () => ({ text: "Cammina venti minuti al giorno" }),
    second: () => ({ text: "Alterna seduta e in piedi ogni ora" }),
    update: ["text", "Cammina venti minuti al giorno, in piano"],
  },
];

/** La visita chiusa e il rinvio con la lettera congelata di uno studio, il 12/10/2026. */
async function createFrozen(tx: Tx, studio: Studio): Promise<Frozen> {
  const appointmentId = await newAppointment(tx, studio, "2026-10-12T07:00:00Z");
  const visitId = idOf(
    await insertRow(tx, "visits", {
      practice_id: studio.practiceId,
      patient_id: studio.patientId,
      cycle_id: studio.cycleId,
      appointment_id: appointmentId,
      visit_date: "2026-10-12",
      kind: "seduta",
      screening_catalog_version: 1,
    }),
  );
  for (const child of CHILDREN) {
    await insertRow(tx, child.table, { practice_id: studio.practiceId, visit_id: visitId, ...child.first(studio) });
  }
  await tx.query("update public.visits set status = 'closed', closed_at = '2026-10-12T08:00:00Z' where id = $1", [
    visitId,
  ]);
  const referralId = idOf(
    await insertRow(
      tx,
      "referrals",
      referral({
        practice_id: studio.practiceId,
        patient_id: studio.patientId,
        cycle_id: studio.cycleId,
        visit_id: visitId,
        status: "stampata",
        patient_agreed_to_share: true,
        letter_file_id: studio.fileId,
      }),
    ),
  );
  return { practiceId: studio.practiceId, visitId, referralId };
}

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  // Come servizio, e salvati nel clone di questo file (non nel modello delle fixture).
  ({
    item: secondItemA,
    a: frozenA,
    b: frozenB,
  } = await asServiceFor(db, async (tx) => ({
    item: idOf(
      await insertRow(tx, "psfs_items", {
        practice_id: PRACTICE_A,
        cycle_id: CYCLE_A,
        position: 2,
        activity: "Salire le scale",
      }),
    ),
    a: await createFrozen(tx, STUDIO_A),
    b: await createFrozen(tx, STUDIO_B),
  })));
});

afterAll(async () => {
  await pg?.close();
});

const R10 = [
  "head",
  "cervical",
  "thoracic",
  "lumbar",
  "sacral",
  "pelvic",
  "lower_extremity",
  "upper_extremity",
  "rib_cage",
  "abdomen_other",
];

describe("public.visits", () => {
  it("i default", async () => {
    const row = await inService(db, (tx) => insertVisit(tx));
    expect(row).toMatchObject({
      status: "draft",
      closed_at: null,
      location: "studio",
      others_present: null,
      others_present_consented: null,
      nprs_pre: null,
      nprs_post: null,
      radiation_sites: [],
      radiation_side: null,
      treatment_response: null,
      adverse_reaction: null,
      screening_reviewed_at: null,
      copied_from_visit_id: null,
    });
  });

  it.each<Case>([
    ["kind", "visita"],
    ["status", "chiusa"],
    ["location", "casa"],
    ["others_present", "a".repeat(201)],
    ["nprs_pre", 11],
    ["nprs_pre", -1],
    ["nprs_post", 11],
    ["subjective_update", "a".repeat(1001)],
    ["radiation_sites", ["spalla"]],
    ["radiation_sites", ["gluteo", "spalla"]],
    ["radiation_side", "destra"],
    ["treatment_response", "guarito"],
    ["adverse_reaction", "forte"],
    ["adverse_reaction_note", "a".repeat(501)],
    ["observation_note", "a".repeat(1001)],
    ["working_hypothesis", "a".repeat(1001)],
    ["plan_next", "a".repeat(501)],
    ["bp_systolic", 49],
    ["bp_systolic", 261],
    ["bp_diastolic", 29],
    ["bp_diastolic", 161],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertVisit(tx, { [column]: value })),
      "23514",
    );
  });

  it.each<Case>([
    ...["prima_visita", "seduta", "controllo"].map((kind): Case => ["kind", kind]),
    ...["studio", "domicilio", "altro"].map((location): Case => ["location", location]),
    ["others_present", "a".repeat(200)],
    ["others_present_consented", true],
    ["nprs_pre", 0],
    ["nprs_pre", 10],
    ["nprs_post", 0],
    ["nprs_post", 10],
    ["subjective_update", "a".repeat(1000)],
    ["radiation_sites", ["gluteo", "coscia", "sotto_ginocchio", "braccio", "mano"]],
    ...["dx", "sx", "bilaterale"].map((side): Case => ["radiation_side", side]),
    ...["migliorato", "invariato", "peggiorato"].map((response): Case => ["treatment_response", response]),
    ...["nessuna", "lieve", "moderata", "grave"].map((reaction): Case => ["adverse_reaction", reaction]),
    ["adverse_reaction_note", "a".repeat(500)],
    ["observation_note", "a".repeat(1000)],
    ["working_hypothesis", "a".repeat(1000)],
    ["plan_next", "a".repeat(500)],
    ["bp_systolic", 50],
    ["bp_systolic", 260],
    ["bp_diastolic", 30],
    ["bp_diastolic", 160],
    ["screening_catalog_version", 2],
    ["copied_from_visit_id", VISIT_A],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertVisit(tx, { [column]: value }));
    expect(row[column]).toEqual(value);
  });

  it("chiusa senza closed_at: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertVisit(tx, { status: "closed" })),
      "23514",
    );
  });

  it("chiusa con closed_at: accettata", async () => {
    const row = await inService(db, (tx) => insertVisit(tx, { status: "closed", closed_at: "2026-10-19T08:00:00Z" }));
    expect(row).toMatchObject({ status: "closed" });
  });

  it("una seconda visita sullo stesso appuntamento: 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "visits", visit(APPOINTMENT_A, { visit_date: "2026-10-05" }))),
      "23505",
    );
  });

  // `on delete restrict` ferma la delete (23001 su Postgres 18, 23503 su Postgres 17: `expectBlockedDelete`).
  // L'appuntamento nasce nella transazione, prenotato: senza la visita uA lo cancellerebbe (agenda.test.ts).
  it("un appuntamento con una visita non si cancella (uA)", async () => {
    await expectBlockedDelete(
      inRollback(db, "A", async (tx) => {
        const row = await insertVisit(tx);
        return tx.query("delete from public.appointments where id = $1", [String(row.appointment_id)]);
      }),
    );
  });

  it("visit_date un giorno prima dell'apertura del ciclo: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertVisit(tx, { visit_date: "2026-09-30" })),
      "23514",
    );
  });

  it("visit_date uguale all'apertura del ciclo: accettata", async () => {
    const row = await inService(db, (tx) => insertVisit(tx, { visit_date: "2026-10-01" }));
    expect(row).toMatchObject({ visit_date: "2026-10-01" });
  });

  it("visit_date spostata prima dell'apertura del ciclo (update): 23514", async () => {
    await expectPgError(
      inService(db, (tx) => tx.query("update public.visits set visit_date = '2026-09-30' where id = $1", [VISIT_A])),
      "23514",
    );
  });

  /** Un ciclo aperto di A2 (che nelle fixture non ne ha) e un suo appuntamento. */
  async function cycleAndAppointmentOfA2(tx: Tx): Promise<{ cycleId: string; appointmentId: string }> {
    const cycleId = idOf(
      await insertRow(tx, "treatment_cycles", {
        practice_id: PRACTICE_A,
        patient_id: PATIENT_A2,
        opened_on: "2026-10-01",
        title: "Cervicalgia, ottobre 2026",
        expected_sessions: 4,
      }),
    );
    const appointmentId = await newAppointment(
      tx,
      { ...STUDIO_A, patientId: PATIENT_A2, cycleId },
      "2026-10-19T08:00:00Z",
    );
    return { cycleId, appointmentId };
  }

  it("paziente diverso da quello del ciclo (appuntamento dello stesso paziente): 23514", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        const { appointmentId } = await cycleAndAppointmentOfA2(tx);
        return insertRow(tx, "visits", visit(appointmentId, { patient_id: PATIENT_A2, cycle_id: CYCLE_A }));
      }),
      "23514",
    );
  });

  it("paziente diverso da quello dell'appuntamento (ciclo dello stesso paziente): 23514", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        const { cycleId } = await cycleAndAppointmentOfA2(tx);
        const appointmentOfA1 = await newAppointment(tx, STUDIO_A, "2026-10-19T07:00:00Z");
        return insertRow(tx, "visits", visit(appointmentOfA1, { patient_id: PATIENT_A2, cycle_id: cycleId }));
      }),
      "23514",
    );
  });

  it("controllo: paziente, ciclo e appuntamento di A2 insieme: accettata", async () => {
    const row = await inService(db, async (tx) => {
      const { cycleId, appointmentId } = await cycleAndAppointmentOfA2(tx);
      return insertRow(tx, "visits", visit(appointmentId, { patient_id: PATIENT_A2, cycle_id: cycleId }));
    });
    expect(row).toMatchObject({ patient_id: PATIENT_A2 });
  });

  it("spostare la visita su un altro paziente (update): 23514", async () => {
    await expectPgError(
      inService(db, (tx) => tx.query("update public.visits set patient_id = $1 where id = $2", [PATIENT_A2, VISIT_A])),
      "23514",
    );
  });
});

const UPDATE_PLAN = "update public.visits set plan_next = $2 where id = $1 returning plan_next";

describe("visita chiusa (visits_immutable)", () => {
  it("in bozza l'update passa, e la chiusura anche (uA)", async () => {
    const rows = await inRollback(db, "A", async (tx) => [
      ...(await tx.query(UPDATE_PLAN, [VISIT_A, "Controllo fra un mese"])),
      ...(await tx.query(
        "update public.visits set status = 'closed', closed_at = '2026-10-05T08:00:00Z' where id = $1 returning status",
        [VISIT_A],
      )),
    ]);
    expect(rows).toEqual([{ plan_next: "Controllo fra un mese" }, { status: "closed" }]);
  });

  it("update senza rettifica (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) => tx.query(UPDATE_PLAN, [frozenA.visitId, "Controllo fra un mese"])),
      "42501",
    );
  });

  // I trigger scattano anche per il superutente: BYPASSRLS salta le policy, non i trigger.
  it("update come servizio senza rettifica: 42501", async () => {
    await expectPgError(
      inRollback(db, "service", (tx) => tx.query(UPDATE_PLAN, [frozenA.visitId, "Controllo fra un mese"])),
      "42501",
    );
  });

  it("update con la riga in visit_amendments nella stessa transazione (uA): passa", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      await amend(tx, PRACTICE_A, frozenA.visitId);
      return tx.query(UPDATE_PLAN, [frozenA.visitId, "Controllo fra un mese"]);
    });
    expect(rows).toEqual([{ plan_next: "Controllo fra un mese" }]);
  });

  it("una rettifica di un'altra visita non apre questa (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await amend(tx, PRACTICE_A, VISIT_A);
        return tx.query(UPDATE_PLAN, [frozenA.visitId, "Controllo fra un mese"]);
      }),
      "42501",
    );
  });

  // La rettifica vale per la transazione che la scrive (xmin), non per sempre. Servono
  // due commit veri, quindi la visita è propria di questo test e resta salvata nel clone del file.
  it("la rettifica di ieri non apre la visita oggi: la seconda transazione senza rettifica dà 42501", async () => {
    const visitId = await asServiceFor(db, async (tx) =>
      idOf(await insertVisit(tx, { status: "closed", closed_at: "2026-10-19T08:00:00Z" })),
    );
    // Transazione 1 ("ieri"): rettifica e modifica insieme.
    const yesterday = await asUserA(db, async (tx) => {
      await amend(tx, PRACTICE_A, visitId);
      return tx.query(UPDATE_PLAN, [visitId, "Controllo fra un mese"]);
    });
    expect(yesterday).toEqual([{ plan_next: "Controllo fra un mese" }]);
    // Transazione 2 ("oggi"): la riga di ieri in visit_amendments c'è ancora, ma non è di questa transazione.
    await expectPgError(
      asUserA(db, (tx) => tx.query(UPDATE_PLAN, [visitId, "Controllo fra due mesi"])),
      "42501",
    );
    await expectPgError(
      asUserA(db, (tx) =>
        insertRow(tx, "visit_advice", { practice_id: PRACTICE_A, visit_id: visitId, text: "Riposo" }),
      ),
      "42501",
    );
    const [amendments] = await asServiceFor(db, (tx) =>
      tx.query<{ n: number }>("select count(*)::int as n from public.visit_amendments where visit_id = $1", [visitId]),
    );
    const [after] = await asServiceFor(db, (tx) =>
      tx.query<{ plan_next: string }>("select plan_next from public.visits where id = $1", [visitId]),
    );
    expect(amendments).toEqual({ n: 1 });
    expect(after).toEqual({ plan_next: "Controllo fra un mese" });
  });

  const REOPEN = "update public.visits set status = 'draft', closed_at = null where id = $1";

  it("chiusa non torna in bozza (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) => tx.query(REOPEN, [frozenA.visitId])),
      "42501",
    );
  });

  it("chiusa non torna in bozza nemmeno con la rettifica (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await amend(tx, PRACTICE_A, frozenA.visitId);
        return tx.query(REOPEN, [frozenA.visitId]);
      }),
      "42501",
    );
  });

  it("delete di una visita chiusa come servizio: 42501", async () => {
    await expectPgError(
      inRollback(db, "service", (tx) => tx.query("delete from public.visits where id = $1", [frozenA.visitId])),
      "42501",
    );
  });

  // Senza policy D uA non cancella nessuna visita (isolation.test.ts): il trigger ferma solo le chiuse.
  it("controllo: una visita in bozza senza figlie si cancella come servizio", async () => {
    const { id, deleted } = await inService(db, async (tx) => {
      const id = idOf(await insertVisit(tx));
      return { id, deleted: await tx.query("delete from public.visits where id = $1 returning id", [id]) };
    });
    expect(deleted).toEqual([{ id }]);
  });
});

describe("app.visit_locked", () => {
  async function locked(visitId: string, amended: boolean): Promise<boolean | undefined> {
    const rows = await inRollback(db, "A", async (tx) => {
      if (amended) await amend(tx, PRACTICE_A, visitId);
      return tx.query<{ locked: boolean }>("select app.visit_locked($1, $2) as locked", [PRACTICE_A, visitId]);
    });
    return rows[0]?.locked;
  }

  it("visita in bozza: false", async () => {
    expect(await locked(VISIT_A, false)).toBe(false);
  });

  it("visita chiusa: true", async () => {
    expect(await locked(frozenA.visitId, false)).toBe(true);
  });

  it("visita chiusa con la rettifica nella transazione: false", async () => {
    expect(await locked(frozenA.visitId, true)).toBe(false);
  });

  it("anon non la esegue: 42501", async () => {
    await expectPgError(
      asAnon(db, (tx) => tx.query("select app.visit_locked($1, $2)", [PRACTICE_A, VISIT_A])),
      "42501",
    );
  });
});

type Write = "insert" | "update" | "delete";
const WRITES: Write[] = ["insert", "update", "delete"];

/**
 * Una scrittura su una figlia della visita `visitId` di A, con returning: l'insert aggiunge `second`,
 * update e delete toccano l'unica riga della figlia su quella visita.
 */
async function childWrite(tx: Tx, child: Child, write: Write, visitId: string): Promise<unknown[]> {
  const table = `public.${ident(child.table)}`;
  const [column, value] = child.update;
  switch (write) {
    case "insert":
      return [await insertRow(tx, child.table, { practice_id: PRACTICE_A, visit_id: visitId, ...child.second() })];
    case "update":
      return tx.query(`update ${table} set ${ident(column)} = $1 where visit_id = $2 returning id`, [value, visitId]);
    case "delete":
      return tx.query(`delete from ${table} where visit_id = $1 returning id`, [visitId]);
  }
}

describe("figlie della visita (visit_children_guard)", () => {
  const CASES = CHILDREN.flatMap((child) => WRITES.map((write): [string, Write, Child] => [child.table, write, child]));

  it.each(CASES)("%s, %s in bozza (uA): passa", async (_table, write, child) => {
    const rows = await inRollback(db, "A", (tx) => childWrite(tx, child, write, VISIT_A));
    expect(rows).toHaveLength(1);
  });

  it.each(CASES)("%s, %s a visita chiusa (uA): 42501", async (_table, write, child) => {
    await expectPgError(
      inRollback(db, "A", (tx) => childWrite(tx, child, write, frozenA.visitId)),
      "42501",
    );
  });

  it.each(CASES)(
    "%s, %s a visita chiusa con la rettifica nella stessa transazione (uA): passa",
    async (_table, write, child) => {
      const rows = await inRollback(db, "A", async (tx) => {
        await amend(tx, PRACTICE_A, frozenA.visitId);
        return childWrite(tx, child, write, frozenA.visitId);
      });
      expect(rows).toHaveLength(1);
    },
  );

  // Regione e primaria cambiano insieme alla visita, così non urtano le unique della visita d'arrivo.
  const MOVE = `update public.visit_region_findings
                   set visit_id = $1, region = 'cervical', is_primary = false
                 where visit_id = $2`;

  it("spostare una disfunzione da una visita in bozza a una chiusa (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) => tx.query(MOVE, [frozenA.visitId, VISIT_A])),
      "42501",
    );
  });

  it("spostare una disfunzione da una visita chiusa a una in bozza (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) => tx.query(MOVE, [VISIT_A, frozenA.visitId])),
      "42501",
    );
  });

  it("una rettifica di un'altra visita non apre le figlie di questa (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await amend(tx, PRACTICE_A, VISIT_A);
        return tx.query("delete from public.visit_region_findings where visit_id = $1", [frozenA.visitId]);
      }),
      "42501",
    );
  });
});

describe("public.psfs_scores", () => {
  const score = (extra: Values = {}): Values => ({ item_id: PSFS_ITEM_A, score: 3, phase: "iniziale", ...extra });

  it.each<Case>([
    ["score", 11],
    ["score", -1],
    ["phase", "media"],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "psfs_scores", score({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["score", 0],
    ["score", 10],
    ...["iniziale", "intermedia", "finale"].map((phase): Case => ["phase", phase]),
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertOnNewVisit(tx, "psfs_scores", score({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it("la stessa attività due volte nella stessa visita: 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertOnVisitA(tx, "psfs_scores", score({ phase: "intermedia" }))),
      "23505",
    );
  });
});

describe("public.visit_screening_answers", () => {
  const answer = (extra: Values = {}): Values => ({ item_code: "anticoagulanti", answer: "no", ...extra });

  it("i default", async () => {
    const row = await inService(db, (tx) => insertOnNewVisit(tx, "visit_screening_answers", answer()));
    expect(row).toMatchObject({ regions: [], sub_answers: [], from_history: false, note: null });
  });

  it.each<Case>([
    ["item_code", "a"],
    ["item_code", "a".repeat(41)],
    ["item_code", "Anticoagulanti"],
    ["item_code", "anti-coagulanti"],
    ["answer", "forse"],
    ["regions", ["collo"]],
    ["regions", ["lumbar", "collo"]],
    ["note", "a".repeat(301)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "visit_screening_answers", answer({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["item_code", "a1"],
    ["item_code", "a".repeat(40)],
    ...["no", "si", "non_so"].map((value): Case => ["answer", value]),
    ["regions", R10],
    ["sub_answers", ["inr_instabile"]],
    ["from_history", true],
    ["note", "a".repeat(300)],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) =>
      insertOnNewVisit(tx, "visit_screening_answers", answer({ [column]: value })),
    );
    expect(row[column]).toEqual(value);
  });

  it("la stessa voce due volte nella stessa visita: 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertOnVisitA(tx, "visit_screening_answers", answer({ answer: "si" }))),
      "23505",
    );
  });
});

describe("public.visit_screening_outcomes", () => {
  const outcome = (extra: Values = {}): Values => ({
    family: "thrust",
    suggested: "indicated",
    outcome: "indicated",
    ...extra,
  });
  const LEVELS = ["indicated", "caution", "contraindicated"];

  it("i default", async () => {
    const row = await inService(db, (tx) => insertOnNewVisit(tx, "visit_screening_outcomes", outcome()));
    expect(row).toMatchObject({ local_contraindicated_regions: [], override_note: null });
  });

  it.each<Case>([
    ["family", "hvla"],
    ["suggested", "si"],
    ["outcome", "no"],
    ["local_contraindicated_regions", ["collo"]],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "visit_screening_outcomes", outcome({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ...["thrust", "direct", "indirect"].map((family): Case => ["family", family]),
    ...LEVELS.map((level): Case => ["suggested", level]),
    ...LEVELS.map((level): Case => ["outcome", level]),
    ["local_contraindicated_regions", R10],
    ["override_note", "Sospetto non confermato dal medico"],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) =>
      insertOnNewVisit(tx, "visit_screening_outcomes", outcome({ [column]: value })),
    );
    expect(row[column]).toEqual(value);
  });

  it("la stessa famiglia due volte nella stessa visita: 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertOnVisitA(tx, "visit_screening_outcomes", outcome({ outcome: "caution" }))),
      "23505",
    );
  });
});

describe("public.visit_region_findings", () => {
  const finding = (extra: Values = {}): Values => ({ region: "cervical", severity: 1, tenderness: true, ...extra });
  const TART = ["tissue_texture", "asymmetry", "restriction", "tenderness"];

  it("i default", async () => {
    const row = await inService(db, (tx) =>
      insertOnNewVisit(tx, "visit_region_findings", { region: "cervical", severity: 2 }),
    );
    expect(row).toMatchObject({
      tissue_texture: false,
      asymmetry: false,
      restriction: false,
      tenderness: false,
      side: null,
      segment_note: null,
      is_primary: false,
      copied: false,
    });
  });

  it.each<Case>([
    ["region", "collo"],
    ["region", "Lumbar"],
    ["severity", 4],
    ["severity", -1],
    ["side", "sinistro"],
    ["segment_note", "a".repeat(201)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "visit_region_findings", finding({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ...R10.map((region): Case => ["region", region]),
    ["severity", 0],
    ["severity", 3],
    ...["dx", "sx", "bilaterale", "centrale"].map((side): Case => ["side", side]),
    ["segment_note", "a".repeat(200)],
    ["copied", true],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) =>
      insertOnNewVisit(tx, "visit_region_findings", finding({ [column]: value })),
    );
    expect(row[column]).toBe(value);
  });

  it("severity 0 e TART tutti falsi: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "visit_region_findings", { region: "cervical", severity: 0 })),
      "23514",
    );
  });

  it.each(TART)("severity 0 con solo %s: accettata", async (column) => {
    const row = await inService(db, (tx) =>
      insertOnNewVisit(tx, "visit_region_findings", { region: "cervical", severity: 0, [column]: true }),
    );
    expect(row).toMatchObject({ severity: 0, [column]: true });
  });

  it("due regioni primarie nella stessa visita: 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertOnVisitA(tx, "visit_region_findings", finding({ is_primary: true }))),
      "23505",
    );
  });

  it("controllo: una seconda regione non primaria nella stessa visita: accettata", async () => {
    const row = await inService(db, (tx) => insertOnVisitA(tx, "visit_region_findings", finding()));
    expect(row).toMatchObject({ region: "cervical", is_primary: false });
  });

  it("la stessa regione due volte nella stessa visita: 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertOnVisitA(tx, "visit_region_findings", finding({ region: "lumbar" }))),
      "23505",
    );
  });
});

describe("public.visit_test_results", () => {
  const result = (extra: Values = {}): Values => ({ test_code: "dita_pavimento", ...extra });

  it("i default", async () => {
    const row = await inService(db, (tx) => insertOnNewVisit(tx, "visit_test_results", result()));
    expect(row).toMatchObject({
      custom_label: null,
      custom_unit: null,
      side: null,
      value_bool: null,
      value_lateral: null,
      value_numeric: null,
      value_ordinal: null,
      pain_provoked: null,
      copied: false,
    });
  });

  it.each<Case>([
    ["test_code", "a"],
    ["test_code", "a".repeat(41)],
    ["test_code", "SLR"],
    ["custom_unit", "a".repeat(11)],
    ["side", "bil"],
    ["value_lateral", "pos"],
    ["note", "a".repeat(201)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "visit_test_results", result({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["test_code", "a1"],
    ["test_code", "a".repeat(40)],
    ...["dx", "sx"].map((side): Case => ["side", side]),
    ["value_bool", false],
    ...["neg", "dx", "sx", "bil"].map((lateral): Case => ["value_lateral", lateral]),
    ["value_numeric", "1234.50"],
    ["value_ordinal", 3],
    ["pain_provoked", true],
    ["custom_unit", "a".repeat(10)],
    ["note", "a".repeat(200)],
    ["copied", true],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertOnNewVisit(tx, "visit_test_results", result({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it.each<[label: string, values: Values]>([
    ["value_bool e value_numeric", { value_bool: true, value_numeric: "12.00" }],
    ["value_lateral e value_ordinal", { value_lateral: "dx", value_ordinal: 2 }],
  ])("due valori insieme (%s): 23514", async (_label, values) => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "visit_test_results", result(values))),
      "23514",
    );
  });

  it("test libero senza custom_label: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "visit_test_results", { test_code: "libero", value_bool: true })),
      "23514",
    );
  });

  it("custom_label su un test del catalogo: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "visit_test_results", result({ custom_label: "Prova" }))),
      "23514",
    );
  });

  it("test libero con custom_label di 61 caratteri: 23514", async () => {
    await expectPgError(
      inService(db, (tx) =>
        insertOnNewVisit(tx, "visit_test_results", { test_code: "libero", custom_label: "a".repeat(61) }),
      ),
      "23514",
    );
  });

  it("test libero con custom_label di 60 caratteri: accettato", async () => {
    const row = await inService(db, (tx) =>
      insertOnNewVisit(tx, "visit_test_results", {
        test_code: "libero",
        custom_label: "a".repeat(60),
        value_numeric: "35.00",
      }),
    );
    expect(row).toMatchObject({ test_code: "libero", value_numeric: "35.00" });
  });

  it("lo stesso test e lo stesso lato due volte nella stessa visita: 23505", async () => {
    await expectPgError(
      inService(db, (tx) =>
        insertOnVisitA(tx, "visit_test_results", { test_code: "slump", side: "dx", value_bool: false }),
      ),
      "23505",
    );
  });

  it("controllo: lo stesso test sull'altro lato: accettato", async () => {
    const row = await inService(db, (tx) =>
      insertOnVisitA(tx, "visit_test_results", { test_code: "slump", side: "sx" }),
    );
    expect(row).toMatchObject({ test_code: "slump", side: "sx" });
  });

  it("lo stesso test senza lato due volte nella stessa visita: 23505", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        await insertOnVisitA(tx, "visit_test_results", result());
        return insertOnVisitA(tx, "visit_test_results", result());
      }),
      "23505",
    );
  });

  const free = (label: string): Values => ({ test_code: "libero", custom_label: label, side: "dx", value_bool: true });

  it('test libero "Prova" e "prova" sullo stesso lato: 23505', async () => {
    await expectPgError(
      inService(db, async (tx) => {
        await insertOnVisitA(tx, "visit_test_results", free("Prova"));
        return insertOnVisitA(tx, "visit_test_results", free("prova"));
      }),
      "23505",
    );
  });

  it('controllo: test libero "Prova" e "Forza" sullo stesso lato: accettati', async () => {
    const rows = await inService(db, async (tx) => [
      await insertOnVisitA(tx, "visit_test_results", free("Prova")),
      await insertOnVisitA(tx, "visit_test_results", free("Forza")),
    ]);
    expect(rows.map((row) => row.custom_label)).toEqual(["Prova", "Forza"]);
  });
});

describe("public.visit_treatments", () => {
  const treatment = (extra: Values = {}): Values => ({
    region: "cervical",
    technique_code: "articolatoria",
    family: "direct",
    ...extra,
  });
  const TECHNIQUES = [
    "tessuti_molli",
    "articolatoria",
    "hvla",
    "energia_muscolare",
    "got",
    "inibizione",
    "fasciale",
    "craniale",
    "viscerale",
    "still",
    "funzionale",
    "counterstrain",
    "blt",
    "linfatica",
    "riflessi",
  ];

  it("i default", async () => {
    const row = await inService(db, (tx) => insertOnNewVisit(tx, "visit_treatments", treatment()));
    expect(row).toMatchObject({
      custom_technique: null,
      approach: null,
      response: null,
      tolerance: "buona",
      note: null,
      copied: false,
    });
  });

  it.each<Case>([
    ["region", "collo"],
    ["technique_code", "osteopatia"],
    ["approach", "misto"],
    ["family", "hvla"],
    ["response", "guarito"],
    ["tolerance", "scarsa"],
    ["note", "a".repeat(301)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "visit_treatments", treatment({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ...R10.map((region): Case => ["region", region]),
    ...TECHNIQUES.map((technique): Case => ["technique_code", technique]),
    ...["direct", "indirect"].map((approach): Case => ["approach", approach]),
    ...["thrust", "direct", "indirect"].map((family): Case => ["family", family]),
    ...["migliorato", "invariato", "peggiorato"].map((response): Case => ["response", response]),
    ...["buona", "fastidio", "interrotta"].map((tolerance): Case => ["tolerance", tolerance]),
    ["note", "a".repeat(300)],
    ["copied", true],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertOnNewVisit(tx, "visit_treatments", treatment({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it("altra senza custom_technique: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "visit_treatments", treatment({ technique_code: "altra" }))),
      "23514",
    );
  });

  it("custom_technique su una tecnica del catalogo: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "visit_treatments", treatment({ custom_technique: "Pompage" }))),
      "23514",
    );
  });

  it("altra con custom_technique di 61 caratteri: 23514", async () => {
    await expectPgError(
      inService(db, (tx) =>
        insertOnNewVisit(tx, "visit_treatments", treatment({ technique_code: "altra", custom_technique: "a".repeat(61) })),
      ),
      "23514",
    );
  });

  it("altra con custom_technique di 60 caratteri: accettata", async () => {
    const row = await inService(db, (tx) =>
      insertOnNewVisit(tx, "visit_treatments", treatment({ technique_code: "altra", custom_technique: "a".repeat(60) })),
    );
    expect(row).toMatchObject({ technique_code: "altra", custom_technique: "a".repeat(60) });
  });

  it("la stessa tecnica nella stessa regione della stessa visita: 23505", async () => {
    await expectPgError(
      inService(db, (tx) =>
        insertOnVisitA(tx, "visit_treatments", treatment({ region: "lumbar", tolerance: "fastidio" })),
      ),
      "23505",
    );
  });

  it("controllo: la stessa tecnica in un'altra regione: accettata", async () => {
    const row = await inService(db, (tx) => insertOnVisitA(tx, "visit_treatments", treatment()));
    expect(row).toMatchObject({ region: "cervical", technique_code: "articolatoria" });
  });

  const other = (name: string): Values => treatment({ technique_code: "altra", custom_technique: name });

  it('altra "Pompage" e "pompage" nella stessa regione: 23505', async () => {
    await expectPgError(
      inService(db, async (tx) => {
        await insertOnVisitA(tx, "visit_treatments", other("Pompage"));
        return insertOnVisitA(tx, "visit_treatments", other("pompage"));
      }),
      "23505",
    );
  });

  it('controllo: altra "Pompage" e "Trazione" nella stessa regione: accettate', async () => {
    const rows = await inService(db, async (tx) => [
      await insertOnVisitA(tx, "visit_treatments", other("Pompage")),
      await insertOnVisitA(tx, "visit_treatments", other("Trazione")),
    ]);
    expect(rows.map((row) => row.custom_technique)).toEqual(["Pompage", "Trazione"]);
  });
});

describe("public.visit_advice", () => {
  const advice = (extra: Values = {}): Values => ({ text: "Cammina venti minuti al giorno", ...extra });

  it("i default: communicated_via {a_voce}", async () => {
    const row = await inService(db, (tx) => insertOnNewVisit(tx, "visit_advice", advice()));
    expect(row).toMatchObject({ communicated_via: ["a_voce"], template_code: null, copied: false });
  });

  it.each<Case>([
    ["text", "a".repeat(1001)],
    ["communicated_via", []],
    ["communicated_via", ["email"]],
    ["communicated_via", ["a_voce", "email"]],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertOnNewVisit(tx, "visit_advice", advice({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["text", "a".repeat(1000)],
    ["template_code", "camminare"],
    ...["a_voce", "foglio_stampato", "messaggio_copiato"].map((via): Case => ["communicated_via", [via]]),
    ["communicated_via", ["a_voce", "foglio_stampato", "messaggio_copiato"]],
    ["copied", true],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertOnNewVisit(tx, "visit_advice", advice({ [column]: value })));
    expect(row[column]).toEqual(value);
  });
});

describe("public.visit_amendments", () => {
  const amendment = (extra: Values = {}): Values => ({
    amended_at: "2026-10-13T09:00:00Z",
    reason: "Corretto il piano dopo la telefonata",
    changes: JSON.stringify({ plan_next: { before: null, after: "Controllo fra un mese" } }),
    ...extra,
  });

  it("changes resta il JSON scritto", async () => {
    const row = await inService(db, (tx) => insertOnVisitA(tx, "visit_amendments", amendment()));
    expect(row.changes).toEqual({ plan_next: { before: null, after: "Controllo fra un mese" } });
  });

  it.each<Case>([
    ["reason", "a".repeat(9)],
    ["reason", " ".repeat(10)],
    ["reason", "a".repeat(501)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertOnVisitA(tx, "visit_amendments", amendment({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["reason", "a".repeat(10)],
    ["reason", "a".repeat(500)],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertOnVisitA(tx, "visit_amendments", amendment({ [column]: value })));
    expect(row[column]).toBe(value);
  });
});

describe("public.referrals", () => {
  const SHARED = ["stampata", "consegnata_al_paziente", "inviata"];

  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "referrals", referral()));
    expect(row).toMatchObject({
      status: "bozza",
      patient_agreed_to_share: false,
      visit_id: null,
      physician_id: null,
      recipient_free: null,
      delivered_on: null,
      physician_reply_note: null,
      letter_file_id: null,
    });
  });

  it.each<Case>([
    ["recipient_kind", "medico"],
    ["reason", "controllo"],
    ["urgency", "subito"],
    ["status", "spedita"],
    ["summary_text", "a".repeat(3001)],
    ["request_text", "a".repeat(1001)],
    ["physician_reply_note", "a".repeat(1001)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "referrals", referral({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ...["medico_curante", "medico_inviante", "specialista", "pronto_soccorso", "altro"].map(
      (kind): Case => ["recipient_kind", kind],
    ),
    ...["red_flag", "sintomi_persistenti", "peggioramento", "fuori_competenza", "richiesta_paziente", "altro"].map(
      (reason): Case => ["reason", reason],
    ),
    ...["emergenza", "urgente", "programmato"].map((urgency): Case => ["urgency", urgency]),
    ["summary_text", "a".repeat(3000)],
    ["request_text", "a".repeat(1000)],
    ["physician_reply_note", "a".repeat(1000)],
    ["recipient_free", "Dott. Neri, ortopedico"],
    ["physician_id", PHYSICIAN_A],
    ["visit_id", VISIT_A],
    ["delivered_on", "2026-10-20"],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "referrals", referral({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it.each(SHARED)("%s senza patient_agreed_to_share: 23514", async (status) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "referrals", referral({ status }))),
      "23514",
    );
  });

  it.each(SHARED)("%s con patient_agreed_to_share: accettato", async (status) => {
    const row = await inService(db, (tx) =>
      insertRow(tx, "referrals", referral({ status, patient_agreed_to_share: true })),
    );
    expect(row).toMatchObject({ status, patient_agreed_to_share: true });
  });
});

describe("lettera del rinvio (referrals_letter_guard)", () => {
  const SET_LETTER = "update public.referrals set letter_file_id = $2 where id = $1 returning letter_file_id";

  it("letter_file_id da null a FILE_A (uA): passa", async () => {
    const rows = await inRollback(db, "A", (tx) => tx.query(SET_LETTER, [REFERRAL_A, FILE_A]));
    expect(rows).toEqual([{ letter_file_id: FILE_A }]);
  });

  it("poi di nuovo a null (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await tx.query(SET_LETTER, [REFERRAL_A, FILE_A]);
        return tx.query(SET_LETTER, [REFERRAL_A, null]);
      }),
      "42501",
    );
  });

  it("poi a un altro file (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await tx.query(SET_LETTER, [REFERRAL_A, FILE_A]);
        return tx.query(SET_LETTER, [REFERRAL_A, await newFile(tx, PRACTICE_A)]);
      }),
      "42501",
    );
  });

  it("a null come servizio, su una lettera salvata: 42501", async () => {
    await expectPgError(
      inRollback(db, "service", (tx) => tx.query(SET_LETTER, [frozenA.referralId, null])),
      "42501",
    );
  });

  it("controllo: lo stesso file riscritto passa, e gli altri campi del rinvio cambiano (uA)", async () => {
    const rows = await inRollback(db, "A", (tx) =>
      tx.query(
        `update public.referrals
            set letter_file_id = $2, status = 'consegnata_al_paziente', delivered_on = '2026-10-20'
          where id = $1 returning status, letter_file_id`,
        [frozenA.referralId, FILE_A],
      ),
    );
    expect(rows).toEqual([{ status: "consegnata_al_paziente", letter_file_id: FILE_A }]);
  });
});

describe("public.patient_attachments", () => {
  const attachment = (fileId: string, extra: Values = {}): Values => ({
    practice_id: PRACTICE_A,
    patient_id: PATIENT_A1,
    file_id: fileId,
    kind: "referto",
    taken_on: "2026-10-19",
    ...extra,
  });

  /** Un allegato nuovo di A1 con un suo file, riletto. */
  async function insertAttachment(tx: Tx, extra: Values = {}): Promise<Record<string, unknown>> {
    return insertRow(tx, "patient_attachments", attachment(await newFile(tx, PRACTICE_A), extra));
  }

  it("i default", async () => {
    const row = await inService(db, (tx) => insertAttachment(tx));
    expect(row).toMatchObject({
      visit_id: null,
      cycle_id: null,
      view: null,
      width_px: null,
      height_px: null,
      caption: null,
      deleted_at: null,
    });
  });

  it.each<Case>([
    ["kind", "radiografia"],
    ["view", "alto"],
    ["caption", "a".repeat(201)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertAttachment(tx, { [column]: value })),
      "23514",
    );
  });

  it.each<Case>([
    ...["referto", "lettera", "altro"].map((kind): Case => ["kind", kind]),
    ...["anteriore", "posteriore", "laterale_dx", "laterale_sx", "altro"].map((view): Case => ["view", view]),
    ["caption", "a".repeat(200)],
    ["width_px", 4032],
    ["height_px", 3024],
    ["visit_id", VISIT_A],
    ["cycle_id", CYCLE_A],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertAttachment(tx, { [column]: value }));
    expect(row[column]).toBe(value);
  });

  it("foto_posturale senza view: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertAttachment(tx, { kind: "foto_posturale" })),
      "23514",
    );
  });

  it("controllo: foto_posturale con view: accettata", async () => {
    const row = await inService(db, (tx) => insertAttachment(tx, { kind: "foto_posturale", view: "laterale_dx" }));
    expect(row).toMatchObject({ kind: "foto_posturale", view: "laterale_dx" });
  });

  it("lo stesso file in due allegati: 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "patient_attachments", attachment(FILE_A))),
      "23505",
    );
  });
});

// Contratto di purga: (a) il servizio con la purga di A scrive una riga
// congelata di A; (b) con la purga di A, la stessa scrittura su una riga congelata di B dà 42501;
// (c) uA con la purga di A resta fermo sulla riga di A.
describe("uscita di purga", () => {
  type FrozenWrite = [label: string, write: (tx: Tx, frozen: Frozen) => Promise<unknown[]>];
  const FROZEN_WRITES: FrozenWrite[] = [
    [
      "update di una visita chiusa",
      (tx, frozen) => tx.query(UPDATE_PLAN, [frozen.visitId, "Controllo fra un mese"]),
    ],
    [
      "delete di una figlia di una visita chiusa",
      (tx, frozen) =>
        tx.query("delete from public.visit_region_findings where visit_id = $1 returning id", [frozen.visitId]),
    ],
    [
      "letter_file_id del rinvio riportato a null",
      (tx, frozen) =>
        tx.query("update public.referrals set letter_file_id = null where id = $1 returning id", [frozen.referralId]),
    ],
  ];

  it.each(FROZEN_WRITES)("(a) servizio con la purga di A: %s di A passa", async (_label, write) => {
    const rows = await inRollback(db, "service", async (tx) => {
      await setPurge(tx, PRACTICE_A);
      return write(tx, frozenA);
    });
    expect(rows).toHaveLength(1);
  });

  it.each(FROZEN_WRITES)("(b) servizio con la purga di A: %s di B: 42501", async (_label, write) => {
    await expectPgError(
      inRollback(db, "service", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return write(tx, frozenB);
      }),
      "42501",
    );
  });

  it.each(FROZEN_WRITES)("(c) uA con la purga di A: %s di A: 42501", async (_label, write) => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return write(tx, frozenA);
      }),
      "42501",
    );
  });

  // Un update esce solo se la riga resta nello studio della purga: la purga di A non porta una riga di A dentro
  // la visita chiusa di B, e non porta a B una riga congelata di A.
  type MoveToB = [label: string, move: (tx: Tx) => Promise<unknown[]>];
  const MOVES_TO_B: MoveToB[] = [
    [
      "un consiglio della visita in bozza di A nella visita chiusa di B",
      async (tx) => {
        const adviceId = idOf(await insertOnVisitA(tx, "visit_advice", { text: "Alterna seduta e in piedi ogni ora" }));
        await setPurge(tx, PRACTICE_A);
        return tx.query("update public.visit_advice set practice_id = $1, visit_id = $2 where id = $3 returning id", [
          PRACTICE_B,
          frozenB.visitId,
          adviceId,
        ]);
      },
    ],
    [
      "la visita chiusa di A",
      async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return tx.query("update public.visits set practice_id = $1 where id = $2 returning id", [
          PRACTICE_B,
          frozenA.visitId,
        ]);
      },
    ],
    [
      "il rinvio di A con la lettera, sul file di B",
      async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return tx.query("update public.referrals set practice_id = $1, letter_file_id = $2 where id = $3 returning id", [
          PRACTICE_B,
          FILE_B,
          frozenA.referralId,
        ]);
      },
    ],
  ];

  it.each(MOVES_TO_B)("(b) servizio con la purga di A: spostare su B %s: 42501", async (_label, move) => {
    await expectPgError(inRollback(db, "service", move), "42501");
  });
});
