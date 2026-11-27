import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { issueFromEditorAction, saveDraftAction } from "@/app/(app)/fatture/actions";
import * as invoiceActions from "@/app/(app)/fatture/actions";
import { toActionFailure } from "@/server/actions/result";
import type { CommandContext } from "@/server/actions/run";
import { LATE_ISSUE, PAID_IN_FUTURE } from "@/lib/fiscal/issue-date";
import { toFatturaModel } from "@/lib/fiscal/model";
import { XML_MISSING_TAX_CODE } from "@/lib/fiscal/problems";
import { sdiChecks } from "@/lib/fiscal/sdi-checks";
import type { InvoiceSnapshot } from "@/lib/fiscal/snapshot";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { switchToUser } from "@/server/db/service";
import { DomainError } from "@/server/domain/errors";
import { issueInvoice, saveInvoiceDraft } from "@/server/domain/invoices/commands";
import { peekNextNumber } from "@/server/domain/invoices/queries";
import { saveRecipientFiscalFields } from "@/server/domain/invoices/recipient";
import { createPatient } from "@/server/domain/patients/commands";
import { saveFiscalSettings, saveRegistration, saveStudio } from "@/server/domain/settings/commands";
import { xmlSha256 } from "@/server/fatturapa/build-xml";
import { STUDIO } from "../../seed/people";
import { validateFatturaXml } from "../support/xsd";
import { issueInvoice as fixtureIssue, INVOICE_B, PRACTICE_A, PRACTICE_B, USER_A, USER_B } from "./fixtures";
import { inRollback, inUserA, openTestDb } from "./helpers";

// Solo il contesto Next è sostituito: azioni, comandi, RLS, emissione e contatori sono reali.
const actionContext = vi.hoisted(() => ({ current: null as CommandContext | null }));
vi.mock("@/server/actions/run", () => ({
  runAction: async (name: string, command: (context: CommandContext) => Promise<unknown>) => {
    if (actionContext.current === null) throw new Error("Contesto del test mancante");
    try {
      return { ok: true, data: await command(actionContext.current) };
    } catch (error) {
      return toActionFailure(error, name);
    }
  },
}));

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const fiscal = {
  regime: "forfettario", vatNumber: "00000000000", taxCode: STUDIO.practitionerTaxCode,
  atecoCode: "86.96.09", fiscalAddressLine: "Via delle Prove 7", fiscalPostalCode: "40121",
  fiscalCity: "Bologna", fiscalProvince: "BO", fiscalCountry: "IT", inpsSurchargeEnabled: false,
  stampChargedToClient: true, paperStampAuthorization: null, iban: "IT80N0000001000000000123456",
  ibanHolder: "Laura Benedetti", defaultPaymentMethod: "carta", bankTransferDueDays: 15,
};
const ALREADY_ISSUED = "La fattura è già emessa.";
const ISSUED_BACKWARDS = "Un'altra fattura della serie risulta emessa dopo quest'ora: controlla data e ora del computer.";
const DATE_WARNING = "La data della fattura viene prima di quella dell'ultima fattura emessa.";
const NUMBERING_MISMATCH = "La numerazione delle fatture non torna con il contatore: non emetto. Controlla le fatture dell'anno.";
const fixtureCounters = [{ series: "TD01", year: 2025, last_number: 7 }];
let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

