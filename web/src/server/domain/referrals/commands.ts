import { REFERRAL_LOCKED } from "@/lib/clinical/labels";
import { buildReferralSummary, DEFAULT_REQUEST_TEXT } from "@/lib/clinical/referral-summary";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { loadVisit } from "@/server/domain/visits/ops/screening";
import { storageKey } from "@/server/files/keys";
import { referralFacts, referralSuggestion } from "./queries";
import { DeliveredInput, NewReferralInput, UpdateReferralInput } from "./schemas";

// Comandi del rinvio al medico. Il rinvio nasce in bozza
// con la sintesi generata una volta; il contenuto si modifica solo in bozza e prima del PDF; la consegna
// vuole l'assenso del paziente. Il PDF lo scrive `ensureReferralPdf` (src/server/pdf/referral-file.ts)
// con `attachReferralLetter`, e da lì la lettera non cambia (trigger `referrals_letter_guard`, 42501).
// Nessun comando scrive `status` diverso da bozza e consegnata (`stampata` e `inviata` non hanno azioni),
// `created_by` né `created_at`.

export const NEEDS_CYCLE = "Per un rinvio serve un ciclo.";
export const EDIT_LOCKED = REFERRAL_LOCKED;
export const NEEDS_AGREEMENT = "Serve l'assenso del paziente a condividere queste informazioni.";
export const DELIVERY_IN_FUTURE = "La consegna non può essere nel futuro.";
export const DELIVERY_BEFORE_LETTER = "La consegna non può precedere la lettera.";

async function belongsToPatient(tx: Tx, practiceId: string, patientId: string, cycleId: string): Promise<boolean> {
  const rows = await tx.query("select 1 from public.treatment_cycles where practice_id = $1 and id = $2 and patient_id = $3", [
    practiceId,
    cycleId,
    patientId,
  ]);
  return rows.length > 0;
}

/** Il ciclo aperto del paziente, altrimenti il più recente; null senza cicli. */
async function defaultCycle(tx: Tx, practiceId: string, patientId: string): Promise<string | null> {
  const [row] = await tx.query<{ id: string }>(
    `select id from public.treatment_cycles
      where practice_id = $1 and patient_id = $2
      order by (status = 'open') desc, opened_on desc, created_at desc, id desc
      limit 1`,
    [practiceId, patientId],
  );
  return row?.id ?? null;
}

/**
 * "Nuovo rinvio" e «Prepara rinvio»: il rinvio in bozza al medico curante del paziente (se in rubrica),
 * con motivo e urgenza dati o proposti dai promemoria della visita (`referralSuggestion`), la sintesi
 * generata sui fatti del ciclo e la richiesta predefinita. `created_on` è il giorno della lettera, oggi
 * per l'orologio del comando: la lettera nasce quando l'osteopata la prepara.
 */
export async function createReferral(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: unknown,
): Promise<{ id: string; patientId: string }> {
  const r = NewReferralInput.parse(input);
  const [patient] = await tx.query<{ gpId: string | null }>(
    'select gp_physician_id as "gpId" from public.patients where practice_id = $1 and id = $2',
    [practiceId, r.patientId],
  );
  // Un paziente che non c'è, o è di un altro studio, si ferma qui.
  if (!patient) throw new DomainError(NOT_ALLOWED);

  let cycleId: string;
  const visitId = r.visitId ?? null;
  if (visitId !== null) {
    const visit = await loadVisit(tx, practiceId, visitId);
    if (!visit || visit.patientId !== r.patientId) throw new DomainError(NOT_ALLOWED);
    if (r.cycleId !== undefined && r.cycleId !== visit.cycleId) throw new DomainError(NOT_ALLOWED);
    cycleId = visit.cycleId;
  } else if (r.cycleId !== undefined) {
    if (!(await belongsToPatient(tx, practiceId, r.patientId, r.cycleId))) throw new DomainError(NOT_ALLOWED);
    cycleId = r.cycleId;
  } else {
    const found = await defaultCycle(tx, practiceId, r.patientId);
    if (found === null) throw new DomainError(NEEDS_CYCLE);
    cycleId = found;
  }

  const suggestion = await referralSuggestion(tx, practiceId, cycleId, visitId);
  const reason = r.reason ?? suggestion.reason;
  const facts = await referralFacts(tx, practiceId, cycleId, visitId);
  const [row] = await tx.query<{ id: string }>(
    `insert into public.referrals
       (practice_id, patient_id, cycle_id, visit_id, created_on, recipient_kind, physician_id, reason, urgency,
        summary_text, request_text)
     values ($1, $2, $3, $4, $5, 'medico_curante', $6, $7, $8, $9, $10)
     returning id`,
    [
      practiceId,
      r.patientId,
      cycleId,
      visitId,
      clock.today(),
      patient.gpId,
      reason,
      r.urgency ?? suggestion.urgency,
      buildReferralSummary({ ...facts, reason }),
      DEFAULT_REQUEST_TEXT,
    ],
  );
  if (!row) throw new DomainError(NOT_ALLOWED);
  return { id: row.id, patientId: r.patientId };
}

