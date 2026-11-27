import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEMS } from "@/lib/clinical/catalog";
import { fixedClock, romeDateTime } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { createPatient } from "@/server/domain/patients/commands";
import { startVisit } from "@/server/domain/visits/commands";
import { editHistory, editOpening, editPsfsItem, editRelapse } from "@/server/domain/visits/section-a";
import { PRACTICE_A, PRACTICE_B, VISIT_A } from "./fixtures";
import { asUserB, inUserA, openTestDb } from "./helpers";

// Le scritture della sezione A dell'editor: una visita di un altro studio, o il ciclo
// e il paziente di un altro, non si raggiungono dalla visita; l'apertura si scrive solo dalla prima visita in bozza;
// la revisione degli apparati e dello stile di vita non va mai indietro. I dati nascono come uA e tornano indietro.

const clock = fixedClock("2026-11-04T08:30:00+01:00");

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const rejectionOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    (value: unknown) => expect.fail(`atteso un errore, invece il comando ha restituito ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );

/** Il comando risponde con "Operazione non permessa" (DomainError): la transazione resta valida. */
async function expectNotAllowed(p: Promise<unknown>): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(NOT_ALLOWED);
}

async function patient(tx: Tx, lastName: string): Promise<string> {
  const { id } = await createPatient(tx, PRACTICE_A, clock, { firstName: "Paolo", lastName, birthDate: "1985-05-05" });
  return id;
}

async function cycle(tx: Tx, patientId: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions)
     values ($1, $2, 'trattamento', '2026-10-01', 'Nuovo ciclo, ottobre 2026', 4) returning id`,
    [PRACTICE_A, patientId],
  );
  if (!row) throw new Error("ciclo non creato");
  return row.id;
}

/** Una visita in bozza di `day` sul ciclo, da un appuntamento già fatto. */
let serviceCount = 0;

async function visit(tx: Tx, patientId: string, cycleId: string, day: string): Promise<string> {
  const [service] = await tx.query<{ id: string }>(
    `insert into public.services (practice_id, kind, name, invoice_description, duration_min, price_cents, color)
     values ($1, 'seduta', $2, 'Prestazione di osteopatia', 45, 6000, 'petrolio') returning id`,
    [PRACTICE_A, `Voce seduta ${++serviceCount}`],
  );
  const [appointment] = await tx.query<{ id: string }>(
    `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status)
     values ($1, $2, $3, $4, $5, 45, 6000, 'fatto') returning id`,
    [PRACTICE_A, patientId, service?.id ?? null, cycleId, romeDateTime(day, "09:00")],
  );
  const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId: appointment?.id ?? null });
  return visitId;
}

async function psfsItem(tx: Tx, cycleId: string, activity: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    "insert into public.psfs_items (practice_id, cycle_id, position, activity) values ($1, $2, 1, $3) returning id",
    [PRACTICE_A, cycleId, activity],
  );
  if (!row) throw new Error("attività non creata");
  return row.id;
}

const systemRows = (status: "nulla" | "da_segnalare") => SYSTEMS.map(({ code }) => ({ system: code, status, note: null }));

describe("editOpening", () => {
  it("scrive il ciclo della visita e ignora un ciclo scelto dal client", async () => {
    const { own, other } = await inUserA(db, async (tx) => {
      const patientId = await patient(tx, "Bianchi");
      const cycleId = await cycle(tx, patientId);
      const otherCycleId = await cycle(tx, await patient(tx, "Verdi"));
      const visitId = await visit(tx, patientId, cycleId, "2026-11-03");
      await editOpening(tx, PRACTICE_A, clock, visitId, { goal: "Salire le scale", cycleId: otherCycleId });
      const goalOf = async (id: string) =>
        (await tx.query<{ goal: string | null }>("select goal from public.treatment_cycles where id = $1", [id]))[0]?.goal;
      return { own: await goalOf(cycleId), other: await goalOf(otherCycleId) };
    });
    expect(own).toBe("Salire le scale");
    expect(other).toBeNull();
  });

  it("si rifiuta da una visita di un altro studio, da una visita che non è la prima e da una visita chiusa", async () => {
    await expectNotAllowed(asUserB(db, (tx) => editOpening(tx, PRACTICE_B, clock, VISIT_A, { goal: "Altro studio" })));
    await inUserA(db, async (tx) => {
      const patientId = await patient(tx, "Rossi");
      const cycleId = await cycle(tx, patientId);
      const first = await visit(tx, patientId, cycleId, "2026-11-02");
      const second = await visit(tx, patientId, cycleId, "2026-11-03");
      await expectNotAllowed(editOpening(tx, PRACTICE_A, clock, second, { goal: "Dalla seconda" }));
      await tx.query("update public.visits set status = 'closed', closed_at = $3 where practice_id = $1 and id = $2", [
        PRACTICE_A,
        first,
        clock.now(),
      ]);
      await expectNotAllowed(editOpening(tx, PRACTICE_A, clock, first, { goal: "Dalla chiusa" }));
    });
  });
});

