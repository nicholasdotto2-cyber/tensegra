import { z } from "zod";

const base = { patientId: z.uuid(), appointmentId: z.uuid().nullable(), guardianId: z.uuid().nullable() };
const variants = [
  { moduleKey: z.literal("informativa"), cycleId: z.null() },
  { moduleKey: z.literal("trattamento"), cycleId: z.uuid() },
  { moduleKey: z.literal("trattamento_minore"), cycleId: z.uuid() },
] as const;
export const ConsentTargetSchema = z.discriminatedUnion("moduleKey", [
  z.object({ ...base, ...variants[0] }).strict(),
  z.object({ ...base, ...variants[1] }).strict(),
  z.object({ ...base, ...variants[2] }).strict(),
]);
export type ConsentTarget = z.infer<typeof ConsentTargetSchema>;

const text = z.string().trim().transform(value => value || null).nullable();
const declarations = {
  id: z.uuid(), signerName: z.string().trim().min(1), outcome: z.enum(["accetta", "rifiuta"]),
  refusesInformation: z.boolean(), refusalNote: text, trusteeName: text, trusteeContact: text,
  minorOpinionNote: text, singleGuardianDeclaration: z.boolean(), secondGuardianName: text,
  notes: text, choices: z.object({ whatsapp: z.boolean(), richiami: z.boolean() }).strict().nullable(),
  previewHash: z.string().regex(/^[0-9a-f]{64}$/),
};
export const ConsentFieldsSchema = z.discriminatedUnion("moduleKey", [
  z.object({ ...base, ...variants[0], ...declarations }).strict(),
  z.object({ ...base, ...variants[1], ...declarations }).strict(),
  z.object({ ...base, ...variants[2], ...declarations }).strict(),
]);
export type ConsentFields = z.infer<typeof ConsentFieldsSchema>;

// Questi metadati sono prodotti dall'orchestratore server dopo checkUpload, come per le foto.
// Il comando non riceve byte o FileStore: non vanno esposti come campi del form client.
const StoredFileSchema = z.object({
  id: z.uuid(), storageKey: z.string().min(1), mime: z.enum(["image/png", "image/jpeg", "image/webp", "application/pdf"]),
  size: z.number().int().min(1).max(10485760), sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export const SignConsentInput = z.object({ fields: ConsentFieldsSchema, signature: StoredFileSchema, secondSignature: StoredFileSchema.nullable() }).strict();
export const UploadConsentInput = z.object({ fields: ConsentFieldsSchema, signedOn: z.iso.date(), document: StoredFileSchema }).strict();
const mode = z.enum(["verbale", "scritta", "messaggio"]);
const note = z.string().trim().max(300).nullable();
export const RevokeConsentInput = z.object({ id: z.uuid(), revokedOn: z.iso.date(), mode, note }).strict();
export const RecordChoiceInput = z.object({ patientId: z.uuid(), choice: z.enum(["whatsapp", "richiami"]), value: z.literal(false), decidedOn: z.iso.date(), mode, note }).strict();
