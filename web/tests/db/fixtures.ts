import { createHash, randomUUID } from "node:crypto";
import type { SqlParam, Tx } from "@/server/db/db";
import type { Values } from "./helpers";

// Banco di prova a due studi: l'utente A è owner dello studio A, l'utente B
// dello studio B. Ogni tabella di `public` ha almeno una riga per studio, così ogni caso di
// isolamento ha una riga "dell'altro" da cercare, aggiornare o cancellare.

export const USER_A = "a0000000-0000-4000-8000-00000000000a";
export const USER_B = "b0000000-0000-4000-8000-00000000000b";
export const PRACTICE_A = "a0000000-0000-4000-8000-000000000001";
export const PRACTICE_B = "b0000000-0000-4000-8000-000000000001";
/** Il file di fixture di ogni studio: tutte le chiavi verso `files` usano questi due, così `files` resta a 1 riga per studio. */
export const FILE_A = "a0000000-0000-4000-8000-0000000000f1";
export const FILE_B = "b0000000-0000-4000-8000-0000000000f1";

/**
 * Come una tabella di `public` entra nei test di isolamento (`isolation.test.ts`). Ogni
 * tabella nuova aggiunge qui la sua voce: senza, `rls-catalog.test.ts` fallisce.
 *
 * Contratto per chi aggiunge una voce:
 * - le scritture dei test sulle righe delle fixture girano in una transazione che torna sempre
 *   indietro, quindi nessun valore della fixture resta salvato e ogni test parte da `loadFixtures`;
 * - l'update di `updateColumn` gira anche senza where, quindi tocca tutte le righe di A: i trigger
 *   della tabella scattano lo stesso, anche se poi si torna indietro. Per le tabelle con un trigger
 *   di immutabilità la riga di fixture è aperta (ciclo `open`, visita `draft`, fattura `bozza`,
 *   consenso firmato) e `updateColumn` è una colonna che il trigger lascia cambiare; se non esiste,
 *   niente `updateColumn`;
 * - ogni chiave esterna verso un'altra tabella con `practice_id` è composta `(practice_id, x_id)`:
 *   lo controlla `rls-catalog.test.ts`. Per il caso 23503 serve `parent`: con la policy U basta
 *   `column` e `table`; se un trigger o un privilegio di colonna risponderebbe prima della chiave
 *   esterna (`consent_records`, `message_log`), o se non c'è la policy U, `parent` passa da
 *   `insertWithParent`;
 * - una tabella 1:1 con lo studio (`practice_settings`, `fiscal_settings`, `clinical_settings`)
 *   porta `oneRowPerPractice`: il caso "uA inserisce una sua riga e la vede" diventa "uA inserisce
 *   una seconda riga di A: 23505".
 */
export interface TableFixture {
  /** La colonna che lega la riga allo studio (`practice_id`, `id` per `practices`) o all'utente (`user_id`). */
  scope: "practice_id" | "id" | "user_id";
  /** Righe che `uA` e `uB` vedono dopo `loadFixtures`. */
  expectedA: number;
  expectedB: number;
  /** Le policy per `authenticated`: S select, I insert, U update, D delete. */
  policies: ReadonlyArray<"S" | "I" | "U" | "D">;
  /**
   * Inserisce una riga valida dello studio dato, senza `returning`: con `returning` Postgres
   * applica anche la policy di select alla riga nuova, e una policy di insert sbagliata non si
   * vedrebbe più. Gli id dei genitori vanno presi da costanti: uA non vede le righe di B.
   */
  insertFor?: (tx: Tx, practiceId: string) => Promise<unknown>;
  /**
   * Tabella 1:1 con lo studio, con `practice_id` come chiave: ogni studio ha già la sua riga, quindi
   * `insertFor` per lo stesso studio non può riuscire. Il caso di insert propria di
   * `isolation.test.ts` diventa un secondo insert di A che dà `23505`.
   */
  oneRowPerPractice?: true;
  /**
   * Il messaggio del `42501` dei casi "uA inserisce con practice_id di B" (`insert`) e "uA sposta le
   * sue righe su B" (`move`) di `isolation.test.ts`, dove a rispondere non è la policy della tabella ma
   * quella di un'altra tabella, un trigger o un privilegio di colonna. Senza, il caso vuole il messaggio
   * della RLS della tabella (`row-level security policy for table "<tabella>"`): così un `42501` arrivato
   * da altro non passa per una prova della policy. Accanto alla voce, il perché.
   */
  answeredBy?: { insert?: RegExp; move?: RegExp };
  /**
   * Colonna innocua per i test di update. Senza, la tabella non ha i casi di update e di delete
   * in `isolation.test.ts`: è il caso delle tabelle con privilegi ridotti, provate nel loro file
   * (`number_series` in `numbering.test.ts`).
   */
  updateColumn?: { column: string; value: SqlParam };
  /**
   * Chiave composta verso un genitore, per il caso "figlio di A verso genitore di B" (23503). Con
   * la policy U il caso è un update di `column`; senza U, per le tabelle in sola insert (scelte del
   * consenso, eventi della fattura), è `insertWithParent`: una riga valida dello studio dato con
   * `column` = `parentId`, senza `returning`. Se `insertWithParent` c'è, il caso è l'insert anche
   * con la policy U: serve dove un trigger o un privilegio di colonna risponderebbe all'update
   * prima della chiave esterna (`consent_records`, `message_log`).
   */
  parent?: {
    column: string;
    table: string;
    insertWithParent?: (tx: Tx, practiceId: string, parentId: string) => Promise<unknown>;
  };
}

// sha256 qualunque ma valido (64 cifre esadecimali): i test non leggono il contenuto dei file.
const SHA256 = "0123456789abcdef".repeat(4);

function insertFile(tx: Tx, practiceId: string, id: string = randomUUID()): Promise<unknown[]> {
  return tx.query(
    `insert into public.files (id, practice_id, kind, storage_key, mime_type, size_bytes, sha256)
     values ($1, $2, 'posture_photo', $3, 'image/jpeg', 1024, $4)`,
    [id, practiceId, `${practiceId}/posture_photo/${id}.jpg`, SHA256],
  );
}

// Id fissi delle righe di fixture con un `id` proprio: `NNN` = cifra della migrazione (1 = impostazioni)
// più due cifre di sequenza. Le tabelle 1:1 con lo studio non hanno `id`.
const OPENING_HOURS_A = "a0000000-0000-4000-8000-000000000101";
const OPENING_HOURS_B = "b0000000-0000-4000-8000-000000000101";

// Pazienti (migrazione 2). A ha tre pazienti, B due; il genitore sta sul minore (A3, B2). Le voci di
// anamnesi, gli apparati, lo stile di vita e la storia perinatale stanno sul primo paziente di ogni
// studio: i loro `insertFor` usano un altro paziente o un altro apparato, così non urtano le unique.
export const PHYSICIAN_A = "a0000000-0000-4000-8000-000000000201";
export const PHYSICIAN_B = "b0000000-0000-4000-8000-000000000201";
export const PATIENT_A1 = "a0000000-0000-4000-8000-000000000202";
export const PATIENT_A2 = "a0000000-0000-4000-8000-000000000203";
export const PATIENT_A3 = "a0000000-0000-4000-8000-000000000204";
export const PATIENT_B1 = "b0000000-0000-4000-8000-000000000202";
export const PATIENT_B2 = "b0000000-0000-4000-8000-000000000203";
export const GUARDIAN_A = "a0000000-0000-4000-8000-000000000205";
export const GUARDIAN_B = "b0000000-0000-4000-8000-000000000205";
const HISTORY_ITEM_A = "a0000000-0000-4000-8000-000000000206";
const HISTORY_ITEM_B = "b0000000-0000-4000-8000-000000000206";
const SYSTEMS_REVIEW_A = "a0000000-0000-4000-8000-000000000207";
const SYSTEMS_REVIEW_B = "b0000000-0000-4000-8000-000000000207";
const LIFESTYLE_A = "a0000000-0000-4000-8000-000000000208";
const LIFESTYLE_B = "b0000000-0000-4000-8000-000000000208";
const PERINATAL_A = "a0000000-0000-4000-8000-000000000209";
const PERINATAL_B = "b0000000-0000-4000-8000-000000000209";

