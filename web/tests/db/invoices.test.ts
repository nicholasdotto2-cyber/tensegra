import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, SqlParam, Tx } from "@/server/db/db";
import {
  APPOINTMENT_A,
  APPOINTMENT_B,
  BILLING_PARTY_A,
  BILLING_PARTY_B,
  FILE_A,
  FILE_B,
  GUARDIAN_A,
  GUARDIAN_B,
  INVOICE_A,
  INVOICE_B,
  INVOICE_LINE_A,
  invoiceDraft,
  issueInvoice,
  PATIENT_A1,
  PATIENT_A2,
  PATIENT_A3,
  PATIENT_B1,
  PRACTICE_A,
  PRACTICE_B,
  SERVICE_A,
  SERVICE_B,
  USER_A,
  USER_B,
} from "./fixtures";
import {
  asServiceFor,
  asUserA,
  asUserB,
  type Case,
  expectPgError,
  ident,
  idOf,
  inRollback,
  insertRow,
  inService,
  openTestDb,
  setPurge,
  type Values,
} from "./helpers";

// Vincoli, default e trigger delle fatture: billing_parties, invoices, invoice_lines,
// invoice_events e fiscal_exports. Nelle fixture A1 ha una fattura in bozza (INVOICE_A, forfettario, carta) con una
// riga sull'appuntamento del 5/10 (INVOICE_LINE_A) e l'evento della creazione. Questo file salva in `beforeAll`, per
// A e per B, una fattura emessa con una riga (numero da app.next_number, quindi come uA e come uB), e un PDF di A.
// Ogni test gira in una transazione che torna indietro; un caso che fallisce per transazione, con il codice Postgres
// esatto. La numerazione sta in numbering.test.ts.

let db: Db;
let pg: PGlite;

/** Una fattura emessa il 20/10/2026 con una riga senza appuntamento, salvata in `beforeAll`: nessun test la cambia. */
interface Issued {
  practiceId: string;
  invoiceId: string;
  lineId: string;
}
let issuedA: Issued;
let issuedB: Issued;

/** Un PDF di fattura di A, salvato in `beforeAll`: il PDF di una fattura emessa non passa a lui dopo FILE_A. */
const PDF_A = "a0000000-0000-4000-8000-0000000000f2";

/** La fotografia di una fattura inserita già emessa: una chiave sola, così il JSON riletto è lo stesso testo. */
const SNAPSHOT = JSON.stringify({ numero: "90/2026" });

/** Una fattura inserita già emessa, con numero, anno, etichetta, data e fotografia: la base dei check che valgono fuori dalla bozza. */
const issued = (extra: Values = {}): Values =>
  invoiceDraft({
    status: "emessa",
    year: 2026,
    number: 90,
    number_label: "90/2026",
    issue_date: "2026-10-20",
    snapshot: SNAPSHOT,
    ...extra,
  });

/** Una seduta da 60 euro senza appuntamento, in posizione 2 della bozza di A1 (la 1 è la riga della fixture). */
const line = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  invoice_id: INVOICE_A,
  line_number: 2,
  line_kind: "prestazione",
  description: "Seduta di osteopatia",
  quantity: 1,
  unit_price_cents: 6000,
  line_total_cents: 6000,
  vat_rate_bp: 0,
  nature: "N2.2",
  ...extra,
});

/** Una bozza da 60 euro con la sua riga, emessa il 20/10/2026: va chiamata come utente dello studio. */
async function createIssued(tx: Tx, practiceId: string, patientId: string): Promise<Issued> {
  const totals = { fees_cents: 6000, taxable_cents: 6000, total_cents: 6000, net_cents: 6000 };
  const invoiceId = idOf(await insertRow(tx, "invoices", invoiceDraft({ practice_id: practiceId, patient_id: patientId, ...totals })));
  const lineId = idOf(
    await insertRow(tx, "invoice_lines", line({ practice_id: practiceId, invoice_id: invoiceId, line_number: 1 })),
  );
  await issueInvoice(tx, { invoiceId, issueDate: "2026-10-20" });
  return { practiceId, invoiceId, lineId };
}

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  // Salvati nel clone di questo file (non nel modello delle fixture). app.next_number vuole lo studio
  // dell'utente: le fatture di A le emette uA, quelle di B uB.
  issuedA = await asUserA(db, (tx) => createIssued(tx, PRACTICE_A, PATIENT_A1));
  issuedB = await asUserB(db, (tx) => createIssued(tx, PRACTICE_B, PATIENT_B1));
  await asServiceFor(db, (tx) =>
    insertRow(tx, "files", {
      id: PDF_A,
      practice_id: PRACTICE_A,
      kind: "invoice_pdf",
      storage_key: `${PRACTICE_A}/invoice_pdf/${PDF_A}.pdf`,
      mime_type: "application/pdf",
      size_bytes: 4096,
      sha256: "d".repeat(64),
    }),
  );
});

afterAll(async () => {
  await pg?.close();
});