interface CurrentReferral {
  status: string;
  letterFileId: string | null;
  recipientKind: string;
  physicianId: string | null;
  recipientFree: string | null;
  reason: string;
  urgency: string;
  summaryText: string;
  requestText: string;
}

async function currentReferral(tx: Tx, practiceId: string, referralId: string): Promise<CurrentReferral | null> {
  const [row] = await tx.query<CurrentReferral>(
    `select status,
            letter_file_id as "letterFileId",
            recipient_kind as "recipientKind",
            physician_id as "physicianId",
            recipient_free as "recipientFree",
            reason,
            urgency,
            summary_text as "summaryText",
            request_text as "requestText"
       from public.referrals
      where practice_id = $1 and id = $2`,
    [practiceId, referralId],
  );
  return row ?? null;
}

/**
 * Il modulo della lettera: destinatario, motivo, urgenza, sintesi, richiesta e assenso. Il contenuto si
 * scrive solo in bozza e prima del PDF; dopo il PDF, in bozza, cambia solo l'assenso (la lettera stampata
 * senza assenso si consegna quando il paziente lo dà). Un medico che non è in rubrica nello
 * studio, o un rinvio di un altro studio, risponde "Operazione non permessa".
 */
export async function updateReferral(tx: Tx, practiceId: string, _clock: Clock, input: unknown): Promise<void> {
  const u = UpdateReferralInput.parse(input);
  const current = await currentReferral(tx, practiceId, u.referralId);
  if (!current) throw new DomainError(NOT_ALLOWED);

  if (current.status !== "bozza" || current.letterFileId !== null) {
    const sameContent =
      current.recipientKind === u.recipientKind &&
      current.physicianId === u.physicianId &&
      current.recipientFree === u.recipientFree &&
      current.reason === u.reason &&
      current.urgency === u.urgency &&
      current.summaryText === u.summaryText &&
      current.requestText === u.requestText;
    if (current.status !== "bozza" || !sameContent) throw new DomainError(EDIT_LOCKED);
    // La stessa condizione nell'update: una consegna arrivata dopo la lettura non si scavalca.
    const agreed = await tx.query(
      `update public.referrals set patient_agreed_to_share = $3
        where practice_id = $1 and id = $2 and status = 'bozza'
        returning id`,
      [practiceId, u.referralId, u.patientAgreedToShare],
    );
    if (agreed.length === 0) throw new DomainError(EDIT_LOCKED);
    return;
  }

  if (u.physicianId !== null) {
    const rows = await tx.query("select 1 from public.physicians where practice_id = $1 and id = $2", [
      practiceId,
      u.physicianId,
    ]);
    if (rows.length === 0) throw new DomainError(NOT_ALLOWED, { field: "physicianId" });
  }
  // Le stesse condizioni nell'update: un PDF o una consegna arrivati dopo la lettura non si scavalcano.
  const updated = await tx.query(
    `update public.referrals
        set recipient_kind = $3, physician_id = $4, recipient_free = $5, reason = $6, urgency = $7,
            summary_text = $8, request_text = $9, patient_agreed_to_share = $10
      where practice_id = $1 and id = $2 and status = 'bozza' and letter_file_id is null
      returning id`,
    [
      practiceId,
      u.referralId,
      u.recipientKind,
      u.physicianId,
      u.recipientFree,
      u.reason,
      u.urgency,
      u.summaryText,
      u.requestText,
      u.patientAgreedToShare,
    ],
  );
  if (updated.length === 0) throw new DomainError(EDIT_LOCKED);
}

