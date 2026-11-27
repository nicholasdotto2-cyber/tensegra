import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/db";
import {
  APPOINTMENT_A,
  APPOINTMENT_B,
  MESSAGE_LOG_A,
  MESSAGE_LOG_B,
  PATIENT_A1,
  PATIENT_A2,
  PRACTICE_A,
  PRACTICE_B,
  USER_A,
  USER_B,
  VISIT_A,
  VISIT_B,
} from "./fixtures";
import {
  asServiceFor,
  type Case,
  expectBlockedDelete,
  expectPgError,
  ident,
  insertRow,
  inService,
  inUserA,
  openTestDb,
  setPurge,
  type Values,
} from "./helpers";

// Vincoli, default e privilegi dei messaggi: message_templates e message_log. Nelle
// fixture ogni studio ha il modello di conferma "lei" e una riga di registro del primo paziente, sulla
// conferma dell'appuntamento del 5/10, copiata e ancora da confermare. Del registro si aggiorna solo
// l'esito: lo dicono i privilegi di colonna di `authenticated`, quindi i casi di scrittura vietata girano
// come uA e danno 42501 anche sulle sue righe. Ogni test gira in una transazione che torna indietro; un
// caso che fallisce per transazione, con il codice Postgres esatto. Delete e update fra studi diversi
// (0 righe) li prova isolation.test.ts.

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

// La fixture è la conferma "lei": una riga nuova con chiave e variante di default non urta la unique,
// salvo nei casi che la provano.
const template = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  key: "promemoria",
  variant: "tu",
  body: "Ciao {nome}, ti ricordo la seduta di domani alle {ora}.",
  ...extra,
});

describe("public.message_templates", () => {
  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "message_templates", template()));
    expect(row).toMatchObject({ is_customized: false });
  });

  it.each<Case>([
    ["key", "saluti"],
    ["key", "Conferma"],
    ["key", ""],
    ["variant", "voi"],
    ["variant", "Tu"],
    ["variant", ""],
    // Oltre ai check della tabella: un testo di soli spazi vale il vuoto.
    ["body", ""],
    ["body", "   "],
    ["body", "a".repeat(701)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "message_templates", template({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    // La fixture è conferma/lei: conferma/tu è libera.
    ...["conferma", "promemoria", "spostamento", "richiamo", "consigli"].map((key): Case => ["key", key]),
    ["variant", "lei"],
    ["body", "S"],
    ["body", "a".repeat(700)],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "message_templates", template({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it("stessa key e stessa variant nello stesso studio: 23505", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        await insertRow(tx, "message_templates", template());
        await insertRow(tx, "message_templates", template({ body: "Un altro testo" }));
      }),
      "23505",
    );
  });

  it("lo stesso modello della fixture (conferma, lei): 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "message_templates", template({ key: "conferma", variant: "lei" }))),
      "23505",
    );
  });

  it("stessa key con un'altra variant, e stessa key e variant in un altro studio: accettate", async () => {
    const rows = await inService(db, async (tx) => {
      await insertRow(tx, "message_templates", template({ variant: "tu" }));
      await insertRow(tx, "message_templates", template({ variant: "lei" }));
      await insertRow(tx, "message_templates", template({ practice_id: PRACTICE_B, variant: "tu" }));
      return tx.query<{ practice_id: string; variant: string }>(
        "select practice_id::text as practice_id, variant from public.message_templates where key = 'promemoria' order by 1, 2",
      );
    });
    expect(rows).toEqual([
      { practice_id: PRACTICE_A, variant: "lei" },
      { practice_id: PRACTICE_A, variant: "tu" },
      { practice_id: PRACTICE_B, variant: "tu" },
    ]);
  });

  it("uA personalizza il testo di un suo modello", async () => {
    const rows = await inUserA(db, (tx) =>
      tx.query<{ body: string; is_customized: boolean }>(
        `update public.message_templates set body = 'Buongiorno {nome}, ci vediamo {giorno}.', is_customized = true
          where practice_id = $1 and key = 'conferma' and variant = 'lei' returning body, is_customized`,
        [PRACTICE_A],
      ),
    );
    expect(rows).toEqual([{ body: "Buongiorno {nome}, ci vediamo {giorno}.", is_customized: true }]);
  });
});

/** Una riga di registro del primo paziente di A: copiata, senza appuntamento né visita (valida salvo ciò che `extra` cambia). */
const log = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  patient_id: PATIENT_A1,
  template_key: "promemoria",
  recipient_kind: "paziente",
  recipient_name: "Giulia Ferrari",
  body: "Buongiorno Giulia, le ricordo la seduta di domani alle 9.",
  action: "copiato",
  ...extra,
});

