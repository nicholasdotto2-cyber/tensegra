import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Clock, fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { switchToUser } from "@/server/db/service";
import { toBlock } from "@/server/domain/appointments/blocks";
import { cancelAppointment, createAppointment } from "@/server/domain/appointments/commands";
import { listRange } from "@/server/domain/appointments/queries";
import { getOpenCycle } from "@/server/domain/cycles/queries";
import { createPatient } from "@/server/domain/patients/commands";
import { APPOINTMENT_B, PRACTICE_A, PRACTICE_B, SERVICE_A, USER_A, USER_B } from "./fixtures";
import { inService, inUserA, openTestDb } from "./helpers";

// Gli appuntamenti di un periodo per la griglia dell'agenda: i
// limiti dei giorni sono le 00:00 di Roma, così la domenica di 25 ore del 25/10/2026 e quella di 23 ore
// del 28/03/2027 stanno nella loro settimana; le posizioni (`toBlock`) sono minuti dell'orologio di
// Roma, mai differenze di istanti. I dati nascono come uA con i comandi dell'app; ogni test torna
// indietro. L'orologio è giovedì 22/10/2026 alle 08:30 di Roma.

const D0 = fixedClock("2026-10-22T08:30:00+02:00");

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

async function patient(tx: Tx, firstName: string, lastName: string): Promise<string> {
  return (await createPatient(tx, PRACTICE_A, D0, { firstName, lastName, birthDate: "1979-03-09" })).id;
}

/** Una seduta da 45 minuti (SERVICE_A) nel ciclo aperto del paziente, o in un ciclo nuovo. */
async function book(tx: Tx, patientId: string, day: string, time: string, clock: Clock = D0): Promise<string> {
  const open = await getOpenCycle(tx, PRACTICE_A, patientId);
  const created = await createAppointment(tx, PRACTICE_A, clock, {
    patient: { kind: "existing", patientId },
    serviceId: SERVICE_A,
    day,
    time,
    durationMin: 45,
    cycle: open ? { kind: "existing", cycleId: open.id } : { kind: "new" },
    priceCents: 6000,
    status: "prenotato",
  });
  const [first] = created.appointments;
  if (!first) throw new Error("nessun appuntamento creato");
  return first.id;
}

interface Booked {
  saturday: string;
  sunday10: string;
  sunday23: string;
  monday0030: string;
  spring23: string;
}

/** Sabato 24/10 alle 10:00, domenica 25/10 alle 10:00 e alle 23:00, lunedì 26/10 alle 00:30, domenica 28/03/2027 alle 23:00. */
async function bookAroundTheChanges(tx: Tx): Promise<Booked> {
  const marco = await patient(tx, "Marco", "Bellandi");
  return {
    saturday: await book(tx, marco, "2026-10-24", "10:00"),
    sunday10: await book(tx, marco, "2026-10-25", "10:00"),
    sunday23: await book(tx, marco, "2026-10-25", "23:00"),
    monday0030: await book(tx, marco, "2026-10-26", "00:30"),
    spring23: await book(tx, marco, "2027-03-28", "23:00"),
  };
}

describe("listRange e toBlock nei giorni del cambio d'ora", () => {
  it("la domenica di 25 ore sta nella settimana del 19/10, il lunedì alle 00:30 nella successiva", async () => {
    const out = await inUserA(db, async (tx) => {
      const ids = await bookAroundTheChanges(tx);
      return {
        ids,
        october: await listRange(tx, PRACTICE_A, "2026-10-19", "2026-10-26"),
        next: await listRange(tx, PRACTICE_A, "2026-10-26", "2026-11-02"),
      };
    });

    expect(out.october.map((a) => a.id)).toEqual([out.ids.saturday, out.ids.sunday10, out.ids.sunday23]);
    expect(out.october.map(toBlock)).toEqual([
      expect.objectContaining({ id: out.ids.saturday, day: "2026-10-24", startMin: 600, endMin: 645, timeRange: "10:00-10:45" }),
      expect.objectContaining({ id: out.ids.sunday10, day: "2026-10-25", startMin: 600, endMin: 645, timeRange: "10:00-10:45" }),
      expect.objectContaining({ id: out.ids.sunday23, day: "2026-10-25", startMin: 1380, endMin: 1425, timeRange: "23:00-23:45" }),
    ]);

    expect(out.next.map((a) => a.id)).toEqual([out.ids.monday0030]);
    expect(out.next.map(toBlock)).toEqual([
      expect.objectContaining({ day: "2026-10-26", startMin: 30, endMin: 75, timeRange: "00:30-01:15" }),
    ]);
  });

  it("la domenica di 23 ore del 28/03/2027 tiene le 23:00 alle 23:00", async () => {
    const out = await inUserA(db, async (tx) => {
      const ids = await bookAroundTheChanges(tx);
      return { ids, day: await listRange(tx, PRACTICE_A, "2027-03-28", "2027-03-29") };
    });
    expect(out.day.map((a) => a.id)).toEqual([out.ids.spring23]);
    expect(toBlock(out.day[0]!)).toEqual(
      expect.objectContaining({ day: "2027-03-28", startMin: 1380, endMin: 1425, timeRange: "23:00-23:45" }),
    );
  });
});

