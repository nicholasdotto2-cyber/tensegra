import { whatsappHref } from "@/lib/messages/links";
import { toE164 } from "@/lib/phone";
import { DEFAULT_TEMPLATES, templateProblem, type TemplateKey, type Variant } from "@/lib/messages/templates";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { pgCode } from "@/server/db/errors";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { getPracticeSettings } from "@/server/domain/settings/queries";
import { MessageTemplateIdentityInput, MessageTemplateInput } from "@/server/domain/settings/schemas";
import { markAdviceMessagePrepared } from "./advice";
import { linkPhone, MESSAGE_TOO_LONG, resolveMessage } from "./queries";
import { RecordMessageInput, SetMessageOutcomeInput } from "./schemas";

// Registro dei messaggi: una riga dopo una copia riuscita, una copia
// manuale dichiarata o l'apertura del link. Sorgente, destinatario e permessi si rileggono qui, non solo
// nell'anteprima. L'azione non prova l'invio: l'esito parte da_confermare e lo dichiara l'osteopata. I consigli
// aggiungono `messaggio_copiato` alle righe scelte nella stessa transazione della riga del registro.

const EMPTY = "Scrivi il testo del messaggio.";
// La chiave primaria e la unique (practice_id, id): un id già usato, anche da un altro studio.
const ID_CONSTRAINTS = new Set(["message_log_pkey", "message_log_practice_id_id_key"]);

interface LoggedRow {
  patient_id: string;
  appointment_id: string | null;
  visit_id: string | null;
  template_key: string;
  body: string;
  action: string;
}

const SELECT_LOGGED = `select patient_id, appointment_id, visit_id, template_key, body, action
       from public.message_log where practice_id = $1 and id = $2`;

export async function recordMessage(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<{ id: string }> {
  const { id, source, body, action } = RecordMessageInput.parse(input);
  const resolved = await resolveMessage(tx, practiceId, clock, source);
  if (!resolved) throw new DomainError(NOT_ALLOWED);
  const { prepared } = resolved;
  // Il retry dello stesso tentativo non duplica la riga; un contenuto diverso sullo stesso id no.
  const same = (row: LoggedRow) => row.patient_id === prepared.patientId && row.appointment_id === resolved.appointmentId
    && row.visit_id === resolved.visitId && row.template_key === prepared.templateKey
    && row.body === body && row.action === action;
  const [existing] = await tx.query<LoggedRow>(SELECT_LOGGED, [practiceId, id]);
  if (existing) {
    if (!same(existing)) throw new DomainError(NOT_ALLOWED);
    return { id };
  }
  if (!body.trim()) throw new DomainError(EMPTY, { field: "body" });
  if (Array.from(body).length > 700) throw new DomainError(MESSAGE_TOO_LONG, { field: "body" });
  if (resolved.copyProblem) throw new DomainError(resolved.copyProblem);
  let phone: string | null;
  if (action === "whatsapp_aperto") {
    if (resolved.whatsappProblem) throw new DomainError(resolved.whatsappProblem);
    // Il link del testo finale ritoccato, non di quello compilato. Il numero è quello davvero
    // nel link: nella demo quello per le prove o nessuno, mai il cellulare del paziente.
    phone = linkPhone(whatsappHref(prepared.recipient, body));
  } else {
    phone = prepared.recipient.phone ? toE164(prepared.recipient.phone) : null;
  }
  // Prima della riga, dopo il controllo del retry: un errore del registro dopo questo punto annulla tutta la
  // transazione, rettifica compresa; il retry dello stesso id è già tornato sopra e non rettifica di nuovo.
  if (source.kind === "visit") await markAdviceMessagePrepared(tx, practiceId, clock, source);
  await tx.query("savepoint message_record");
  try {
    await tx.query(
      `insert into public.message_log (id, practice_id, patient_id, appointment_id, visit_id, template_key, recipient_kind,
                                       recipient_name, recipient_phone, body, action, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, practiceId, prepared.patientId, resolved.appointmentId, resolved.visitId, prepared.templateKey,
        prepared.recipient.kind, prepared.recipient.name, phone, body, action, clock.now()],
    );
    await tx.query("release savepoint message_record");
  } catch (error) {
    await tx.query("rollback to savepoint message_record");
    await tx.query("release savepoint message_record");
    if (pgCode(error) !== "23505" || !ID_CONSTRAINTS.has(String((error as { constraint?: unknown }).constraint))) throw error;
    // Doppio clic: l'altro tentativo ha scritto dopo la nostra select. Stessa riga dello studio: riuscito.
    // Riga diversa, o di un altro studio (invisibile): rifiuto generico, senza il 23505.
    const [raced] = await tx.query<LoggedRow>(SELECT_LOGGED, [practiceId, id]);
    // Per i consigli questa transazione ha già rettificato come l'altro tentativo: il rifiuto la annulla, e restano
    // la riga e la rettifica dell'altro, una volta sola.
    if (raced && same(raced) && source.kind !== "visit") return { id };
    throw new DomainError(NOT_ALLOWED);
  }
  return { id };
}

/** L'esito si dichiara e si corregge; testo e azione restano quelli registrati. */
export async function setMessageOutcome(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { id, outcome } = SetMessageOutcomeInput.parse(input);
  const [current] = await tx.query<{ outcome: string }>(
    "select outcome from public.message_log where practice_id = $1 and id = $2 for update",
    [practiceId, id],
  );
  if (!current) throw new DomainError(NOT_ALLOWED);
  if (current.outcome === outcome) return;
  const rows = await tx.query(
    "update public.message_log set outcome = $3, outcome_at = $4 where practice_id = $1 and id = $2 returning id",
    [practiceId, id, outcome, outcome === "da_confermare" ? null : clock.now()],
  );
  if (rows.length !== 1) throw new DomainError(NOT_ALLOWED);
}

async function writeTemplate(tx: Tx, practiceId: string, clock: Clock, key: TemplateKey, variant: Variant, body: string, isCustomized: boolean) {
  if (!await getPracticeSettings(tx, practiceId)) throw new DomainError(NOT_ALLOWED);
  await tx.query(
    `insert into public.message_templates (practice_id, key, variant, body, is_customized, created_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (practice_id, key, variant) do update set body = excluded.body, is_customized = excluded.is_customized`,
    [practiceId, key, variant, body, isCustomized, clock.now()],
  );
}

/** Valida prima di qualsiasi scrittura; il corpo resta letterale, anche per i caratteri astrali. */
export async function saveMessageTemplate(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { key, variant, body } = MessageTemplateInput.parse(input);
  const problem = templateProblem(key, body);
  if (problem) throw new DomainError(problem, { field: "body" });
  await writeTemplate(tx, practiceId, clock, key, variant, body, body !== DEFAULT_TEMPLATES[key][variant]);
}

/** Un solo modello e tono, senza cancellare righe né toccare le altre varianti. */
export async function restoreMessageTemplate(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { key, variant } = MessageTemplateIdentityInput.parse(input);
  await writeTemplate(tx, practiceId, clock, key, variant, DEFAULT_TEMPLATES[key][variant], false);
}
