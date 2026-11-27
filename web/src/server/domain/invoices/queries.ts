import { firstLast, isMinor } from "@/lib/format";
import { escapeLike } from "@/lib/like";
import { STAMP_CENTS } from "@/lib/fiscal/amounts";
import { quarterOf } from "@/lib/fiscal/calendar";
import type { InvoiceListParams } from "@/lib/fiscal/list-params";
import { withLivePayment } from "@/lib/fiscal/live-payment";
import { emissionProblems, type EmissionProblem } from "@/lib/fiscal/problems";
import { stampDeadline } from "@/lib/fiscal/stamp-deadline";
import { type Clock, romeDayBounds, todayRome } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import type { DocType, FiscalRates, Nature, PaymentMethod, Regime } from "@/lib/fiscal/types";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { getRegistry } from "@/server/domain/patients/card";
import { numberLabel } from "@/lib/fiscal/numbering";
import { esePeriod, standardDescriptionsFor, type EseDocument } from "@/lib/fiscal/redact";
import { buildSnapshot, type InvoiceSnapshot } from "@/lib/fiscal/snapshot";
import { fiscalRatesOf, getFiscalSettings, getPracticeSettings } from "@/server/domain/settings/queries";
import type { DraftInput, RecipientInput } from "./schemas";
import { provisionalSnapshotInput } from "./provisional-snapshot";

/** Anteprima senza prenotare né consumare il numero. */
export async function peekNextNumber(tx: Tx, practiceId: string, docType: DocType, year: number): Promise<string> {
  const [row] = await tx.query<{ lastNumber: number }>(
    'select last_number as "lastNumber" from public.number_series where practice_id = $1 and series = $2 and year = $3',
    [practiceId, docType, year],
  );
  return numberLabel(docType, (row?.lastNumber ?? 0) + 1, year);
}

// "Fatture da emettere": gli appuntamenti fatti fino a oggi senza una riga di
// fattura attiva e senza `no_invoice_reason`. Una riga con `link_active` in una bozza conta come attiva
// (l'appuntamento va nella tab Bozze); la riga di una fattura annullata no. Ogni lettura
// filtra lo studio anche oltre la RLS.

/** Una riga di "Fatture da emettere". */
export interface ToInvoiceRow {
  appointmentId: string;
  patientId: string;
  /** Il giorno di Roma della seduta, "AAAA-MM-GG". */
  day: string;
  /** "Nome Cognome". */
  patientName: string;
  serviceName: string;
  /** Il prezzo dell'appuntamento (`appointments.price_cents`), non quello del listino. */
  priceCents: number;
}

// Su `public.appointments a`: $1 lo studio, $2 le 00:00 di Roma di domani ("fino a oggi" compreso).
const TO_INVOICE = `a.practice_id = $1
        and a.status = 'fatto'
        and a.starts_at < $2
        and a.no_invoice_reason is null
        and not exists (select 1
                          from public.invoice_lines l
                         where l.practice_id = a.practice_id and l.appointment_id = a.id and l.link_active)`;

const endOfToday = (clock: Clock): Date => romeDayBounds(clock.today()).end;

/** Le sedute da fatturare, dalla più vecchia. */
export async function listToInvoice(tx: Tx, practiceId: string, clock: Clock): Promise<ToInvoiceRow[]> {
  return readToInvoice(tx, practiceId, clock);
}

async function readToInvoice(tx: Tx, practiceId: string, clock: Clock): Promise<InvoiceEditorView["toInvoice"]> {
  const rows = await tx.query<{
    appointmentId: string;
    patientId: string;
    serviceId: string;
    description: string;
    startsAt: Date;
    firstName: string;
    lastName: string;
    serviceName: string;
    priceCents: number;
  }>(
    `select a.id as "appointmentId",
            a.patient_id as "patientId", a.service_id as "serviceId", s.invoice_description as description,
            a.starts_at as "startsAt",
            p.first_name as "firstName",
            p.last_name as "lastName",
            s.name as "serviceName",
            a.price_cents as "priceCents"
       from public.appointments a
       join public.patients p on p.practice_id = a.practice_id and p.id = a.patient_id
       join public.services s on s.practice_id = a.practice_id and s.id = a.service_id
      where ${TO_INVOICE}
      order by a.starts_at, a.id`,
    [practiceId, endOfToday(clock)],
  );
  return rows.map((row) => ({
    appointmentId: row.appointmentId,
    patientId: row.patientId,
    serviceId: row.serviceId,
    description: row.description,
    day: todayRome(row.startsAt),
    patientName: firstLast(row),
    serviceName: row.serviceName,
    priceCents: row.priceCents,
  }));
}

