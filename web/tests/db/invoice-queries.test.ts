import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseInvoiceListParams } from "@/lib/fiscal/list-params";
import { DEMO_PRACTICE_ID, getActor } from "@/server/auth/actor";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { switchToUser } from "@/server/db/service";
import {
  countDrafts, getInvoiceDetail, getInvoiceEditor, getMonthTiles, invoiceOfAppointment,
  listDrafts, listInvoices, listPatientInvoices, listToInvoice, peekNextNumber,
} from "@/server/domain/invoices/queries";
import { issueInvoice } from "@/server/domain/invoices/commands";
import { seedDemo } from "../../seed/demo";
import { asUserB, inService, openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

const P = DEMO_PRACTICE_ID;
const clock = fixedClock("2026-11-04T07:00:00+01:00");
const october = { anno: 2026, mese: "2026-10", stato: "tutte" as const, q: "" };
let db: Db;
let pg: PGlite;
const asDemo = <T>(fn: (tx: Tx) => Promise<T>) => db.asUser(getActor(), fn);

const asDemoRollback = <T>(fn: (tx: Tx) => Promise<T>) => asDemo(async (tx) => {
  await tx.query("savepoint editor_test");
  try {
    return await fn(tx);
  } finally {
    await tx.query("rollback to savepoint editor_test");
  }
});

async function appointment(tx: Tx, firstName: string) {
  const [row] = await tx.query<{ id: string; patientId: string }>(
    `select a.id, a.patient_id as "patientId" from public.appointments a
       join public.patients p on p.practice_id = a.practice_id and p.id = a.patient_id
      where a.practice_id = $1 and p.first_name = $2 order by a.starts_at limit 1`, [P, firstName],
  );
  expect(row).toBeDefined();
  return row!;
}

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  await seedDemo(db, clock, new MemoryFileStore());
});
afterAll(async () => { await pg?.close(); });

