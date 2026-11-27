import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionFailure } from "@/server/actions/result";
import { DEFAULT_ACTIVE_TEST_CODES } from "@/lib/clinical/catalog";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { switchToUser } from "@/server/db/service";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import {
  saveClinicalSettings,
  saveDemoTestPhone,
  saveOpeningHours,
  saveRegistration,
  saveStudio,
} from "@/server/domain/settings/commands";
import { getClinicalSettings, getOpeningHours, getPracticeSettings } from "@/server/domain/settings/queries";
import { CYCLE_A, PATIENT_A1, PRACTICE_A, SERVICE_A } from "./fixtures";
import { asUserA, asUserB, expectPgError, inRollback, inUserA, openTestDb } from "./helpers";

// Comandi di Impostazioni: ogni sezione si salva da sola, con i testi dei campi
// prima dei check del database; gli orari si sostituiscono in una transazione e dicono quanti
// appuntamenti futuri restano fuori; i flag della demo li scrive solo il seed.

const clock = fixedClock("2026-11-04T08:30:00+01:00");

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const STUDIO = {
  practiceName: "Studio Osteopatico Borgo Tiglio",
  practitionerFirstName: "Laura",
  practitionerLastName: "Benedetti",
  practitionerTitle: "Osteopata",
  addressLine: "Via delle Prove 7",
  postalCode: "40121",
  city: "Bologna",
  province: "BO",
  phone: "+39 051 000 0000",
  email: "studio@example.com",
  pec: "",
};

const REGISTRATION = {
  registrationKind: "ese",
  registrationOrder: "Ordine TSRM PSTRP di Bologna",
  registrationProvince: "BO",
  registrationNumber: "0000",
  registrationDate: "",
  insuranceCompany: "Compagnia Esempio Assicurazioni",
  insurancePolicyNumber: "RC-0000-DEMO",
  insuranceLimitEuros: 2_000_000,
  insuranceExpiresOn: "2027-05-23",
};

const MORNING = { opens: "09:00", closes: "13:00" };
const AFTERNOON = { opens: "14:30", closes: "19:30" };

type Band = { opens: string; closes: string };

/** Una settimana con le fasce date per giorno ISO; i giorni assenti sono chiusi. */
function hours(bands: Partial<Record<number, Band[]>>) {
  return { days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, bands: bands[weekday] ?? [] })) };
}

/** Gli orari del seed: lun-ven 09:00-13:00 e 14:30-19:30, sab 09:00-13:00, dom chiuso. */
const SEED_HOURS = hours({
  1: [MORNING, AFTERNOON],
  2: [MORNING, AFTERNOON],
  3: [MORNING, AFTERNOON],
  4: [MORNING, AFTERNOON],
  5: [MORNING, AFTERNOON],
  6: [MORNING],
});

const CLINICAL = {
  defaultRecallWeeks: 6,
  defaultExpectedSessions: 4,
  defaultSessionIntervalWeeks: 2,
  referralPrompts: ["R1", "R3"],
};

const nameOf = (err: unknown): unknown => (err as { name?: unknown } | null)?.name;

