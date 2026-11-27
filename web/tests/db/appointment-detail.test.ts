import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { cancelAppointment, createAppointment, savePaymentMethod } from "@/server/domain/appointments/commands";
import { closeCycle } from "@/server/domain/cycles/commands";
import { createService } from "@/server/domain/services/commands";
import { getAppointmentDetail, getSedutaFatta } from "@/server/domain/appointments/queries";
import {
  CYCLE_A,
  FILE_A,
  invoiceDraft,
  issueInvoice,
  PATIENT_A1,
  PATIENT_A2,
  PRACTICE_A,
  SERVICE_A,
  sha256Hex,
} from "./fixtures";
import { asUserB, idOf, inUserA, insertRow, openTestDb } from "./helpers";

// Il dettaglio dell'appuntamento e il pannello "Seduta fatta":
// le azioni ammesse con i blocchi letti nel database, la
// domanda prima dell'inizio, il consenso del ciclo, i passi fatti e le successive della serie. Tutto
// come uA, con i dati creati dai comandi dell'app.

/** Mercoledì 4/11/2026 alle 08:30 di Roma: l'orologio della pagina. */
const clock = fixedClock("2026-11-04T08:30:00+01:00");
/** Mezz'ora prima: gli appuntamenti nascono con questo. */
const bookingClock = fixedClock("2026-11-04T08:00:00+01:00");

const CONSENT_TEXT = "Consenso al trattamento osteopatico di Luca Romano";

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

/** Una seduta da 45 minuti della voce SERVICE_A; `patch` cambia i campi. */
function seduta(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    serviceId: SERVICE_A,
    durationMin: 45,
    priceCents: 6000,
    status: "prenotato",
    ...patch,
  };
}

/** Luca Romano (nessun consenso, nessun ciclo) oggi alle 17:00, in un ciclo nuovo. */
async function lucaToday(tx: Tx): Promise<string> {
  const created = await createAppointment(
    tx,
    PRACTICE_A,
    bookingClock,
    seduta({ patient: { kind: "existing", patientId: PATIENT_A2 }, cycle: { kind: "new" }, day: "2026-11-04", time: "17:00" }),
  );
  const [first] = created.appointments;
  if (!first) throw new Error("nessun appuntamento creato");
  return first.id;
}

/** Marco Bellandi, paziente nuovo: la seduta di oggi alle 08:00 già fatta e quella di lunedì 16/11 alle 09:00. */
async function marcoDone(tx: Tx): Promise<{ doneId: string; nextId: string; cycleId: string; patientId: string }> {
  const done = await createAppointment(
    tx,
    PRACTICE_A,
    bookingClock,
    seduta({
      patient: { kind: "new", firstName: "Marco", lastName: "Bellandi", birthDate: "1985-05-10", phone: "" },
      cycle: { kind: "new" },
      day: "2026-11-04",
      time: "08:00",
      status: "fatto",
    }),
  );
  const next = await createAppointment(
    tx,
    PRACTICE_A,
    bookingClock,
    seduta({
      patient: { kind: "existing", patientId: done.patientId },
      cycle: { kind: "existing", cycleId: done.cycleId },
      day: "2026-11-16",
      time: "09:00",
    }),
  );
  const [doneRow] = done.appointments;
  const [nextRow] = next.appointments;
  if (!doneRow || !nextRow) throw new Error("nessun appuntamento creato");
  return { doneId: doneRow.id, nextId: nextRow.id, cycleId: done.cycleId, patientId: done.patientId };
}

/** Una bozza di fattura del paziente con la riga della seduta (legame attivo): restituisce l'id della fattura. */
async function draftOn(tx: Tx, patientId: string, appointmentId: string): Promise<string> {
  const invoiceId = idOf(await insertRow(tx, "invoices", invoiceDraft({ patient_id: patientId })));
  await insertRow(tx, "invoice_lines", {
    practice_id: PRACTICE_A,
    invoice_id: invoiceId,
    line_number: 1,
    line_kind: "prestazione",
    appointment_id: appointmentId,
    description: "Seduta di osteopatia",
    quantity: 1,
    unit_price_cents: 6000,
    line_total_cents: 6000,
    vat_rate_bp: 0,
    nature: "N2.2",
  });
  return invoiceId;
}

