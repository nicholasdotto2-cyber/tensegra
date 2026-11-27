import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/db";
import { GUARDIAN_A, PATIENT_A1, PATIENT_A2, PATIENT_A3, PHYSICIAN_A, PRACTICE_A } from "./fixtures";
import {
  type Case,
  expectBlockedDelete,
  expectPgError,
  inRollback,
  insertRow,
  inService,
  openTestDb,
  type Values,
} from "./helpers";

// Vincoli, default e ricerca dei pazienti: physicians, patients, patient_guardians,
// patient_history_items, patient_systems_review, patient_lifestyle e perinatal_histories. Ogni test
// gira in una transazione che torna indietro, sullo studio A delle fixture (3 pazienti: A1 con
// l'anamnesi, A3 minore con un genitore che è contatto e intestatario); un caso che fallisce per
// transazione, con il codice Postgres esatto.

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const physician = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  full_name: "Dott.ssa Anna Verdi",
  role: "mmg",
  ...extra,
});

const patient = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  first_name: "Mario",
  last_name: "Rossi",
  birth_date: "1985-06-15",
  addressing: "lei",
  ...extra,
});

// A1 non ha genitori: i flag e il limite si provano su di lui, salvo dove serve il minore A3.
const guardian = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  patient_id: PATIENT_A1,
  relationship: "madre",
  first_name: "Laura",
  last_name: "Greco",
  ...extra,
});

const historyItem = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  patient_id: PATIENT_A2,
  kind: "trauma",
  label: "Distorsione di caviglia",
  ...extra,
});

const systemsReview = (extra: Values = {}): Values => ({
  practice_id: PRACTICE_A,
  patient_id: PATIENT_A2,
  system: "digerente",
  reviewed_on: "2026-10-01",
  ...extra,
});

// A2 non ha né stile di vita né storia perinatale: la prima riga di A1 sta già nelle fixture.
const lifestyle = (extra: Values = {}): Values => ({ practice_id: PRACTICE_A, patient_id: PATIENT_A2, ...extra });
const perinatal = (extra: Values = {}): Values => ({ practice_id: PRACTICE_A, patient_id: PATIENT_A2, ...extra });

const REGIONS = [
  "head",
  "cervical",
  "thoracic",
  "lumbar",
  "sacral",
  "pelvic",
  "lower_extremity",
  "upper_extremity",
  "rib_cage",
  "abdomen_other",
];

describe("app.region_codes", () => {
  it("sono le dieci regioni", async () => {
    const rows = await inService(db, (tx) => tx.query<{ codes: string[] }>("select app.region_codes() as codes"));
    expect(rows).toEqual([{ codes: REGIONS }]);
  });
});

