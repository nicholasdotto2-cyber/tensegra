import { z } from "zod";
import { toLatin1 } from "@/lib/fiscal/latin1";

const INVALID = "Valore non valido";
export const REASON_REQUIRED = "Scegli un motivo.";
export const PARTY_CODE_REQUIRED = "Serve la partita IVA o il codice fiscale del committente.";
const uuid = z.uuid({ error: INVALID });
const date = z.iso.date({ error: "Scrivi la data nel formato 22/10/2026." });
const paymentMethod = z.enum(["contanti", "carta", "bonifico"], { error: INVALID });

// Si converte al salvataggio. I caratteri rimasti fuori dal Latin-1
// impediranno l'emissione, non il salvataggio della bozza o del committente.
function text(max: number) {
  return z.string({ error: INVALID }).trim().transform(toLatin1)
    .pipe(z.string().min(1, { error: "Campo obbligatorio." }).max(max, { error: `Massimo ${max} caratteri.` }));
}
function optionalText(rule: z.ZodType<string, string> = z.string()) {
  return z.string({ error: INVALID }).nullable()
    .transform((value) => value === null || value.trim() === "" ? null : toLatin1(value.trim()))
    .pipe(rule.nullable());
}
const address = {
  addressLine: text(60),
  postalCode: text(5).pipe(z.string().regex(/^\d{5}$/, { error: "Scrivi il CAP con 5 cifre." })),
  city: text(60),
  province: text(2).pipe(z.string().regex(/^[A-Z]{2}$/, { error: "Scrivi la sigla della provincia, per esempio BO." })),
};

export const RecipientInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paziente"), patientId: uuid }).strict(),
  z.object({ kind: z.literal("tutore"), patientId: uuid, guardianId: uuid }).strict(),
  z.object({ kind: z.literal("committente"), billingPartyId: uuid }).strict(),
], { error: INVALID });
export type RecipientInput = z.input<typeof RecipientInput>;

const DraftLineInput = z.object({
  serviceId: uuid.nullable(), appointmentId: uuid.nullable(), description: text(1000),
  serviceDate: date.nullable(), quantity: z.int({ error: INVALID }).min(1).max(9999),
  unitPriceCents: z.int({ error: INVALID }).min(0).max(99999999),
}).strict();

export const DraftInput = z.object({
  // Id stabile scelto dal client per una nuova bozza; invoiceId resta l'id di una bozza già salvata.
  id: uuid.optional(),
  invoiceId: uuid.nullable(), recipient: RecipientInput,
  lines: z.array(DraftLineInput, { error: INVALID }).min(1).max(50),
  paymentMethod, paidOn: date.nullable(),
  stampMarkCode: optionalText(z.string().max(30)), internalNotes: optionalText(z.string().max(1000)),
}, { error: INVALID }).strict().refine((draft) => draft.id === undefined || draft.invoiceId === null || draft.id === draft.invoiceId, {
  error: INVALID, path: ["id"],
});
export type DraftInput = z.input<typeof DraftInput>;

export const InvoiceIdInput = z.object({ invoiceId: uuid }, { error: INVALID }).strict();
export type InvoiceIdInput = z.input<typeof InvoiceIdInput>;

export const PaymentInput = z.object({ invoiceId: uuid, method: paymentMethod, paidOn: date }, { error: INVALID }).strict();
export type PaymentInput = z.input<typeof PaymentInput>;

export const CancelInput = z.object({
  invoiceId: uuid, note: optionalText(z.string().max(500, { error: "Massimo 500 caratteri." })),
}, { error: INVALID }).strict();
export type CancelInput = z.input<typeof CancelInput>;

export const NoInvoiceInput = z.object({
  appointmentId: uuid,
  reason: z.enum(["compresa_in_altra", "gratuita", "altro"], { error: REASON_REQUIRED }),
}, { error: INVALID }).strict();
export type NoInvoiceInput = z.input<typeof NoInvoiceInput>;

export const BillingPartyInput = z.object({
  id: uuid.nullable(), name: text(80),
  vatNumber: optionalText(z.string().regex(/^\d{11}$/, { error: "Scrivi la partita IVA con 11 cifre." })),
  taxCode: optionalText(),
  ...address,
  recipientCode: text(7).pipe(z.string().regex(/^[A-Z0-9]{7}$/, { error: INVALID })).default("0000000"),
  pec: optionalText(z.string().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, { error: "Scrivi un indirizzo email valido." })),
  isWithholdingAgent: z.boolean({ error: INVALID }),
}, { error: INVALID }).strict().refine((v) => v.vatNumber !== null || v.taxCode !== null, {
  error: PARTY_CODE_REQUIRED, path: ["vatNumber"],
});
export type BillingPartyInput = z.input<typeof BillingPartyInput>;

// Nell'editor fattura un campo vuoto non cancella l'anagrafica già compilata.
function supplied(rule: z.ZodType<string, string>) {
  return z.string({ error: INVALID }).trim().transform((value) => value || undefined)
    .pipe(rule.optional()).optional();
}
const recipientFields = {
  taxCode: supplied(z.string()),
  address: z.object({
    addressLine: supplied(address.addressLine), postalCode: supplied(address.postalCode),
    city: supplied(address.city), province: supplied(address.province),
  }).strict().optional(),
};
export const RecipientFieldsInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paziente"), patientId: uuid, ...recipientFields }).strict(),
  z.object({ kind: z.literal("tutore"), patientId: uuid, guardianId: uuid, ...recipientFields }).strict(),
], { error: INVALID });
export type RecipientFieldsInput = z.input<typeof RecipientFieldsInput>;
