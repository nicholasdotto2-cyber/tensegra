import { createHash } from "node:crypto";
import { z } from "zod";
import { consentFitsAge } from "@/lib/consents/required";
import { MAX_FILE_BYTES } from "@/lib/files/messages";
import { dayField } from "@/lib/format";
import { type Clock, todayRome } from "@/server/clock";
import type { SqlParam, Tx } from "@/server/db/db";
import { pgCode } from "@/server/db/errors";
import type { StoredFileInput } from "@/server/domain/attachments/commands";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { storageKey } from "@/server/files/keys";
import { freezeConsent, getConsentPreview, type ConsentPreview } from "./preview";
import { type ConsentFields, type ConsentTarget, RecordChoiceInput, RevokeConsentInput, SignConsentInput, UploadConsentInput } from "./schemas";

const CHANGED = "Il modulo è cambiato: rileggilo prima di firmare.";
const LATER = "C'è già un consenso firmato dopo questa data: carica un documento con una data uguale o successiva.";
type Method = "tela" | "pdf_caricato";

function validateFields(fields: ConsentFields, preview: ConsentPreview, second: StoredFileInput | null, method: Method) {
  if (fields.previewHash !== preview.hash) throw new DomainError(CHANGED);
  if (fields.signerName !== preview.signerName) throw new DomainError(NOT_ALLOWED);
  if (fields.refusesInformation && !fields.refusalNote) throw new DomainError("Indica quali informazioni non desidera ricevere.", { field: "refusalNote" });
  if (!fields.refusesInformation && fields.refusalNote !== null) throw new DomainError(NOT_ALLOWED);
  if ((fields.moduleKey === "informativa") !== (fields.choices !== null)) throw new DomainError("Indica entrambe le scelte.", { field: "choices" });
  const represented = preview.signerKind !== "paziente";
  if (!represented && (fields.secondGuardianName || second || fields.singleGuardianDeclaration || fields.minorOpinionNote)) throw new DomainError(NOT_ALLOWED);
  if (method === "tela" && Boolean(fields.secondGuardianName) !== Boolean(second)) throw new DomainError("Compila il nome e la firma del secondo genitore.", { field: "secondGuardianName" });
  if (fields.moduleKey === "trattamento_minore" && !fields.secondGuardianName && !fields.singleGuardianDeclaration) throw new DomainError("Conferma la dichiarazione sull'altro genitore.", { field: "singleGuardianDeclaration" });
  if (fields.secondGuardianName && fields.singleGuardianDeclaration) throw new DomainError("La dichiarazione si usa solo con una firma.", { field: "singleGuardianDeclaration" });
}

function validateFile(practiceId: string, file: StoredFileInput, kind: "signature" | "consent_upload") {
  if (file.storageKey !== storageKey(practiceId, kind, file.id, file.mime) || (kind === "signature" ? file.mime !== "image/png" : !["application/pdf", "image/jpeg", "image/png"].includes(file.mime))) throw new DomainError(NOT_ALLOWED);
}

/** File già verificato dai byte sul server: chiave, tipo e legami vengono ricontrollati qui. */
async function registerFile(tx: Tx, practiceId: string, patientId: string, clock: Clock, file: StoredFileInput, kind: "signature" | "consent_upload") {
  validateFile(practiceId, file, kind);
  const [existing] = await tx.query<{ storageKey: string; mime: string; size: number; sha256: string; kind: string }>(
    "select storage_key as \"storageKey\", mime_type as mime, size_bytes as size, sha256, kind from public.files where practice_id=$1 and id=$2", [practiceId, file.id],
  );
  if (existing) {
    if (existing.storageKey !== file.storageKey || existing.mime !== file.mime || existing.size !== file.size || existing.sha256 !== file.sha256 || existing.kind !== kind) throw new DomainError(NOT_ALLOWED);
    const [otherPatient] = await tx.query(
      `select id from public.consent_records where practice_id=$1 and patient_id<>$2
       and ($3 in (signature_file_id, second_signature_file_id, document_file_id)) limit 1`, [practiceId, patientId, file.id],
    );
    if (otherPatient) throw new DomainError(NOT_ALLOWED);
    return;
  }
  const inserted = await tx.query(
    `insert into public.files (id, practice_id, kind, storage_key, mime_type, size_bytes, sha256, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing returning id`,
    [file.id, practiceId, kind, file.storageKey, file.mime, file.size, file.sha256, clock.now()],
  );
  if (inserted.length !== 1) throw new DomainError(NOT_ALLOWED);
}