// Listino (migrazione 3): una voce per studio, la seduta da 45 minuti che gli appuntamenti
// copiano. Il nome è diverso da "Seduta": i test del listino ne inseriscono una con quel nome.
export const SERVICE_A = "a0000000-0000-4000-8000-000000000301";
export const SERVICE_B = "b0000000-0000-4000-8000-000000000301";

// Cicli (migrazione 4): un ciclo di trattamento aperto sul primo paziente di ogni studio, con
// un'attività PSFS in posizione 1. Aperto, così l'update di `plan_note` passa `treatment_cycles_immutable`;
// l'attività ha il punteggio della visita, quindi il suo `updateColumn` la riscrive uguale (`psfs_items_guard`).
export const CYCLE_A = "a0000000-0000-4000-8000-000000000401";
export const CYCLE_B = "b0000000-0000-4000-8000-000000000401";
export const PSFS_ITEM_A = "a0000000-0000-4000-8000-000000000402";
export const PSFS_ITEM_B = "b0000000-0000-4000-8000-000000000402";

// Agenda (migrazione 5): una serie per studio e un appuntamento prenotato del primo paziente, sul
// suo ciclo aperto e con la seduta del listino: lunedì 5/10/2026 alle 09:00 di Roma, 45 minuti.
export const SERIES_A = "a0000000-0000-4000-8000-000000000501";
export const SERIES_B = "b0000000-0000-4000-8000-000000000501";
export const APPOINTMENT_A = "a0000000-0000-4000-8000-000000000502";
export const APPOINTMENT_B = "b0000000-0000-4000-8000-000000000502";

// Visita e cartella (migrazione 6): una visita in bozza sull'appuntamento della fixture, con una riga
// in ogni tabella figlia e una rettifica, un rinvio in bozza e una foto posturale del primo paziente.
// In bozza, così l'update di `updateColumn` passa i trigger di immutabilità della visita e delle figlie.
export const VISIT_A = "a0000000-0000-4000-8000-000000000601";
export const VISIT_B = "b0000000-0000-4000-8000-000000000601";
const PSFS_SCORE_A = "a0000000-0000-4000-8000-000000000602";
const PSFS_SCORE_B = "b0000000-0000-4000-8000-000000000602";
const SCREENING_ANSWER_A = "a0000000-0000-4000-8000-000000000603";
const SCREENING_ANSWER_B = "b0000000-0000-4000-8000-000000000603";
const SCREENING_OUTCOME_A = "a0000000-0000-4000-8000-000000000604";
const SCREENING_OUTCOME_B = "b0000000-0000-4000-8000-000000000604";
const REGION_FINDING_A = "a0000000-0000-4000-8000-000000000605";
const REGION_FINDING_B = "b0000000-0000-4000-8000-000000000605";
const TEST_RESULT_A = "a0000000-0000-4000-8000-000000000606";
const TEST_RESULT_B = "b0000000-0000-4000-8000-000000000606";
const TREATMENT_A = "a0000000-0000-4000-8000-000000000607";
const TREATMENT_B = "b0000000-0000-4000-8000-000000000607";
const ADVICE_A = "a0000000-0000-4000-8000-000000000608";
const ADVICE_B = "b0000000-0000-4000-8000-000000000608";
const AMENDMENT_A = "a0000000-0000-4000-8000-000000000609";
const AMENDMENT_B = "b0000000-0000-4000-8000-000000000609";
export const REFERRAL_A = "a0000000-0000-4000-8000-000000000610";
export const REFERRAL_B = "b0000000-0000-4000-8000-000000000610";
const ATTACHMENT_A = "a0000000-0000-4000-8000-000000000611";
const ATTACHMENT_B = "b0000000-0000-4000-8000-000000000611";

// Consensi (migrazione 7): l'informativa del primo paziente, firmata da lui sulla tela con il file dello
// studio il 5/10 e valida, e la sua scelta su WhatsApp espressa nel modulo. Un consenso è firmato fin
// dall'insert: l'update di `revocation_note` è fra i campi che `consent_records_immutable` lascia cambiare.
export const CONSENT_A = "a0000000-0000-4000-8000-000000000701";
export const CONSENT_B = "b0000000-0000-4000-8000-000000000701";
const CONSENT_CHOICE_A = "a0000000-0000-4000-8000-000000000702";
const CONSENT_CHOICE_B = "b0000000-0000-4000-8000-000000000702";

// Fatture (migrazione 8): un committente per studio, la fattura in bozza del primo paziente (forfettario, carta)
// con una riga sull'appuntamento della fixture, l'evento della sua creazione e l'export di settembre. In bozza,
// così l'update di `updateColumn` passa `invoices_immutable` e `invoice_lines_guard`.
export const BILLING_PARTY_A = "a0000000-0000-4000-8000-000000000801";
export const BILLING_PARTY_B = "b0000000-0000-4000-8000-000000000801";
export const INVOICE_A = "a0000000-0000-4000-8000-000000000802";
export const INVOICE_B = "b0000000-0000-4000-8000-000000000802";
export const INVOICE_LINE_A = "a0000000-0000-4000-8000-000000000803";
export const INVOICE_LINE_B = "b0000000-0000-4000-8000-000000000803";
const INVOICE_EVENT_A = "a0000000-0000-4000-8000-000000000804";
const INVOICE_EVENT_B = "b0000000-0000-4000-8000-000000000804";
const FISCAL_EXPORT_A = "a0000000-0000-4000-8000-000000000805";
const FISCAL_EXPORT_B = "b0000000-0000-4000-8000-000000000805";

// Messaggi (migrazione 9): il modello di conferma "lei" e la riga del registro con cui il primo paziente ha
// ricevuto la conferma dell'appuntamento della fixture, copiata e ancora da confermare. Da confermare, così
// l'update di `updateColumn` (l'esito) cambia davvero un valore.
const MESSAGE_TEMPLATE_A = "a0000000-0000-4000-8000-000000000901";
const MESSAGE_TEMPLATE_B = "b0000000-0000-4000-8000-000000000901";
export const MESSAGE_LOG_A = "a0000000-0000-4000-8000-000000000902";
export const MESSAGE_LOG_B = "b0000000-0000-4000-8000-000000000902";

/** Lo sha256 esadecimale minuscolo del testo in UTF-8, come lo vuole il check di `consent_records.rendered_hash`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Il testo dell'informativa con il nome di chi firma, congelato alla firma. */
function informativaText(signerName: string): string {
  return (
    "Informativa sul trattamento dei dati personali (art. 13 del Regolamento UE 2016/679). " +
    `Io sottoscritto/a ${signerName} dichiaro di aver ricevuto e letto l'informativa.`
  );
}

/** Il paziente di uno studio su cui un `insertFor` appende una riga: il primo, o il minore per i genitori. */
const firstPatientOf = (practiceId: string): string => (practiceId === PRACTICE_A ? PATIENT_A1 : PATIENT_B1);
const secondPatientOf = (practiceId: string): string => (practiceId === PRACTICE_A ? PATIENT_A2 : PATIENT_B2);
const minorPatientOf = (practiceId: string): string => (practiceId === PRACTICE_A ? PATIENT_A3 : PATIENT_B2);
const cycleOf = (practiceId: string): string => (practiceId === PRACTICE_A ? CYCLE_A : CYCLE_B);
const serviceOf = (practiceId: string): string => (practiceId === PRACTICE_A ? SERVICE_A : SERVICE_B);
const visitOf = (practiceId: string): string => (practiceId === PRACTICE_A ? VISIT_A : VISIT_B);
const fileOf = (practiceId: string): string => (practiceId === PRACTICE_A ? FILE_A : FILE_B);
const invoiceOf = (practiceId: string): string => (practiceId === PRACTICE_A ? INVOICE_A : INVOICE_B);