describe("listRange", () => {
  it("una riga per appuntamento con paziente, prestazione e colore; il blocco ha i campi della griglia", async () => {
    const out = await inUserA(db, async (tx) => {
      const ids = await bookAroundTheChanges(tx);
      return { ids, rows: await listRange(tx, PRACTICE_A, "2026-10-24", "2026-10-25") };
    });
    expect(out.rows).toEqual([
      {
        id: out.ids.saturday,
        startsAt: new Date("2026-10-24T08:00:00Z"),
        endsAt: new Date("2026-10-24T08:45:00Z"),
        status: "prenotato",
        patientFirstName: "Marco",
        patientLastName: "Bellandi",
        serviceName: "Seduta osteopatica",
        color: "petrolio",
      },
    ]);
    expect(toBlock(out.rows[0]!)).toEqual({
      id: out.ids.saturday,
      day: "2026-10-24",
      startMin: 600,
      endMin: 645,
      timeRange: "10:00-10:45",
      patientLabel: "Bellandi Marco",
      serviceName: "Seduta osteopatica",
      color: "petrolio",
      status: "prenotato",
      startsAtIso: "2026-10-24T08:00:00.000Z",
    });
  });

  it("restituisce ogni stato, anche l'annullato (la pagina decide se mostrarlo)", async () => {
    const out = await inUserA(db, async (tx) => {
      const ids = await bookAroundTheChanges(tx);
      await cancelAppointment(tx, PRACTICE_A, D0, { id: ids.sunday10, reason: "paziente", alsoFollowing: false });
      return { ids, rows: await listRange(tx, PRACTICE_A, "2026-10-25", "2026-10-26") };
    });
    expect(out.rows.map((a) => [a.id, a.status])).toEqual([
      [out.ids.sunday10, "annullato"],
      [out.ids.sunday23, "prenotato"],
    ]);
  });

  it("un periodo senza appuntamenti dà un elenco vuoto", async () => {
    const rows = await inUserA(db, (tx) => listRange(tx, PRACTICE_A, "2026-12-07", "2026-12-14"));
    expect(rows).toEqual([]);
  });
});

describe("isolamento", () => {
  it("uB non vede niente di A, nemmeno con lo studio di A; nel suo studio solo il suo appuntamento", async () => {
    const out = await inService(db, async (tx) => {
      await switchToUser(tx, { userId: USER_A });
      const ids = await bookAroundTheChanges(tx);
      const asA = await listRange(tx, PRACTICE_A, "2026-10-01", "2027-04-01");
      await switchToUser(tx, { userId: USER_B });
      return {
        ids,
        asA,
        asB: await listRange(tx, PRACTICE_A, "2026-10-01", "2027-04-01"),
        ownB: await listRange(tx, PRACTICE_B, "2026-10-01", "2027-04-01"),
      };
    });
    // Con l'appuntamento delle fixture del 5/10 e i cinque di questo test.
    expect(out.asA.map((a) => a.id)).toEqual(expect.arrayContaining(Object.values(out.ids)));
    expect(out.asA).toHaveLength(6);
    expect(out.asB).toEqual([]);
    expect(out.ownB.map((a) => a.id)).toEqual([APPOINTMENT_B]);
  });
});
