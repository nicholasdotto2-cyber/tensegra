import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { romeDateTime } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import {
  APPOINTMENT_A,
  APPOINTMENT_B,
  CYCLE_A,
  CYCLE_B,
  PATIENT_A1,
  PATIENT_A2,
  PATIENT_B2,
  PRACTICE_A,
  PRACTICE_B,
  SERIES_A,
  SERIES_B,
  SERVICE_A,
} from "./fixtures";
import {
  type Case,
  expectBlockedDelete,
  expectPgError,
  idOf,
  inRollback,
  insertRow,
  inService,
  openTestDb,
  setPurge,
  type Values,
} from "./helpers";

// Vincoli, default e trigger dell'agenda: appointment_series e
// appointments. Nelle fixture ogni studio ha una serie e un appuntamento prenotato del primo
// paziente sul suo ciclo aperto (APPOINTMENT_A: A1, CYCLE_A, SERVICE_A). Ogni test gira in una
// transazione che torna indietro; un caso che fallisce per transazione, con il codice Postgres
// esatto. Gli istanti sono in UTC; accanto, l'ora di Roma che rappresentano.

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

/** Un `timestamptz` letto dal database (un `Date`) in ISO, per confrontarlo con l'istante atteso. */
function iso(value: unknown): string {
  if (!(value instanceof Date)) throw new Error("atteso un timestamptz letto come Date");
  return value.toISOString();
}

const series = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  weekday: 3,
  local_time: "18:00",
  interval_weeks: 2,
  count: 3,
  ...extra,
});

// Mercoledì 4/11/2026 alle 09:00 di Roma (ora solare, UTC+1), sul ciclo aperto di A1.
const appointment = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  patient_id: PATIENT_A1,
  service_id: SERVICE_A,
  cycle_id: CYCLE_A,
  starts_at: "2026-11-04T08:00:00Z",
  duration_min: 45,
  price_cents: 6000,
  ...extra,
});

describe("public.appointment_series", () => {
  it.each<Case>([
    ["weekday", 0],
    ["weekday", 8],
    ["interval_weeks", 0],
    ["interval_weeks", 5],
    ["count", 1],
    ["count", 13],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "appointment_series", series({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["weekday", 1],
    ["weekday", 7],
    ["interval_weeks", 1],
    ["interval_weeks", 4],
    ["count", 2],
    ["count", 12],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "appointment_series", series({ [column]: value })));
    expect(row[column]).toBe(value);
  });
});

describe("public.appointments", () => {
  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "appointments", appointment()));
    expect(row).toMatchObject({
      status: "prenotato",
      status_changed_at: null,
      cancel_reason: null,
      series_id: null,
      payment_method: null,
      no_invoice_reason: null,
      notes: null,
    });
  });

  it.each<Case>([
    ["duration_min", 0],
    ["duration_min", 20],
    ["duration_min", 255],
    ["status", "chiuso"],
    ["status", "Prenotato"],
    ["cancel_reason", "medico"],
    ["price_cents", -1],
    ["payment_method", "assegno"],
    ["no_invoice_reason", "omaggio"],
    ["notes", "a".repeat(301)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "appointments", appointment({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["duration_min", 15],
    ["duration_min", 240],
    ["price_cents", 0],
    ["notes", "a".repeat(300)],
    ["series_id", SERIES_A],
    ...["prenotato", "confermato", "fatto", "saltato"].map((status): Case => ["status", status]),
    ...["paziente", "studio", "altro"].map((reason): Case => ["cancel_reason", reason]),
    ...["contanti", "carta", "bonifico"].map((method): Case => ["payment_method", method]),
    ...["compresa_in_altra", "gratuita", "altro"].map((reason): Case => ["no_invoice_reason", reason]),
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "appointments", appointment({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it("annullato senza cancel_reason: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "appointments", appointment({ status: "annullato" }))),
      "23514",
    );
  });

  it("annullato con cancel_reason: accettato", async () => {
    const row = await inService(db, (tx) =>
      insertRow(tx, "appointments", appointment({ status: "annullato", cancel_reason: "studio" })),
    );
    expect(row).toMatchObject({ status: "annullato", cancel_reason: "studio" });
  });

  it("ends_at lo scrive il trigger: il valore passato non conta, e ogni update lo ricalcola", async () => {
    const ends = await inService(db, async (tx) => {
      const row = await insertRow(tx, "appointments", appointment({ ends_at: "2000-01-01T00:00:00Z" }));
      const update = async (set: string): Promise<string> => {
        const [updated] = await tx.query<{ ends_at: Date }>(
          `update public.appointments set ${set} where id = $1 returning ends_at`,
          [idOf(row)],
        );
        return iso(updated?.ends_at);
      };
      return [iso(row.ends_at), await update("duration_min = 60"), await update("ends_at = '2000-01-01T00:00:00Z'")];
    });
    expect(ends).toEqual(["2026-11-04T08:45:00.000Z", "2026-11-04T09:00:00.000Z", "2026-11-04T09:00:00.000Z"]);
  });

  it("ciclo di un altro paziente: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "appointments", appointment({ patient_id: PATIENT_A2 }))),
      "23514",
    );
  });

  it("spostare un appuntamento su un altro paziente con lo stesso ciclo (update): 23514", async () => {
    await expectPgError(
      inService(db, (tx) =>
        tx.query("update public.appointments set patient_id = $1 where id = $2", [PATIENT_A2, APPOINTMENT_A]),
      ),
      "23514",
    );
  });

  // Il trigger cerca il ciclo con (practice_id, cycle_id): non lo trova, lascia passare e risponde la chiave composta.
  it("ciclo di un altro studio: 23503", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "appointments", appointment({ cycle_id: CYCLE_B }))),
      "23503",
    );
  });

  it("serie di un altro studio: 23503", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "appointments", appointment({ series_id: SERIES_B }))),
      "23503",
    );
  });
});

