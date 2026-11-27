import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, Tx } from "@/server/db/db";
import { FILE_A, FILE_B, PRACTICE_A } from "./fixtures";
import { type Case, expectPgError, inRollback, insertRow, openTestDb, type Values } from "./helpers";

// Vincoli e default delle impostazioni: practice_settings, opening_hours,
// fiscal_settings e clinical_settings. Ogni test gira in una transazione che torna indietro, sullo
// studio C creato qui dentro (A e B hanno già la loro riga 1:1 dalle fixture); un caso che fallisce
// per transazione, con il codice Postgres esatto.

const PRACTICE_C = "c0000000-0000-4000-8000-000000000001";

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

/** Crea lo studio C e passa a `fn` la transazione di servizio; alla fine tutto torna indietro. */
function inStudioC<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inRollback(db, "service", async (tx) => {
    await tx.query("insert into public.practices (id, name) values ($1, 'Studio C')", [PRACTICE_C]);
    return fn(tx);
  });
}

const practiceSettings = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_C,
  practitioner_first_name: "Carla",
  practitioner_last_name: "Neri",
  ...extra,
});

const openingHours = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_C,
  weekday: 1,
  slot: 1,
  opens_at: "09:00",
  closes_at: "13:00",
  ...extra,
});

const fiscalSettings = (extra: Values = {}): Values => ({ practice_id: PRACTICE_C, ...extra });

const clinicalSettings = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_C,
  active_test_codes: [],
  ...extra,
});

