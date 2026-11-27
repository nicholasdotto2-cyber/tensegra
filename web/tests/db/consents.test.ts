import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, SqlParam, Tx } from "@/server/db/db";
import {
  CONSENT_A,
  CONSENT_B,
  CYCLE_A,
  FILE_A,
  FILE_B,
  GUARDIAN_A,
  PATIENT_A1,
  PATIENT_A2,
  PATIENT_A3,
  PRACTICE_A,
  PRACTICE_B,
  sha256Hex,
} from "./fixtures";
import {
  asServiceFor,
  type Case,
  expectPgError,
  ident,
  inRollback,
  insertRow,
  inService,
  openTestDb,
  setPurge,
  type Values,
} from "./helpers";

// Vincoli, default e trigger dei consensi: consent_records e consent_choices. Nelle
// fixture A1 ha l'informativa firmata da lei sulla tela il 5/10, valida e senza PDF (CONSENT_A, firma
// FILE_A), e il sì a WhatsApp espresso nel modulo. Un consenso è firmato fin dall'insert: dopo cambiano
// solo lo stato, la revoca e il PDF (da null a un file). Questo file salva in `beforeAll` un secondo file
// di A. Ogni test gira in una transazione che torna indietro; un caso che fallisce per transazione, con il
// codice Postgres esatto. Update e delete di consent_choices toccano 0 righe: lo provano i casi "senza
// policy U" e "senza policy D" di isolation.test.ts.

let db: Db;
let pg: PGlite;

/** Un secondo file di A, salvato in `beforeAll`: la firma e il PDF di un consenso firmato non passano a lui. */
const OTHER_FILE_A = "a0000000-0000-4000-8000-0000000000f2";

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  // Come servizio, e salvato nel clone di questo file (non nel modello delle fixture).
  await asServiceFor(db, (tx) =>
    insertRow(tx, "files", {
      id: OTHER_FILE_A,
      practice_id: PRACTICE_A,
      kind: "consent_pdf",
      storage_key: `${PRACTICE_A}/consent_pdf/${OTHER_FILE_A}.pdf`,
      mime_type: "application/pdf",
      size_bytes: 2048,
      sha256: "e".repeat(64),
    }),
  );
});

afterAll(async () => {
  await pg?.close();
});

const TEXT = "Io sottoscritta Giulia Ferrari dichiaro di aver ricevuto e letto l'informativa.";

/** Un'informativa di A1 firmata da lei sulla tela il 19/10, con il testo e il suo sha256. */
const consent = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  patient_id: PATIENT_A1,
  module_key: "informativa",
  module_version: "2026.1",
  rendered_text: TEXT,
  rendered_hash: sha256Hex(TEXT),
  signer_kind: "paziente",
  signer_name: "Giulia Ferrari",
  method: "tela",
  signature_file_id: FILE_A,
  signed_on: "2026-10-19",
  ...extra,
});

const TREATMENT_MODULES = ["trattamento", "trattamento_minore"];

