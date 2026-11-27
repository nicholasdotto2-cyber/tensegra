import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, SqlParam, Tx } from "@/server/db/db";
import {
  CYCLE_A,
  CYCLE_B,
  PATIENT_A1,
  PATIENT_A2,
  PATIENT_A3,
  PATIENT_B2,
  PHYSICIAN_A,
  PHYSICIAN_B,
  PRACTICE_A,
  PRACTICE_B,
  PSFS_ITEM_A,
  PSFS_ITEM_B,
  SERVICE_A,
  VISIT_A,
} from "./fixtures";
import {
  asAnon,
  asServiceFor,
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

// Vincoli, default e trigger dei cicli, e l'uscita di purga dei trigger di
// immutabilità: treatment_cycles, psfs_items e app.purging(). Nelle fixture A1 ha un
// ciclo di trattamento aperto (CYCLE_A, dal 2026-10-01) con un'attività PSFS in posizione 1; questo
// file aggiunge in `beforeAll` un ciclo chiuso con un'attività sul secondo paziente di A e di B
// (A2, B2). Ogni test gira in una transazione che torna indietro; un caso che fallisce per
// transazione, con il codice Postgres esatto.

let db: Db;
let pg: PGlite;

/** Un ciclo chiuso con un'attività PSFS in posizione 1, salvato in `beforeAll`: nessun test lo cambia. */
interface ClosedCycle {
  practiceId: string;
  cycleId: string;
  itemId: string;
}
let closedA: ClosedCycle;
let closedB: ClosedCycle;

/** Un ciclo di primavera: l'attività si scrive finché è aperto, poi il ciclo si chiude. */
async function createClosedCycle(tx: Tx, practiceId: string, patientId: string): Promise<ClosedCycle> {
  const cycleId = idOf(
    await insertRow(tx, "treatment_cycles", {
      practice_id: practiceId,
      patient_id: patientId,
      opened_on: "2026-03-02",
      title: "Cervicalgia, marzo 2026",
      expected_sessions: 4,
    }),
  );
  const itemId = idOf(
    await insertRow(tx, "psfs_items", { practice_id: practiceId, cycle_id: cycleId, position: 1, activity: "Guidare" }),
  );
  await tx.query(
    "update public.treatment_cycles set status = 'closed', closed_on = '2026-04-10', outcome = 'raggiunto' where id = $1",
    [cycleId],
  );
  return { practiceId, cycleId, itemId };
}

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  // Come servizio, e salvati nel clone di questo file (non nel modello delle fixture).
  ({ a: closedA, b: closedB } = await asServiceFor(db, async (tx) => ({
    a: await createClosedCycle(tx, PRACTICE_A, PATIENT_A2),
    b: await createClosedCycle(tx, PRACTICE_B, PATIENT_B2),
  })));
});

afterAll(async () => {
  await pg?.close();
});

// A2 ha solo il ciclo chiuso di `beforeAll`: un ciclo nuovo su di lui non urta l'indice dei cicli aperti.
const cycle = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  patient_id: PATIENT_A2,
  opened_on: "2026-10-01",
  title: "Lombalgia, ottobre 2026",
  expected_sessions: 4,
  ...extra,
});

// La fixture del ciclo aperto di A1 è in posizione 1: un'attività nuova prende la 2.
const psfsItem = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  cycle_id: CYCLE_A,
  position: 2,
  activity: "Salire le scale",
  ...extra,
});

const CLOSE_SQL = "update public.treatment_cycles set status = 'closed', closed_on = $2, outcome = $3 where id = $1";