describe("letture delle fatture sul seed della demo", () => {
  it("E1 prepara i problemi del bonifico anche per nuovo editor, seduta e bozza caricati con carta", async () => {
    await asDemoRollback(async (tx) => {
      await tx.query("update public.fiscal_settings set default_payment_method = 'carta', iban = null where practice_id = $1", [P]);
      const matteo = await appointment(tx, "Matteo");
      await tx.query("update public.appointments set payment_method = 'carta' where practice_id = $1 and id = $2", [P, matteo.id]);
      const [draft] = await listDrafts(tx, P);
      await tx.query("update public.invoices set payment_method = 'carta' where practice_id = $1 and id = $2", [P, draft!.id]);
      const starts = [{ kind: "new" } as const, { kind: "appointment", appointmentId: matteo.id } as const,
        { kind: "draft", invoiceId: draft!.id } as const];
      for (const start of starts) {
        const view = await getInvoiceEditor(tx, P, clock, start);
        expect(view?.problems).toContainEqual({
          field: "payment.iban", message: "Per il bonifico serve l'IBAN dello studio: completalo in Impostazioni, Fisco.", href: "/impostazioni/fisco",
        });
      }
    });
  });

  it("iban_non_nasconde_00471: la vista ha bonifico e 00471, l'emissione con carta rifiuta senza consumare il numero", async () => {
    await asDemoRollback(async (tx) => {
      const [draft] = await listDrafts(tx, P);
      await tx.query("update public.fiscal_settings set iban = null where practice_id = $1", [P]);
      await tx.query(`update public.billing_parties set vat_number = (select vat_number from public.fiscal_settings where practice_id = $1)
        where practice_id = $1 and id = (select billing_party_id from public.invoices where practice_id = $1 and id = $2)`, [P, draft!.id]);
      const view = await getInvoiceEditor(tx, P, clock, { kind: "draft", invoiceId: draft!.id });
      expect(view?.draft?.paymentMethod).toBe("bonifico");
      expect(view?.problems).toContainEqual({
        field: "payment.iban", message: "Per il bonifico serve l'IBAN dello studio: completalo in Impostazioni, Fisco.", href: "/impostazioni/fisco",
      });
      const sdi = { field: "sdi.00471", message: "Controllo SdI 00471: cedente e cessionario con la stessa partita IVA", href: null };
      expect(view?.problems).toContainEqual(sdi);
      expect(view?.problems.filter((p) => p.field === sdi.field)).toHaveLength(1);
      // Il comando di emissione resta com'era: rifiuta prima di consumare il numero.
      await tx.query("update public.invoices set payment_method = 'carta' where practice_id = $1 and id = $2", [P, draft!.id]);
      await expect(issueInvoice(tx, P, clock, { invoiceId: draft!.id })).rejects.toThrow(sdi.message);
      expect(await peekNextNumber(tx, P, "TD01", 2026)).toBe(view?.nextNumber);
    });
  });

  it("il nuovo editor usa il metodo dello studio, senza sovrascrivere bozze o sedute", async () => {
    await asDemoRollback(async (tx) => {
      for (const method of ["carta", "bonifico", "contanti"]) {
        await tx.query("update public.fiscal_settings set default_payment_method = $2 where practice_id = $1", [P, method]);
        expect(await getInvoiceEditor(tx, P, clock, { kind: "new" })).toMatchObject({ defaultPaymentMethod: method });
      }
      const [draft] = await listDrafts(tx, P);
      expect((await getInvoiceEditor(tx, P, clock, { kind: "draft", invoiceId: draft!.id }))?.draft?.paymentMethod).toBe("bonifico");
      const matteo = await appointment(tx, "Matteo");
      await tx.query("update public.appointments set payment_method = 'carta' where practice_id = $1 and id = $2", [P, matteo.id]);
      expect((await getInvoiceEditor(tx, P, clock, { kind: "appointment", appointmentId: matteo.id }))?.prefill?.paymentMethod).toBe("carta");
    });
  });

  it("senza impostazioni di pagamento il nuovo editor mantiene Contanti", async () => {
    await inService(db, async (tx) => {
      // La RLS non permette DELETE alle impostazioni: prepara l'assenza come servizio,
      // poi legge con l'identità demo e i suoi privilegi reali.
      expect(await tx.query("delete from public.fiscal_settings where practice_id = $1 returning practice_id", [P])).toHaveLength(1);
      await switchToUser(tx, getActor());
      expect(await getInvoiceEditor(tx, P, clock, { kind: "new" })).toMatchObject({ defaultPaymentMethod: "contanti" });
    });
  });

  it("ignora parametri non validi e legge anno, mese, tab, stato e ricerca", () => {
    expect(parseInvoiceListParams({ tab: "sbagliata", anno: "2026x", mese: "2026-13", stato: ["pagate"], q: ["x"] }, clock.today()))
      .toEqual({ tab: "emesse", anno: 2026, mese: "2026-11", stato: "tutte", q: "" });
    expect(parseInvoiceListParams({ tab: "bozze", anno: "2025", mese: "2025-02", stato: "pagate", q: " Bellandi " }, clock.today()))
      .toEqual({ tab: "bozze", anno: 2025, mese: "2025-02", stato: "pagate", q: "Bellandi" });
  });

  it("ottobre mostra la prima visita di Marco e Lorenzo annullata con la nota", async () => {
    await asDemo(async (tx) => {
      const rows = await listInvoices(tx, P, october);
      expect(rows.find((r) => r.recipientText === "Marco Bellandi")).toMatchObject({
        totalCents: 8200, stampDue: true, status: "pagata", serviceText: "Prima visita osteopatica",
        minorText: null, hasXml: true, actions: ["annulla_incasso", "annulla"],
      });
      const cancelled = rows.find((r) => r.status === "annullata")!;
      expect(cancelled).toMatchObject({ recipientText: "Lorenzo Gatti", creditNote: { numberLabel: "NC-1/2026" }, actions: [] });
      expect(await listInvoices(tx, P, { ...october, stato: "annullate" })).toEqual([cancelled]);
      expect((await listInvoices(tx, P, { ...october, q: "Bellandi" })).map((r) => r.recipientText)).toEqual(["Marco Bellandi"]);
      expect(await listInvoices(tx, P, { ...october, q: "NC-1" })).toMatchObject([{ docType: "TD04", numberLabel: "NC-1/2026", actions: [] }]);
      expect(await listInvoices(tx, P, { ...october, q: "%" })).toEqual([]);
    });
  });

  it("calcola emesso al netto della nota, incassato, da incassare e bolli XML del trimestre", async () => {
    await asDemo(async (tx) => {
      const rows = await tx.query<{ docType: string; status: string; total: number; net: number; day: string; paid: string | null; stamp: boolean; xml: string | null }>(
        `select doc_type as "docType", status, total_cents as total, net_cents as net, issue_date as day,
                paid_on as paid, stamp_due as stamp, xml_file_name as xml
           from public.invoices where practice_id = $1 and status <> 'bozza'`, [P],
      );
      const month = rows.filter((r) => r.day.startsWith("2026-10"));
      const stamps = rows.filter((r) => r.day >= "2026-10-01" && r.day < "2027-01-01" && r.stamp && r.xml);
      expect(stamps.length).toBeGreaterThan(0);
      expect(await getMonthTiles(tx, P, "2026-10")).toEqual({
        issuedCents: month.reduce((sum, r) => sum + (r.docType === "TD04" ? -r.total : r.total), 0),
        collectedCents: rows.filter((r) => r.docType === "TD01" && r.status === "pagata" && r.paid?.startsWith("2026-10")).reduce((sum, r) => sum + r.net, 0),
        toCollectCents: month.filter((r) => r.docType === "TD01" && r.status === "emessa").reduce((sum, r) => sum + r.net, 0),
        stamps: { year: 2026, quarter: 4, count: stamps.length, cents: stamps.length * 200, deadline: "2027-03-01" },
      });
    });
  });

  it("legge la bozza del committente e ripristina l'input senza duplicare il bollo automatico", async () => {
    await asDemo(async (tx) => {
      const drafts = await listDrafts(tx, P);
      expect(drafts).toMatchObject([{ status: "bozza", recipientText: "Polisportiva Esempio SSD a r.l.", numberLabel: null, actions: [] }]);
      expect(await countDrafts(tx, P)).toBe(1);
      const id = drafts[0]!.id;
      const lines = await tx.query<{ kind: string }>(
        "select line_kind as kind from public.invoice_lines where practice_id = $1 and invoice_id = $2 order by line_number", [P, id],
      );
      expect(lines).toEqual([{ kind: "prestazione" }, { kind: "rimborso_bollo" }]);
      const editor = await getInvoiceEditor(tx, P, clock, { kind: "draft", invoiceId: id });
      expect(editor).toMatchObject({ invoiceId: id, regime: "forfettario", regimeChanged: false, nextNumber: "303/2026",
        draft: { invoiceId: id, recipient: { kind: "committente" }, lines: [{ quantity: 2, unitPriceCents: 5500 }], paymentMethod: "bonifico" }, prefill: null });
      expect(editor?.draft?.lines).toHaveLength(1);
    });
  });

  it("se mancano i dati fiscali lo studio non è pronto e il nuovo editor mostra solo problemi del fornitore", async () => {
    await asDemoRollback(async (tx) => {
      await tx.query(`update public.fiscal_settings set vat_number = null, tax_code = null,
        fiscal_address_line = null, fiscal_postal_code = null, fiscal_city = null, fiscal_province = null
        where practice_id = $1`, [P]);
      const view = await getInvoiceEditor(tx, P, clock, { kind: "new" });
      expect(view).toMatchObject({ supplierReady: false, draft: null, prefill: null });
      expect(view?.problems.map((problem) => problem.field)).toEqual([
        "supplier.vatNumber", "supplier.taxCode", "supplier.address",
      ]);
      expect(view?.problems.every((problem) => problem.href === "/impostazioni/fisco")).toBe(true);
    });
  });

  it("se il regime cambia dopo il salvataggio segnala la bozza e usa il regime attuale nell'editor", async () => {
    await asDemoRollback(async (tx) => {
      const [draft] = await listDrafts(tx, P);
      await tx.query("update public.fiscal_settings set regime = 'ordinario' where practice_id = $1", [P]);
      const view = await getInvoiceEditor(tx, P, clock, { kind: "draft", invoiceId: draft!.id });
      expect(view).toMatchObject({
        invoiceId: draft!.id, regime: "ordinario", regimeChanged: true, supplierReady: true, problems: [],
        draft: { recipient: { kind: "committente" }, lines: [{ quantity: 2, unitPriceCents: 5500 }] },
      });
      const [saved] = await tx.query<{ regime: string }>(
        "select regime from public.invoices where practice_id = $1 and id = $2", [P, draft!.id],
      );
      expect(saved?.regime).toBe("forfettario");
    });
  });

  it("il dettaglio di Lorenzo ha cronologia e nota collegata, la nota rimanda alla fattura", async () => {
    await asDemo(async (tx) => {
      const [row] = await listInvoices(tx, P, { ...october, stato: "annullate" });
      const detail = await getInvoiceDetail(tx, P, row!.id);
      expect(detail).toMatchObject({ status: "annullata", linked: { kind: "nota", numberLabel: "NC-1/2026" }, actions: [], hasXml: true });
      expect(detail?.events.map((e) => e.label)).toEqual(["Bozza creata", "Emessa", "Incasso registrato", "Annullata con la nota di credito"]);
      expect(detail?.events.every((e) => Number.isFinite(Date.parse(e.at)))).toBe(true);
      expect(await getInvoiceDetail(tx, P, detail!.linked!.id)).toMatchObject({ docType: "TD04", linked: { kind: "fattura", id: row!.id }, actions: [] });
    });
  });

  it("precompila Matteo con descrizione, prezzo e data della seduta e prossimo numero", async () => {
    await asDemo(async (tx) => {
      const matteo = await appointment(tx, "Matteo");
      const view = await getInvoiceEditor(tx, P, clock, { kind: "appointment", appointmentId: matteo.id });
      expect(view).toMatchObject({ invoiceId: null, supplierReady: true, today: "2026-11-04", nextNumber: "303/2026", problems: [],
        prefill: { recipient: { kind: "paziente", patientId: matteo.patientId },
          lines: [{ appointmentId: matteo.id, description: "Prima visita osteopatica", unitPriceCents: 8000, serviceDate: "2026-11-02", quantity: 1 }] } });
      expect(view?.prefill?.lines).toHaveLength(1);
      expect(view?.recipients.patients.find((p) => p.id === matteo.patientId)).toMatchObject({ name: "Matteo Ricci", minor: false, payerGuardian: null });
      expect(view?.toInvoice.find((r) => r.appointmentId === matteo.id)).toMatchObject({ patientId: matteo.patientId, description: "Prima visita osteopatica" });
      expect((await listToInvoice(tx, P, clock)).find((r) => r.appointmentId === matteo.id)?.patientId).toBe(matteo.patientId);
    });
  });

  it("propone Elena Rinaldi come intestataria per Sofia", async () => {
    await asDemo(async (tx) => {
      const sofia = await appointment(tx, "Sofia");
      const view = await getInvoiceEditor(tx, P, clock, { kind: "appointment", appointmentId: sofia.id });
      const patient = view!.recipients.patients.find((p) => p.id === sofia.patientId)!;
      expect(patient).toMatchObject({ minor: true, payerGuardian: { name: "Elena Rinaldi" } });
      expect(view?.prefill?.recipient).toEqual({ kind: "tutore", patientId: sofia.patientId, guardianId: patient.payerGuardian!.id });
      expect(view?.recipientFields?.taxCode).toBeTruthy();
    });
  });

  it("legge le tre fatture di Martina intestate alla madre e il numero della prima visita di Marco", async () => {
    await asDemo(async (tx) => {
      const martina = await appointment(tx, "Martina");
      const rows = await listPatientInvoices(tx, P, martina.patientId);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.recipientText === "Simona De Luca" && r.minorText === "per Martina De Luca")).toBe(true);
      const marco = await appointment(tx, "Marco");
      const invoice = await invoiceOfAppointment(tx, P, marco.id);
      expect(invoice).toMatchObject({ status: "pagata", numberLabel: expect.stringMatching(/^\d+\/2026$/) });
      expect(await getInvoiceEditor(tx, P, clock, { kind: "draft", invoiceId: invoice!.id })).toBeNull();
    });
  });

  it("uB non legge liste, dettaglio, editor o collegamenti dello studio demo", async () => {
    const ids = await asDemo(async (tx) => ({
      draft: (await listDrafts(tx, P))[0]!.id,
      invoice: (await listInvoices(tx, P, october))[0]!.id,
      appointment: await appointment(tx, "Marco"),
    }));
    await asUserB(db, async (tx) => {
      expect(await listInvoices(tx, P, october)).toEqual([]);
      expect(await listDrafts(tx, P)).toEqual([]);
      expect(await countDrafts(tx, P)).toBe(0);
      expect(await listPatientInvoices(tx, P, ids.appointment.patientId)).toEqual([]);
      expect(await getInvoiceDetail(tx, P, ids.invoice)).toBeNull();
      expect(await invoiceOfAppointment(tx, P, ids.appointment.id)).toBeNull();
      expect(await getInvoiceEditor(tx, P, clock, { kind: "new" })).toBeNull();
      expect(await getInvoiceEditor(tx, P, clock, { kind: "draft", invoiceId: ids.draft })).toBeNull();
      expect(await getInvoiceEditor(tx, P, clock, { kind: "appointment", appointmentId: ids.appointment.id })).toBeNull();
      expect(await getMonthTiles(tx, P, "2026-10")).toMatchObject({ issuedCents: 0, collectedCents: 0, toCollectCents: 0, stamps: { count: 0, cents: 0 } });
    });
  });
});
