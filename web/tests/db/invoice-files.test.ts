import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pdfFileName } from "@/lib/fiscal/numbering";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { createAppointment } from "@/server/domain/appointments/commands";
import {
  attachInvoicePdf, cancelWithCreditNote, issueInvoice, recordDownload, registerPayment, saveInvoiceDraft, undoPayment,
} from "@/server/domain/invoices/commands";
import { saveRecipientFiscalFields } from "@/server/domain/invoices/recipient";
import { createPatient } from "@/server/domain/patients/commands";
import { saveFiscalSettings, saveStudio } from "@/server/domain/settings/commands";
import { storageKey } from "@/server/files/keys";
import type { StoreContext } from "@/server/files/upload";
import { ensureInvoicePdf, readInvoiceXml } from "@/server/pdf/invoice-file";
import { STUDIO } from "../../seed/people";
import { pdfText } from "../support/pdf-text";
import { INVOICE_A, INVOICE_B, PRACTICE_A, PRACTICE_B, SERVICE_A, USER_A, USER_B } from "./fixtures";
import { asServiceFor, asUserA, asUserB, expectPgError, inUserA, openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

// PDF della fattura e download. `ensureInvoicePdf` apre le sue
// transazioni e salva davvero: si chiama su fatture scritte ed emesse come uA e salvate (non in rollback),
// poi le righe si rileggono come servizio. Oggi è mercoledì 4/11/2026 alle 08:30 di Roma.

const issueClock = fixedClock("2026-11-04T08:30:00+01:00");
const downloadClock = fixedClock("2026-11-10T09:15:00+01:00");
const fiscal = {
  regime: "forfettario", vatNumber: "00000000000", taxCode: STUDIO.practitionerTaxCode,
  atecoCode: "86.96.09", fiscalAddressLine: "Via delle Prove 7", fiscalPostalCode: "40121",
  fiscalCity: "Bologna", fiscalProvince: "BO", fiscalCountry: "IT", inpsSurchargeEnabled: false,
  stampChargedToClient: true, paperStampAuthorization: null, iban: "IT80N0000001000000000123456",
  ibanHolder: "Laura Benedetti", defaultPaymentMethod: "carta", bankTransferDueDays: 15,
};
const PDF_MAGIC = "%PDF-";

let db: Db;
let pg: PGlite;
let store: MemoryFileStore;
let ctxA: StoreContext;
let ctxB: StoreContext;
let invoiceId: string;
let creditNoteId: string;
let extraInvoiceId: string;

/** Una fattura emessa con due sedute (70,00 e 55,00) e il bollo: 127,00; salvata davvero. */
async function issueOne(tx: Tx, firstName: string, day: string, regime = "forfettario") {
  await saveFiscalSettings(tx, PRACTICE_A, issueClock, { ...fiscal, regime });
  await saveStudio(tx, PRACTICE_A, issueClock, {
    practiceName: STUDIO.practiceName, practitionerFirstName: "Laura", practitionerLastName: "Benedetti",
    practitionerTitle: "Osteopata", addressLine: "Via delle Prove 7", postalCode: "40121", city: "Bologna",
    province: "BO", phone: "+390510000000", email: "studio@example.com", pec: null,
  });
  const { id: patientId } = await createPatient(tx, PRACTICE_A, issueClock, { firstName, lastName: "Fontana", birthDate: "1990-01-01" });
  await saveRecipientFiscalFields(tx, PRACTICE_A, issueClock, {
    kind: "paziente", patientId, taxCode: STUDIO.practitionerTaxCode,
    address: { addressLine: "Via delle Prove 1", postalCode: "40121", city: "Bologna", province: "BO" },
  });
  const appointments: string[] = [];
  let cycle: { kind: "new" } | { kind: "existing"; cycleId: string } = { kind: "new" };
  for (const time of ["10:00", "11:00"]) {
    const created = await createAppointment(tx, PRACTICE_A, issueClock, {
      patient: { kind: "existing", patientId }, serviceId: SERVICE_A, day, time,
      durationMin: 45, cycle, priceCents: 5500, status: "fatto",
    });
    appointments.push(created.appointments[0]!.id);
    cycle = { kind: "existing", cycleId: created.cycleId };
  }
  const lines = [7000, 5500].map((unitPriceCents, i) => ({
    serviceId: SERVICE_A, appointmentId: appointments[i]!, description: `Trattamento osteopatico ${i + 1}`,
    serviceDate: day, quantity: 1, unitPriceCents,
  }));
  const { id } = await saveInvoiceDraft(tx, PRACTICE_A, issueClock, {
    invoiceId: null, recipient: { kind: "paziente", patientId }, lines,
    paymentMethod: "carta", paidOn: null, stampMarkCode: null, internalNotes: null,
  });
  await issueInvoice(tx, PRACTICE_A, issueClock, { invoiceId: id });
  return id;
}

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  ctxA = { db, actor: { userId: USER_A }, practiceId: PRACTICE_A };
  ctxB = { db, actor: { userId: USER_B }, practiceId: PRACTICE_B };
  invoiceId = await asUserA(db, (tx) => issueOne(tx, "Elisa", "2026-11-03"));
  extraInvoiceId = await asUserA(db, (tx) => issueOne(tx, "Irene", "2026-11-02"));
  creditNoteId = (await asUserA(db, (tx) => cancelWithCreditNote(tx, PRACTICE_A, downloadClock, { invoiceId: extraInvoiceId, note: null }))).creditNoteId;
});