/** L'update di una colonna della fattura `invoiceId`, con returning: senza errore dà la riga aggiornata. */
function updateInvoice(tx: Tx, invoiceId: string, column: string, value: SqlParam): Promise<unknown[]> {
  return tx.query(`update public.invoices set ${ident(column)} = $2 where id = $1 returning id`, [invoiceId, value]);
}

/** Quante righe ha la fattura `invoiceId`, lette nella transazione `tx`. */
async function countLines(tx: Tx, invoiceId: string): Promise<number | undefined> {
  const [row] = await tx.query<{ n: number }>("select count(*)::int as n from public.invoice_lines where invoice_id = $1", [
    invoiceId,
  ]);
  return row?.n;
}

describe("public.invoices", () => {
  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "invoices", invoiceDraft()));
    expect(row).toMatchObject({
      doc_type: "TD01",
      status: "bozza",
      year: null,
      number: null,
      number_label: null,
      issue_date: null,
      guardian_id: null,
      billing_party_id: null,
      withholding_agent: false,
      surcharge_applied: false,
      withholding_applied: false,
      stamp_due: false,
      stamp_charged: false,
      fees_cents: 0,
      surcharge_cents: 0,
      taxable_cents: 0,
      vat_cents: 0,
      stamp_charged_cents: 0,
      total_cents: 0,
      withholding_cents: 0,
      net_cents: 0,
      due_date: null,
      paid_on: null,
      credited_invoice_id: null,
      credit_note_id: null,
      transmission_id: null,
      xml_file_name: null,
      snapshot: null,
      xml: null,
      xml_sha256: null,
      pdf_file_id: null,
      stamp_mark_code: null,
      internal_notes: null,
      issued_at: null,
      paid_at: null,
      cancelled_at: null,
    });
  });

  it.each<[label: string, values: Values]>([
    [
      "totale diverso da imponibile + IVA + bollo",
      invoiceDraft({ taxable_cents: 6000, stamp_charged_cents: 200, total_cents: 6000, net_cents: 6000 }),
    ],
    [
      "netto diverso da totale meno ritenuta",
      invoiceDraft({ taxable_cents: 6000, total_cents: 6000, withholding_cents: 1200, net_cents: 6000 }),
    ],
    ["TD04 senza credited_invoice_id", invoiceDraft({ doc_type: "TD04" })],
    ["committente senza billing_party_id", invoiceDraft({ recipient_kind: "committente" })],
    ["paziente senza patient_id", invoiceDraft({ patient_id: null })],
    ["tutore senza guardian_id", invoiceDraft({ recipient_kind: "tutore", patient_id: PATIENT_A3 })],
    ["bozza con number", invoiceDraft({ number: 5 })],
    ["emessa senza number", issued({ number: null })],
    ["bozza con snapshot", invoiceDraft({ snapshot: "{}" })],
    ['number_label "NC-/"', issued({ number_label: "NC-/" })],
    ['xml_sha256 "abc"', issued({ xml_sha256: "abc" })],
  ])("check della tabella: %s: 23514", async (_label, values) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "invoices", values)),
      "23514",
    );
  });

  // Controlli dei casi sopra: la stessa riga con il dato coerente entra.
  it.each<[label: string, values: Values]>([
    ["emessa con numero, anno, etichetta e data", issued()],
    [
      "totali coerenti, con bollo addebitato e ritenuta",
      invoiceDraft({
        fees_cents: 6000,
        taxable_cents: 6000,
        stamp_charged_cents: 200,
        total_cents: 6200,
        withholding_cents: 1200,
        net_cents: 5000,
      }),
    ],
    ["TD04 con credited_invoice_id", invoiceDraft({ doc_type: "TD04", credited_invoice_id: INVOICE_A })],
    [
      "committente con billing_party_id, senza paziente",
      invoiceDraft({ recipient_kind: "committente", patient_id: null, billing_party_id: BILLING_PARTY_A, withholding_agent: true }),
    ],
    ["tutore con guardian_id", invoiceDraft({ recipient_kind: "tutore", patient_id: PATIENT_A3, guardian_id: GUARDIAN_A })],
    ["bozza con paid_on: l'incasso può precedere l'emissione", invoiceDraft({ paid_on: "2026-10-05" })],
    ["pagata con paid_on", issued({ status: "pagata", paid_on: "2026-10-20" })],
    ["number_label di 20 caratteri con una cifra", issued({ number_label: `NC-${"9".repeat(17)}` })],
    ["xml_sha256 di 64 cifre esadecimali, con l'XML", issued({ xml: "<p:FatturaElettronica/>", xml_sha256: "a".repeat(64) })],
  ])("controllo: %s: accettata", async (_label, values) => {
    const row = await inService(db, (tx) => insertRow(tx, "invoices", values));
    // jsonb torna come oggetto: la fotografia si riscrive in JSON per confrontarla con il testo inserito.
    expect({ ...row, snapshot: JSON.stringify(row.snapshot) }).toMatchObject(values);
  });

  // Fuori dalla bozza c'è ciò che l'emissione scrive sempre: senza l'anno la unique (studio, tipo, anno,
  // numero) non vale, perché un null è sempre diverso da un altro; senza la data il check dell'anno passa lo stesso.
  it.each(["year", "issue_date", "number_label", "snapshot"])("emessa senza %s: 23514", async (column) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "invoices", issued({ [column]: null }))),
      "23514",
    );
  });

  it("emissione della bozza senza anno (update, uA): 23514", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) =>
        tx.query(
          `update public.invoices
              set status = 'emessa', number = 1, number_label = '1/2026', issue_date = '2026-10-20', snapshot = $2
            where id = $1`,
          [INVOICE_A, SNAPSHOT],
        ),
      ),
      "23514",
    );
  });

  // XML, progressivo dell'invio e nome del file mancano nell'esente verso persona fisica.
  it("controllo: emessa senza XML, progressivo e nome del file: accettata", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "invoices", issued()));
    expect(row).toMatchObject({ status: "emessa", xml: null, xml_sha256: null, transmission_id: null, xml_file_name: null });
  });

  // Tutto ciò che scrive l'emissione è null in bozza. snapshot è nei casi dei check sopra.
  it.each<Case>([
    ["year", 2026],
    ["number_label", "1/2026"],
    ["issue_date", "2026-10-20"],
    ["transmission_id", "00001"],
    ["xml_file_name", "IT01234567890_00001.xml"],
    ["xml", "<p:FatturaElettronica/>"],
    ["xml_sha256", "a".repeat(64)],
  ])("bozza con %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "invoices", invoiceDraft({ [column]: value }))),
      "23514",
    );
  });

  it.each<[label: string, values: Values]>([
    ["doc_type TD02", invoiceDraft({ doc_type: "TD02" })],
    ["status stornata", issued({ status: "stornata" })],
    ["regime minimi", invoiceDraft({ regime: "minimi" })],
    ["recipient_kind azienda", invoiceDraft({ recipient_kind: "azienda" })],
    ["payment_method assegno", invoiceDraft({ payment_method: "assegno" })],
    ["fees_cents negativo", invoiceDraft({ fees_cents: -1 })],
    ["surcharge_cents negativo", invoiceDraft({ surcharge_cents: -1 })],
    ["vat_cents negativo, con i totali coerenti", invoiceDraft({ taxable_cents: 1000, vat_cents: -100, total_cents: 900, net_cents: 900 })],
    ["number 0", issued({ number: 0 })],
    ["transmission_id di 6 caratteri", issued({ transmission_id: "ABCDEF" })],
    ["transmission_id con un trattino", issued({ transmission_id: "0-1" })],
    ["number_label di 21 caratteri", issued({ number_label: "9".repeat(21) })],
    ["stamp_mark_code di 31 caratteri", invoiceDraft({ stamp_mark_code: "a".repeat(31) })],
    ["pagata senza paid_on", issued({ status: "pagata" })],
  ])("valore fuori formato: %s: 23514", async (_label, values) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "invoices", values)),
      "23514",
    );
  });

  it.each<Case>([
    ["guardian_id", GUARDIAN_B],
    ["billing_party_id", BILLING_PARTY_B],
    ["credited_invoice_id", INVOICE_B],
    ["credit_note_id", INVOICE_B],
    ["pdf_file_id", FILE_B],
  ])("%s di un altro studio: 23503", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "invoices", invoiceDraft({ [column]: value }))),
      "23503",
    );
  });

  // La delete attraversa la chiave `cascade` e il trigger di guardia delle righe.
  it("bozza con due righe: uA la cancella e le righe spariscono", async () => {
    const { invoiceId, before, deleted, after } = await inRollback(db, "A", async (tx) => {
      const invoiceId = idOf(await insertRow(tx, "invoices", invoiceDraft()));
      await insertRow(tx, "invoice_lines", line({ invoice_id: invoiceId, line_number: 1 }));
      await insertRow(tx, "invoice_lines", line({ invoice_id: invoiceId, line_number: 2 }));
      const before = await countLines(tx, invoiceId);
      const deleted = await tx.query("delete from public.invoices where id = $1 returning id", [invoiceId]);
      return { invoiceId, before, deleted, after: await countLines(tx, invoiceId) };
    });
    expect(before).toBe(2);
    expect(deleted).toEqual([{ id: invoiceId }]);
    expect(after).toBe(0);
  });

  // Una bozza vera ha già la sua cronologia ("bozza: tutto modificabile e cancellabile"). La chiave degli
  // eventi è `cascade` come quella delle righe: uA non ha la policy D sugli eventi, e con `restrict` la delete
  // verrebbe fermata dalla chiave (23001 o 23503).
  it("la bozza della fixture: uA la cancella, e con lei la riga e l'evento della creazione", async () => {
    const counts = async (tx: Tx) => {
      const [row] = await tx.query<{ invoices: number; lines: number; events: number }>(
        `select (select count(*)::int from public.invoices where id = $1) as invoices,
                (select count(*)::int from public.invoice_lines where invoice_id = $1) as lines,
                (select count(*)::int from public.invoice_events where invoice_id = $1) as events`,
        [INVOICE_A],
      );
      return row;
    };
    const { before, deleted, after } = await inRollback(db, "A", async (tx) => {
      const before = await counts(tx);
      const deleted = await tx.query("delete from public.invoices where id = $1 returning id", [INVOICE_A]);
      return { before, deleted, after: await counts(tx) };
    });
    expect(before).toEqual({ invoices: 1, lines: 1, events: 1 });
    expect(deleted).toEqual([{ id: INVOICE_A }]);
    expect(after).toEqual({ invoices: 0, lines: 0, events: 0 });
  });
});