describe("public.practice_settings", () => {
  it("i default", async () => {
    const row = await inStudioC((tx) =>
      insertRow(tx, "practice_settings", {
        practice_id: PRACTICE_C,
        practitioner_first_name: "Carla",
        practitioner_last_name: "Neri",
      }),
    );
    expect(row).toMatchObject({
      is_demo: false,
      practitioner_title: "Osteopata",
      registration_kind: "nessuna",
      retention_years: 10,
      default_addressing: "lei",
    });
  });

  it.each<Case>([
    ["postal_code", "4012"],
    ["province", "bo"],
    ["phone", "+39 051 000 0099"],
    ["email", "studio@"],
    ["registration_kind", "iscritto"],
    ["insurance_limit_cents", 0],
    ["retention_years", 31],
    ["demo_test_phone", "3330000077"],
    // Oltre ai check della tabella: gli estremi e i testi di soli spazi.
    ["practitioner_first_name", "   "],
    ["practitioner_first_name", "a".repeat(61)],
    ["practitioner_last_name", ""],
    ["pec", "pec@"],
    ["registration_order", "a".repeat(61)],
    ["registration_province", "B"],
    ["registration_number", "a".repeat(61)],
    ["retention_years", 0],
    ["default_addressing", "voi"],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inStudioC((tx) => insertRow(tx, "practice_settings", practiceSettings({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["practitioner_first_name", "a".repeat(60)],
    ["postal_code", "40121"],
    ["province", "BO"],
    ["phone", "+390510000099"],
    ["email", "studio@example.com"],
    ["pec", "studio@pec.example.test"],
    ["registration_kind", "in_attesa"],
    ["registration_kind", "ese"],
    ["registration_kind", "albo"],
    ["registration_province", "BO"],
    ["registration_order", "a".repeat(60)],
    ["insurance_limit_cents", 1],
    ["insurance_limit_cents", 500000000],
    ["retention_years", 1],
    ["retention_years", 30],
    ["default_addressing", "tu"],
    ["demo_test_phone", "+393330000077"],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inStudioC((tx) => insertRow(tx, "practice_settings", practiceSettings({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it("la firma può essere un file dello stesso studio", async () => {
    const rows = await inRollback(db, "service", (tx) =>
      tx.query<{ file_id: string }>(
        `update public.practice_settings set practitioner_signature_file_id = $1 where practice_id = $2
         returning practitioner_signature_file_id::text as file_id`,
        [FILE_A, PRACTICE_A],
      ),
    );
    expect(rows).toEqual([{ file_id: FILE_A }]);
  });

  it("la firma non può essere un file di un altro studio, nemmeno per il servizio: 23503", async () => {
    await expectPgError(
      inRollback(db, "service", (tx) =>
        tx.query("update public.practice_settings set practitioner_signature_file_id = $1 where practice_id = $2", [
          FILE_B,
          PRACTICE_A,
        ]),
      ),
      "23503",
    );
  });
});

describe("public.fiscal_settings", () => {
  it("i default", async () => {
    const row = await inStudioC((tx) => insertRow(tx, "fiscal_settings", { practice_id: PRACTICE_C }));
    expect(row).toMatchObject({
      regime: "forfettario",
      fiscal_country: "IT",
      inps_surcharge_enabled: false,
      inps_surcharge_bp: 400,
      withholding_bp: 2000,
      vat_rate_bp: 2200,
      stamp_charged_to_client: true,
      default_payment_method: "carta",
      bank_transfer_due_days: 15,
    });
  });

  it.each<Case>([
    ["vat_number", "1234567890"],
    ["tax_code", "abc"],
    ["ateco_code", "86.96"],
    ["iban", "IT00"],
    ["inps_surcharge_bp", 401],
    ["regime", "semplificato"],
    ["bank_transfer_due_days", 121],
    ["fiscal_province", "Bo"],
    // Oltre ai check della tabella.
    ["vat_number", "1234567890a"],
    ["tax_code", "RSSMRA80A01H501"],
    ["ateco_code", "869609"],
    ["iban", "it60x0542811101000000123456"],
    ["fiscal_postal_code", "4012"],
    ["fiscal_country", "it"],
    ["inps_surcharge_bp", -1],
    ["withholding_bp", 10001],
    ["vat_rate_bp", 10001],
    ["vat_rate_bp", -1],
    ["default_payment_method", "assegno"],
    ["bank_transfer_due_days", -1],
    ["fiscal_address_line", "a".repeat(61)],
    ["fiscal_city", "a".repeat(61)],
    ["paper_stamp_authorization", "a".repeat(61)],
    ["iban_holder", "a".repeat(201)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inStudioC((tx) => insertRow(tx, "fiscal_settings", fiscalSettings({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["regime", "ordinario"],
    ["regime", "esente_sanitario"],
    ["vat_number", "12345678903"],
    ["tax_code", "RSSMRA80A01H501U"],
    ["tax_code", "12345678903"],
    ["ateco_code", "86.96.09"],
    ["fiscal_postal_code", "40121"],
    ["fiscal_province", "BO"],
    ["fiscal_address_line", "a".repeat(60)],
    ["fiscal_city", "a".repeat(60)],
    ["inps_surcharge_bp", 0],
    ["inps_surcharge_bp", 400],
    ["withholding_bp", 0],
    ["withholding_bp", 10000],
    ["vat_rate_bp", 0],
    ["vat_rate_bp", 10000],
    ["paper_stamp_authorization", "a".repeat(60)],
    ["iban", "IT60X0542811101000000123456"],
    ["iban_holder", "a".repeat(200)],
    ["default_payment_method", "contanti"],
    ["default_payment_method", "bonifico"],
    ["bank_transfer_due_days", 0],
    ["bank_transfer_due_days", 120],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inStudioC((tx) => insertRow(tx, "fiscal_settings", fiscalSettings({ [column]: value })));
    expect(row[column]).toBe(value);
  });
});

describe("public.opening_hours", () => {
  it.each<[string, Values]>([
    ["opens_at 09:10 non è un quarto d'ora", { opens_at: "09:10" }],
    ["closes_at 13:10 non è un quarto d'ora", { closes_at: "13:10" }],
    ["opens_at 09:00:30 ha i secondi", { opens_at: "09:00:30" }],
    ["closes_at 13:00:30 ha i secondi", { closes_at: "13:00:30" }],
    ["opens_at 13:00 dopo closes_at 09:00", { opens_at: "13:00", closes_at: "09:00" }],
    ["opens_at uguale a closes_at", { opens_at: "09:00", closes_at: "09:00" }],
    ["fascia 3", { slot: 3 }],
    ["fascia 0", { slot: 0 }],
    ["giorno 8", { weekday: 8 }],
    ["giorno 0", { weekday: 0 }],
  ])("%s: 23514", async (_label, extra) => {
    await expectPgError(
      inStudioC((tx) => insertRow(tx, "opening_hours", openingHours(extra))),
      "23514",
    );
  });

  it("la stessa (giorno, fascia) due volte nello stesso studio: 23505", async () => {
    await expectPgError(
      inStudioC(async (tx) => {
        await insertRow(tx, "opening_hours", openingHours());
        await insertRow(tx, "opening_hours", openingHours({ opens_at: "10:00", closes_at: "12:00" }));
      }),
      "23505",
    );
  });

  it("lunedì fascia 1 come lo studio A, e la fascia 2 dello stesso giorno: accettate", async () => {
    const rows = await inStudioC(async (tx) => {
      await insertRow(tx, "opening_hours", openingHours());
      await insertRow(tx, "opening_hours", openingHours({ slot: 2, opens_at: "15:45", closes_at: "19:15" }));
      return tx.query<{ weekday: number; slot: number }>(
        "select weekday, slot from public.opening_hours where practice_id = $1 order by slot",
        [PRACTICE_C],
      );
    });
    expect(rows).toEqual([
      { weekday: 1, slot: 1 },
      { weekday: 1, slot: 2 },
    ]);
  });

  it.each<[string, Values]>([
    ["domenica", { weekday: 7 }],
    ["mezzanotte meno un quarto", { opens_at: "23:00:00", closes_at: "23:45:00" }],
    ["dall'apertura a mezzogiorno", { opens_at: "00:00:00", closes_at: "12:00:00" }],
  ])("%s: accettato", async (_label, extra) => {
    const row = await inStudioC((tx) => insertRow(tx, "opening_hours", openingHours(extra)));
    expect(row).toMatchObject(extra);
  });
});

describe("public.clinical_settings", () => {
  it("i default", async () => {
    const row = await inStudioC((tx) => insertRow(tx, "clinical_settings", clinicalSettings()));
    expect(row).toMatchObject({
      default_recall_weeks: 6,
      default_expected_sessions: 4,
      default_session_interval_weeks: 2,
      active_test_codes: [],
      referral_prompts: ["R1", "R2", "R3"],
      pediatric_red_flags_enabled: false,
    });
  });

  it("active_test_codes non ha un default: lo scrive il seed, senza è 23502", async () => {
    await expectPgError(
      inStudioC((tx) => insertRow(tx, "clinical_settings", { practice_id: PRACTICE_C })),
      "23502",
    );
  });

  it.each<Case>([
    ["referral_prompts", ["R4"]],
    ["referral_prompts", ["R1", "R4"]],
    ["default_recall_weeks", 53],
    ["default_recall_weeks", 1],
    ["default_expected_sessions", 0],
    ["default_expected_sessions", 21],
    ["default_session_interval_weeks", 5],
    ["default_session_interval_weeks", 0],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inStudioC((tx) => insertRow(tx, "clinical_settings", clinicalSettings({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["referral_prompts", []],
    ["referral_prompts", ["R2"]],
    ["default_recall_weeks", 2],
    ["default_recall_weeks", 52],
    ["default_expected_sessions", 1],
    ["default_expected_sessions", 20],
    ["default_session_interval_weeks", 1],
    ["default_session_interval_weeks", 4],
    ["active_test_codes", ["slr", "faber"]],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inStudioC((tx) => insertRow(tx, "clinical_settings", clinicalSettings({ [column]: value })));
    expect(row[column]).toEqual(value);
  });
});
