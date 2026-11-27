import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, Tx } from "@/server/db/db";
import { APPOINTMENT_A, CYCLE_A, PATIENT_A1, PRACTICE_A, SERVICE_A, VISIT_A } from "./fixtures";
import { expectPgError, idOf, inUserA, insertRow, openTestDb, type Values } from "./helpers";

// La visita sta nel ciclo del suo appuntamento (migrazione 20261024100000), provata come uA.
// Il ciclo di una visita non cambia da nessuno dei due lati: né la visita verso un altro ciclo, né
// l'appuntamento (lo ferma il trigger dell'appuntamento, già della migrazione 5).

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const RULE = /La visita sta nel ciclo del suo appuntamento/;

/**
 * Un secondo ciclo di A1 (CYCLE_A2), già chiuso e aperto prima dell'appuntamento: un insert aperto si scontra con
 * `treatment_cycles_one_open_idx` (CYCLE_A è aperto).
 */
async function secondCycle(tx: Tx): Promise<string> {
  return idOf(
    await insertRow(tx, "treatment_cycles", {
      practice_id: PRACTICE_A,
      patient_id: PATIENT_A1,
      opened_on: "2026-09-01",
      title: "Cervicalgia, settembre 2026",
      expected_sessions: 4,
      status: "closed",
      closed_on: "2026-09-30",
      outcome: "raggiunto",
    }),
  );
}

/** Un appuntamento nuovo di A1 su CYCLE_A, senza visita, lunedì 19/10/2026 alle 09:00 di Roma. */
async function freeAppointment(tx: Tx): Promise<string> {
  return idOf(
    await insertRow(tx, "appointments", {
      practice_id: PRACTICE_A,
      patient_id: PATIENT_A1,
      service_id: SERVICE_A,
      cycle_id: CYCLE_A,
      starts_at: "2026-10-19T07:00:00Z",
      duration_min: 45,
      price_cents: 6000,
    }),
  );
}

const visit = (appointmentId: string, cycleId: string): Values => ({
  practice_id: PRACTICE_A,
  patient_id: PATIENT_A1,
  cycle_id: cycleId,
  appointment_id: appointmentId,
  visit_date: "2026-10-19",
  kind: "seduta",
  screening_catalog_version: 1,
});

describe("la visita sta nel ciclo del suo appuntamento", () => {
  it("insert di una visita in un altro ciclo dello stesso paziente: 23514", async () => {
    await expectPgError(
      inUserA(db, async (tx) => {
        const otherId = await secondCycle(tx);
        return insertRow(tx, "visits", visit(await freeAppointment(tx), otherId));
      }),
      "23514",
      RULE,
    );
  });

  it("update di VISIT_A verso un altro ciclo: 23514", async () => {
    await expectPgError(
      inUserA(db, async (tx) => {
        const otherId = await secondCycle(tx);
        return tx.query("update public.visits set cycle_id = $2 where id = $1", [VISIT_A, otherId]);
      }),
      "23514",
      RULE,
    );
  });

  it("update dell'appuntamento della visita verso un altro ciclo: 23514 del trigger dell'appuntamento", async () => {
    await expectPgError(
      inUserA(db, async (tx) => {
        const otherId = await secondCycle(tx);
        return tx.query("update public.appointments set cycle_id = $2 where id = $1", [APPOINTMENT_A, otherId]);
      }),
      "23514",
      /L'appuntamento ha una visita: paziente e ciclo restano quelli della visita/,
    );
  });

  it("controllo: la visita nello stesso ciclo dell'appuntamento si aggiorna e si inserisce", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const updated = await tx.query(
        "update public.visits set location = 'domicilio' where id = $1 returning id, location",
        [VISIT_A],
      );
      const inserted = await insertRow(tx, "visits", visit(await freeAppointment(tx), CYCLE_A));
      return { updated, inserted: inserted.cycle_id };
    });
    expect(outcome.updated).toEqual([{ id: VISIT_A, location: "domicilio" }]);
    expect(outcome.inserted).toBe(CYCLE_A);
  });
});