/** Quante sono le sedute da fatturare: il numero accanto a "Fatture" e nel titolo del blocco. */
export async function countToInvoice(tx: Tx, practiceId: string, clock: Clock): Promise<number> {
  const [row] = await tx.query<{ n: number }>(
    `select count(*)::int as n from public.appointments a where ${TO_INVOICE}`,
    [practiceId, endOfToday(clock)],
  );
  return row?.n ?? 0;
}

export interface DraftLine {
  id: string; lineNumber: number; lineKind: "prestazione" | "rimborso_bollo";
  serviceId: string | null; appointmentId: string | null; linkActive: boolean;
  description: string; serviceDate: string | null; quantity: number; unitPriceCents: number;
  lineTotalCents: number; vatRateBp: number; nature: Nature | null; subjectToWithholding: boolean;
}

export interface DraftView {
  id: string; docType: DocType; status: "bozza" | "emessa" | "pagata" | "annullata";
  regime: Regime; recipientKind: RecipientInput["kind"]; patientId: string | null;
  guardianId: string | null; billingPartyId: string | null; withholdingAgent: boolean;
  paymentMethod: PaymentMethod; paidOn: string | null; stampMarkCode: string | null; internalNotes: string | null;
  lines: DraftLine[];
}

/** Lettura interna per i comandi: il blocco sulla testata serializza i salvataggi della stessa bozza. */
export async function loadDraft(tx: Tx, practiceId: string, invoiceId: string): Promise<DraftView> {
  const [row] = await tx.query<Omit<DraftView, "lines">>(
    `select id, doc_type as "docType", status, regime, recipient_kind as "recipientKind",
            patient_id as "patientId", guardian_id as "guardianId", billing_party_id as "billingPartyId",
            withholding_agent as "withholdingAgent", payment_method as "paymentMethod", paid_on as "paidOn",
            stamp_mark_code as "stampMarkCode", internal_notes as "internalNotes"
       from public.invoices where practice_id = $1 and id = $2 for update`,
    [practiceId, invoiceId],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  const lines = await tx.query<DraftLine>(
    `select id, line_number as "lineNumber", line_kind as "lineKind", service_id as "serviceId",
            appointment_id as "appointmentId", link_active as "linkActive", description,
            service_date as "serviceDate", quantity, unit_price_cents as "unitPriceCents",
            line_total_cents as "lineTotalCents", vat_rate_bp as "vatRateBp", nature,
            subject_to_withholding as "subjectToWithholding"
       from public.invoice_lines where practice_id = $1 and invoice_id = $2 order by line_number`,
    [practiceId, invoiceId],
  );
  return { ...row, lines };
}

export interface RecipientView {
  kind: RecipientInput["kind"]; patientId: string | null; guardianId: string | null; billingPartyId: string | null;
  firstName: string | null; lastName: string | null; name: string | null;
  taxCode: string | null; vatNumber: string | null;
  addressLine: string | null; postalCode: string | null; city: string | null; province: string | null; country: string;
  recipientCode: string; pec: string | null; withholdingAgent: boolean;
}

/** Verifica anche che il genitore sia proprio di questo paziente; i dati fiscali possono mancare in bozza. */
export async function loadRecipient(tx: Tx, practiceId: string, recipient: RecipientInput): Promise<RecipientView> {
  if (recipient.kind === "committente") {
    const [party] = await tx.query<Omit<RecipientView, "kind" | "patientId" | "guardianId" | "firstName" | "lastName">>(
      `select id as "billingPartyId", name, tax_code as "taxCode", vat_number as "vatNumber",
              address_line as "addressLine", postal_code as "postalCode", city, province, country,
              recipient_code as "recipientCode", pec, is_withholding_agent as "withholdingAgent"
         from public.billing_parties where practice_id = $1 and id = $2`,
      [practiceId, recipient.billingPartyId],
    );
    if (!party) throw new DomainError(NOT_ALLOWED);
    return { ...party, kind: recipient.kind, patientId: null, guardianId: null, firstName: null, lastName: null };
  }
  const registry = await getRegistry(tx, practiceId, recipient.patientId);
  if (!registry) throw new DomainError(NOT_ALLOWED);
  const guardian = recipient.kind === "tutore" ? registry.guardians.find((g) => g.id === recipient.guardianId) : null;
  if (recipient.kind === "tutore" && !guardian) throw new DomainError(NOT_ALLOWED);
  const person = guardian ?? registry.personali;
  const address = guardian ?? registry.indirizzo;
  const nullable = (text: string) => text === "" ? null : text;
  return {
    kind: recipient.kind, patientId: recipient.patientId, guardianId: guardian?.id ?? null, billingPartyId: null,
    firstName: person.firstName, lastName: person.lastName, name: null, taxCode: nullable(person.taxCode), vatNumber: null,
    addressLine: nullable(address.addressLine), postalCode: nullable(address.postalCode), city: nullable(address.city),
    province: nullable(address.province), country: address.country,
    recipientCode: "0000000", pec: null, withholdingAgent: false,
  };
}

// Export oscurato per l'elenco speciale: fatture e note emesse, annullate comprese, mai le bozze.
// Il pagamento si legge dalla riga, come nel PDF di cortesia: `withLivePayment`.

export const INVALID_PERIOD = "Periodo non valido.";

const ESE_WHERE = `i.practice_id = $1 and i.doc_type in ('TD01', 'TD04') and i.status <> 'bozza'
        and i.snapshot is not null and i.issue_date between $2::date and $3::date`;

/** TD01 e TD04 non in bozza con `issue_date` nei mesi da `from` a `to` ("AAAA-MM") compresi, per data e numero. */
export async function listEseDocuments(
  tx: Tx, practiceId: string, from: string, to: string,
): Promise<(EseDocument & { id: string })[]> {
  const period = esePeriod(from, to);
  if (!period) throw new DomainError(INVALID_PERIOD);
  const rows = await tx.query<{
    id: string; snapshot: InvoiceSnapshot; status: EseDocument["status"]; paidOn: string | null;
    paymentMethod: InvoiceSnapshot["payment"]["method"]; dueDate: string | null;
  }>(
    `select i.id, i.snapshot, i.status, i.paid_on as "paidOn", i.payment_method as "paymentMethod", i.due_date as "dueDate"
       from public.invoices i
      where ${ESE_WHERE}
      order by i.issue_date, i.doc_type, i.year, i.number, i.id`,
    [practiceId, period.start, period.end],
  );
  const services = new Map(
    (await tx.query<{ id: string; description: string }>(
      "select id, invoice_description as description from public.services where practice_id = $1",
      [practiceId],
    )).map((service) => [service.id, service.description] as const),
  );
  return rows.map((row) => {
    const snapshot = withLivePayment(row.snapshot, { method: row.paymentMethod, paidOn: row.paidOn, dueDate: row.dueDate });
    return {
      id: row.id, snapshot, status: row.status, paidOn: row.paidOn,
      standardDescriptions: standardDescriptionsFor(snapshot.lines, services),
    };
  });
}

/** Quanti sono i documenti di `listEseDocuments`. */
export async function countEseDocuments(tx: Tx, practiceId: string, from: string, to: string): Promise<number> {
  const period = esePeriod(from, to);
  if (!period) throw new DomainError(INVALID_PERIOD);
  const [row] = await tx.query<{ n: number }>(
    `select count(*)::int as n from public.invoices i where ${ESE_WHERE}`,
    [practiceId, period.start, period.end],
  );
  return row?.n ?? 0;
}

export interface InvoiceRow {
  id: string;
  docType: DocType;
  numberLabel: string | null;
  issueDate: string | null;
  recipientText: string;
  minorText: string | null;
  serviceText: string;
  totalCents: number;
  netCents: number;
  paymentMethod: PaymentMethod;
  stampDue: boolean;
  status: DraftView["status"];
  creditNote: { id: string; numberLabel: string } | null;
  hasXml: boolean;
  actions: ("registra_incasso" | "annulla_incasso" | "annulla")[];
}

function invoiceActions(docType: DocType, status: InvoiceRow["status"]): InvoiceRow["actions"] {
  if (docType !== "TD01") return [];
  if (status === "emessa") return ["registra_incasso", "annulla"];
  if (status === "pagata") return ["annulla_incasso", "annulla"];
  return [];
}

// Le anagrafiche vive servono soltanto alle bozze. Fuori dalla bozza, nomi e prestazioni
// vengono esclusivamente dalla fotografia, anche se il paziente o il listino cambiano.
const SELECT_INVOICE_ROWS = `select i.id, i.doc_type as "docType", i.number_label as "numberLabel",
       i.issue_date as "issueDate", i.status, i.total_cents as "totalCents", i.stamp_due as "stampDue",
       i.net_cents as "netCents", i.payment_method as "paymentMethod",
       (i.xml_file_name is not null) as "hasXml",
       case when i.status = 'bozza' then
         case i.recipient_kind when 'committente' then b.name when 'tutore' then concat_ws(' ', g.first_name, g.last_name)
           else concat_ws(' ', p.first_name, p.last_name) end
         else coalesce(i.snapshot->'recipient'->>'name',
           concat_ws(' ', i.snapshot->'recipient'->>'firstName', i.snapshot->'recipient'->>'lastName')) end as "recipientText",
       case when i.status = 'bozza' then
         case when i.recipient_kind = 'tutore' then 'per ' || concat_ws(' ', p.first_name, p.last_name) end
         else case when i.snapshot->'recipient'->>'minorName' is not null
           then 'per ' || (i.snapshot->'recipient'->>'minorName') end end as "minorText",
       case when i.status = 'bozza' then
         (select string_agg(l.description, ', ' order by l.line_number) from public.invoice_lines l
           where l.practice_id = i.practice_id and l.invoice_id = i.id and l.line_kind = 'prestazione')
         else (select string_agg(line->>'description', ', ' order by (line->>'lineNumber')::int)
                 from jsonb_array_elements(i.snapshot->'lines') line where line->>'kind' = 'prestazione') end as "serviceText",
       case when c.id is not null then jsonb_build_object('id', c.id, 'numberLabel', c.number_label) end as "creditNote"
  from public.invoices i
  left join public.patients p on i.status = 'bozza' and p.practice_id = i.practice_id and p.id = i.patient_id
  left join public.patient_guardians g on i.status = 'bozza' and g.practice_id = i.practice_id and g.id = i.guardian_id
  left join public.billing_parties b on i.status = 'bozza' and b.practice_id = i.practice_id and b.id = i.billing_party_id
  left join public.invoices c on c.practice_id = i.practice_id and c.id = i.credit_note_id
 where i.practice_id = $1`;
const INVOICE_ORDER = "order by i.issue_date desc, i.number desc, i.doc_type, i.id";

function withActions(rows: Omit<InvoiceRow, "actions">[]): InvoiceRow[] {
  return rows.map((row) => ({ ...row, actions: invoiceActions(row.docType, row.status) }));
}

export async function listInvoices(
  tx: Tx, practiceId: string, p: Pick<InvoiceListParams, "anno" | "mese" | "stato" | "q">,
): Promise<InvoiceRow[]> {
  const period = esePeriod(p.mese, p.mese);
  if (!period) throw new DomainError(INVALID_PERIOD);
  const status = { tutte: null, da_incassare: "emessa", pagate: "pagata", annullate: "annullata" }[p.stato];
  const rows = await tx.query<Omit<InvoiceRow, "actions">>(
    `${SELECT_INVOICE_ROWS}
       and i.doc_type in ('TD01', 'TD04') and i.status <> 'bozza' and i.year = $2
       and i.issue_date between $3::date and $4::date
       and ($5::text is null or i.status = $5 and i.doc_type = 'TD01')
       and ($6 = '' or i.number_label ilike $7
         or concat_ws(' ', i.snapshot->'recipient'->>'name', i.snapshot->'recipient'->>'firstName',
                          i.snapshot->'recipient'->>'lastName', i.snapshot->'recipient'->>'minorName') ilike $7)
     ${INVOICE_ORDER}`,
    [practiceId, p.anno, period.start, period.end, status, p.q.trim(), `%${escapeLike(p.q.trim())}%`],
  );
  return withActions(rows);
}

export async function listDrafts(tx: Tx, practiceId: string): Promise<InvoiceRow[]> {
  return withActions(await tx.query<Omit<InvoiceRow, "actions">>(
    `${SELECT_INVOICE_ROWS} and i.status = 'bozza' order by i.created_at desc, i.id`, [practiceId],
  ));
}

export async function countDrafts(tx: Tx, practiceId: string): Promise<number> {
  const [row] = await tx.query<{ n: number }>(
    "select count(*)::int as n from public.invoices where practice_id = $1 and status = 'bozza'", [practiceId],
  );
  return row?.n ?? 0;
}

export interface MonthTiles {
  issuedCents: number;
  collectedCents: number;
  toCollectCents: number;
  stamps: { year: number; quarter: 1 | 2 | 3 | 4; count: number; cents: number; deadline: string };
}

/** Ogni riquadro ha la propria data e base di calcolo. Le note non sottraggono bolli. */
export async function getMonthTiles(tx: Tx, practiceId: string, mese: string): Promise<MonthTiles> {
  const period = esePeriod(mese, mese);
  if (!period) throw new DomainError(INVALID_PERIOD);
  const year = Number(mese.slice(0, 4));
  const quarter = quarterOf(period.start);
  const [totals] = await tx.query<{ issuedCents: string; collectedCents: string; toCollectCents: string }>(
    `select coalesce(sum(case when doc_type = 'TD04' then -total_cents else total_cents end)
              filter (where issue_date between $2::date and $3::date), 0)::text as "issuedCents",
            coalesce(sum(net_cents) filter (where doc_type = 'TD01' and status = 'pagata'
              and paid_on between $2::date and $3::date), 0)::text as "collectedCents",
            coalesce(sum(net_cents) filter (where doc_type = 'TD01' and status = 'emessa'
              and issue_date between $2::date and $3::date), 0)::text as "toCollectCents"
       from public.invoices where practice_id = $1 and status <> 'bozza' and doc_type in ('TD01', 'TD04')`,
    [practiceId, period.start, period.end],
  );
  const quarters = await tx.query<{ quarter: number; n: number }>(
    `select extract(quarter from issue_date)::int as quarter, count(*)::int as n
       from public.invoices where practice_id = $1 and status <> 'bozza' and stamp_due
        and xml_file_name is not null and doc_type in ('TD01', 'TD04')
        and issue_date between $2::date and $3::date group by 1`,
    [practiceId, `${year}-01-01`, `${year}-12-31`],
  );
  const count = (q: number) => quarters.find((row) => row.quarter === q)?.n ?? 0;
  return {
    issuedCents: Number(totals?.issuedCents ?? 0), collectedCents: Number(totals?.collectedCents ?? 0),
    toCollectCents: Number(totals?.toCollectCents ?? 0),
    stamps: { year, quarter, count: count(quarter), cents: count(quarter) * STAMP_CENTS,
      deadline: stampDeadline(year, quarter, { q1Cents: count(1) * STAMP_CENTS, q2Cents: count(2) * STAMP_CENTS }) },
  };
}

export interface InvoiceDetail {
  id: string;
  docType: DocType;
  status: InvoiceRow["status"];
  numberLabel: string | null;
  issueDate: string | null;
  xmlFileName: string | null;
  hasXml: boolean;
  totalCents: number;
  netCents: number;
  paymentMethod: PaymentMethod;
  paidOn: string | null;
  events: { at: string; label: string }[];
  linked: { id: string; numberLabel: string; kind: "nota" | "fattura" } | null;
  actions: InvoiceRow["actions"];
}

const EVENT_LABELS = {
  creata: "Bozza creata", modificata: "Bozza modificata", emessa: "Emessa",
  pagamento_registrato: "Incasso registrato", pagamento_annullato: "Incasso annullato",
  annullata: "Annullata con la nota di credito", pdf_scaricato: "PDF scaricato", xml_scaricato: "XML scaricato",
  export_ese: "Inclusa nell'export per l'elenco speciale",
} as const;

export async function getInvoiceDetail(tx: Tx, practiceId: string, id: string): Promise<InvoiceDetail | null> {
  const [row] = await tx.query<Omit<InvoiceDetail, "events" | "actions">>(
    `select i.id, i.doc_type as "docType", i.status, i.number_label as "numberLabel", i.issue_date as "issueDate",
            i.xml_file_name as "xmlFileName", (i.xml_file_name is not null) as "hasXml",
            i.total_cents as "totalCents", i.net_cents as "netCents", i.payment_method as "paymentMethod", i.paid_on as "paidOn",
            case when linked.id is not null then jsonb_build_object('id', linked.id, 'numberLabel', linked.number_label,
              'kind', case when i.doc_type = 'TD04' then 'fattura' else 'nota' end) end as linked
       from public.invoices i
       left join public.invoices linked on linked.practice_id = i.practice_id
        and linked.id = case when i.doc_type = 'TD04' then i.credited_invoice_id else i.credit_note_id end
      where i.practice_id = $1 and i.id = $2`, [practiceId, id],
  );
  if (!row) return null;
  const events = await tx.query<{ at: Date; type: keyof typeof EVENT_LABELS }>(
    `select at, event_type as type from public.invoice_events where practice_id = $1 and invoice_id = $2
      order by at, array_position($3::text[], event_type), id`, [practiceId, id, Object.keys(EVENT_LABELS)],
  );
  return { ...row, events: events.map((e) => ({ at: e.at.toISOString(), label: EVENT_LABELS[e.type] })),
    actions: invoiceActions(row.docType, row.status) };
}

/** Il testo dell'XML salvato, per "Vedi XML"; null per una bozza o una fattura senza XML. */
export async function getInvoiceXml(tx: Tx, practiceId: string, id: string): Promise<string | null> {
  const [row] = await tx.query<{ xml: string | null }>(
    "select xml from public.invoices where practice_id = $1 and id = $2 and status <> 'bozza'", [practiceId, id],
  );
  return row?.xml ?? null;
}

export async function listPatientInvoices(tx: Tx, practiceId: string, patientId: string): Promise<InvoiceRow[]> {
  return withActions(await tx.query<Omit<InvoiceRow, "actions">>(
    `${SELECT_INVOICE_ROWS} and i.status <> 'bozza' and i.doc_type in ('TD01', 'TD04')
       and (i.patient_id = $2 or exists (select 1 from public.patient_guardians guardian
         where guardian.practice_id = i.practice_id and guardian.patient_id = $2 and guardian.id = i.guardian_id))
     ${INVOICE_ORDER}`, [practiceId, patientId],
  ));
}

export async function invoiceOfAppointment(
  tx: Tx, practiceId: string, appointmentId: string,
): Promise<{ id: string; numberLabel: string | null; status: string } | null> {
  const [row] = await tx.query<{ id: string; numberLabel: string | null; status: string }>(
    `select i.id, i.number_label as "numberLabel", i.status from public.invoice_lines l
       join public.invoices i on i.practice_id = l.practice_id and i.id = l.invoice_id
      where l.practice_id = $1 and l.appointment_id = $2 and l.link_active limit 1`, [practiceId, appointmentId],
  );
  return row ?? null;
}

export interface InvoiceEditorView {
  invoiceId: string | null;
  defaultPaymentMethod: PaymentMethod;
  regime: Regime;
  regimeChanged: boolean;
  rates: FiscalRates;
  supplierReady: boolean;
  recipients: {
    patients: { id: string; name: string; minor: boolean; payerGuardian: { id: string; name: string } | null }[];
    parties: { id: string; name: string; withholdingAgent: boolean }[];
  };
  draft: DraftInput | null;
  prefill: { recipient: DraftInput["recipient"]; lines: DraftInput["lines"]; paymentMethod: PaymentMethod } | null;
  toInvoice: (ToInvoiceRow & { patientId: string; serviceId: string; description: string })[];
  services: { id: string; name: string; description: string; priceCents: number }[];
  today: string;
  nextNumber: string;
  problems: EmissionProblem[];
  recipientFields: {
    taxCode: string | null;
    address: { addressLine: string | null; postalCode: string | null; city: string | null; province: string | null };
  } | null;
}

export type EditorStart = { kind: "new" } | { kind: "appointment"; appointmentId: string } | { kind: "draft"; invoiceId: string };

function recipientOf(draft: DraftView): RecipientInput {
  return draft.recipientKind === "committente" ? { kind: "committente", billingPartyId: draft.billingPartyId! }
    : draft.recipientKind === "tutore" ? { kind: "tutore", patientId: draft.patientId!, guardianId: draft.guardianId! }
      : { kind: "paziente", patientId: draft.patientId! };
}

/** L'apertura dell'editor non salva una bozza e non consuma numeri. */
export async function getInvoiceEditor(
  tx: Tx, practiceId: string, clock: Clock, start: EditorStart,
): Promise<InvoiceEditorView | null> {
  const practice = await getPracticeSettings(tx, practiceId);
  if (!practice) return null;
  const fiscal = await getFiscalSettings(tx, practiceId);
  const [paymentSettings] = await tx.query<{ method: PaymentMethod }>(
    'select default_payment_method as method from public.fiscal_settings where practice_id = $1', [practiceId],
  );
  const defaultPaymentMethod = paymentSettings?.method ?? "contanti";
  const today = clock.today();
  const rates = fiscalRatesOf(fiscal);
  const patients = await tx.query<{ id: string; name: string; birthDate: string; payerGuardian: { id: string; name: string } | null }>(
    `select p.id, concat_ws(' ', p.first_name, p.last_name) as name, p.birth_date as "birthDate",
            (select jsonb_build_object('id', g.id, 'name', concat_ws(' ', g.first_name, g.last_name))
               from public.patient_guardians g where g.practice_id = p.practice_id and g.patient_id = p.id
                and g.is_payer order by g.id limit 1) as "payerGuardian"
       from public.patients p where p.practice_id = $1 and p.archived_at is null order by lower(p.last_name), lower(p.first_name), p.id`, [practiceId],
  );
  const parties = await tx.query<InvoiceEditorView["recipients"]["parties"][number]>(
    `select id, name, is_withholding_agent as "withholdingAgent" from public.billing_parties
      where practice_id = $1 and archived_at is null order by lower(name), id`, [practiceId],
  );
  let draft: DraftInput | null = null;
  let prefill: InvoiceEditorView["prefill"] = null;
  let regimeChanged = false;
  if (start.kind === "draft") {
    const rows = await tx.query("select id from public.invoices where practice_id = $1 and id = $2 and status = 'bozza' and doc_type = 'TD01'", [practiceId, start.invoiceId]);
    if (!rows.length) return null;
    const saved = await loadDraft(tx, practiceId, start.invoiceId);
    regimeChanged = saved.regime !== fiscal.regime;
    draft = {
      invoiceId: saved.id, recipient: recipientOf(saved),
      // Il bollo è un risultato del calcolo, non una prestazione da risalvare come input.
      lines: saved.lines.filter((l) => l.lineKind === "prestazione").map((l) => ({
        serviceId: l.serviceId, appointmentId: l.appointmentId, description: l.description,
        serviceDate: l.serviceDate, quantity: l.quantity, unitPriceCents: l.unitPriceCents,
      })),
      paymentMethod: saved.paymentMethod, paidOn: saved.paidOn, stampMarkCode: saved.stampMarkCode, internalNotes: saved.internalNotes,
    };
  } else if (start.kind === "appointment") {
    const [a] = await tx.query<{
      id: string; patientId: string; birthDate: string; startsAt: Date; guardianId: string | null;
      serviceId: string; description: string; priceCents: number; paymentMethod: PaymentMethod | null;
    }>(
      `select a.id, a.patient_id as "patientId", p.birth_date as "birthDate", a.starts_at as "startsAt",
              (select g.id from public.patient_guardians g where g.practice_id = a.practice_id
                and g.patient_id = a.patient_id and g.is_payer order by g.id limit 1) as "guardianId",
              a.service_id as "serviceId", s.invoice_description as description, a.price_cents as "priceCents", a.payment_method as "paymentMethod"
         from public.appointments a join public.patients p on p.practice_id = a.practice_id and p.id = a.patient_id
         join public.services s on s.practice_id = a.practice_id and s.id = a.service_id
        where a.practice_id = $1 and a.id = $2`, [practiceId, start.appointmentId],
    );
    if (!a) return null;
    const day = todayRome(a.startsAt);
    prefill = {
      recipient: isMinor(a.birthDate, day) && a.guardianId
        ? { kind: "tutore", patientId: a.patientId, guardianId: a.guardianId } : { kind: "paziente", patientId: a.patientId },
      lines: [{ serviceId: a.serviceId, appointmentId: a.id, description: a.description,
        serviceDate: day, quantity: 1, unitPriceCents: a.priceCents }],
      paymentMethod: a.paymentMethod ?? defaultPaymentMethod,
    };
  }
  const selected = draft ?? prefill;
  const recipient = selected ? await loadRecipient(tx, practiceId, selected.recipient) : null;
  const lines = selected?.lines ?? [];
  const input = provisionalSnapshotInput({
    practice, fiscal, recipient, lines, today, docType: "TD01", credited: null,
    // L'editor filtra payment.* sul metodo scelto, anche se la vista parte da carta o contanti.
    payment: { method: "bonifico", paidOn: draft?.paidOn ?? null }, stampMarkCode: draft?.stampMarkCode ?? null,
  });
  const { issueDate } = input;
  const snapshot = buildSnapshot(input);
  // I controlli SdI si fermano al primo problema: senza la classe del pagamento compaiono anche con l'IBAN
  // mancante, e restano quando nell'editor si passa a carta o contanti.
  const allProblems = emissionProblems(snapshot);
  for (const problem of emissionProblems(snapshot, { includePayment: false })) {
    if (!allProblems.some((p) => p.field === problem.field && p.message === problem.message)) allProblems.push(problem);
  }
  const supplierProblems = allProblems.filter((p) => p.field.startsWith("supplier."));
  const services = await tx.query<InvoiceEditorView["services"][number]>(
    `select id, name, invoice_description as description, price_cents as "priceCents" from public.services
      where practice_id = $1 and archived_at is null order by sort_order, lower(name), id`, [practiceId],
  );
  return {
    invoiceId: draft?.invoiceId ?? null, defaultPaymentMethod, regime: fiscal.regime, regimeChanged, rates, supplierReady: supplierProblems.length === 0,
    recipients: { patients: patients.map((p) => ({ id: p.id, name: p.name, minor: isMinor(p.birthDate, today), payerGuardian: p.payerGuardian })), parties },
    draft, prefill, toInvoice: await readToInvoice(tx, practiceId, clock), services, today,
    nextNumber: await peekNextNumber(tx, practiceId, "TD01", Number(issueDate.slice(0, 4))),
    problems: selected ? allProblems : allProblems.filter((p) => p.field.startsWith("supplier.") || p.field.startsWith("payment.")),
    recipientFields: recipient && recipient.kind !== "committente" ? {
      taxCode: recipient.taxCode, address: { addressLine: recipient.addressLine, postalCode: recipient.postalCode,
        city: recipient.city, province: recipient.province },
    } : null,
  };
}
