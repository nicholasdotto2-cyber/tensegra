import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAID_IN_FUTURE } from "@/lib/fiscal/issue-date";
import type { InvoiceSnapshot } from "@/lib/fiscal/snapshot";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { switchToUser } from "@/server/db/service";
import { createAppointment } from "@/server/domain/appointments/commands";
import {
  CANNOT_CANCEL, cancelWithCreditNote, issueInvoice, PAID_BEFORE_ISSUE, REFUND_OUTSIDE,
  registerPayment, saveInvoiceDraft, undoPayment,
} from "@/server/domain/invoices/commands";
import { listToInvoice } from "@/server/domain/invoices/queries";
import { saveRecipientFiscalFields } from "@/server/domain/invoices/recipient";
import { createPatient } from "@/server/domain/patients/commands";
import { saveFiscalSettings, saveStudio } from "@/server/domain/settings/commands";
import { xmlSha256 } from "@/server/fatturapa/build-xml";
import { STUDIO } from "../../seed/people";
import { validateFatturaXml } from "../support/xsd";
import { PRACTICE_A, PRACTICE_B, SERVICE_A, USER_A, USER_B } from "./fixtures";
import { expectPgError, inUserA, openTestDb } from "./helpers";

const issueClock = fixedClock("2026-11-04T08:30:00+01:00");
const laterClock = fixedClock("2026-11-10T09:15:00+01:00");
const fiscal = {
  regime: "forfettario", vatNumber: "00000000000", taxCode: STUDIO.practitionerTaxCode,
  atecoCode: "86.96.09", fiscalAddressLine: "Via delle Prove 7", fiscalPostalCode: "40121",
  fiscalCity: "Bologna", fiscalProvince: "BO", fiscalCountry: "IT", inpsSurchargeEnabled: false,
  stampChargedToClient: true, paperStampAuthorization: null, iban: "IT80N0000001000000000123456",
  ibanHolder: "Laura Benedetti", defaultPaymentMethod: "carta", bankTransferDueDays: 15,
};
const NOTE = "Intestata alla persona sbagliata";
let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