describe("getAppointmentDetail", () => {
  it("un prenotato di oggi alle 17:00 senza consensi: Segna come fatta con la domanda, consenso mancante", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const id = await lucaToday(tx);
      const [row] = await tx.query<{ updatedAt: Date }>('select updated_at as "updatedAt" from public.appointments where id = $1', [id]);
      return { id, detail: await getAppointmentDetail(tx, PRACTICE_A, clock, id), updatedAt: row?.updatedAt.toISOString() };
    });
    const { detail } = outcome;
    expect(detail).not.toBeNull();
    expect(detail?.actions).toContain("segna_fatta");
    // Non è ancora iniziato: niente "Saltato"; nessun blocco, quindi anche "Elimina".
    expect(detail?.actions).toEqual(["segna_confermato", "segna_fatta", "annulla", "elimina", "modifica"]);
    expect(detail?.doneQuestion).toBe("Inizia alle 17:00. Segnarlo comunque come fatto?");
    expect(detail?.consentMissing).toBe(true);
    expect(detail?.stepsDone).toBeNull();
    expect(detail?.dayText).toBe("mercoledì 4 novembre 2026");
    expect(detail?.timeText).toBe("17:00-17:45");
    expect(detail?.durationText).toBe("45 min");
    expect(detail?.patientName).toBe("Luca Romano");
    expect(detail?.patient).toMatchObject({ id: PATIENT_A2, firstName: "Luca", lastName: "Romano", archived: false });
    expect(detail?.patientId).toBe(PATIENT_A2);
    // Si può aprire la visita anche prima del "fatto", ma non ce n'è ancora una.
    expect(detail?.visit).toBeNull();
    expect(detail?.canOpenVisit).toBe(true);
    expect(detail?.serviceId).toBe(SERVICE_A);
    expect(detail?.serviceName).toBe("Seduta osteopatica");
    expect(detail?.cycleTitle).toBe("Nuovo ciclo, novembre 2026");
    expect(detail?.sessionLabel).toBe("Seduta 1 di 4");
    expect(detail?.status).toBe("prenotato");
    expect(detail?.priceCents).toBe(6000);
    expect(detail?.notes).toBeNull();
    expect(detail?.seriesFollowing).toBe(0);
    expect(detail?.edit).toEqual({ day: "2026-11-04", time: "17:00", durationMin: 45, updatedAt: outcome.updatedAt });
  });

  it("con il consenso al trattamento del ciclo il consenso non manca, anche senza informativa", async () => {
    const consentMissing = await inUserA(db, async (tx) => {
      const id = await lucaToday(tx);
      const [row] = await tx.query<{ cycleId: string }>('select cycle_id as "cycleId" from public.appointments where id = $1', [id]);
      await insertRow(tx, "consent_records", {
        practice_id: PRACTICE_A,
        patient_id: PATIENT_A2,
        cycle_id: row?.cycleId ?? null,
        module_key: "trattamento",
        module_version: "2026.1",
        rendered_text: CONSENT_TEXT,
        rendered_hash: sha256Hex(CONSENT_TEXT),
        signer_kind: "paziente",
        signer_name: "Luca Romano",
        method: "tela",
        signature_file_id: FILE_A,
        signed_on: "2026-11-04",
      });
      return (await getAppointmentDetail(tx, PRACTICE_A, clock, id))?.consentMissing;
    });
    expect(consentMissing).toBe(false);
  });

  it("con una riga di message_log non c'è Elimina, resta Annulla appuntamento", async () => {
    const actions = await inUserA(db, async (tx) => {
      const id = await lucaToday(tx);
      await insertRow(tx, "message_log", {
        practice_id: PRACTICE_A,
        patient_id: PATIENT_A2,
        appointment_id: id,
        template_key: "conferma",
        recipient_kind: "paziente",
        recipient_name: "Luca Romano",
        body: "Buongiorno Luca, ti confermo la seduta di oggi alle 17.",
        action: "copiato",
      });
      return (await getAppointmentDetail(tx, PRACTICE_A, clock, id))?.actions;
    });
    expect(actions).not.toContain("elimina");
    expect(actions).toContain("annulla");
  });

  it("un fatto senza fattura né visita, con la prossima seduta già fissata: 1 passo su 3", async () => {
    const detail = await inUserA(db, async (tx) => {
      const { doneId } = await marcoDone(tx);
      return getAppointmentDetail(tx, PRACTICE_A, clock, doneId);
    });
    expect(detail?.status).toBe("fatto");
    expect(detail?.stepsDone).toBe(1);
    expect(detail?.doneQuestion).toBeNull();
    expect(detail?.actions).toEqual(["annulla_fatto"]);
    expect(detail?.patientName).toBe("Marco Bellandi");
    expect(detail?.invoice).toBeNull();
  });

  it("la riga «Fattura»: una bozza sulla seduta senza numero, emessa con il numero", async () => {
    const out = await inUserA(db, async (tx) => {
      const { doneId, patientId } = await marcoDone(tx);
      const invoiceId = await draftOn(tx, patientId, doneId);
      const draft = await getAppointmentDetail(tx, PRACTICE_A, clock, doneId);
      const number = await issueInvoice(tx, { invoiceId, issueDate: "2026-11-04" });
      return { invoiceId, number, draft, issued: await getAppointmentDetail(tx, PRACTICE_A, clock, doneId) };
    });
    expect(out.draft?.invoice).toEqual({ id: out.invoiceId, numberLabel: null, status: "bozza" });
    // La bozza tiene la seduta: il passo 1 è fatto.
    expect(out.draft?.stepsDone).toBe(2);
    expect(out.issued?.invoice).toEqual({ id: out.invoiceId, numberLabel: `${out.number}/2026`, status: "emessa" });
  });

  it("la visita dell'appuntamento: bozza o chiusa con il suo id; un giorno dopo oggi non si apre", async () => {
    const out = await inUserA(db, async (tx) => {
      const id = await lucaToday(tx);
      const [row] = await tx.query<{ cycleId: string }>('select cycle_id as "cycleId" from public.appointments where id = $1', [id]);
      const visit = await insertRow(tx, "visits", {
        practice_id: PRACTICE_A,
        patient_id: PATIENT_A2,
        cycle_id: row?.cycleId ?? "",
        appointment_id: id,
        visit_date: "2026-11-04",
        kind: "seduta",
        screening_catalog_version: 1,
      });
      const visitId = idOf(visit);
      const draft = (await getAppointmentDetail(tx, PRACTICE_A, clock, id))?.visit;
      await tx.query("update public.visits set status = 'closed', closed_at = $2 where id = $1", [visitId, "2026-11-04T08:00:00Z"]);
      const closed = (await getAppointmentDetail(tx, PRACTICE_A, clock, id))?.visit;
      const { doneId, nextId } = await marcoDone(tx);
      return {
        visitId,
        draft,
        closed,
        done: (await getAppointmentDetail(tx, PRACTICE_A, clock, doneId))?.canOpenVisit,
        later: await getAppointmentDetail(tx, PRACTICE_A, clock, nextId),
      };
    });
    expect(out.draft).toEqual({ id: out.visitId, status: "draft" });
    expect(out.closed).toEqual({ id: out.visitId, status: "closed" });
    expect(out.done).toBe(true);
    // Lunedì 16/11 è dopo oggi: la visita non nasce prima (startVisit).
    expect(out.later?.canOpenVisit).toBe(false);
    expect(out.later?.visit).toBeNull();
  });

  it("un annullato non offre la visita", async () => {
    const canOpen = await inUserA(db, async (tx) => {
      const id = await lucaToday(tx);
      await cancelAppointment(tx, PRACTICE_A, clock, { id, reason: "paziente", alsoFollowing: false });
      return (await getAppointmentDetail(tx, PRACTICE_A, clock, id))?.canOpenVisit;
    });
    expect(canOpen).toBe(false);
  });

  it("la terza di una serie di 4 ha una successiva, la prima tre", async () => {
    const following = await inUserA(db, async (tx) => {
      const created = await createAppointment(
        tx,
        PRACTICE_A,
        bookingClock,
        seduta({
          patient: { kind: "existing", patientId: PATIENT_A1 },
          cycle: { kind: "existing", cycleId: CYCLE_A },
          day: "2026-11-09",
          time: "09:00",
          repeat: { intervalWeeks: 1, count: 4, excludedDays: [] },
        }),
      );
      const ids = created.appointments.map((a) => a.id);
      return Promise.all([ids[0], ids[2]].map(async (id) => (await getAppointmentDetail(tx, PRACTICE_A, clock, id ?? ""))?.seriesFollowing));
    });
    expect(following).toEqual([3, 1]);
  });

  it("un id che non c'è, o di un altro studio, non ha dettaglio", async () => {
    const id = await inUserA(db, async (tx) => {
      const own = await lucaToday(tx);
      return { own, missing: await getAppointmentDetail(tx, PRACTICE_A, clock, "a0000000-0000-4000-8000-0000000009ff") };
    });
    expect(id.missing).toBeNull();
    // uB sull'appuntamento del 5/10 dello studio A, che resta nelle fixture.
    const [fixture] = await inUserA(db, (tx) =>
      tx.query<{ id: string }>("select id from public.appointments where practice_id = $1 limit 1", [PRACTICE_A]),
    );
    const fromB = await asUserB(db, async (tx) => ({
      asB: await getAppointmentDetail(tx, PRACTICE_A, clock, fixture?.id ?? ""),
      sedutaFatta: await getSedutaFatta(tx, PRACTICE_A, clock, fixture?.id ?? ""),
    }));
    expect(fromB).toEqual({ asB: null, sedutaFatta: null });
  });
});