describe("public.message_log, valori e legami", () => {
  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "message_log", log()));
    expect(row).toMatchObject({
      appointment_id: null,
      visit_id: null,
      recipient_phone: null,
      outcome: "da_confermare",
      outcome_at: null,
    });
  });

  it.each<Case>([
    ["template_key", "saluti"],
    ["template_key", "Conferma"],
    ["action", "inviato"],
    ["action", "Copiato"],
    ["recipient_kind", "nonno"],
    ["recipient_kind", "Paziente"],
    ["outcome", "boh"],
    ["outcome", "copiato"],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "message_log", log({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ...["conferma", "promemoria", "spostamento", "richiamo", "consigli"].map((key): Case => ["template_key", key]),
    ...["paziente", "genitore", "tutore"].map((kind): Case => ["recipient_kind", kind]),
    ...["copiato", "whatsapp_aperto"].map((action): Case => ["action", action]),
    ...["da_confermare", "inviato", "non_inviato"].map((outcome): Case => ["outcome", outcome]),
    ["recipient_phone", "+393330000077"],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "message_log", log({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it.each<Case>([
    ["recipient_name", null],
    ["body", null],
    ["template_key", null],
    ["action", null],
  ])("%s = %j: 23502", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "message_log", log({ [column]: value }))),
      "23502",
    );
  });

  it("una riga sull'appuntamento di conferma e una sulla visita dei consigli: accettate", async () => {
    const rows = await inService(db, async (tx) => {
      await insertRow(tx, "message_log", log({ template_key: "conferma", appointment_id: APPOINTMENT_A }));
      await insertRow(tx, "message_log", log({ template_key: "consigli", visit_id: VISIT_A, action: "whatsapp_aperto" }));
      return tx.query<{ template_key: string }>(
        "select template_key from public.message_log where appointment_id = $1 or visit_id = $2 order by template_key",
        [APPOINTMENT_A, VISIT_A],
      );
    });
    // Più la riga di fixture, che sta già sull'appuntamento.
    expect(rows).toEqual([{ template_key: "conferma" }, { template_key: "conferma" }, { template_key: "consigli" }]);
  });

  it.each<[string, Values]>([
    ["un appuntamento di B", { appointment_id: APPOINTMENT_B }],
    ["una visita di B", { visit_id: VISIT_B }],
  ])("una riga di A su %s: 23503", async (_name, extra) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "message_log", log(extra))),
      "23503",
    );
  });

  it("un paziente con messaggi nel registro non si cancella", async () => {
    await expectBlockedDelete(
      inService(db, async (tx) => {
        // A2 non ha altro in cartella: lo tiene solo il messaggio.
        await insertRow(tx, "message_log", log({ patient_id: PATIENT_A2 }));
        await tx.query("delete from public.patients where id = $1", [PATIENT_A2]);
      }),
    );
  });

  it("created_by lo scrive il trigger: uA che passa USER_B ottiene USER_A", async () => {
    const row = await inUserA(db, (tx) =>
      insertRow(tx, "message_log", log({ created_by: USER_B })),
    );
    expect(row.created_by).toBe(USER_A);
  });
});