describe("public.treatment_cycles", () => {
  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "treatment_cycles", cycle()));
    expect(row).toMatchObject({
      kind: "trattamento",
      status: "open",
      medical_diagnosis_source: "assente",
      self_referred: true,
      main_region: null,
      referring_physician_id: null,
      plan_agreed_on: null,
      closed_on: null,
      outcome: null,
      previous_cycle_id: null,
    });
  });

  it.each<Case>([
    ["kind", "ciclo"],
    ["kind", "Trattamento"],
    ["status", "chiuso"],
    ["title", "a".repeat(81)],
    ["chief_complaint", "a".repeat(501)],
    ["main_region", "collo"],
    ["onset_mode", "improvviso"],
    ["medical_diagnosis_text", "a".repeat(301)],
    ["medical_diagnosis_source", "referto"],
    ["goal", "a".repeat(301)],
    ["expected_sessions", 0],
    ["plan_note", "a".repeat(1001)],
    ["outcome", "guarito"],
    ["outcome_note", "a".repeat(1001)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "treatment_cycles", cycle({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["kind", "mantenimento"],
    ["title", "a".repeat(80)],
    ["chief_complaint", "a".repeat(500)],
    ["main_region", "lumbar"],
    ["onset_on", "2026-09-20"],
    ["medical_diagnosis_text", "a".repeat(300)],
    ["self_referred", false],
    ["goal", "a".repeat(300)],
    ["expected_sessions", 1],
    ["expected_sessions", 20],
    ["plan_note", "a".repeat(1000)],
    ["plan_agreed_on", "2026-10-01"],
    ["outcome_note", "a".repeat(1000)],
    ...["acuto", "graduale", "post_traumatico", "ricorrente"].map((mode): Case => ["onset_mode", mode]),
    ...["referto_allegato", "riferita_dal_paziente", "assente"].map((source): Case => ["medical_diagnosis_source", source]),
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "treatment_cycles", cycle({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it("un secondo ciclo aperto per lo stesso paziente: 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "treatment_cycles", cycle({ patient_id: PATIENT_A1 }))),
      "23505",
    );
  });

  it("dopo la chiusura del primo, un nuovo ciclo aperto dello stesso paziente passa", async () => {
    const open = await inService(db, async (tx) => {
      await tx.query(CLOSE_SQL, [CYCLE_A, "2026-10-20", "raggiunto"]);
      await insertRow(tx, "treatment_cycles", cycle({ patient_id: PATIENT_A1, opened_on: "2026-10-21" }));
      return tx.query<{ n: number }>(
        "select count(*)::int as n from public.treatment_cycles where patient_id = $1 and status = 'open'",
        [PATIENT_A1],
      );
    });
    expect(open).toEqual([{ n: 1 }]);
  });

  it.each<[label: string, closedOn: string | null, outcome: string | null]>([
    ["senza outcome", "2026-10-20", null],
    ["senza closed_on", null, "raggiunto"],
    ["senza closed_on né outcome", null, null],
    ["con closed_on prima di opened_on", "2026-09-30", "raggiunto"],
  ])("chiuso %s: 23514", async (_label, closedOn, outcome) => {
    await expectPgError(
      inService(db, (tx) => tx.query(CLOSE_SQL, [CYCLE_A, closedOn, outcome])),
      "23514",
    );
  });

  it("closed_on prima di opened_on anche su un ciclo aperto: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "treatment_cycles", cycle({ closed_on: "2026-09-30" }))),
      "23514",
    );
  });

  it.each(["raggiunto", "parzialmente_raggiunto", "non_raggiunto", "interrotto_dal_paziente", "rinviato_al_medico"])(
    "chiuso il giorno stesso dell'apertura con esito %s: accettato",
    async (outcome) => {
      const rows = await inService(db, (tx) =>
        tx.query(`${CLOSE_SQL} returning status, closed_on, outcome`, [CYCLE_A, "2026-10-01", outcome]),
      );
      expect(rows).toEqual([{ status: "closed", closed_on: "2026-10-01", outcome }]);
    },
  );

  it("trattamento senza expected_sessions: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "treatment_cycles", cycle({ expected_sessions: null }))),
      "23514",
    );
  });

  it("mantenimento senza expected_sessions: accettato", async () => {
    const row = await inService(db, (tx) =>
      insertRow(tx, "treatment_cycles", cycle({ kind: "mantenimento", expected_sessions: null })),
    );
    expect(row).toMatchObject({ kind: "mantenimento", expected_sessions: null });
  });

  it("expected_sessions 21: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "treatment_cycles", cycle({ expected_sessions: 21 }))),
      "23514",
    );
  });

  it("medico inviante e ciclo precedente dello stesso studio: accettati", async () => {
    const row = await inService(db, (tx) =>
      insertRow(
        tx,
        "treatment_cycles",
        cycle({ referring_physician_id: PHYSICIAN_A, self_referred: false, previous_cycle_id: CYCLE_A }),
      ),
    );
    expect(row).toMatchObject({ referring_physician_id: PHYSICIAN_A, previous_cycle_id: CYCLE_A });
  });

  it("medico inviante di un altro studio: 23503", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "treatment_cycles", cycle({ referring_physician_id: PHYSICIAN_B }))),
      "23503",
    );
  });

  it("ciclo precedente di un altro studio: 23503", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "treatment_cycles", cycle({ previous_cycle_id: closedB.cycleId }))),
      "23503",
    );
  });

  // `on delete restrict` ferma la delete (23001 su Postgres 18, 23503 su Postgres 17: `expectBlockedDelete`):
  // la ricaduta tiene il ciclo da cui viene. Si cancella il ciclo chiuso di `beforeAll`, non CYCLE_A: le
  // fixture dei task successivi (appuntamenti, visite) tengono CYCLE_A con chiavi restrict, e la delete
  // verrebbe fermata anche da loro.
  // Fuori dalla purga un ciclo chiuso non si cancella (treatment_cycles_immutable, 42501): con la purga di
  // A il trigger lascia passare, e la chiave della ricaduta tiene lo stesso.
  it("con la purga di A, un ciclo chiuso a cui punta una ricaduta non si cancella", async () => {
    await expectBlockedDelete(
      inService(db, async (tx) => {
        await insertRow(tx, "treatment_cycles", cycle({ previous_cycle_id: closedA.cycleId }));
        await setPurge(tx, PRACTICE_A);
        return tx.query("delete from public.treatment_cycles where id = $1", [closedA.cycleId]);
      }),
    );
  });

  // La delete attraversa la chiave `cascade` e il trigger di guardia delle attività.
  // Il ciclo nasce nella transazione, per lo stesso motivo: nessuna chiave restrict dei task
  // successivi lo tiene.
  it("un ciclo aperto con due attività PSFS si cancella, e le attività con lui (uA)", async () => {
    const { cycleId, before, deleted, after } = await inRollback(db, "A", async (tx) => {
      const cycleId = idOf(await insertRow(tx, "treatment_cycles", cycle()));
      await insertRow(tx, "psfs_items", psfsItem({ cycle_id: cycleId, position: 1 }));
      await insertRow(tx, "psfs_items", psfsItem({ cycle_id: cycleId, position: 2 }));
      const countItems = async (): Promise<number | undefined> =>
        (
          await tx.query<{ n: number }>("select count(*)::int as n from public.psfs_items where cycle_id = $1", [cycleId])
        )[0]?.n;
      const before = await countItems();
      const deleted = await tx.query("delete from public.treatment_cycles where id = $1 returning id", [cycleId]);
      return { cycleId, before, deleted, after: await countItems() };
    });
    expect(before).toBe(2);
    expect(deleted).toEqual([{ id: cycleId }]);
    expect(after).toBe(0);
  });
});

