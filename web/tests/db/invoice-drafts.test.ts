import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { switchToUser } from "@/server/db/service";
import { createAppointment } from "@/server/domain/appointments/commands";
import { deleteInvoiceDraft, markNotToInvoice, saveBillingParty, saveInvoiceDraft } from "@/server/domain/invoices/commands";
import { listToInvoice } from "@/server/domain/invoices/queries";
import { defaultInvoiceRecipient, saveRecipientFiscalFields } from "@/server/domain/invoices/recipient";
import { getRegistry } from "@/server/domain/patients/card";
import { createPatient, saveGuardian } from "@/server/domain/patients/commands";
import { saveFiscalSettings } from "@/server/domain/settings/commands";
import { STUDIO } from "../../seed/people";
import { INVOICE_A, issueInvoice, PATIENT_A1, PRACTICE_A, PRACTICE_B, SERVICE_A, USER_A, USER_B } from "./fixtures";
import { inUserA, openTestDb } from "./helpers";

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const party = {
  id: null, name: "Polisportiva – Esempio", vatNumber: "00000000000", taxCode: null,
  addressLine: "Via dello Sport 1", postalCode: "40139", city: "Bologna", province: "BO",
  recipientCode: "ABC1234", pec: null, isWithholdingAgent: true,
};
const fiscal = {
  regime: "forfettario", vatNumber: "00000000000", taxCode: STUDIO.practitionerTaxCode,
  atecoCode: "86.96.09", fiscalAddressLine: "Via delle Prove 7", fiscalPostalCode: "40121",
  fiscalCity: "Bologna", fiscalProvince: "BO", fiscalCountry: "IT", inpsSurchargeEnabled: false,
  stampChargedToClient: true, paperStampAuthorization: null, iban: null, ibanHolder: null,
  defaultPaymentMethod: "carta", bankTransferDueDays: 15,
};
const line = (appointmentId: string | null = null, unitPriceCents = 5500) => ({
  serviceId: SERVICE_A, appointmentId, description: "Trattamento osteopatico", serviceDate: "2026-11-03",
  quantity: 1, unitPriceCents,
});
const draft = (patientId: string, appointmentId: string | null = null) => ({
  invoiceId: null as string | null, recipient: { kind: "paziente" as const, patientId },
  lines: [line(appointmentId)], paymentMethod: "carta", paidOn: null, stampMarkCode: null, internalNotes: null,
});

let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

async function patient(tx: Tx, minor = false) {
  return (await createPatient(tx, PRACTICE_A, clock, {
    firstName: "Elisa", lastName: "Fontana", birthDate: minor ? "2010-01-01" : "1990-01-01",
    ...(minor ? { guardian: { firstName: "Laura", lastName: "Benedetti" } } : {}),
  })).id;
}
async function appointment(tx: Tx, patientId: string, status = "fatto") {
  const created = await createAppointment(tx, PRACTICE_A, clock, {
    patient: { kind: "existing", patientId }, serviceId: SERVICE_A, day: "2026-11-03", time: "10:00",
    durationMin: 45, cycle: { kind: "new" }, priceCents: 5500, status,
  });
  return created.appointments[0]!.id;
}
async function invoice(tx: Tx, id: string) {
  return (await tx.query("select * from public.invoices where practice_id = $1 and id = $2", [PRACTICE_A, id]))[0];
}
async function lines(tx: Tx, id: string) {
  return tx.query("select * from public.invoice_lines where practice_id = $1 and invoice_id = $2 order by line_number", [PRACTICE_A, id]);
}

