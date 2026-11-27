import { z } from "zod";
import { computeInvoice, natureOf } from "@/lib/fiscal/calc";
import { PAID_IN_FUTURE } from "@/lib/fiscal/issue-date";
import { esePeriod } from "@/lib/fiscal/redact";
import { stampLineDescription, type InvoiceSnapshot } from "@/lib/fiscal/snapshot";
import { storageKey } from "@/server/files/keys";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { pgCode } from "@/server/db/errors";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { fiscalRatesOf, getFiscalSettings } from "@/server/domain/settings/queries";
import { loadDraft, loadRecipient } from "./queries";
import { BillingPartyInput, CancelInput, DraftInput, InvoiceIdInput, NoInvoiceInput, PaymentInput } from "./schemas";
import { ALREADY_ISSUED, emitDraft, type IssuedInvoice } from "./emission";

export const DRAFT_ONLY = "Solo una bozza si modifica o si elimina.";
export const APPOINTMENT_TAKEN = "Questa seduta è già in un'altra fattura.";
export const APPOINTMENT_OTHER_PATIENT = "La seduta è di un altro paziente.";
export const APPOINTMENT_NOT_DONE = "Si fattura solo una seduta fatta.";
export const APPOINTMENT_NOT_TO_INVOICE = "Questa seduta è segnata come da non fatturare: togli il segno prima di fatturarla.";
const INVALID = "Valore non valido";

/** Serve anche alle insert senza un id esistente: nessuna scrittura prima di verificare lo studio. */
async function requirePractice(tx: Tx, practiceId: string): Promise<void> {
  const rows = await tx.query("select id from public.practices where id = $1", [practiceId]);
  if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
}