/** Una fattura emessa il 4/11 con due sedute (70,00 e 55,00) e il bollo: 127,00 in tutto. */
async function issued(tx: Tx, regime = "forfettario", paidOn: string | null = null) {
  await saveFiscalSettings(tx, PRACTICE_A, issueClock, { ...fiscal, regime });
  await saveStudio(tx, PRACTICE_A, issueClock, {
    practiceName: STUDIO.practiceName, practitionerFirstName: "Laura", practitionerLastName: "Benedetti",
    practitionerTitle: "Osteopata", addressLine: "Via delle Prove 7", postalCode: "40121", city: "Bologna",
    province: "BO", phone: "+390510000000", email: "studio@example.com", pec: null,
  });
  const { id: patientId } = await createPatient(tx, PRACTICE_A, issueClock, { firstName: "Elisa", lastName: "Fontana", birthDate: "1990-01-01" });
  await saveRecipientFiscalFields(tx, PRACTICE_A, issueClock, {
    kind: "paziente", patientId, taxCode: STUDIO.practitionerTaxCode,
    address: { addressLine: "Via delle Prove 1", postalCode: "40121", city: "Bologna", province: "BO" },
  });
  const appointments: string[] = [];
  let cycle: { kind: "new" } | { kind: "existing"; cycleId: string } = { kind: "new" };
  for (const time of ["10:00", "11:00"]) {
    const created = await createAppointment(tx, PRACTICE_A, issueClock, {
      patient: { kind: "existing", patientId }, serviceId: SERVICE_A, day: "2026-11-03", time,
      durationMin: 45, cycle, priceCents: 5500, status: "fatto",
    });
    appointments.push(created.appointments[0]!.id);
    cycle = { kind: "existing", cycleId: created.cycleId };
  }
  const lines = [7000, 5500].map((unitPriceCents, i) => ({
    serviceId: SERVICE_A, appointmentId: appointments[i]!, description: `Trattamento osteopatico ${i + 1}`,
    serviceDate: "2026-11-03", quantity: 1, unitPriceCents,
  }));
  const { id } = await saveInvoiceDraft(tx, PRACTICE_A, issueClock, {
    invoiceId: null, recipient: { kind: "paziente", patientId }, lines,
    paymentMethod: "carta", paidOn, stampMarkCode: null, internalNotes: null,
  });
  await issueInvoice(tx, PRACTICE_A, issueClock, { invoiceId: id });
  return { id, patientId, appointments };
}
interface Row {
  id: string; doc_type: string; status: string; number_label: string; issue_date: string; paid_on: string | null;
  paid_at: Date | null; payment_method: string; cancelled_at: Date | null; credit_note_id: string | null;
  credited_invoice_id: string | null; total_cents: number; fees_cents: number; net_cents: number;
  internal_notes: string | null; transmission_id: string | null; xml: string | null; xml_sha256: string | null;
  snapshot: InvoiceSnapshot;
}
async function invoice(tx: Tx, id: string) {
  return (await tx.query<Row>("select * from public.invoices where practice_id = $1 and id = $2", [PRACTICE_A, id]))[0]!;
}
async function lines(tx: Tx, id: string) {
  return tx.query(
    `select line_number, line_kind, description, service_date, quantity, unit_price_cents, line_total_cents,
            vat_rate_bp, nature, subject_to_withholding, service_id, appointment_id, link_active
       from public.invoice_lines where practice_id = $1 and invoice_id = $2 order by line_number`, [PRACTICE_A, id]);
}
async function events(tx: Tx, id: string) {
  return tx.query<{ event_type: string; at: Date; details: unknown }>(
    "select event_type, at, details from public.invoice_events where practice_id = $1 and invoice_id = $2 order by event_type", [PRACTICE_A, id]);
}
async function state(tx: Tx) {
  return {
    counters: await tx.query("select series, year, last_number from public.number_series where practice_id = $1 order by series, year", [PRACTICE_A]),
    invoices: await tx.query("select * from public.invoices where practice_id = $1 order by id", [PRACTICE_A]),
    lines: await tx.query("select * from public.invoice_lines where practice_id = $1 order by id", [PRACTICE_A]),
    events: await tx.query("select * from public.invoice_events where practice_id = $1 order by id", [PRACTICE_A]),
  };
}

