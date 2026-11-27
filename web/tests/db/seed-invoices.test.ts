import { readFileSync, readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toFatturaModel } from "@/lib/fiscal/model";
import { progressive } from "@/lib/fiscal/numbering";
import { legalText } from "@/lib/fiscal/references";
import { sdiChecks } from "@/lib/fiscal/sdi-checks";
import type { InvoiceSnapshot } from "@/lib/fiscal/snapshot";
import { DEMO_PRACTICE_ID, getActor } from "@/server/auth/actor";
import { fixedClock, romeDateTime, todayRome } from "@/server/clock";
import type { Db } from "@/server/db/db";
import { listToInvoice } from "@/server/domain/invoices/queries";
import { seedDemo } from "../../seed/demo";
import { seedCounters } from "../../seed/invoices";
import { seedForbidden } from "../support/forbidden";
import { validateFatturaXml } from "../support/xsd";
import { openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

const P = DEMO_PRACTICE_ID;
const clock = fixedClock(romeDateTime("2026-11-04", "07:00"));
let db: Db;
let pg: PGlite;

interface Invoice {
  id: string; doc_type: string; status: string; number: number | null; number_label: string | null;
  recipient_kind: string; total_cents: number; withholding_cents: number; stamp_due: boolean;
  payment_method: string; paid_on: string | null; issue_date: string | null; issued_at: Date | null;
  credit_note_id: string | null; transmission_id: string | null; xml: string | null; snapshot: InvoiceSnapshot | null;
}
const invoices = () => db.asUser(getActor(), (tx) => tx.query<Invoice>(
  `select id, doc_type, status, number, number_label, recipient_kind, total_cents, withholding_cents,
          stamp_due, payment_method, paid_on, issue_date, issued_at, credit_note_id, transmission_id, xml, snapshot
     from public.invoices where practice_id = $1 order by issued_at nulls last`, [P],
));

describe("fatture del seed", () => {
  beforeAll(async () => {
    ({ db, pg } = await openTestDb());
    await seedDemo(db, clock, new MemoryFileStore());
  });
  afterAll(async () => { await pg?.close(); });

  it.each([
    ["2026-11-04", [{ series: "TD01", year: 2026, lastNumber: 279 }, { series: "INVIO", year: 0, lastNumber: 279 }]],
    ["2026-10-22", [{ series: "TD01", year: 2026, lastNumber: 261 }, { series: "INVIO", year: 0, lastNumber: 261 }]],
    ["2027-01-13", [{ series: "TD01", year: 2026, lastNumber: 369 }, { series: "TD01", year: 2027, lastNumber: 0 }, { series: "INVIO", year: 0, lastNumber: 369 }]],
  ])("contatori iniziali di %s", (d0, expected) => {
    expect(seedCounters(d0)).toEqual(expected);
  });

  it("sostituisce gli stand-in senza segnare appuntamenti da non fatturare", async () => {
    const directory = new URL("../../seed/", import.meta.url);
    const source = readdirSync(directory).filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(new URL(name, directory), "utf8")).join("\n");
    expect(source).not.toMatch(/writeFiscalSettingsTemporary|markNotToInvoiceTemporary/);
    expect(await db.asUser(getActor(), (tx) => tx.query(
      "select id from public.appointments where practice_id = $1 and no_invoice_reason is not null", [P],
    ))).toEqual([]);
  });

  it("emette 23 TD01 da 280 a 302, una NC e una bozza libera del mese", async () => {
    const rows = await invoices();
    const issued = rows.filter((r) => r.doc_type === "TD01" && r.status !== "bozza");
    expect(issued.map((r) => r.number)).toEqual(Array.from({ length: 23 }, (_, i) => 280 + i));
    expect(rows.filter((r) => r.doc_type === "TD04").map((r) => r.number_label)).toEqual(["NC-1/2026"]);
    const drafts = rows.filter((r) => r.status === "bozza");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ recipient_kind: "committente", number: null, issued_at: null });
    const lines = await db.asUser(getActor(), (tx) => tx.query(
      `select description, quantity, unit_price_cents, appointment_id from public.invoice_lines
        where practice_id = $1 and invoice_id = $2 and line_kind = 'prestazione'`, [P, drafts[0]!.id],
    ));
    expect(lines).toEqual([{ description: "Trattamento osteopatico atleti, novembre 2026", quantity: 2,
      unit_price_cents: 5500, appointment_id: null }]);
  });

  it("paga le 21 fatture dei pazienti, 10 prime visite con bollo e 11 senza, a rotazione", async () => {
    const patients = (await invoices()).filter((r) => r.doc_type === "TD01" && r.status === "pagata" && r.recipient_kind !== "committente");
    expect(patients).toHaveLength(21);
    expect(patients.filter((r) => r.stamp_due)).toHaveLength(10);
    expect(patients.filter((r) => !r.stamp_due)).toHaveLength(11);
    for (const [index, row] of patients.entries()) {
      expect(row.payment_method).toBe(index % 2 === 0 ? "contanti" : "carta");
      expect(row.paid_on).toBe(row.issue_date);
      const snapshot = row.snapshot!;
      expect(snapshot.lines[0]!.serviceDate).toBe(row.issue_date);
      if (row.stamp_due) {
        expect(row.total_cents).toBe(8200);
        expect(snapshot.lines[1]).toMatchObject({ kind: "rimborso_bollo", unitPriceCents: 200, nature: "N2.2" });
      } else expect(snapshot.lines).toHaveLength(1);
    }
    const marco = patients.filter((r) => r.snapshot!.recipient.firstName === "Marco" && r.stamp_due);
    expect(marco).toHaveLength(1);
    const lines = await db.asUser(getActor(), (tx) => tx.query<{
      description: string; invoice_description: string; service_date: string; starts_at: Date;
      unit_price_cents: number; price_cents: number; service_id: string; appointment_service: string;
      issued_at: Date; duration_min: number; first_name: string;
    }>(`select l.description, s.invoice_description, l.service_date, a.starts_at,
               l.unit_price_cents, a.price_cents, l.service_id, a.service_id as appointment_service,
               i.issued_at, a.duration_min, p.first_name
          from public.invoice_lines l join public.invoices i on i.practice_id = l.practice_id and i.id = l.invoice_id
          join public.appointments a on a.practice_id = l.practice_id and a.id = l.appointment_id
          join public.services s on s.practice_id = l.practice_id and s.id = l.service_id
          join public.patients p on p.practice_id = a.practice_id and p.id = a.patient_id
         where l.practice_id = $1 and i.status = 'pagata' and i.recipient_kind <> 'committente'`, [P]));
    expect(lines).toHaveLength(21);
    for (const line of lines) {
      expect(line.description).toBe(line.invoice_description);
      expect(line.service_id).toBe(line.appointment_service);
      expect(line.unit_price_cents).toBe(line.price_cents);
      expect(line.service_date).toBe(todayRome(line.starts_at));
      expect(line.issued_at.getTime()).toBe(line.starts_at.getTime() + line.duration_min * 60_000
        + (line.first_name === "Lorenzo" ? 10 * 60_000 : 0));
    }
    const martina = patients.find((r) => r.snapshot!.recipient.minorName === "Martina De Luca");
    expect(martina).toMatchObject({ recipient_kind: "tutore" });
  });

  it("storna Lorenzo e riemette al padre Paolo a fine appuntamento, +5 e +10 minuti", async () => {
    const rows = await invoices();
    const wrong = rows.find((r) => r.status === "annullata")!;
    expect(wrong).toMatchObject({ recipient_kind: "paziente", total_cents: 8200 });
    expect(wrong.snapshot!.recipient).toMatchObject({ firstName: "Lorenzo", lastName: "Gatti" });
    const credit = rows.find((r) => r.id === wrong.credit_note_id)!;
    const right = rows.find((r) => r.doc_type === "TD01" && r.snapshot?.recipient.firstName === "Paolo"
      && r.snapshot.recipient.lastName === "Gatti")!;
    expect(credit).toMatchObject({ doc_type: "TD04", total_cents: 8200, status: "emessa" });
    expect(right).toMatchObject({ recipient_kind: "tutore", payment_method: wrong.payment_method });
    expect(right.snapshot!.recipient).toMatchObject({ firstName: "Paolo", lastName: "Gatti", minorName: "Lorenzo Gatti" });
    const links = await db.asUser(getActor(), (tx) => tx.query<{ link_active: boolean; starts_at: Date; duration_min: number }>(
      `select l.link_active, a.starts_at, a.duration_min from public.invoice_lines l
         join public.appointments a on a.practice_id = l.practice_id and a.id = l.appointment_id
        where l.practice_id = $1 and l.invoice_id = $2`, [P, credit.id],
    ));
    expect(links).toHaveLength(1);
    expect(links[0]!.link_active).toBe(false);
    const end = links[0]!.starts_at.getTime() + links[0]!.duration_min * 60_000;
    expect(wrong.issued_at!.getTime()).toBe(end);
    expect(credit.issued_at!.getTime()).toBe(end + 5 * 60_000);
    expect(right.issued_at!.getTime()).toBe(end + 10 * 60_000);
  });

  it("fattura la Polisportiva a ottobre con bollo, bonifico e nessuna ritenuta", async () => {
    const club = (await invoices()).filter((r) => r.recipient_kind === "committente" && r.status !== "bozza");
    expect(club).toHaveLength(1);
    expect(club[0]).toMatchObject({ status: "pagata", payment_method: "bonifico", paid_on: "2026-10-31",
      issue_date: "2026-10-31", issued_at: romeDateTime("2026-10-31", "12:30"), total_cents: 22200, withholding_cents: 0 });
    expect(club[0]!.snapshot!.lines[0]).toMatchObject({ description: "Trattamento osteopatico atleti, ottobre 2026",
      quantity: 4, unitPriceCents: 5500, appointmentId: null });
    expect(club[0]!.snapshot!.texts.causali).toContain(legalText("forfettario_no_ritenuta", "2026-10-31").text);
    expect(club[0]!.xml).toContain(legalText("forfettario_no_ritenuta", "2026-10-31").text);
    expect(club[0]!.snapshot!.recipient).toMatchObject({ name: "Polisportiva Esempio SSD a r.l.",
      vatNumber: "09876540007", taxCode: "09876540007", recipientCode: "ABC1234", pec: null,
      address: { line: "Via dello Sport 1", postalCode: "40139", city: "Bologna", province: "BO" } });
    expect(seedForbidden("2026-11-04")).toEqual(expect.arrayContaining(["Polisportiva Esempio SSD a r.l.", "09876540007", "ABC1234"]));
  });

  it("ogni XML salvato passa XSD e SdI, con progressivi consecutivi, restano Matteo e Valentina", async () => {
    const issued = (await invoices()).filter((r) => r.status !== "bozza");
    expect(issued).toHaveLength(24);
    for (const [index, row] of issued.entries()) {
      expect(row.transmission_id).toBe(progressive(280 + index));
      expect(row.xml).not.toBeNull();
      expect(await validateFatturaXml(row.xml!)).toEqual({ valid: true, errors: [] });
      expect(sdiChecks(toFatturaModel(row.snapshot!))).toEqual([]);
    }
    expect((await db.asUser(getActor(), (tx) => listToInvoice(tx, P, clock))).map((r) => r.patientName))
      .toEqual(["Matteo Ricci", "Valentina Greco"]);
  });
});