describe("public.physicians", () => {
  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "physicians", physician()));
    expect(row).toMatchObject({ archived_at: null, notes: null, email: null });
  });

  it.each<Case>([
    ["full_name", "A"],
    ["full_name", "   "],
    ["full_name", "a".repeat(121)],
    ["role", "dentista"],
    ["email", "medico@"],
    ["notes", "a".repeat(501)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "physicians", physician({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["full_name", "Dr"],
    ["full_name", "a".repeat(120)],
    ["role", "mmg"],
    ["role", "pediatra"],
    ["role", "specialista"],
    ["role", "altro"],
    ["email", "medico@example.com"],
    ["notes", "a".repeat(500)],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "physicians", physician({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  // Una delete bloccata da una chiave `on delete restrict` risponde 23001 su Postgres 18 (restrict_violation) e
  // 23503 su Postgres 17: `expectBlockedDelete` li accetta tutti e due, ma solo se l'errore è quello di una
  // delete. Il 23503 dell'insert e dell'update che puntano a un genitore che non c'è (o di un altro studio) è
  // un'altra cosa, e lo prova `expectPgError`.
  it("un medico a cui punta un paziente non si cancella, nemmeno per il servizio", async () => {
    await expectBlockedDelete(
      inService(db, (tx) => tx.query("delete from public.physicians where id = $1", [PHYSICIAN_A])),
    );
  });
});

describe("public.patients", () => {
  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "patients", patient()));
    expect(row).toMatchObject({
      sex: "nd",
      country: "IT",
      preferred_channel: "whatsapp",
      recall_paused: false,
      recall_interval_weeks: null,
      tax_code: null,
      gp_physician_id: null,
      default_referring_physician_id: null,
      archived_at: null,
    });
  });

  // Un nome di soli spazi vale il vuoto, 60 caratteri passano e 61 no.
  it.each<Case>([
    ["first_name", "   "],
    ["first_name", ""],
    ["first_name", "a".repeat(61)],
    ["last_name", "   "],
    ["last_name", ""],
    ["last_name", "a".repeat(61)],
    ["phone", "+39 333 0000077"],
    ["phone", "3330000077"],
    ["phone", "+39333"],
    ["phone", "+0393330000077"],
    ["tax_code", "rssmra80a01h501u"],
    ["tax_code", "RSSMRA80A01H501"],
    ["tax_code", "RSSMRA80A01H501UX"],
    ["postal_code", "4012"],
    ["postal_code", "401211"],
    ["postal_code", "4012a"],
    ["sex", "x"],
    ["sex", "F"],
    ["recall_interval_weeks", 1],
    ["recall_interval_weeks", 53],
    ["preferred_channel", "sms"],
    ["addressing", "voi"],
    ["clinical_alert", "a".repeat(201)],
    ["admin_notes", "a".repeat(501)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "patients", patient({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["first_name", "a".repeat(60)],
    ["last_name", "a".repeat(60)],
    ["phone", "+393330000077"],
    ["phone", "+123456789012345"],
    ["tax_code", "RSSMRA80A01H501U"],
    ["postal_code", "40121"],
    ["postal_code", null],
    ["sex", "f"],
    ["sex", "m"],
    ["sex", "nd"],
    ["recall_interval_weeks", 2],
    ["recall_interval_weeks", 52],
    ["preferred_channel", "telefono"],
    ["preferred_channel", "nessuno"],
    ["addressing", "tu"],
    ["clinical_alert", "a".repeat(200)],
    ["admin_notes", "a".repeat(500)],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "patients", patient({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it("il CAP di quattro cifre passa fuori dall'Italia", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "patients", patient({ postal_code: "4012", country: "CH" })));
    expect(row).toMatchObject({ postal_code: "4012", country: "CH" });
  });

  it.each(["birth_date", "addressing"])("senza %s: 23502", async (missing) => {
    const without = Object.fromEntries(Object.entries(patient()).filter(([column]) => column !== missing));
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "patients", without)),
      "23502",
    );
  });

  it("il medico curante può essere un medico dello stesso studio", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "patients", patient({ gp_physician_id: PHYSICIAN_A })));
    expect(row.gp_physician_id).toBe(PHYSICIAN_A);
  });

  // La delete attraversa la chiave `cascade` dei genitori e si ferma sulle chiavi `restrict` (delete bloccata, vedi sopra).
  // Niente cancellazione fisica dei dati clinici, quindi ognuna delle quattro tabelle figlie deve
  // fermare la delete da sola. A1 ha una riga in tutte e quattro e una chiave scritta `cascade` resterebbe
  // coperta dalle altre tre: la prova usa A2, che non ne ha, e gli dà una sola riga per volta.
  it("A2 senza righe figlie si cancella (controllo delle prove che seguono)", async () => {
    const deleted = await inRollback(db, "A", (tx) =>
      tx.query("delete from public.patients where id = $1 returning id", [PATIENT_A2]),
    );
    expect(deleted).toEqual([{ id: PATIENT_A2 }]);
  });

  it.each<[table: string, row: Values]>([
    ["patient_history_items", historyItem()],
    ["patient_systems_review", systemsReview()],
    ["patient_lifestyle", lifestyle()],
    ["perinatal_histories", perinatal()],
  ])("con una riga in %s non si cancella", async (table, row) => {
    await expectBlockedDelete(
      inRollback(db, "A", async (tx) => {
        await insertRow(tx, table, row);
        return tx.query("delete from public.patients where id = $1", [PATIENT_A2]);
      }),
    );
  });

  it("con il solo genitore si cancella e il genitore sparisce", async () => {
    const { deleted, patients, guardians } = await inRollback(db, "A", async (tx) => {
      const deleted = await tx.query("delete from public.patients where id = $1 returning id", [PATIENT_A3]);
      const [patients] = await tx.query<{ n: number }>("select count(*)::int as n from public.patients where id = $1", [
        PATIENT_A3,
      ]);
      const [guardians] = await tx.query<{ n: number }>(
        "select count(*)::int as n from public.patient_guardians where patient_id = $1",
        [PATIENT_A3],
      );
      return { deleted, patients: patients?.n, guardians: guardians?.n };
    });
    expect(deleted).toEqual([{ id: PATIENT_A3 }]);
    expect(patients).toBe(0);
    expect(guardians).toBe(0);
  });
});