async function setup(tx: Tx, lastName = "D’Amico", taxCode: string | null = STUDIO.practitionerTaxCode) {
  await saveFiscalSettings(tx, PRACTICE_A, clock, fiscal);
  await saveStudio(tx, PRACTICE_A, clock, {
    practiceName: STUDIO.practiceName, practitionerFirstName: "Laura", practitionerLastName: "Benedetti",
    practitionerTitle: "Osteopata", addressLine: "Via delle Prove 7", postalCode: "40121", city: "Bologna",
    province: "BO", phone: "+390510000000", email: "studio@example.com", pec: null,
  });
  const { id } = await createPatient(tx, PRACTICE_A, clock, { firstName: "Elisa", lastName, birthDate: "1990-01-01" });
  await saveRecipientFiscalFields(tx, PRACTICE_A, clock, {
    kind: "paziente", patientId: id, ...(taxCode === null ? {} : { taxCode }),
    address: { addressLine: "Via delle Prove 1", postalCode: "40121", city: "Bologna", province: "BO" },
  });
  return id;
}
async function draft(tx: Tx, patientId: string, paidOn: string | null = null, paymentMethod = "carta", cents = 5500) {
  return (await saveInvoiceDraft(tx, PRACTICE_A, clock, {
    invoiceId: null, recipient: { kind: "paziente", patientId },
    lines: [{ serviceId: null, appointmentId: null, description: "Trattamento osteopatico",
      serviceDate: "2026-11-03", quantity: 1, unitPriceCents: cents }],
    paymentMethod, paidOn, stampMarkCode: null, internalNotes: null,
  })).id;
}
interface InvoiceRow {
  status: string; number: number | null; number_label: string | null; issue_date: string | null;
  issued_at: Date | null; paid_at: Date | null; due_date: string | null; year: number | null;
  transmission_id: string | null; xml_file_name: string | null; xml: string | null;
  xml_sha256: string | null; snapshot: InvoiceSnapshot;
}
async function invoice(tx: Tx, id: string) {
  return (await tx.query<InvoiceRow>("select * from public.invoices where practice_id = $1 and id = $2", [PRACTICE_A, id]))[0]!;
}
async function counters(tx: Tx) {
  return tx.query("select series, year, last_number from public.number_series where practice_id = $1 order by series, year", [PRACTICE_A]);
}
async function state(tx: Tx) {
  return {
    counters: await counters(tx),
    invoices: await tx.query("select * from public.invoices where practice_id = $1 order by id", [PRACTICE_A]),
    lines: await tx.query("select * from public.invoice_lines where practice_id = $1 order by id", [PRACTICE_A]),
    events: await tx.query("select * from public.invoice_events where practice_id = $1 order by id", [PRACTICE_A]),
  };
}

