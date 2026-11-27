import { createHash, randomUUID } from "node:crypto";
import type { ModuleKey } from "@/lib/consents/required";
import type { Tx } from "@/server/db/db";

// Righe di consenso e di scelta scritte a mano, solo per le fixture dei test db che non provano la firma: una
// insert per tabella, come utente dello studio, con RLS e trigger attivi. Il seed della demo non le usa più:
// firma, caricamento e revoca passano dai comandi veri. `rendered_hash` è lo sha256 del
// testo (check della tabella); la riga di `files` è un segnaposto da 1 byte, senza file nello store.

const RENDERED_TEXT = "Testo provvisorio del seed: il modulo vero arriva dopo.";
const MODULE_VERSION = "2026.1";
/** Il contenuto immaginario dei file segnaposto, da cui lo sha256 della riga di `files`. */
const PLACEHOLDER_FILE_TEXT = "File provvisorio del seed: nessun file su disco.";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface TemporaryConsent {
  patientId: string;
  moduleKey: ModuleKey;
  /** Il ciclo dei moduli al trattamento; null per l'informativa. */
  cycleId: string | null;
  /** "AAAA-MM-GG". */
  signedOn: string;
  signerKind: "paziente" | "genitore";
  signerName: string;
  /** Il genitore che firma per un minore. */
  guardianId: string | null;
  method: "tela" | "pdf_caricato";
}

/** La firma su tela è un PNG (`signature_file_id`), il modulo caricato un PDF (`document_file_id`). */
const FILE_OF = {
  tela: { kind: "signature", mimeType: "image/png", extension: "png" },
  pdf_caricato: { kind: "consent_upload", mimeType: "application/pdf", extension: "pdf" },
} as const;

/** Un consenso valido e accettato, con il suo file segnaposto, in una sola insert per tabella. */
export async function writeConsentTemporary(tx: Tx, practiceId: string, c: TemporaryConsent): Promise<{ id: string }> {
  const file = FILE_OF[c.method];
  const fileId = randomUUID();
  await tx.query(
    `insert into public.files (id, practice_id, kind, storage_key, mime_type, size_bytes, sha256)
     values ($1, $2, $3, $4, $5, 1, $6)`,
    [
      fileId,
      practiceId,
      file.kind,
      `${practiceId}/${file.kind}/${fileId}.${file.extension}`,
      file.mimeType,
      sha256Hex(PLACEHOLDER_FILE_TEXT),
    ],
  );
  const [row] = await tx.query<{ id: string }>(
    `insert into public.consent_records
       (practice_id, patient_id, cycle_id, module_key, module_version, rendered_text, rendered_hash,
        signer_kind, signer_name, guardian_id, method, signature_file_id, document_file_id, signed_on)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning id`,
    [
      practiceId,
      c.patientId,
      c.cycleId,
      c.moduleKey,
      MODULE_VERSION,
      RENDERED_TEXT,
      sha256Hex(RENDERED_TEXT),
      c.signerKind,
      c.signerName,
      c.guardianId,
      c.method,
      c.method === "tela" ? fileId : null,
      c.method === "pdf_caricato" ? fileId : null,
      c.signedOn,
    ],
  );
  if (!row) throw new Error("Il consenso di prova non è stato scritto.");
  return { id: row.id };
}

export interface TemporaryChoice {
  patientId: string;
  /** L'informativa in cui la scelta è stata espressa; null per una revoca fuori dal modulo. */
  consentRecordId: string | null;
  choice: "whatsapp" | "richiami";
  value: boolean;
  /** "AAAA-MM-GG". */
  decidedOn: string;
  mode: "modulo" | "messaggio";
}

/** Una scelta sul canale: una riga nuova, mai una modifica (la revoca è un'altra riga a false). */
export async function writeChoiceTemporary(tx: Tx, practiceId: string, c: TemporaryChoice): Promise<void> {
  await tx.query(
    `insert into public.consent_choices (practice_id, patient_id, consent_record_id, choice, value, decided_on, mode)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [practiceId, c.patientId, c.consentRecordId, c.choice, c.value, c.decidedOn, c.mode],
  );
}
