import { z } from "zod";

// La sorgente di un messaggio: il browser indica solo da dove nasce, il server rilegge paziente,
// destinatario, valori e permessi. I consigli sono id di righe della visita, mai testo libero.
export const MessageSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("appointment"),
    appointmentId: z.uuid(),
    templateKey: z.enum(["conferma", "promemoria", "spostamento"]),
  }).strict(),
  z.object({ kind: z.literal("recall"), patientId: z.uuid(), templateKey: z.literal("richiamo") }).strict(),
  z.object({
    kind: z.literal("visit"),
    visitId: z.uuid(),
    adviceIds: z.array(z.uuid()).min(1).max(50),
    templateKey: z.literal("consigli"),
  }).strict(),
]);
export type MessageSource = z.infer<typeof MessageSourceSchema>;

/** `id` lo genera il client per tentativo e lo riusa nel retry del registro. */
export const RecordMessageInput = z.object({
  id: z.uuid(),
  source: MessageSourceSchema,
  body: z.string(),
  action: z.enum(["copiato", "whatsapp_aperto"]),
}).strict();

export const SetMessageOutcomeInput = z.object({
  id: z.uuid(),
  outcome: z.enum(["inviato", "non_inviato", "da_confermare"]),
}).strict();