describe("public.consent_records", () => {
  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "consent_records", consent()));
    expect(row).toMatchObject({
      cycle_id: null,
      missing_fields: [],
      guardian_id: null,
      second_guardian_name: null,
      document_file_id: null,
      outcome: "accetta",
      refuses_information: false,
      refusal_note: null,
      trustee_name: null,
      trustee_contact: null,
      minor_opinion_note: null,
      status: "valido",
      revoked_on: null,
      revocation_mode: null,
      revocation_note: null,
    });
  });

  it.each<Case>([
    ["signer_kind", "nonno"],
    ["method", "carta"],
    ["outcome", "forse"],
    ["status", "annullato"],
    ["revocation_mode", "telefono"],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "consent_records", consent({ [column]: value }))),
      "23514",
    );
  });

  // Con il ciclo, così il check fra module_key e cycle_id passa e risponde solo la lista.
  it("module_key fuori dalla lista, con il ciclo: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "consent_records", consent({ module_key: "privacy", cycle_id: CYCLE_A }))),
      "23514",
    );
  });

  it.each<Case>([
    ...["paziente", "genitore", "tutore"].map((kind): Case => ["signer_kind", kind]),
    ...["accetta", "rifiuta"].map((outcome): Case => ["outcome", outcome]),
    ...["valido", "revocato", "sostituito"].map((status): Case => ["status", status]),
    ...["verbale", "scritta", "messaggio"].map((mode): Case => ["revocation_mode", mode]),
    ["missing_fields", ["professione", "codice_fiscale"]],
    ["document_file_id", FILE_A],
    ["refuses_information", true],
    ["refusal_note", "Non vuole conoscere i dettagli della valutazione"],
    ["trustee_name", "Laura Greco"],
    ["trustee_contact", "+393330000077"],
    ["minor_opinion_note", "Dice che dopo le sedute il dolore è minore"],
    ["revoked_on", "2026-10-20"],
    ["revocation_note", "Revoca comunicata a voce in studio"],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "consent_records", consent({ [column]: value })));
    expect(row[column]).toEqual(value);
  });

  it("controllo: l'informativa di un minore firmata dal genitore, con il secondo genitore: accettata", async () => {
    const row = await inService(db, (tx) =>
      insertRow(
        tx,
        "consent_records",
        consent({
          patient_id: PATIENT_A3,
          signer_kind: "genitore",
          signer_name: "Laura Greco",
          guardian_id: GUARDIAN_A,
          second_guardian_name: "Marco Greco",
        }),
      ),
    );
    expect(row).toMatchObject({ patient_id: PATIENT_A3, guardian_id: GUARDIAN_A, second_guardian_name: "Marco Greco" });
  });

  it("informativa con cycle_id: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "consent_records", consent({ cycle_id: CYCLE_A }))),
      "23514",
    );
  });

  it.each(TREATMENT_MODULES)("%s senza cycle_id: 23514", async (moduleKey) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "consent_records", consent({ module_key: moduleKey }))),
      "23514",
    );
  });

  it.each(TREATMENT_MODULES)("controllo: %s con cycle_id: accettato", async (moduleKey) => {
    const row = await inService(db, (tx) =>
      insertRow(tx, "consent_records", consent({ module_key: moduleKey, cycle_id: CYCLE_A })),
    );
    expect(row).toMatchObject({ module_key: moduleKey, cycle_id: CYCLE_A });
  });

  it("tela senza signature_file_id: 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "consent_records", consent({ signature_file_id: null }))),
      "23514",
    );
  });

  it("pdf_caricato senza document_file_id: 23514", async () => {
    await expectPgError(
      inService(db, (tx) =>
        insertRow(tx, "consent_records", consent({ method: "pdf_caricato", signature_file_id: null })),
      ),
      "23514",
    );
  });

  it("controllo: pdf_caricato con document_file_id e senza firma: accettato", async () => {
    const row = await inService(db, (tx) =>
      insertRow(
        tx,
        "consent_records",
        consent({ method: "pdf_caricato", signature_file_id: null, document_file_id: FILE_A }),
      ),
    );
    expect(row).toMatchObject({ method: "pdf_caricato", signature_file_id: null, document_file_id: FILE_A });
  });

  it.each<[label: string, hash: string]>([
    ["lo sha256 di un altro testo", sha256Hex("Io sottoscritta Giulia Ferrari non acconsento.")],
    ["lo sha256 giusto in maiuscolo", sha256Hex(TEXT).toUpperCase()],
    ["vuoto", ""],
  ])("rendered_hash diverso dallo sha256 di rendered_text (%s): 23514", async (_label, hash) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "consent_records", consent({ rendered_hash: hash }))),
      "23514",
    );
  });

  // Le lettere accentate pesano due byte in UTF-8: l'hash del database è quello dei byte UTF-8 del testo.
  it("controllo: testo con lettere accentate e il suo sha256 in UTF-8: accettato", async () => {
    const text = "Il trattamento è già stato spiegato: perché, quanto dura, quali effetti può avere.";
    const row = await inService(db, (tx) =>
      insertRow(tx, "consent_records", consent({ rendered_text: text, rendered_hash: sha256Hex(text) })),
    );
    expect(row).toMatchObject({ rendered_text: text, rendered_hash: sha256Hex(text) });
  });
});

/** La revoca a voce del 20/10 del consenso `$1`. */
const REVOKE_SQL = `update public.consent_records
                       set status = 'revocato', revoked_on = '2026-10-20', revocation_mode = 'verbale'
                     where id = $1`;

/** L'update di una colonna del consenso `consentId`, con returning: senza errore dà la riga aggiornata. */
function updateConsent(tx: Tx, consentId: string, column: string, value: SqlParam): Promise<unknown[]> {
  return tx.query(`update public.consent_records set ${ident(column)} = $2 where id = $1 returning id`, [
    consentId,
    value,
  ]);
}