/** L'update di una colonna del ciclo `cycleId`, con returning: senza errore dà la riga aggiornata. */
function updateCycle(tx: Tx, cycleId: string, column: string, value: SqlParam): Promise<unknown[]> {
  return tx.query(`update public.treatment_cycles set ${ident(column)} = $2 where id = $1 returning id`, [cycleId, value]);
}

const REOPEN_SQL =
  "update public.treatment_cycles set status = 'open', closed_on = null, outcome = null where id = $1 returning id";
const DELETE_CYCLE_SQL = "delete from public.treatment_cycles where id = $1 returning id";

// Un ciclo chiuso non si riapre (una ricaduta apre un ciclo nuovo con previous_cycle_id) e il suo
// esito resta un dato fermo. Riaprirlo toglierebbe anche il blocco delle sue attività PSFS (psfs_items_guard).
describe("ciclo chiuso (treatment_cycles_immutable)", () => {
  it("riaprire un ciclo chiuso (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) => tx.query(REOPEN_SQL, [closedA.cycleId])),
      "42501",
    );
  });

  // I trigger scattano anche per il superutente: BYPASSRLS salta le policy, non i trigger.
  it("riaprire un ciclo chiuso come servizio senza purga: 42501", async () => {
    await expectPgError(
      inRollback(db, "service", (tx) => tx.query(REOPEN_SQL, [closedA.cycleId])),
      "42501",
    );
  });

  it("riscrivere esito, nota e data di chiusura senza riaprire (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) =>
        tx.query(
          `update public.treatment_cycles
              set outcome = 'non_raggiunto', outcome_note = 'Riscritto dopo la chiusura', closed_on = '2026-04-20'
            where id = $1`,
          [closedA.cycleId],
        ),
      ),
      "42501",
    );
  });

  it.each<Case>([
    ["status", "open"],
    ["outcome", "non_raggiunto"],
    ["outcome_note", "Riscritto dopo la chiusura"],
    ["closed_on", "2026-04-11"],
    ["kind", "mantenimento"],
    ["patient_id", PATIENT_A3],
    ["opened_on", "2026-03-01"],
  ])("update di %s = %j di un ciclo chiuso (uA): 42501", async (column, value) => {
    await expectPgError(
      inRollback(db, "A", (tx) => updateCycle(tx, closedA.cycleId, column, value)),
      "42501",
    );
  });

  it("controllo: i campi congelati riscritti uguali passano, con titolo e note del piano (uA)", async () => {
    const rows = await inRollback(db, "A", (tx) =>
      tx.query(
        `update public.treatment_cycles
            set status = status, outcome = outcome, outcome_note = outcome_note, closed_on = closed_on, kind = kind,
                patient_id = patient_id, opened_on = opened_on, title = $2, plan_note = $3
          where id = $1 returning title, plan_note`,
        [closedA.cycleId, "Cervicalgia, primavera 2026", "Esercizi a casa due volte al giorno"],
      ),
    );
    expect(rows).toEqual([{ title: "Cervicalgia, primavera 2026", plan_note: "Esercizi a casa due volte al giorno" }]);
  });

  it("delete di un ciclo chiuso (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) => tx.query(DELETE_CYCLE_SQL, [closedA.cycleId])),
      "42501",
    );
  });

  it("delete di un ciclo chiuso come servizio senza purga: 42501", async () => {
    await expectPgError(
      inRollback(db, "service", (tx) => tx.query(DELETE_CYCLE_SQL, [closedA.cycleId])),
      "42501",
    );
  });
});