describe("public.message_log, solo l'esito si aggiorna", () => {
  // Ogni colonna salvo esito, data dell'esito e updated_at: scrivere un valore valido è vietato lo stesso,
  // anche sulla riga di uA e anche con un where che la sceglie per id.
  it.each<Case>([
    ["body", "Un altro testo"],
    ["recipient_name", "Qualcun altro"],
    ["recipient_phone", "+393330000000"],
    ["recipient_kind", "genitore"],
    ["template_key", "consigli"],
    ["action", "whatsapp_aperto"],
    ["patient_id", PATIENT_A2],
    ["appointment_id", null],
    ["visit_id", VISIT_A],
    ["practice_id", PRACTICE_B],
    ["created_at", "2026-10-01T00:00:00Z"],
    ["created_by", USER_B],
    ["id", "a0000000-0000-4000-8000-000000000999"],
  ])("update di %s = %j come uA sulla sua riga: 42501", async (column, value) => {
    await expectPgError(
      inUserA(db, (tx) =>
        tx.query(`update public.message_log set ${ident(column)} = $1 where id = $2`, [value, MESSAGE_LOG_A]),
      ),
      "42501",
    );
  });

  it("update di body senza where come uA: 42501, e un update di body e di outcome insieme", async () => {
    await expectPgError(
      inUserA(db, (tx) => tx.query("update public.message_log set body = 'Un altro testo'")),
      "42501",
    );
    await expectPgError(
      inUserA(db, (tx) =>
        tx.query("update public.message_log set body = 'Un altro testo', outcome = 'inviato' where id = $1", [
          MESSAGE_LOG_A,
        ]),
      ),
      "42501",
    );
  });

  it("update di body come uA con la purga dello studio impostata: 42501 (la purga non apre i privilegi)", async () => {
    await expectPgError(
      inUserA(db, async (tx) => {
        await setPurge(tx, PRACTICE_A);
        await tx.query("update public.message_log set body = 'Un altro testo' where id = $1", [MESSAGE_LOG_A]);
      }),
      "42501",
    );
  });

  it("update di outcome e outcome_at come uA passa, e il testo resta quello copiato", async () => {
    const [before] = await asServiceFor(db, (tx) =>
      tx.query<{ updated_at: Date; body: string }>("select updated_at, body from public.message_log where id = $1", [
        MESSAGE_LOG_A,
      ]),
    );
    const rows = await inUserA(db, (tx) =>
      tx.query<{ outcome: string; outcome_at: Date; body: string; updated_at: Date }>(
        `update public.message_log set outcome = 'inviato', outcome_at = '2026-10-05T08:15:00Z'
          where id = $1 returning outcome, outcome_at, body, updated_at`,
        [MESSAGE_LOG_A],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "inviato", body: before?.body });
    expect(rows[0]?.outcome_at.toISOString()).toBe("2026-10-05T08:15:00.000Z");
    // Il trigger ha fatto avanzare updated_at, che è fra le colonne aggiornabili.
    expect(rows[0]?.updated_at.getTime()).toBeGreaterThan(before?.updated_at.getTime() ?? Infinity);
  });

  it.each(["da_confermare", "inviato", "non_inviato"])("l'esito si porta a %s", async (outcome) => {
    const rows = await inUserA(db, (tx) =>
      tx.query<{ outcome: string }>("update public.message_log set outcome = $1 where id = $2 returning outcome", [
        outcome,
        MESSAGE_LOG_A,
      ]),
    );
    expect(rows).toEqual([{ outcome }]);
  });

  it("un esito fuori elenco: 23514", async () => {
    await expectPgError(
      inUserA(db, (tx) => tx.query("update public.message_log set outcome = 'boh' where id = $1", [MESSAGE_LOG_A])),
      "23514",
    );
  });

  it("uA non cancella la sua riga: 0 righe, la riga esiste ancora", async () => {
    const { deleted, remaining } = await inUserA(db, async (tx) => {
      const deleted = await tx.query("delete from public.message_log where id = $1 returning id", [MESSAGE_LOG_A]);
      const remaining = await tx.query<{ n: number }>("select count(*)::int as n from public.message_log where id = $1", [
        MESSAGE_LOG_A,
      ]);
      return { deleted, remaining };
    });
    expect(deleted).toEqual([]);
    expect(remaining).toEqual([{ n: 1 }]);
  });

  it("uA non aggiorna l'esito di una riga di B: 0 righe", async () => {
    const rows = await inUserA(db, (tx) =>
      tx.query("update public.message_log set outcome = 'inviato' where id = $1 returning id", [MESSAGE_LOG_B]),
    );
    expect(rows).toEqual([]);
  });
});

describe("public.message_log, privilegi nel catalogo", () => {
  const UPDATABLE = ["outcome", "outcome_at", "updated_at"];

  it("authenticated: select, insert, delete sulla tabella e update solo su esito, data dell'esito e updated_at", async () => {
    const privileges = await asServiceFor(db, (tx) =>
      tx.query<{ privilege: string; ok: boolean }>(
        `select p as privilege, has_table_privilege('authenticated', 'public.message_log', p) as ok
           from unnest(array['select', 'insert', 'update', 'delete']) as p`,
      ),
    );
    expect(privileges).toEqual([
      { privilege: "select", ok: true },
      { privilege: "insert", ok: true },
      // has_table_privilege non vede un update concesso solo su alcune colonne.
      { privilege: "update", ok: false },
      { privilege: "delete", ok: true },
    ]);
    const columns = await asServiceFor(db, (tx) =>
      tx.query<{ column: string; ok: boolean }>(
        `select a.attname::text as "column", has_column_privilege('authenticated', c.oid, a.attnum, 'update') as ok
           from pg_class c
           join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          where c.oid = 'public.message_log'::regclass
          order by a.attnum`,
      ),
    );
    expect(columns.filter((c) => c.ok).map((c) => c.column)).toEqual(UPDATABLE);
    expect(columns.filter((c) => !c.ok).length).toBeGreaterThan(UPDATABLE.length);
  });

  it("service_role: select, insert, update, delete su tutta la tabella", async () => {
    const privileges = await asServiceFor(db, (tx) =>
      tx.query<{ privilege: string; ok: boolean }>(
        `select p as privilege, has_table_privilege('service_role', 'public.message_log', p) as ok
           from unnest(array['select', 'insert', 'update', 'delete']) as p`,
      ),
    );
    expect(privileges).toEqual([
      { privilege: "select", ok: true },
      { privilege: "insert", ok: true },
      { privilege: "update", ok: true },
      { privilege: "delete", ok: true },
    ]);
  });

  it("le policy di message_log sono select, insert e update: nessuna delete", async () => {
    const policies = await asServiceFor(db, (tx) =>
      tx.query<{ policyname: string; cmd: string }>(
        "select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'message_log' order by policyname",
      ),
    );
    expect(policies).toEqual([
      { policyname: "message_log_insert", cmd: "INSERT" },
      { policyname: "message_log_select", cmd: "SELECT" },
      { policyname: "message_log_update", cmd: "UPDATE" },
    ]);
  });
});