describe("getSedutaFatta", () => {
  it("il pannello di Marco: titolo, passi nell'ordine del banco e la prossima seduta già fissata", async () => {
    const view = await inUserA(db, async (tx) => {
      const { doneId, cycleId } = await marcoDone(tx);
      return { view: await getSedutaFatta(tx, PRACTICE_A, clock, doneId), doneId, cycleId };
    });
    expect(view.view?.appointmentId).toBe(view.doneId);
    expect(view.view?.title).toBe("Seduta fatta: Marco Bellandi");
    expect(view.view?.steps).toEqual({ incasso: false, prossima: true, visita: false });
    expect(view.view?.next).toEqual({ kind: "booked", text: "Prossima seduta già fissata: lunedì 16 novembre alle 09:00" });
    expect(view.view?.paymentMethod).toBeNull();
    expect(view.view?.consentMissing).toBe(true);
    expect(view.view?.cycleId).toBe(view.cycleId);
    expect(view.view?.patient).toMatchObject({ firstName: "Marco", lastName: "Bellandi", archived: false });
    expect(view.view?.invoice).toBeNull();
  });

  it("con la fattura emessa sulla seduta il passo 1 è fatto e il pannello porta la fattura", async () => {
    const out = await inUserA(db, async (tx) => {
      const { doneId, patientId } = await marcoDone(tx);
      const invoiceId = await draftOn(tx, patientId, doneId);
      const number = await issueInvoice(tx, { invoiceId, issueDate: "2026-11-04", paidOn: "2026-11-04" });
      return { invoiceId, number, view: await getSedutaFatta(tx, PRACTICE_A, clock, doneId) };
    });
    expect(out.view?.steps.incasso).toBe(true);
    expect(out.view?.invoice).toEqual({ id: out.invoiceId, numberLabel: `${out.number}/2026`, status: "pagata" });
  });

  it("con no_invoice_reason il passo 1 è fatto: 2 passi su 3; il metodo scelto si rilegge", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const { doneId } = await marcoDone(tx);
      await tx.query("update public.appointments set no_invoice_reason = 'altro' where id = $1", [doneId]);
      await savePaymentMethod(tx, PRACTICE_A, clock, { id: doneId, method: "carta" });
      return {
        view: await getSedutaFatta(tx, PRACTICE_A, clock, doneId),
        stepsDone: (await getAppointmentDetail(tx, PRACTICE_A, clock, doneId))?.stepsDone,
      };
    });
    expect(outcome.view?.steps).toEqual({ incasso: true, prossima: true, visita: false });
    expect(outcome.view?.paymentMethod).toBe("carta");
    expect(outcome.stepsDone).toBe(2);
  });

  it("senza la prossima seduta il passo 2 è da fare e c'è la proposta", async () => {
    const view = await inUserA(db, async (tx) => {
      const { doneId, nextId } = await marcoDone(tx);
      await tx.query("delete from public.appointments where id = $1", [nextId]);
      return getSedutaFatta(tx, PRACTICE_A, clock, doneId);
    });
    expect(view?.steps.prossima).toBe(false);
    expect(view?.next.kind).toBe("proposal");
  });

  it("il passo 3 e il passo 2: la visita dell'appuntamento, il tipo del ciclo e se si chiude da qui", async () => {
    const out = await inUserA(db, async (tx) => {
      const { doneId, nextId, cycleId } = await marcoDone(tx);
      const before = await getSedutaFatta(tx, PRACTICE_A, clock, doneId);
      const visit = await insertRow(tx, "visits", {
        practice_id: PRACTICE_A,
        patient_id: before?.patient.id ?? "",
        cycle_id: cycleId,
        appointment_id: doneId,
        visit_date: "2026-11-04",
        kind: "seduta",
        screening_catalog_version: 1,
      });
      const withDraft = await getSedutaFatta(tx, PRACTICE_A, clock, doneId);
      // Con la seduta del 16/11 ancora prenotata il ciclo non si chiude (closeCycle).
      await tx.query("delete from public.appointments where id = $1", [nextId]);
      await closeCycle(tx, PRACTICE_A, clock, {
        cycleId,
        outcome: "raggiunto",
        closedOn: "2026-11-04",
        finalScores: "non_tornato",
        recall: "nessuno",
      });
      return { before, visitId: idOf(visit), withDraft, afterClose: await getSedutaFatta(tx, PRACTICE_A, clock, doneId) };
    });
    expect(out.before).toMatchObject({ visitId: null, cycleKind: "trattamento", canCloseCycle: true });
    expect(out.withDraft).toMatchObject({ visitId: out.visitId, cycleKind: "trattamento", canCloseCycle: true });
    // Chiuso il ciclo non c'è più niente da chiudere; il tipo resta.
    expect(out.afterClose).toMatchObject({ visitId: out.visitId, cycleKind: "trattamento", canCloseCycle: false });
  });

  it("un controllo fatto sta in un ciclo di mantenimento", async () => {
    const view = await inUserA(db, async (tx) => {
      const check = await createService(tx, PRACTICE_A, clock, {
        kind: "controllo",
        name: "Controllo",
        invoiceDescription: "Controllo osteopatico",
        durationMin: 30,
        priceCents: 4500,
        color: "salvia",
      });
      const created = await createAppointment(
        tx,
        PRACTICE_A,
        bookingClock,
        seduta({
          patient: { kind: "existing", patientId: PATIENT_A2 },
          cycle: { kind: "new" },
          serviceId: check.id,
          durationMin: 30,
          day: "2026-11-04",
          time: "08:00",
          status: "fatto",
        }),
      );
      const [first] = created.appointments;
      return getSedutaFatta(tx, PRACTICE_A, clock, first?.id ?? "");
    });
    expect(view).toMatchObject({ cycleKind: "mantenimento", canCloseCycle: true, visitId: null });
  });

  it("un appuntamento non fatto non ha il pannello", async () => {
    const view = await inUserA(db, async (tx) => getSedutaFatta(tx, PRACTICE_A, clock, await lucaToday(tx)));
    expect(view).toBeNull();
  });
});