/**
 * Un appuntamento a cavallo della mezzanotte di Roma: giorno e ora di Roma, lo stesso
 * istante in UTC scritto per esteso, la durata e la fine attesa in UTC (null: rifiutato con 23514).
 */
interface NightCase {
  label: string;
  romeDay: string;
  romeTime: string;
  startsAt: string;
  minutes: number;
  endsAt: string | null;
}

const NIGHT_CASES: NightCase[] = [
  // Ora solare (UTC+1): per UTC inizio e fine stanno nello stesso giorno, il 4/11; per Roma la fine è il 5.
  {
    label: "fine nel giorno dopo a Roma",
    romeDay: "2026-11-04",
    romeTime: "23:30",
    startsAt: "2026-11-04T22:30:00Z",
    minutes: 60,
    endsAt: null,
  },
  // Per UTC inizio e fine stanno in due giorni (4 e 5/11), per Roma entrambi nel 5.
  {
    label: "conta il giorno di Roma, non quello UTC",
    romeDay: "2026-11-05",
    romeTime: "00:30",
    startsAt: "2026-11-04T23:30:00Z",
    minutes: 60,
    endsAt: "2026-11-05T00:30:00.000Z",
  },
  // Fine dell'ora legale: il 25/10/2026 dura 25 ore e la mezzanotte del 26 è alle 23:00 UTC. Con
  // l'offset dell'estate (UTC+2) le 22:15 UTC sarebbero già il 26, e i 45 minuti passerebbero.
  {
    label: "25/10/2026 (25 ore), 45 minuti",
    romeDay: "2026-10-25",
    romeTime: "23:15",
    startsAt: "2026-10-25T22:15:00Z",
    minutes: 45,
    endsAt: null,
  },
  {
    label: "25/10/2026 (25 ore), 30 minuti",
    romeDay: "2026-10-25",
    romeTime: "23:15",
    startsAt: "2026-10-25T22:15:00Z",
    minutes: 30,
    endsAt: "2026-10-25T22:45:00.000Z",
  },
  // Inizio dell'ora legale: il 28/03/2027 dura 23 ore e la mezzanotte del 29 è alle 22:00 UTC. Con
  // l'offset dell'inverno (UTC+1) le 21:15 UTC sarebbero le 22:15, e i 45 minuti passerebbero.
  {
    label: "28/03/2027 (23 ore), 45 minuti",
    romeDay: "2027-03-28",
    romeTime: "23:15",
    startsAt: "2027-03-28T21:15:00Z",
    minutes: 45,
    endsAt: null,
  },
  {
    label: "28/03/2027 (23 ore), 30 minuti",
    romeDay: "2027-03-28",
    romeTime: "23:15",
    startsAt: "2027-03-28T21:15:00Z",
    minutes: 30,
    endsAt: "2027-03-28T21:45:00.000Z",
  },
];