/** Un appuntamento di `patientId` sul ciclo `cycleId`, lunedì 19/10/2026 alle 09:00 di Roma (UTC+2): restituisce il suo id. */
async function newAppointment(tx: Tx, patientId: string, cycleId: string): Promise<string> {
  return idOf(
    await insertRow(tx, "appointments", {
      practice_id: PRACTICE_A,
      patient_id: patientId,
      service_id: SERVICE_A,
      cycle_id: cycleId,
      starts_at: "2026-10-19T07:00:00Z",
      duration_min: 45,
      price_cents: 6000,
    }),
  );
}

// Le regole della visita (lo stesso paziente del ciclo, mai prima dell'apertura del ciclo) dal lato del
// ciclo. Nelle fixture CYCLE_A ha APPOINTMENT_A e la visita in bozza del 5/10 (VISIT_A).
describe("regole del ciclo dal lato di appuntamenti e visite (treatment_cycles_rules)", () => {
  it("il paziente di un ciclo con un appuntamento non cambia: 23514", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        const cycleId = idOf(await insertRow(tx, "treatment_cycles", cycle()));
        await newAppointment(tx, PATIENT_A2, cycleId);
        return updateCycle(tx, cycleId, "patient_id", PATIENT_A3);
      }),
      "23514",
    );
  });

  // La visita sta sul ciclo e il suo appuntamento su un altro ciclo dello stesso paziente: dalla migrazione
  // 20261024100000 non si può più preparare, e il ciclo con una visita ha sempre un appuntamento.
  it("la visita sul ciclo e il suo appuntamento su un altro ciclo dello stesso paziente: 23514", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        const otherId = idOf(await insertRow(tx, "treatment_cycles", cycle({ opened_on: "2026-09-01" })));
        const appointmentId = await newAppointment(tx, PATIENT_A2, otherId);
        await tx.query(CLOSE_SQL, [otherId, "2026-09-30", "raggiunto"]);
        const cycleId = idOf(await insertRow(tx, "treatment_cycles", cycle()));
        return insertRow(tx, "visits", {
          practice_id: PRACTICE_A,
          patient_id: PATIENT_A2,
          cycle_id: cycleId,
          appointment_id: appointmentId,
          visit_date: "2026-10-19",
          kind: "prima_visita",
          screening_catalog_version: 1,
        });
      }),
      "23514",
      /La visita sta nel ciclo del suo appuntamento/,
    );
  });

  it("controllo: il paziente di un ciclo senza appuntamenti né visite cambia", async () => {
    const rows = await inService(db, async (tx) => {
      const cycleId = idOf(await insertRow(tx, "treatment_cycles", cycle()));
      return updateCycle(tx, cycleId, "patient_id", PATIENT_A3);
    });
    expect(rows).toHaveLength(1);
  });

  it("l'apertura del ciclo spostata dopo la sua prima visita: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => updateCycle(tx, CYCLE_A, "opened_on", "2026-10-06")),
      "23514",
    );
  });

  it.each(["2026-10-05", "2026-09-01"])("controllo: l'apertura del ciclo spostata al %s passa", async (openedOn) => {
    const rows = await inService(db, (tx) => updateCycle(tx, CYCLE_A, "opened_on", openedOn));
    expect(rows).toEqual([{ id: CYCLE_A }]);
  });
});