type Status = "bozza" | "emessa" | "pagata" | "annullata";

/** Le colonne che un update scrive per portare una fattura già emessa allo stato dato. */
const SET_STATUS: Record<Status, string> = {
  bozza: "status = 'bozza'",
  emessa: "status = 'emessa'",
  pagata: "status = 'pagata', paid_on = '2026-10-21', paid_at = '2026-10-21T09:00:00Z', payment_method = 'contanti'",
  annullata: "status = 'annullata', cancelled_at = '2026-10-22T09:00:00Z'",
};

/** Una fattura di A nello stato dato, nella transazione `tx`: la bozza della fixture o la fattura emessa di `beforeAll`. */
async function invoiceIn(tx: Tx, status: Status): Promise<string> {
  if (status === "bozza") return INVOICE_A;
  if (status === "annullata") {
    const creditNoteId = idOf(
      await insertRow(tx, "invoices", invoiceDraft({ doc_type: "TD04", credited_invoice_id: issuedA.invoiceId })),
    );
    await issueInvoice(tx, { invoiceId: creditNoteId, issueDate: "2026-10-22" });
    await tx.query(`update public.invoices set ${SET_STATUS[status]}, credit_note_id = $2 where id = $1`, [
      issuedA.invoiceId,
      creditNoteId,
    ]);
  } else if (status !== "emessa") {
    await tx.query(`update public.invoices set ${SET_STATUS[status]} where id = $1`, [issuedA.invoiceId]);
  }
  return issuedA.invoiceId;
}