/** Un'informativa firmata sulla tela da `patientId` il 6/10, con la firma nel file dello studio. */
function insertInformativa(tx: Tx, practiceId: string, patientId: string): Promise<unknown[]> {
  const text = informativaText("Marta Gallo");
  return tx.query(
    `insert into public.consent_records (practice_id, patient_id, module_key, module_version, rendered_text, rendered_hash,
                                         signer_kind, signer_name, method, signature_file_id, signed_on)
     values ($1, $2, 'informativa', '2026.1', $3, $4, 'paziente', 'Marta Gallo', 'tela', $5, '2026-10-06')`,
    [practiceId, patientId, text, sha256Hex(text), fileOf(practiceId)],
  );
}

/** Una revoca a voce dei richiami da parte di `patientId` il 6/10, fuori da un'informativa. */
function insertChoice(tx: Tx, practiceId: string, patientId: string): Promise<unknown[]> {
  return tx.query(
    `insert into public.consent_choices (practice_id, patient_id, choice, value, decided_on, mode)
     values ($1, $2, 'richiami', false, '2026-10-06', 'verbale')`,
    [practiceId, patientId],
  );
}

/** Una modifica alla fattura `invoiceId` registrata il 6/10: una riga della cronologia della fattura. */
function insertInvoiceEvent(tx: Tx, practiceId: string, invoiceId: string): Promise<unknown[]> {
  return tx.query(
    `insert into public.invoice_events (practice_id, invoice_id, event_type, at)
     values ($1, $2, 'modificata', '2026-10-06T08:00:00Z')`,
    [practiceId, invoiceId],
  );
}

/** Un promemoria copiato per `patientId`: una riga del registro dei messaggi, senza appuntamento né visita. */
function insertMessageLog(tx: Tx, practiceId: string, patientId: string): Promise<unknown[]> {
  return tx.query(
    `insert into public.message_log (practice_id, patient_id, template_key, recipient_kind, recipient_name, body, action)
     values ($1, $2, 'promemoria', 'paziente', 'Marta Gallo', 'Buongiorno Marta, le ricordo la seduta di domani alle 9.', 'copiato')`,
    [practiceId, patientId],
  );
}

/** Come i test db emettono una fattura in bozza, senza XML né progressivo dell'invio. */
export interface InvoiceIssue {
  invoiceId: string;
  /** La `Data` del documento, `YYYY-MM-DD`: l'anno del numero è il suo, salvo `year`. */
  issueDate: string;
  /** Un anno del numero diverso da quello di `issueDate`, per provare il check. */
  year?: number;
  /** Un numero scelto a mano, al posto del prossimo di `app.next_number` (che vuole un utente dello studio). */
  number?: number;
  /** La data dell'incasso: la fattura passa a `pagata` invece che a `emessa`. */
  paidOn?: string;
}

/**
 * Emette la bozza con un update diretto: numero della serie del suo tipo (`TD01` o `TD04`) da `app.next_number`,
 * anno, etichetta (`14/2026`, `NC-1/2026`), data, istante e fotografia. Restituisce il numero.
 */
export async function issueInvoice(tx: Tx, issue: InvoiceIssue): Promise<number> {
  const [invoice] = await tx.query<{ practice_id: string; doc_type: string }>(
    "select practice_id, doc_type from public.invoices where id = $1",
    [issue.invoiceId],
  );
  if (!invoice) throw new Error("la fattura da emettere non c'è o non si vede");
  const year = issue.year ?? Number(issue.issueDate.slice(0, 4));
  let number = issue.number;
  if (number === undefined) {
    const [row] = await tx.query<{ n: number }>("select app.next_number($1, $2, $3) as n", [
      invoice.practice_id,
      invoice.doc_type,
      year,
    ]);
    number = row?.n;
  }
  if (number === undefined) throw new Error("app.next_number non ha dato un numero");
  const label = `${invoice.doc_type === "TD04" ? "NC-" : ""}${number}/${year}`;
  const snapshot = JSON.stringify({ numero: label, data: issue.issueDate });
  const issued = await tx.query(
    `update public.invoices
        set status = $2, year = $3, number = $4, number_label = $5, issue_date = $6, issued_at = $7, snapshot = $8,
            paid_on = coalesce($9::date, paid_on), paid_at = coalesce($10::timestamptz, paid_at)
      where id = $1
      returning id`,
    [
      issue.invoiceId,
      issue.paidOn ? "pagata" : "emessa",
      year,
      number,
      label,
      issue.issueDate,
      `${issue.issueDate}T09:00:00Z`,
      snapshot,
      issue.paidOn ?? null,
      issue.paidOn ? `${issue.paidOn}T09:00:00Z` : null,
    ],
  );
  if (issued.length !== 1) throw new Error("l'emissione non ha aggiornato la fattura");
  return number;
}

/** Una bozza di fattura di A1 in forfettario, pagata con carta, con i totali a zero (i valori per `invoices`). */
export const invoiceDraft = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  regime: "forfettario",
  recipient_kind: "paziente",
  patient_id: PATIENT_A1,
  payment_method: "carta",
  ...extra,
});

/** Inserisce una riga di una tabella figlia della visita, sulla visita in bozza dello studio. */
function insertVisitChild(
  tx: Tx,
  practiceId: string,
  table: string,
  columns: string,
  values: string,
): Promise<unknown[]> {
  return tx.query(`insert into public.${table} (practice_id, visit_id, ${columns}) values ($1, $2, ${values})`, [
    practiceId,
    visitOf(practiceId),
  ]);
}

/** Le voci di `TABLE_FIXTURES` delle 7 figlie della visita: tutte S, I, U, D e legate a `visits` da `visit_id`. */
function visitChild(insertFor: TableFixture["insertFor"], updateColumn: TableFixture["updateColumn"]): TableFixture {
  return {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U", "D"],
    insertFor,
    updateColumn,
    parent: { column: "visit_id", table: "visits" },
  };
}