describe("consenso firmato (consent_records_immutable)", () => {
  const CHANGED = "Io sottoscritta Giulia Ferrari dichiaro di aver ricevuto l'informativa aggiornata.";

  it.each<Case>([
    ["signed_at", "2026-11-04T08:30:00+01:00"],
    ["second_signature_file_id", OTHER_FILE_A],
    ["practitioner_signature_file_id", OTHER_FILE_A],
  ])("nuove_firme_immutabili: %s", async (column, value) => {
    await expectPgError(inRollback(db, "A", (tx) => updateConsent(tx, CONSENT_A, column, value)), "42501");
  });

  it.each(["second_signature_file_id", "practitioner_signature_file_id"])("nuove_firme_FK_studio: %s", async (column) => {
    await expectPgError(inRollback(db, "A", (tx) => insertRow(tx, "consent_records", consent({ [column]: FILE_B, second_guardian_name: "Secondo Prova" }))), "23503");
  });

  it("seconda_firma_richiede_nome", async () => {
    await expectPgError(inRollback(db, "A", (tx) => insertRow(tx, "consent_records", consent({ second_signature_file_id: OTHER_FILE_A }))), "23514");
  });

  it("nuove_firme_nullable_e_rinvio", async () => {
    await inRollback(db, "A", async (tx) => {
      const row = await insertRow(tx, "consent_records", consent());
      expect(row).toMatchObject({ signed_at: null, second_signature_file_id: null, practitioner_signature_file_id: null });
      const signed = await insertRow(tx, "consent_records", consent({ signed_at: "2026-11-04T07:30:00Z", second_signature_file_id: OTHER_FILE_A, second_guardian_name: "Secondo Prova", practitioner_signature_file_id: FILE_A }));
      expect(signed.second_signature_file_id).toBe(OTHER_FILE_A);
      const [patient] = await tx.query<{ recall_snoozed_until: string | null }>("update public.patients set recall_snoozed_until = '2026-11-18' where id = $1 returning recall_snoozed_until", [PATIENT_A1]);
      expect(patient?.recall_snoozed_until).toBe("2026-11-18");
    });
  });

  it.each<Case>([
    ["rendered_text", CHANGED],
    ["rendered_hash", sha256Hex(CHANGED)],
    ["signature_file_id", OTHER_FILE_A],
    ["signed_on", "2026-10-06"],
  ])("update di %s = %j (uA): 42501", async (column, value) => {
    await expectPgError(
      inRollback(db, "A", (tx) => updateConsent(tx, CONSENT_A, column, value)),
      "42501",
    );
  });

  // Testo e hash coerenti passerebbero il check dell'hash: li ferma solo il trigger.
  it("testo e hash riscritti insieme, coerenti (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", (tx) =>
        tx.query("update public.consent_records set rendered_text = $2, rendered_hash = $3 where id = $1", [
          CONSENT_A,
          CHANGED,
          sha256Hex(CHANGED),
        ]),
      ),
      "42501",
    );
  });

  // Fuori dalla lista dei campi della revoca e del PDF non cambia niente, non solo i quattro della revoca.
  it.each<Case>([
    ["patient_id", PATIENT_A2],
    ["module_version", "2026.2"],
    ["signer_name", "Giulia Ferraris"],
    ["outcome", "rifiuta"],
    ["missing_fields", ["professione"]],
  ])("update di un altro campo della firma, %s = %j (uA): 42501", async (column, value) => {
    await expectPgError(
      inRollback(db, "A", (tx) => updateConsent(tx, CONSENT_A, column, value)),
      "42501",
    );
  });

  // I trigger scattano anche per il superutente: BYPASSRLS salta le policy, non i trigger.
  it("update di signed_on come servizio: 42501", async () => {
    await expectPgError(
      inRollback(db, "service", (tx) => updateConsent(tx, CONSENT_A, "signed_on", "2026-10-06")),
      "42501",
    );
  });

  it("controllo: i campi congelati riscritti uguali passano, con la nota di revoca (uA)", async () => {
    const rows = await inRollback(db, "A", (tx) =>
      tx.query(
        `update public.consent_records
            set rendered_text = rendered_text, rendered_hash = rendered_hash,
                signature_file_id = signature_file_id, signed_on = signed_on, revocation_note = $2
          where id = $1 returning revocation_note`,
        [CONSENT_A, "Chiede di essere richiamata prima di revocare"],
      ),
    );
    expect(rows).toEqual([{ revocation_note: "Chiede di essere richiamata prima di revocare" }]);
  });

  // L. 219/2017 ("Niente si cancella"): la revoca registrata resta. Una revoca sbagliata si corregge con
  // un consenso nuovo, firmato.
  it.each<[label: string, set: string]>([
    ["torna valido e cancella la revoca", "status = 'valido', revoked_on = null, revocation_mode = null"],
    ["torna valido", "status = 'valido'"],
    ["passa a sostituito", "status = 'sostituito'"],
    ["revoked_on riscritto", "revoked_on = '2026-10-21'"],
    ["revoked_on a null", "revoked_on = null"],
    ["revocation_mode riscritto", "revocation_mode = 'scritta'"],
    ["revocation_mode a null", "revocation_mode = null"],
  ])("dopo la revoca, %s (uA): 42501", async (_label, set) => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await tx.query(REVOKE_SQL, [CONSENT_A]);
        return tx.query(`update public.consent_records set ${set} where id = $1 returning id`, [CONSENT_A]);
      }),
      "42501",
    );
  });

  it("un consenso sostituito non torna valido (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await updateConsent(tx, CONSENT_A, "status", "sostituito");
        return updateConsent(tx, CONSENT_A, "status", "valido");
      }),
      "42501",
    );
  });

  it("controllo: valido → sostituito passa (uA)", async () => {
    const rows = await inRollback(db, "A", (tx) =>
      tx.query("update public.consent_records set status = 'sostituito' where id = $1 returning status", [CONSENT_A]),
    );
    expect(rows).toEqual([{ status: "sostituito" }]);
  });

  it("controllo: dopo la revoca la nota della revoca cambia (uA)", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      await tx.query(REVOKE_SQL, [CONSENT_A]);
      return tx.query("update public.consent_records set revocation_note = $2 where id = $1 returning revocation_note", [
        CONSENT_A,
        "Revoca confermata per iscritto il giorno dopo",
      ]);
    });
    expect(rows).toEqual([{ revocation_note: "Revoca confermata per iscritto il giorno dopo" }]);
  });

  // Senza policy D uA non cancella nessun consenso (isolation.test.ts): il trigger ferma anche il servizio. Il
  // consenso nasce nella transazione, così nessuna scelta sul canale lo tiene con la chiave restrict.
  it("delete di un consenso firmato come servizio senza purga: 42501", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        const consentId = String((await insertRow(tx, "consent_records", consent())).id);
        return tx.query("delete from public.consent_records where id = $1 returning id", [consentId]);
      }),
      "42501",
    );
  });

  it("la revoca passa (uA)", async () => {
    const rows = await inRollback(db, "A", (tx) =>
      tx.query(
        `update public.consent_records
            set status = 'revocato', revoked_on = '2026-10-20', revocation_mode = 'verbale', revocation_note = $2
          where id = $1 returning status, revoked_on, revocation_mode, revocation_note`,
        [CONSENT_A, "Revoca comunicata a voce in studio"],
      ),
    );
    expect(rows).toEqual([
      {
        status: "revocato",
        revoked_on: "2026-10-20",
        revocation_mode: "verbale",
        revocation_note: "Revoca comunicata a voce in studio",
      },
    ]);
  });
});