describe("incasso", () => {
  it("non annulla l'incasso già stampato come data dell'operazione sulla fattura cartacea", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await issued(tx, "esente_sanitario", "2026-11-03");
      expect(await invoice(tx, id)).toMatchObject({
        xml: null, issue_date: "2026-11-04", status: "pagata",
        snapshot: { electronic: false, payment: { paidOn: "2026-11-03" } },
      });
      const before = await state(tx);
      await expect(undoPayment(tx, PRACTICE_A, laterClock, { invoiceId: id })).rejects.toMatchObject({
        name: "DomainError",
        message: "Su questa fattura cartacea l'incasso è già stampato nella data dell'operazione: non si può annullare.",
      });
      expect(await state(tx)).toEqual(before);
    });
  });

  it("registra e annulla l'incasso senza toccare l'XML, con gli eventi", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await issued(tx);
      const first = await invoice(tx, id);
      expect(first).toMatchObject({ status: "emessa", paid_on: null, paid_at: null, payment_method: "carta" });

      const before = await state(tx);
      await expect(registerPayment(tx, PRACTICE_A, laterClock, { invoiceId: id, method: "contanti", paidOn: "2026-11-11" }))
        .rejects.toMatchObject({ name: "DomainError", message: PAID_IN_FUTURE });
      await expect(registerPayment(tx, PRACTICE_A, laterClock, { invoiceId: id, method: "contanti", paidOn: "2026-11-03" }))
        .rejects.toMatchObject({ name: "DomainError", message: PAID_BEFORE_ISSUE });
      expect(PAID_BEFORE_ISSUE).toBe("L'incasso non può precedere la data della fattura.");
      expect(await state(tx)).toEqual(before);

      await registerPayment(tx, PRACTICE_A, laterClock, { invoiceId: id, method: "contanti", paidOn: "2026-11-09" });
      const paid = await invoice(tx, id);
      expect(paid).toMatchObject({ status: "pagata", paid_on: "2026-11-09", paid_at: laterClock.now(), payment_method: "contanti" });
      expect(paid.xml).toBe(first.xml);
      expect(paid.xml_sha256).toBe(first.xml_sha256);
      expect(paid.snapshot).toEqual(first.snapshot);

      await undoPayment(tx, PRACTICE_A, laterClock, { invoiceId: id });
      expect(await invoice(tx, id)).toMatchObject({ status: "emessa", paid_on: null, paid_at: null, payment_method: "carta", xml: first.xml });
      expect((await events(tx, id)).map((e) => e.event_type)).toEqual(["creata", "emessa", "pagamento_annullato", "pagamento_registrato"]);
    });
  });

  it("rifiuta incasso e annullo d'incasso fuori dallo stato giusto", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await issued(tx);
      const before = await state(tx);
      await expect(undoPayment(tx, PRACTICE_A, laterClock, { invoiceId: id })).rejects.toMatchObject({ name: "DomainError" });
      await registerPayment(tx, PRACTICE_A, laterClock, { invoiceId: id, method: "carta", paidOn: "2026-11-05" });
      await expect(registerPayment(tx, PRACTICE_A, laterClock, { invoiceId: id, method: "carta", paidOn: "2026-11-06" })).rejects.toMatchObject({ name: "DomainError" });
      await undoPayment(tx, PRACTICE_A, laterClock, { invoiceId: id });
      expect((await state(tx)).counters).toEqual(before.counters);
    });
  });

  it("dice il motivo giusto quando lo stato non permette l'incasso o l'annullo", async () => {
    await inUserA(db, async (tx) => {
      const { id, patientId } = await issued(tx);
      const draft = (await saveInvoiceDraft(tx, PRACTICE_A, laterClock, {
        invoiceId: null, recipient: { kind: "paziente", patientId },
        lines: [{ serviceId: null, appointmentId: null, description: "Bozza", serviceDate: null, quantity: 1, unitPriceCents: 1000 }],
        paymentMethod: "carta", paidOn: null, stampMarkCode: null, internalNotes: null,
      })).id;
      const pay = (invoiceId: string) => registerPayment(tx, PRACTICE_A, laterClock, { invoiceId, method: "carta", paidOn: "2026-11-05" });
      const undo = (invoiceId: string) => undoPayment(tx, PRACTICE_A, laterClock, { invoiceId });

      // annullo d'incasso su una fattura emessa, non pagata
      let before = await state(tx);
      await expect(undo(id)).rejects.toMatchObject({ name: "DomainError", message: "Non c'è un incasso da annullare." });
      expect(await state(tx)).toEqual(before);

      // secondo incasso sulla stessa fattura (doppio clic)
      await pay(id);
      before = await state(tx);
      await expect(pay(id)).rejects.toMatchObject({ name: "DomainError", message: "La fattura risulta già pagata." });
      expect(await state(tx)).toEqual(before);
      expect(await invoice(tx, id)).toMatchObject({ status: "pagata", paid_on: "2026-11-05" });

      // bozza, nota di credito, fattura annullata
      const { creditNoteId } = await cancelWithCreditNote(tx, PRACTICE_A, laterClock, { invoiceId: id, note: null });
      before = await state(tx);
      for (const target of [draft, creditNoteId, id]) {
        await expect(pay(target)).rejects.toMatchObject({ name: "DomainError", message: "L'incasso si registra solo su una fattura emessa." });
      }
      expect(await state(tx)).toEqual(before);
    });
  });
});

