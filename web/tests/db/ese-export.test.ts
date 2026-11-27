import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { createAppointment } from "@/server/domain/appointments/commands";
import { DomainError } from "@/server/domain/errors";
import { cancelWithCreditNote, issueInvoice, recordEseExport, saveInvoiceDraft } from "@/server/domain/invoices/commands";
import { countEseDocuments, listEseDocuments } from "@/server/domain/invoices/queries";
import { saveRecipientFiscalFields } from "@/server/domain/invoices/recipient";
import { createPatient } from "@/server/domain/patients/commands";
import { saveFiscalSettings, saveStudio } from "@/server/domain/settings/commands";
import { STUDIO } from "../../seed/people";
import { PRACTICE_A, PRACTICE_B, SERVICE_A } from "./fixtures";
import { asUserA, asUserB, inUserA, openTestDb } from "./helpers";

// Export oscurato: quali documenti entrano nel periodo e cosa si registra. Oggi è martedì 20/10/2026
// alle 10:00 di Roma; le tre fatture sono di ottobre, una annullata da una nota (del 20/10), più una bozza.

const clock = fixedClock("2026-10-20T10:00:00+02:00");
const exportClock = fixedClock("2026-11-04T08:30:00+01:00");
const SHA = "ab".repeat(32);
const OTHER_SHA = "cd".repeat(32);
const fiscal = {
  regime: "forfettario", vatNumber: "00000000000", taxCode: STUDIO.practitionerTaxCode,
  atecoCode: "86.96.09", fiscalAddressLine: "Via delle Prove 7", fiscalPostalCode: "40121",
  fiscalCity: "Bologna", fiscalProvince: "BO", fiscalCountry: "IT", inpsSurchargeEnabled: false,
  stampChargedToClient: true, paperStampAuthorization: null, iban: "IT80N0000001000000000123456",
  ibanHolder: "Laura Benedetti", defaultPaymentMethod: "carta", bankTransferDueDays: 15,
};

let db: Db;
let pg: PGlite;
let issuedIds: string[];

async function newPatient(tx: Tx, firstName: string): Promise<string> {
  const { id } = await createPatient(tx, PRACTICE_A, clock, { firstName, lastName: "Fontana", birthDate: "1990-01-01" });
  await saveRecipientFiscalFields(tx, PRACTICE_A, clock, {
    kind: "paziente", patientId: id, taxCode: STUDIO.practitionerTaxCode,
    address: { addressLine: "Via delle Prove 1", postalCode: "40121", city: "Bologna", province: "BO" },
  });
  return id;
}

/** Una fattura emessa con una seduta da 55,00 nel giorno dato. */
async function issueOne(tx: Tx, firstName: string, day: string): Promise<string> {
  const patientId = await newPatient(tx, firstName);
  const created = await createAppointment(tx, PRACTICE_A, clock, {
    patient: { kind: "existing", patientId }, serviceId: SERVICE_A, day, time: "10:00",
    durationMin: 45, cycle: { kind: "new" }, priceCents: 5500, status: "fatto",
  });
  const { id } = await saveInvoiceDraft(tx, PRACTICE_A, clock, {
    invoiceId: null, recipient: { kind: "paziente", patientId },
    lines: [{
      serviceId: SERVICE_A, appointmentId: created.appointments[0]!.id, description: "Trattamento osteopatico",
      serviceDate: day, quantity: 1, unitPriceCents: 5500,
    }],
    paymentMethod: "carta", paidOn: null, stampMarkCode: null, internalNotes: null,
  });
  await issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id });
  return id;
}

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  issuedIds = await asUserA(db, async (tx) => {
    await saveFiscalSettings(tx, PRACTICE_A, clock, fiscal);
    await saveStudio(tx, PRACTICE_A, clock, {
      practiceName: STUDIO.practiceName, practitionerFirstName: "Laura", practitionerLastName: "Benedetti",
      practitionerTitle: "Osteopata", addressLine: "Via delle Prove 7", postalCode: "40121", city: "Bologna",
      province: "BO", phone: "+390510000000", email: "studio@example.com", pec: null,
    });
    const ids = [
      await issueOne(tx, "Elisa", "2026-10-05"),
      await issueOne(tx, "Irene", "2026-10-06"),
      await issueOne(tx, "Sara", "2026-10-07"),
    ];
    const note = await cancelWithCreditNote(tx, PRACTICE_A, clock, { invoiceId: ids[2]!, note: null });
    // Una bozza (anche con una riga libera): non entra mai.
    const draftPatient = await newPatient(tx, "Giulia");
    await saveInvoiceDraft(tx, PRACTICE_A, clock, {
      invoiceId: null, recipient: { kind: "paziente", patientId: draftPatient },
      lines: [{ serviceId: null, appointmentId: null, description: "Seduta", serviceDate: "2026-10-08", quantity: 1, unitPriceCents: 5500 }],
      paymentMethod: "carta", paidOn: null, stampMarkCode: null, internalNotes: null,
    });
    return [...ids, note.creditNoteId];
  });
});

