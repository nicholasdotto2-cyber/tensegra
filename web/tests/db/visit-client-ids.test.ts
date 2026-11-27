import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock, romeDateTime } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { addPsfsItem } from "@/server/domain/cycles/commands";
import { NOT_ALLOWED } from "@/server/domain/errors";
import { createPatient } from "@/server/domain/patients/commands";
import { amendVisit, closeVisit, copyFromPreviousVisit, editVisit, startVisit } from "@/server/domain/visits/commands";
import { PRACTICE_A, PRACTICE_B } from "./fixtures";
import { asServiceFor, asUserA, asUserB, inUserA, insertRow, openTestDb } from "./helpers";

const clock = fixedClock("2026-11-04T12:30:00+01:00");
let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

interface Target { visitId: string; cycleId: string; patientId: string }

async function visitOn(tx: Tx, practiceId: string, patientId: string, cycleId: string, day: string): Promise<string> {
  const [service] = await tx.query<{ id: string }>("select id from public.services where practice_id = $1 limit 1", [practiceId]);
  if (!service) throw new Error("Servizio mancante");
  const appointment = await insertRow(tx, "appointments", {
    practice_id: practiceId, patient_id: patientId, cycle_id: cycleId, service_id: service.id,
    starts_at: romeDateTime(day, "09:00"), duration_min: 45, price_cents: 6000, status: "fatto",
  });
  const { visitId } = await startVisit(tx, practiceId, clock, { appointmentId: appointment.id });
  for (const group of ["ci_sistemica", "ci_locale", "rf_rachide"]) {
    await editVisit(tx, practiceId, clock, { visitId, op: { op: "nessun_altra_voce", group } });
  }
  await editVisit(tx, practiceId, clock, { visitId, op: { op: "esiti", outcomes:
    ["thrust", "direct", "indirect"].map((family) => ({ family, outcome: "indicated" })),
  } });
  return visitId;
}

async function setup(tx: Tx, practiceId = PRACTICE_A): Promise<Target> {
  const { id: patientId } = await createPatient(tx, practiceId, clock, { firstName: "Luca", lastName: "Prova", birthDate: "1980-01-01" });
  const cycle = await insertRow(tx, "treatment_cycles", {
    practice_id: practiceId, patient_id: patientId, kind: "mantenimento", opened_on: "2026-10-20", title: "Prova retry",
  });
  const cycleId = String(cycle.id);
  return { patientId, cycleId, visitId: await visitOn(tx, practiceId, patientId, cycleId, "2026-10-20") };
}

const cases = [
  { name: "disfunzione", table: "visit_region_findings", op: { op: "disfunzione", region: "lumbar", severity: 2 } },
  { name: "test", table: "visit_test_results", op: { op: "test", testCode: "libero", customLabel: "Prova libera", valueBool: true } },
  { name: "tecnica", table: "visit_treatments", op: { op: "tecnica", region: "lumbar", techniqueCode: "tessuti_molli" } },
  { name: "consiglio", table: "visit_advice", op: { op: "consiglio", templateCode: "camminata", communicatedVia: ["a_voce"] } },
  { name: "psfs", table: "psfs_items", op: null },
  { name: "rettifica", table: "visit_amendments", op: null },
] as const;
type Case = (typeof cases)[number];

async function prepare(tx: Tx, c: Case, t: Target, practiceId = PRACTICE_A) {
  if (c.name === "rettifica") await closeVisit(tx, practiceId, clock, { visitId: t.visitId, confirmCopied: false, alsoMarkDone: false });
}
function write(tx: Tx, c: Case, t: Target, id?: string, practiceId = PRACTICE_A) {
  const identity = id === undefined ? {} : { id };
  if (c.name === "psfs") return addPsfsItem(tx, practiceId, clock, { cycleId: t.cycleId, activity: "Camminare", ...identity });
  if (c.name === "rettifica") return amendVisit(tx, practiceId, clock, {
    visitId: t.visitId, reason: "Correzione del dolore", ops: [{ op: "campi", values: { nprsPre: 4 } }], ...identity,
  });
  return editVisit(tx, practiceId, clock, { visitId: t.visitId, op: { ...c.op, ...identity } });
}
function rows(tx: Tx, c: Case, t: Target) {
  return tx.query<Record<string, unknown>>(`select * from public.${c.table} where ${c.name === "psfs" ? "cycle_id" : "visit_id"} = $1 order by id`,
    [c.name === "psfs" ? t.cycleId : t.visitId]);
}