/** L'errore con cui il comando fallisce; se riesce, il test fallisce. */
function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (value: unknown) => expect.fail(`atteso un errore, invece il comando ha restituito ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );
}

/** Il comando fallisce prima del database (DomainError o ZodError): la risposta che arriva al modulo. */
async function formFailure(p: Promise<unknown>) {
  const error = await rejectionOf(p);
  expect(["DomainError", "ZodError"], String(error)).toContain(nameOf(error));
  return toActionFailure(error, "test");
}

/** Il comando risponde "Operazione non permessa" con un DomainError, quindi la transazione resta valida. */
async function expectNotAllowed(p: Promise<unknown>): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(NOT_ALLOWED);
}

async function settingsRow(tx: Tx, practiceId: string = PRACTICE_A): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx.query("select * from public.practice_settings where practice_id = $1", [practiceId]);
  return row;
}

async function practiceRow(tx: Tx, practiceId: string = PRACTICE_A): Promise<{ name: string; updated_at: Date }> {
  const [row] = await tx.query<{ name: string; updated_at: Date }>(
    "select name, updated_at from public.practices where id = $1",
    [practiceId],
  );
  if (!row) throw new Error("studio non trovato");
  return row;
}

async function hourRows(tx: Tx, practiceId: string = PRACTICE_A) {
  return tx.query<{ id: string; weekday: number; slot: number; opens_at: string; closes_at: string }>(
    `select id, weekday, slot, opens_at::text as opens_at, closes_at::text as closes_at
       from public.opening_hours
      where practice_id = $1
      order by weekday, slot`,
    [practiceId],
  );
}

/** Un appuntamento di A (primo paziente, suo ciclo, seduta del listino), inserito come uA. */
async function insertAppointment(
  tx: Tx,
  startsAt: string,
  status: "prenotato" | "confermato" | "fatto" | "saltato" | "annullato" = "prenotato",
  durationMin = 45,
): Promise<void> {
  await tx.query(
    `insert into public.appointments
       (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status, cancel_reason)
     values ($1, $2, $3, $4, $5, $6, 6000, $7, $8)`,
    [PRACTICE_A, PATIENT_A1, SERVICE_A, CYCLE_A, startsAt, durationMin, status, status === "annullato" ? "paziente" : null],
  );
}

describe("saveStudio", () => {
  it("saveStudio scrive studio e osteopata", async () => {
    const saved = await inUserA(db, async (tx) => {
      await saveStudio(tx, PRACTICE_A, clock, STUDIO);
      return { practice: await practiceRow(tx), row: await settingsRow(tx), view: await getPracticeSettings(tx, PRACTICE_A) };
    });
    expect(saved.practice.name).toBe("Studio Osteopatico Borgo Tiglio");
    expect(saved.row).toMatchObject({
      practitioner_first_name: "Laura",
      practitioner_last_name: "Benedetti",
      practitioner_title: "Osteopata",
      address_line: "Via delle Prove 7",
      postal_code: "40121",
      city: "Bologna",
      province: "BO",
      phone: "+390510000000",
      email: "studio@example.com",
      pec: null,
    });
    expect(saved.view).toMatchObject({
      practiceName: "Studio Osteopatico Borgo Tiglio",
      practitionerFirstName: "Laura",
      practitionerLastName: "Benedetti",
      practitionerTitle: "Osteopata",
      addressLine: "Via delle Prove 7",
      postalCode: "40121",
      city: "Bologna",
      province: "BO",
      phone: "+390510000000",
      email: "studio@example.com",
      pec: null,
      isDemo: false,
    });
  });

  it("saveStudio: spazi ai lati tolti, campi vuoti a null, +39 aggiunto al telefono", async () => {
    const row = await inUserA(db, async (tx) => {
      await saveStudio(tx, PRACTICE_A, clock, {
        ...STUDIO,
        practiceName: "  Studio Osteopatico Borgo Tiglio ",
        practitionerFirstName: " Laura ",
        addressLine: "   ",
        city: "",
        phone: "051 000 0000",
        email: null,
      });
      return { practice: await practiceRow(tx), row: await settingsRow(tx) };
    });
    expect(row.practice.name).toBe("Studio Osteopatico Borgo Tiglio");
    expect(row.row).toMatchObject({
      practitioner_first_name: "Laura",
      address_line: null,
      city: null,
      phone: "+390510000000",
      email: null,
    });
  });

  it.each([
    ["postalCode", "4012", "Scrivi il CAP con 5 cifre."],
    ["province", "bo", "Scrivi la sigla della provincia, per esempio BO."],
    ["phone", "12", "Scrivi il numero con il prefisso, per esempio +39 051 000 0000."],
    ["email", "studio@", "Scrivi un indirizzo email valido."],
    ["pec", "pec@studio", "Scrivi un indirizzo email valido."],
    ["practitionerFirstName", "   ", "Campo obbligatorio."],
    ["practitionerLastName", "x".repeat(61), "Massimo 60 caratteri."],
    ["practitionerTitle", "", "Campo obbligatorio."],
    ["practiceName", "x".repeat(81), "Massimo 80 caratteri."],
  ])("saveStudio: formati, %s %j", async (field, value, message) => {
    const outcome = await inUserA(db, async (tx) => {
      const failure = await formFailure(saveStudio(tx, PRACTICE_A, clock, { ...STUDIO, [field]: value }));
      return { failure, practice: await practiceRow(tx), row: await settingsRow(tx) };
    });
    expect(outcome.failure.fieldErrors?.[field]).toBe(message);
    // Niente scritto: lo studio e l'osteopata restano quelli della fixture.
    expect(outcome.practice.name).toBe("Studio A");
    expect(outcome.row).toMatchObject({ practitioner_first_name: "Anna", phone: null });
  });

  it("saveStudio rifiuta isDemo", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const failure = await formFailure(saveStudio(tx, PRACTICE_A, clock, { ...STUDIO, isDemo: true }));
      return { failure, practice: await practiceRow(tx), row: await settingsRow(tx) };
    });
    expect(outcome.failure).toEqual({ ok: false, refused: true, message: "Valore non valido" });
    expect(outcome.row?.is_demo).toBe(false);
    expect(outcome.practice.name).toBe("Studio A");
  });

  it("saveStudio con lo stesso nome", async () => {
    const stamps = await inUserA(db, async (tx) => {
      const before = await practiceRow(tx);
      await saveStudio(tx, PRACTICE_A, clock, { ...STUDIO, practiceName: "Studio A" });
      const sameName = await practiceRow(tx);
      await saveStudio(tx, PRACTICE_A, clock, STUDIO);
      const newName = await practiceRow(tx);
      return { before, sameName, newName };
    });
    // Il comando non tocca `practices` se il nome non cambia: il trigger di updated_at non scatta.
    expect(stamps.sameName.updated_at).toEqual(stamps.before.updated_at);
    expect(stamps.newName.name).toBe("Studio Osteopatico Borgo Tiglio");
    expect(stamps.newName.updated_at).not.toEqual(stamps.before.updated_at);
  });

  it("su uno studio senza impostazioni: saveStudio e saveClinicalSettings creano la riga, saveRegistration no", async () => {
    const USER_C = "c0000000-0000-4000-8000-00000000000c";
    const PRACTICE_C = "c0000000-0000-4000-8000-000000000001";
    const outcome = await inRollback(db, "service", async (tx) => {
      // Come il seed: studio e membership come servizio, poi tutto come l'utente.
      await tx.query("insert into auth.users (id, email) values ($1, 'c@example.test')", [USER_C]);
      await tx.query("insert into public.practices (id, name) values ($1, $2)", [PRACTICE_C, STUDIO.practiceName]);
      await tx.query("insert into public.memberships (practice_id, user_id) values ($1, $2)", [PRACTICE_C, USER_C]);
      await switchToUser(tx, { userId: USER_C });

      // L'update di Iscrizione e polizza non trova la riga: 0 righe, "Operazione non permessa".
      await expectNotAllowed(saveRegistration(tx, PRACTICE_C, clock, REGISTRATION));
      await saveStudio(tx, PRACTICE_C, clock, STUDIO);
      await saveRegistration(tx, PRACTICE_C, clock, REGISTRATION);
      await saveClinicalSettings(tx, PRACTICE_C, clock, CLINICAL);
      const [clinical] = await tx.query(
        `select default_recall_weeks, default_expected_sessions, default_session_interval_weeks, referral_prompts,
                active_test_codes, pediatric_red_flags_enabled, created_by::text as created_by
           from public.clinical_settings where practice_id = $1`,
        [PRACTICE_C],
      );
      return { settings: await settingsRow(tx, PRACTICE_C), clinical };
    });
    expect(outcome.settings).toMatchObject({
      practitioner_first_name: "Laura",
      phone: "+390510000000",
      registration_kind: "ese",
      insurance_limit_cents: 200_000_000,
      is_demo: false,
      created_by: USER_C,
    });
    expect(outcome.clinical).toEqual({
      default_recall_weeks: 6,
      default_expected_sessions: 4,
      default_session_interval_weeks: 2,
      referral_prompts: ["R1", "R3"],
      // La prima riga parte dai 24 test di default, in ordine.
      active_test_codes: [...DEFAULT_ACTIVE_TEST_CODES].sort(),
      pediatric_red_flags_enabled: false,
      created_by: USER_C,
    });
  });
});

describe("saveRegistration", () => {
  it("saveRegistration scrive iscrizione e polizza, il massimale in centesimi", async () => {
    const saved = await inUserA(db, async (tx) => {
      await saveRegistration(tx, PRACTICE_A, clock, REGISTRATION);
      return { row: await settingsRow(tx), view: await getPracticeSettings(tx, PRACTICE_A) };
    });
    expect(saved.row).toMatchObject({
      registration_kind: "ese",
      registration_order: "Ordine TSRM PSTRP di Bologna",
      registration_province: "BO",
      registration_number: "0000",
      registration_date: null,
      insurance_company: "Compagnia Esempio Assicurazioni",
      insurance_policy_number: "RC-0000-DEMO",
      insurance_limit_cents: 200_000_000,
      insurance_expires_on: "2027-05-23",
    });
    expect(saved.view).toMatchObject({
      registrationKind: "ese",
      registrationDate: null,
      insuranceLimitCents: 200_000_000,
      insuranceExpiresOn: "2027-05-23",
    });
  });

  it("saveRegistration: il massimale più alto, la data d'iscrizione e i campi vuoti", async () => {
    const row = await inUserA(db, async (tx) => {
      await saveRegistration(tx, PRACTICE_A, clock, {
        ...REGISTRATION,
        registrationKind: "albo",
        registrationDate: "2021-03-15",
        insuranceLimitEuros: 21_474_836,
      });
      const highest = await settingsRow(tx);
      await saveRegistration(tx, PRACTICE_A, clock, {
        ...REGISTRATION,
        registrationKind: "nessuna",
        registrationOrder: "",
        registrationProvince: null,
        insuranceLimitEuros: "",
        insuranceExpiresOn: "",
      });
      return { highest, emptied: await settingsRow(tx) };
    });
    expect(row.highest).toMatchObject({
      registration_kind: "albo",
      registration_date: "2021-03-15",
      insurance_limit_cents: 2_147_483_600,
    });
    expect(row.emptied).toMatchObject({
      registration_kind: "nessuna",
      registration_order: null,
      registration_province: null,
      insurance_limit_cents: null,
      insurance_expires_on: null,
    });
  });

  it.each([
    ["registrationKind", "iscritto", "Valore non valido"],
    ["insuranceLimitEuros", 21_474_837, "Scrivi un importo intero in euro, da 1 a 21.474.836."],
    ["insuranceLimitEuros", 0, "Scrivi un importo intero in euro, da 1 a 21.474.836."],
    ["insuranceLimitEuros", 1500.5, "Scrivi un importo intero in euro, da 1 a 21.474.836."],
    ["insuranceLimitEuros", "2000000", "Scrivi un importo intero in euro, da 1 a 21.474.836."],
    ["registrationProvince", "bo", "Scrivi la sigla della provincia, per esempio BO."],
    ["registrationOrder", "x".repeat(61), "Massimo 60 caratteri."],
    ["registrationNumber", "1".repeat(61), "Massimo 60 caratteri."],
    ["registrationDate", "15/03/2021", "Scrivi la data nel formato 22/10/2026."],
    ["insuranceExpiresOn", "2027-02-30", "Scrivi la data nel formato 22/10/2026."],
  ])("saveRegistration: %s %j", async (field, value, message) => {
    const outcome = await inUserA(db, async (tx) => {
      const failure = await formFailure(saveRegistration(tx, PRACTICE_A, clock, { ...REGISTRATION, [field]: value }));
      return { failure, row: await settingsRow(tx) };
    });
    expect(outcome.failure.fieldErrors?.[field]).toBe(message);
    expect(outcome.row).toMatchObject({ registration_kind: "nessuna", insurance_limit_cents: null });
  });
});

describe("saveOpeningHours", () => {
  it("saveOpeningHours sostituisce le righe", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const fixture = await hourRows(tx);
      const result = await saveOpeningHours(tx, PRACTICE_A, clock, SEED_HOURS);
      return { fixture, result, rows: await hourRows(tx) };
    });
    expect(outcome.fixture).toHaveLength(1);
    expect(outcome.rows).toHaveLength(11);
    expect(outcome.rows.filter((r) => r.weekday === 1).map(({ slot, opens_at, closes_at }) => [slot, opens_at, closes_at])).toEqual([
      [1, "09:00:00", "13:00:00"],
      [2, "14:30:00", "19:30:00"],
    ]);
    expect(outcome.rows.filter((r) => r.weekday === 6).map(({ slot, opens_at }) => [slot, opens_at])).toEqual([[1, "09:00:00"]]);
    expect(outcome.rows.some((r) => r.weekday === 7)).toBe(false);
    const fixtureIds = outcome.fixture.map((r) => r.id);
    expect(outcome.rows.filter((r) => fixtureIds.includes(r.id))).toEqual([]);
    // L'appuntamento della fixture (5/10) è passato: nessun futuro fuori orario.
    expect(outcome.result).toEqual({ outsideCount: 0, firstOutsideDay: null });
  });

  it("saveOpeningHours numera le fasce per inizio", async () => {
    const rows = await inUserA(db, async (tx) => {
      await saveOpeningHours(tx, PRACTICE_A, clock, hours({ 2: [AFTERNOON, MORNING] }));
      return hourRows(tx);
    });
    expect(rows.map(({ weekday, slot, opens_at }) => [weekday, slot, opens_at])).toEqual([
      [2, 1, "09:00:00"],
      [2, 2, "14:30:00"],
    ]);
  });

  it("saveOpeningHours: tutti i giorni chiusi cancella ogni riga", async () => {
    const rows = await inUserA(db, async (tx) => {
      await saveOpeningHours(tx, PRACTICE_A, clock, hours({}));
      return hourRows(tx);
    });
    expect(rows).toEqual([]);
  });

  it("saveOpeningHours: gli errori del passo 1 arrivano come fieldErrors e non scrivono niente", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const before = await hourRows(tx);
      const error = await rejectionOf(
        saveOpeningHours(tx, PRACTICE_A, clock, hours({ 1: [{ opens: "09:00", closes: "08:00" }] })),
      );
      const both = await rejectionOf(
        saveOpeningHours(
          tx,
          PRACTICE_A,
          clock,
          hours({ 1: [{ opens: "09:00", closes: "08:00" }], 2: [MORNING, { opens: "12:00", closes: "15:00" }] }),
        ),
      );
      const quarter = await rejectionOf(saveOpeningHours(tx, PRACTICE_A, clock, hours({ 3: [{ opens: "09:10", closes: "13:00" }] })));
      return { before, error, both, quarter, after: await hourRows(tx) };
    });
    expect(isDomainError(outcome.error)).toBe(true);
    expect(outcome.error).toMatchObject({
      message: "L'ora di fine deve venire dopo l'inizio.",
      field: "days.0.bands.0.closes",
    });
    expect(toActionFailure(outcome.error, "test").fieldErrors).toEqual({
      "days.0.bands.0.closes": "L'ora di fine deve venire dopo l'inizio.",
    });
    expect(toActionFailure(outcome.both, "test")).toEqual({
      ok: false,
      refused: true,
      message: "L'ora di fine deve venire dopo l'inizio.",
      fieldErrors: {
        "days.0.bands.0.closes": "L'ora di fine deve venire dopo l'inizio.",
        "days.1.bands.1.opens": "Le due fasce si sovrappongono.",
      },
    });
    expect(toActionFailure(outcome.quarter, "test").fieldErrors).toEqual({
      "days.2.bands.0.opens": "Scegli un orario a passi di 15 minuti.",
    });
    expect(outcome.after).toEqual(outcome.before);
  });

  it.each([
    ["sei giorni", { days: SEED_HOURS.days.slice(0, 6) }],
    ["un giorno ripetuto", { days: [...SEED_HOURS.days.slice(0, 6), { weekday: 1, bands: [] }] }],
    ["tre fasce", hours({ 1: [MORNING, AFTERNOON, { opens: "20:00", closes: "21:00" }] })],
    ["un giorno 8", { days: [...SEED_HOURS.days.slice(0, 6), { weekday: 8, bands: [] }] }],
    ["una chiave in più", { ...SEED_HOURS, practiceId: PRACTICE_A }],
    ["una chiave in più nella fascia", hours({ 1: [{ ...MORNING, slot: 2 } as Band] })],
  ])("saveOpeningHours rifiuta %s", async (_label, input) => {
    const outcome = await inUserA(db, async (tx) => {
      const failure = await formFailure(saveOpeningHours(tx, PRACTICE_A, clock, input));
      return { failure, rows: await hourRows(tx) };
    });
    expect(outcome.failure.ok).toBe(false);
    expect(outcome.failure.message).toBe("Valore non valido");
    expect(outcome.rows).toHaveLength(1);
  });

  it("saveOpeningHours conta i futuri fuori orario", async () => {
    const result = await inUserA(db, async (tx) => {
      await insertAppointment(tx, "2026-11-09T07:00:00Z"); // lunedì 9/11 alle 08:00 di Roma
      await insertAppointment(tx, "2026-11-10T07:00:00Z", "annullato"); // martedì 10/11 alle 08:00
      return saveOpeningHours(tx, PRACTICE_A, clock, SEED_HOURS);
    });
    expect(result).toEqual({ outsideCount: 1, firstOutsideDay: "2026-11-09" });
  });

  it("saveOpeningHours conta prenotati e confermati da 00:00 di oggi, ignora le sovrapposizioni", async () => {
    const result = await inUserA(db, async (tx) => {
      // Fuori orario: oggi alle 08:00 (già passato, ma da 00:00 di oggi), sabato pomeriggio,
      // domenica, e 12:30-13:30 che attraversa la pausa pranzo.
      await insertAppointment(tx, "2026-11-04T07:00:00Z");
      await insertAppointment(tx, "2026-11-07T14:00:00Z", "confermato");
      await insertAppointment(tx, "2026-11-08T09:00:00Z");
      await insertAppointment(tx, "2026-11-09T11:30:00Z", "prenotato", 60);
      // Non contano: ieri, un fatto e un saltato fuori orario, due appuntamenti sovrapposti dentro la fascia.
      await insertAppointment(tx, "2026-11-03T07:00:00Z");
      await insertAppointment(tx, "2026-11-04T06:00:00Z", "fatto");
      await insertAppointment(tx, "2026-11-11T07:00:00Z", "saltato");
      await insertAppointment(tx, "2026-11-12T09:00:00Z");
      await insertAppointment(tx, "2026-11-12T09:15:00Z", "confermato");
      // 12:15-13:00 finisce alla chiusura: dentro.
      await insertAppointment(tx, "2026-11-13T11:15:00Z");
      return saveOpeningHours(tx, PRACTICE_A, clock, SEED_HOURS);
    });
    expect(result).toEqual({ outsideCount: 4, firstOutsideDay: "2026-11-04" });
  });
});

describe("getOpeningHours", () => {
  it("getOpeningHours dopo il salvataggio", async () => {
    const week = await inUserA(db, async (tx) => {
      await saveOpeningHours(tx, PRACTICE_A, clock, SEED_HOURS);
      return getOpeningHours(tx, PRACTICE_A);
    });
    expect(week[1]).toEqual([
      { opensMin: 540, closesMin: 780 },
      { opensMin: 870, closesMin: 1170 },
    ]);
    expect(week[6]).toEqual([{ opensMin: 540, closesMin: 780 }]);
    expect(week[7]).toEqual([]);
  });

  it("getOpeningHours della fixture: solo il lunedì mattina", async () => {
    const week = await inUserA(db, (tx) => getOpeningHours(tx, PRACTICE_A));
    expect(week).toEqual({ 1: [{ opensMin: 540, closesMin: 780 }], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] });
  });
});

describe("saveClinicalSettings", () => {
  it("saveClinicalSettings scrive cadenza, sedute, intervallo e rinvii, il resto non cambia", async () => {
    const outcome = await inUserA(db, async (tx) => {
      // Valori diversi dai default, così si vede che il comando non li tocca.
      await tx.query(
        `update public.clinical_settings
            set active_test_codes = '{T01}', pediatric_red_flags_enabled = true
          where practice_id = $1`,
        [PRACTICE_A],
      );
      await saveClinicalSettings(tx, PRACTICE_A, clock, CLINICAL);
      const first = await clinicalRow(tx);
      await saveClinicalSettings(tx, PRACTICE_A, clock, {
        defaultRecallWeeks: 8,
        defaultExpectedSessions: 6,
        defaultSessionIntervalWeeks: 3,
        referralPrompts: ["R3", "R1", "R3"],
      });
      return { first, second: await clinicalRow(tx), view: await getClinicalSettings(tx, PRACTICE_A) };
    });
    expect(outcome.first).toEqual({
      default_recall_weeks: 6,
      default_expected_sessions: 4,
      default_session_interval_weeks: 2,
      referral_prompts: ["R1", "R3"],
      active_test_codes: ["T01"],
      pediatric_red_flags_enabled: true,
    });
    expect(outcome.second).toMatchObject({
      default_recall_weeks: 8,
      default_expected_sessions: 6,
      default_session_interval_weeks: 3,
      referral_prompts: ["R1", "R3"],
      active_test_codes: ["T01"],
      pediatric_red_flags_enabled: true,
    });
    expect(outcome.view).toEqual({
      defaultRecallWeeks: 8,
      defaultExpectedSessions: 6,
      defaultSessionIntervalWeeks: 3,
      referralPrompts: ["R1", "R3"],
      activeTestCodes: ["T01"],
      pediatricRedFlagsEnabled: true,
    });
  });

  it("saveClinicalSettings: con activeTestCodes scrive quei test, ordinati e senza doppioni", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const before = await clinicalRow(tx);
      await saveClinicalSettings(tx, PRACTICE_A, clock, {
        ...CLINICAL,
        activeTestCodes: ["trendelenburg", "slr", "slr"],
      });
      return { before, after: await clinicalRow(tx), view: await getClinicalSettings(tx, PRACTICE_A) };
    });
    // La riga del banco parte con i test della fixture: il comando li sostituisce.
    expect(outcome.after?.active_test_codes).toEqual(["slr", "trendelenburg"]);
    expect(outcome.after?.active_test_codes).not.toEqual(outcome.before?.active_test_codes);
    expect(outcome.view?.activeTestCodes).toEqual(["slr", "trendelenburg"]);
    // Le red flag pediatriche non le scrive nessun comando: restano spente.
    expect(outcome.view?.pediatricRedFlagsEnabled).toBe(false);
  });

  it("saveClinicalSettings: un test fuori dal catalogo è un errore su activeTestCodes e non scrive niente", async () => {
    const outcome = await inUserA(db, async (tx) => {
      const before = await clinicalRow(tx);
      // Un riflesso dell'esame neurologico non è fra i test che si attivano.
      const failure = await formFailure(
        saveClinicalSettings(tx, PRACTICE_A, clock, { ...CLINICAL, activeTestCodes: ["slr", "riflesso_rotuleo"] }),
      );
      return { failure, before, after: await clinicalRow(tx) };
    });
    expect(outcome.failure.fieldErrors).toEqual({ activeTestCodes: "Test non presente nel catalogo." });
    expect(outcome.failure.message).toBe("Test non presente nel catalogo.");
    expect(outcome.after).toEqual(outcome.before);
  });

  it("saveClinicalSettings: nessun rinvio acceso", async () => {
    const row = await inUserA(db, async (tx) => {
      await saveClinicalSettings(tx, PRACTICE_A, clock, { ...CLINICAL, referralPrompts: [] });
      return clinicalRow(tx);
    });
    expect(row?.referral_prompts).toEqual([]);
  });

  it.each([
    ["defaultSessionIntervalWeeks", 5],
    ["defaultSessionIntervalWeeks", 0],
    ["defaultRecallWeeks", 1],
    ["defaultRecallWeeks", 53],
    ["defaultExpectedSessions", 21],
    ["defaultExpectedSessions", 2.5],
    ["referralPrompts", ["R4"]],
  ])("saveClinicalSettings: %s %j è un errore sul campo", async (field, value) => {
    const outcome = await inUserA(db, async (tx) => {
      const failure = await formFailure(saveClinicalSettings(tx, PRACTICE_A, clock, { ...CLINICAL, [field]: value }));
      return { failure, row: await clinicalRow(tx) };
    });
    const keys = Object.keys(outcome.failure.fieldErrors ?? {});
    expect(keys.length).toBe(1);
    expect(keys[0]?.startsWith(field)).toBe(true);
    expect(outcome.failure.message).toBe("Valore non valido");
    expect(outcome.row?.referral_prompts).toEqual(["R1", "R2", "R3"]);
  });
});

async function clinicalRow(tx: Tx, practiceId: string = PRACTICE_A): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx.query(
    `select default_recall_weeks, default_expected_sessions, default_session_interval_weeks, referral_prompts,
            active_test_codes, pediatric_red_flags_enabled
       from public.clinical_settings where practice_id = $1`,
    [practiceId],
  );
  return row;
}

describe("saveDemoTestPhone", () => {
  it("saveDemoTestPhone: senza is_demo, Operazione non permessa", async () => {
    const row = await inUserA(db, async (tx) => {
      await expectNotAllowed(saveDemoTestPhone(tx, PRACTICE_A, clock, { demoTestPhone: "+39 333 000 0001" }));
      return settingsRow(tx);
    });
    expect(row?.demo_test_phone).toBeNull();
  });

  it("saveDemoTestPhone: con is_demo scrive il numero, vuoto lo toglie", async () => {
    const outcome = await inUserA(db, async (tx) => {
      await tx.query("update public.practice_settings set is_demo = true where practice_id = $1", [PRACTICE_A]);
      await saveDemoTestPhone(tx, PRACTICE_A, clock, { demoTestPhone: "+39 333 000 0001" });
      const written = await settingsRow(tx);
      const view = await getPracticeSettings(tx, PRACTICE_A);
      const failure = await formFailure(saveDemoTestPhone(tx, PRACTICE_A, clock, { demoTestPhone: "12" }));
      await saveDemoTestPhone(tx, PRACTICE_A, clock, { demoTestPhone: "" });
      return { written, view, failure, emptied: await settingsRow(tx) };
    });
    expect(outcome.written?.demo_test_phone).toBe("+393330000001");
    expect(outcome.view).toMatchObject({ isDemo: true, demoTestPhone: "+393330000001", demoSeededAt: null });
    expect(outcome.failure.fieldErrors).toEqual({
      demoTestPhone: "Scrivi il numero con il prefisso, per esempio +39 051 000 0000.",
    });
    expect(outcome.emptied?.demo_test_phone).toBeNull();
    // I flag del seed restano come erano.
    expect(outcome.emptied).toMatchObject({ is_demo: true, demo_seeded_at: null, demo_seed_version: null });
  });

  it("saveDemoTestPhone rifiuta isDemo", async () => {
    const failure = await inUserA(db, (tx) =>
      formFailure(saveDemoTestPhone(tx, PRACTICE_A, clock, { demoTestPhone: "", isDemo: true })),
    );
    expect(failure).toEqual({ ok: false, refused: true, message: "Valore non valido" });
  });
});

// Studio B sui dati di A: un database tutto suo, perché qui le transazioni di uB arrivano al commit
// (un DomainError lascia la transazione valida) e si rilegge A dopo.
describe("studio B", () => {
  let isolated: Db;
  let isolatedPg: PGlite;

  beforeAll(async () => {
    ({ db: isolated, pg: isolatedPg } = await openTestDb());
    // A è uno studio demo: così l'update di saveDemoTestPhone troverebbe la riga, se uB la vedesse.
    await asUserA(isolated, (tx) =>
      tx.query("update public.practice_settings set is_demo = true where practice_id = $1", [PRACTICE_A]),
    );
  });

  afterAll(async () => {
    await isolatedPg?.close();
  });

  const snapshotOfA = () =>
    asUserA(isolated, async (tx) => ({
      settings: await settingsRow(tx),
      practice: await practiceRow(tx),
      hours: await hourRows(tx),
      clinical: await clinicalRow(tx),
    }));

  it("saveStudio come uB su PRACTICE_A fallisce e i dati di A sono uguali", async () => {
    const before = await snapshotOfA();
    await expectPgError(
      inRollback(isolated, "B", (tx) => saveStudio(tx, PRACTICE_A, clock, STUDIO)),
      "42501",
      /row-level security policy for table "practice_settings"/,
    );
    expect(await snapshotOfA()).toEqual(before);
  });

  it("saveRegistration e saveDemoTestPhone come uB su PRACTICE_A: Operazione non permessa, riga di A invariata", async () => {
    const before = await snapshotOfA();
    const errors = await asUserB(isolated, async (tx) => ({
      registration: await rejectionOf(saveRegistration(tx, PRACTICE_A, clock, REGISTRATION)),
      phone: await rejectionOf(saveDemoTestPhone(tx, PRACTICE_A, clock, { demoTestPhone: "+39 333 000 0001" })),
    }));
    for (const error of [errors.registration, errors.phone]) {
      expect(isDomainError(error), String(error)).toBe(true);
      expect((error as Error).message).toBe(NOT_ALLOWED);
    }
    expect(await snapshotOfA()).toEqual(before);
  });

  it("saveOpeningHours e saveClinicalSettings come uB su PRACTICE_A falliscono e A non cambia", async () => {
    const before = await snapshotOfA();
    await expectPgError(
      inRollback(isolated, "B", (tx) => saveOpeningHours(tx, PRACTICE_A, clock, SEED_HOURS)),
      "42501",
      /row-level security policy for table "opening_hours"/,
    );
    await expectPgError(
      inRollback(isolated, "B", (tx) => saveClinicalSettings(tx, PRACTICE_A, clock, CLINICAL)),
      "42501",
      /row-level security policy for table "clinical_settings"/,
    );
    expect(await snapshotOfA()).toEqual(before);
  });

  it("le query come uB su PRACTICE_A non vedono niente", async () => {
    const seen = await inRollback(isolated, "B", async (tx) => ({
      settings: await getPracticeSettings(tx, PRACTICE_A),
      hours: await getOpeningHours(tx, PRACTICE_A),
      clinical: await getClinicalSettings(tx, PRACTICE_A),
    }));
    expect(seen).toEqual({
      settings: null,
      hours: { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] },
      clinical: null,
    });
  });
});