afterAll(async () => {
  await pg?.close();
});

describe("listEseDocuments e recordEseExport", () => {
  it("uA vede 4 documenti di ottobre: la bozza no, l'annullata e la nota sì, in ordine di data e numero", async () => {
    const documents = await asUserA(db, (tx) => listEseDocuments(tx, PRACTICE_A, "2026-10", "2026-10"));
    expect(documents).toHaveLength(4);
    expect(documents.map((doc) => doc.snapshot.numberLabel)).toEqual(["1/2026", "2/2026", "3/2026", "NC-1/2026"]);
    expect(documents.map((doc) => doc.status)).toEqual(["emessa", "emessa", "annullata", "emessa"]);
    expect(new Set(documents.map((doc) => doc.id))).toEqual(new Set(issuedIds));
    for (const doc of documents) expect(doc.standardDescriptions).toHaveLength(doc.snapshot.lines.length);
    expect(await asUserA(db, (tx) => countEseDocuments(tx, PRACTICE_A, "2026-10", "2026-10"))).toBe(4);
    expect(await asUserA(db, (tx) => listEseDocuments(tx, PRACTICE_A, "2026-11", "2026-12"))).toEqual([]);
    expect(await asUserA(db, (tx) => countEseDocuments(tx, PRACTICE_A, "2026-09", "2026-09"))).toBe(0);
  });

  it("la descrizione standard è quella del listino di oggi, una per riga", async () => {
    const [first] = await asUserA(db, (tx) => listEseDocuments(tx, PRACTICE_A, "2026-10", "2026-10"));
    const [service] = await asUserA(db, (tx) =>
      tx.query<{ description: string }>("select invoice_description as description from public.services where id = $1", [SERVICE_A]));
    expect(first!.snapshot.lines.map((line) => line.kind)).toEqual(["prestazione"]);
    expect(first!.standardDescriptions).toEqual([service!.description]);
  });

  it("recordEseExport scrive fiscal_exports e un evento export_ese per documento", async () => {
    await inUserA(db, async (tx) => {
      await recordEseExport(tx, PRACTICE_A, exportClock, {
        from: "2026-10", to: "2026-10", count: 4, zipSha256: SHA, invoiceIds: issuedIds,
      });
      const exports = await tx.query<{ period_from: string; period_to: string; documents_count: number; zip_sha256: string }>(
        `select period_from::text, period_to::text, documents_count, zip_sha256
           from public.fiscal_exports where practice_id = $1 and zip_sha256 = $2`,
        [PRACTICE_A, SHA],
      );
      expect(exports).toEqual([{ period_from: "2026-10-01", period_to: "2026-10-31", documents_count: 4, zip_sha256: SHA }]);
      const events = await tx.query<{ invoice_id: string; at: Date }>(
        "select invoice_id, at from public.invoice_events where practice_id = $1 and event_type = 'export_ese'",
        [PRACTICE_A],
      );
      expect(events).toHaveLength(4);
      expect(new Set(events.map((event) => event.invoice_id))).toEqual(new Set(issuedIds));
      for (const event of events) expect(event.at.toISOString()).toBe(exportClock.now().toISOString());
    });
  });

  it("uB non vede i documenti di A e non può registrare un export sui loro id", async () => {
    expect(await asUserB(db, (tx) => listEseDocuments(tx, PRACTICE_B, "2026-10", "2026-10"))).toEqual([]);
    expect(await asUserB(db, (tx) => listEseDocuments(tx, PRACTICE_A, "2026-10", "2026-10"))).toEqual([]);
    expect(await asUserB(db, (tx) => countEseDocuments(tx, PRACTICE_A, "2026-10", "2026-10"))).toBe(0);
    // La stessa registrazione sugli id di A, con lo studio di B e con quello di A: sempre rifiutata, senza scrivere.
    for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
      await expect(
        asUserB(db, (tx) =>
          recordEseExport(tx, practiceId, exportClock, {
            from: "2026-10", to: "2026-10", count: 4, zipSha256: OTHER_SHA, invoiceIds: issuedIds,
          })),
      ).rejects.toBeInstanceOf(DomainError);
    }
    const rows = await asUserA(db, (tx) =>
      tx.query("select 1 from public.fiscal_exports where practice_id = $1 and zip_sha256 = $2", [PRACTICE_A, OTHER_SHA]));
    expect(rows).toEqual([]);
  });
});