describe("id del client", () => {
  for (const c of cases) {
    it(`stesso_id_una_riga: ${c.name}, anche dopo un altro aggiornamento`, async () => {
      await inUserA(db, async (tx) => {
        const t = await setup(tx);
        await prepare(tx, c, t);
        const id = randomUUID();
        const first = await write(tx, c, t, id);
        const before = await rows(tx, c, t);
        expect(before).toHaveLength(1);
        expect(before[0]?.id).toBe(id);
        if (c.op !== null) await editVisit(tx, PRACTICE_A, clock, {
          visitId: t.visitId, op: { ...c.op, ...(c.name === "disfunzione" ? { severity: 3 } :
            c.name === "consiglio" ? { text: "Consiglio aggiornato" } : { note: "Annotazione successiva" }) },
        });
        // Una seconda rettifica non deve essere annullata dal retry della prima.
        if (c.name === "rettifica") await amendVisit(tx, PRACTICE_A, clock, {
          visitId: t.visitId, reason: "Seconda correzione dolore", ops: [{ op: "campi", values: { nprsPre: 7 } }],
        });
        const saved = await rows(tx, c, t);
        expect(await write(tx, c, t, id)).toEqual(first);
        expect(await rows(tx, c, t)).toEqual(saved);
        if (c.name === "rettifica") {
          const [v] = await tx.query<{ nprs_pre: number }>("select nprs_pre from public.visits where id = $1", [t.visitId]);
          expect(v?.nprs_pre).toBe(7);
        }
      });
    });
    it(`id_di_un_altra_visita: ${c.name}`, async () => {
      const id = randomUUID();
      const t = await asUserA(db, async (tx) => {
        const target = await setup(tx);
        await prepare(tx, c, target);
        await write(tx, c, target, id);
        return target;
      });
      await expect(asUserA(db, async (tx) => {
        const other = await setup(tx);
        await prepare(tx, c, other);
        await write(tx, c, other, id);
      })).rejects.toThrow(NOT_ALLOWED);
      expect(await asUserA(db, (tx) => rows(tx, c, t))).toHaveLength(1);
    });
    it(`id_di_un_altro_studio: ${c.name}`, async () => {
      const id = randomUUID();
      const t = await asUserA(db, async (tx) => {
        const target = await setup(tx);
        await prepare(tx, c, target);
        await write(tx, c, target, id);
        return target;
      });
      const before = await asServiceFor(db, (tx) => rows(tx, c, t));
      await expect(asUserB(db, async (tx) => {
        expect(await rows(tx, c, t)).toEqual([]);
        const other = await setup(tx, PRACTICE_B);
        await prepare(tx, c, other, PRACTICE_B);
        await write(tx, c, other, id, PRACTICE_B);
      })).rejects.toThrow();
      expect(await asServiceFor(db, (tx) => rows(tx, c, t))).toEqual(before);
    });
    it(`senza_id_come_oggi: ${c.name}`, async () => {
      await inUserA(db, async (tx) => {
        const t = await setup(tx);
        await prepare(tx, c, t);
        await write(tx, c, t);
        await write(tx, c, t);
        expect(await rows(tx, c, t)).toHaveLength(c.name === "psfs" || c.name === "rettifica" ? 2 : 1);
      });
    });
  }

  it("copia_due_volte: stessi campi, nessuna riga duplicata", async () => {
    await inUserA(db, async (tx) => {
      const t = await setup(tx);
      for (const c of cases.filter((c) => c.op !== null)) await write(tx, c, t);
      await closeVisit(tx, PRACTICE_A, clock, { visitId: t.visitId, confirmCopied: false, alsoMarkDone: false });
      const visitId = await visitOn(tx, PRACTICE_A, t.patientId, t.cycleId, "2026-11-03");
      const copy = () => copyFromPreviousVisit(tx, PRACTICE_A, clock, { visitId, replace: false });
      expect((await copy()).needsReplace).toBe(false);
      const target = { ...t, visitId };
      const before = await Promise.all(cases.slice(0, 3).map((c) => rows(tx, c, target)));
      expect(before.map((r) => r.length)).toEqual([1, 1, 1]);
      expect((await copy()).needsReplace).toBe(true);
      expect(await Promise.all(cases.slice(0, 3).map((c) => rows(tx, c, target)))).toEqual(before);
    });
  });

  it("rettifica_rifiuta_id_figlio_di_un_altra_visita_prima_di_scrivere", async () => {
    const id = randomUUID();
    const source = await asUserA(db, async (tx) => {
      const t = await setup(tx);
      await write(tx, cases[0], t, id);
      return t;
    });
    const target = await asUserA(db, async (tx) => {
      const t = await setup(tx);
      // Una riga della stessa regione non deve nascondere l'id della visita diversa.
      await write(tx, cases[0], t);
      await prepare(tx, cases[5], t);
      return t;
    });
    await expect(asUserA(db, (tx) => amendVisit(tx, PRACTICE_A, clock, {
      id: randomUUID(), visitId: target.visitId, reason: "Correggo la disfunzione", ops: [{ ...cases[0].op, id }],
    }))).rejects.toThrow(NOT_ALLOWED);
    expect(await asUserA(db, (tx) => rows(tx, cases[5], target))).toEqual([]);
    expect((await asUserA(db, (tx) => rows(tx, cases[0], source)))[0]?.severity).toBe(2);
  });
});