describe("fattura emessa (invoices_immutable)", () => {
  it.each<Case>([
    ["fees_cents", 6500],
    ["number", 91],
    ["number_label", "91/2026"],
    ["issue_date", "2026-10-19"],
    ["issued_at", "2026-10-19T09:00:00Z"],
    ["snapshot", '{"numero": "91/2026"}'],
    ["patient_id", PATIENT_A2],
    ["regime", "ordinario"],
    ["stamp_mark_code", "01234567890123"],
  ])("update di %s = %j (uA): 42501", async (column, value) => {
    await expectPgError(
      inRollback(db, "A", (tx) => updateInvoice(tx, issuedA.invoiceId, column, value)),
      "42501",
    );
  });

  // I trigger scattano anche per il superutente: BYPASSRLS salta le policy, non i trigger.
  it("delete come servizio: 42501", async () => {
    await expectPgError(
      inRollback(db, "service", (tx) => tx.query("delete from public.invoices where id = $1", [issuedA.invoiceId])),
      "42501",
    );
  });

  // La chiave degli eventi è `cascade`: il trigger scatta prima, quindi una fattura emessa non perde la cronologia.
  it("delete come servizio di una fattura emessa con un evento: 42501", async () => {
    await expectPgError(
      inRollback(db, "service", async (tx) => {
        await insertRow(tx, "invoice_events", {
          practice_id: PRACTICE_A,
          invoice_id: issuedA.invoiceId,
          event_type: "emessa",
          at: "2026-10-20T09:00:00Z",
        });
        return tx.query("delete from public.invoices where id = $1", [issuedA.invoiceId]);
      }),
      "42501",
    );
  });

  // La policy D di uA vede solo le bozze: la delete non arriva nemmeno al trigger.
  it("delete di uA: 0 righe, la fattura resta", async () => {
    const { deleted, left } = await inRollback(db, "A", async (tx) => {
      const deleted = await tx.query("delete from public.invoices where id = $1 returning id", [issuedA.invoiceId]);
      const [left] = await tx.query<{ n: number }>("select count(*)::int as n from public.invoices where id = $1", [
        issuedA.invoiceId,
      ]);
      return { deleted, left: left?.n };
    });
    expect(deleted).toEqual([]);
    expect(left).toBe(1);
  });

  it("internal_notes passa (uA)", async () => {
    const rows = await inRollback(db, "A", (tx) =>
      tx.query("update public.invoices set internal_notes = $2 where id = $1 returning internal_notes", [
        issuedA.invoiceId,
        "Ritirata in studio",
      ]),
    );
    expect(rows).toEqual([{ internal_notes: "Ritirata in studio" }]);
  });

  it("controllo: i campi congelati riscritti uguali passano, con le note interne (uA)", async () => {
    const rows = await inRollback(db, "A", (tx) =>
      tx.query(
        `update public.invoices
            set fees_cents = fees_cents, number = number, snapshot = snapshot, issue_date = issue_date, internal_notes = $2
          where id = $1 returning internal_notes`,
        [issuedA.invoiceId, "Ritirata in studio"],
      ),
    );
    expect(rows).toEqual([{ internal_notes: "Ritirata in studio" }]);
  });

  it("incasso: status pagata, paid_on, paid_at, payment_method passa (uA)", async () => {
    const rows = await inRollback(db, "A", (tx) =>
      tx.query(
        `update public.invoices
            set status = 'pagata', paid_on = '2026-10-21', paid_at = '2026-10-21T09:00:00Z', payment_method = 'contanti'
          where id = $1 returning status, paid_on, payment_method`,
        [issuedA.invoiceId],
      ),
    );
    expect(rows).toEqual([{ status: "pagata", paid_on: "2026-10-21", payment_method: "contanti" }]);
  });

  it("pagata → emessa (incasso annullato) passa (uA)", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      const invoiceId = await invoiceIn(tx, "pagata");
      return tx.query(
        "update public.invoices set status = 'emessa', paid_on = null, paid_at = null where id = $1 returning status, paid_on",
        [invoiceId],
      );
    });
    expect(rows).toEqual([{ status: "emessa", paid_on: null }]);
  });

  // La fattura si annulla solo con la nota di credito già emessa.
  it.each<Status>(["emessa", "pagata"])("%s → annullata, con la nota di credito e cancelled_at, passa (uA)", async (from) => {
    const { creditNoteId, rows } = await inRollback(db, "A", async (tx) => {
      const invoiceId = await invoiceIn(tx, from);
      const creditNoteId = idOf(
        await insertRow(tx, "invoices", invoiceDraft({ doc_type: "TD04", credited_invoice_id: invoiceId })),
      );
      await issueInvoice(tx, { invoiceId: creditNoteId, issueDate: "2026-10-22" });
      const rows = await tx.query(
        `update public.invoices set status = 'annullata', credit_note_id = $2, cancelled_at = '2026-10-22T09:00:00Z'
          where id = $1 returning status, credit_note_id`,
        [invoiceId, creditNoteId],
      );
      return { creditNoteId, rows };
    });
    expect(rows).toEqual([{ status: "annullata", credit_note_id: creditNoteId }]);
  });

  it("emissione già incassata: bozza → pagata passa (uA)", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      const invoiceId = idOf(await insertRow(tx, "invoices", invoiceDraft()));
      await issueInvoice(tx, { invoiceId, issueDate: "2026-10-20", paidOn: "2026-10-20" });
      return tx.query("select status, paid_on from public.invoices where id = $1", [invoiceId]);
    });
    expect(rows).toEqual([{ status: "pagata", paid_on: "2026-10-20" }]);
  });

  it.each<[from: Status, to: Status]>([
    ["emessa", "bozza"],
    ["annullata", "emessa"],
    ["bozza", "annullata"],
    ["pagata", "bozza"],
    ["annullata", "bozza"],
    ["annullata", "pagata"],
  ])("transizione vietata %s → %s (uA): 42501", async (from, to) => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        const invoiceId = await invoiceIn(tx, from);
        return tx.query(`update public.invoices set ${SET_STATUS[to]} where id = $1 returning id`, [invoiceId]);
      }),
      "42501",
    );
  });
});