// Contratto di purga delle regole del ciclo: (a) il servizio con la purga di A fa la scrittura vietata sul ciclo di
// A; (b) con la purga di A la stessa scrittura sul ciclo di B (CYCLE_B, con APPOINTMENT_B e la visita del 5/10)
// dà 23514; (c) uA con la purga di A resta fermo sul ciclo di A.
describe("uscita di purga su treatment_cycles_rules", () => {
  type RuleWrite = [label: string, column: string, valueFor: (practiceId: string) => string];
  const RULE_WRITES: RuleWrite[] = [
    ["paziente di un ciclo con appuntamento e visita", "patient_id", (p) => (p === PRACTICE_A ? PATIENT_A2 : PATIENT_B2)],
    ["apertura dopo la prima visita", "opened_on", () => "2026-10-06"],
  ];
  const cycleOf = (practiceId: string): string => (practiceId === PRACTICE_A ? CYCLE_A : CYCLE_B);

  it.each(RULE_WRITES)("(a) servizio con la purga di A: %s di A passa", async (_label, column, valueFor) => {
    const rows = await inRollback(db, "service", async (tx) => {
      await setPurge(tx, PRACTICE_A);
      return updateCycle(tx, CYCLE_A, column, valueFor(PRACTICE_A));
    });
    expect(rows).toEqual([{ id: CYCLE_A }]);
  });

  it.each(RULE_WRITES)("(b) servizio con la purga di A: %s di B: 23514", async (_label, column, valueFor) => {
    await expectPgError(
      inRollback(db, "service", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return updateCycle(tx, cycleOf(PRACTICE_B), column, valueFor(PRACTICE_B));
      }),
      "23514",
    );
  });

  it.each(RULE_WRITES)("(c) uA con la purga di A: %s di A: 23514", async (_label, column, valueFor) => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return updateCycle(tx, CYCLE_A, column, valueFor(PRACTICE_A));
      }),
      "23514",
    );
  });
});