/**
 * "Segna come consegnata al paziente": dalla bozza, con l'assenso, scrive `consegnata_al_paziente` e il
 * giorno scelto dall'utente (proposto oggi dalla pagina), mai nel futuro né prima della lettera. Una lettera
 * già consegnata non si ri-consegna.
 */
export async function markReferralDelivered(tx: Tx, practiceId: string, clock: Clock, input: unknown): Promise<void> {
  const d = DeliveredInput.parse(input);
  const [current] = await tx.query<{ status: string; agreed: boolean; createdOn: string }>(
    `select status, patient_agreed_to_share as agreed, created_on as "createdOn"
       from public.referrals where practice_id = $1 and id = $2`,
    [practiceId, d.referralId],
  );
  if (!current || current.status !== "bozza") throw new DomainError(NOT_ALLOWED);
  if (!current.agreed) throw new DomainError(NEEDS_AGREEMENT, { field: "patientAgreedToShare" });
  // I giorni "AAAA-MM-GG" in ordine di testo sono in ordine di calendario; l'orologio è solo il limite.
  if (d.deliveredOn > clock.today()) throw new DomainError(DELIVERY_IN_FUTURE, { field: "deliveredOn" });
  if (d.deliveredOn < current.createdOn) throw new DomainError(DELIVERY_BEFORE_LETTER, { field: "deliveredOn" });
  await tx.query(
    `update public.referrals set status = 'consegnata_al_paziente', delivered_on = $3
      where practice_id = $1 and id = $2 and status = 'bozza'`,
    [practiceId, d.referralId, d.deliveredOn],
  );
}

/**
 * Il PDF della lettera, già scritto nello store da `ensureReferralPdf`: nella stessa transazione la riga
 * di `files` (`referral_pdf`) e `letter_file_id`, una volta sola. Se la lettera ha già il suo file (anche
 * salvato da un'altra richiesta nel frattempo) risponde «La lettera è già salvata: non si modifica.» e
 * la transazione non scrive niente.
 */
export async function attachReferralLetter(
  tx: Tx,
  practiceId: string,
  _clock: Clock,
  input: { referralId: string; file: { id: string; storageKey: string; size: number; sha256: string } },
): Promise<{ fileId: string }> {
  const { referralId, file } = input;
  const [current] = await tx.query<{ letterFileId: string | null }>(
    'select letter_file_id as "letterFileId" from public.referrals where practice_id = $1 and id = $2',
    [practiceId, referralId],
  );
  if (!current) throw new DomainError(NOT_ALLOWED);
  if (current.letterFileId !== null) throw new DomainError(EDIT_LOCKED);
  // La chiave è quella di questo studio e di questo file.
  if (file.storageKey !== storageKey(practiceId, "referral_pdf", file.id, "application/pdf")) {
    throw new DomainError(NOT_ALLOWED);
  }

  await tx.query(
    `insert into public.files (id, practice_id, kind, storage_key, mime_type, size_bytes, sha256)
     values ($1, $2, 'referral_pdf', $3, 'application/pdf', $4, $5)`,
    [file.id, practiceId, file.storageKey, file.size, file.sha256],
  );
  const updated = await tx.query(
    `update public.referrals set letter_file_id = $3
      where practice_id = $1 and id = $2 and letter_file_id is null
      returning id`,
    [practiceId, referralId, file.id],
  );
  // Un'altra transazione l'ha salvata fra la lettura e l'update: l'errore annulla anche la riga di files.
  if (updated.length === 0) throw new DomainError(EDIT_LOCKED);
  return { fileId: file.id };
}