describe("bozze e destinatari", () => {
  it("riusa l'id nuovo del client anche quando si ripete Salva bozza", async () => {
    await inUserA(db, async (tx) => {
      const id = "b1919191-1919-4191-8191-191919191919";
      const input = { ...draft(await patient(tx)), id };
      expect(await saveInvoiceDraft(tx, PRACTICE_A, clock, input)).toEqual({ id });
      expect(await saveInvoiceDraft(tx, PRACTICE_A, clock, input)).toEqual({ id });
      expect(await tx.query("select id from public.invoices where practice_id = $1 and id = $2", [PRACTICE_A, id])).toEqual([{ id }]);
      expect(await lines(tx, id)).toHaveLength(1);
      expect(await tx.query("select event_type from public.invoice_events where practice_id = $1 and invoice_id = $2 order by event_type", [PRACTICE_A, id])).toEqual([
        { event_type: "creata" }, { event_type: "modificata" },
      ]);
    });
  });

  it("rifiuta con DomainError la seduta segnata da non fatturare senza scrivere", async () => {
    await inUserA(db, async (tx) => {
      const p = await patient(tx);
      const a = await appointment(tx, p);
      await markNotToInvoice(tx, PRACTICE_A, clock, { appointmentId: a, reason: "gratuita" });
      const before = await tx.query("select id from public.invoices where practice_id = $1 order by id", [PRACTICE_A]);
      await expect(saveInvoiceDraft(tx, PRACTICE_A, clock, draft(p, a))).rejects.toMatchObject({
        name: "DomainError", message: "Questa seduta è segnata come da non fatturare: togli il segno prima di fatturarla.",
      });
      expect(await tx.query("select id from public.invoices where practice_id = $1 order by id", [PRACTICE_A])).toEqual(before);
    });
  });

  it.each(["paziente", "tutore"] as const)("ignora CF e campi indirizzo vuoti e rifila quelli dati per %s", async (kind) => {
    await inUserA(db, async (tx) => {
      const patientId = await patient(tx, kind === "tutore");
      const registry = (await getRegistry(tx, PRACTICE_A, patientId))!;
      const recipient = kind === "tutore"
        ? { kind, patientId, guardianId: registry.guardians[0]!.id }
        : { kind, patientId };
      const address = { addressLine: "Via delle Prove 1", postalCode: "40121", city: "Bologna", province: "BO" };
      await saveRecipientFiscalFields(tx, PRACTICE_A, clock, { ...recipient, taxCode: STUDIO.practitionerTaxCode, address });
      const before = await getRegistry(tx, PRACTICE_A, patientId);
      await saveRecipientFiscalFields(tx, PRACTICE_A, clock, { ...recipient, taxCode: "   " });
      expect(await getRegistry(tx, PRACTICE_A, patientId)).toEqual(before);
      await saveRecipientFiscalFields(tx, PRACTICE_A, clock, {
        ...recipient, taxCode: `  ${STUDIO.practitionerTaxCode}  `,
        address: { addressLine: "  ", postalCode: "", city: "  Modena  ", province: " MO " },
      });
      const after = (await getRegistry(tx, PRACTICE_A, patientId))!;
      expect(kind === "tutore" ? after.guardians[0] : { ...after.personali, ...after.indirizzo }).toMatchObject({
        taxCode: STUDIO.practitionerTaxCode, ...address, city: "Modena", province: "MO",
      });
    });
  });

  it("salva e ricalcola tutta la bozza forfettaria, bollo ed eventi con l'orologio", async () => {
    await inUserA(db, async (tx) => {
      await saveFiscalSettings(tx, PRACTICE_A, clock, fiscal);
      const p = await patient(tx);
      const a = await appointment(tx, p);
      const input = draft(p, a);
      const { id } = await saveInvoiceDraft(tx, PRACTICE_A, clock, input);
      expect(await invoice(tx, id)).toMatchObject({ status: "bozza", regime: "forfettario", fees_cents: 5500, total_cents: 5500, net_cents: 5500, number: null });
      expect(await lines(tx, id)).toMatchObject([{ line_number: 1, line_kind: "prestazione", unit_price_cents: 5500, line_total_cents: 5500, nature: "N2.2", vat_rate_bp: 0, link_active: true }]);
      expect((await lines(tx, id))).toHaveLength(1);
      expect(await listToInvoice(tx, PRACTICE_A, clock)).not.toContainEqual(expect.objectContaining({ appointmentId: a }));
      expect(await saveInvoiceDraft(tx, PRACTICE_A, clock, { ...input, invoiceId: id, lines: [...input.lines, line(null, 8000)] })).toEqual({ id });
      expect(await lines(tx, id)).toMatchObject([
        { line_number: 1, line_kind: "prestazione", line_total_cents: 5500 },
        { line_number: 2, line_kind: "prestazione", line_total_cents: 8000 },
        { line_number: 3, line_kind: "rimborso_bollo", line_total_cents: 200, nature: "N2.2", appointment_id: null },
      ]);
      expect(await invoice(tx, id)).toMatchObject({ fees_cents: 13500, total_cents: 13700, net_cents: 13700 });
      expect(await tx.query("select event_type, at from public.invoice_events where practice_id = $1 and invoice_id = $2 order by event_type", [PRACTICE_A, id])).toEqual([
        { event_type: "creata", at: clock.now() }, { event_type: "modificata", at: clock.now() },
      ]);
      await deleteInvoiceDraft(tx, PRACTICE_A, clock, { invoiceId: id });
      expect(await invoice(tx, id)).toBeUndefined();
      expect(await lines(tx, id)).toEqual([]);
      expect(await listToInvoice(tx, PRACTICE_A, clock)).toContainEqual(expect.objectContaining({ appointmentId: a }));
    });
  });

  it("ricopia il regime corrente e salva il lordo del paziente in ordinario", async () => {
    await inUserA(db, async (tx) => {
      await saveFiscalSettings(tx, PRACTICE_A, clock, fiscal);
      const input = draft(await patient(tx));
      const { id } = await saveInvoiceDraft(tx, PRACTICE_A, clock, input);
      await saveFiscalSettings(tx, PRACTICE_A, clock, { ...fiscal, regime: "ordinario" });
      await saveInvoiceDraft(tx, PRACTICE_A, clock, { ...input, invoiceId: id });
      expect(await invoice(tx, id)).toMatchObject({ regime: "ordinario", fees_cents: 4508, vat_cents: 992, total_cents: 5500 });
      expect(await lines(tx, id)).toMatchObject([{ unit_price_cents: 5500, line_total_cents: 5500, vat_rate_bp: 2200, nature: null }]);
    });
  });

  it("applica la ritenuta al committente sostituto in ordinario", async () => {
    await inUserA(db, async (tx) => {
      await saveFiscalSettings(tx, PRACTICE_A, clock, { ...fiscal, regime: "ordinario" });
      const b = await saveBillingParty(tx, PRACTICE_A, clock, party);
      const { id } = await saveInvoiceDraft(tx, PRACTICE_A, clock, { ...draft(PATIENT_A1), recipient: { kind: "committente", billingPartyId: b.id } });
      expect(await invoice(tx, id)).toMatchObject({ withholding_agent: true, withholding_applied: true, fees_cents: 5500, withholding_cents: 1100, total_cents: 6710, net_cents: 5610 });
      expect(await lines(tx, id)).toMatchObject([{ subject_to_withholding: true }]);
    });
  });

  it.each([
    ["altro paziente", "La seduta è di un altro paziente."],
    ["prenotata", "Si fattura solo una seduta fatta."],
    ["occupata", "Questa seduta è già in un'altra fattura."],
  ])("rifiuta una seduta %s prima delle scritture", async (kind, message) => {
    await inUserA(db, async (tx) => {
      const p = await patient(tx);
      const a = await appointment(tx, p, kind === "prenotata" ? "prenotato" : "fatto");
      if (kind === "occupata") await saveInvoiceDraft(tx, PRACTICE_A, clock, draft(p, a));
      const before = await tx.query("select * from public.invoices where practice_id = $1 order by id", [PRACTICE_A]);
      await expect(saveInvoiceDraft(tx, PRACTICE_A, clock, draft(kind === "altro paziente" ? PATIENT_A1 : p, a))).rejects.toThrow(message);
      expect(await tx.query("select * from public.invoices where practice_id = $1 order by id", [PRACTICE_A])).toEqual(before);
    });
  });

  it("rifiuta modifica e cancellazione di una fattura emessa", async () => {
    await inUserA(db, async (tx) => {
      await issueInvoice(tx, { invoiceId: INVOICE_A, issueDate: "2026-11-03" });
      const before = await invoice(tx, INVOICE_A);
      await expect(deleteInvoiceDraft(tx, PRACTICE_A, clock, { invoiceId: INVOICE_A })).rejects.toThrow("Solo una bozza si modifica o si elimina.");
      await expect(saveInvoiceDraft(tx, PRACTICE_A, clock, { ...draft(PATIENT_A1), invoiceId: INVOICE_A })).rejects.toThrow("La fattura è già emessa.");
      expect(await invoice(tx, INVOICE_A)).toEqual(before);
    });
  });

  it("rifiuta un genitore di un altro paziente", async () => {
    await inUserA(db, async (tx) => {
      const p = await patient(tx, true);
      const g = (await getRegistry(tx, PRACTICE_A, p))!.guardians[0]!;
      const recipient = { kind: "tutore", patientId: p, guardianId: g.id };
      const before = await tx.query("select id from public.invoices where practice_id = $1 order by id", [PRACTICE_A]);
      expect(await defaultInvoiceRecipient(tx, PRACTICE_A, p, "2026-11-03")).toEqual(recipient);
      expect(await defaultInvoiceRecipient(tx, PRACTICE_A, p, "2028-01-01")).toEqual({ kind: "paziente", patientId: p });
      expect(await tx.query("select id from public.invoices where practice_id = $1 order by id", [PRACTICE_A])).toEqual(before);
      const saved = await saveInvoiceDraft(tx, PRACTICE_A, clock, { ...draft(p), recipient });
      expect(await invoice(tx, saved.id)).toMatchObject({ recipient_kind: "tutore", patient_id: p, guardian_id: g.id, withholding_agent: false });
      // La proposta non impone il genitore: anche il paziente minore è selezionabile.
      const selected = await saveInvoiceDraft(tx, PRACTICE_A, clock, draft(p));
      expect(await invoice(tx, selected.id)).toMatchObject({ recipient_kind: "paziente", guardian_id: null });
      await expect(saveInvoiceDraft(tx, PRACTICE_A, clock, { ...draft(PATIENT_A1), recipient: { kind: "tutore", patientId: PATIENT_A1, guardianId: g.id } })).rejects.toThrow("Operazione non permessa");
    });
  });

  it("Non fatturare salva il motivo e toglie la seduta dall'elenco; il motivo è obbligatorio", async () => {
    await inUserA(db, async (tx) => {
      const a = await appointment(tx, await patient(tx));
      await expect(markNotToInvoice(tx, PRACTICE_A, clock, { appointmentId: a })).rejects.toThrow("Scegli un motivo.");
      await markNotToInvoice(tx, PRACTICE_A, clock, { appointmentId: a, reason: "gratuita" });
      expect(await tx.query("select no_invoice_reason from public.appointments where id = $1", [a])).toEqual([{ no_invoice_reason: "gratuita" }]);
      expect(await listToInvoice(tx, PRACTICE_A, clock)).not.toContainEqual(expect.objectContaining({ appointmentId: a }));
    });
  });

  it("inserisce e aggiorna un committente, normalizza Latin-1 e richiede P.IVA o CF", async () => {
    await inUserA(db, async (tx) => {
      await expect(saveBillingParty(tx, PRACTICE_A, clock, { ...party, vatNumber: null })).rejects.toThrow("Serve la partita IVA o il codice fiscale del committente.");
      const { id } = await saveBillingParty(tx, PRACTICE_A, clock, party);
      expect(await tx.query("select name from public.billing_parties where id = $1", [id])).toEqual([{ name: "Polisportiva - Esempio" }]);
      expect(await saveBillingParty(tx, PRACTICE_A, clock, { ...party, id, name: "Polisportiva d’Esempio", addressLine: "Via dell’Esempio 2" })).toEqual({ id });
      expect(await tx.query("select name, address_line from public.billing_parties where id = $1", [id])).toEqual([{ name: "Polisportiva d'Esempio", address_line: "Via dell'Esempio 2" }]);
      const saved = await saveInvoiceDraft(tx, PRACTICE_A, clock, { ...draft(PATIENT_A1), lines: [{ ...line(), description: "Seduta d’esempio" }] });
      expect(await lines(tx, saved.id)).toMatchObject([{ description: "Seduta d'esempio" }]);
    });
  });

  it("completa solo il CF del paziente e indirizzo e CAP del genitore preservando il resto", async () => {
    await inUserA(db, async (tx) => {
      const p = await patient(tx);
      const before = await getRegistry(tx, PRACTICE_A, p);
      await saveRecipientFiscalFields(tx, PRACTICE_A, clock, { kind: "paziente", patientId: p, taxCode: STUDIO.practitionerTaxCode });
      expect(await getRegistry(tx, PRACTICE_A, p)).toEqual({ ...before, personali: { ...before!.personali, taxCode: STUDIO.practitionerTaxCode } });
      const minor = await patient(tx, true);
      const registry = (await getRegistry(tx, PRACTICE_A, minor))!;
      const { id: guardianId, ...g } = registry.guardians[0]!;
      await saveGuardian(tx, PRACTICE_A, clock, { ...g, guardianId, patientId: minor, addressLine: "Via delle Prove 1", postalCode: "40121", city: "Bologna", province: "BO" });
      const old = (await getRegistry(tx, PRACTICE_A, minor))!;
      const address = { addressLine: "Via delle Prove 2", postalCode: "40139", city: "Bologna", province: "BO" };
      await saveRecipientFiscalFields(tx, PRACTICE_A, clock, { kind: "tutore", patientId: minor, guardianId, address });
      expect(await getRegistry(tx, PRACTICE_A, minor)).toEqual({ ...old, guardians: [{ ...old.guardians[0], ...address }] });
    });
  });

  it("uB non modifica gli id di A con nessun comando", async () => {
    await inUserA(db, async (tx) => {
      const p = await patient(tx);
      const a = await appointment(tx, p);
      const minor = await patient(tx, true);
      const guardianId = (await getRegistry(tx, PRACTICE_A, minor))!.guardians[0]!.id;
      const b = await saveBillingParty(tx, PRACTICE_A, clock, party);
      const saved = await saveInvoiceDraft(tx, PRACTICE_A, clock, draft(p));
      const before = { invoice: await invoice(tx, saved.id), registry: await getRegistry(tx, PRACTICE_A, p) };
      const snapshot = async () => ({
        invoices: await tx.query("select * from public.invoices where practice_id = $1 order by id", [PRACTICE_A]),
        lines: await tx.query("select * from public.invoice_lines where practice_id = $1 order by id", [PRACTICE_A]),
        events: await tx.query("select * from public.invoice_events where practice_id = $1 order by id", [PRACTICE_A]),
        parties: await tx.query("select * from public.billing_parties where practice_id = $1 order by id", [PRACTICE_A]),
        registry: await getRegistry(tx, PRACTICE_A, minor),
      });
      const untouched = await snapshot();
      await switchToUser(tx, { userId: USER_B });
      for (const scope of [PRACTICE_A, PRACTICE_B]) {
        const calls = [
          () => saveInvoiceDraft(tx, scope, clock, draft(p, a)),
          () => saveInvoiceDraft(tx, scope, clock, { ...draft(p), invoiceId: saved.id }),
          () => saveInvoiceDraft(tx, scope, clock, { ...draft(p), recipient: { kind: "committente", billingPartyId: b.id } }),
          () => deleteInvoiceDraft(tx, scope, clock, { invoiceId: saved.id }),
          () => markNotToInvoice(tx, scope, clock, { appointmentId: a, reason: "altro" }),
          () => saveBillingParty(tx, scope, clock, { ...party, id: b.id }),
          () => saveRecipientFiscalFields(tx, scope, clock, { kind: "paziente", patientId: p, taxCode: STUDIO.practitionerTaxCode }),
          () => saveRecipientFiscalFields(tx, scope, clock, { kind: "tutore", patientId: minor, guardianId, address: { addressLine: "Via delle Prove 2", postalCode: "40139", city: "Bologna", province: "BO" } }),
        ];
        for (const call of calls) await expect(call()).rejects.toThrow("Operazione non permessa");
      }
      await expect(saveBillingParty(tx, PRACTICE_A, clock, party)).rejects.toThrow("Operazione non permessa");
      await switchToUser(tx, { userId: USER_A });
      expect(await snapshot()).toEqual(untouched);
      expect(await invoice(tx, saved.id)).toEqual(before.invoice);
      expect(await getRegistry(tx, PRACTICE_A, p)).toEqual(before.registry);
      expect(await tx.query("select no_invoice_reason from public.appointments where id = $1", [a])).toEqual([{ no_invoice_reason: null }]);
      expect(await tx.query("select name from public.billing_parties where id = $1", [b.id])).toEqual([{ name: "Polisportiva - Esempio" }]);
    });
  });
});