describe("public.psfs_items", () => {
  it.each<Case>([
    ["position", 4],
    ["position", 0],
    ["activity", "a".repeat(121)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "psfs_items", psfsItem({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["position", 2],
    ["position", 3],
    ["activity", "a".repeat(120)],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "psfs_items", psfsItem({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it("stessa position due volte nello stesso ciclo: 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "psfs_items", psfsItem({ position: 1 }))),
      "23505",
    );
  });

  it("la stessa position in un altro ciclo: accettata", async () => {
    const row = await inService(db, async (tx) => {
      const other = await insertRow(tx, "treatment_cycles", cycle());
      return insertRow(tx, "psfs_items", psfsItem({ cycle_id: idOf(other), position: 1 }));
    });
    expect(row).toMatchObject({ position: 1 });
  });
});

type Write = "insert" | "update" | "delete";
const WRITES: Write[] = ["insert", "update", "delete"];

/** Una scrittura sulle attività del ciclo chiuso `closed`, con returning: l'insert prende la posizione 2. */
function frozenWrite(tx: Tx, write: Write, closed: ClosedCycle): Promise<unknown[]> {
  switch (write) {
    case "insert":
      return tx.query(
        "insert into public.psfs_items (practice_id, cycle_id, position, activity) values ($1, $2, 2, 'Correre') returning id",
        [closed.practiceId, closed.cycleId],
      );
    case "update":
      return tx.query("update public.psfs_items set activity = 'Correre' where id = $1 returning id", [closed.itemId]);
    case "delete":
      return tx.query("delete from public.psfs_items where id = $1 returning id", [closed.itemId]);
  }
}

describe("psfs_items a ciclo chiuso (psfs_items_guard)", () => {
  it.each(WRITES)("%s come uA: 42501", async (write) => {
    await expectPgError(
      inRollback(db, "A", (tx) => frozenWrite(tx, write, closedA)),
      "42501",
    );
  });

  // I trigger scattano anche per il superutente: BYPASSRLS salta le policy, non i trigger.
  it.each(WRITES)("%s come servizio senza purga: 42501", async (write) => {
    await expectPgError(
      inRollback(db, "service", (tx) => frozenWrite(tx, write, closedA)),
      "42501",
    );
  });

  // Un'attività nuova, senza punteggi: PSFS_ITEM_A ha il punteggio della visita della fixture, e il cambio di
  // posizione lo fermerebbe anche la regola delle attività valutate.
  it("spostare un'attività da un ciclo aperto a uno chiuso: 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        const itemId = idOf(await insertRow(tx, "psfs_items", psfsItem()));
        return tx.query("update public.psfs_items set cycle_id = $1 where id = $2", [closedA.cycleId, itemId]);
      }),
      "42501",
    );
  });

  it("spostare un'attività da un ciclo chiuso a uno aperto: 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) =>
        tx.query("update public.psfs_items set cycle_id = $1, position = 2 where id = $2", [CYCLE_A, closedA.itemId]),
      ),
      "42501",
    );
  });
});

const RENAME_SQL = "update public.psfs_items set activity = 'Correre 30 minuti' where id = $1 returning id";
const CLOSE_VISIT_A_SQL = "update public.visits set status = 'closed', closed_at = '2026-10-05T08:00:00Z' where id = $1";