describe("PDF della fattura (pdf_file_id)", () => {
  const SET_PDF = "update public.invoices set pdf_file_id = $2 where id = $1 returning pdf_file_id";

  it("da null a FILE_A passa (uA)", async () => {
    const rows = await inRollback(db, "A", (tx) => tx.query(SET_PDF, [issuedA.invoiceId, FILE_A]));
    expect(rows).toEqual([{ pdf_file_id: FILE_A }]);
  });

  it("poi a un altro file (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await tx.query(SET_PDF, [issuedA.invoiceId, FILE_A]);
        return tx.query(SET_PDF, [issuedA.invoiceId, PDF_A]);
      }),
      "42501",
    );
  });

  it("poi di nuovo a null (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await tx.query(SET_PDF, [issuedA.invoiceId, FILE_A]);
        return tx.query(SET_PDF, [issuedA.invoiceId, null]);
      }),
      "42501",
    );
  });

  it("controllo: poi lo stesso file riscritto passa (uA)", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      await tx.query(SET_PDF, [issuedA.invoiceId, FILE_A]);
      return tx.query(SET_PDF, [issuedA.invoiceId, FILE_A]);
    });
    expect(rows).toEqual([{ pdf_file_id: FILE_A }]);
  });
});

type Write = "insert" | "update" | "delete";
const WRITES: Write[] = ["insert", "update", "delete"];

/** Una scrittura sulle righe della fattura emessa `target`, con returning: l'insert prende la posizione 2. */
function frozenLineWrite(tx: Tx, write: Write, target: Issued): Promise<unknown[]> {
  switch (write) {
    case "insert":
      return tx.query(
        `insert into public.invoice_lines (practice_id, invoice_id, line_number, line_kind, description, quantity,
                                           unit_price_cents, line_total_cents, vat_rate_bp, nature)
         values ($1, $2, 2, 'prestazione', 'Seduta di osteopatia', 1, 6000, 6000, 0, 'N2.2') returning id`,
        [target.practiceId, target.invoiceId],
      );
    case "update":
      return tx.query("update public.invoice_lines set description = 'Seduta del 20/10' where id = $1 returning id", [
        target.lineId,
      ]);
    case "delete":
      return tx.query("delete from public.invoice_lines where id = $1 returning id", [target.lineId]);
  }
}