describe("PDF del consenso (document_file_id)", () => {
  const SET_DOCUMENT =
    "update public.consent_records set document_file_id = $2 where id = $1 returning document_file_id";

  it("da null a FILE_A (uA): passa", async () => {
    const rows = await inRollback(db, "A", (tx) => tx.query(SET_DOCUMENT, [CONSENT_A, FILE_A]));
    expect(rows).toEqual([{ document_file_id: FILE_A }]);
  });

  it("poi di nuovo a null (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await tx.query(SET_DOCUMENT, [CONSENT_A, FILE_A]);
        return tx.query(SET_DOCUMENT, [CONSENT_A, null]);
      }),
      "42501",
    );
  });

  it("poi a un altro file (uA): 42501", async () => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await tx.query(SET_DOCUMENT, [CONSENT_A, FILE_A]);
        return tx.query(SET_DOCUMENT, [CONSENT_A, OTHER_FILE_A]);
      }),
      "42501",
    );
  });

  it("controllo: poi lo stesso file riscritto passa (uA)", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      await tx.query(SET_DOCUMENT, [CONSENT_A, FILE_A]);
      return tx.query(SET_DOCUMENT, [CONSENT_A, FILE_A]);
    });
    expect(rows).toEqual([{ document_file_id: FILE_A }]);
  });
});