describe("public.patient_guardians", () => {
  it("i default", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "patient_guardians", guardian()));
    expect(row).toMatchObject({ country: "IT", has_parental_authority: true, is_contact: false, is_payer: false });
  });

  it.each<Case>([
    ["relationship", "nonno"],
    ["first_name", "   "],
    ["first_name", "a".repeat(61)],
    ["last_name", ""],
    ["last_name", "a".repeat(61)],
    ["tax_code", "rssmra80a01h501u"],
    ["phone", "333 0000077"],
    ["phone", "+39 333 0000077"],
    ["postal_code", "4012"],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "patient_guardians", guardian({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["relationship", "tutore"],
    ["first_name", "a".repeat(60)],
    ["tax_code", "RSSMRA80A01H501U"],
    ["phone", "+393330000077"],
    ["postal_code", "40121"],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "patient_guardians", guardian({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it("il CAP di quattro cifre passa fuori dall'Italia", async () => {
    const row = await inService(db, (tx) =>
      insertRow(tx, "patient_guardians", guardian({ postal_code: "4012", country: "CH" })),
    );
    expect(row).toMatchObject({ postal_code: "4012", country: "CH" });
  });

  it("il secondo genitore dello stesso paziente passa", async () => {
    const rows = await inService(db, async (tx) => {
      await insertRow(tx, "patient_guardians", guardian());
      await insertRow(tx, "patient_guardians", guardian({ relationship: "padre", first_name: "Paolo" }));
      return tx.query("select id from public.patient_guardians where patient_id = $1", [PATIENT_A1]);
    });
    expect(rows).toHaveLength(2);
  });

  it("il terzo genitore dello stesso paziente: 23514", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        await insertRow(tx, "patient_guardians", guardian());
        await insertRow(tx, "patient_guardians", guardian({ relationship: "padre", first_name: "Paolo" }));
        await insertRow(tx, "patient_guardians", guardian({ relationship: "tutore", first_name: "Rita" }));
      }),
      "23514",
    );
  });

  it("il limite conta i genitori di quel paziente, non quelli degli altri", async () => {
    const rows = await inService(db, async (tx) => {
      // A3 ha già il genitore della fixture: A1 ne prende due, e nessuno dei due urta il limite.
      await insertRow(tx, "patient_guardians", guardian());
      await insertRow(tx, "patient_guardians", guardian({ relationship: "padre", first_name: "Paolo" }));
      return tx.query("select id from public.patient_guardians where practice_id = $1", [PRACTICE_A]);
    });
    expect(rows).toHaveLength(3);
  });

  it("spostare un genitore su un paziente che ne ha già due: 23514", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        await insertRow(tx, "patient_guardians", guardian());
        await insertRow(tx, "patient_guardians", guardian({ relationship: "padre", first_name: "Paolo" }));
        await tx.query("update public.patient_guardians set patient_id = $1 where id = $2", [PATIENT_A1, GUARDIAN_A]);
      }),
      "23514",
    );
  });

  it("riscrivere patient_id su un paziente che ne ha due, il proprio, passa: la riga stessa non conta", async () => {
    const rows = await inService(db, async (tx) => {
      await insertRow(tx, "patient_guardians", guardian({ patient_id: PATIENT_A3, relationship: "padre" }));
      return tx.query("update public.patient_guardians set patient_id = $1 where id = $2 returning id", [
        PATIENT_A3,
        GUARDIAN_A,
      ]);
    });
    expect(rows).toEqual([{ id: GUARDIAN_A }]);
  });

  // A3 ha già il genitore della fixture, contatto e intestatario.
  it("un secondo is_contact: 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "patient_guardians", guardian({ patient_id: PATIENT_A3, is_contact: true }))),
      "23505",
    );
  });

  it("un secondo is_payer: 23505", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "patient_guardians", guardian({ patient_id: PATIENT_A3, is_payer: true }))),
      "23505",
    );
  });

  it("is_contact al secondo genitore prima di toglierlo al primo: 23505", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        const second = await insertRow(tx, "patient_guardians", guardian({ patient_id: PATIENT_A3, relationship: "padre" }));
        await tx.query("update public.patient_guardians set is_contact = true where id = $1", [second.id as string]);
      }),
      "23505",
    );
  });

  it("due pazienti diversi hanno ciascuno il proprio contatto e il proprio intestatario", async () => {
    const row = await inService(db, (tx) =>
      insertRow(tx, "patient_guardians", guardian({ patient_id: PATIENT_A1, is_contact: true, is_payer: true })),
    );
    expect(row).toMatchObject({ is_contact: true, is_payer: true });
  });

  it("contatto e intestatario possono essere due genitori diversi", async () => {
    const rows = await inService(db, async (tx) => {
      await tx.query("update public.patient_guardians set is_payer = false where id = $1", [GUARDIAN_A]);
      await insertRow(tx, "patient_guardians", guardian({ patient_id: PATIENT_A3, relationship: "padre", is_payer: true }));
      return tx.query("select is_contact, is_payer from public.patient_guardians where patient_id = $1 order by is_contact desc", [
        PATIENT_A3,
      ]);
    });
    expect(rows).toEqual([
      { is_contact: true, is_payer: false },
      { is_contact: false, is_payer: true },
    ]);
  });

  // Il cambio del genitore di riferimento di un minore, due update nella stessa transazione.
  it("il contatto passa dal primo al secondo genitore con due update nella stessa transazione", async () => {
    const { contacts, secondId } = await inRollback(db, "A", async (tx) => {
      const second = await insertRow(tx, "patient_guardians", guardian({ patient_id: PATIENT_A3, relationship: "padre" }));
      const secondId = second.id as string;
      await tx.query("update public.patient_guardians set is_contact = false where id = $1", [GUARDIAN_A]);
      await tx.query("update public.patient_guardians set is_contact = true where id = $1", [secondId]);
      const contacts = await tx.query<{ id: string }>(
        "select id::text as id from public.patient_guardians where patient_id = $1 and is_contact",
        [PATIENT_A3],
      );
      return { contacts, secondId };
    });
    expect(contacts).toEqual([{ id: secondId }]);
  });
});