describe("fine dell'appuntamento nello stesso giorno di Roma (appointments_rules)", () => {
  // I casi sono scritti in UTC: questo controllo prova che ogni istante è proprio l'ora di Roma del
  // caso, convertita da `romeDateTime` (l'ora a muro di Roma, mai "inizio + 24 ore").
  it.each(NIGHT_CASES)("$label: $startsAt è il $romeDay alle $romeTime di Roma", ({ romeDay, romeTime, startsAt }) => {
    expect(romeDateTime(romeDay, romeTime).toISOString()).toBe(new Date(startsAt).toISOString());
  });

  it.each(NIGHT_CASES.filter((night) => night.endsAt === null))("$label: 23514", async ({ startsAt, minutes }) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "appointments", appointment({ starts_at: startsAt, duration_min: minutes }))),
      "23514",
    );
  });

  it.each(NIGHT_CASES.filter((night) => night.endsAt !== null))(
    "$label: passa, fine $endsAt",
    async ({ startsAt, minutes, endsAt }) => {
      const row = await inService(db, (tx) =>
        insertRow(tx, "appointments", appointment({ starts_at: startsAt, duration_min: minutes })),
      );
      expect(iso(row.ends_at)).toBe(endsAt);
    },
  );

  it("un update che porta la fine al giorno dopo a Roma: 23514", async () => {
    await expectPgError(
      inService(db, (tx) =>
        tx.query("update public.appointments set starts_at = $1 where id = $2", ["2026-11-04T22:30:00Z", APPOINTMENT_A]),
      ),
      "23514",
    );
  });
});

describe("delete degli appuntamenti come uA (policy appointments_delete)", () => {
  /**
   * Un appuntamento di A1 con lo stato dato, inserito e poi cancellato da uA nella stessa
   * transazione: nasce lì perché le chiavi restrict dei task dopo (visite, righe di fattura)
   * potrebbero tenere APPOINTMENT_A. Restituisce le righe cancellate e quelle rimaste.
   */
  function deleteWithStatus(status: string): Promise<{ deleted: number; left: number | undefined }> {
    return inRollback(db, "A", async (tx) => {
      const id = idOf(
        await insertRow(
          tx,
          "appointments",
          appointment({ status, cancel_reason: status === "annullato" ? "paziente" : null }),
        ),
      );
      const deleted = await tx.query("delete from public.appointments where id = $1 returning id", [id]);
      const [left] = await tx.query<{ n: number }>("select count(*)::int as n from public.appointments where id = $1", [
        id,
      ]);
      return { deleted: deleted.length, left: left?.n };
    });
  }

  it.each(["prenotato", "confermato"])("%s: 1 riga cancellata", async (status) => {
    expect(await deleteWithStatus(status)).toEqual({ deleted: 1, left: 0 });
  });

  it.each(["fatto", "saltato", "annullato"])("%s: 0 righe, la riga resta", async (status) => {
    expect(await deleteWithStatus(status)).toEqual({ deleted: 0, left: 1 });
  });
});

/** Un ciclo aperto di `patientId` (A2 e B2 non ne hanno nelle fixture) nello studio dato: restituisce il suo id. */
async function openCycleOf(tx: Tx, practiceId: string, patientId: string): Promise<string> {
  return idOf(
    await insertRow(tx, "treatment_cycles", {
      practice_id: practiceId,
      patient_id: patientId,
      opened_on: "2026-10-01",
      title: "Cervicalgia, ottobre 2026",
      expected_sessions: 4,
    }),
  );
}

const MOVE_SQL = "update public.appointments set patient_id = $2, cycle_id = $3 where id = $1 returning id";

// Dal lato dell'appuntamento: con la visita, l'appuntamento non passa a un paziente o a un ciclo diversi da
// quelli della visita. Nelle fixture APPOINTMENT_A ha la visita in bozza di A1 sul ciclo CYCLE_A.
describe("appuntamento con la visita (appointments_rules)", () => {
  it("spostato su un altro paziente, con un ciclo di quel paziente: 23514", async () => {
    await expectPgError(
      inService(db, async (tx) =>
        tx.query(MOVE_SQL, [APPOINTMENT_A, PATIENT_A2, await openCycleOf(tx, PRACTICE_A, PATIENT_A2)]),
      ),
      "23514",
    );
  });

  // A1 ha già un ciclo aperto: l'altro ciclo nasce chiuso.
  it("spostato su un altro ciclo dello stesso paziente: 23514", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        const closedId = idOf(
          await insertRow(tx, "treatment_cycles", {
            practice_id: PRACTICE_A,
            patient_id: PATIENT_A1,
            opened_on: "2026-03-02",
            title: "Cervicalgia, marzo 2026",
            expected_sessions: 4,
            status: "closed",
            closed_on: "2026-04-10",
            outcome: "raggiunto",
          }),
        );
        return tx.query(MOVE_SQL, [APPOINTMENT_A, PATIENT_A1, closedId]);
      }),
      "23514",
    );
  });

  it("controllo: paziente e ciclo riscritti uguali passano, con le note (uA)", async () => {
    const rows = await inRollback(db, "A", (tx) =>
      tx.query(
        "update public.appointments set patient_id = patient_id, cycle_id = cycle_id, notes = $2 where id = $1 returning notes",
        [APPOINTMENT_A, "Porta le lastre"],
      ),
    );
    expect(rows).toEqual([{ notes: "Porta le lastre" }]);
  });

  it("controllo: un appuntamento senza visita passa a un altro paziente con il suo ciclo", async () => {
    const rows = await inService(db, async (tx) => {
      const appointmentId = idOf(await insertRow(tx, "appointments", appointment()));
      return tx.query(MOVE_SQL, [appointmentId, PATIENT_A2, await openCycleOf(tx, PRACTICE_A, PATIENT_A2)]);
    });
    expect(rows).toHaveLength(1);
  });
});