describe("righe di una fattura emessa (invoice_lines_guard)", () => {
  it.each(WRITES)("%s come uA: 42501", async (write) => {
    await expectPgError(
      inRollback(db, "A", (tx) => frozenLineWrite(tx, write, issuedA)),
      "42501",
    );
  });

  it.each(WRITES)("%s come servizio senza purga: 42501", async (write) => {
    await expectPgError(
      inRollback(db, "service", (tx) => frozenLineWrite(tx, write, issuedA)),
      "42501",
    );
  });

  it("link_active a false su una fattura emessa non annullata (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) =>
        tx.query("update public.invoice_lines set link_active = false where id = $1 returning link_active", [
          issuedA.lineId,
        ]),
      ),
      "42501",
      /^Il legame con l'appuntamento cambia solo quando la fattura è annullata$/,
    );
  });

  it("spostare una riga dalla bozza alla fattura emessa: 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) =>
        tx.query("update public.invoice_lines set invoice_id = $1, line_number = 2 where id = $2", [
          issuedA.invoiceId,
          INVOICE_LINE_A,
        ]),
      ),
      "42501",
    );
  });

  it("spostare una riga dalla fattura emessa alla bozza: 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) =>
        tx.query("update public.invoice_lines set invoice_id = $1, line_number = 2 where id = $2", [
          INVOICE_A,
          issuedA.lineId,
        ]),
      ),
      "42501",
    );
  });
});

describe("public.invoice_lines", () => {
  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "invoice_lines", line()));
    expect(row).toMatchObject({
      service_id: null,
      appointment_id: null,
      link_active: true,
      service_date: null,
      subject_to_withholding: false,
    });
  });

  it.each<[label: string, values: Values]>([
    ["line_total_cents diverso da quantità per prezzo", line({ quantity: 2 })],
    ["vat_rate_bp 0 senza nature", line({ nature: null })],
    ["vat_rate_bp 2200 con nature N2.2", line({ vat_rate_bp: 2200 })],
    ["line_number 0", line({ line_number: 0 })],
    ["line_number 10000", line({ line_number: 10000 })],
    ["line_kind sconto", line({ line_kind: "sconto" })],
    ["description vuota", line({ description: "" })],
    ["description di soli spazi", line({ description: "   " })],
    ["description di 1001 caratteri", line({ description: "a".repeat(1001) })],
    ["quantity 0", line({ quantity: 0, line_total_cents: 0 })],
    ["unit_price_cents negativo", line({ unit_price_cents: -100, line_total_cents: -100 })],
    ["vat_rate_bp 10001", line({ vat_rate_bp: 10001, nature: null })],
    ["nature N1", line({ nature: "N1" })],
  ])("%s: 23514", async (_label, values) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "invoice_lines", values)),
      "23514",
    );
  });

  it.each<[label: string, values: Values]>([
    ["due sedute: 2 per 6000 fa 12000", line({ quantity: 2, line_total_cents: 12000 })],
    ["IVA al 22% senza natura (ordinario)", line({ vat_rate_bp: 2200, nature: null })],
    ["esente con natura N4", line({ nature: "N4" })],
    [
      "rimborso del bollo",
      line({ line_kind: "rimborso_bollo", description: "Rimborso imposta di bollo", unit_price_cents: 200, line_total_cents: 200 }),
    ],
    ["line_number 9999 e description di 1000 caratteri", line({ line_number: 9999, description: "a".repeat(1000) })],
    [
      "con la voce di listino, la data della seduta e la ritenuta",
      line({ service_id: SERVICE_A, service_date: "2026-10-05", subject_to_withholding: true }),
    ],
  ])("controllo: %s: accettata", async (_label, values) => {
    const row = await inService(db, (tx) => insertRow(tx, "invoice_lines", values));
    expect(row).toMatchObject(values);
  });

  it("stessa line_number due volte nella stessa fattura: 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "invoice_lines", line({ line_number: 1 }))),
      "23505",
    );
  });

  it.each<Case>([
    ["service_id", SERVICE_B],
    ["appointment_id", APPOINTMENT_B],
  ])("%s di un altro studio: 23503", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "invoice_lines", line({ [column]: value }))),
      "23503",
    );
  });

});