describe("public.patient_history_items", () => {
  it("i default: risk_tags vuoto, in corso, non cancellata", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "patient_history_items", historyItem()));
    expect(row).toMatchObject({ risk_tags: [], ongoing: true, region: null, deleted_at: null });
  });

  it("region 'collo': 23514", async () => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "patient_history_items", historyItem({ region: "collo" }))),
      "23514",
    );
  });

  it.each(REGIONS)("region %s: accettata", async (region) => {
    const row = await inService(db, (tx) => insertRow(tx, "patient_history_items", historyItem({ region })));
    expect(row.region).toBe(region);
  });

  it.each<Case>([
    ["kind", "visita"],
    ["label", "a".repeat(201)],
    ["note", "a".repeat(501)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "patient_history_items", historyItem({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["kind", "patologia"],
    ["kind", "farmaco"],
    ["kind", "intervento"],
    ["kind", "trauma"],
    ["kind", "allergia"],
    ["kind", "esame"],
    ["label", "a".repeat(200)],
    ["note", "a".repeat(500)],
    ["occurred_year", 2019],
    ["risk_tags", ["anticoagulante_tao", "cicatrice"]],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "patient_history_items", historyItem({ [column]: value })));
    expect(row[column]).toEqual(value);
  });
});

describe("public.patient_systems_review", () => {
  it("i default: niente da segnalare", async () => {
    const row = await inService(db, (tx) => insertRow(tx, "patient_systems_review", systemsReview()));
    expect(row).toMatchObject({ status: "nulla", note: null });
  });

  it("stesso system due volte per lo stesso paziente: 23505", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        await insertRow(tx, "patient_systems_review", systemsReview());
        await insertRow(tx, "patient_systems_review", systemsReview({ status: "da_segnalare" }));
      }),
      "23505",
    );
  });

  it("lo stesso system per un altro paziente, e un altro system per lo stesso: accettati", async () => {
    const rows = await inService(db, async (tx) => {
      await insertRow(tx, "patient_systems_review", systemsReview());
      await insertRow(tx, "patient_systems_review", systemsReview({ patient_id: PATIENT_A3 }));
      await insertRow(tx, "patient_systems_review", systemsReview({ system: "sonno" }));
      return tx.query("select id from public.patient_systems_review where practice_id = $1", [PRACTICE_A]);
    });
    // Le tre inserite più la riga di A1 delle fixture.
    expect(rows).toHaveLength(4);
  });

  it.each<Case>([
    ["system", "vista"],
    ["status", "forse"],
    ["note", "a".repeat(301)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "patient_systems_review", systemsReview({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["system", "urogenitale"],
    ["system", "respiratorio"],
    ["system", "cardiocircolatorio"],
    ["system", "orl_vista"],
    ["system", "stomatognatico"],
    ["system", "sonno"],
    ["system", "stress_umore"],
    ["status", "da_segnalare"],
    ["note", "a".repeat(300)],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) =>
      insertRow(tx, "patient_systems_review", systemsReview({ [column]: value })),
    );
    expect(row[column]).toBe(value);
  });

  it("senza reviewed_on: 23502", async () => {
    await expectPgError(
      inService(db, (tx) =>
        insertRow(tx, "patient_systems_review", { practice_id: PRACTICE_A, patient_id: PATIENT_A2, system: "digerente" }),
      ),
      "23502",
    );
  });
});