const SELECT_RECORD = `select id, patient_id, cycle_id, module_key, module_version, rendered_text, rendered_hash,
  missing_fields, signer_kind, signer_name, guardian_id, second_guardian_name, method,
  signature_file_id, second_signature_file_id, practitioner_signature_file_id, document_file_id,
  signed_on, signed_at, outcome, refuses_information, refusal_note, trustee_name, trustee_contact,
  minor_opinion_note, demo, status, revoked_on, revocation_mode, revocation_note, created_at
  from public.consent_records where practice_id=$1 and id=$2`;

function equalValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a instanceof Date ? a.toISOString() : a) === JSON.stringify(b instanceof Date ? b.toISOString() : b);
}

/** L'orchestratore può aver allocato un nuovo UUID per gli stessi byte: non crea altri file. */
async function verifyRetryFile(tx: Tx, practiceId: string, savedId: unknown, file: StoredFileInput, kind: "signature" | "consent_upload") {
  validateFile(practiceId, file, kind);
  const [saved] = await tx.query<{ mime: string; size: number; sha256: string }>("select mime_type as mime, size_bytes as size, sha256 from public.files where practice_id=$1 and id=$2 and kind=$3", [practiceId, String(savedId), kind]);
  if (!saved || saved.mime !== file.mime || saved.size !== file.size || saved.sha256 !== file.sha256) throw new DomainError(NOT_ALLOWED);
  if (file.id !== savedId && (await tx.query("select id from public.files where practice_id=$1 and id=$2", [practiceId, file.id])).length > 0) throw new DomainError(NOT_ALLOWED);
}