// Un punteggio dice quanto il paziente riesce a fare quell'attività: rinominarla o spostarla, anche a ciclo aperto,
// cambierebbe ciò che una visita ha registrato. Un'attività diversa è un'attività nuova. Nelle
// fixture PSFS_ITEM_A ha il punteggio iniziale della visita in bozza VISIT_A.
describe("attività PSFS con punteggi (psfs_items_guard)", () => {
  it("rinominare un'attività valutata in una visita chiusa (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await tx.query(CLOSE_VISIT_A_SQL, [VISIT_A]);
        return tx.query(RENAME_SQL, [PSFS_ITEM_A]);
      }),
      "42501",
    );
  });

  it("spostare di posizione un'attività valutata in una visita chiusa (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await tx.query(CLOSE_VISIT_A_SQL, [VISIT_A]);
        return tx.query("update public.psfs_items set position = 3 where id = $1 returning id", [PSFS_ITEM_A]);
      }),
      "42501",
    );
  });

  it("rinominare un'attività valutata in una visita in bozza (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) => tx.query(RENAME_SQL, [PSFS_ITEM_A])),
      "42501",
    );
  });

  it("rinominare un'attività valutata come servizio senza purga: 42501", async () => {
    await expectPgError(
      inRollback(db, "service", (tx) => tx.query(RENAME_SQL, [PSFS_ITEM_A])),
      "42501",
    );
  });

  it("controllo: un'attività senza punteggi si rinomina e cambia posizione (uA)", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      const itemId = idOf(await insertRow(tx, "psfs_items", psfsItem()));
      return tx.query(
        "update public.psfs_items set activity = 'Correre 30 minuti', position = 3 where id = $1 returning activity, position",
        [itemId],
      );
    });
    expect(rows).toEqual([{ activity: "Correre 30 minuti", position: 3 }]);
  });

  it("controllo: l'attività valutata riscritta uguale passa (uA)", async () => {
    const rows = await inRollback(db, "A", (tx) =>
      tx.query("update public.psfs_items set activity = activity, position = position where id = $1 returning id", [
        PSFS_ITEM_A,
      ]),
    );
    expect(rows).toEqual([{ id: PSFS_ITEM_A }]);
  });
});

// Contratto di purga della regola: (a) il servizio con la purga di A rinomina l'attività valutata di A; (b) con la
// purga di A l'attività valutata di B resta ferma; (c) uA con la purga di A resta fermo sull'attività di A.
describe("uscita di purga sulle attività PSFS con punteggi", () => {
  it("(a) servizio con la purga di A: rinominare l'attività valutata di A passa", async () => {
    const rows = await inRollback(db, "service", async (tx) => {
      await setPurge(tx, PRACTICE_A);
      return tx.query(RENAME_SQL, [PSFS_ITEM_A]);
    });
    expect(rows).toEqual([{ id: PSFS_ITEM_A }]);
  });

  it("(b) servizio con la purga di A: rinominare l'attività valutata di B: 42501", async () => {
    await expectPgError(
      inRollback(db, "service", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return tx.query(RENAME_SQL, [PSFS_ITEM_B]);
      }),
      "42501",
    );
  });

  it("(c) uA con la purga di A: rinominare l'attività valutata di A: 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return tx.query(RENAME_SQL, [PSFS_ITEM_A]);
      }),
      "42501",
    );
  });
});

// Contratto di purga: (a) il servizio con la purga di A scrive una riga
// congelata di A; (b) con la purga di A, la stessa scrittura su una riga congelata di B dà 42501;
// (c) uA con la purga di A resta fermo sulla riga di A.
describe("uscita di purga su psfs_items", () => {
  it.each(WRITES)("(a) servizio con la purga di A: %s su un'attività congelata di A passa", async (write) => {
    const rows = await inRollback(db, "service", async (tx) => {
      await setPurge(tx, PRACTICE_A);
      return frozenWrite(tx, write, closedA);
    });
    expect(rows).toHaveLength(1);
  });

  it.each(WRITES)("(b) servizio con la purga di A: %s su un'attività congelata di B: 42501", async (write) => {
    await expectPgError(
      inRollback(db, "service", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return frozenWrite(tx, write, closedB);
      }),
      "42501",
    );
  });

  it.each(WRITES)("(c) uA con la purga di A: %s su un'attività congelata di A: 42501", async (write) => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return frozenWrite(tx, write, closedA);
      }),
      "42501",
    );
  });

  // Un update esce solo se la riga resta nello studio della purga: la purga di A non porta un'attività di A
  // dentro il ciclo chiuso di B. L'attività nasce nella transazione, senza punteggi.
  it("(b) servizio con la purga di A: spostare un'attività di A nel ciclo chiuso di B: 42501", async () => {
    await expectPgError(
      inRollback(db, "service", async (tx) => {
        const itemId = idOf(await insertRow(tx, "psfs_items", psfsItem()));
        await setPurge(tx, PRACTICE_A);
        return tx.query("update public.psfs_items set practice_id = $1, cycle_id = $2 where id = $3 returning id", [
          PRACTICE_B,
          closedB.cycleId,
          itemId,
        ]);
      }),
      "42501",
    );
  });
});