describe("public.consent_choices", () => {
  /** Il sì di A1 ai richiami, detto a voce il 19/10. */
  const choice = (extra: Values = {}): Values => ({
    practice_id: PRACTICE_A,
    patient_id: PATIENT_A1,
    choice: "richiami",
    value: true,
    decided_on: "2026-10-19",
    mode: "verbale",
    ...extra,
  });

  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "consent_choices", choice()));
    expect(row).toMatchObject({ consent_record_id: null, note: null });
  });

  it.each<Case>([
    ["choice", "email"],
    ["mode", "telefono"],
    ["note", "a".repeat(301)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "consent_choices", choice({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ...["whatsapp", "richiami"].map((name): Case => ["choice", name]),
    ...["modulo", "verbale", "scritta", "messaggio"].map((mode): Case => ["mode", mode]),
    ["value", false],
    ["note", "a".repeat(300)],
    ["consent_record_id", CONSENT_A],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "consent_choices", choice({ [column]: value })));
    expect(row[column]).toEqual(value);
  });

  it("l'indice dell'ultima scelta per paziente e canale", async () => {
    const rows = await inService(db, (tx) =>
      tx.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'consent_choices_latest_idx'",
      ),
    );
    expect(rows.map((row) => row.indexdef)).toEqual([
      "CREATE INDEX consent_choices_latest_idx ON public.consent_choices USING btree " +
        "(practice_id, patient_id, choice, decided_on DESC, created_at DESC, record_order DESC)",
    ]);
  });
});

// Contratto di purga: (a) il servizio con la purga di A scrive una riga
// congelata di A; (b) con la purga di A, la stessa scrittura su una riga congelata di B dà 42501;
// (c) uA con la purga di A resta fermo sulla riga di A.
describe("uscita di purga", () => {
  type FrozenWrite = [label: string, write: (tx: Tx, consentId: string) => Promise<unknown[]>];
  // La scelta sul canale della fixture punta al consenso con una chiave restrict: la purga la cancella prima.
  const DELETE_CONSENT: FrozenWrite = [
    "delete del consenso firmato, dopo la sua scelta sul canale",
    async (tx, consentId) => {
      await tx.query("delete from public.consent_choices where consent_record_id = $1", [consentId]);
      return tx.query("delete from public.consent_records where id = $1 returning id", [consentId]);
    },
  ];
  const FROZEN_WRITES: FrozenWrite[] = [
    ["update di signed_on del consenso firmato", (tx, consentId) => updateConsent(tx, consentId, "signed_on", "2026-10-06")],
    [
      "revoca annullata",
      async (tx, consentId) => {
        await tx.query(REVOKE_SQL, [consentId]);
        return tx.query(
          "update public.consent_records set status = 'valido', revoked_on = null, revocation_mode = null where id = $1 returning id",
          [consentId],
        );
      },
    ],
    DELETE_CONSENT,
  ];

  it.each(FROZEN_WRITES)("(a) servizio con la purga di A: %s di A passa", async (_label, write) => {
    const rows = await inRollback(db, "service", async (tx) => {
      await setPurge(tx, PRACTICE_A);
      return write(tx, CONSENT_A);
    });
    expect(rows).toEqual([{ id: CONSENT_A }]);
  });

  it.each(FROZEN_WRITES)("(b) servizio con la purga di A: %s di B: 42501", async (_label, write) => {
    await expectPgError(
      inRollback(db, "service", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return write(tx, CONSENT_B);
      }),
      "42501",
    );
  });

  it.each(FROZEN_WRITES.slice(0, 2))("(c) uA con la purga di A: %s di A: 42501", async (_label, write) => {
    await expectPgError(
      inRollback(db, "A", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return write(tx, CONSENT_A);
      }),
      "42501",
    );
  });

  // Senza policy D la delete di uA non arriva al trigger: il caso (c) della delete tocca 0 righe invece di dare
  // 42501, come per la fattura emessa (invoices.test.ts).
  it("(c) uA con la purga di A: la delete del consenso di A tocca 0 righe, il consenso resta", async () => {
    const { deleted, left } = await inRollback(db, "A", async (tx) => {
      await setPurge(tx, PRACTICE_A);
      const deleted = await DELETE_CONSENT[1](tx, CONSENT_A);
      const [left] = await tx.query<{ n: number }>("select count(*)::int as n from public.consent_records where id = $1", [
        CONSENT_A,
      ]);
      return { deleted, left: left?.n };
    });
    expect(deleted).toEqual([]);
    expect(left).toBe(1);
  });

  // Un update esce solo se la riga resta nello studio della purga: la purga di A non porta a B un consenso di A.
  it("(b) servizio con la purga di A: il consenso di A spostato su B: 42501", async () => {
    await expectPgError(
      inRollback(db, "service", async (tx) => {
        await setPurge(tx, PRACTICE_A);
        return updateConsent(tx, CONSENT_A, "practice_id", PRACTICE_B);
      }),
      "42501",
    );
  });
});