async function collect(tx: Tx, practiceId: string, clock: Clock, fields: ConsentFields, method: Method, file: StoredFileInput, second: StoredFileInput | null, declaredDay: string): Promise<{ id: string }> {
  const [patient] = await tx.query<{ birthDate: string }>("select birth_date as \"birthDate\" from public.patients where practice_id=$1 and id=$2 for update", [practiceId, fields.patientId]);
  if (!patient) throw new DomainError(NOT_ALLOWED);
  const [existing] = await tx.query(SELECT_RECORD, [practiceId, fields.id]);
  // Un retry usa la data originale, senza spostare l'istante della firma.
  const signedOn = method === "tela" && existing ? String(existing.signed_on) : declaredDay;
  const signedAt = method === "tela" ? existing?.signed_at instanceof Date ? existing.signed_at : clock.now() : null;
  const target: ConsentTarget = { patientId: fields.patientId, cycleId: fields.cycleId, moduleKey: fields.moduleKey, appointmentId: fields.appointmentId, guardianId: fields.guardianId } as ConsentTarget;
  const collectedOn = existing?.created_at instanceof Date ? todayRome(existing.created_at) : clock.today();
  if (signedOn > clock.today()) throw new DomainError("La data della firma non può essere nel futuro.", { field: "signedOn" });
  // La stessa regola di loadValidConsents: una chiave che non va con l'età alla firma non conterebbe mai.
  if (!consentFitsAge(fields.moduleKey, patient.birthDate, signedOn)) {
    const message = fields.moduleKey === "trattamento"
      ? `Il paziente era minorenne il ${dayField(signedOn)}: serve il modulo per il minore.`
      : `Il paziente era maggiorenne il ${dayField(signedOn)}: serve il modulo per l'adulto.`;
    throw new DomainError(message, method === "pdf_caricato" ? { field: "signedOn" } : {});
  }
  const preview = await getConsentPreview(tx, practiceId, { today: () => collectedOn, now: () => clock.now() }, target, signedOn);
  if (!preview) throw new DomainError(NOT_ALLOWED);
  if (existing && fields.previewHash !== preview.hash) throw new DomainError(NOT_ALLOWED);
  validateFields(fields, preview, second, method);
  const rendered = freezeConsent(preview, fields, signedOn, signedAt?.toISOString() ?? null);
  // Un retry conserva anche il null delle righe raccolte prima della migrazione.
  const demo = existing && existing.demo === null ? null : preview.demo;
  const values: Record<string, SqlParam> = {
    id: fields.id, patient_id: fields.patientId, cycle_id: fields.cycleId, module_key: fields.moduleKey,
    module_version: preview.version, demo, rendered_text: rendered.text, rendered_hash: createHash("sha256").update(rendered.text).digest("hex"),
    missing_fields: rendered.missingFields, signer_kind: preview.signerKind, signer_name: preview.signerName,
    guardian_id: fields.guardianId, second_guardian_name: fields.secondGuardianName, method,
    signature_file_id: method === "tela" ? file.id : null, second_signature_file_id: second?.id ?? null,
    practitioner_signature_file_id: preview.practitionerSignatureFileId,
    document_file_id: method === "pdf_caricato" ? file.id : null, signed_on: signedOn, signed_at: signedAt,
    outcome: fields.outcome, refuses_information: fields.refusesInformation, refusal_note: fields.refusalNote,
    trustee_name: fields.trusteeName, trustee_contact: fields.trusteeContact, minor_opinion_note: fields.minorOpinionNote,
  };
  if (existing) {
    const fileColumns = ["signature_file_id", "second_signature_file_id", "document_file_id"];
    if (Object.entries(values).some(([key, value]) => !fileColumns.includes(key) && !equalValue(existing[key], value)) || Boolean(existing.second_signature_file_id) !== Boolean(second)) throw new DomainError(NOT_ALLOWED);
    const choices = await tx.query<{ choice: "whatsapp" | "richiami"; value: boolean }>("select choice, value from public.consent_choices where practice_id=$1 and consent_record_id=$2 order by choice", [practiceId, fields.id]);
    if (fields.choices && (choices.length !== 2 || choices.some(c => fields.choices?.[c.choice] !== c.value))) throw new DomainError(NOT_ALLOWED);
    await verifyRetryFile(tx, practiceId, method === "tela" ? existing.signature_file_id : existing.document_file_id, file, method === "tela" ? "signature" : "consent_upload");
    if (second) await verifyRetryFile(tx, practiceId, existing.second_signature_file_id, second, "signature");
    return { id: fields.id };
  }
  // Le due chiavi di trattamento di un ciclo sono un gruppo, come in loadValidConsents: un documento
  // più vecchio della decisione più recente non la sostituisce. Una revoca è una decisione: conta la sua data.
  const group = fields.moduleKey === "informativa" ? ["informativa"] : ["trattamento", "trattamento_minore"];
  const [newest] = await tx.query<{ day: string | null }>(
    `select max(greatest(signed_on, revoked_on)) as day from public.consent_records where practice_id=$1 and patient_id=$2
     and module_key = any($3::text[]) and cycle_id is not distinct from $4::uuid and status <> 'sostituito'`,
    [practiceId, fields.patientId, group, fields.cycleId],
  );
  if (newest?.day && signedOn < newest.day) throw new DomainError(LATER, { field: "signedOn" });
  // Il savepoint rende atomico il comando anche se un chiamante cattura DomainError nel tx.
  await tx.query("savepoint consent_collect");
  try {
    await registerFile(tx, practiceId, fields.patientId, clock, file, method === "tela" ? "signature" : "consent_upload");
    if (second) {
      if (second.id === file.id) throw new DomainError(NOT_ALLOWED);
      await registerFile(tx, practiceId, fields.patientId, clock, second, "signature");
    }
    if (!existing) {
      const columns = Object.keys(values);
      const rows = await tx.query(
        `insert into public.consent_records (practice_id, ${columns.join(", ")}, created_at)
         values ($1, ${columns.map((_, i) => `$${i + 2}`).join(", ")}, $${columns.length + 2})
         on conflict (id) do nothing returning id`, [practiceId, ...Object.values(values), clock.now()],
      );
      if (rows.length !== 1) throw new DomainError(NOT_ALLOWED);
      await tx.query(
        `update public.consent_records set status='sostituito' where practice_id=$1 and patient_id=$2
         and module_key = any($3::text[]) and cycle_id is not distinct from $4::uuid and status='valido' and id<>$5`,
        [practiceId, fields.patientId, group, fields.cycleId, fields.id],
      );
      if (fields.choices) {
        for (const choice of ["whatsapp", "richiami"] as const) {
          await tx.query(
            `insert into public.consent_choices (practice_id, patient_id, consent_record_id, choice, value, decided_on, mode, created_at)
             values ($1,$2,$3,$4,$5,$6,'modulo',$7)`,
            [practiceId, fields.patientId, fields.id, choice, fields.choices[choice], signedOn, clock.now()],
          );
        }
      }
    }
    await tx.query("release savepoint consent_collect");
    return { id: fields.id };
  } catch (error) {
    await tx.query("rollback to savepoint consent_collect");
    await tx.query("release savepoint consent_collect");
    if (pgCode(error) === "23505" && (error as { constraint?: string }).constraint === "consent_records_pkey") throw new DomainError(NOT_ALLOWED);
    throw error;
  }
}