// INVOICE_LINE_A fattura già APPOINTMENT_A, attiva: l'indice parziale su link_active.
describe("un appuntamento si fattura una volta", () => {
  /** Una seconda bozza di A1 con una riga su APPOINTMENT_A. */
  async function billAppointmentAgain(tx: Tx): Promise<Record<string, unknown>> {
    const otherId = idOf(await insertRow(tx, "invoices", invoiceDraft()));
    return insertRow(tx, "invoice_lines", line({ invoice_id: otherId, line_number: 1, appointment_id: APPOINTMENT_A }));
  }

  it("seconda riga attiva sullo stesso appuntamento in un'altra fattura: 23505", async () => {
    await expectPgError(inRollback(db, "A", billAppointmentAgain), "23505");
  });

  it("con link_active = false sulla prima, la seconda passa", async () => {
    const row = await inRollback(db, "A", async (tx) => {
      await tx.query("update public.invoice_lines set link_active = false where id = $1", [INVOICE_LINE_A]);
      return billAppointmentAgain(tx);
    });
    expect(row).toMatchObject({ appointment_id: APPOINTMENT_A, link_active: true });
  });
});

describe("public.invoice_events", () => {
  const INSERT_EVENT = `insert into public.invoice_events (practice_id, invoice_id, event_type, at, user_id, created_by)
                        values ($1, $2, 'modificata', '2026-10-21T09:00:00Z', $3, $3)
                        returning user_id, created_by`;

  // app.set_created_by ridefinita scrive anche user_id, e solo su questa tabella.
  it("user_id e created_by sono USER_A anche se uA passa USER_B; come servizio null", async () => {
    const byUser = await inRollback(db, "A", (tx) => tx.query(INSERT_EVENT, [PRACTICE_A, INVOICE_A, USER_B]));
    expect(byUser).toEqual([{ user_id: USER_A, created_by: USER_A }]);
    const byService = await inRollback(db, "service", (tx) => tx.query(INSERT_EVENT, [PRACTICE_A, INVOICE_A, USER_A]));
    expect(byService).toEqual([{ user_id: null, created_by: null }]);
  });

  it.each([
    "creata",
    "modificata",
    "emessa",
    "pagamento_registrato",
    "pagamento_annullato",
    "annullata",
    "pdf_scaricato",
    "xml_scaricato",
    "export_ese",
  ])("event_type %s: accettato", async (eventType) => {
    const row = await inService(db, (tx) =>
      insertRow(tx, "invoice_events", {
        practice_id: PRACTICE_A,
        invoice_id: INVOICE_A,
        event_type: eventType,
        at: "2026-10-21T09:00:00Z",
      }),
    );
    expect(row).toMatchObject({ event_type: eventType, details: null });
  });

  it("event_type fuori dalla lista: 23514", async () => {
    await expectPgError(
      inService(db, (tx) =>
        insertRow(tx, "invoice_events", {
          practice_id: PRACTICE_A,
          invoice_id: INVOICE_A,
          event_type: "inviata",
          at: "2026-10-21T09:00:00Z",
        }),
      ),
      "23514",
    );
  });
});

