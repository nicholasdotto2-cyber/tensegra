import { timeOf, weekdayDayMonth } from "@/lib/format";
import { whatsappHref } from "@/lib/messages/links";
import { missingMessage, renderMessage, type MessageValues, type MissingMessage } from "@/lib/messages/render";
import { phoneDisplay } from "@/lib/phone";
import { DEFAULT_TEMPLATES, templateProblem, type TemplateKey, type Variant } from "@/lib/messages/templates";
import { type CopyDisabledCode, MESSAGE_MAX, MESSAGE_TOO_LONG, messageLength } from "@/lib/messages/texts";
import { daysBetween, todayRome, type Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { MessageTemplatePreviewInput } from "@/server/domain/settings/schemas";
import { getPracticeSettings, type PracticeSettingsView } from "@/server/domain/settings/queries";
import { getMessageRecipient, type MessageRecipient } from "./recipient";
import type { MessageSource } from "./schemas";

/** Un modello salvato prevale sul default, solo per uno studio accessibile. */
export async function getMessageTemplate(tx: Tx, practiceId: string, key: TemplateKey, variant: Variant): Promise<string | null> {
  if (!await getPracticeSettings(tx, practiceId)) return null;
  const [row] = await tx.query<{ body: string }>(
    `select body from public.message_templates where practice_id = $1 and key = $2 and variant = $3`,
    [practiceId, key, variant],
  );
  return row?.body ?? DEFAULT_TEMPLATES[key][variant];
}

export type MessageTemplateView = { key: TemplateKey; variant: Variant; body: string; isCustomized: boolean };

/** Tutte le dieci varianti, con il default per quelle non ancora persistite. */
export async function listMessageTemplates(tx: Tx, practiceId: string): Promise<MessageTemplateView[]> {
  if (!await getPracticeSettings(tx, practiceId)) return [];
  const saved = await tx.query<MessageTemplateView>(
    `select key, variant, body, is_customized as "isCustomized" from public.message_templates where practice_id = $1`, [practiceId],
  );
  return (Object.keys(DEFAULT_TEMPLATES) as TemplateKey[]).flatMap((key) =>
    (["tu", "lei"] as const).map((variant) => saved.find((t) => t.key === key && t.variant === variant)
      ?? { key, variant, body: DEFAULT_TEMPLATES[key][variant], isCustomized: false }),
  );
}

/** Variante dell'editor, contesti reali, sola lettura. Nessuna azione di invio o riga di registro. */
export async function previewMessageTemplate(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<{ text: string; missing: string[] }> {
  const { key, body, patientId } = MessageTemplatePreviewInput.parse(input);
  const problem = templateProblem(key, body);
  if (problem) throw new DomainError(problem, { field: "body" });
  const practice = await getPracticeSettings(tx, practiceId);
  const recipient = await getMessageRecipient(tx, practiceId, clock, patientId);
  if (!practice || !recipient) throw new DomainError(NOT_ALLOWED);
  const context: MessageContext = {};
  if (key === "richiamo") {
    const [done] = await tx.query<{ startsAt: Date }>(
      `select starts_at as "startsAt" from public.appointments
        where practice_id = $1 and patient_id = $2 and status = 'fatto'
        order by starts_at desc, id desc limit 1`, [practiceId, patientId],
    );
    context.lastDoneOn = done ? todayRome(done.startsAt) : null;
  } else if (key === "consigli") {
    const [visit] = await tx.query<{ id: string }>(
      `select v.id from public.visits v where v.practice_id = $1 and v.patient_id = $2
        and exists (select 1 from public.visit_advice a where a.practice_id = v.practice_id and a.visit_id = v.id and btrim(a.text) <> '')
        order by v.visit_date desc, v.created_at desc, v.id desc limit 1`, [practiceId, patientId],
    );
    const advice = visit ? await tx.query<{ text: string }>(
      `select text from public.visit_advice where practice_id = $1 and visit_id = $2 and btrim(text) <> '' order by created_at, id`,
      [practiceId, visit.id],
    ) : [];
    context.advice = advice.length ? advice.map((a) => a.text.trim()).join(" ") : null;
  } else {
    const [appointment] = await tx.query<{ startsAt: Date; durationMin: number }>(
      `select starts_at as "startsAt", duration_min as "durationMin" from public.appointments
        where practice_id = $1 and patient_id = $2 and status in ('prenotato', 'confermato') and starts_at >= $3
        order by starts_at, id limit 1`, [practiceId, patientId, clock.now()],
    );
    context.appointment = appointment ?? null;
  }
  return renderMessage(key, body, buildMessageValues(clock, practice, recipient, context));
}

export interface MessageContext {
  appointment?: { startsAt: Date; durationMin: number } | null;
  /** Giorno di Roma dell'ultimo appuntamento fatto, letto dalla sorgente autorizzata. */
  lastDoneOn?: string | null;
  advice?: string | null;
}

/** Valori di presentazione dai dati già autorizzati; nessuna data o consiglio di ripiego. */
export function buildMessageValues(clock: Clock, practice: PracticeSettingsView, recipient: MessageRecipient, context: MessageContext): MessageValues {
  const appointment = context.appointment;
  const day = appointment ? todayRome(appointment.startsAt) : null;
  const date = day ? weekdayDayMonth(day) : null;
  const minor = recipient.kind !== "paziente";
  const address = practice.addressLine?.trim();
  const city = practice.city?.trim();
  const firstName = practice.practitionerFirstName.trim();
  const lastName = practice.practitionerLastName.trim();
  return {
    nome: recipient.firstName.trim() || null,
    per_paziente: minor ? (recipient.patientFirstName ? ` per ${recipient.patientFirstName}` : null) : "",
    di_paziente: minor ? (recipient.patientFirstName ? ` di ${recipient.patientFirstName}` : null) : "",
    studio: practice.practiceName.trim() || null,
    indirizzo: address && city ? `${address}, ${city}` : null,
    telefono_studio: practice.phone ? phoneDisplay(practice.phone) : null,
    osteopata: firstName && lastName ? `${firstName} ${lastName}` : null,
    quando: day && date ? (daysBetween(clock.today(), day) === 1 ? `domani, ${date},` : date) : null,
    ora: appointment ? timeOf(appointment.startsAt) : null,
    durata: appointment ? `${appointment.durationMin} minuti` : null,
    settimane: context.lastDoneOn ? String(Math.floor(daysBetween(context.lastDoneOn, clock.today()) / 7)) : null,
    consigli: context.advice ?? null,
  };
}

const TEMPLATE_NAMES: Record<TemplateKey, string> = {
  conferma: "Conferma", promemoria: "Promemoria", spostamento: "Spostamento", richiamo: "Richiamo", consigli: "Consigli",
};
const NO_WHATSAPP = "Manca il consenso WhatsApp";
const NO_RECALL = "Manca il consenso ai richiami";
export { MESSAGE_TOO_LONG };

export type PreparedMessage = {
  source: MessageSource;
  patientId: string;
  templateKey: TemplateKey;
  recipient: MessageRecipient;
  body: string;
  missing: MissingMessage[];
  copyAllowed: boolean;
  copyDisabledReason: string | null;
  /** Il client rivaluta sul testo ritoccato solo "troppo_lungo". */
  copyDisabledCode: CopyDisabledCode | null;
  whatsappHref: string | null;
};

/** La sorgente riletta sotto RLS, con i motivi che valgono anche per il testo ritoccato a mano. */
export interface ResolvedMessage {
  prepared: PreparedMessage;
  appointmentId: string | null;
  visitId: string | null;
  /** Modello salvato non valido o consenso richiesto dal modello assente: niente copia né link. */
  copyProblem: string | null;
  /** Il primo motivo per cui il link WhatsApp non si apre. */
  whatsappProblem: string | null;
}

interface SourceContext { patientId: string; appointmentId: string | null; visitId: string | null; context: MessageContext }

async function loadSource(tx: Tx, practiceId: string, source: MessageSource): Promise<SourceContext | null> {
  if (source.kind === "appointment") {
    const [row] = await tx.query<{ patientId: string; startsAt: Date; durationMin: number }>(
      `select patient_id as "patientId", starts_at as "startsAt", duration_min as "durationMin"
         from public.appointments where practice_id = $1 and id = $2`,
      [practiceId, source.appointmentId],
    );
    if (!row) return null;
    return {
      patientId: row.patientId, appointmentId: source.appointmentId, visitId: null,
      context: { appointment: { startsAt: row.startsAt, durationMin: row.durationMin } },
    };
  }
  if (source.kind === "recall") {
    // L'ultimo fatto si legge qui e non da listRecalls, che userà questa funzione.
    const [patient] = await tx.query<{ id: string }>(
      "select id from public.patients where practice_id = $1 and id = $2",
      [practiceId, source.patientId],
    );
    if (!patient) return null;
    const [done] = await tx.query<{ startsAt: Date }>(
      `select starts_at as "startsAt" from public.appointments
        where practice_id = $1 and patient_id = $2 and status = 'fatto' order by starts_at desc limit 1`,
      [practiceId, source.patientId],
    );
    return {
      patientId: source.patientId, appointmentId: null, visitId: null,
      context: { lastDoneOn: done ? todayRome(done.startsAt) : null },
    };
  }
  const [visit] = await tx.query<{ patientId: string }>(
    `select patient_id as "patientId" from public.visits where practice_id = $1 and id = $2`,
    [practiceId, source.visitId],
  );
  if (!visit) return null;
  const ids = [...new Set(source.adviceIds)];
  const rows = await tx.query<{ id: string; text: string }>(
    "select id, text from public.visit_advice where practice_id = $1 and visit_id = $2 and id = any($3::uuid[])",
    [practiceId, source.visitId, ids],
  );
  // Ogni consiglio deve essere di questa visita: un id estraneo rifiuta l'intera sorgente.
  if (rows.length !== ids.length) return null;
  const text = new Map(rows.map((row) => [row.id, row.text.trim()]));
  return {
    patientId: visit.patientId, appointmentId: null, visitId: source.visitId,
    context: { advice: ids.map((id) => text.get(id)).join(" ") },
  };
}

/** Il numero che il link porta davvero, già con la sostituzione della demo; null per `wa.me/?text=`. */
export function linkPhone(href: string): string | null {
  const digits = /^https:\/\/wa\.me\/(\d*)\?/.exec(href)?.[1];
  return digits ? `+${digits}` : null;
}

/** Sorgente, destinatario, testo e permessi riletti sotto RLS: la base dell'anteprima e del registro. */
export async function resolveMessage(tx: Tx, practiceId: string, clock: Clock, source: MessageSource): Promise<ResolvedMessage | null> {
  const loaded = await loadSource(tx, practiceId, source);
  if (!loaded) return null;
  const recipient = await getMessageRecipient(tx, practiceId, clock, loaded.patientId);
  const practice = await getPracticeSettings(tx, practiceId);
  if (!recipient || !practice) return null;
  const templateKey = source.templateKey;
  const template = await getMessageTemplate(tx, practiceId, templateKey, recipient.addressing);
  if (template === null) return null;
  const values = buildMessageValues(clock, practice, recipient, loaded.context);
  let rendered: { text: string; missing: string[] };
  let templateError: string | null = null;
  // Solo la compilazione: un RangeError qui è il modello salvato, mai i valori.
  try {
    rendered = renderMessage(templateKey, template, values);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // Un modello salvato che le regole attuali rifiutano: un avviso con il link, non un errore della pagina.
    const variant = recipient.addressing === "tu" ? "Tu" : "Lei";
    templateError = `Il modello ${TEMPLATE_NAMES[templateKey]} (${variant}) non si può usare. ${error.message}`;
    rendered = { text: "", missing: ["modello"] };
  }
  const body = rendered.text;
  const missing: MissingMessage[] = rendered.missing.map((key) => missingMessage(key, loaded.patientId));
  const consentProblem = templateKey === "richiamo" && !recipient.recallConsent ? NO_RECALL
    : templateKey === "consigli" && !recipient.whatsappConsent ? NO_WHATSAPP : null;
  const copyProblem = templateError ?? consentProblem;
  const whatsappProblem = copyProblem ?? recipient.whatsappDisabledReason;
  const tooLong = messageLength(body) > MESSAGE_MAX;
  const copyDisabledReason = copyProblem ?? (tooLong ? MESSAGE_TOO_LONG : null);
  const copyDisabledCode: CopyDisabledCode | null = copyProblem ? "non_ammesso" : tooLong ? "troppo_lungo" : null;
  return {
    appointmentId: loaded.appointmentId,
    visitId: loaded.visitId,
    copyProblem,
    whatsappProblem,
    prepared: {
      source, patientId: loaded.patientId, templateKey, recipient, body, missing,
      copyAllowed: copyDisabledReason === null,
      copyDisabledReason,
      copyDisabledCode,
      whatsappHref: copyDisabledReason === null && whatsappProblem === null ? whatsappHref(recipient, body) : null,
    },
  };
}

/** Anteprima autorizzata: null se la sorgente non è dello studio o non lega paziente, visita e consigli. */
export async function prepareMessage(tx: Tx, practiceId: string, clock: Clock, source: MessageSource): Promise<PreparedMessage | null> {
  return (await resolveMessage(tx, practiceId, clock, source))?.prepared ?? null;
}

export type MessageLogRow = {
  id: string;
  patientId: string;
  appointmentId: string | null;
  visitId: string | null;
  templateKey: TemplateKey;
  recipientName: string;
  recipientPhone: string | null;
  body: string;
  action: "copiato" | "whatsapp_aperto";
  outcome: "da_confermare" | "inviato" | "non_inviato";
  createdAt: Date;
  outcomeAt: Date | null;
};

const LOG_COLUMNS = `id, patient_id as "patientId", appointment_id as "appointmentId", visit_id as "visitId",
  template_key as "templateKey", recipient_name as "recipientName", recipient_phone as "recipientPhone",
  body, action, outcome, created_at as "createdAt", outcome_at as "outcomeAt"`;
// A parità di istante vince l'ultima riga inserita, non l'UUID. record_order resta sul server.
const LOG_ORDER = "order by created_at desc, record_order desc";
const MAX_HISTORY = 100;

/** Cronologia del paziente: fino a 100 righe per la tab Messaggi, 3 per il Riepilogo. */
export async function listPatientMessages(tx: Tx, practiceId: string, patientId: string, limit: number = MAX_HISTORY): Promise<MessageLogRow[]> {
  const size = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_HISTORY) : MAX_HISTORY;
  return tx.query<MessageLogRow>(
    `select ${LOG_COLUMNS} from public.message_log where practice_id = $1 and patient_id = $2 ${LOG_ORDER} limit $3`,
    [practiceId, patientId, size],
  );
}

/** Nel dettaglio dell'appuntamento soltanto le sue righe. */
export async function listAppointmentMessages(tx: Tx, practiceId: string, appointmentId: string): Promise<MessageLogRow[]> {
  return tx.query<MessageLogRow>(
    `select ${LOG_COLUMNS} from public.message_log where practice_id = $1 and appointment_id = $2 ${LOG_ORDER} limit $3`,
    [practiceId, appointmentId, MAX_HISTORY],
  );
}