export async function signConsent(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<{ id: string }> {
  const { fields, signature, secondSignature } = SignConsentInput.parse(input);
  return collect(tx, practiceId, clock, fields, "tela", signature, secondSignature, clock.today());
}

export async function uploadConsent(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<{ id: string }> {
  const { fields, document, signedOn } = UploadConsentInput.parse(input);
  return collect(tx, practiceId, clock, fields, "pdf_caricato", document, null, signedOn);
}

export async function revokeConsent(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { id, revokedOn, mode, note } = RevokeConsentInput.parse(input);
  const [record] = await tx.query(SELECT_RECORD + " for update", [practiceId, id]);
  if (!record) throw new DomainError(NOT_ALLOWED);
  if (revokedOn < String(record.signed_on)) throw new DomainError(`La revoca non può avere una data precedente alla firma del ${dayField(String(record.signed_on))}.`, { field: "revokedOn" });
  if (revokedOn > clock.today()) throw new DomainError("La data della revoca non può essere nel futuro.", { field: "revokedOn" });
  if (record.status === "revocato" && record.revoked_on === revokedOn && record.revocation_mode === mode && record.revocation_note === note) return;
  if (record.status !== "valido") throw new DomainError(NOT_ALLOWED);
  await tx.query("update public.consent_records set status='revocato', revoked_on=$3, revocation_mode=$4, revocation_note=$5 where practice_id=$1 and id=$2", [practiceId, id, revokedOn, mode, note]);
}

export async function recordChoice(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { patientId, choice, value, decidedOn, mode, note } = RecordChoiceInput.parse(input);
  const [patient] = await tx.query("select id from public.patients where practice_id=$1 and id=$2 for update", [practiceId, patientId]);
  if (!patient) throw new DomainError(NOT_ALLOWED);
  if (decidedOn > clock.today()) throw new DomainError("La data della revoca non può essere nel futuro.", { field: "decidedOn" });
  const [latest] = await tx.query<{ day: string }>("select decided_on as day from public.consent_choices where practice_id=$1 and patient_id=$2 and choice=$3 order by decided_on desc, created_at desc, record_order desc limit 1", [practiceId, patientId, choice]);
  if (latest && decidedOn < latest.day) throw new DomainError(`La revoca non può avere una data precedente al consenso del ${dayField(latest.day)}.`, { field: "decidedOn" });
  await tx.query("insert into public.consent_choices (practice_id, patient_id, consent_record_id, choice, value, decided_on, mode, note, created_at) values ($1,$2,null,$3,$4,$5,$6,$7,$8)", [practiceId, patientId, choice, value, decidedOn, mode, note, clock.now()]);
}

const AttachConsentDocumentInput = z.object({
  consentId: z.uuid(),
  file: z.object({
    id: z.uuid(), storageKey: z.string().min(1), mime: z.literal("application/pdf"),
    size: z.number().int().min(1).max(MAX_FILE_BYTES), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict();

/**
 * La transazione 2 della firma: registra il PDF generato fuori transazione e lo collega al consenso
 * firmato sulla tela, solo se il consenso non ha ancora un documento. Rilegge consenso e paziente nello
 * studio; un consenso che non c'è, caricato o che ha già il suo documento risponde NOT_ALLOWED, così il
 * secondo di due salvataggi non sostituisce il primo.
 */
export async function attachConsentDocument(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const { consentId, file } = AttachConsentDocumentInput.parse(input);
  const [record] = await tx.query<{ patientId: string; method: Method; documentFileId: string | null }>(
    `select patient_id as "patientId", method, document_file_id as "documentFileId"
       from public.consent_records where practice_id=$1 and id=$2 for update`,
    [practiceId, consentId],
  );
  if (!record || record.method !== "tela" || record.documentFileId !== null) throw new DomainError(NOT_ALLOWED);
  const [patient] = await tx.query("select id from public.patients where practice_id=$1 and id=$2", [practiceId, record.patientId]);
  if (!patient || file.storageKey !== storageKey(practiceId, "consent_pdf", file.id, file.mime)) throw new DomainError(NOT_ALLOWED);
  const inserted = await tx.query(
    `insert into public.files (id, practice_id, kind, storage_key, mime_type, size_bytes, sha256, created_at)
     values ($1,$2,'consent_pdf',$3,$4,$5,$6,$7) on conflict do nothing returning id`,
    [file.id, practiceId, file.storageKey, file.mime, file.size, file.sha256, clock.now()],
  );
  if (inserted.length !== 1) throw new DomainError(NOT_ALLOWED);
  const updated = await tx.query(
    "update public.consent_records set document_file_id=$3 where practice_id=$1 and id=$2 and document_file_id is null returning id",
    [practiceId, consentId, file.id],
  );
  if (updated.length !== 1) throw new DomainError(NOT_ALLOWED);
}