async function appointmentOf(tx: Tx, practiceId: string, appointmentId: string, invoiceId: string | null) {
  const [row] = await tx.query<{ patientId: string; status: string; taken: boolean; noInvoiceReason: string | null }>(
    `select a.patient_id as "patientId", a.status, a.no_invoice_reason as "noInvoiceReason",
            exists (select 1 from public.invoice_lines l
                     where l.practice_id = a.practice_id and l.appointment_id = a.id and l.link_active
                       and ($3::uuid is null or l.invoice_id <> $3::uuid)) as taken
       from public.appointments a where a.practice_id = $1 and a.id = $2`,
    [practiceId, appointmentId, invoiceId],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return row;
}

function requireEditableDraft(current: { status: string; docType: string }) {
  if (current.docType !== "TD01") throw new DomainError(DRAFT_ONLY);
  if (current.status !== "bozza") throw new DomainError(ALREADY_ISSUED);
}

/** Salvataggio esplicito: lo stesso id del client riusa la bozza e non può riscrivere una fattura emessa. */
export async function saveInvoiceDraft(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<{ id: string }> {
  const draft = DraftInput.parse(input);
  await requirePractice(tx, practiceId);
  const targetId = draft.invoiceId ?? draft.id ?? null;
  let updating = false;
  if (targetId !== null) {
    const [current] = await tx.query<{ status: string; docType: string }>(
      `select status, doc_type as "docType" from public.invoices where practice_id = $1 and id = $2 for update`,
      [practiceId, targetId],
    );
    if (!current && draft.invoiceId !== null) throw new DomainError(NOT_ALLOWED);
    if (current) {
      requireEditableDraft(current);
      updating = true;
    }
  }
  const recipient = await loadRecipient(tx, practiceId, draft.recipient);
  const appointments = new Set<string>();
  for (const line of draft.lines) {
    if (line.serviceId !== null) {
      const rows = await tx.query("select id from public.services where practice_id = $1 and id = $2", [practiceId, line.serviceId]);
      if (rows.length === 0) throw new DomainError(NOT_ALLOWED);
    }
    if (line.appointmentId === null) continue;
    const appointment = await appointmentOf(tx, practiceId, line.appointmentId, targetId);
    if (recipient.patientId !== null && appointment.patientId !== recipient.patientId) throw new DomainError(APPOINTMENT_OTHER_PATIENT);
    if (appointment.status !== "fatto") throw new DomainError(APPOINTMENT_NOT_DONE);
    if (appointment.noInvoiceReason !== null) throw new DomainError(APPOINTMENT_NOT_TO_INVOICE);
    if (appointment.taken || appointments.has(line.appointmentId)) throw new DomainError(APPOINTMENT_TAKEN);
    appointments.add(line.appointmentId);
  }
  const fiscal = await getFiscalSettings(tx, practiceId);
  const computation = computeInvoice({
    regime: fiscal.regime, rates: fiscalRatesOf(fiscal), recipientKind: recipient.kind,
    withholdingAgent: recipient.withholdingAgent, lines: draft.lines,
  });
  // I limiti del modulo ammettono prodotti più grandi di un integer SQL: rifiuto prima di scrivere.
  const amounts = [computation.feesCents, computation.surchargeCents, computation.taxableCents,
    computation.vatCents, computation.totalCents, computation.withholdingCents, computation.netCents,
    ...draft.lines.map((line) => line.quantity * line.unitPriceCents)];
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0 || amount > 2147483647)) throw new DomainError(INVALID);
  const values = [practiceId, fiscal.regime, recipient.kind, recipient.patientId, recipient.guardianId,
    recipient.billingPartyId, recipient.withholdingAgent, computation.surchargeApplied, computation.withholdingApplied,
    computation.stampDue, computation.stampCharged, computation.feesCents, computation.surchargeCents,
    computation.taxableCents, computation.vatCents, computation.stampChargedCents, computation.totalCents,
    computation.withholdingCents, computation.netCents, draft.paymentMethod, draft.paidOn, draft.stampMarkCode, draft.internalNotes];
  let saved: { id: string } | undefined;
  let created = false;
  if (!updating) {
    [saved] = await tx.query<{ id: string }>(
      `insert into public.invoices
         (practice_id, regime, recipient_kind, patient_id, guardian_id, billing_party_id, withholding_agent,
          surcharge_applied, withholding_applied, stamp_due, stamp_charged, fees_cents, surcharge_cents,
          taxable_cents, vat_cents, stamp_charged_cents, total_cents, withholding_cents, net_cents,
          payment_method, paid_on, stamp_mark_code, internal_notes, id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,coalesce($24::uuid,gen_random_uuid()))
       on conflict (id) do nothing returning id`, [...values, targetId]);
    created = saved !== undefined;
    if (!saved) {
      if (targetId === null) throw new DomainError(NOT_ALLOWED);
      // Due richieste possono leggere entrambe un id ancora assente: l'insert attende il vincitore,
      // poi si rilegge con il lock prima di aggiornare. Una fattura emessa non si tocca né si rinumera.
      requireEditableDraft(await loadDraft(tx, practiceId, targetId));
      updating = true;
    }
  }
  if (updating) {
    [saved] = await tx.query<{ id: string }>(
      `update public.invoices set regime = $2, recipient_kind = $3, patient_id = $4, guardian_id = $5,
          billing_party_id = $6, withholding_agent = $7, surcharge_applied = $8, withholding_applied = $9,
          stamp_due = $10, stamp_charged = $11, fees_cents = $12, surcharge_cents = $13,
          taxable_cents = $14, vat_cents = $15, stamp_charged_cents = $16, total_cents = $17,
          withholding_cents = $18, net_cents = $19, payment_method = $20, paid_on = $21,
          stamp_mark_code = $22, internal_notes = $23
        where practice_id = $1 and id = $24 and status = 'bozza' returning id`, [...values, targetId]);
  }
  if (!saved) throw new DomainError(NOT_ALLOWED);
  await tx.query("delete from public.invoice_lines where practice_id = $1 and invoice_id = $2", [practiceId, saved.id]);
  const calculatedLines = draft.lines.map((line) => ({ ...line, kind: "prestazione" as "prestazione" | "rimborso_bollo" }));
  if (computation.stampCharged) calculatedLines.push({
    serviceId: null, appointmentId: null, kind: "rimborso_bollo", description: stampLineDescription,
    serviceDate: null, quantity: 1, unitPriceCents: computation.stampChargedCents,
  });
  for (const [index, line] of calculatedLines.entries()) {
    try {
      await tx.query(
        `insert into public.invoice_lines
           (practice_id, invoice_id, line_number, line_kind, service_id, appointment_id, link_active,
            description, service_date, quantity, unit_price_cents, line_total_cents, vat_rate_bp, nature, subject_to_withholding)
         values ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [practiceId, saved.id, index + 1, line.kind, line.serviceId, line.appointmentId, line.description,
          line.serviceDate, line.quantity, line.unitPriceCents, line.quantity * line.unitPriceCents,
          computation.lineVatRateBp, natureOf(fiscal.regime), computation.withholdingApplied],
      );
    } catch (error) {
      if (pgCode(error) === "23505") throw new DomainError(APPOINTMENT_TAKEN);
      throw error;
    }
  }
  await tx.query(
    "insert into public.invoice_events (practice_id, invoice_id, event_type, at) values ($1,$2,$3,$4)",
    [practiceId, saved.id, created ? "creata" : "modificata", clock.now()],
  );
  return saved;
}

export async function issueInvoice(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<IssuedInvoice> {
  const { invoiceId } = InvoiceIdInput.parse(input);
  return emitDraft(tx, practiceId, clock, invoiceId, null);
}

export const PAID_BEFORE_ISSUE = "L'incasso non può precedere la data della fattura.";
export const REFUND_OUTSIDE = "Rimborso da gestire fuori dal gestionale";
export const CANNOT_CANCEL = "Si annulla solo una fattura emessa o pagata.";
export const ALREADY_PAID = "La fattura risulta già pagata.";
export const PAY_ONLY_ISSUED = "L'incasso si registra solo su una fattura emessa.";
export const NO_PAYMENT_TO_UNDO = "Non c'è un incasso da annullare.";

/** Blocca la testata: due incassi o due annullamenti della stessa fattura si mettono in fila. */
async function lockInvoice(tx: Tx, practiceId: string, invoiceId: string) {
  const [row] = await tx.query<{
    docType: string; status: string; issueDate: string | null; numberLabel: string | null;
    xml: string | null; snapshot: InvoiceSnapshot | null;
  }>(
    `select doc_type as "docType", status, issue_date as "issueDate", number_label as "numberLabel", xml, snapshot
       from public.invoices where practice_id = $1 and id = $2 for update`,
    [practiceId, invoiceId],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return row;
}

async function addEvent(tx: Tx, practiceId: string, invoiceId: string, type: string, at: Date, details: object | null = null) {
  await tx.query(
    "insert into public.invoice_events (practice_id, invoice_id, event_type, at, details) values ($1,$2,$3,$4,$5)",
    [practiceId, invoiceId, type, at, details === null ? null : JSON.stringify(details)],
  );
}

/**
 * Solo una fattura emessa; l'importo è il netto già calcolato, l'XML salvato non si tocca. Il PDF
 * mostra data e metodo dell'incasso: `pdf_file_id` torna null nella stessa transazione, così
 * la richiesta dopo lo genera di nuovo; la riga `files` vecchia resta.
 */
export async function registerPayment(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { invoiceId, method, paidOn } = PaymentInput.parse(input);
  const current = await lockInvoice(tx, practiceId, invoiceId);
  if (current.docType === "TD01" && current.status === "pagata") throw new DomainError(ALREADY_PAID);
  if (current.docType !== "TD01" || current.status !== "emessa") throw new DomainError(PAY_ONLY_ISSUED);
  if (current.issueDate === null) throw new DomainError(NOT_ALLOWED);
  if (paidOn > clock.today()) throw new DomainError(PAID_IN_FUTURE);
  if (paidOn < current.issueDate) throw new DomainError(PAID_BEFORE_ISSUE);
  const now = clock.now();
  const saved = await tx.query(
    `update public.invoices set status = 'pagata', paid_on = $3, paid_at = $4, payment_method = $5, pdf_file_id = null
      where practice_id = $1 and id = $2 and status = 'emessa' returning id`,
    [practiceId, invoiceId, paidOn, now, method],
  );
  if (saved.length !== 1) throw new DomainError(NOT_ALLOWED);
  await addEvent(tx, practiceId, invoiceId, "pagamento_registrato", now);
}

export async function undoPayment(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { invoiceId } = InvoiceIdInput.parse(input);
  const current = await lockInvoice(tx, practiceId, invoiceId);
  if (current.docType !== "TD01" || current.status !== "pagata") throw new DomainError(NO_PAYMENT_TO_UNDO);
  if (current.snapshot === null) throw new DomainError(NOT_ALLOWED);
  const frozenPaidOn = current.snapshot?.payment.paidOn;
  if (current.xml === null && frozenPaidOn && current.issueDate && frozenPaidOn < current.issueDate) {
    throw new DomainError("Su questa fattura cartacea l'incasso è già stampato nella data dell'operazione: non si può annullare.");
  }
  const saved = await tx.query(
    `update public.invoices set status = 'emessa', paid_on = null, paid_at = null, payment_method = $3, pdf_file_id = null
      where practice_id = $1 and id = $2 and status = 'pagata' returning id`,
    [practiceId, invoiceId, current.snapshot.payment.method],
  );
  if (saved.length !== 1) throw new DomainError(NOT_ALLOWED);
  await addEvent(tx, practiceId, invoiceId, "pagamento_annullato", clock.now());
}

/** Nell'ordine: bozza TD04 copiata, emissione, fattura annullata, poi le sue righe si liberano. */
export async function cancelWithCreditNote(
  tx: Tx, practiceId: string, clock: Clock, input: unknown,
): Promise<{ creditNoteId: string; numberLabel: string; wasPaid: boolean }> {
  const { invoiceId, note } = CancelInput.parse(input);
  const original = await lockInvoice(tx, practiceId, invoiceId);
  if (original.docType !== "TD01" || (original.status !== "emessa" && original.status !== "pagata")
    || original.issueDate === null || original.numberLabel === null) throw new DomainError(CANNOT_CANCEL);
  const [draft] = await tx.query<{ id: string }>(
    `insert into public.invoices
       (practice_id, doc_type, regime, recipient_kind, patient_id, guardian_id, billing_party_id, withholding_agent,
        surcharge_applied, withholding_applied, stamp_due, stamp_charged, fees_cents, surcharge_cents, taxable_cents,
        vat_cents, stamp_charged_cents, total_cents, withholding_cents, net_cents, payment_method,
        credited_invoice_id, internal_notes)
     select practice_id, 'TD04', regime, recipient_kind, patient_id, guardian_id, billing_party_id, withholding_agent,
        surcharge_applied, withholding_applied, stamp_due, stamp_charged, fees_cents, surcharge_cents, taxable_cents,
        vat_cents, stamp_charged_cents, total_cents, withholding_cents, net_cents, payment_method, id, $3
       from public.invoices where practice_id = $1 and id = $2
     returning id`,
    [practiceId, invoiceId, note],
  );
  if (!draft) throw new DomainError(NOT_ALLOWED);
  // La nota ricorda l'appuntamento nella riga ma non lo tiene: link_active falso fin dall'insert.
  await tx.query(
    `insert into public.invoice_lines
       (practice_id, invoice_id, line_number, line_kind, service_id, appointment_id, link_active, description,
        service_date, quantity, unit_price_cents, line_total_cents, vat_rate_bp, nature, subject_to_withholding)
     select practice_id, $3, line_number, line_kind, service_id, appointment_id, false, description,
        service_date, quantity, unit_price_cents, line_total_cents, vat_rate_bp, nature, subject_to_withholding
       from public.invoice_lines where practice_id = $1 and invoice_id = $2`,
    [practiceId, invoiceId, draft.id],
  );
  const credit = await emitDraft(tx, practiceId, clock, draft.id, { numberLabel: original.numberLabel, issueDate: original.issueDate });
  const now = clock.now();
  const cancelled = await tx.query(
    `update public.invoices set status = 'annullata', credit_note_id = $3, cancelled_at = $4
      where practice_id = $1 and id = $2 and status in ('emessa', 'pagata') returning id`,
    [practiceId, invoiceId, draft.id, now],
  );
  if (cancelled.length !== 1) throw new DomainError(NOT_ALLOWED);
  await tx.query("update public.invoice_lines set link_active = false where practice_id = $1 and invoice_id = $2", [practiceId, invoiceId]);
  await addEvent(tx, practiceId, invoiceId, "annullata", now, note === null ? null : { note });
  return { creditNoteId: draft.id, numberLabel: credit.numberLabel, wasPaid: original.status === "pagata" };
}

export async function deleteInvoiceDraft(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const { invoiceId } = InvoiceIdInput.parse(input);
  const current = await loadDraft(tx, practiceId, invoiceId);
  if (current.status !== "bozza" || current.docType !== "TD01") throw new DomainError(DRAFT_ONLY);
  await tx.query("delete from public.invoices where practice_id = $1 and id = $2 and status = 'bozza'", [practiceId, invoiceId]);
}

export async function markNotToInvoice(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const { appointmentId, reason } = NoInvoiceInput.parse(input);
  const appointment = await appointmentOf(tx, practiceId, appointmentId, null);
  if (appointment.status !== "fatto") throw new DomainError(APPOINTMENT_NOT_DONE);
  if (appointment.taken) throw new DomainError(APPOINTMENT_TAKEN);
  await tx.query("update public.appointments set no_invoice_reason = $3 where practice_id = $1 and id = $2", [practiceId, appointmentId, reason]);
}

export async function saveBillingParty(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<{ id: string }> {
  const party = BillingPartyInput.parse(input);
  await requirePractice(tx, practiceId);
  const values = [practiceId, party.name, party.vatNumber, party.taxCode, party.addressLine,
    party.postalCode, party.city, party.province, party.recipientCode, party.pec, party.isWithholdingAgent];
  const [row] = party.id === null
    ? await tx.query<{ id: string }>(
      `insert into public.billing_parties (practice_id, name, vat_number, tax_code, address_line,
          postal_code, city, province, recipient_code, pec, is_withholding_agent)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`, values)
    : await tx.query<{ id: string }>(
      `update public.billing_parties set name = $2, vat_number = $3, tax_code = $4, address_line = $5,
          postal_code = $6, city = $7, province = $8, recipient_code = $9, pec = $10, is_withholding_agent = $11
        where practice_id = $1 and id = $12 returning id`, [...values, party.id]);
  if (!row) throw new DomainError(NOT_ALLOWED);
  return row;
}

const PdfFileInput = z.object({
  invoiceId: z.uuid({ error: INVALID }),
  renderedPayment: z.object({
    method: z.enum(["contanti", "carta", "bonifico"], { error: INVALID }),
    paidOn: z.iso.date({ error: INVALID }).nullable(),
  }, { error: INVALID }).strict(),
  file: z.object({
    id: z.uuid({ error: INVALID }), storageKey: z.string({ error: INVALID }),
    size: z.number({ error: INVALID }).int({ error: INVALID }).positive({ error: INVALID }),
    sha256: z.string({ error: INVALID }).regex(/^[0-9a-f]{64}$/, { error: INVALID }),
  }, { error: INVALID }).strict(),
}, { error: INVALID }).strict();

const DownloadInput = z.object({
  invoiceId: z.uuid({ error: INVALID }), kind: z.enum(["pdf", "xml"], { error: INVALID }),
}, { error: INVALID }).strict();

export const PDF_ALREADY_SAVED = "Il PDF di questa fattura è già salvato.";

/**
 * Il PDF della copia di cortesia si salva una volta sola, alla prima richiesta. Riga `files`
 * `invoice_pdf` e `pdf_file_id` da null; il trigger lascia cambiare solo questo campo su una fattura emessa.
 */
export async function attachInvoicePdf(
  tx: Tx, practiceId: string, _clock: Clock, input: unknown,
): Promise<void> {
  const { invoiceId, file, renderedPayment } = PdfFileInput.parse(input);
  const [current] = await tx.query<{
    status: string; pdfFileId: string | null; paidOn: string | null; paymentMethod: string;
  }>(
    `select status, pdf_file_id as "pdfFileId", paid_on as "paidOn", payment_method as "paymentMethod"
       from public.invoices where practice_id = $1 and id = $2 for update`,
    [practiceId, invoiceId],
  );
  if (!current || current.status === "bozza") throw new DomainError(NOT_ALLOWED);
  if (current.pdfFileId !== null) throw new DomainError(PDF_ALREADY_SAVED);
  if (current.paidOn !== renderedPayment.paidOn || current.paymentMethod !== renderedPayment.method) {
    throw new DomainError("L'incasso è cambiato durante la creazione del PDF. Riprova.");
  }
  // La chiave è quella di questo studio e di questo file.
  if (file.storageKey !== storageKey(practiceId, "invoice_pdf", file.id, "application/pdf")) throw new DomainError(NOT_ALLOWED);
  await tx.query(
    `insert into public.files (id, practice_id, kind, storage_key, mime_type, size_bytes, sha256)
     values ($1, $2, 'invoice_pdf', $3, 'application/pdf', $4, $5)`,
    [file.id, practiceId, file.storageKey, file.size, file.sha256],
  );
  const updated = await tx.query(
    `update public.invoices set pdf_file_id = $3
      where practice_id = $1 and id = $2 and pdf_file_id is null
        and paid_on is not distinct from $4::date and payment_method = $5 returning id`,
    [practiceId, invoiceId, file.id, renderedPayment.paidOn, renderedPayment.method],
  );
  if (updated.length !== 1) throw new DomainError(PDF_ALREADY_SAVED);
}

/** Ogni risposta 200 delle route di download scrive l'evento, con l'istante dell'orologio. */
export async function recordDownload(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { invoiceId, kind } = DownloadInput.parse(input);
  const current = await lockInvoice(tx, practiceId, invoiceId);
  if (current.status === "bozza") throw new DomainError(NOT_ALLOWED);
  await addEvent(tx, practiceId, invoiceId, kind === "pdf" ? "pdf_scaricato" : "xml_scaricato", clock.now());
}

const EseExportInput = z.object({
  from: z.string({ error: INVALID }), to: z.string({ error: INVALID }),
  count: z.number({ error: INVALID }).int({ error: INVALID }).positive({ error: INVALID }),
  zipSha256: z.string({ error: INVALID }).regex(/^[0-9a-f]{64}$/, { error: INVALID }),
  invoiceIds: z.array(z.uuid({ error: INVALID }), { error: INVALID }).min(1, { error: INVALID }),
}, { error: INVALID }).strict();

/**
 * L'export per l'elenco speciale si registra prima della risposta. Una riga `fiscal_exports`
 * con il primo giorno di `from` e l'ultimo di `to`, lo sha256 dello ZIP, e `export_ese` su ogni documento.
 */
export async function recordEseExport(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { from, to, count, zipSha256, invoiceIds } = EseExportInput.parse(input);
  const period = esePeriod(from, to);
  if (!period || count !== invoiceIds.length) throw new DomainError(INVALID);
  const now = clock.now();
  for (const invoiceId of invoiceIds) {
    const current = await lockInvoice(tx, practiceId, invoiceId);
    if (current.status === "bozza") throw new DomainError(NOT_ALLOWED);
    await addEvent(tx, practiceId, invoiceId, "export_ese", now);
  }
  await tx.query(
    `insert into public.fiscal_exports (practice_id, period_from, period_to, documents_count, zip_sha256)
     values ($1, $2, $3, $4, $5)`,
    [practiceId, period.start, period.end, count, zipSha256],
  );
}