// Contratto di purga della regola: (a) il servizio con la purga di A sposta l'appuntamento con la visita di A;
// (b) con la purga di A lo stesso spostamento dell'appuntamento con la visita di B dà 23514; (c) uA con la purga di
// A resta fermo sull'appuntamento di A.
describe("uscita di purga su appointments_rules", () => {
  it("(a) servizio con la purga di A: l'appuntamento con la visita di A passa ad A2", async () => {
    const rows = await inRollback(db, "service", async (tx) => {
      const cycleId = await openCycleOf(tx, PRACTICE_A, PATIENT_A2);
      await setPurge(tx, PRACTICE_A);
      return tx.query(MOVE_SQL, [APPOINTMENT_A, PATIENT_A2, cycleId]);
    });
    expect(rows).toEqual([{ id: APPOINTMENT_A }]);
  });

  it("(b) servizio con la purga di A: l'appuntamento con la visita di B passa a B2: 23514", async () => {
    await expectPgError(
      inRollback(db, "service", async (tx) => {
        const cycleId = await openCycleOf(tx, PRACTICE_B, PATIENT_B2);
        await setPurge(tx, PRACTICE_A);
        return tx.query(MOVE_SQL, [APPOINTMENT_B, PATIENT_B2, cycleId]);
      }),
      "23514",
    );
  });

  it("(c) uA con la purga di A: l'appuntamento con la visita di A passa ad A2: 23514", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        const cycleId = await openCycleOf(tx, PRACTICE_A, PATIENT_A2);
        await setPurge(tx, PRACTICE_A);
        return tx.query(MOVE_SQL, [APPOINTMENT_A, PATIENT_A2, cycleId]);
      }),
      "23514",
    );
  });
});

// `on delete restrict` ferma la delete (23001 su Postgres 18, 23503 su Postgres 17: `expectBlockedDelete`).
// Il genitore nasce nella transazione, così la delete la ferma solo l'appuntamento: le fixture dei task
// dopo potrebbero tenere SERVICE_A e CYCLE_A con altre chiavi restrict.
describe("le chiavi restrict degli appuntamenti", () => {
  type Parent = [label: string, table: string, create: (tx: Tx) => Promise<string>, link: (id: string) => Values];

  const PARENTS: Parent[] = [
    [
      "una voce di listino",
      "services",
      async (tx) =>
        idOf(
          await insertRow(tx, "services", {
            practice_id: PRACTICE_A,
            kind: "controllo",
            name: "Controllo",
            invoice_description: "Controllo osteopatico",
            duration_min: 30,
            price_cents: 4000,
            color: "salvia",
          }),
        ),
      (id) => appointment({ service_id: id }),
    ],
    [
      // A2 non ha cicli aperti nelle fixture.
      "un ciclo",
      "treatment_cycles",
      async (tx) =>
        idOf(
          await insertRow(tx, "treatment_cycles", {
            practice_id: PRACTICE_A,
            patient_id: PATIENT_A2,
            opened_on: "2026-10-15",
            title: "Cervicalgia, ottobre 2026",
            expected_sessions: 4,
          }),
        ),
      (id) => appointment({ patient_id: PATIENT_A2, cycle_id: id }),
    ],
  ];

  it.each(PARENTS)("%s senza appuntamenti si cancella (controllo della prova che segue)", async (_label, table, create) => {
    const { id, deleted } = await inRollback(db, "A", async (tx) => {
      const id = await create(tx);
      return { id, deleted: await tx.query(`delete from public.${table} where id = $1 returning id`, [id]) };
    });
    expect(deleted).toEqual([{ id }]);
  });

  it.each(PARENTS)("%s con un appuntamento non si cancella", async (_label, table, create, link) => {
    await expectBlockedDelete(
      inRollback(db, "A", async (tx) => {
        const id = await create(tx);
        await insertRow(tx, "appointments", link(id));
        return tx.query(`delete from public.${table} where id = $1`, [id]);
      }),
    );
  });
});