describe("public.billing_parties", () => {
  /** Una società sportiva di Bologna con la partita IVA. */
  const party = (extra: Values = {}): Values => ({
    practice_id: PRACTICE_A,
    name: "ASD Basket Esempio",
    vat_number: "02345678901",
    address_line: "Via dello Sport 2",
    postal_code: "40129",
    city: "Bologna",
    province: "BO",
    ...extra,
  });

  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "billing_parties", party()));
    expect(row).toMatchObject({
      tax_code: null,
      country: "IT",
      recipient_code: "0000000",
      pec: null,
      is_withholding_agent: true,
      archived_at: null,
    });
  });

  it("senza vat_number né tax_code: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "billing_parties", party({ vat_number: null }))),
      "23514",
    );
  });

  it("controllo: con il solo tax_code: accettato", async () => {
    const row = await inService(db, (tx) =>
      insertRow(tx, "billing_parties", party({ vat_number: null, tax_code: "91234567890" })),
    );
    expect(row).toMatchObject({ vat_number: null, tax_code: "91234567890" });
  });

  it.each<Case>([
    ["recipient_code", "abc"],
    ["recipient_code", "m5uxcr1"],
    ["vat_number", "1234567890"],
    ["name", "a".repeat(81)],
    ["address_line", "a".repeat(61)],
    ["postal_code", "4012"],
    ["city", "a".repeat(61)],
    ["province", "bo"],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "billing_parties", party({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["recipient_code", "M5UXCR1"],
    ["name", "a".repeat(80)],
    ["address_line", "a".repeat(60)],
    ["city", "a".repeat(60)],
    ["pec", "amministrazione@pec.example.test"],
    ["is_withholding_agent", false],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "billing_parties", party({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  // app.set_created_by ridefinita su una tabella senza user_id: il ramo di invoice_events non scatta.
  it("created_by lo scrive il trigger: uA che passa USER_B ottiene USER_A", async () => {
    const row = await inRollback(db, "A", (tx) => insertRow(tx, "billing_parties", party({ created_by: USER_B })));
    expect(row.created_by).toBe(USER_A);
  });
});

// Contratto di purga, per i due trigger: (a) il servizio con la purga di A scrive una riga
// congelata di A; (b) con la purga di A, la stessa scrittura su una riga congelata di B dà 42501; (c) uA con la
// purga di A resta fermo sulla riga di A.
describe("uscita di purga", () => {
  type FrozenWrite = [label: string, write: (tx: Tx, target: Issued) => Promise<unknown[]>];
  const DELETE_ISSUED: FrozenWrite = [
    "delete di una fattura emessa con le sue righe",
    (tx, target) => tx.query("delete from public.invoices where id = $1 returning id", [target.invoiceId]),
  ];
  const FROZEN_WRITES: FrozenWrite[] = [
    DELETE_ISSUED,
    ["update di fees_cents di una fattura emessa", (tx, target) => updateInvoice(tx, target.invoiceId, "fees_cents", 6500)],
    [
      "delete di una riga di una fattura emessa",
      (tx, target) => tx.query("delete from public.invoice_lines where id = $1 returning id", [target.lineId]),
    ],
  ];

  it.each(FROZEN_WRITES)("(a) servizio con la purga di A: %s di A passa", async (_label, write) => {
    const rows = await inRollback(db, "service", async (tx) => {
      await setPurge(tx, PRACTICE_A);
      return write(tx, issuedA);
    });
    expect(rows).toHaveLength(1);
  });

  it("(a) la fattura emessa di A cancellata con la purga porta via le sue righe", async () => {
    const after = await inRollback(db, "service", async (tx) => {
      await setPurge(tx, PRACTICE_A);
      await DELETE_ISSUED[1](tx, issuedA);
      return countLines(tx, issuedA.invoiceId);
    });
    expect(after).toBe(0);
  });

  it.each(FROZEN_WRITES)("(b) servizio con la purga di A: %s di B: 42501", async (_label, write) => {
    await expectPgError(
      inRollback(db, "service", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return write(tx, issuedB);
      }),
      "42501",
    );
  });

  it.each(FROZEN_WRITES.slice(1))("(c) uA con la purga di A: %s di A: 42501", async (_label, write) => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return write(tx, issuedA);
      }),
      "42501",
    );
  });

  // La policy D di uA vede solo le bozze, quindi la delete di una fattura emessa non arriva al trigger: il caso (c)
  // della delete tocca 0 righe invece di dare 42501. Il trigger resta chiuso per uA nei due casi (c) sopra.
  it("(c) uA con la purga di A: la delete della fattura emessa di A tocca 0 righe, fattura e righe restano", async () => {
    const { deleted, lines } = await inRollback(db, "A", async (tx) => {
      await setPurge(tx, PRACTICE_A);
      const deleted = await DELETE_ISSUED[1](tx, issuedA);
      return { deleted, lines: await countLines(tx, issuedA.invoiceId) };
    });
    expect(deleted).toEqual([]);
    expect(lines).toBe(1);
  });

  // Un update esce solo se la riga resta nello studio della purga: la purga di A non porta una riga della bozza di A
  // dentro la fattura emessa di B, e non porta a B la fattura emessa di A.
  type MoveToB = [label: string, move: (tx: Tx) => Promise<unknown[]>];
  const MOVES_TO_B: MoveToB[] = [
    [
      "una riga della bozza di A nella fattura emessa di B",
      async (tx) => {
        const lineId = idOf(await insertRow(tx, "invoice_lines", line()));
        await setPurge(tx, PRACTICE_A);
        return tx.query("update public.invoice_lines set practice_id = $1, invoice_id = $2 where id = $3 returning id", [
          PRACTICE_B,
          issuedB.invoiceId,
          lineId,
        ]);
      },
    ],
    [
      "la fattura emessa di A",
      async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return updateInvoice(tx, issuedA.invoiceId, "practice_id", PRACTICE_B);
      },
    ],
  ];

  it.each(MOVES_TO_B)("(b) servizio con la purga di A: spostare su B %s: 42501", async (_label, move) => {
    await expectPgError(inRollback(db, "service", move), "42501");
  });

  // Fattura annullata e nota di credito si puntano a vicenda, e la purga stacca la nota prima
  // delle delete. La nota di credito è emessa con un numero scelto a mano: come servizio app.next_number dà 42501.
  it("passo 2: il servizio con la purga di A toglie credit_note_id da una fattura annullata di A", async () => {
    const rows = await inRollback(db, "service", async (tx) => {
      const creditNoteId = idOf(
        await insertRow(tx, "invoices", invoiceDraft({ doc_type: "TD04", credited_invoice_id: issuedA.invoiceId })),
      );
      await issueInvoice(tx, { invoiceId: creditNoteId, issueDate: "2026-10-22", number: 1 });
      await tx.query(
        `update public.invoices set status = 'annullata', credit_note_id = $2, cancelled_at = '2026-10-22T09:00:00Z'
          where id = $1`,
        [issuedA.invoiceId, creditNoteId],
      );
      await setPurge(tx, PRACTICE_A);
      await tx.query("update public.invoices set credit_note_id = null where practice_id = $1", [PRACTICE_A]);
      return tx.query("select status, credit_note_id from public.invoices where id = $1", [issuedA.invoiceId]);
    });
    expect(rows).toEqual([{ status: "annullata", credit_note_id: null }]);
  });
});