describe("annullamento con nota di credito", () => {
  it("emette la TD04 con le stesse righe, bollo compreso, e libera le sedute", async () => {
    await inUserA(db, async (tx) => {
      const { id, appointments, patientId } = await issued(tx);
      const original = await invoice(tx, id);
      const originalLines = await lines(tx, id);
      expect(originalLines).toHaveLength(3);
      expect(await listToInvoice(tx, PRACTICE_A, laterClock)).toEqual([]);

      const result = await cancelWithCreditNote(tx, PRACTICE_A, laterClock, { invoiceId: id, note: NOTE });
      expect(result).toEqual({ creditNoteId: expect.any(String), numberLabel: "NC-1/2026", wasPaid: false });
      const note = await invoice(tx, result.creditNoteId);
      expect(note).toMatchObject({
        doc_type: "TD04", status: "emessa", number_label: "NC-1/2026", issue_date: "2026-11-10",
        credited_invoice_id: id, credit_note_id: null, total_cents: 12700, fees_cents: original.fees_cents,
        net_cents: original.net_cents, payment_method: original.payment_method, paid_on: null, internal_notes: NOTE,
        snapshot: { docType: "TD04", credited: { numberLabel: "1/2026", issueDate: "2026-11-04" } },
      });
      const noteLines = await lines(tx, result.creditNoteId);
      expect(noteLines).toEqual(originalLines.map((line) => ({ ...(line as object), link_active: false })));
      expect(noteLines.map((line) => (line as { appointment_id: string | null }).appointment_id)).toEqual([appointments[0], appointments[1], null]);

      expect(note.xml).not.toBeNull();
      expect(await validateFatturaXml(note.xml!)).toEqual({ valid: true, errors: [] });
      expect(note.xml_sha256).toBe(xmlSha256(note.xml!));
      expect(note.xml).toContain("<TipoDocumento>TD04</TipoDocumento>");
      expect(note.xml).toContain("<Causale>Storno totale fattura 1/2026 del 04/11/2026</Causale>");
      expect(note.xml).toMatch(/<DatiFattureCollegate>\s*<IdDocumento>1\/2026<\/IdDocumento>/);
      expect(note.xml).toContain("<DatiBollo>");
      expect(note.xml).toContain("<ImportoTotaleDocumento>127.00</ImportoTotaleDocumento>");
      expect(note.xml).not.toContain("<DatiPagamento>");
      expect(note.transmission_id).not.toBe(original.transmission_id);

      expect(await invoice(tx, id)).toMatchObject({
        status: "annullata", credit_note_id: result.creditNoteId, cancelled_at: laterClock.now(), xml: original.xml,
      });
      expect((await lines(tx, id)).map((line) => (line as { link_active: boolean }).link_active)).toEqual([false, false, false]);
      expect((await events(tx, id)).map((e) => e.event_type)).toEqual(["annullata", "creata", "emessa"]);
      expect((await events(tx, id))[0]).toMatchObject({ event_type: "annullata", at: laterClock.now(), details: { note: NOTE } });
      expect(await events(tx, result.creditNoteId)).toEqual([{ event_type: "emessa", at: laterClock.now(), details: null }]);

      expect(await listToInvoice(tx, PRACTICE_A, laterClock)).toEqual([
        expect.objectContaining({ appointmentId: appointments[0] }), expect.objectContaining({ appointmentId: appointments[1] }),
      ]);
      const redraft = await saveInvoiceDraft(tx, PRACTICE_A, laterClock, {
        invoiceId: null, recipient: { kind: "paziente", patientId },
        lines: [{ serviceId: SERVICE_A, appointmentId: appointments[0]!, description: "Trattamento osteopatico",
          serviceDate: "2026-11-03", quantity: 1, unitPriceCents: 7000 }],
        paymentMethod: "carta", paidOn: null, stampMarkCode: null, internalNotes: null,
      });
      expect(redraft.id).toEqual(expect.any(String));
    });
  });

  it("senza motivo lascia le note interne vuote e dice se l'incasso c'era", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await issued(tx, "forfettario", "2026-11-04");
      expect(await invoice(tx, id)).toMatchObject({ status: "pagata" });
      const result = await cancelWithCreditNote(tx, PRACTICE_A, laterClock, { invoiceId: id, note: "  " });
      expect(result).toMatchObject({ wasPaid: true });
      expect(await invoice(tx, result.creditNoteId)).toMatchObject({ internal_notes: null, paid_on: null, status: "emessa" });
      expect(await invoice(tx, id)).toMatchObject({ status: "annullata", paid_on: "2026-11-04" });
      expect((await events(tx, id))[0]).toMatchObject({ event_type: "annullata", details: null });
      expect(REFUND_OUTSIDE).toBe("Rimborso da gestire fuori dal gestionale");
    });
  });

  it("annulla una sola volta e solo una fattura emessa o pagata", async () => {
    await inUserA(db, async (tx) => {
      const { id, patientId } = await issued(tx);
      const { creditNoteId } = await cancelWithCreditNote(tx, PRACTICE_A, laterClock, { invoiceId: id, note: null });
      const draft = (await saveInvoiceDraft(tx, PRACTICE_A, laterClock, {
        invoiceId: null, recipient: { kind: "paziente", patientId },
        lines: [{ serviceId: null, appointmentId: null, description: "Bozza", serviceDate: null, quantity: 1, unitPriceCents: 1000 }],
        paymentMethod: "carta", paidOn: null, stampMarkCode: null, internalNotes: null,
      })).id;
      const before = await state(tx);
      expect(CANNOT_CANCEL).toBe("Si annulla solo una fattura emessa o pagata.");
      for (const target of [creditNoteId, draft, id]) {
        await expect(cancelWithCreditNote(tx, PRACTICE_A, laterClock, { invoiceId: target, note: null }))
          .rejects.toMatchObject({ name: "DomainError", message: CANNOT_CANCEL });
      }
      expect(await state(tx)).toEqual(before);
      expect(await tx.query("select id from public.invoices where practice_id = $1 and doc_type = 'TD04'", [PRACTICE_A])).toHaveLength(1);
    });
  });

  it("esente verso il paziente: la fattura non ha XML e nemmeno la nota", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await issued(tx, "esente_sanitario");
      expect(await invoice(tx, id)).toMatchObject({ xml: null, snapshot: { electronic: false } });
      const { creditNoteId } = await cancelWithCreditNote(tx, PRACTICE_A, laterClock, { invoiceId: id, note: null });
      expect(await invoice(tx, creditNoteId)).toMatchObject({
        doc_type: "TD04", status: "emessa", number_label: "NC-1/2026", xml: null, xml_sha256: null,
        transmission_id: null, snapshot: { electronic: false, credited: { numberLabel: "1/2026" } },
      });
      expect(await invoice(tx, id)).toMatchObject({ status: "annullata", credit_note_id: creditNoteId });
    });
  });

  it("uB non incassa e non annulla le fatture di A, neppure passando lo studio A", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await issued(tx);
      const before = await state(tx);
      await switchToUser(tx, { userId: USER_B });
      for (const scope of [PRACTICE_A, PRACTICE_B]) {
        await expect(registerPayment(tx, scope, laterClock, { invoiceId: id, method: "carta", paidOn: "2026-11-05" })).rejects.toThrow("Operazione non permessa");
        await expect(undoPayment(tx, scope, laterClock, { invoiceId: id })).rejects.toThrow("Operazione non permessa");
        await expect(cancelWithCreditNote(tx, scope, laterClock, { invoiceId: id, note: null })).rejects.toThrow("Operazione non permessa");
      }
      await switchToUser(tx, { userId: USER_A });
      expect(await state(tx)).toEqual(before);
    });
  });

  it("uA non riattiva il legame di una riga della fattura annullata: 42501", async () => {
    await expectPgError(inUserA(db, async (tx) => {
      const { id } = await issued(tx);
      await cancelWithCreditNote(tx, PRACTICE_A, laterClock, { invoiceId: id, note: null });
      return tx.query("update public.invoice_lines set link_active = true where practice_id = $1 and invoice_id = $2", [PRACTICE_A, id]);
    }), "42501", /^Il legame con l'appuntamento cambia solo quando la fattura è annullata$/);
  });

  it("uA non riattiva il legame di una riga della nota di credito: 23514", async () => {
    await expectPgError(inUserA(db, async (tx) => {
      const { id } = await issued(tx);
      const { creditNoteId } = await cancelWithCreditNote(tx, PRACTICE_A, laterClock, { invoiceId: id, note: null });
      return tx.query("update public.invoice_lines set link_active = true where practice_id = $1 and invoice_id = $2", [PRACTICE_A, creditNoteId]);
    }), "23514", /^Una riga di una nota di credito non tiene l'appuntamento$/);
  });
});