export const TABLE_FIXTURES: Record<string, TableFixture> = {
  practices: {
    scope: "id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "U"],
    updateColumn: { column: "name", value: "Studio rinominato" },
  },
  memberships: {
    scope: "user_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S"],
  },
  files: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I"],
    insertFor: (tx, practiceId) => insertFile(tx, practiceId),
    updateColumn: { column: "original_name", value: "rinominato.jpg" },
  },
  number_series: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S"],
  },
  practice_settings: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    oneRowPerPractice: true,
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.practice_settings (practice_id, practitioner_first_name, practitioner_last_name)
         values ($1, 'Carla', 'Neri')`,
        [practiceId],
      ),
    updateColumn: { column: "practitioner_title", value: "Osteopata D.O." },
    parent: { column: "practitioner_signature_file_id", table: "files" },
  },
  opening_hours: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U", "D"],
    // La fixture ha il lunedì fascia 1: l'insert prende il martedì, così non urta la chiave (studio, giorno, fascia).
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.opening_hours (practice_id, weekday, slot, opens_at, closes_at)
         values ($1, 2, 1, '09:00', '13:00')`,
        [practiceId],
      ),
    updateColumn: { column: "closes_at", value: "13:30:00" },
  },
  fiscal_settings: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    oneRowPerPractice: true,
    insertFor: (tx, practiceId) => tx.query("insert into public.fiscal_settings (practice_id) values ($1)", [practiceId]),
    updateColumn: { column: "iban_holder", value: "Studio Prova" },
  },
  clinical_settings: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    oneRowPerPractice: true,
    insertFor: (tx, practiceId) =>
      tx.query("insert into public.clinical_settings (practice_id, active_test_codes) values ($1, '{}')", [practiceId]),
    updateColumn: { column: "default_recall_weeks", value: 8 },
  },
  physicians: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    insertFor: (tx, practiceId) =>
      tx.query("insert into public.physicians (practice_id, full_name, role) values ($1, 'Dott. Luca Neri', 'specialista')", [
        practiceId,
      ]),
    updateColumn: { column: "notes", value: "Riceve il martedì" },
  },
  patients: {
    scope: "practice_id",
    expectedA: 3,
    expectedB: 2,
    policies: ["S", "I", "U", "D"],
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.patients (practice_id, first_name, last_name, birth_date, addressing)
         values ($1, 'Marta', 'Gallo', '1992-11-03', 'lei')`,
        [practiceId],
      ),
    updateColumn: { column: "admin_notes", value: "Paga con carta" },
    parent: { column: "gp_physician_id", table: "physicians" },
  },
  patient_guardians: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U", "D"],
    // La fixture è il contatto e l'intestatario del minore: la seconda riga non può esserlo (unique parziali).
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.patient_guardians (practice_id, patient_id, relationship, first_name, last_name, is_contact, is_payer)
         values ($1, $2, 'padre', 'Paolo', 'Bianchi', false, false)`,
        [practiceId, minorPatientOf(practiceId)],
      ),
    updateColumn: { column: "email", value: "genitore@example.test" },
    parent: { column: "patient_id", table: "patients" },
  },
  patient_history_items: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    insertFor: (tx, practiceId) =>
      tx.query(
        "insert into public.patient_history_items (practice_id, patient_id, kind, label) values ($1, $2, 'allergia', 'Penicillina')",
        [practiceId, firstPatientOf(practiceId)],
      ),
    updateColumn: { column: "note", value: "Dal 2019" },
    parent: { column: "patient_id", table: "patients" },
  },
  patient_systems_review: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    // La fixture è l'apparato digerente: l'insert prende il respiratorio, così non urta la unique (studio, paziente, apparato).
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.patient_systems_review (practice_id, patient_id, system, reviewed_on)
         values ($1, $2, 'respiratorio', '2026-10-01')`,
        [practiceId, firstPatientOf(practiceId)],
      ),
    updateColumn: { column: "note", value: "Reflusso occasionale" },
    parent: { column: "patient_id", table: "patients" },
  },
  patient_lifestyle: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    // Una riga sola per paziente: la fixture sta sul primo, l'insert sul secondo.
    insertFor: (tx, practiceId) =>
      tx.query("insert into public.patient_lifestyle (practice_id, patient_id, occupation) values ($1, $2, 'Insegnante')", [
        practiceId,
        secondPatientOf(practiceId),
      ]),
    updateColumn: { column: "occupation", value: "Impiegata" },
    parent: { column: "patient_id", table: "patients" },
  },
  perinatal_histories: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    insertFor: (tx, practiceId) =>
      tx.query("insert into public.perinatal_histories (practice_id, patient_id) values ($1, $2)", [
        practiceId,
        secondPatientOf(practiceId),
      ]),
    updateColumn: { column: "notes", value: "Parto senza complicazioni" },
    parent: { column: "patient_id", table: "patients" },
  },
  services: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U", "D"],
    // La fixture è la seduta: l'insert prende la prima visita, così non urta l'indice sul nome delle voci attive.
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.services (practice_id, kind, name, invoice_description, duration_min, price_cents, color)
         values ($1, 'prima_visita', 'Prima visita osteopatica', 'Prima visita osteopatica', 60, 8000, 'oceano')`,
        [practiceId],
      ),
    updateColumn: { column: "sort_order", value: 5 },
  },
  treatment_cycles: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U", "D"],
    // Un solo ciclo aperto per paziente: la fixture sta sul primo, l'insert sul secondo.
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.treatment_cycles (practice_id, patient_id, opened_on, title, expected_sessions)
         values ($1, $2, '2026-10-15', 'Cervicalgia, ottobre 2026', 4)`,
        [practiceId, secondPatientOf(practiceId)],
      ),
    updateColumn: { column: "plan_note", value: "Una seduta a settimana per un mese" },
    // Il ciclo della fixture ha appuntamento e visita: a un update di patient_id risponderebbe prima
    // treatment_cycles_rules (23514). La chiave composta si prova con il medico inviante.
    parent: { column: "referring_physician_id", table: "physicians" },
  },
  psfs_items: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U", "D"],
    // La fixture è in posizione 1: l'insert prende la 2, così non urta la unique (studio, ciclo, posizione).
    insertFor: (tx, practiceId) =>
      tx.query(
        "insert into public.psfs_items (practice_id, cycle_id, position, activity) values ($1, $2, 2, 'Salire le scale')",
        [practiceId, cycleOf(practiceId)],
      ),
    // L'attività della fixture di A ha un punteggio, e psfs_items_guard non la lascia rinominare: l'update la
    // riscrive con il suo valore, che passa il trigger e prova lo stesso le policy (la riga di B ha un'altra attività).
    updateColumn: { column: "activity", value: "Stare seduta alla scrivania" },
    parent: { column: "cycle_id", table: "treatment_cycles" },
  },
  appointment_series: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.appointment_series (practice_id, weekday, local_time, interval_weeks, count)
         values ($1, 3, '18:00', 2, 3)`,
        [practiceId],
      ),
    updateColumn: { column: "count", value: 6 },
  },
  appointments: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U", "D"],
    // Lunedì 12/10/2026 alle 09:00 di Roma: una settimana dopo la fixture, sullo stesso ciclo.
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents)
         values ($1, $2, $3, $4, '2026-10-12T07:00:00Z', 45, 6000)`,
        [practiceId, firstPatientOf(practiceId), serviceOf(practiceId), cycleOf(practiceId)],
      ),
    updateColumn: { column: "notes", value: "Porta le lastre" },
    parent: { column: "service_id", table: "services" },
  },
  visits: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    // Una visita per appuntamento: l'insert crea prima un suo appuntamento, lunedì 12/10/2026 alle 09:00 di Roma.
    insertFor: async (tx, practiceId) => {
      const appointmentId = randomUUID();
      await tx.query(
        `insert into public.appointments (id, practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents)
         values ($1, $2, $3, $4, $5, '2026-10-12T07:00:00Z', 45, 6000)`,
        [appointmentId, practiceId, firstPatientOf(practiceId), serviceOf(practiceId), cycleOf(practiceId)],
      );
      return tx.query(
        `insert into public.visits (practice_id, patient_id, cycle_id, appointment_id, visit_date, kind, screening_catalog_version)
         values ($1, $2, $3, $4, '2026-10-12', 'seduta', 1)`,
        [practiceId, firstPatientOf(practiceId), cycleOf(practiceId), appointmentId],
      );
    },
    updateColumn: { column: "plan_next", value: "Controllo fra due settimane" },
    parent: { column: "cycle_id", table: "treatment_cycles" },
    // L'insert con lo studio B si ferma al suo appuntamento, sulla policy di appointments: la with check
    // di visits_insert la prova l'insert diretto con i genitori di A di rls-catalog.test.ts.
    answeredBy: { insert: /row-level security policy for table "appointments"/ },
  },
  // Il ciclo della fixture ha una sola attività PSFS, già valutata nella visita: l'insert crea prima
  // l'attività in posizione 2, così il punteggio non urta la unique (studio, attività, visita).
  psfs_scores: {
    ...visitChild(
      async (tx, practiceId) => {
        const itemId = randomUUID();
        await tx.query(
          "insert into public.psfs_items (id, practice_id, cycle_id, position, activity) values ($1, $2, $3, 2, 'Salire le scale')",
          [itemId, practiceId, cycleOf(practiceId)],
        );
        return tx.query(
          "insert into public.psfs_scores (practice_id, item_id, visit_id, score, phase) values ($1, $2, $3, 4, 'iniziale')",
          [practiceId, itemId, visitOf(practiceId)],
        );
      },
      { column: "score", value: 5 },
    ),
    // L'insert con lo studio B si ferma alla sua attività, sulla policy di psfs_items: la with check di
    // psfs_scores_insert la prova l'insert diretto con i genitori di A di rls-catalog.test.ts.
    answeredBy: { insert: /row-level security policy for table "psfs_items"/ },
  },
  // La fixture è la voce sugli anticoagulanti: l'insert prende un'altra voce.
  visit_screening_answers: visitChild(
    (tx, practiceId) =>
      insertVisitChild(tx, practiceId, "visit_screening_answers", "item_code, answer", "'osteoporosi', 'no'"),
    { column: "note", value: "Densitometria del 2025 nella norma" },
  ),
  // La fixture è la famiglia thrust: l'insert prende le tecniche dirette.
  visit_screening_outcomes: visitChild(
    (tx, practiceId) =>
      insertVisitChild(
        tx,
        practiceId,
        "visit_screening_outcomes",
        "family, suggested, outcome",
        "'direct', 'indicated', 'indicated'",
      ),
    { column: "override_note", value: "Nessuna controindicazione emersa" },
  ),
  // La fixture è la lombare, primaria: l'insert prende la dorsale, non primaria.
  visit_region_findings: visitChild(
    (tx, practiceId) =>
      insertVisitChild(tx, practiceId, "visit_region_findings", "region, severity, tenderness", "'thoracic', 1, true"),
    { column: "segment_note", value: "D5" },
  ),
  // La fixture è lo slump a destra: l'insert prende lo slump a sinistra.
  visit_test_results: visitChild(
    (tx, practiceId) =>
      insertVisitChild(tx, practiceId, "visit_test_results", "test_code, side, value_bool", "'slump', 'sx', false"),
    { column: "note", value: "Tensione senza dolore" },
  ),
  // La fixture è l'articolatoria sulla lombare: l'insert prende i tessuti molli sulla stessa regione.
  visit_treatments: visitChild(
    (tx, practiceId) =>
      insertVisitChild(
        tx,
        practiceId,
        "visit_treatments",
        "region, technique_code, family",
        "'lumbar', 'tessuti_molli', 'direct'",
      ),
    { column: "note", value: "Ben tollerata" },
  ),
  // Nessuna unique oltre all'id: un secondo consiglio sulla stessa visita entra.
  visit_advice: visitChild(
    (tx, practiceId) =>
      insertVisitChild(tx, practiceId, "visit_advice", "text", "'Alterna seduta e in piedi ogni ora'"),
    { column: "text", value: "Cammina venti minuti al giorno, in piano" },
  ),
  // Senza policy U: il caso del genitore di B è un insert.
  visit_amendments: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I"],
    insertFor: (tx, practiceId) =>
      insertVisitChild(
        tx,
        practiceId,
        "visit_amendments",
        "amended_at, reason, changes",
        `'2026-10-06T08:00:00Z', 'Aggiunto il tratto della disfunzione', '{}'`,
      ),
    updateColumn: { column: "reason", value: "Corretto il lato della disfunzione" },
    parent: {
      column: "visit_id",
      table: "visits",
      insertWithParent: (tx, practiceId, parentId) =>
        tx.query(
          `insert into public.visit_amendments (practice_id, visit_id, amended_at, reason, changes)
           values ($1, $2, '2026-10-06T08:00:00Z', 'Aggiunto il tratto della disfunzione', '{}')`,
          [practiceId, parentId],
        ),
    },
  },
  referrals: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.referrals (practice_id, patient_id, cycle_id, created_on, recipient_kind, reason, urgency,
                                       summary_text, request_text, recipient_free)
         values ($1, $2, $3, '2026-10-06', 'specialista', 'peggioramento', 'urgente',
                 'Lombalgia in peggioramento dopo tre sedute', 'Si chiede una valutazione ortopedica', 'Dott. Neri, ortopedico')`,
        [practiceId, firstPatientOf(practiceId), cycleOf(practiceId)],
      ),
    updateColumn: { column: "physician_reply_note", value: "Risonanza magnetica prescritta" },
    parent: { column: "patient_id", table: "patients" },
  },
  // La fixture usa il file dello studio, e un file sta in un solo allegato: l'insert crea prima un suo file.
  patient_attachments: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    insertFor: async (tx, practiceId) => {
      const fileId = randomUUID();
      await insertFile(tx, practiceId, fileId);
      return tx.query(
        `insert into public.patient_attachments (practice_id, patient_id, file_id, kind, view, taken_on)
         values ($1, $2, $3, 'foto_posturale', 'posteriore', '2026-10-05')`,
        [practiceId, firstPatientOf(practiceId), fileId],
      );
    },
    updateColumn: { column: "caption", value: "In piedi, a riposo" },
    parent: { column: "patient_id", table: "patients" },
    // L'insert con lo studio B si ferma al suo file, sulla policy di files: la with check di
    // patient_attachments_insert la prova l'insert diretto con i genitori di A di rls-catalog.test.ts.
    answeredBy: { insert: /row-level security policy for table "files"/ },
  },
  // Nessuna unique oltre all'id: una seconda informativa dello stesso paziente entra. Il caso del genitore
  // di B è un insert: all'update di patient_id risponderebbe prima consent_records_immutable (42501).
  consent_records: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    insertFor: (tx, practiceId) => insertInformativa(tx, practiceId, firstPatientOf(practiceId)),
    updateColumn: { column: "revocation_note", value: "Revoca comunicata a voce in studio" },
    parent: { column: "patient_id", table: "patients", insertWithParent: insertInformativa },
    // practice_id non è fra i campi che consent_records_immutable lascia cambiare: allo spostamento su B
    // risponde il trigger, che è before update e scatta prima della with check di consent_records_update.
    answeredBy: { move: /Un consenso firmato non si modifica: cambiano solo lo stato e la revoca/ },
  },
  // Senza policy U: il caso del genitore di B è un insert.
  consent_choices: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I"],
    insertFor: (tx, practiceId) => insertChoice(tx, practiceId, firstPatientOf(practiceId)),
    updateColumn: { column: "note", value: "Confermato al telefono" },
    parent: { column: "patient_id", table: "patients", insertWithParent: insertChoice },
  },
  // La fixture ha la partita IVA: l'insert prende un'associazione con il solo codice fiscale.
  billing_parties: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.billing_parties (practice_id, name, tax_code, address_line, postal_code, city, province)
         values ($1, 'Associazione Amici del Parco', '91234567890', 'Via del Parco 7', '40139', 'Bologna', 'BO')`,
        [practiceId],
      ),
    updateColumn: { column: "pec", value: "amministrazione@pec.example.test" },
  },
  // Nessuna unique sulle bozze (numero null): una seconda bozza dello stesso paziente entra.
  invoices: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U", "D"],
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.invoices (practice_id, regime, recipient_kind, patient_id, payment_method)
         values ($1, 'forfettario', 'paziente', $2, 'contanti')`,
        [practiceId, firstPatientOf(practiceId)],
      ),
    updateColumn: { column: "internal_notes", value: "Chiede la fattura anche per l'assicurazione" },
    parent: { column: "patient_id", table: "patients" },
  },
  // La fixture è la riga 1, sull'appuntamento della fixture: l'insert prende la 2, senza appuntamento, così non urta
  // né la unique (studio, fattura, riga) né l'indice di un appuntamento fatturato una volta.
  invoice_lines: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U", "D"],
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.invoice_lines (practice_id, invoice_id, line_number, line_kind, description, quantity,
                                           unit_price_cents, line_total_cents, vat_rate_bp, nature)
         values ($1, $2, 2, 'prestazione', 'Seduta di osteopatia del 28/09/2026', 1, 6000, 6000, 0, 'N2.2')`,
        [practiceId, invoiceOf(practiceId)],
      ),
    updateColumn: { column: "description", value: "Seduta di osteopatia del 5/10/2026" },
    parent: { column: "invoice_id", table: "invoices" },
  },
  // Senza policy U: il caso del genitore di B è un insert.
  invoice_events: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I"],
    insertFor: (tx, practiceId) => insertInvoiceEvent(tx, practiceId, invoiceOf(practiceId)),
    updateColumn: { column: "event_type", value: "modificata" },
    parent: { column: "invoice_id", table: "invoices", insertWithParent: insertInvoiceEvent },
  },
  fiscal_exports: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I"],
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.fiscal_exports (practice_id, period_from, period_to, documents_count, zip_sha256)
         values ($1, '2026-10-01', '2026-10-31', 3, $2)`,
        [practiceId, SHA256],
      ),
    updateColumn: { column: "documents_count", value: 9 },
  },
  // La fixture è la conferma "lei": l'insert prende il promemoria, così non urta la unique (studio, chiave, variante).
  message_templates: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    insertFor: (tx, practiceId) =>
      tx.query(
        `insert into public.message_templates (practice_id, key, variant, body)
         values ($1, 'promemoria', 'lei', 'Buongiorno {nome}, le ricordo la seduta di domani alle {ora}.')`,
        [practiceId],
      ),
    updateColumn: { column: "is_customized", value: true },
  },
  // Senza il privilegio di update su `patient_id` (solo l'esito si aggiorna), il caso del genitore di B
  // è un insert: all'update risponderebbe prima il privilegio di colonna (42501). `updateColumn` è l'esito.
  message_log: {
    scope: "practice_id",
    expectedA: 1,
    expectedB: 1,
    policies: ["S", "I", "U"],
    insertFor: (tx, practiceId) => insertMessageLog(tx, practiceId, firstPatientOf(practiceId)),
    updateColumn: { column: "outcome", value: "inviato" },
    parent: { column: "patient_id", table: "patients", insertWithParent: insertMessageLog },
    // authenticated non ha l'update di practice_id (solo dell'esito): allo spostamento su B risponde il
    // privilegio di colonna, controllato prima che la riga arrivi alla with check di message_log_update.
    answeredBy: { move: /permission denied for table message_log/ },
  },
};

