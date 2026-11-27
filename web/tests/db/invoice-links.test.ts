import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, Tx } from "@/server/db/db";
import {
  APPOINTMENT_A,
  FILE_A,
  INVOICE_A,
  INVOICE_LINE_A,
  invoiceDraft,
  issueInvoice,
  PRACTICE_A,
} from "./fixtures";
import { expectPgError, idOf, inRollback, insertRow, openTestDb, setPurge } from "./helpers";

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const LINK_MESSAGE = /^Il legame con l'appuntamento cambia solo quando la fattura è annullata$/;
const CREDIT_LINE_MESSAGE = /^Una riga di una nota di credito non tiene l'appuntamento$/;
const CREDIT_TARGET_MESSAGE = /^La nota di credito collegata deve stornare questa fattura$/;

async function creditDraft(tx: Tx, invoiceId = INVOICE_A): Promise<string> {
  return idOf(await insertRow(tx, "invoices", invoiceDraft({ doc_type: "TD04", credited_invoice_id: invoiceId })));
}

async function cancelInvoice(tx: Tx, creditNoteId: string): Promise<void> {
  await tx.query(
    `update public.invoices
        set status = 'annullata', credit_note_id = $2, cancelled_at = '2026-10-22T09:00:00Z'
      where id = $1`,
    [INVOICE_A, creditNoteId],
  );
}

/** La fattura della fixture ha già una riga attiva sull'appuntamento di A. */
async function cancelledInvoice(tx: Tx, service = false): Promise<string> {
  await issueInvoice(tx, { invoiceId: INVOICE_A, issueDate: "2026-10-20", ...(service ? { number: 1 } : {}) });
  const creditNoteId = await creditDraft(tx);
  await issueInvoice(tx, { invoiceId: creditNoteId, issueDate: "2026-10-22", ...(service ? { number: 1 } : {}) });
  await cancelInvoice(tx, creditNoteId);
  return creditNoteId;
}

async function creditLine(tx: Tx, invoiceId: string, linkActive: boolean): Promise<string> {
  return idOf(await insertRow(tx, "invoice_lines", {
    practice_id: PRACTICE_A,
    invoice_id: invoiceId,
    line_number: 1,
    line_kind: "prestazione",
    appointment_id: APPOINTMENT_A,
    description: "Seduta di osteopatia",
    quantity: 1,
    unit_price_cents: 6000,
    line_total_cents: 6000,
    vat_rate_bp: 0,
    nature: "N2.2",
    link_active: linkActive,
  }));
}