describe("public.patient_lifestyle", () => {
  it("una seconda riga per lo stesso paziente: 23505", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        await insertRow(tx, "patient_lifestyle", lifestyle());
        await insertRow(tx, "patient_lifestyle", lifestyle({ occupation: "Altro" }));
      }),
      "23505",
    );
  });

  it.each<Case>([
    ["pregnancy_weeks", 43],
    ["pregnancy_weeks", 0],
    ["pregnancy_status", "forse"],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "patient_lifestyle", lifestyle({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["pregnancy_weeks", 1],
    ["pregnancy_weeks", 42],
    ["pregnancy_status", "no"],
    ["pregnancy_status", "in_corso"],
    ["pregnancy_status", "post_partum"],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "patient_lifestyle", lifestyle({ [column]: value })));
    expect(row[column]).toBe(value);
  });
});

describe("public.perinatal_histories", () => {
  it("una seconda riga per lo stesso paziente: 23505", async () => {
    await expectPgError(
      inService(db, async (tx) => {
        await insertRow(tx, "perinatal_histories", perinatal());
        await insertRow(tx, "perinatal_histories", perinatal({ notes: "Altro" }));
      }),
      "23505",
    );
  });

  it.each<Case>([
    ["gestational_age_weeks", 21],
    ["gestational_age_weeks", 45],
    ["birth_weight_g", 299],
    ["birth_weight_g", 6501],
    ["delivery_mode", "cesareo"],
    ["presentation", "obliqua"],
    ["labour_hours", 72.1],
    ["labour_hours", -0.1],
    ["apgar_1", 11],
    ["apgar_1", -1],
    ["apgar_5", 11],
    ["feeding", "latte"],
    ["preferred_head_side", "destra"],
    ["notes", "a".repeat(1001)],
  ])("valore fuori formato %s = %j: 23514", async (column, value) => {
    await expectPgError(
      inService(db, (tx) => insertRow(tx, "perinatal_histories", perinatal({ [column]: value }))),
      "23514",
    );
  });

  it.each<Case>([
    ["gestational_age_weeks", 22],
    ["gestational_age_weeks", 44],
    ["birth_weight_g", 300],
    ["birth_weight_g", 6500],
    ["delivery_mode", "operativo_ventosa"],
    ["delivery_mode", "operativo_forcipe"],
    ["delivery_mode", "cesareo_programmato"],
    ["delivery_mode", "cesareo_urgente"],
    ["presentation", "podalica"],
    ["apgar_1", 0],
    ["apgar_1", 10],
    ["apgar_5", 10],
    ["nicu_stay", true],
    ["feeding", "misto"],
    ["preferred_head_side", "nessuna"],
    ["notes", "a".repeat(1000)],
  ])("valore in formato %s = %j: accettato", async (column, value) => {
    const row = await inService(db, (tx) => insertRow(tx, "perinatal_histories", perinatal({ [column]: value })));
    expect(row[column]).toBe(value);
  });

  it("le ore di travaglio da 0 a 72 sono accettate (numeric arriva come stringa)", async () => {
    const rows = await inService(db, async (tx) => [
      await insertRow(tx, "perinatal_histories", perinatal({ labour_hours: 0 })),
      await insertRow(tx, "perinatal_histories", perinatal({ patient_id: PATIENT_A3, labour_hours: 72 })),
    ]);
    expect(rows.map((row) => row.labour_hours)).toEqual(["0.0", "72.0"]);
  });
});

