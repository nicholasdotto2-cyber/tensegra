import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock } from "@/server/clock";
import type { Db, SqlParam, Tx } from "@/server/db/db";
import { switchToUser } from "@/server/db/service";
import {
  cancelAppointment,
  createAppointment,
  deleteAppointment,
  markConfirmed,
  markDone,
  markSkipped,
  restoreAppointment,
  savePaymentMethod,
  undoDone,
  undoSkipped,
  updateAppointment,
} from "@/server/domain/appointments/commands";
import { followingInSeries, loadBlockers } from "@/server/domain/appointments/queries";
import { BLOCKED_DELETE, isConflictError, isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { openCycle } from "@/server/domain/cycles/commands";
import { createPatient } from "@/server/domain/patients/commands";
import { archiveService, createService } from "@/server/domain/services/commands";
import { startVisit } from "@/server/domain/visits/commands";
import {
  APPOINTMENT_A,
  CYCLE_A,
  invoiceDraft,
  issueInvoice,
  PATIENT_A1,
  PRACTICE_A,
  PRACTICE_B,
  SERVICE_A,
  SERVICE_B,
  USER_A,
} from "./fixtures";
import { asUserB, expectBlockedDelete, idOf, inRollback, inService, inUserA, insertRow, openTestDb } from "./helpers";

// Cambi di stato, modifica ed eliminazione degli appuntamenti:
// ogni comando riapplica la tabella degli stati sullo stato letto nel database, prima stato e
// orario ("Operazione non permessa"), poi i blocchi con la loro frase; scrive con il `Clock` e con lo
// stato letto nella where, così una scrittura di un'altra finestra nel mezzo risponde `ConflictError`.

/** Mercoledì 4/11/2026 alle 08:30 di Roma (07:30 UTC): l'orologio dei comandi. */
const clock = fixedClock("2026-11-04T08:30:00+01:00");
/** Mezz'ora prima: gli appuntamenti nascono con questo, così l'istante del cambio di stato si distingue. */
const bookingClock = fixedClock("2026-11-04T08:00:00+01:00");
const BOOKED_AT = "2026-11-04T07:00:00.000Z";
const CHANGED_AT = "2026-11-04T07:30:00.000Z";

const HAS_VISIT = "C'è già una visita";
const DRAFT_INVOICE = "C'è già una fattura in bozza.";
const SAME_DAY = "L'appuntamento deve finire entro la stessa giornata.";
const CHOOSE_REASON = "Scegli il motivo.";
const VISIT_KEEPS_DAY = "Questo appuntamento ha già una visita: non si sposta a un altro giorno.";

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const nameOf = (err: unknown): unknown => (err as { name?: unknown } | null)?.name;

/** L'errore con cui il comando fallisce; se riesce, il test fallisce. */
function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (value: unknown) => expect.fail(`atteso un errore, invece il comando ha restituito ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );
}

/** Il comando fallisce prima del database (DomainError o ZodError): la risposta che arriva al modulo. */
async function formFailure(p: Promise<unknown>) {
  const error = await rejectionOf(p);
  expect(["DomainError", "ZodError"], String(error)).toContain(nameOf(error));
  return toActionFailure(error, "test");
}

/** Un DomainError di testo `message`, sul campo `field` se c'è: la transazione resta valida. */
async function expectDomainError(p: Promise<unknown>, message: string, field?: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
  if (field !== undefined) expect((error as { field?: unknown }).field).toBe(field);
}

/** Un ConflictError: la pagina si ricarica. */
async function expectConflict(p: Promise<unknown>): Promise<void> {
  const error = await rejectionOf(p);
  expect(isConflictError(error), String(error)).toBe(true);
  expect(toActionFailure(error, "test")).toEqual({
    ok: false,
    message: "L'appuntamento è stato modificato in un'altra finestra. Ricarico i dati.",
    conflict: true,
  });
}

/** Una seduta di PATIENT_A1 nel suo ciclo aperto, lunedì 9/11 alle 09:00; `patch` cambia i campi. */
function seduta(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    patient: { kind: "existing", patientId: PATIENT_A1 },
    serviceId: SERVICE_A,
    day: "2026-11-09",
    time: "09:00",
    durationMin: 45,
    cycle: { kind: "existing", cycleId: CYCLE_A },
    priceCents: 6000,
    status: "prenotato",
    ...patch,
  };
}

/** Prenota con `bookingClock` e restituisce l'id del primo appuntamento creato. */
async function book(tx: Tx, patch: Record<string, unknown> = {}): Promise<string> {
  const created = await createAppointment(tx, PRACTICE_A, bookingClock, seduta(patch));
  const [first] = created.appointments;
  if (!first) throw new Error("nessun appuntamento creato");
  return first.id;
}

/** Una serie settimanale di `count` sedute dal 9/11 alle 09:00: gli id in ordine di orario. */
async function bookSeries(tx: Tx, count: number): Promise<string[]> {
  const created = await createAppointment(
    tx,
    PRACTICE_A,
    bookingClock,
    seduta({ repeat: { intervalWeeks: 1, count, excludedDays: [] } }),
  );
  return created.appointments.map((a) => a.id);
}

async function rowOf(tx: Tx, id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx.query("select * from public.appointments where id = $1", [id]);
  return row;
}

async function statusOf(tx: Tx, id: string): Promise<unknown> {
  return (await rowOf(tx, id))?.status;
}

const iso = (value: unknown): string => (value as Date).toISOString();

/** `updated_at` riletto e passato come ISO, come lo manda il dialogo di modifica. */
async function tokenOf(tx: Tx, id: string): Promise<string> {
  const [row] = await tx.query<{ updatedAt: Date }>('select updated_at as "updatedAt" from public.appointments where id = $1', [
    id,
  ]);
  if (!row) throw new Error("appuntamento non trovato");
  return row.updatedAt.toISOString();
}

/** Una visita in bozza (come VISIT_A) sull'appuntamento, del giorno dato. */
async function insertVisit(tx: Tx, appointmentId: string, visitDate: string, closed = false): Promise<void> {
  await insertRow(tx, "visits", {
    practice_id: PRACTICE_A,
    patient_id: PATIENT_A1,
    cycle_id: CYCLE_A,
    appointment_id: appointmentId,
    visit_date: visitDate,
    kind: "seduta",
    screening_catalog_version: 1,
    ...(closed ? { status: "closed", closed_at: "2026-11-04T09:00:00Z" } : {}),
  });
}

/** La conferma copiata per l'appuntamento: una riga di `message_log`, che non si cancella. */
async function insertMessage(tx: Tx, appointmentId: string): Promise<void> {
  await insertRow(tx, "message_log", {
    practice_id: PRACTICE_A,
    patient_id: PATIENT_A1,
    appointment_id: appointmentId,
    template_key: "conferma",
    recipient_kind: "paziente",
    recipient_name: "Giulia Ferrari",
    body: "Buongiorno Giulia, le confermo la seduta di lunedì alle 9.",
    action: "copiato",
  });
}

/**
 * Una fattura da 60 euro di A1 con la riga dell'appuntamento: in bozza, o emessa col numero 273 del
 * 4/11/2026 se `issued`. `linkActive` falso è la riga di una fattura annullata.
 */
async function invoiceFor(tx: Tx, appointmentId: string, opts: { issued: boolean; linkActive?: boolean }): Promise<string> {
  const totals = { fees_cents: 6000, taxable_cents: 6000, total_cents: 6000, net_cents: 6000 };
  const invoiceId = idOf(await insertRow(tx, "invoices", invoiceDraft(totals)));
  await insertRow(tx, "invoice_lines", {
    practice_id: PRACTICE_A,
    invoice_id: invoiceId,
    line_number: 1,
    line_kind: "prestazione",
    service_id: SERVICE_A,
    appointment_id: appointmentId,
    description: "Seduta di osteopatia",
    service_date: "2026-11-04",
    quantity: 1,
    unit_price_cents: 6000,
    line_total_cents: 6000,
    vat_rate_bp: 0,
    nature: "N2.2",
    link_active: opts.linkActive ?? true,
  });
  if (opts.issued) await issueInvoice(tx, { invoiceId, issueDate: "2026-11-04", number: 273 });
  return invoiceId;
}

async function countWhere(tx: Tx, table: string, column: string, value: string): Promise<number> {
  const [row] = await tx.query<{ n: number }>(`select count(*)::int as n from public.${table} where ${column} = $1`, [value]);
  return row?.n ?? -1;
}

/**
 * Un'altra finestra cambia lo stato fra la lettura del comando e la sua scrittura: prima della prima
 * update o delete del comando su `appointments`, la stessa transazione porta la riga a `status`.
 */
function racing(tx: Tx, id: string, status: string): Tx {
  let raced = false;
  return {
    query: async <T>(text: string, params?: readonly SqlParam[]): Promise<T[]> => {
      if (!raced && /^\s*(update|delete\s+from)\s+public\.appointments\b/i.test(text)) {
        raced = true;
        await tx.query(
          `update public.appointments
              set status = $2, cancel_reason = case when $2::text = 'annullato' then 'altro' end
            where id = $1`,
          [id, status],
        );
      }
      return tx.query<T>(text, params);
    },
  };
}

describe("markConfirmed", () => {
  it("prenotato -> confermato, con l'istante del clock", async () => {
    const row = await inUserA(db, async (tx) => {
      const id = await book(tx);
      expect(iso((await rowOf(tx, id))?.status_changed_at)).toBe(BOOKED_AT);
      await markConfirmed(tx, PRACTICE_A, clock, { id });
      return rowOf(tx, id);
    });
    expect(row).toMatchObject({ status: "confermato", cancel_reason: null });
    expect(iso(row?.status_changed_at)).toBe(CHANGED_AT);
  });

  it("su un fatto o su un confermato: Operazione non permessa, lo stato resta", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const done = await book(tx, { day: "2026-11-04", time: "08:00", status: "fatto" });
      const confirmed = await book(tx, { status: "confermato" });
      await expectDomainError(markConfirmed(tx, PRACTICE_A, clock, { id: done }), NOT_ALLOWED);
      await expectDomainError(markConfirmed(tx, PRACTICE_A, clock, { id: confirmed }), NOT_ALLOWED);
      return { done: await rowOf(tx, done), confirmed: await rowOf(tx, confirmed) };
    });
    expect(outcome.done?.status).toBe("fatto");
    expect(iso(outcome.done?.status_changed_at)).toBe(BOOKED_AT);
    expect(outcome.confirmed?.status).toBe("confermato");
  });

  it("un appuntamento che non c'è e una chiave in più: niente scritture", async () => {
    await inUserA(db, async (tx) => {
      await expectDomainError(
        markConfirmed(tx, PRACTICE_A, clock, { id: "a0000000-0000-4000-8000-00000000dead" }),
        NOT_ALLOWED,
      );
      const id = await book(tx);
      expect(await formFailure(markConfirmed(tx, PRACTICE_A, clock, { id, status: "confermato" }))).toMatchObject({
        ok: false,
      });
      expect(await statusOf(tx, id)).toBe("prenotato");
    });
  });
});

describe("markDone", () => {
  it("oggi alle 17:00, non ancora iniziato: fatto", async () => {
    const row = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-04", time: "17:00" });
      await markDone(tx, PRACTICE_A, clock, { id });
      return rowOf(tx, id);
    });
    expect(row?.status).toBe("fatto");
    expect(iso(row?.status_changed_at)).toBe(CHANGED_AT);
  });

  it("ieri, segnato in ritardo: fatto", async () => {
    const status = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-03", status: "confermato" });
      await markDone(tx, PRACTICE_A, clock, { id });
      return statusOf(tx, id);
    });
    expect(status).toBe("fatto");
  });

  it("il 5/11 e da saltato: Operazione non permessa", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const tomorrow = await book(tx, { day: "2026-11-05" });
      const skipped = await book(tx, { day: "2026-11-04", time: "08:00" });
      await markSkipped(tx, PRACTICE_A, clock, { id: skipped });
      await expectDomainError(markDone(tx, PRACTICE_A, clock, { id: tomorrow }), NOT_ALLOWED);
      await expectDomainError(markDone(tx, PRACTICE_A, clock, { id: skipped }), NOT_ALLOWED);
      return { tomorrow: await statusOf(tx, tomorrow), skipped: await statusOf(tx, skipped) };
    });
    expect(outcome).toEqual({ tomorrow: "prenotato", skipped: "saltato" });
  });
});

describe("markSkipped", () => {
  it("iniziato alle 08:00: saltato", async () => {
    const row = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-04", time: "08:00", status: "confermato" });
      await markSkipped(tx, PRACTICE_A, clock, { id });
      return rowOf(tx, id);
    });
    expect(row?.status).toBe("saltato");
    expect(iso(row?.status_changed_at)).toBe(CHANGED_AT);
  });

  it("con una visita in bozza: C'è già una visita, lo stato resta confermato", async () => {
    const status = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-04", time: "08:00", status: "confermato" });
      await insertVisit(tx, id, "2026-11-04");
      await expectDomainError(markSkipped(tx, PRACTICE_A, clock, { id }), HAS_VISIT);
      return statusOf(tx, id);
    });
    expect(status).toBe("confermato");
  });

  it("alle 17:00, non ancora iniziato: Operazione non permessa", async () => {
    const status = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-04", time: "17:00" });
      await expectDomainError(markSkipped(tx, PRACTICE_A, clock, { id }), NOT_ALLOWED);
      return statusOf(tx, id);
    });
    expect(status).toBe("prenotato");
  });
});

describe("cancelAppointment", () => {
  it("senza motivo: «Scegli il motivo.» sul campo, niente scritture", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const id = await book(tx);
      const missing = await formFailure(cancelAppointment(tx, PRACTICE_A, clock, { id, alsoFollowing: false }));
      const blank = await formFailure(cancelAppointment(tx, PRACTICE_A, clock, { id, reason: "", alsoFollowing: false }));
      return { missing, blank, status: await statusOf(tx, id) };
    });
    const expected = { ok: false, refused: true, message: CHOOSE_REASON, fieldErrors: { reason: CHOOSE_REASON } };
    expect(outcome.missing).toEqual(expected);
    expect(outcome.blank).toEqual(expected);
    expect(outcome.status).toBe("prenotato");
  });

  it("con il motivo paziente: annullato, con il motivo e l'istante del clock", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const id = await book(tx, { status: "confermato" });
      const result = await cancelAppointment(tx, PRACTICE_A, clock, { id, reason: "paziente", alsoFollowing: false });
      return { result, row: await rowOf(tx, id) };
    });
    expect(outcome.result).toEqual({ cancelled: 1 });
    expect(outcome.row).toMatchObject({ status: "annullato", cancel_reason: "paziente" });
    expect(iso(outcome.row?.status_changed_at)).toBe(CHANGED_AT);
  });

  it("serie di 4: la seconda con le successive annulla 3 appuntamenti, la prima resta", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const ids = await bookSeries(tx, 4);
      const [first, second] = ids;
      if (!first || !second) throw new Error("serie incompleta");
      const followingBefore = await followingInSeries(tx, PRACTICE_A, second);
      const result = await cancelAppointment(tx, PRACTICE_A, clock, { id: second, reason: "studio", alsoFollowing: true });
      return {
        followingBefore,
        result,
        followingAfter: await followingInSeries(tx, PRACTICE_A, first),
        rows: await tx.query<{ status: string; cancel_reason: string | null; status_changed_at: Date }>(
          "select status, cancel_reason, status_changed_at from public.appointments where id = any($1::uuid[]) order by starts_at",
          [ids],
        ),
      };
    });
    expect(outcome.followingBefore).toBe(2);
    expect(outcome.result).toEqual({ cancelled: 3 });
    expect(outcome.followingAfter).toBe(0);
    expect(outcome.rows.map((r) => [r.status, r.cancel_reason])).toEqual([
      ["prenotato", null],
      ["annullato", "studio"],
      ["annullato", "studio"],
      ["annullato", "studio"],
    ]);
    expect(outcome.rows.slice(1).map((r) => iso(r.status_changed_at))).toEqual([CHANGED_AT, CHANGED_AT, CHANGED_AT]);
    expect(iso(outcome.rows[0]?.status_changed_at)).toBe(BOOKED_AT);
  });

  it("le successive già annullate o con una visita non contano e restano come sono", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const ids = await bookSeries(tx, 4);
      const [, second, third, fourth] = ids;
      if (!second || !third || !fourth) throw new Error("serie incompleta");
      await cancelAppointment(tx, PRACTICE_A, clock, { id: third, reason: "altro", alsoFollowing: false });
      await insertVisit(tx, fourth, "2026-11-30");
      const following = await followingInSeries(tx, PRACTICE_A, second);
      const result = await cancelAppointment(tx, PRACTICE_A, clock, { id: second, reason: "paziente", alsoFollowing: true });
      return {
        following,
        result,
        rows: await tx.query<{ status: string; cancel_reason: string | null }>(
          "select status, cancel_reason from public.appointments where id = any($1::uuid[]) order by starts_at",
          [ids],
        ),
      };
    });
    expect(outcome.following).toBe(0);
    expect(outcome.result).toEqual({ cancelled: 1 });
    expect(outcome.rows).toEqual([
      { status: "prenotato", cancel_reason: null },
      { status: "annullato", cancel_reason: "paziente" },
      { status: "annullato", cancel_reason: "altro" },
      { status: "prenotato", cancel_reason: null },
    ]);
  });

  it("senza le successive, o fuori da una serie, annulla solo quello", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const ids = await bookSeries(tx, 3);
      const [first] = ids;
      const single = await book(tx, { day: "2026-11-10" });
      if (!first) throw new Error("serie incompleta");
      return {
        series: await cancelAppointment(tx, PRACTICE_A, clock, { id: first, reason: "paziente", alsoFollowing: false }),
        singleFollowing: await followingInSeries(tx, PRACTICE_A, single),
        single: await cancelAppointment(tx, PRACTICE_A, clock, { id: single, reason: "paziente", alsoFollowing: true }),
        statuses: (
          await tx.query<{ status: string }>(
            "select status from public.appointments where id = any($1::uuid[]) order by starts_at",
            [ids],
          )
        ).map((r) => r.status),
      };
    });
    expect(outcome.series).toEqual({ cancelled: 1 });
    expect(outcome.singleFollowing).toBe(0);
    expect(outcome.single).toEqual({ cancelled: 1 });
    expect(outcome.statuses).toEqual(["annullato", "prenotato", "prenotato"]);
  });

  it("APPOINTMENT_A ha VISIT_A: «C'è già una visita», lo stato resta", async () => {
    const status = await inUserA(db, async (tx) => {
      await expectDomainError(
        cancelAppointment(tx, PRACTICE_A, clock, { id: APPOINTMENT_A, reason: "paziente", alsoFollowing: false }),
        HAS_VISIT,
      );
      return statusOf(tx, APPOINTMENT_A);
    });
    expect(status).toBe("prenotato");
  });

  it("su un fatto o su un annullato: Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const done = await book(tx, { day: "2026-11-04", time: "08:00", status: "fatto" });
      const cancelled = await book(tx);
      await cancelAppointment(tx, PRACTICE_A, clock, { id: cancelled, reason: "studio", alsoFollowing: false });
      for (const id of [done, cancelled]) {
        await expectDomainError(
          cancelAppointment(tx, PRACTICE_A, clock, { id, reason: "paziente", alsoFollowing: false }),
          NOT_ALLOWED,
        );
      }
      expect(await rowOf(tx, cancelled)).toMatchObject({ status: "annullato", cancel_reason: "studio" });
      expect(await statusOf(tx, done)).toBe("fatto");
    });
  });
});

describe("undoDone", () => {
  it("un fatto pulito torna confermato", async () => {
    const row = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-04", time: "08:00", status: "fatto" });
      await undoDone(tx, PRACTICE_A, clock, { id });
      return rowOf(tx, id);
    });
    expect(row?.status).toBe("confermato");
    expect(iso(row?.status_changed_at)).toBe(CHANGED_AT);
  });

  it("con una visita, con la fattura emessa n. 273 o con una bozza: la frase del blocco, lo stato resta fatto", async () => {
    const statuses = await inUserA(db, async (tx) => {
      const withVisit = await book(tx, { day: "2026-11-04", time: "08:00", status: "fatto" });
      const withIssued = await book(tx, { day: "2026-11-03", status: "fatto" });
      const withDraft = await book(tx, { day: "2026-11-02", status: "fatto" });
      await insertVisit(tx, withVisit, "2026-11-04");
      await invoiceFor(tx, withIssued, { issued: true });
      await invoiceFor(tx, withDraft, { issued: false });
      await expectDomainError(undoDone(tx, PRACTICE_A, clock, { id: withVisit }), HAS_VISIT);
      await expectDomainError(undoDone(tx, PRACTICE_A, clock, { id: withIssued }), "C'è già la fattura n. 273/2026");
      await expectDomainError(undoDone(tx, PRACTICE_A, clock, { id: withDraft }), DRAFT_INVOICE);
      return Promise.all([withVisit, withIssued, withDraft].map((id) => statusOf(tx, id)));
    });
    expect(statuses).toEqual(["fatto", "fatto", "fatto"]);
  });

  it("una riga di una fattura annullata (link_active falso) non blocca", async () => {
    const status = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-04", time: "08:00", status: "fatto" });
      await invoiceFor(tx, id, { issued: false, linkActive: false });
      await undoDone(tx, PRACTICE_A, clock, { id });
      return statusOf(tx, id);
    });
    expect(status).toBe("confermato");
  });

  it("su un confermato: Operazione non permessa", async () => {
    const status = await inUserA(db, async (tx) => {
      const id = await book(tx, { status: "confermato" });
      await expectDomainError(undoDone(tx, PRACTICE_A, clock, { id }), NOT_ALLOWED);
      return statusOf(tx, id);
    });
    expect(status).toBe("confermato");
  });
});

describe("restoreAppointment", () => {
  it("un annullato del 9/11 alle 09:00 torna prenotato, senza motivo né sovrapposizioni", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const id = await book(tx, { status: "confermato" });
      await cancelAppointment(tx, PRACTICE_A, bookingClock, { id, reason: "paziente", alsoFollowing: false });
      const result = await restoreAppointment(tx, PRACTICE_A, clock, { id });
      return { result, row: await rowOf(tx, id) };
    });
    expect(outcome.result).toEqual({ overlap: null });
    expect(outcome.row).toMatchObject({ status: "prenotato", cancel_reason: null });
    expect(iso(outcome.row?.status_changed_at)).toBe(CHANGED_AT);
  });

  it("con una seduta attiva di Carla Bianchi il 9/11 09:00-09:45: l'avviso della sovrapposizione", async () => {
    const result = await inUserA(db, async (tx) => {
      const id = await book(tx);
      await cancelAppointment(tx, PRACTICE_A, clock, { id, reason: "studio", alsoFollowing: false });
      const carla = await createPatient(tx, PRACTICE_A, clock, {
        firstName: "Carla",
        lastName: "Bianchi",
        birthDate: "1975-06-12",
      });
      await createAppointment(tx, PRACTICE_A, clock, {
        ...seduta({ status: "confermato" }),
        patient: { kind: "existing", patientId: carla.id },
        cycle: { kind: "new" },
      });
      return restoreAppointment(tx, PRACTICE_A, clock, { id });
    });
    expect(result).toEqual({ overlap: "Bianchi Carla, 09:00-09:45" });
  });

  it("un annullato di ieri, un saltato e un prenotato: Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const yesterday = await book(tx, { day: "2026-11-03" });
      await cancelAppointment(tx, PRACTICE_A, clock, { id: yesterday, reason: "paziente", alsoFollowing: false });
      const skipped = await book(tx, { day: "2026-11-04", time: "08:00" });
      await markSkipped(tx, PRACTICE_A, clock, { id: skipped });
      const booked = await book(tx);
      for (const id of [yesterday, skipped, booked]) {
        await expectDomainError(restoreAppointment(tx, PRACTICE_A, clock, { id }), NOT_ALLOWED);
      }
      expect(await rowOf(tx, yesterday)).toMatchObject({ status: "annullato", cancel_reason: "paziente" });
      expect(await statusOf(tx, skipped)).toBe("saltato");
      expect(await statusOf(tx, booked)).toBe("prenotato");
    });
  });
});

describe("deleteAppointment", () => {
  it("un messaggio registrato, una visita in bozza o una riga di fattura non attiva fermano la delete", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const withMessage = await book(tx, { day: "2026-11-09" });
      const withVisit = await book(tx, { day: "2026-11-10" });
      const withLine = await book(tx, { day: "2026-11-11" });
      await insertMessage(tx, withMessage);
      await insertVisit(tx, withVisit, "2026-11-10");
      await invoiceFor(tx, withLine, { issued: false, linkActive: false });
      for (const id of [withMessage, withVisit, withLine]) {
        await expectDomainError(deleteAppointment(tx, PRACTICE_A, clock, { id }), BLOCKED_DELETE);
      }
      const blockers = await loadBlockers(tx, PRACTICE_A, [withMessage, withVisit, withLine]);
      return {
        statuses: await Promise.all([withMessage, withVisit, withLine].map((id) => statusOf(tx, id))),
        linked: {
          messages: await countWhere(tx, "message_log", "appointment_id", withMessage),
          visits: await countWhere(tx, "visits", "appointment_id", withVisit),
          lines: await countWhere(tx, "invoice_lines", "appointment_id", withLine),
        },
        blockers: [withMessage, withVisit, withLine].map((id) => blockers.get(id)),
      };
    });
    expect(outcome.statuses).toEqual(["prenotato", "prenotato", "prenotato"]);
    expect(outcome.linked).toEqual({ messages: 1, visits: 1, lines: 1 });
    const none = {
      hasVisit: false,
      hasClosedVisit: false,
      hasAnyInvoiceLine: false,
      hasActiveInvoiceLine: false,
      activeInvoiceLabel: null,
      hasMessage: false,
    };
    expect(outcome.blockers).toEqual([
      { ...none, hasMessage: true },
      { ...none, hasVisit: true },
      { ...none, hasAnyInvoiceLine: true },
    ]);
  });

  it("la delete diretta come uA dell'appuntamento con il messaggio: 23001 o 23503", async () => {
    await inUserA(db, async (tx) => {
      const id = await book(tx);
      await insertMessage(tx, id);
      // L'errore del database abortisce la transazione: va per ultimo, in un suo inRollback.
      await expectBlockedDelete(tx.query("delete from public.appointments where id = $1", [id]));
    });
  });

  it("un prenotato o un confermato pulito si elimina", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const booked = await book(tx);
      const confirmed = await book(tx, { day: "2026-11-10", status: "confermato" });
      await deleteAppointment(tx, PRACTICE_A, clock, { id: booked });
      await deleteAppointment(tx, PRACTICE_A, clock, { id: confirmed });
      return { booked: await rowOf(tx, booked), confirmed: await rowOf(tx, confirmed) };
    });
    expect(outcome).toEqual({ booked: undefined, confirmed: undefined });
  });

  it("un fatto, un saltato o un annullato: Operazione non permessa, la riga resta", async () => {
    await inUserA(db, async (tx) => {
      const done = await book(tx, { day: "2026-11-04", time: "08:00", status: "fatto" });
      const skipped = await book(tx, { day: "2026-11-04", time: "07:00" });
      await markSkipped(tx, PRACTICE_A, clock, { id: skipped });
      const cancelled = await book(tx);
      await cancelAppointment(tx, PRACTICE_A, clock, { id: cancelled, reason: "altro", alsoFollowing: false });
      for (const id of [done, skipped, cancelled]) {
        await expectDomainError(deleteAppointment(tx, PRACTICE_A, clock, { id }), NOT_ALLOWED);
      }
      expect(await Promise.all([done, skipped, cancelled].map((id) => statusOf(tx, id)))).toEqual([
        "fatto",
        "saltato",
        "annullato",
      ]);
    });
  });

  // Se tra il controllo e la delete nasce un collegamento, la chiave restrict risponde con 23001
  // (Postgres 18) o 23503 (Postgres 17): il comando le tratta come il controllo esplicito. Il
  // collegamento nel mezzo non si ottiene con una sola connessione: qui la delete fallisce con il
  // codice vero e tutto il resto va al database.
  it.each(["23001", "23503"])("se la delete arriva al database e risponde %s, il testo è quello del blocco", async (code) => {
    await inUserA(db, async (tx) => {
      const id = await book(tx);
      const failing: Tx = {
        query: <T>(text: string, params?: readonly SqlParam[]): Promise<T[]> =>
          /^\s*delete\s+from\s+public\.appointments/i.test(text)
            ? Promise.reject(
                Object.assign(new Error('update or delete on table "appointments" violates foreign key'), { code }),
              )
            : tx.query<T>(text, params),
      };
      await expectDomainError(deleteAppointment(failing, PRACTICE_A, clock, { id }), BLOCKED_DELETE);
    });
  });
});

describe("loadBlockers", () => {
  it("visita chiusa, riga attiva in una fattura emessa o in una bozza", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const closedVisit = await book(tx, { day: "2026-11-04", time: "08:00", status: "fatto" });
      const issued = await book(tx, { day: "2026-11-03", status: "fatto" });
      const draft = await book(tx, { day: "2026-11-02", status: "fatto" });
      const clean = await book(tx);
      await insertVisit(tx, closedVisit, "2026-11-04", true);
      await invoiceFor(tx, issued, { issued: true });
      await invoiceFor(tx, draft, { issued: false });
      const ids = [closedVisit, issued, draft, clean];
      const blockers = await loadBlockers(tx, PRACTICE_A, ids);
      return { size: blockers.size, rows: ids.map((id) => blockers.get(id)) };
    });
    const none = {
      hasVisit: false,
      hasClosedVisit: false,
      hasAnyInvoiceLine: false,
      hasActiveInvoiceLine: false,
      activeInvoiceLabel: null,
      hasMessage: false,
    };
    expect(outcome.size).toBe(4);
    expect(outcome.rows).toEqual([
      { ...none, hasVisit: true, hasClosedVisit: true },
      { ...none, hasAnyInvoiceLine: true, hasActiveInvoiceLine: true, activeInvoiceLabel: "273/2026" },
      { ...none, hasAnyInvoiceLine: true, hasActiveInvoiceLine: true },
      none,
    ]);
  });

  it("APPOINTMENT_A della fixture: visita in bozza, riga attiva in bozza, messaggio; nessun id, nessuna voce", async () => {
    const outcome = await inUserA(db, async (tx) => ({
      fixture: (await loadBlockers(tx, PRACTICE_A, [APPOINTMENT_A])).get(APPOINTMENT_A),
      empty: (await loadBlockers(tx, PRACTICE_A, [])).size,
    }));
    expect(outcome.fixture).toEqual({
      hasVisit: true,
      hasClosedVisit: false,
      hasAnyInvoiceLine: true,
      hasActiveInvoiceLine: true,
      activeInvoiceLabel: null,
      hasMessage: true,
    });
    expect(outcome.empty).toBe(0);
  });
});

describe("updateAppointment", () => {
  /** L'input del dialogo di modifica per la seduta del 9/11 alle 09:00, con il token riletto. */
  function edit(id: string, expectedUpdatedAt: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      expectedUpdatedAt,
      serviceId: SERVICE_A,
      day: "2026-11-09",
      time: "09:00",
      durationMin: 45,
      priceCents: 6000,
      status: "prenotato",
      ...patch,
    };
  }

  it("cambia il prezzo: stato e orario restano, nessuno spostamento", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const id = await book(tx, { notes: "Porta le lastre" });
      const token = await tokenOf(tx, id);
      const result = await updateAppointment(tx, PRACTICE_A, clock, edit(id, token, { priceCents: 5000, notes: " " }));
      return { result, row: await rowOf(tx, id) };
    });
    expect(outcome.result).toEqual({ movedFromConfirmed: false });
    expect(outcome.row).toMatchObject({ status: "prenotato", price_cents: 5000, duration_min: 45, notes: null });
    expect(iso(outcome.row?.starts_at)).toBe("2026-11-09T08:00:00.000Z");
    expect(iso(outcome.row?.status_changed_at)).toBe(BOOKED_AT);
  });

  it("un prenotato spostato prima dell'apertura del ciclo porta indietro opened_on", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const { id: patientId } = await createPatient(tx, PRACTICE_A, bookingClock, {
        firstName: "Elisa",
        lastName: "Fontana",
        birthDate: "1964-05-02",
      });
      const { id: cycleId } = await openCycle(tx, PRACTICE_A, bookingClock, {
        patientId,
        kind: "trattamento",
        firstAppointmentDay: "2026-11-09",
      });
      const created = await createAppointment(
        tx,
        PRACTICE_A,
        bookingClock,
        seduta({ patient: { kind: "existing", patientId }, cycle: { kind: "existing", cycleId } }),
      );
      const id = created.appointments[0]?.id ?? "";
      const openedOn = async (): Promise<unknown> =>
        (await tx.query("select opened_on from public.treatment_cycles where id = $1", [cycleId]))[0];
      const before = await openedOn();
      await updateAppointment(tx, PRACTICE_A, clock, edit(id, await tokenOf(tx, id), { day: "2026-10-27" }));
      return { before, after: await openedOn(), row: await rowOf(tx, id) };
    });
    // openCycle prende il minore fra oggi (4/11) e il primo giorno (9/11).
    expect(outcome.before).toEqual({ opened_on: "2026-11-04" });
    expect(outcome.after).toEqual({ opened_on: "2026-10-27" });
    expect(iso(outcome.row?.starts_at)).toBe("2026-10-27T08:00:00.000Z");
  });

  it("uno spostamento dentro il ciclo non tocca opened_on", async () => {
    const opened = await inUserA(db, async (tx) => {
      const id = await book(tx);
      await updateAppointment(tx, PRACTICE_A, clock, edit(id, await tokenOf(tx, id), { day: "2026-10-27" }));
      await updateAppointment(tx, PRACTICE_A, clock, edit(id, await tokenOf(tx, id), { day: "2026-11-12" }));
      return tx.query("select opened_on from public.treatment_cycles where id = $1", [CYCLE_A]);
    });
    // CYCLE_A si apre l'1/10: il 27/10 e il 12/11 stanno dopo.
    expect(opened).toEqual([{ opened_on: "2026-10-01" }]);
  });

  it("un confermato spostato dal 9/11 al 10/11 torna prenotato", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const id = await book(tx, { status: "confermato" });
      const result = await updateAppointment(
        tx,
        PRACTICE_A,
        clock,
        edit(id, await tokenOf(tx, id), { day: "2026-11-10", time: "10:30", durationMin: 60, status: "confermato" }),
      );
      return { result, row: await rowOf(tx, id) };
    });
    expect(outcome.result).toEqual({ movedFromConfirmed: true });
    expect(outcome.row).toMatchObject({ status: "prenotato", duration_min: 60 });
    expect(iso(outcome.row?.starts_at)).toBe("2026-11-10T09:30:00.000Z");
    expect(iso(outcome.row?.ends_at)).toBe("2026-11-10T10:30:00.000Z");
    expect(iso(outcome.row?.status_changed_at)).toBe(CHANGED_AT);
  });

  it("un confermato con la sola durata cambiata e un prenotato spostato e confermato: nessuno spostamento da confermato", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const confirmed = await book(tx, { status: "confermato" });
      const booked = await book(tx, { day: "2026-11-10" });
      return {
        longer: await updateAppointment(
          tx,
          PRACTICE_A,
          clock,
          edit(confirmed, await tokenOf(tx, confirmed), { durationMin: 60, status: "confermato" }),
        ),
        moved: await updateAppointment(
          tx,
          PRACTICE_A,
          clock,
          edit(booked, await tokenOf(tx, booked), { day: "2026-11-11", status: "confermato" }),
        ),
        confirmed: await rowOf(tx, confirmed),
        booked: await rowOf(tx, booked),
      };
    });
    expect(outcome.longer).toEqual({ movedFromConfirmed: false });
    expect(outcome.moved).toEqual({ movedFromConfirmed: false });
    expect(outcome.confirmed).toMatchObject({ status: "confermato", duration_min: 60 });
    expect(iso(outcome.confirmed?.status_changed_at)).toBe(BOOKED_AT);
    expect(outcome.booked?.status).toBe("confermato");
    expect(iso(outcome.booked?.starts_at)).toBe("2026-11-11T08:00:00.000Z");
    expect(iso(outcome.booked?.status_changed_at)).toBe(CHANGED_AT);
  });

  it("con un token vecchio di un secondo: ConflictError, riga invariata", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const id = await book(tx);
      const before = await rowOf(tx, id);
      const stale = new Date(new Date(await tokenOf(tx, id)).getTime() - 1000).toISOString();
      await expectConflict(updateAppointment(tx, PRACTICE_A, clock, edit(id, stale, { priceCents: 5000 })));
      return { before, after: await rowOf(tx, id) };
    });
    expect(outcome.after).toEqual(outcome.before);
  });

  // PGlite scrive now() al millisecondo (l'orologio di Emscripten), Postgres al microsecondo: il dialogo
  // rilegge updated_at come Date di JS, che tronca a .123. Come servizio, con i trigger spenti per una
  // sola update, APPOINTMENT_A prende un updated_at con i microsecondi; poi la transazione passa a uA.
  it("il token vale al millisecondo: un updated_at con i microsecondi di Postgres combacia", async () => {
    const outcome = await inService(db, async (tx) => {
      await tx.query("set local session_replication_role = replica");
      await tx.query("update public.appointments set updated_at = '2026-10-04T08:00:00.123789Z' where id = $1", [
        APPOINTMENT_A,
      ]);
      await tx.query("set local session_replication_role = origin");
      await switchToUser(tx, { userId: USER_A });
      const token = await tokenOf(tx, APPOINTMENT_A);
      const result = await updateAppointment(
        tx,
        PRACTICE_A,
        clock,
        edit(APPOINTMENT_A, token, { day: "2026-10-05", priceCents: 5000 }),
      );
      return { token, result, row: await rowOf(tx, APPOINTMENT_A) };
    });
    expect(outcome.token).toBe("2026-10-04T08:00:00.123Z");
    expect(outcome.result).toEqual({ movedFromConfirmed: false });
    expect(outcome.row?.price_cents).toBe(5000);
  });

  it("su un fatto: Operazione non permessa", async () => {
    const row = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-04", time: "08:00", status: "fatto" });
      const token = await tokenOf(tx, id);
      await expectDomainError(
        updateAppointment(tx, PRACTICE_A, clock, edit(id, token, { day: "2026-11-04", time: "08:00", priceCents: 5000 })),
        NOT_ALLOWED,
      );
      return rowOf(tx, id);
    });
    expect(row).toMatchObject({ status: "fatto", price_cents: 6000 });
  });

  // `visit_date` è il giorno di Roma dell'appuntamento, e nessuno lo sposta.
  it("con una visita, in bozza o chiusa, un altro giorno è rifiutato con la frase; l'ora dello stesso giorno cambia", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const draft = await book(tx, { day: "2026-11-04", time: "08:00" });
      const closed = await book(tx, { day: "2026-11-04", time: "11:00" });
      const { visitId: draftVisit } = await startVisit(tx, PRACTICE_A, clock, { appointmentId: draft });
      const { visitId: closedVisit } = await startVisit(tx, PRACTICE_A, clock, { appointmentId: closed });
      await tx.query("update public.visits set status = 'closed', closed_at = $2 where id = $1", [closedVisit, clock.now()]);
      const before = { draft: await rowOf(tx, draft), closed: await rowOf(tx, closed) };
      for (const id of [draft, closed]) {
        await expectDomainError(
          updateAppointment(tx, PRACTICE_A, clock, edit(id, await tokenOf(tx, id), { day: "2026-11-12", time: "10:00" })),
          VISIT_KEEPS_DAY,
          "day",
        );
      }
      const refused = { draft: await rowOf(tx, draft), closed: await rowOf(tx, closed) };
      await updateAppointment(tx, PRACTICE_A, clock, edit(draft, await tokenOf(tx, draft), { day: "2026-11-04", time: "09:30" }));
      const visitDates = await tx.query<{ visitDate: string }>(
        'select visit_date as "visitDate" from public.visits where id = any($1::uuid[]) order by visit_date',
        [[draftVisit, closedVisit]],
      );
      return { before, refused, moved: await rowOf(tx, draft), visitDates: visitDates.map((v) => v.visitDate) };
    });
    expect(outcome.refused).toEqual(outcome.before);
    expect(iso(outcome.moved?.starts_at)).toBe("2026-11-04T08:30:00.000Z");
    expect(outcome.visitDates).toEqual(["2026-11-04", "2026-11-04"]);
  });

  it("le regole dei campi: fine alla mezzanotte, prestazione di un altro studio, paziente o ciclo nell'input", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const id = await book(tx);
      const before = await rowOf(tx, id);
      const token = await tokenOf(tx, id);
      await expectDomainError(updateAppointment(tx, PRACTICE_A, clock, edit(id, token, { time: "23:30" })), SAME_DAY, "time");
      await expectDomainError(
        updateAppointment(tx, PRACTICE_A, clock, edit(id, token, { serviceId: SERVICE_B })),
        NOT_ALLOWED,
        "serviceId",
      );
      const withCycle = await formFailure(updateAppointment(tx, PRACTICE_A, clock, { ...edit(id, token), cycleId: CYCLE_A }));
      const withPatient = await formFailure(
        updateAppointment(tx, PRACTICE_A, clock, { ...edit(id, token), patientId: PATIENT_A1 }),
      );
      const done = await formFailure(updateAppointment(tx, PRACTICE_A, clock, edit(id, token, { status: "fatto" })));
      return { before, after: await rowOf(tx, id), withCycle, withPatient, done };
    });
    expect(outcome.after).toEqual(outcome.before);
    expect(outcome.withCycle.ok).toBe(false);
    expect(outcome.withPatient.ok).toBe(false);
    expect(outcome.done).toMatchObject({ ok: false, fieldErrors: { status: "Valore non valido" } });
  });

  it("una prestazione archiviata resta se è già quella dell'appuntamento, non si sceglie se è un'altra", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const service = {
        kind: "seduta",
        invoiceDescription: "Seduta di osteopatia",
        durationMin: 45,
        priceCents: 6000,
        color: "oceano",
      };
      const long = await createService(tx, PRACTICE_A, clock, { ...service, name: "Seduta lunga" });
      const short = await createService(tx, PRACTICE_A, clock, { ...service, name: "Seduta breve" });
      const id = await book(tx, { serviceId: long.id });
      await archiveService(tx, PRACTICE_A, clock, { id: long.id });
      await archiveService(tx, PRACTICE_A, clock, { id: short.id });
      const token = await tokenOf(tx, id);
      const kept = await updateAppointment(tx, PRACTICE_A, clock, edit(id, token, { serviceId: long.id, priceCents: 5500 }));
      await expectDomainError(
        updateAppointment(tx, PRACTICE_A, clock, edit(id, await tokenOf(tx, id), { serviceId: short.id })),
        NOT_ALLOWED,
        "serviceId",
      );
      return { kept, row: await rowOf(tx, id), longId: long.id };
    });
    expect(outcome.kept).toEqual({ movedFromConfirmed: false });
    expect(outcome.row).toMatchObject({ service_id: outcome.longId, price_cents: 5500 });
  });
});

describe("undoSkipped", () => {
  it("un saltato di oggi alle 08:00, già iniziato, torna confermato con l'istante del clock", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-04", time: "08:00" });
      await markSkipped(tx, PRACTICE_A, bookingClock, { id });
      const result = await undoSkipped(tx, PRACTICE_A, clock, { id });
      return { result, row: await rowOf(tx, id) };
    });
    expect(outcome.result).toEqual({ overlap: null });
    expect(outcome.row).toMatchObject({ status: "confermato", cancel_reason: null });
    expect(iso(outcome.row?.status_changed_at)).toBe(CHANGED_AT);
  });

  it("un saltato di ieri torna confermato, così si può segnare come fatto", async () => {
    const status = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-03", time: "18:00" });
      await markSkipped(tx, PRACTICE_A, clock, { id });
      await undoSkipped(tx, PRACTICE_A, clock, { id });
      await markDone(tx, PRACTICE_A, clock, { id });
      return statusOf(tx, id);
    });
    expect(status).toBe("fatto");
  });

  it("se nel frattempo l'orario è stato preso: l'avviso della sovrapposizione, lo stato cambia lo stesso", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-03", time: "09:00" });
      await markSkipped(tx, PRACTICE_A, clock, { id });
      const carla = await createPatient(tx, PRACTICE_A, clock, {
        firstName: "Carla",
        lastName: "Bianchi",
        birthDate: "1975-06-12",
      });
      await createAppointment(tx, PRACTICE_A, clock, {
        ...seduta({ day: "2026-11-03", status: "fatto" }),
        patient: { kind: "existing", patientId: carla.id },
        cycle: { kind: "new" },
      });
      const result = await undoSkipped(tx, PRACTICE_A, clock, { id });
      return { result, status: await statusOf(tx, id) };
    });
    expect(outcome.result).toEqual({ overlap: "Bianchi Carla, 09:00-09:45" });
    expect(outcome.status).toBe("confermato");
  });

  it("un saltato non ancora iniziato (lì vale Ripristina), un prenotato e un annullato: Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const future = await book(tx, { day: "2026-11-04", time: "17:00" });
      await tx.query("update public.appointments set status = 'saltato' where id = $1", [future]);
      const booked = await book(tx, { day: "2026-11-04", time: "08:00" });
      const cancelled = await book(tx, { day: "2026-11-03" });
      await cancelAppointment(tx, PRACTICE_A, clock, { id: cancelled, reason: "paziente", alsoFollowing: false });
      for (const id of [future, booked, cancelled]) {
        await expectDomainError(undoSkipped(tx, PRACTICE_A, clock, { id }), NOT_ALLOWED);
      }
      expect(await statusOf(tx, future)).toBe("saltato");
      expect(await statusOf(tx, booked)).toBe("prenotato");
      expect(await rowOf(tx, cancelled)).toMatchObject({ status: "annullato", cancel_reason: "paziente" });
    });
  });
});

describe("savePaymentMethod", () => {
  it("su un fatto: carta, poi null", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-04", time: "08:00", status: "fatto" });
      await savePaymentMethod(tx, PRACTICE_A, clock, { id, method: "carta" });
      const card = (await rowOf(tx, id))?.payment_method;
      await savePaymentMethod(tx, PRACTICE_A, clock, { id, method: null });
      return { card, after: await rowOf(tx, id) };
    });
    expect(outcome.card).toBe("carta");
    expect(outcome.after).toMatchObject({ status: "fatto", payment_method: null });
    expect(iso(outcome.after?.status_changed_at)).toBe(BOOKED_AT);
  });

  it("su un prenotato: Operazione non permessa; un metodo fuori elenco: Valore non valido", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const booked = await book(tx);
      const done = await book(tx, { day: "2026-11-04", time: "08:00", status: "fatto" });
      await expectDomainError(savePaymentMethod(tx, PRACTICE_A, clock, { id: booked, method: "carta" }), NOT_ALLOWED);
      const cheque = await formFailure(savePaymentMethod(tx, PRACTICE_A, clock, { id: done, method: "assegno" }));
      return { cheque, booked: await rowOf(tx, booked), done: await rowOf(tx, done) };
    });
    expect(outcome.cheque).toMatchObject({ ok: false, fieldErrors: { method: "Valore non valido" } });
    expect(outcome.booked?.payment_method).toBeNull();
    expect(outcome.done?.payment_method).toBeNull();
  });
});

describe("scrittura di un'altra finestra fra lettura e scrittura: 0 righe, ConflictError", () => {
  type Case = [
    name: string,
    status: "prenotato" | "fatto" | "annullato" | "saltato",
    /** Oggi a quest'ora: alle 17:00 "fatto" e "Ripristina" sono ammessi, alle 08:00 "Saltato" e "Annulla 'saltato'". */
    time: string,
    raceTo: string,
    run: (tx: Tx, id: string) => Promise<unknown>,
  ];
  const cases: Case[] = [
    ["markConfirmed", "prenotato", "17:00", "confermato", (tx, id) => markConfirmed(tx, PRACTICE_A, clock, { id })],
    ["markDone", "prenotato", "17:00", "annullato", (tx, id) => markDone(tx, PRACTICE_A, clock, { id })],
    ["markSkipped", "prenotato", "08:00", "fatto", (tx, id) => markSkipped(tx, PRACTICE_A, clock, { id })],
    ["undoDone", "fatto", "17:00", "confermato", (tx, id) => undoDone(tx, PRACTICE_A, clock, { id })],
    [
      "cancelAppointment",
      "prenotato",
      "17:00",
      "confermato",
      (tx, id) => cancelAppointment(tx, PRACTICE_A, clock, { id, reason: "paziente", alsoFollowing: true }),
    ],
    ["restoreAppointment", "annullato", "17:00", "prenotato", (tx, id) => restoreAppointment(tx, PRACTICE_A, clock, { id })],
    ["undoSkipped", "saltato", "08:00", "confermato", (tx, id) => undoSkipped(tx, PRACTICE_A, clock, { id })],
    ["deleteAppointment", "prenotato", "17:00", "confermato", (tx, id) => deleteAppointment(tx, PRACTICE_A, clock, { id })],
    [
      "updateAppointment",
      "prenotato",
      "17:00",
      "confermato",
      async (tx, id) => {
        const token = await tokenOf(tx, id);
        return updateAppointment(tx, PRACTICE_A, clock, {
          id,
          expectedUpdatedAt: token,
          serviceId: SERVICE_A,
          day: "2026-11-04",
          time: "17:00",
          durationMin: 45,
          priceCents: 5000,
          status: "prenotato",
        });
      },
    ],
    [
      "savePaymentMethod",
      "fatto",
      "17:00",
      "confermato",
      (tx, id) => savePaymentMethod(tx, PRACTICE_A, clock, { id, method: "carta" }),
    ],
  ];

  it.each(cases)("%s", async (_name, status, time, raceTo, run) => {
    const row = await inUserA(db, async (tx) => {
      const id = await book(tx, { day: "2026-11-04", time, status: status === "fatto" ? "fatto" : "prenotato" });
      if (status === "annullato") {
        await cancelAppointment(tx, PRACTICE_A, clock, { id, reason: "studio", alsoFollowing: false });
      }
      if (status === "saltato") await markSkipped(tx, PRACTICE_A, clock, { id });
      await expectConflict(run(racing(tx, id, raceTo), id));
      return rowOf(tx, id);
    });
    expect(row?.status).toBe(raceTo);
    expect(row?.price_cents).toBe(6000);
    expect(row?.payment_method).toBeNull();
  });
});

describe("studio B", () => {
  it("ogni comando come uB sugli id di A fallisce e non cambia niente", async () => {
    const before = await inService(db, (tx) => rowOf(tx, APPOINTMENT_A));
    // asUserB conferma la transazione: se un comando scrivesse prima di fermarsi, la riga cambierebbe.
    await asUserB(db, async (tx) => {
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        const id = APPOINTMENT_A;
        await expectDomainError(markConfirmed(tx, practiceId, clock, { id }), NOT_ALLOWED);
        await expectDomainError(markDone(tx, practiceId, clock, { id }), NOT_ALLOWED);
        await expectDomainError(markSkipped(tx, practiceId, clock, { id }), NOT_ALLOWED);
        await expectDomainError(undoDone(tx, practiceId, clock, { id }), NOT_ALLOWED);
        await expectDomainError(
          cancelAppointment(tx, practiceId, clock, { id, reason: "paziente", alsoFollowing: true }),
          NOT_ALLOWED,
        );
        await expectDomainError(restoreAppointment(tx, practiceId, clock, { id }), NOT_ALLOWED);
        await expectDomainError(undoSkipped(tx, practiceId, clock, { id }), NOT_ALLOWED);
        await expectDomainError(deleteAppointment(tx, practiceId, clock, { id }), NOT_ALLOWED);
        await expectDomainError(
          updateAppointment(tx, practiceId, clock, {
            id,
            expectedUpdatedAt: iso(before?.updated_at),
            serviceId: SERVICE_A,
            day: "2026-10-05",
            time: "09:00",
            durationMin: 45,
            priceCents: 1,
            status: "confermato",
          }),
          NOT_ALLOWED,
        );
        await expectDomainError(savePaymentMethod(tx, practiceId, clock, { id, method: "carta" }), NOT_ALLOWED);
        expect((await loadBlockers(tx, practiceId, [id])).size).toBe(0);
        expect(await followingInSeries(tx, practiceId, id)).toBe(0);
      }
    });
    expect(await inService(db, (tx) => rowOf(tx, APPOINTMENT_A))).toEqual(before);
    // Controllo: con un appuntamento di B il comando di uB riesce.
    const own = await inRollback(db, "B", async (tx) => {
      const [row] = await tx.query<{ id: string }>("select id from public.appointments where practice_id = $1", [PRACTICE_B]);
      if (!row) throw new Error("nessun appuntamento di B");
      await markConfirmed(tx, PRACTICE_B, clock, { id: row.id });
      return statusOf(tx, row.id);
    });
    expect(own).toBe("confermato");
  });
});