// Contratto di purga del ciclo chiuso: (a) il servizio con la purga di A riapre e cancella il ciclo chiuso di A
// (la delete porta via anche la sua attività PSFS); (b) con la purga di A, il ciclo chiuso di B resta fermo;
// (c) uA con la purga di A resta fermo sul ciclo di A.
describe("uscita di purga su treatment_cycles", () => {
  type CycleWrite = [label: string, sql: string];
  const CYCLE_WRITES: CycleWrite[] = [
    ["riapertura", REOPEN_SQL],
    ["delete", DELETE_CYCLE_SQL],
  ];

  it.each(CYCLE_WRITES)("(a) servizio con la purga di A: %s del ciclo chiuso di A passa", async (_label, sql) => {
    const rows = await inRollback(db, "service", async (tx) => {
      await setPurge(tx, PRACTICE_A);
      return tx.query(sql, [closedA.cycleId]);
    });
    expect(rows).toEqual([{ id: closedA.cycleId }]);
  });

  it.each(CYCLE_WRITES)("(b) servizio con la purga di A: %s del ciclo chiuso di B: 42501", async (_label, sql) => {
    await expectPgError(
      inRollback(db, "service", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return tx.query(sql, [closedB.cycleId]);
      }),
      "42501",
    );
  });

  it.each(CYCLE_WRITES)("(c) uA con la purga di A: %s del ciclo chiuso di A: 42501", async (_label, sql) => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return tx.query(sql, [closedA.cycleId]);
      }),
      "42501",
    );
  });
});

describe("app.purging", () => {
  /** `app.purging(practiceId)` letta da `who`, con la purga aperta per `purge` (null: mai impostata) e il ruolo `role`. */
  async function purging(
    who: "A" | "service",
    purge: string | null,
    practiceId: string,
    role?: "service_role",
  ): Promise<boolean | undefined> {
    const rows = await inRollback(db, who, async (tx) => {
      if (purge !== null) await setPurge(tx, purge);
      if (role) await tx.query("select set_config('role', $1, true)", [role]);
      return tx.query<{ open: boolean }>("select app.purging($1) as open", [practiceId]);
    });
    return rows[0]?.open;
  }

  it("servizio senza purga: false", async () => {
    expect(await purging("service", null, PRACTICE_A)).toBe(false);
  });

  it("servizio con la purga di A, per A: true", async () => {
    expect(await purging("service", PRACTICE_A, PRACTICE_A)).toBe(true);
  });

  it("service_role con la purga di A, per A: true", async () => {
    expect(await purging("service", PRACTICE_A, PRACTICE_A, "service_role")).toBe(true);
  });

  it("servizio con la purga di A, per B: false", async () => {
    expect(await purging("service", PRACTICE_A, PRACTICE_B)).toBe(false);
  });

  it("uA con la purga di A, per A: false", async () => {
    expect(await purging("A", PRACTICE_A, PRACTICE_A)).toBe(false);
  });

  it("anon non la esegue: 42501", async () => {
    await expectPgError(
      asAnon(db, (tx) => tx.query("select app.purging($1)", [PRACTICE_A])),
      "42501",
    );
  });
});