/** Da eseguire come servizio: scrive anche in `auth.users`, che `authenticated` non vede. */
export async function loadFixtures(tx: Tx): Promise<void> {
  await tx.query("insert into auth.users (id, email) values ($1, 'ua@example.test'), ($2, 'ub@example.test')", [
    USER_A,
    USER_B,
  ]);
  await tx.query("insert into public.practices (id, name) values ($1, 'Studio A'), ($2, 'Studio B')", [
    PRACTICE_A,
    PRACTICE_B,
  ]);
  await tx.query(
    "insert into public.memberships (practice_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')",
    [PRACTICE_A, USER_A, PRACTICE_B, USER_B],
  );
  await insertFile(tx, PRACTICE_A, FILE_A);
  await insertFile(tx, PRACTICE_B, FILE_B);
  await tx.query(
    `insert into public.number_series (practice_id, series, year, last_number)
     values ($1, 'TD01', 2025, 7), ($2, 'TD01', 2025, 7)`,
    [PRACTICE_A, PRACTICE_B],
  );
  // Impostazioni (migrazione 1): firma null, solo i default per la parte fiscale, nessun test attivo.
  await tx.query(
    `insert into public.practice_settings (practice_id, practitioner_first_name, practitioner_last_name)
     values ($1, 'Anna', 'Rossi'), ($2, 'Bruno', 'Bianchi')`,
    [PRACTICE_A, PRACTICE_B],
  );
  await tx.query(
    `insert into public.opening_hours (id, practice_id, weekday, slot, opens_at, closes_at)
     values ($1, $2, 1, 1, '09:00', '13:00'), ($3, $4, 1, 1, '09:00', '13:00')`,
    [OPENING_HOURS_A, PRACTICE_A, OPENING_HOURS_B, PRACTICE_B],
  );
  await tx.query("insert into public.fiscal_settings (practice_id) values ($1), ($2)", [PRACTICE_A, PRACTICE_B]);
  await tx.query("insert into public.clinical_settings (practice_id, active_test_codes) values ($1, '{}'), ($2, '{}')", [
    PRACTICE_A,
    PRACTICE_B,
  ]);
  // Pazienti (migrazione 2): A tre pazienti, B due. Il primo paziente di ogni studio ha il medico
  // curante, l'ultimo è un minore con il genitore come contatto e intestatario.
  await tx.query(
    `insert into public.physicians (id, practice_id, full_name, role)
     values ($1, $2, 'Dott.ssa Anna Verdi', 'mmg'), ($3, $4, 'Dott. Piero Rinaldi', 'pediatra')`,
    [PHYSICIAN_A, PRACTICE_A, PHYSICIAN_B, PRACTICE_B],
  );
  await tx.query(
    `insert into public.patients (id, practice_id, first_name, last_name, birth_date, addressing, gp_physician_id)
     values ($1, $2, 'Giulia', 'Ferrari', '1984-03-09', 'lei', $3),
            ($4, $2, 'Luca', 'Romano', '1971-07-21', 'tu', null),
            ($5, $2, 'Sofia', 'Greco', '2016-02-14', 'tu', null),
            ($6, $7, 'Elena', 'Conti', '1990-12-02', 'lei', $8),
            ($9, $7, 'Matteo', 'Esposito', '2019-09-30', 'tu', null)`,
    [PATIENT_A1, PRACTICE_A, PHYSICIAN_A, PATIENT_A2, PATIENT_A3, PATIENT_B1, PRACTICE_B, PHYSICIAN_B, PATIENT_B2],
  );
  await tx.query(
    `insert into public.patient_guardians (id, practice_id, patient_id, relationship, first_name, last_name, is_contact, is_payer)
     values ($1, $2, $3, 'madre', 'Laura', 'Greco', true, true), ($4, $5, $6, 'padre', 'Andrea', 'Esposito', true, true)`,
    [GUARDIAN_A, PRACTICE_A, PATIENT_A3, GUARDIAN_B, PRACTICE_B, PATIENT_B2],
  );
  await tx.query(
    `insert into public.patient_history_items (id, practice_id, patient_id, kind, label)
     values ($1, $2, $3, 'trauma', 'Distorsione di caviglia'), ($4, $5, $6, 'intervento', 'Appendicectomia')`,
    [HISTORY_ITEM_A, PRACTICE_A, PATIENT_A1, HISTORY_ITEM_B, PRACTICE_B, PATIENT_B1],
  );
  await tx.query(
    `insert into public.patient_systems_review (id, practice_id, patient_id, system, reviewed_on)
     values ($1, $2, $3, 'digerente', '2026-10-01'), ($4, $5, $6, 'digerente', '2026-10-01')`,
    [SYSTEMS_REVIEW_A, PRACTICE_A, PATIENT_A1, SYSTEMS_REVIEW_B, PRACTICE_B, PATIENT_B1],
  );
  await tx.query(
    `insert into public.patient_lifestyle (id, practice_id, patient_id, occupation)
     values ($1, $2, $3, 'Commessa'), ($4, $5, $6, 'Muratore')`,
    [LIFESTYLE_A, PRACTICE_A, PATIENT_A1, LIFESTYLE_B, PRACTICE_B, PATIENT_B1],
  );
  await tx.query(
    `insert into public.perinatal_histories (id, practice_id, patient_id, gestational_age_weeks)
     values ($1, $2, $3, 39), ($4, $5, $6, 40)`,
    [PERINATAL_A, PRACTICE_A, PATIENT_A1, PERINATAL_B, PRACTICE_B, PATIENT_B1],
  );
  // Listino (migrazione 3): la seduta da 45 minuti, attiva, in entrambi gli studi.
  await tx.query(
    `insert into public.services (id, practice_id, kind, name, invoice_description, duration_min, price_cents, color)
     values ($1, $2, 'seduta', 'Seduta osteopatica', 'Seduta di osteopatia', 45, 6000, 'petrolio'),
            ($3, $4, 'seduta', 'Seduta osteopatica', 'Seduta di osteopatia', 45, 6000, 'petrolio')`,
    [SERVICE_A, PRACTICE_A, SERVICE_B, PRACTICE_B],
  );
  // Cicli (migrazione 4): un ciclo di trattamento aperto sul primo paziente, con un'attività PSFS.
  await tx.query(
    `insert into public.treatment_cycles (id, practice_id, patient_id, opened_on, title, expected_sessions)
     values ($1, $2, $3, '2026-10-01', 'Lombalgia, ottobre 2026', 4),
            ($4, $5, $6, '2026-10-01', 'Lombalgia, ottobre 2026', 4)`,
    [CYCLE_A, PRACTICE_A, PATIENT_A1, CYCLE_B, PRACTICE_B, PATIENT_B1],
  );
  await tx.query(
    `insert into public.psfs_items (id, practice_id, cycle_id, position, activity)
     values ($1, $2, $3, 1, 'Stare seduta alla scrivania'), ($4, $5, $6, 1, 'Sollevare il figlio')`,
    [PSFS_ITEM_A, PRACTICE_A, CYCLE_A, PSFS_ITEM_B, PRACTICE_B, CYCLE_B],
  );
  // Agenda (migrazione 5): una serie del lunedì alle 09:00 e un appuntamento prenotato sul ciclo
  // aperto del primo paziente (stato di default). La fine la scrive il trigger.
  await tx.query(
    `insert into public.appointment_series (id, practice_id, weekday, local_time, interval_weeks, count)
     values ($1, $2, 1, '09:00', 1, 4), ($3, $4, 1, '09:00', 1, 4)`,
    [SERIES_A, PRACTICE_A, SERIES_B, PRACTICE_B],
  );
  await tx.query(
    `insert into public.appointments (id, practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents)
     values ($1, $2, $3, $4, $5, '2026-10-05T07:00:00Z', 45, 6000),
            ($6, $7, $8, $9, $10, '2026-10-05T07:00:00Z', 45, 6000)`,
    [APPOINTMENT_A, PRACTICE_A, PATIENT_A1, SERVICE_A, CYCLE_A, APPOINTMENT_B, PRACTICE_B, PATIENT_B1, SERVICE_B, CYCLE_B],
  );
  // Visita e cartella (migrazione 6): la prima visita in bozza sull'appuntamento del 5/10, con una riga
  // in ogni tabella figlia, una rettifica, un rinvio in bozza al medico curante e una foto posturale.
  await tx.query(
    `insert into public.visits (id, practice_id, patient_id, cycle_id, appointment_id, visit_date, kind, screening_catalog_version)
     values ($1, $2, $3, $4, $5, '2026-10-05', 'prima_visita', 1),
            ($6, $7, $8, $9, $10, '2026-10-05', 'prima_visita', 1)`,
    [VISIT_A, PRACTICE_A, PATIENT_A1, CYCLE_A, APPOINTMENT_A, VISIT_B, PRACTICE_B, PATIENT_B1, CYCLE_B, APPOINTMENT_B],
  );
  await tx.query(
    `insert into public.psfs_scores (id, practice_id, item_id, visit_id, score, phase)
     values ($1, $2, $3, $4, 3, 'iniziale'), ($5, $6, $7, $8, 3, 'iniziale')`,
    [PSFS_SCORE_A, PRACTICE_A, PSFS_ITEM_A, VISIT_A, PSFS_SCORE_B, PRACTICE_B, PSFS_ITEM_B, VISIT_B],
  );
  await tx.query(
    `insert into public.visit_screening_answers (id, practice_id, visit_id, item_code, answer)
     values ($1, $2, $3, 'anticoagulanti', 'no'), ($4, $5, $6, 'anticoagulanti', 'no')`,
    [SCREENING_ANSWER_A, PRACTICE_A, VISIT_A, SCREENING_ANSWER_B, PRACTICE_B, VISIT_B],
  );
  await tx.query(
    `insert into public.visit_screening_outcomes (id, practice_id, visit_id, family, suggested, outcome)
     values ($1, $2, $3, 'thrust', 'indicated', 'indicated'), ($4, $5, $6, 'thrust', 'indicated', 'indicated')`,
    [SCREENING_OUTCOME_A, PRACTICE_A, VISIT_A, SCREENING_OUTCOME_B, PRACTICE_B, VISIT_B],
  );
  await tx.query(
    `insert into public.visit_region_findings (id, practice_id, visit_id, region, severity, restriction, is_primary)
     values ($1, $2, $3, 'lumbar', 2, true, true), ($4, $5, $6, 'lumbar', 2, true, true)`,
    [REGION_FINDING_A, PRACTICE_A, VISIT_A, REGION_FINDING_B, PRACTICE_B, VISIT_B],
  );
  await tx.query(
    `insert into public.visit_test_results (id, practice_id, visit_id, test_code, side, value_bool)
     values ($1, $2, $3, 'slump', 'dx', true), ($4, $5, $6, 'slump', 'dx', true)`,
    [TEST_RESULT_A, PRACTICE_A, VISIT_A, TEST_RESULT_B, PRACTICE_B, VISIT_B],
  );
  await tx.query(
    `insert into public.visit_treatments (id, practice_id, visit_id, region, technique_code, family)
     values ($1, $2, $3, 'lumbar', 'articolatoria', 'direct'), ($4, $5, $6, 'lumbar', 'articolatoria', 'direct')`,
    [TREATMENT_A, PRACTICE_A, VISIT_A, TREATMENT_B, PRACTICE_B, VISIT_B],
  );
  await tx.query(
    `insert into public.visit_advice (id, practice_id, visit_id, text)
     values ($1, $2, $3, 'Cammina venti minuti al giorno'), ($4, $5, $6, 'Cammina venti minuti al giorno')`,
    [ADVICE_A, PRACTICE_A, VISIT_A, ADVICE_B, PRACTICE_B, VISIT_B],
  );
  await tx.query(
    `insert into public.visit_amendments (id, practice_id, visit_id, amended_at, reason, changes)
     values ($1, $2, $3, '2026-10-05T10:00:00Z', 'Corretta la severità della lombare', '{"severity": {"before": 3, "after": 2}}'),
            ($4, $5, $6, '2026-10-05T10:00:00Z', 'Corretta la severità della lombare', '{"severity": {"before": 3, "after": 2}}')`,
    [AMENDMENT_A, PRACTICE_A, VISIT_A, AMENDMENT_B, PRACTICE_B, VISIT_B],
  );
  await tx.query(
    `insert into public.referrals (id, practice_id, patient_id, cycle_id, visit_id, created_on, recipient_kind, physician_id,
                                   reason, urgency, summary_text, request_text)
     values ($1, $2, $3, $4, $5, '2026-10-05', 'medico_curante', $6, 'sintomi_persistenti', 'programmato',
             'Lombalgia da tre settimane, senza segni neurologici', 'Si chiede una valutazione clinica'),
            ($7, $8, $9, $10, $11, '2026-10-05', 'medico_curante', $12, 'sintomi_persistenti', 'programmato',
             'Lombalgia da tre settimane, senza segni neurologici', 'Si chiede una valutazione clinica')`,
    [
      ...[REFERRAL_A, PRACTICE_A, PATIENT_A1, CYCLE_A, VISIT_A, PHYSICIAN_A],
      ...[REFERRAL_B, PRACTICE_B, PATIENT_B1, CYCLE_B, VISIT_B, PHYSICIAN_B],
    ],
  );
  await tx.query(
    `insert into public.patient_attachments (id, practice_id, patient_id, visit_id, cycle_id, file_id, kind, view, taken_on)
     values ($1, $2, $3, $4, $5, $6, 'foto_posturale', 'anteriore', '2026-10-05'),
            ($7, $8, $9, $10, $11, $12, 'foto_posturale', 'anteriore', '2026-10-05')`,
    [
      ...[ATTACHMENT_A, PRACTICE_A, PATIENT_A1, VISIT_A, CYCLE_A, FILE_A],
      ...[ATTACHMENT_B, PRACTICE_B, PATIENT_B1, VISIT_B, CYCLE_B, FILE_B],
    ],
  );
  // Consensi (migrazione 7): l'informativa del primo paziente, firmata sulla tela e valida, senza il PDF
  // (document_file_id null), e il sì a WhatsApp espresso nel modulo.
  const textA = informativaText("Giulia Ferrari");
  const textB = informativaText("Elena Conti");
  await tx.query(
    `insert into public.consent_records (id, practice_id, patient_id, module_key, module_version, rendered_text,
                                         rendered_hash, signer_kind, signer_name, method, signature_file_id, signed_on)
     values ($1, $2, $3, 'informativa', '2026.1', $4, $5, 'paziente', 'Giulia Ferrari', 'tela', $6, '2026-10-05'),
            ($7, $8, $9, 'informativa', '2026.1', $10, $11, 'paziente', 'Elena Conti', 'tela', $12, '2026-10-05')`,
    [
      ...[CONSENT_A, PRACTICE_A, PATIENT_A1, textA, sha256Hex(textA), FILE_A],
      ...[CONSENT_B, PRACTICE_B, PATIENT_B1, textB, sha256Hex(textB), FILE_B],
    ],
  );
  await tx.query(
    `insert into public.consent_choices (id, practice_id, patient_id, consent_record_id, choice, value, decided_on, mode)
     values ($1, $2, $3, $4, 'whatsapp', true, '2026-10-05', 'modulo'),
            ($5, $6, $7, $8, 'whatsapp', true, '2026-10-05', 'modulo')`,
    [
      ...[CONSENT_CHOICE_A, PRACTICE_A, PATIENT_A1, CONSENT_A],
      ...[CONSENT_CHOICE_B, PRACTICE_B, PATIENT_B1, CONSENT_B],
    ],
  );
  // Fatture (migrazione 8): una società sportiva con partita IVA come committente; la bozza del primo paziente in
  // forfettario, pagata con carta, con la riga della seduta del 5/10 (60 euro, natura N2.2, sotto la soglia del
  // bollo) e l'evento della creazione; l'export di settembre.
  await tx.query(
    `insert into public.billing_parties (id, practice_id, name, vat_number, address_line, postal_code, city, province)
     values ($1, $2, 'ASD Pallavolo Reno', '01234567890', 'Via dello Sport 3', '40128', 'Bologna', 'BO'),
            ($3, $4, 'ASD Pallavolo Reno', '01234567890', 'Via dello Sport 3', '40128', 'Bologna', 'BO')`,
    [BILLING_PARTY_A, PRACTICE_A, BILLING_PARTY_B, PRACTICE_B],
  );
  await tx.query(
    `insert into public.invoices (id, practice_id, regime, recipient_kind, patient_id, payment_method,
                                  fees_cents, taxable_cents, total_cents, net_cents)
     values ($1, $2, 'forfettario', 'paziente', $3, 'carta', 6000, 6000, 6000, 6000),
            ($4, $5, 'forfettario', 'paziente', $6, 'carta', 6000, 6000, 6000, 6000)`,
    [INVOICE_A, PRACTICE_A, PATIENT_A1, INVOICE_B, PRACTICE_B, PATIENT_B1],
  );
  await tx.query(
    `insert into public.invoice_lines (id, practice_id, invoice_id, line_number, line_kind, service_id, appointment_id,
                                       description, service_date, quantity, unit_price_cents, line_total_cents,
                                       vat_rate_bp, nature)
     values ($1, $2, $3, 1, 'prestazione', $4, $5, 'Seduta di osteopatia', '2026-10-05', 1, 6000, 6000, 0, 'N2.2'),
            ($6, $7, $8, 1, 'prestazione', $9, $10, 'Seduta di osteopatia', '2026-10-05', 1, 6000, 6000, 0, 'N2.2')`,
    [
      ...[INVOICE_LINE_A, PRACTICE_A, INVOICE_A, SERVICE_A, APPOINTMENT_A],
      ...[INVOICE_LINE_B, PRACTICE_B, INVOICE_B, SERVICE_B, APPOINTMENT_B],
    ],
  );
  await tx.query(
    `insert into public.invoice_events (id, practice_id, invoice_id, event_type, at)
     values ($1, $2, $3, 'creata', '2026-10-05T10:00:00Z'), ($4, $5, $6, 'creata', '2026-10-05T10:00:00Z')`,
    [INVOICE_EVENT_A, PRACTICE_A, INVOICE_A, INVOICE_EVENT_B, PRACTICE_B, INVOICE_B],
  );
  await tx.query(
    `insert into public.fiscal_exports (id, practice_id, period_from, period_to, documents_count, zip_sha256)
     values ($1, $2, '2026-09-01', '2026-09-30', 4, $3), ($4, $5, '2026-09-01', '2026-09-30', 4, $3)`,
    [FISCAL_EXPORT_A, PRACTICE_A, SHA256, FISCAL_EXPORT_B, PRACTICE_B],
  );
  // Messaggi (migrazione 9): il modello di conferma "lei" e il testo copiato per la conferma dell'appuntamento del
  // 5/10 (esito ancora da confermare), copiato la sera prima: con now() i test che ordinano per data dipendevano dal giorno.
  await tx.query(
    `insert into public.message_templates (id, practice_id, key, variant, body)
     values ($1, $2, 'conferma', 'lei', 'Buongiorno {nome}, le confermo la seduta di {giorno} alle {ora}.'),
            ($3, $4, 'conferma', 'lei', 'Buongiorno {nome}, le confermo la seduta di {giorno} alle {ora}.')`,
    [MESSAGE_TEMPLATE_A, PRACTICE_A, MESSAGE_TEMPLATE_B, PRACTICE_B],
  );
  await tx.query(
    `insert into public.message_log (id, practice_id, patient_id, appointment_id, template_key, recipient_kind,
                                     recipient_name, recipient_phone, body, action, created_at)
     values ($1, $2, $3, $4, 'conferma', 'paziente', 'Giulia Ferrari', '+393330000077',
             'Buongiorno Giulia, le confermo la seduta di lunedì alle 9.', 'copiato', '2026-10-04T18:00:00+02:00'),
            ($5, $6, $7, $8, 'conferma', 'paziente', 'Elena Conti', '+393330000088',
             'Buongiorno Elena, le confermo la seduta di lunedì alle 9.', 'copiato', '2026-10-04T18:00:00+02:00')`,
    [MESSAGE_LOG_A, PRACTICE_A, PATIENT_A1, APPOINTMENT_A, MESSAGE_LOG_B, PRACTICE_B, PATIENT_B1, APPOINTMENT_B],
  );
}