// La ricerca della lista pazienti: l'espressione è scritta esattamente come
// l'indice, perché il planner lo usi. `$1` è il testo cercato.
const searchWhere = (arg: string): string =>
  `app.search_text(first_name || ' ' || last_name || ' ' || first_name) like '%' || app.search_text(${arg}) || '%'`;

describe("ricerca dei pazienti", () => {
  it.each<[string, number]>([
    ["bellandi", 1],
    ["BELLANDÌ marco", 1],
    ["marco bellandi", 1],
    ["Marco Bellandì", 1],
    ["ellan", 1],
    ["rossi", 0],
    ["bellandini", 0],
  ])("trova Marco Bellandì con %j: %i riga", async (query, expected) => {
    const rows = await inRollback(db, "A", async (tx) => {
      await tx.query(
        `insert into public.patients (practice_id, first_name, last_name, birth_date, addressing)
         values ($1, 'Marco', 'Bellandì', '1980-01-01', 'lei')`,
        [PRACTICE_A],
      );
      return tx.query<{ first_name: string; last_name: string }>(
        `select first_name, last_name from public.patients where ${searchWhere("$1")}`,
        [query],
      );
    });
    expect(rows).toEqual(expected === 1 ? [{ first_name: "Marco", last_name: "Bellandì" }] : []);
  });

  it("un nome scritto senza accento si trova anche con l'accento nella ricerca", async () => {
    const rows = await inRollback(db, "A", async (tx) => {
      await tx.query(
        `insert into public.patients (practice_id, first_name, last_name, birth_date, addressing)
         values ($1, 'Nicolò', 'Dandrea', '1980-01-01', 'lei')`,
        [PRACTICE_A],
      );
      return tx.query<{ first_name: string }>(`select first_name from public.patients where ${searchWhere("$1")}`, ["NICOLO"]);
    });
    expect(rows).toEqual([{ first_name: "Nicolò" }]);
  });

  it("il planner usa l'indice trigram", async () => {
    const plan = await inRollback(db, "service", async (tx) => {
      await tx.query("set local enable_seqscan = off");
      const rows = await tx.query<Record<string, string>>(
        `explain select id from public.patients where ${searchWhere("'bellandi'")}`,
      );
      return rows.map((row) => Object.values(row).join(" ")).join("\n");
    });
    expect(plan).toContain("patients_search_trgm_idx");
  });
});
