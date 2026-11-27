import { monthYear } from "@/lib/format";
import type { PaymentMethod } from "@/lib/fiscal/types";
import { DEMO_PRACTICE_ID } from "@/server/auth/actor";
import { addDaysRome, type Clock, daysBetween, fixedClock, romeDateTime } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { cancelWithCreditNote, issueInvoice, saveBillingParty, saveInvoiceDraft } from "@/server/domain/invoices/commands";
import type { DraftInput, RecipientInput } from "@/server/domain/invoices/schemas";
import { bandsOf } from "@/server/domain/settings/opening-days";
import { getOpeningHours } from "@/server/domain/settings/queries";
import { endOf } from "./dates";
import type { Seeded } from "./demo";
import { POLISPORTIVA } from "./people";

const P = DEMO_PRACTICE_ID;
const MINUTE_MS = 60_000;

/** I numeri esterni precedono la finestra D0-92; INVIO resta unico anche a cavallo d'anno. */
export function seedCounters(d0: string): { series: "TD01" | "INVIO"; year: number; lastNumber: number }[] {
  const start = addDaysRome(d0, -92);
  const year = Number(start.slice(0, 4));
  const currentYear = Number(d0.slice(0, 4));
  const lastNumber = 9 * Math.ceil(daysBetween(`${year}-01-01`, start) / 7);
  return [
    { series: "TD01", year, lastNumber },
    ...(year === currentYear ? [] : [{ series: "TD01" as const, year: currentYear, lastNumber: 0 }]),
    { series: "INVIO", year: 0, lastNumber },
  ];
}

/** Le fatture della demo passano dagli stessi comandi dell'app, una data per ogni evento. */
export async function seedInvoices(tx: Tx, clock: Clock, seeded: readonly Seeded[]): Promise<void> {
  const { address, ...party } = POLISPORTIVA;
  const { id: billingPartyId } = await saveBillingParty(tx, P, clock, {
    ...party, id: null, addressLine: address.line, postalCode: address.postalCode,
    city: address.city, province: address.province,
  });
  const events: { at: Date; run: () => Promise<void> }[] = [];
  const paidAppointments = seeded.flatMap((s) => s.appointments
    .filter((a) => a.seed.status === "fatto" && a.seed.toInvoice !== false)
    .map((a) => ({ s, a, at: endOf(a) })))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  async function emit(at: Date, draft: Omit<DraftInput, "invoiceId" | "stampMarkCode" | "internalNotes">): Promise<string> {
    const eventClock = fixedClock(at);
    const { id } = await saveInvoiceDraft(tx, P, eventClock, {
      ...draft, invoiceId: null, stampMarkCode: null, internalNotes: null,
    });
    // paidOn fa emettere e registrare l'incasso nella stessa transazione, compresi i due eventi.
    await issueInvoice(tx, P, eventClock, { invoiceId: id });
    return id;
  }

  for (const [index, { s, a, at }] of paidAppointments.entries()) {
    const method: PaymentMethod = index % 2 === 0 ? "contanti" : "carta";
    let recipient: RecipientInput = { kind: "paziente", patientId: s.patientId };
    if (s.patient.contactGuardian) {
      const [payer] = await tx.query<{ id: string }>(
        "select id from public.patient_guardians where practice_id = $1 and patient_id = $2 and is_payer",
        [P, s.patientId],
      );
      if (!payer) throw new Error("Il minore del seed non ha un genitore intestatario.");
      recipient = { kind: "tutore", patientId: s.patientId, guardianId: payer.id };
    }
    const draft = {
      recipient, paymentMethod: method, paidOn: a.day,
      lines: [{ serviceId: a.service.id, appointmentId: a.id, description: a.service.invoiceDescription,
        serviceDate: a.day, quantity: 1, unitPriceCents: a.service.priceCents }],
    };
    if (s.patient.firstName === "Lorenzo" && s.patient.lastName === "Gatti") {
      let wrongInvoiceId: string;
      events.push({ at, run: async () => {
        wrongInvoiceId = await emit(at, { ...draft, recipient: { kind: "paziente", patientId: s.patientId } });
      } });
      const creditAt = new Date(at.getTime() + 5 * MINUTE_MS);
      events.push({ at: creditAt, run: async () => {
        await cancelWithCreditNote(tx, P, fixedClock(creditAt), { invoiceId: wrongInvoiceId, note: null });
      } });
      const rightAt = new Date(at.getTime() + 10 * MINUTE_MS);
      events.push({ at: rightAt, run: async () => { await emit(rightAt, draft); } });
    } else events.push({ at, run: async () => { await emit(at, draft); } });
  }

  const week = await getOpeningHours(tx, P);
  let clubDay = addDaysRome(`${clock.today().slice(0, 7)}-01`, -1);
  while (bandsOf(week, clubDay).length === 0) clubDay = addDaysRome(clubDay, -1);
  const clubAt = romeDateTime(clubDay, "12:30");
  const clubLine = (day: string, quantity: number) => ({
    serviceId: null, appointmentId: null, description: `Trattamento osteopatico atleti, ${monthYear(day)}`,
    serviceDate: null, quantity, unitPriceCents: 5500,
  });
  const clubRecipient = { kind: "committente" as const, billingPartyId };
  events.push({ at: clubAt, run: async () => {
    await emit(clubAt, { recipient: clubRecipient, paymentMethod: "bonifico", paidOn: clubDay, lines: [clubLine(clubDay, 4)] });
  } });
  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const event of events) await event.run();

  await saveInvoiceDraft(tx, P, clock, {
    invoiceId: null, recipient: clubRecipient, paymentMethod: "bonifico", paidOn: null,
    stampMarkCode: null, internalNotes: null, lines: [clubLine(clock.today(), 2)],
  });
}