describe("verso dei legami della fattura", () => {
  it("uA non disattiva il legame di una fattura emessa: 42501", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await issueInvoice(tx, { invoiceId: INVOICE_A, issueDate: "2026-10-20" });
      return tx.query("update public.invoice_lines set link_active = false where id = $1", [INVOICE_LINE_A]);
    }), "42501", LINK_MESSAGE);
  });

  it("uA annulla con una TD04 emessa e disattiva il legame: righe rilette", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      const creditNoteId = await cancelledInvoice(tx);
      await tx.query("update public.invoice_lines set link_active = false where id = $1", [INVOICE_LINE_A]);
      return tx.query(
        `select i.status, i.credit_note_id = $2 as correct_note,
                i.cancelled_at = '2026-10-22T09:00:00Z'::timestamptz as correct_time,
                l.appointment_id, l.link_active
           from public.invoices i join public.invoice_lines l on l.invoice_id = i.id
          where i.id = $1`,
        [INVOICE_A, creditNoteId],
      );
    });
    expect(rows).toEqual([{
      status: "annullata", correct_note: true, correct_time: true,
      appointment_id: APPOINTMENT_A, link_active: false,
    }]);
  });

  it("uA non riattiva il legame della fattura annullata: 42501", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await cancelledInvoice(tx);
      await tx.query("update public.invoice_lines set link_active = false where id = $1", [INVOICE_LINE_A]);
      return tx.query("update public.invoice_lines set link_active = true where id = $1", [INVOICE_LINE_A]);
    }), "42501", LINK_MESSAGE);
  });

  it("uA non inserisce una riga TD04 attiva, anche in bozza: 23514", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await tx.query("update public.invoice_lines set link_active = false where id = $1", [INVOICE_LINE_A]);
      return creditLine(tx, await creditDraft(tx), true);
    }), "23514", CREDIT_LINE_MESSAGE);
  });

  it("uA inserisce la riga TD04 con link_active false: riga riletta", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      const lineId = await creditLine(tx, await creditDraft(tx), false);
      return tx.query("select appointment_id, link_active from public.invoice_lines where id = $1", [lineId]);
    });
    expect(rows).toEqual([{ appointment_id: APPOINTMENT_A, link_active: false }]);
  });

  it("uA non attiva con update una riga TD04 in bozza: 23514", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await tx.query("update public.invoice_lines set link_active = false where id = $1", [INVOICE_LINE_A]);
      const lineId = await creditLine(tx, await creditDraft(tx), false);
      return tx.query("update public.invoice_lines set link_active = true where id = $1", [lineId]);
    }), "23514", CREDIT_LINE_MESSAGE);
  });

  it("uA non trasforma in TD04 una bozza con una riga attiva: 23514", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      const otherId = idOf(await insertRow(tx, "invoices", invoiceDraft()));
      return tx.query("update public.invoices set doc_type = 'TD04', credited_invoice_id = $2 where id = $1", [INVOICE_A, otherId]);
    }), "23514", CREDIT_LINE_MESSAGE);
  });

  it("uA trasforma in TD04 una bozza con righe inattive: riga riletta", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      const otherId = idOf(await insertRow(tx, "invoices", invoiceDraft()));
      await tx.query("update public.invoice_lines set link_active = false where id = $1", [INVOICE_LINE_A]);
      await tx.query("update public.invoices set doc_type = 'TD04', credited_invoice_id = $2 where id = $1", [INVOICE_A, otherId]);
      return tx.query(
        `select i.doc_type, i.credited_invoice_id = $2 as correct_invoice, l.link_active
           from public.invoices i join public.invoice_lines l on l.invoice_id = i.id
          where i.id = $1`,
        [INVOICE_A, otherId],
      );
    });
    expect(rows).toEqual([{ doc_type: "TD04", correct_invoice: true, link_active: false }]);
  });

  it("uA non scrive credit_note_id prima di annullare la fattura: 42501", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await issueInvoice(tx, { invoiceId: INVOICE_A, issueDate: "2026-10-20" });
      const noteId = await creditDraft(tx);
      await issueInvoice(tx, { invoiceId: noteId, issueDate: "2026-10-22" });
      return tx.query("update public.invoices set credit_note_id = $2 where id = $1", [INVOICE_A, noteId]);
    }), "42501", /^La nota di credito collegata non cambia$/);
  });

  it("uA non cambia credit_note_id già scritto con un'altra TD04: 42501", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await cancelledInvoice(tx);
      const otherNoteId = await creditDraft(tx);
      await issueInvoice(tx, { invoiceId: otherNoteId, issueDate: "2026-10-22" });
      return tx.query("update public.invoices set credit_note_id = $2 where id = $1", [INVOICE_A, otherNoteId]);
    }), "42501", /^La nota di credito collegata non cambia$/);
  });

  it("uA non annulla con credit_note_id verso una TD01: 23514", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await issueInvoice(tx, { invoiceId: INVOICE_A, issueDate: "2026-10-20" });
      const otherId = idOf(await insertRow(tx, "invoices", invoiceDraft()));
      await issueInvoice(tx, { invoiceId: otherId, issueDate: "2026-10-22" });
      return cancelInvoice(tx, otherId);
    }), "23514", CREDIT_TARGET_MESSAGE);
  });

  it("uA non annulla con una TD04 ancora in bozza: 23514", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await issueInvoice(tx, { invoiceId: INVOICE_A, issueDate: "2026-10-20" });
      return cancelInvoice(tx, await creditDraft(tx));
    }), "23514", CREDIT_TARGET_MESSAGE);
  });

  it("uA non annulla con una TD04 pagata inserita direttamente: 23514", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await issueInvoice(tx, { invoiceId: INVOICE_A, issueDate: "2026-10-20" });
      // L'insert non attraversa invoices_immutable: isola il controllo sullo stato della nota collegata.
      const noteId = idOf(await insertRow(tx, "invoices", invoiceDraft({
        doc_type: "TD04", credited_invoice_id: INVOICE_A, status: "pagata",
        year: 2026, number: 90, number_label: "NC-90/2026", issue_date: "2026-10-22",
        snapshot: JSON.stringify({ numero: "NC-90/2026" }), paid_on: "2026-10-22",
      })));
      return cancelInvoice(tx, noteId);
    }), "23514", CREDIT_TARGET_MESSAGE);
  });

  it("uA non annulla con una TD04 che storna un'altra fattura: 23514", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await issueInvoice(tx, { invoiceId: INVOICE_A, issueDate: "2026-10-20" });
      const otherId = idOf(await insertRow(tx, "invoices", invoiceDraft()));
      const noteId = await creditDraft(tx, otherId);
      await issueInvoice(tx, { invoiceId: noteId, issueDate: "2026-10-22" });
      return cancelInvoice(tx, noteId);
    }), "23514", CREDIT_TARGET_MESSAGE);
  });

  it("uA non annulla senza credit_note_id: 42501", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await issueInvoice(tx, { invoiceId: INVOICE_A, issueDate: "2026-10-20" });
      return tx.query("update public.invoices set status = 'annullata', cancelled_at = '2026-10-22T09:00:00Z' where id = $1", [INVOICE_A]);
    }), "42501", /^Una fattura annullata vuole la sua nota di credito$/);
  });

  it("uA non porta una TD04 da bozza direttamente a pagata: 42501", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      const noteId = await creditDraft(tx);
      return issueInvoice(tx, { invoiceId: noteId, issueDate: "2026-10-22", paidOn: "2026-10-22" });
    }), "42501", /^Una nota di credito resta emessa$/);
  });

  it.each(["bozza", "pagata", "annullata"])("uA non porta una TD04 emessa a %s: 42501", async (status) => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      const noteId = await cancelledInvoice(tx);
      return tx.query("update public.invoices set status = $2, paid_on = '2026-10-22' where id = $1", [noteId, status]);
    }), "42501", /^Una nota di credito resta emessa$/);
  });

  it("uA non cambia paid_on di una fattura annullata: 42501", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await cancelledInvoice(tx);
      return tx.query("update public.invoices set paid_on = '2026-10-22' where id = $1", [INVOICE_A]);
    }), "42501", /^Una fattura annullata non cambia più$/);
  });

  it("uA cambia internal_notes di una fattura annullata: note rilette", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      await cancelledInvoice(tx);
      await tx.query("update public.invoices set internal_notes = 'Storno totale' where id = $1", [INVOICE_A]);
      return tx.query("select status, internal_notes from public.invoices where id = $1", [INVOICE_A]);
    });
    expect(rows).toEqual([{ status: "annullata", internal_notes: "Storno totale" }]);
  });

  it("uA imposta pdf_file_id da null su una fattura annullata: PDF riletto", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      await cancelledInvoice(tx);
      const before = await tx.query("select pdf_file_id from public.invoices where id = $1", [INVOICE_A]);
      expect(before).toEqual([{ pdf_file_id: null }]);
      await tx.query("update public.invoices set pdf_file_id = $2 where id = $1", [INVOICE_A, FILE_A]);
      return tx.query("select status, pdf_file_id from public.invoices where id = $1", [INVOICE_A]);
    });
    expect(rows).toEqual([{ status: "annullata", pdf_file_id: FILE_A }]);
  });

  it("uA non sostituisce il PDF di una fattura annullata: 42501", async () => {
    await expectPgError(inRollback(db, "A", async (tx) => {
      await cancelledInvoice(tx);
      const otherFileId = idOf(await insertRow(tx, "files", {
        id: "a0000000-0000-4000-8000-0000000000f2",
        practice_id: PRACTICE_A, kind: "invoice_pdf",
        storage_key: `${PRACTICE_A}/invoice_pdf/a0000000-0000-4000-8000-0000000000f2.pdf`,
        mime_type: "application/pdf", size_bytes: 4096, sha256: "d".repeat(64),
      }));
      await tx.query("update public.invoices set pdf_file_id = $2 where id = $1", [INVOICE_A, FILE_A]);
      return tx.query("update public.invoices set pdf_file_id = $2 where id = $1", [INVOICE_A, otherFileId]);
    }), "42501", /^Una fattura annullata non cambia più$/);
  });

  it("purga di A come servizio: credit_note_id torna null sulla fattura annullata", async () => {
    const rows = await inRollback(db, "service", async (tx) => {
      await cancelledInvoice(tx, true);
      await setPurge(tx, PRACTICE_A);
      await tx.query("update public.invoices set credit_note_id = null where id = $1", [INVOICE_A]);
      return tx.query("select status, credit_note_id from public.invoices where id = $1", [INVOICE_A]);
    });
    expect(rows).toEqual([{ status: "annullata", credit_note_id: null }]);
  });
});