beforeEach(() => {
  store = new MemoryFileStore();
});

afterAll(async () => {
  await pg?.close();
});

const filesOf = (kind: string) =>
  asServiceFor(db, (tx) =>
    tx.query<{ id: string; kind: string; storage_key: string; mime_type: string; size_bytes: number }>(
      "select id, kind, storage_key, mime_type, size_bytes from public.files where practice_id = $1 and kind = $2 order by id",
      [PRACTICE_A, kind]));
const pdfFileIdOf = async (id: string) =>
  (await asServiceFor(db, (tx) => tx.query<{ pdf_file_id: string | null }>(
    "select pdf_file_id from public.invoices where practice_id = $1 and id = $2", [PRACTICE_A, id])))[0]?.pdf_file_id;

describe("ensureInvoicePdf", () => {
  it("la prima chiamata genera e salva il PDF, la seconda serve gli stessi byte senza una seconda riga", async () => {
    const before = await filesOf("invoice_pdf");
    expect(await pdfFileIdOf(invoiceId)).toBeNull();

    const first = await ensureInvoicePdf(ctxA, issueClock, store, invoiceId);
    expect(first?.fileName).toBe(pdfFileName("TD01", "1/2026"));
    expect(Buffer.from(first!.bytes.subarray(0, PDF_MAGIC.length)).toString("latin1")).toBe(PDF_MAGIC);
    const { text, info } = await pdfText(first!.bytes);
    expect(text.replace(/\s+/g, " ")).toContain("Fattura n. 1/2026 del 04/11/2026");
    expect(info.Title).toBe("Fattura 1/2026");

    const fileId = await pdfFileIdOf(invoiceId);
    expect(fileId).not.toBeNull();
    const files = await filesOf("invoice_pdf");
    expect(files).toHaveLength(before.length + 1);
    const key = storageKey(PRACTICE_A, "invoice_pdf", fileId!, "application/pdf");
    expect(files.find((f) => f.id === fileId)).toMatchObject({
      kind: "invoice_pdf", mime_type: "application/pdf", storage_key: key, size_bytes: first!.bytes.length,
    });
    expect(store.keys()).toEqual([key]);
    expect(await store.get(key)).toEqual(first!.bytes);

    const second = await ensureInvoicePdf(ctxA, downloadClock, store, invoiceId);
    expect(second?.bytes).toEqual(first!.bytes);
    expect(second?.fileName).toBe(pdfFileName("TD01", "1/2026"));
    expect(await filesOf("invoice_pdf")).toHaveLength(before.length + 1);
    expect(store.keys()).toEqual([key]);
    expect(await pdfFileIdOf(invoiceId)).toBe(fileId);
  });

  it("la fattura annullata ha il suo PDF, e la nota di credito il proprio con il nome NotaCredito", async () => {
    const original = await ensureInvoicePdf(ctxA, downloadClock, store, extraInvoiceId);
    expect(original?.fileName).toBe(pdfFileName("TD01", "2/2026"));
    const note = await ensureInvoicePdf(ctxA, downloadClock, store, creditNoteId);
    expect(note?.fileName).toBe("NotaCredito_NC-1-2026.pdf");
    const text = (await pdfText(note!.bytes)).text.replace(/\s+/g, " ");
    expect(text).toContain("storno della fattura n. 2/2026 del 04/11/2026");
    expect(await pdfFileIdOf(extraInvoiceId)).not.toBeNull();
    expect(await pdfFileIdOf(creditNoteId)).not.toBeNull();
  });

  it("una bozza, una fattura di un altro studio e un id che non c'è non hanno PDF", async () => {
    expect(await ensureInvoicePdf(ctxA, issueClock, store, INVOICE_A)).toBeNull();
    expect(await ensureInvoicePdf(ctxB, issueClock, store, INVOICE_B)).toBeNull();
    expect(await ensureInvoicePdf(ctxB, issueClock, store, invoiceId)).toBeNull();
    expect(await ensureInvoicePdf(ctxA, issueClock, store, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(store.keys()).toEqual([]);
  });

  it("se lo store non scrive, niente riga e niente file: la richiesta dopo ci riprova", async () => {
    const filesBefore = await filesOf("invoice_pdf");
    const pending = await asUserA(db, (tx) => issueOne(tx, "Giada", "2026-11-01"));
    store.failNextPut();
    await expect(ensureInvoicePdf(ctxA, issueClock, store, pending)).rejects.toThrow("Scrittura del file fallita");
    expect(await pdfFileIdOf(pending)).toBeNull();
    expect(await filesOf("invoice_pdf")).toHaveLength(filesBefore.length);
    expect(store.keys()).toEqual([]);
    expect(await ensureInvoicePdf(ctxA, issueClock, store, pending)).not.toBeNull();
    expect(await pdfFileIdOf(pending)).not.toBeNull();
  });

  it("se il file salvato non è più nello store, la risposta è null", async () => {
    const lost = await asUserA(db, (tx) => issueOne(tx, "Luisa", "2026-10-30"));
    await ensureInvoicePdf(ctxA, issueClock, store, lost);
    expect(await ensureInvoicePdf(ctxA, issueClock, new MemoryFileStore(), lost)).toBeNull();
  });
});

describe("il PDF e l'incasso", () => {
  const paidOn = "2026-11-09";
  const flatText = async (pdf: { bytes: Uint8Array } | null) => (await pdfText(pdf!.bytes)).text.replace(/\s+/g, " ");
  const fileOf = (id: string) => ({ id, storageKey: storageKey(PRACTICE_A, "invoice_pdf", id, "application/pdf"), size: 10, sha256: "a".repeat(64) });

  it("annulla il bonifico ripristinando carta dalla fotografia e invalidando il PDF", async () => {
    const target = await asUserA(db, (tx) => issueOne(tx, "Ada", "2026-10-21"));
    const read = () => asUserA(db, async (tx) => (await tx.query<{
      payment_method: string; status: string; paid_on: string | null; paid_at: Date | null;
      xml: string; snapshot: unknown; pdf_file_id: string | null;
    }>("select payment_method, status, paid_on, paid_at, xml, snapshot, pdf_file_id from public.invoices where practice_id = $1 and id = $2", [PRACTICE_A, target]))[0]!);
    const frozen = await read();
    await asUserA(db, (tx) => registerPayment(tx, PRACTICE_A, downloadClock, { invoiceId: target, method: "bonifico", paidOn }));
    await ensureInvoicePdf(ctxA, downloadClock, store, target);
    expect((await read()).pdf_file_id).not.toBeNull();
    await asUserA(db, (tx) => undoPayment(tx, PRACTICE_A, downloadClock, { invoiceId: target }));
    expect(await read()).toMatchObject({
      status: "emessa", payment_method: "carta", paid_on: null, paid_at: null, pdf_file_id: null,
      xml: frozen.xml, snapshot: frozen.snapshot,
    });
    const text = await flatText(await ensureInvoicePdf(ctxA, downloadClock, store, target));
    expect(text).toContain("Da pagare con carta");
    expect(text).not.toContain("Da pagare con bonifico");
  });

  it.each(["incasso", "annullo", "metodo"] as const)("non collega il PDF se cambia %s tra render e attach, e la richiesta dopo lo rigenera", async (change) => {
    const target = await asUserA(db, (tx) => issueOne(tx, "Marta", "2026-10-22"));
    if (change !== "incasso") {
      await asUserA(db, (tx) => registerPayment(tx, PRACTICE_A, downloadClock, { invoiceId: target, method: "carta", paidOn }));
    }
    const before = await filesOf("invoice_pdf");
    const put = store.put.bind(store);
    store.put = async (key, bytes) => {
      await put(key, bytes);
      store.put = put;
      await asUserA(db, async (tx) => {
        if (change !== "incasso") await undoPayment(tx, PRACTICE_A, downloadClock, { invoiceId: target });
        if (change !== "annullo") {
          await registerPayment(tx, PRACTICE_A, downloadClock, {
            invoiceId: target, method: change === "metodo" ? "bonifico" : "carta", paidOn,
          });
        }
      });
    };
    await expect(ensureInvoicePdf(ctxA, downloadClock, store, target)).rejects.toMatchObject({ name: "DomainError" });
    expect(await pdfFileIdOf(target)).toBeNull();
    expect(await filesOf("invoice_pdf")).toEqual(before);
    expect(store.keys()).toEqual([]);
    const next = await flatText(await ensureInvoicePdf(ctxA, downloadClock, store, target));
    expect(next).toContain(change === "annullo" ? "Da pagare con carta"
      : `Pagata il 09/11/2026 con ${change === "metodo" ? "bonifico" : "carta"}`);
    expect(await pdfFileIdOf(target)).not.toBeNull();
    expect(await filesOf("invoice_pdf")).toHaveLength(before.length + 1);
  });

  it("registra l'incasso e lo annulla: il PDF successivo dice lo stato vero e il vecchio file resta", async () => {
    const target = await asUserA(db, (tx) => issueOne(tx, "Nora", "2026-10-27"));
    const unpaid = await flatText(await ensureInvoicePdf(ctxA, issueClock, store, target));
    expect(unpaid).toContain("Da pagare con carta");
    expect(unpaid).not.toContain("Pagata il");
    const firstFileId = await pdfFileIdOf(target);
    expect(firstFileId).not.toBeNull();
    const filesBeforePayment = await filesOf("invoice_pdf");

    await asUserA(db, (tx) => registerPayment(tx, PRACTICE_A, downloadClock, { invoiceId: target, method: "bonifico", paidOn }));
    expect(await pdfFileIdOf(target)).toBeNull();
    expect(await filesOf("invoice_pdf")).toHaveLength(filesBeforePayment.length);

    const paid = await flatText(await ensureInvoicePdf(ctxA, downloadClock, store, target));
    expect(paid).toContain("Pagata il 09/11/2026 con bonifico");
    expect(paid).not.toContain("Da pagare");
    const secondFileId = await pdfFileIdOf(target);
    expect(secondFileId).not.toBeNull();
    expect(secondFileId).not.toBe(firstFileId);
    const files = await filesOf("invoice_pdf");
    expect(files).toHaveLength(filesBeforePayment.length + 1);
    expect(files.map((f) => f.id)).toContain(firstFileId);
    expect(store.keys()).toContain(storageKey(PRACTICE_A, "invoice_pdf", firstFileId!, "application/pdf"));

    await asUserA(db, (tx) => undoPayment(tx, PRACTICE_A, downloadClock, { invoiceId: target }));
    expect(await pdfFileIdOf(target)).toBeNull();
    const undone = await flatText(await ensureInvoicePdf(ctxA, downloadClock, store, target));
    expect(undone).not.toContain("Pagata il");
    expect(undone).toContain("Da pagare con carta");
    expect(await pdfFileIdOf(target)).not.toBe(secondFileId);
    expect(await filesOf("invoice_pdf")).toHaveLength(filesBeforePayment.length + 2);
  });

  it("un incasso rifiutato non tocca il PDF salvato", async () => {
    const target = await asUserA(db, (tx) => issueOne(tx, "Sara", "2026-10-26"));
    const first = await ensureInvoicePdf(ctxA, issueClock, store, target);
    const fileId = await pdfFileIdOf(target);
    await expect(asUserA(db, (tx) => undoPayment(tx, PRACTICE_A, downloadClock, { invoiceId: target }))).rejects.toMatchObject({ name: "DomainError" });
    expect(await pdfFileIdOf(target)).toBe(fileId);
    expect((await ensureInvoicePdf(ctxA, downloadClock, store, target))?.bytes).toEqual(first!.bytes);
  });

  it("il trigger non lascia azzerare pdf_file_id da solo su una fattura emessa", async () => {
    await inUserA(db, async (tx) => {
      const target = await issueOne(tx, "Tina", "2026-10-25");
      await attachInvoicePdf(tx, PRACTICE_A, issueClock, { invoiceId: target, file: fileOf("a0000000-0000-4000-8000-0000000000e4"), renderedPayment: { method: "carta", paidOn: null } });
      await expectPgError(
        tx.query("update public.invoices set pdf_file_id = null where id = $1", [target]),
        "42501", /^Il PDF di una fattura emessa non cambia dopo il salvataggio$/,
      );
    });
  });

  it("il trigger non lascia azzerare pdf_file_id su una fattura annullata", async () => {
    await inUserA(db, async (tx) => {
      const target = await issueOne(tx, "Ugo", "2026-10-24");
      await attachInvoicePdf(tx, PRACTICE_A, issueClock, { invoiceId: target, file: fileOf("a0000000-0000-4000-8000-0000000000e5"), renderedPayment: { method: "carta", paidOn: null } });
      await cancelWithCreditNote(tx, PRACTICE_A, downloadClock, { invoiceId: target, note: null });
      await expectPgError(
        tx.query("update public.invoices set pdf_file_id = null where id = $1", [target]),
        "42501", /^Una fattura annullata non cambia più$/,
      );
    });
  });
});

describe("attachInvoicePdf", () => {
  it("salva il file una sola volta: la seconda fa fallire e non lascia una riga in più", async () => {
    await inUserA(db, async (tx) => {
      const target = await issueOne(tx, "Teresa", "2026-10-29");
      const fileOf = (id: string) => ({ id, storageKey: storageKey(PRACTICE_A, "invoice_pdf", id, "application/pdf"), size: 10, sha256: "a".repeat(64) });
      const first = fileOf("a0000000-0000-4000-8000-0000000000e1");
      await attachInvoicePdf(tx, PRACTICE_A, issueClock, { invoiceId: target, file: first, renderedPayment: { method: "carta", paidOn: null } });
      const [row] = await tx.query<{ pdf_file_id: string }>("select pdf_file_id from public.invoices where id = $1", [target]);
      expect(row?.pdf_file_id).toBe(first.id);
      const count = async () => (await tx.query("select id from public.files where practice_id = $1 and kind = 'invoice_pdf'", [PRACTICE_A])).length;
      const before = await count();
      await expect(attachInvoicePdf(tx, PRACTICE_A, issueClock, {
        invoiceId: target, file: fileOf("a0000000-0000-4000-8000-0000000000e2"), renderedPayment: { method: "carta", paidOn: null },
      })).rejects.toMatchObject({ name: "DomainError" });
      expect(await count()).toBe(before);
    });
  });

  it("rifiuta una chiave di un altro studio o di un altro tipo, e una fattura che non è dello studio", async () => {
    await inUserA(db, async (tx) => {
      const target = await issueOne(tx, "Vera", "2026-10-28");
      const id = "a0000000-0000-4000-8000-0000000000e3";
      const good = { id, storageKey: storageKey(PRACTICE_A, "invoice_pdf", id, "application/pdf"), size: 10, sha256: "a".repeat(64) };
      await expect(attachInvoicePdf(tx, PRACTICE_A, issueClock, {
        invoiceId: target, file: { ...good, storageKey: storageKey(PRACTICE_A, "referral_pdf", id, "application/pdf") }, renderedPayment: { method: "carta", paidOn: null },
      })).rejects.toMatchObject({ name: "DomainError" });
      await expect(attachInvoicePdf(tx, PRACTICE_A, issueClock, {
        invoiceId: "00000000-0000-4000-8000-000000000000", file: good, renderedPayment: { method: "carta", paidOn: null },
      })).rejects.toMatchObject({ name: "DomainError" });
    });
  });
});

describe("recordDownload", () => {
  const eventsOf = (tx: Tx, id: string, type: string) =>
    tx.query<{ at: Date; event_type: string }>(
      "select at, event_type from public.invoice_events where practice_id = $1 and invoice_id = $2 and event_type = $3",
      [PRACTICE_A, id, type]);

  it("scrive pdf_scaricato e xml_scaricato con l'istante dell'orologio", async () => {
    await inUserA(db, async (tx) => {
      expect(await eventsOf(tx, invoiceId, "pdf_scaricato")).toEqual([]);
      await recordDownload(tx, PRACTICE_A, downloadClock, { invoiceId, kind: "pdf" });
      await recordDownload(tx, PRACTICE_A, downloadClock, { invoiceId, kind: "xml" });
      await recordDownload(tx, PRACTICE_A, issueClock, { invoiceId, kind: "pdf" });
      expect((await eventsOf(tx, invoiceId, "pdf_scaricato")).map((e) => e.at)).toEqual([downloadClock.now(), issueClock.now()]);
      expect((await eventsOf(tx, invoiceId, "xml_scaricato")).map((e) => e.at)).toEqual([downloadClock.now()]);
    });
  });

  it("come uB sugli id di A fallisce e non scrive niente; una bozza non ha download", async () => {
    await asUserB(db, async (tx) => {
      await expect(recordDownload(tx, PRACTICE_B, downloadClock, { invoiceId, kind: "pdf" })).rejects.toMatchObject({ name: "DomainError" });
    });
    await inUserA(db, async (tx) => {
      await expect(recordDownload(tx, PRACTICE_A, downloadClock, { invoiceId: INVOICE_A, kind: "pdf" })).rejects.toMatchObject({ name: "DomainError" });
      await expect(recordDownload(tx, PRACTICE_A, downloadClock, { invoiceId, kind: "zip" })).rejects.toThrow();
    });
    const events = await asServiceFor(db, (tx) => tx.query(
      "select id from public.invoice_events where event_type in ('pdf_scaricato','xml_scaricato') and invoice_id = any($1::uuid[])", [[invoiceId, INVOICE_A]]));
    expect(events).toEqual([]);
  });
});

describe("readInvoiceXml", () => {
  it("dà l'XML salvato con il nome del download e scrive xml_scaricato; l'esente verso il paziente (senza XML), la bozza e un altro studio danno null", async () => {
    const xml = await readInvoiceXml(ctxA, downloadClock, invoiceId);
    expect(xml?.fileName).toMatch(/^IT[A-Z0-9]+_00001\.xml$/);
    expect(xml?.xml.startsWith("<?xml")).toBe(true);
    const events = await asServiceFor(db, (tx) => tx.query<{ at: Date }>(
      "select at from public.invoice_events where invoice_id = $1 and event_type = 'xml_scaricato'", [invoiceId]));
    expect(events.map((e) => e.at)).toContainEqual(downloadClock.now());
    expect(await readInvoiceXml(ctxA, downloadClock, INVOICE_A)).toBeNull();
    expect(await readInvoiceXml(ctxB, downloadClock, invoiceId)).toBeNull();

    const exempt = await asUserA(db, (tx) => issueOne(tx, "Olga", "2026-10-23", "esente_sanitario"));
    const [stored] = await asServiceFor(db, (tx) => tx.query<{ xml: string | null; xml_file_name: string | null }>(
      "select xml, xml_file_name from public.invoices where id = $1", [exempt]));
    expect(stored).toEqual({ xml: null, xml_file_name: null });
    expect(await readInvoiceXml(ctxA, downloadClock, exempt)).toBeNull();
    const exemptEvents = await asServiceFor(db, (tx) => tx.query(
      "select id from public.invoice_events where invoice_id = $1 and event_type = 'xml_scaricato'", [exempt]));
    expect(exemptEvents).toEqual([]);
    // Il PDF c'è comunque: è la copia analogica, senza nome di file XML.
    const pdf = (await pdfText((await ensureInvoicePdf(ctxA, downloadClock, store, exempt))!.bytes)).text.replace(/\s+/g, " ");
    expect(pdf).toContain("Fattura emessa in formato analogico");
    expect(pdf).not.toContain("File XML:");
  });
});