describe("editPsfsItem", () => {
  it("aggiunge, rinomina e toglie un'attività del ciclo della visita", async () => {
    const names = await inUserA(db, async (tx) => {
      const patientId = await patient(tx, "Neri");
      const cycleId = await cycle(tx, patientId);
      const visitId = await visit(tx, patientId, cycleId, "2026-11-03");
      await editPsfsItem(tx, PRACTICE_A, clock, visitId, { kind: "aggiungi", activity: "Pedalare" });
      const [item] = await tx.query<{ id: string }>("select id from public.psfs_items where cycle_id = $1", [cycleId]);
      await editPsfsItem(tx, PRACTICE_A, clock, visitId, { kind: "rinomina", itemId: item?.id, activity: "Pedalare a lungo" });
      const renamed = await tx.query<{ activity: string }>("select activity from public.psfs_items where cycle_id = $1", [cycleId]);
      await editPsfsItem(tx, PRACTICE_A, clock, visitId, { kind: "togli", itemId: item?.id });
      const left = await tx.query("select 1 from public.psfs_items where cycle_id = $1", [cycleId]);
      return { renamed: renamed.map((r) => r.activity), left: left.length };
    });
    expect(names).toEqual({ renamed: ["Pedalare a lungo"], left: 0 });
  });

  it("non tocca l'attività di un altro ciclo, né da uB né da un'altra visita dello stesso studio", async () => {
    await expectNotAllowed(
      asUserB(db, (tx) => editPsfsItem(tx, PRACTICE_B, clock, VISIT_A, { kind: "aggiungi", activity: "Altro studio" })),
    );
    const activity = await inUserA(db, async (tx) => {
      const patientId = await patient(tx, "Gialli");
      const cycleId = await cycle(tx, patientId);
      const visitId = await visit(tx, patientId, cycleId, "2026-11-03");
      const foreignItem = await psfsItem(tx, await cycle(tx, await patient(tx, "Blu")), "Camminare");
      await expectNotAllowed(editPsfsItem(tx, PRACTICE_A, clock, visitId, { kind: "rinomina", itemId: foreignItem, activity: "Rubata" }));
      await expectNotAllowed(editPsfsItem(tx, PRACTICE_A, clock, visitId, { kind: "togli", itemId: foreignItem }));
      const [row] = await tx.query<{ activity: string }>("select activity from public.psfs_items where id = $1", [foreignItem]);
      return row?.activity;
    });
    expect(activity).toBe("Camminare");
  });
});

describe("editRelapse", () => {
  it("si rifiuta da una visita di un altro studio e da una visita che non è la prima", async () => {
    await expectNotAllowed(
      asUserB(db, (tx) => editRelapse(tx, PRACTICE_B, clock, VISIT_A, { previousCycleId: "a0000000-0000-4000-8000-000000000401" })),
    );
    await inUserA(db, async (tx) => {
      const patientId = await patient(tx, "Viola");
      const cycleId = await cycle(tx, patientId);
      await visit(tx, patientId, cycleId, "2026-11-02");
      const second = await visit(tx, patientId, cycleId, "2026-11-03");
      await expectNotAllowed(editRelapse(tx, PRACTICE_A, clock, second, { previousCycleId: cycleId }));
    });
  });
});

describe("editHistory", () => {
  it("si rifiuta da una visita di un altro studio", async () => {
    await expectNotAllowed(
      asUserB(db, (tx) => editHistory(tx, PRACTICE_B, clock, VISIT_A, { kind: "stile", occupation: null, sport: null, familyHistory: null, pregnancyStatus: null, pregnancyWeeks: null })),
    );
  });

  it("scrive il paziente della visita e ignora un paziente scelto dal client", async () => {
    const { own, other } = await inUserA(db, async (tx) => {
      const patientId = await patient(tx, "Arancio");
      const otherId = await patient(tx, "Grigi");
      const visitId = await visit(tx, patientId, await cycle(tx, patientId), "2026-11-03");
      await editHistory(tx, PRACTICE_A, clock, visitId, {
        kind: "voce",
        item: { kind: "farmaco", label: "Tachipirina", region: null, occurredOn: null, occurredYear: null, ongoing: true, note: null, patientId: otherId },
      });
      const countOf = async (id: string) =>
        (await tx.query("select 1 from public.patient_history_items where patient_id = $1", [id])).length;
      return { own: await countOf(patientId), other: await countOf(otherId) };
    });
    expect({ own, other }).toEqual({ own: 1, other: 0 });
  });

  it("la revisione di apparati e stile di vita non va indietro quando si scrive da una visita più vecchia", async () => {
    const days = await inUserA(db, async (tx) => {
      const patientId = await patient(tx, "Marrone");
      const cycleId = await cycle(tx, patientId);
      const older = await visit(tx, patientId, cycleId, "2026-11-01");
      const newer = await visit(tx, patientId, cycleId, "2026-11-03");
      const lifestyle = { kind: "stile", occupation: "Cuoco", sport: null, familyHistory: null, pregnancyStatus: null, pregnancyWeeks: null };

      await editHistory(tx, PRACTICE_A, clock, newer, { kind: "apparati", rows: systemRows("nulla") });
      await editHistory(tx, PRACTICE_A, clock, newer, lifestyle);
      await editHistory(tx, PRACTICE_A, clock, older, { kind: "apparati", rows: systemRows("da_segnalare") });
      await editHistory(tx, PRACTICE_A, clock, older, { ...lifestyle, occupation: "Cuoco di sala" });

      const systems = await tx.query<{ day: string; status: string }>(
        "select distinct reviewed_on as day, status from public.patient_systems_review where patient_id = $1",
        [patientId],
      );
      const [style] = await tx.query<{ day: string; occupation: string }>(
        "select last_reviewed_on as day, occupation from public.patient_lifestyle where patient_id = $1",
        [patientId],
      );
      return { systems, style };
    });
    // Il contenuto è quello scritto per ultimo, la data resta quella della visita più recente.
    expect(days.systems).toEqual([{ day: "2026-11-03", status: "da_segnalare" }]);
    expect(days.style).toEqual({ day: "2026-11-03", occupation: "Cuoco di sala" });
  });
});