describe("emissione nella transazione dell'utente", () => {
  it("E3 legge dalla action il numero dell'anno richiesto come utente senza consumarlo e valida la data", async () => {
    expect(invoiceActions).toHaveProperty("peekInvoiceNumberAction");
    await inUserA(db, async (tx) => {
      const patientId = await setup(tx);
      const id = await draft(tx, patientId);
      await issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id });
      const before = await state(tx);
      actionContext.current = { tx, practiceId: PRACTICE_A, clock };
      for (const [issueDate, number] of [["2026-12-30", "2/2026"], ["2027-01-02", "1/2027"], ["2025-12-30", "8/2025"]]) {
        expect(await invoiceActions.peekInvoiceNumberAction({ issueDate })).toEqual({ ok: true, data: number });
        expect(await invoiceActions.peekInvoiceNumberAction({ issueDate })).toEqual({ ok: true, data: number });
      }
      for (const bad of [{ issueDate: "2026-02-30" }, { issueDate: "2026-12-30", practiceId: PRACTICE_B }, {}]) {
        expect(await invoiceActions.peekInvoiceNumberAction(bad)).toMatchObject({ ok: false });
      }
      expect(await state(tx)).toEqual(before);
      await switchToUser(tx, { userId: USER_B });
      actionContext.current = { tx, practiceId: PRACTICE_B, clock };
      expect(await invoiceActions.peekInvoiceNumberAction({ issueDate: "2026-12-30" })).toEqual({ ok: true, data: "1/2026" });
      // Anche forzando A nel contesto, la RLS di B non rivela il contatore 2/2026 di A.
      actionContext.current = { tx, practiceId: PRACTICE_A, clock };
      expect(await invoiceActions.peekInvoiceNumberAction({ issueDate: "2026-12-30" })).toEqual({ ok: true, data: "1/2026" });
      await switchToUser(tx, { userId: USER_A });
      expect(await state(tx)).toEqual(before);
    });
  });

  it("X2 salva n° 123 ma blocca l'emissione fino al numero albo senza simboli", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await setup(tx);
      const registration = {
        registrationKind: "albo", registrationOrder: "Ordine TSRM PSTRP di Bologna", registrationProvince: "BO",
        registrationNumber: "n° 123", registrationDate: null, insuranceCompany: null,
        insurancePolicyNumber: null, insuranceLimitEuros: null, insuranceExpiresOn: null,
      };
      await saveRegistration(tx, PRACTICE_A, clock, registration);
      const id = await draft(tx, patientId);
      const before = await state(tx);
      await expect(issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id })).rejects.toMatchObject({ field: "supplier.registration.number" });
      expect(await state(tx)).toEqual(before);
      await saveRegistration(tx, PRACTICE_A, clock, { ...registration, registrationNumber: "123" });
      await issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id });
      const xml = (await invoice(tx, id)).xml!;
      expect(xml).toContain("<NumeroIscrizioneAlbo>123</NumeroIscrizioneAlbo>");
      expect((await validateFatturaXml(xml)).valid).toBe(true);
    });
  });

  it("X1 blocca il beneficiario fuori Latin-1 prima di consumare numeri e salva XML valido dopo la correzione", async () => {
    await inUserA(db, async (tx) => {
      const patientId = await setup(tx);
      await saveFiscalSettings(tx, PRACTICE_A, clock, { ...fiscal, ibanHolder: "Nguyễn" });
      const id = await draft(tx, patientId, null, "bonifico");
      const before = await state(tx);
      await expect(issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id })).rejects.toMatchObject({
        field: "payment.beneficiary",
      });
      expect(await state(tx)).toEqual(before);
      await saveFiscalSettings(tx, PRACTICE_A, clock, fiscal);
      await issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id });
      expect((await validateFatturaXml((await invoice(tx, id)).xml!)).valid).toBe(true);
    });
  });

  it("due emissioni dall'editor con lo stesso id nuovo creano una fattura e consumano un solo numero", async () => {
    await inUserA(db, async (tx) => {
      actionContext.current = { tx, practiceId: PRACTICE_A, clock };
      const id = "b1919191-1919-4191-8191-191919191919";
      const input = {
        id, invoiceId: null, recipient: { kind: "paziente", patientId: await setup(tx) },
        lines: [{ serviceId: null, appointmentId: null, description: "Trattamento osteopatico",
          serviceDate: "2026-11-03", quantity: 1, unitPriceCents: 5500 }],
        paymentMethod: "carta", paidOn: null, stampMarkCode: null, internalNotes: null,
      };
      const before = await tx.query("select id from public.invoices where practice_id = $1 order by id", [PRACTICE_A]);
      expect(await issueFromEditorAction(input)).toMatchObject({ ok: true, data: { id, numberLabel: "1/2026" } });
      const issued = await state(tx);
      expect(await issueFromEditorAction(input)).toEqual({ ok: false, message: ALREADY_ISSUED, refused: true });
      expect(await issueFromEditorAction({ ...input, invoiceId: id })).toEqual({ ok: false, message: ALREADY_ISSUED, refused: true });
      expect(await saveDraftAction({ ...input, invoiceId: id })).toEqual({ ok: false, message: ALREADY_ISSUED, refused: true });
      expect(await state(tx)).toEqual(issued);
      expect(issued.invoices).toHaveLength(before.length + 1);
      expect(await counters(tx)).toEqual([
        { series: "INVIO", year: 0, last_number: 1 }, ...fixtureCounters, { series: "TD01", year: 2026, last_number: 1 },
      ]);
    });
  });

  it("emette 55 euro incassati, congela XML valido, hash, fotografia, contatori ed eventi e rifiuta il doppio invio", async () => {
    await inUserA(db, async (tx) => {
      const p = await setup(tx);
      expect(await peekNextNumber(tx, PRACTICE_A, "TD01", 2026)).toBe("1/2026");
      const id = await draft(tx, p, "2026-11-04");
      expect(await issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id })).toEqual({
        id, numberLabel: "1/2026", status: "pagata", hasXml: true, warnings: [],
      });
      const row = await invoice(tx, id);
      expect(row).toMatchObject({ status: "pagata", number: 1, number_label: "1/2026", year: 2026,
        issue_date: "2026-11-04", issued_at: clock.now(), paid_at: clock.now(), transmission_id: "00001",
        xml_file_name: `IT${STUDIO.practitionerTaxCode}_00001.xml`, snapshot: { numberLabel: "1/2026", recipient: { lastName: "D'Amico" } } });
      expect(await validateFatturaXml(row.xml!)).toEqual({ valid: true, errors: [] });
      expect(sdiChecks(toFatturaModel(row.snapshot))).toEqual([]);
      expect(row.xml_sha256).toBe(xmlSha256(row.xml!));
      expect(await tx.query("select event_type, at from public.invoice_events where practice_id = $1 and invoice_id = $2 order by event_type", [PRACTICE_A, id])).toEqual([
        { event_type: "creata", at: clock.now() }, { event_type: "emessa", at: clock.now() },
        { event_type: "pagamento_registrato", at: clock.now() },
      ]);
      expect(await counters(tx)).toEqual([{ series: "INVIO", year: 0, last_number: 1 }, ...fixtureCounters, { series: "TD01", year: 2026, last_number: 1 }]);
      expect(await peekNextNumber(tx, PRACTICE_A, "TD01", 2026)).toBe("2/2026");
      const before = await state(tx);
      await expect(issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id })).rejects.toEqual(new DomainError(ALREADY_ISSUED));
      expect(await state(tx)).toEqual(before);
    });
  });

  it("bonifico da incassare: emessa, scadenza a 15 giorni e IBAN nell'XML", async () => {
    await inUserA(db, async (tx) => {
      const id = await draft(tx, await setup(tx), null, "bonifico");
      expect(await issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id })).toMatchObject({ status: "emessa" });
      const row = await invoice(tx, id);
      expect(row).toMatchObject({ due_date: "2026-11-19", paid_at: null });
      expect(row.xml).toContain("<IBAN>IT80N0000001000000000123456</IBAN>");
    });
  });

  it("esente verso paziente non crea XML né consuma INVIO", async () => {
    await inUserA(db, async (tx) => {
      const p = await setup(tx);
      await issueInvoice(tx, PRACTICE_A, clock, { invoiceId: await draft(tx, p) });
      await saveFiscalSettings(tx, PRACTICE_A, clock, { ...fiscal, regime: "esente_sanitario" });
      const id = await draft(tx, p);
      expect(await issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id })).toMatchObject({ hasXml: false });
      expect(await invoice(tx, id)).toMatchObject({ xml: null, xml_sha256: null, xml_file_name: null, transmission_id: null, snapshot: { electronic: false } });
      expect(await counters(tx)).toContainEqual({ series: "INVIO", year: 0, last_number: 1 });
    });
  });

  it.each([
    ["2026-11-01", []], ["2026-10-22", [LATE_ISSUE]],
  ])("usa il giorno dell'incasso %s e segnala il ritardo", async (paidOn, warnings) => {
    await inUserA(db, async (tx) => {
      const id = await draft(tx, await setup(tx), paidOn);
      expect(await issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id })).toMatchObject({ warnings });
      expect(await invoice(tx, id)).toMatchObject({ issue_date: paidOn, paid_at: clock.now() });
    });
  });

  it("rifiuta l'incasso futuro con DomainError prima dei contatori", async () => {
    await inUserA(db, async (tx) => {
      const id = await draft(tx, await setup(tx), "2026-11-05");
      const before = await state(tx);
      await expect(issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id })).rejects.toEqual(new DomainError(PAID_IN_FUTURE));
      expect(await state(tx)).toEqual(before);
    });
  });

  it.each([
    ["2026-12-31T23:30:00Z", null, "2027-01-01", 2027],
    ["2027-01-02T09:00:00+01:00", "2026-12-30", "2026-12-30", 2026],
  ])("sceglie l'anno della Data con orologio %s", async (at, paidOn, day, year) => {
    await inUserA(db, async (tx) => {
      const id = await draft(tx, await setup(tx), paidOn);
      await issueInvoice(tx, PRACTICE_A, fixedClock(at), { invoiceId: id });
      expect(await invoice(tx, id)).toMatchObject({ number_label: `1/${year}`, issue_date: day, year });
    });
  });

  it("blocca issued_at anteriore, accetta l'uguaglianza e avvisa sulla Data precedente", async () => {
    await inUserA(db, async (tx) => {
      const p = await setup(tx);
      const first = fixedClock("2026-10-05T08:30:00+02:00");
      await issueInvoice(tx, PRACTICE_A, first, { invoiceId: await draft(tx, p) });
      const id = await draft(tx, p, "2026-10-04");
      const before = await state(tx);
      await expect(issueInvoice(tx, PRACTICE_A, fixedClock("2026-10-04T08:30:00+02:00"), { invoiceId: id })).rejects.toEqual(new DomainError(ISSUED_BACKWARDS));
      expect(await state(tx)).toEqual(before);
      expect(await issueInvoice(tx, PRACTICE_A, first, { invoiceId: id })).toMatchObject({ numberLabel: "2/2026", warnings: [DATE_WARNING] });
    });
  });

  it.each([
    ["Nguyễn", STUDIO.practitionerTaxCode, "Il cognome del paziente contiene una lettera che la fattura elettronica non accetta: correggila in anagrafica"],
    ["Fontana", null, XML_MISSING_TAX_CODE],
  ])("rifiuta l'anagrafica incompleta o non Latin-1: %s", async (name, taxCode, message) => {
    await inUserA(db, async (tx) => {
      const id = await draft(tx, await setup(tx, name, taxCode));
      const before = await state(tx);
      await expect(issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id })).rejects.toEqual(new DomainError(message, { field: taxCode === null ? "recipient.taxCode" : "recipient.lastName" }));
      expect(await state(tx)).toEqual(before);
    });
  });

  it("rifiuta il contatore incoerente e annulla tutte le scritture", async () => {
    await expect(inRollback(db, "service", async (tx) => {
      await switchToUser(tx, { userId: USER_A });
      const p = await setup(tx);
      await fixtureIssue(tx, { invoiceId: await draft(tx, p), issueDate: "2026-11-03", number: 6 });
      const id = await draft(tx, p);
      await tx.query("reset role");
      await tx.query("select app.next_number($1, 'TD01', 2026)", [PRACTICE_A]);
      await tx.query("update public.number_series set last_number = 5 where practice_id = $1 and series = 'TD01' and year = 2026", [PRACTICE_A]);
      await switchToUser(tx, { userId: USER_A });
      await issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id });
    })).rejects.toEqual(new DomainError(NUMBERING_MISMATCH));
    await inUserA(db, async (tx) => { expect(await counters(tx)).toEqual(fixtureCounters); });
  });

  it("un errore sull'update risale e il rollback restituisce entrambi i numeri", async () => {
    await expect(inRollback(db, "A", async (tx) => {
      const id = await draft(tx, await setup(tx));
      const failing: Tx = { query: (sql, params) => {
        if (/update public\.invoices/i.test(sql)) throw new Error("update emissione fallito");
        return tx.query(sql, params);
      } };
      await issueInvoice(failing, PRACTICE_A, clock, { invoiceId: id });
    })).rejects.toThrow("update emissione fallito");
    await inUserA(db, async (tx) => {
      expect(await counters(tx)).toEqual(fixtureCounters);
      const id = await draft(tx, await setup(tx));
      await issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id });
      expect(await invoice(tx, id)).toMatchObject({ number: 1, transmission_id: "00001" });
    });
  });

  it("ricalcola regime, righe e totali quando il regime cambia dopo la bozza", async () => {
    await inUserA(db, async (tx) => {
      const id = await draft(tx, await setup(tx), null, "carta", 8000);
      await saveFiscalSettings(tx, PRACTICE_A, clock, { ...fiscal, regime: "ordinario" });
      await issueInvoice(tx, PRACTICE_A, clock, { invoiceId: id });
      expect(await invoice(tx, id)).toMatchObject({ regime: "ordinario", fees_cents: 6557, vat_cents: 1443,
        total_cents: 8000, stamp_charged: false, snapshot: { regime: "ordinario", computation: { totalCents: 8000 } } });
      expect(await tx.query("select line_kind, nature, vat_rate_bp from public.invoice_lines where practice_id = $1 and invoice_id = $2", [PRACTICE_A, id])).toEqual([
        { line_kind: "prestazione", nature: null, vat_rate_bp: 2200 },
      ]);
    });
  });

  it("un id nuovo del client che esiste in un altro studio (la fattura di B usata da A) è rifiutato senza scrivere né leggere", async () => {
    await inUserA(db, async (tx) => {
      actionContext.current = { tx, practiceId: PRACTICE_A, clock };
      const input = {
        id: INVOICE_B, invoiceId: null, recipient: { kind: "paziente", patientId: await setup(tx) },
        lines: [{ serviceId: null, appointmentId: null, description: "Trattamento osteopatico",
          serviceDate: "2026-11-03", quantity: 1, unitPriceCents: 5500 }],
        paymentMethod: "carta", paidOn: null, stampMarkCode: null, internalNotes: null,
      };
      const ofB = async () => {
        await switchToUser(tx, { userId: USER_B });
        const rows = {
          invoice: await tx.query("select * from public.invoices where practice_id = $1 and id = $2", [PRACTICE_B, INVOICE_B]),
          lines: await tx.query("select * from public.invoice_lines where practice_id = $1 and invoice_id = $2 order by id", [PRACTICE_B, INVOICE_B]),
          events: await tx.query("select * from public.invoice_events where practice_id = $1 and invoice_id = $2 order by id", [PRACTICE_B, INVOICE_B]),
        };
        await switchToUser(tx, { userId: USER_A });
        return rows;
      };
      const beforeA = await state(tx);
      const beforeB = await ofB();
      expect(beforeB.invoice).toHaveLength(1);

      // Solo il messaggio generico: niente dei dati di B torna ad A, e niente dice che cosa sia quella fattura.
      for (const result of [await saveDraftAction(input), await issueFromEditorAction(input)]) {
        expect(result).toEqual({ ok: false, message: "Operazione non permessa", refused: true });
      }
      expect(await state(tx)).toEqual(beforeA);
      expect(await ofB()).toEqual(beforeB);
    });
  });

  it("uB non emette la bozza di A, neppure passando lo studio A", async () => {
    await inUserA(db, async (tx) => {
      const id = await draft(tx, await setup(tx));
      const before = await state(tx);
      await switchToUser(tx, { userId: USER_B });
      for (const scope of [PRACTICE_A, PRACTICE_B]) {
        await expect(issueInvoice(tx, scope, clock, { invoiceId: id })).rejects.toThrow("Operazione non permessa");
      }
      await switchToUser(tx, { userId: USER_A });
      expect(await state(tx)).toEqual(before);
    });
  });
});
