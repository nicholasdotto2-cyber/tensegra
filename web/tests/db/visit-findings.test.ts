import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADVICE_TEMPLATES, DEFAULT_ACTIVE_TEST_CODES } from "@/lib/clinical/catalog";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock, romeDateTime } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { createPatient } from "@/server/domain/patients/commands";
import { saveClinicalSettings } from "@/server/domain/settings/commands";
import { getClinicalSettings } from "@/server/domain/settings/queries";
import { editVisit, startVisit } from "@/server/domain/visits/commands";
import { FILE_A, PRACTICE_A, PRACTICE_B, sha256Hex, VISIT_A } from "./fixtures";
import { asUserA, asUserB, inUserA, insertRow, openTestDb } from "./helpers";

// Disfunzioni, test, tecniche, consigli e conferma dei copiati.
// I dati nascono come uA in ogni test, su pazienti nuovi, e
// tornano indietro. L'orologio è mercoledì 4/11/2026 alle 08:30 di Roma.

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const INVALID = "Valore non valido";
const SCREENING_FIRST = "Conferma lo screening prima di scrivere il trattamento.";
const CONSENT_REVOKED = "Consenso al trattamento revocato: puoi solo annotare il colloquio.";
const INR_NOTE = "INR 2,5 del 03/11/2026 dal libretto TAO";
const BLOCK_TAIL = "Cambia l'esito dello screening se hai nuove informazioni.";
const ALWAYS = ["ci_sistemica", "ci_locale", "rf_rachide"] as const;

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const nameOf = (err: unknown): unknown => (err as { name?: unknown } | null)?.name;

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

async function expectDomainError(p: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
}

// Preparazione, tutta come uA ------------------------------------------------------------------------

/** I test attivi di partenza: le fixture non ne hanno. */
async function activateDefaultTests(tx: Tx): Promise<void> {
  const today = await getClinicalSettings(tx, PRACTICE_A);
  if (!today) throw new Error("impostazioni cliniche mancanti");
  await saveClinicalSettings(tx, PRACTICE_A, clock, {
    defaultRecallWeeks: today.defaultRecallWeeks,
    defaultExpectedSessions: today.defaultExpectedSessions,
    defaultSessionIntervalWeeks: today.defaultSessionIntervalWeeks,
    referralPrompts: today.referralPrompts,
    activeTestCodes: [...DEFAULT_ACTIVE_TEST_CODES],
  });
}

/** Anna, adulta; con una data di un minore, con la madre come genitore di contatto. */
async function newPatient(tx: Tx, birthDate = "1954-06-12"): Promise<string> {
  const guardian = birthDate > "2008-11-04" ? { guardian: { firstName: "Elena", lastName: "Galli", phone: "340 000 0066" } } : {};
  const { id } = await createPatient(tx, PRACTICE_A, clock, { firstName: "Anna", lastName: "Galli", birthDate, ...guardian });
  return id;
}

async function cycle(tx: Tx, patientId: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions, main_region)
     values ($1, $2, 'trattamento', '2026-10-01', 'Lombalgia, ottobre 2026', 4, 'lumbar') returning id`,
    [PRACTICE_A, patientId],
  );
  if (!row) throw new Error("ciclo non creato");
  return row.id;
}

async function visitOn(tx: Tx, patientId: string, cycleId: string, day: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status)
     select $1, $2, s.id, $3, $4, 45, 6000, 'fatto' from public.services s where s.practice_id = $1 limit 1
     returning id`,
    [PRACTICE_A, patientId, cycleId, romeDateTime(day, "09:00")],
  );
  if (!row) throw new Error("appuntamento non creato");
  return (await startVisit(tx, PRACTICE_A, clock, { appointmentId: row.id })).visitId;
}

const run = (tx: Tx, visitId: string, op: Record<string, unknown>) => editVisit(tx, PRACTICE_A, clock, { visitId, op });

async function noOthers(tx: Tx, visitId: string, groups: readonly string[] = ALWAYS): Promise<void> {
  for (const group of groups) await run(tx, visitId, { op: "nessun_altra_voce", group });
}

const outcomes = (thrust: string, direct: string, indirect: string, directNote: string | null = null) => ({
  op: "esiti",
  outcomes: [
    { family: "thrust", outcome: thrust, overrideNote: null },
    { family: "direct", outcome: direct, overrideNote: directNote },
    { family: "indirect", outcome: indirect, overrideNote: null },
  ],
});

/** Paziente, ciclo lombare e una visita del 3/11 in bozza; con `screening` lo screening confermato pulito. */
async function setup(tx: Tx, o: { screening?: boolean; birthDate?: string } = {}) {
  await activateDefaultTests(tx);
  const patientId = await newPatient(tx, o.birthDate);
  const cycleId = await cycle(tx, patientId);
  const visitId = await visitOn(tx, patientId, cycleId, "2026-11-03");
  if (o.screening ?? true) {
    await noOthers(tx, visitId);
    await run(tx, visitId, outcomes("indicated", "indicated", "indicated"));
  }
  return { patientId, cycleId, visitId };
}

/** Gli esiti di Anna: ci_avk «si», thrust controindicato, dirette con cautela con la nota dell'INR. */
async function confirmAnna(tx: Tx, visitId: string): Promise<void> {
  await run(tx, visitId, { op: "risposta", itemCode: "ci_avk", answer: "si" });
  await noOthers(tx, visitId);
  await run(tx, visitId, outcomes("contraindicated", "caution", "indicated", INR_NOTE));
}

const tecnica = (region: string, techniqueCode: string, extra: Record<string, unknown> = {}) => ({
  op: "tecnica",
  region,
  techniqueCode,
  ...extra,
});

// Riletture ------------------------------------------------------------------------------------------

function findingsOf(tx: Tx, visitId: string) {
  return tx.query<Record<string, unknown>>(
    `select region, severity, tissue_texture as "tissueTexture", asymmetry, restriction, tenderness, side,
            segment_note as "segmentNote", is_primary as "isPrimary", copied
       from public.visit_region_findings where visit_id = $1 order by region`,
    [visitId],
  );
}

function testsOf(tx: Tx, visitId: string) {
  return tx.query<Record<string, unknown>>(
    `select id, test_code as "testCode", custom_label as "customLabel", custom_unit as "customUnit", side,
            value_bool as "valueBool", value_lateral as "valueLateral", value_numeric::float8 as "valueNumeric",
            value_ordinal as "valueOrdinal", pain_provoked as "painProvoked", note, copied
       from public.visit_test_results where visit_id = $1 order by test_code, side, id`,
    [visitId],
  );
}

function treatmentsOf(tx: Tx, visitId: string) {
  return tx.query<Record<string, unknown>>(
    `select id, region, technique_code as "techniqueCode", custom_technique as "customTechnique", approach, family,
            tolerance, response, note, copied
       from public.visit_treatments where visit_id = $1 order by region, technique_code, id`,
    [visitId],
  );
}

function adviceOf(tx: Tx, visitId: string) {
  return tx.query<Record<string, unknown>>(
    `select id, template_code as "templateCode", text, communicated_via as "communicatedVia", copied
       from public.visit_advice where visit_id = $1 order by template_code, id`,
    [visitId],
  );
}

async function screeningOf(tx: Tx, visitId: string) {
  const [row] = await tx.query<{ at: Date | null }>('select screening_reviewed_at as "at" from public.visits where id = $1', [
    visitId,
  ]);
  const rows = await tx.query("select family from public.visit_screening_outcomes where visit_id = $1", [visitId]);
  return { at: row?.at ?? null, outcomes: rows.length };
}

const idOf = (rows: Record<string, unknown>[], i = 0): string => String(rows[i]?.id);

// ----------------------------------------------------------------------------------------------------

describe("disfunzione", () => {
  it("cervicale severità 3, T R T, dx, «C2-C3 dx», primaria è una riga; una seconda scrittura la aggiorna", async () => {
    const { first, second } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      const op = {
        op: "disfunzione",
        region: "cervical",
        severity: 3,
        tissueTexture: true,
        asymmetry: false,
        restriction: true,
        tenderness: true,
        side: "dx",
        segmentNote: "C2-C3 dx",
        isPrimary: true,
      };
      await run(tx, visitId, op);
      const first = await findingsOf(tx, visitId);
      await run(tx, visitId, { ...op, severity: 2, segmentNote: "C2 FRS dx" });
      return { first, second: await findingsOf(tx, visitId) };
    });
    expect(first).toEqual([
      {
        region: "cervical",
        severity: 3,
        tissueTexture: true,
        asymmetry: false,
        restriction: true,
        tenderness: true,
        side: "dx",
        segmentNote: "C2-C3 dx",
        isPrimary: true,
        copied: false,
      },
    ]);
    expect(second).toEqual([{ ...first[0], severity: 2, segmentNote: "C2 FRS dx" }]);
  });

  it("severità 0 senza lettere TART è «Con severità 0 segna almeno una lettera TART, o togli la regione.»", async () => {
    const { failure, rows } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      const failure = await formFailure(run(tx, visitId, { op: "disfunzione", region: "lumbar", severity: 0 }));
      return { failure, rows: await findingsOf(tx, visitId) };
    });
    expect(failure.message).toBe("Con severità 0 segna almeno una lettera TART, o togli la regione.");
    expect(failure.fieldErrors).toEqual({ "op.severity": "Con severità 0 segna almeno una lettera TART, o togli la regione." });
    expect(rows).toEqual([]);
  });

  it("severità fuori scala, lato o regione sconosciuti, un campo in più sono Valore non valido", async () => {
    await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      const base = { op: "disfunzione", region: "lumbar", severity: 2 };
      for (const bad of [{ severity: 4 }, { side: "destra" }, { region: "collo" }, { colore: "rosso" }]) {
        expect((await formFailure(run(tx, visitId, { ...base, ...bad }))).message).toBe(INVALID);
      }
      expect(await findingsOf(tx, visitId)).toEqual([]);
    });
  });

  it("dorsale primaria toglie la primaria alla cervicale; togli_disfunzione toglie la riga", async () => {
    const { primaries, after } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, { op: "disfunzione", region: "cervical", severity: 3, isPrimary: true });
      await run(tx, visitId, { op: "disfunzione", region: "thoracic", severity: 2, asymmetry: true, isPrimary: true });
      const primaries = (await findingsOf(tx, visitId)).map((r) => [r.region, r.isPrimary]);
      await run(tx, visitId, { op: "togli_disfunzione", region: "cervical" });
      return { primaries, after: (await findingsOf(tx, visitId)).map((r) => r.region) };
    });
    expect(primaries).toEqual([
      ["cervical", false],
      ["thoracic", true],
    ]);
    expect(after).toEqual(["thoracic"]);
  });

  it("una scrittura su una riga copiata la conferma", async () => {
    const copied = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await tx.query(
        `insert into public.visit_region_findings (practice_id, visit_id, region, severity, copied)
         values ($1, $2, 'lumbar', 2, true)`,
        [PRACTICE_A, visitId],
      );
      await run(tx, visitId, { op: "disfunzione", region: "lumbar", severity: 1, tenderness: true });
      return (await findingsOf(tx, visitId))[0]?.copied;
    });
    expect(copied).toBe(false);
  });
});

describe("test", () => {
  it("flessione_rotazione dx 28 salva 28; lo stesso test e lato aggiorna la stessa riga", async () => {
    const { first, second } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, { op: "test", testCode: "flessione_rotazione", side: "dx", valueNumeric: 28 });
      const first = await testsOf(tx, visitId);
      await run(tx, visitId, { op: "test", testCode: "flessione_rotazione", side: "dx", valueNumeric: 32, painProvoked: true });
      await run(tx, visitId, { op: "test", testCode: "flessione_rotazione", side: "sx", valueNumeric: 40 });
      return { first, second: await testsOf(tx, visitId) };
    });
    expect(first).toEqual([
      {
        id: first[0]?.id,
        testCode: "flessione_rotazione",
        customLabel: null,
        customUnit: null,
        side: "dx",
        valueBool: null,
        valueLateral: null,
        valueNumeric: 28,
        valueOrdinal: null,
        painProvoked: null,
        note: null,
        copied: false,
      },
    ]);
    expect(second.map((r) => [r.id === first[0]?.id, r.side, r.valueNumeric, r.painProvoked])).toEqual([
      [true, "dx", 32, true],
      [false, "sx", 40, null],
    ]);
  });

  it("senza lato «Scegli il lato.»; 200 «Valore fuori dai limiti del test (0-90).»; value_bool su un numerico, codice inesistente: Valore non valido", async () => {
    await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      const noSide = await formFailure(run(tx, visitId, { op: "test", testCode: "flessione_rotazione", valueNumeric: 28 }));
      expect(noSide).toMatchObject({ message: "Scegli il lato.", fieldErrors: { "op.side": "Scegli il lato." } });
      const tooMuch = await formFailure(
        run(tx, visitId, { op: "test", testCode: "flessione_rotazione", side: "dx", valueNumeric: 200 }),
      );
      expect(tooMuch).toMatchObject({
        message: "Valore fuori dai limiti del test (0-90).",
        fieldErrors: { "op.valueNumeric": "Valore fuori dai limiti del test (0-90)." },
      });
      const bool = await formFailure(run(tx, visitId, { op: "test", testCode: "flessione_rotazione", side: "dx", valueBool: true }));
      expect(bool.message).toBe(INVALID);
      expect((await formFailure(run(tx, visitId, { op: "test", testCode: "rotazione_anca", valueBool: true }))).message).toBe(
        INVALID,
      );
      // Un test senza lato non ne vuole uno; un ordinale fuori dalle sue etichette.
      expect((await formFailure(run(tx, visitId, { op: "test", testCode: "dita_pavimento", side: "dx", valueNumeric: 12 }))).message).toBe(
        INVALID,
      );
      expect((await formFailure(run(tx, visitId, { op: "test", testCode: "aslr", side: "dx", valueOrdinal: 6 }))).message).toBe(
        INVALID,
      );
      expect(await testsOf(tx, visitId)).toEqual([]);
    });
  });

  it("i decimali dei limiti hanno la virgola: dita-pavimento 12,5 si salva, 61 no", async () => {
    const { failure, rows } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, { op: "test", testCode: "dita_pavimento", valueNumeric: 12.5 });
      const failure = await formFailure(run(tx, visitId, { op: "test", testCode: "dita_pavimento", valueNumeric: 61 }));
      return { failure, rows: await testsOf(tx, visitId) };
    });
    expect(failure.message).toBe("Valore fuori dai limiti del test (0-60).");
    expect(rows.map((r) => r.valueNumeric)).toEqual([12.5]);
  });

  it("il test libero «Rotazione anca» in ° è test_code 'libero'; «rotazione anca» aggiorna la stessa riga", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, { op: "test", testCode: "libero", customLabel: "Rotazione anca", customUnit: "°", side: "dx", valueNumeric: 35 });
      await run(tx, visitId, { op: "test", testCode: "libero", customLabel: "rotazione anca", customUnit: "°", side: "dx", valueNumeric: 38 });
      return testsOf(tx, visitId);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ testCode: "libero", customUnit: "°", side: "dx", valueNumeric: 38 });
  });

  it("un test libero senza nome, o con un valore laterale, e un'unità su un test del catalogo sono Valore non valido", async () => {
    await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      for (const op of [
        { op: "test", testCode: "libero", valueNumeric: 3 },
        { op: "test", testCode: "libero", customLabel: "Prova", valueLateral: "dx" },
        { op: "test", testCode: "dita_pavimento", customUnit: "cm", valueNumeric: 12 },
      ]) {
        expect((await formFailure(run(tx, visitId, op))).message).toBe(INVALID);
      }
      expect(await testsOf(tx, visitId)).toEqual([]);
    });
  });

  it("un test spento è «Test non attivo nello studio.»; un test dell'esame neurologico passa anche se non è fra gli attivi", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await expectDomainError(
        run(tx, visitId, { op: "test", testCode: "schober_modificato", valueNumeric: 4 }),
        "Test non attivo nello studio.",
      );
      await run(tx, visitId, { op: "test", testCode: "riflesso_bicipitale", side: "dx", valueOrdinal: 0 });
      return testsOf(tx, visitId);
    });
    expect(rows.map((r) => [r.testCode, r.valueOrdinal])).toEqual([["riflesso_bicipitale", 0]]);
  });

  it("una riga vuota (niente valore, dolore provocato o nota) è Valore non valido; la sola nota si salva", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      expect((await formFailure(run(tx, visitId, { op: "test", testCode: "faber", side: "dx" }))).message).toBe(INVALID);
      await run(tx, visitId, { op: "test", testCode: "faber", side: "sx", note: "Non eseguibile per dolore" });
      return testsOf(tx, visitId);
    });
    expect(rows.map((r) => [r.side, r.valueBool, r.note])).toEqual([["sx", null, "Non eseguibile per dolore"]]);
  });

  it("su un test copiato una nota senza valore lo lascia da confermare e conferma tutti lo toglie; un valore lo conferma", async () => {
    const { afterWrites, afterConfirm } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await tx.query(
        `insert into public.visit_test_results (practice_id, visit_id, test_code, side, copied)
         values ($1, $2, 'slr', 'dx', true), ($1, $2, 'slr', 'sx', true)`,
        [PRACTICE_A, visitId],
      );
      await run(tx, visitId, { op: "test", testCode: "slr", side: "dx", note: "Non eseguibile per dolore", painProvoked: true });
      await run(tx, visitId, { op: "test", testCode: "slr", side: "sx", valueNumeric: 60 });
      const afterWrites = (await testsOf(tx, visitId)).map((r) => [r.side, r.copied]);
      await run(tx, visitId, { op: "conferma", target: "tutti" });
      return { afterWrites, afterConfirm: (await testsOf(tx, visitId)).map((r) => [r.side, r.valueNumeric, r.copied]) };
    });
    expect(afterWrites).toEqual([
      ["dx", true],
      ["sx", false],
    ]);
    expect(afterConfirm).toEqual([["sx", 60, false]]);
  });

  it("togli_test toglie la riga; un id che non è della visita è Operazione non permessa", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      const other = await setup(tx);
      await run(tx, visitId, { op: "test", testCode: "faber", side: "sx", valueBool: true });
      await run(tx, other.visitId, { op: "test", testCode: "faber", side: "sx", valueBool: false });
      const otherId = idOf(await testsOf(tx, other.visitId));
      await expectDomainError(run(tx, visitId, { op: "togli_test", resultId: otherId }), NOT_ALLOWED);
      await run(tx, visitId, { op: "togli_test", resultId: idOf(await testsOf(tx, visitId)) });
      return { mine: await testsOf(tx, visitId), other: await testsOf(tx, other.visitId) };
    });
    expect(rows.mine).toEqual([]);
    expect(rows.other).toHaveLength(1);
  });
});

describe("tecnica", () => {
  it("tessuti molli lombare è una riga con family direct e tolleranza buona; togli_tecnica la toglie", async () => {
    const { saved, removed } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, tecnica("lumbar", "tessuti_molli"));
      const saved = await treatmentsOf(tx, visitId);
      await run(tx, visitId, { op: "togli_tecnica", treatmentId: idOf(saved) });
      return { saved, removed: await treatmentsOf(tx, visitId) };
    });
    expect(saved).toEqual([
      {
        id: saved[0]?.id,
        region: "lumbar",
        techniqueCode: "tessuti_molli",
        customTechnique: null,
        approach: null,
        family: "direct",
        tolerance: "buona",
        response: null,
        note: null,
        copied: false,
      },
    ]);
    expect(removed).toEqual([]);
  });

  it("fasciale senza approccio «Scegli l'approccio.»; altra senza nome «Scrivi il nome della tecnica.»", async () => {
    await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      const fascial = await formFailure(run(tx, visitId, tecnica("lumbar", "fasciale")));
      expect(fascial).toMatchObject({ message: "Scegli l'approccio.", fieldErrors: { "op.approach": "Scegli l'approccio." } });
      const other = await formFailure(run(tx, visitId, tecnica("lumbar", "altra", { approach: "indirect" })));
      expect(other).toMatchObject({
        message: "Scrivi il nome della tecnica.",
        fieldErrors: { "op.customTechnique": "Scrivi il nome della tecnica." },
      });
      // Un approccio su una tecnica che non ne ha, un nome su una tecnica del catalogo.
      expect((await formFailure(run(tx, visitId, tecnica("lumbar", "tessuti_molli", { approach: "direct" })))).message).toBe(INVALID);
      expect((await formFailure(run(tx, visitId, tecnica("lumbar", "funzionale", { customTechnique: "Mia" })))).message).toBe(INVALID);
      expect(await treatmentsOf(tx, visitId)).toEqual([]);
    });
  });

  it("craniale senza approccio vale indirect; fasciale indiretta e altra con nome seguono l'approccio", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, tecnica("head", "craniale"));
      await run(tx, visitId, tecnica("lumbar", "fasciale", { approach: "indirect", tolerance: "fastidio", response: "migliorato" }));
      await run(tx, visitId, tecnica("lumbar", "altra", { customTechnique: "Tecnica di Jones", approach: "direct" }));
      return treatmentsOf(tx, visitId);
    });
    expect(rows.map((r) => [r.region, r.techniqueCode, r.customTechnique, r.approach, r.family, r.tolerance, r.response])).toEqual([
      ["head", "craniale", null, "indirect", "indirect", "buona", null],
      ["lumbar", "altra", "Tecnica di Jones", "direct", "direct", "buona", null],
      ["lumbar", "fasciale", null, "indirect", "indirect", "fastidio", "migliorato"],
    ]);
  });

  it("con lo screening non confermato è «Conferma lo screening prima di scrivere il trattamento.»", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx, { screening: false });
      await expectDomainError(run(tx, visitId, tecnica("lumbar", "tessuti_molli")), SCREENING_FIRST);
      return treatmentsOf(tx, visitId);
    });
    expect(rows).toEqual([]);
  });

  it("esiti di Anna: HVLA bloccata con la frase dello screening e nessuna riga; energia muscolare (con cautela) salvata", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx, { screening: false });
      await confirmAnna(tx, visitId);
      await expectDomainError(
        run(tx, visitId, tecnica("lumbar", "hvla")),
        `HVLA controindicata in questa visita: terapia anticoagulante. ${BLOCK_TAIL}`,
      );
      await run(tx, visitId, tecnica("lumbar", "energia_muscolare"));
      return treatmentsOf(tx, visitId);
    });
    expect(rows.map((r) => [r.techniqueCode, r.family])).toEqual([["energia_muscolare", "direct"]]);
  });

  it("cambiare l'approccio di una riga è un cambio di tecnica: il blocco vale", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx, { screening: false });
      await run(tx, visitId, { op: "risposta", itemCode: "ci_avk", answer: "si" });
      await noOthers(tx, visitId);
      await run(tx, visitId, outcomes("contraindicated", "contraindicated", "indicated"));
      await run(tx, visitId, tecnica("lumbar", "fasciale", { approach: "indirect" }));
      await expectDomainError(
        run(tx, visitId, tecnica("lumbar", "fasciale", { approach: "direct" })),
        `Tecnica fasciale controindicata in questa visita: terapia anticoagulante. ${BLOCK_TAIL}`,
      );
      return treatmentsOf(tx, visitId);
    });
    expect(rows.map((r) => [r.techniqueCode, r.approach, r.family])).toEqual([["fasciale", "indirect", "indirect"]]);
  });

  it("un red flag dopo i tessuti molli lombari toglie la conferma; riconfermato, la riga resta, nessuna tecnica nuova, la nota si salva", async () => {
    const r = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, tecnica("lumbar", "tessuti_molli"));
      await run(tx, visitId, { op: "risposta", itemCode: "rf_ces_saddle", answer: "si" });
      const cleared = await screeningOf(tx, visitId);
      await expectDomainError(run(tx, visitId, tecnica("lumbar", "funzionale")), SCREENING_FIRST);
      await run(tx, visitId, outcomes("contraindicated", "contraindicated", "contraindicated"));
      const kept = await treatmentsOf(tx, visitId);
      await expectDomainError(
        run(tx, visitId, tecnica("lumbar", "funzionale")),
        `Tecnica funzionale controindicata in questa visita: anestesia a sella. ${BLOCK_TAIL}`,
      );
      await run(tx, visitId, tecnica("lumbar", "tessuti_molli", { note: "tecnica eseguita prima della comparsa del sintomo" }));
      return { cleared, kept, after: await treatmentsOf(tx, visitId) };
    });
    expect(r.cleared).toEqual({ at: null, outcomes: 0 });
    expect(r.kept.map((t) => t.techniqueCode)).toEqual(["tessuti_molli"]);
    expect(r.after).toEqual([{ ...r.kept[0], note: "tecnica eseguita prima della comparsa del sintomo" }]);
  });
});

describe("gruppo cervicale aperto da una tecnica", () => {
  /** Una visita successiva del ciclo lombare: il gruppo cervicale è chiuso, lo screening confermato pulito. */
  async function followUp(tx: Tx) {
    const { patientId, cycleId } = await setup(tx, { screening: false });
    const visitId = await visitOn(tx, patientId, cycleId, "2026-11-04");
    await noOthers(tx, visitId);
    await run(tx, visitId, outcomes("indicated", "indicated", "indicated"));
    return visitId;
  }

  it("tessuti molli cervicali salvati, conferma tolta; le voci cervicali si rispondono e gli esiti riconfermano", async () => {
    const r = await inUserA(db, async (tx) => {
      const visitId = await followUp(tx);
      // Prima della tecnica il gruppo cervicale è chiuso: una sua voce non si risponde.
      await expectDomainError(run(tx, visitId, { op: "risposta", itemCode: "cv_unlike", answer: "no" }), NOT_ALLOWED);
      await run(tx, visitId, tecnica("cervical", "tessuti_molli"));
      const afterTechnique = { screening: await screeningOf(tx, visitId), rows: await treatmentsOf(tx, visitId) };
      await expectDomainError(run(tx, visitId, tecnica("lumbar", "funzionale")), SCREENING_FIRST);
      await run(tx, visitId, { op: "risposta", itemCode: "cv_unlike", answer: "no" });
      await noOthers(tx, visitId, ["rf_cervicale_vascolare"]);
      await run(tx, visitId, outcomes("indicated", "indicated", "indicated"));
      const reconfirmed = await screeningOf(tx, visitId);
      await run(tx, visitId, tecnica("lumbar", "funzionale"));
      return { afterTechnique, reconfirmed, rows: await treatmentsOf(tx, visitId) };
    });
    expect(r.afterTechnique.screening).toEqual({ at: null, outcomes: 0 });
    expect(r.afterTechnique.rows.map((t) => [t.region, t.techniqueCode, t.family])).toEqual([["cervical", "tessuti_molli", "direct"]]);
    expect(r.reconfirmed).toEqual({ at: clock.now(), outcomes: 3 });
    expect(r.rows.map((t) => [t.region, t.techniqueCode])).toEqual([
      ["cervical", "tessuti_molli"],
      ["lumbar", "funzionale"],
    ]);
  });

  it("una tecnica indiretta cervicale, o una diretta con il gruppo già risposto, non toglie la conferma", async () => {
    const r = await inUserA(db, async (tx) => {
      const visitId = await followUp(tx);
      await run(tx, visitId, tecnica("cervical", "funzionale"));
      const indirect = await screeningOf(tx, visitId);
      await run(tx, visitId, tecnica("cervical", "tessuti_molli"));
      await noOthers(tx, visitId, ["rf_cervicale_vascolare"]);
      await run(tx, visitId, outcomes("indicated", "indicated", "indicated"));
      await run(tx, visitId, tecnica("cervical", "articolatoria"));
      return { indirect, answered: await screeningOf(tx, visitId) };
    });
    expect(r.indirect).toEqual({ at: clock.now(), outcomes: 3 });
    expect(r.answered).toEqual({ at: clock.now(), outcomes: 3 });
  });

  it("confermare una tecnica cervicale diretta copiata, da sola o con «tutti», toglie la conferma; una indiretta no", async () => {
    const r = await inUserA(db, async (tx) => {
      const copiedRow = async (visitId: string, techniqueCode: string, family: string) => {
        const [row] = await tx.query<{ id: string }>(
          `insert into public.visit_treatments (practice_id, visit_id, region, technique_code, family, copied)
           values ($1, $2, 'cervical', $3, $4, true) returning id`,
          [PRACTICE_A, visitId, techniqueCode, family],
        );
        return String(row?.id);
      };
      const single = await followUp(tx);
      const indirectId = await copiedRow(single, "funzionale", "indirect");
      await run(tx, single, { op: "conferma", target: { table: "treatments", id: indirectId } });
      const afterIndirect = await screeningOf(tx, single);
      const directId = await copiedRow(single, "tessuti_molli", "direct");
      await run(tx, single, { op: "conferma", target: { table: "treatments", id: directId } });
      const all = await followUp(tx);
      await copiedRow(all, "articolatoria", "direct");
      await run(tx, all, { op: "conferma", target: "tutti" });
      return { afterIndirect, single: await screeningOf(tx, single), all: await screeningOf(tx, all) };
    });
    expect(r.afterIndirect).toEqual({ at: clock.now(), outcomes: 3 });
    expect(r.single).toEqual({ at: null, outcomes: 0 });
    expect(r.all).toEqual({ at: null, outcomes: 0 });
  });

  it("una riga cervicale che gli esiti nuovi bloccano resta salvata (come il red flag dopo i tessuti molli)", async () => {
    const rows = await inUserA(db, async (tx) => {
      const visitId = await followUp(tx);
      await run(tx, visitId, tecnica("cervical", "tessuti_molli"));
      await run(tx, visitId, { op: "risposta", itemCode: "cv_unlike", answer: "si" });
      await noOthers(tx, visitId, ["rf_cervicale_vascolare"]);
      await run(tx, visitId, outcomes("contraindicated", "contraindicated", "contraindicated"));
      await expectDomainError(
        run(tx, visitId, tecnica("cervical", "articolatoria")),
        `Tecnica articolatoria controindicata in questa visita: dolore al collo o cefalea acuti. ${BLOCK_TAIL}`,
      );
      return treatmentsOf(tx, visitId);
    });
    expect(rows.map((t) => [t.region, t.techniqueCode])).toEqual([["cervical", "tessuti_molli"]]);
  });
});

describe("consenso al trattamento revocato", () => {
  const CONSENT_TEXT = "Consenso al trattamento osteopatico di Anna Galli";

  async function consent(
    tx: Tx,
    patientId: string,
    cycleId: string,
    signedOn: string,
    moduleKey: "trattamento" | "trattamento_minore" = "trattamento",
  ): Promise<string> {
    const row = await insertRow(tx, "consent_records", {
      practice_id: PRACTICE_A,
      patient_id: patientId,
      cycle_id: cycleId,
      module_key: moduleKey,
      module_version: "2026.1",
      rendered_text: CONSENT_TEXT,
      rendered_hash: sha256Hex(CONSENT_TEXT),
      signer_kind: moduleKey === "trattamento" ? "paziente" : "genitore",
      signer_name: "Anna Galli",
      method: "tela",
      signature_file_id: FILE_A,
      signed_on: signedOn,
    });
    return String(row.id);
  }

  async function revoke(tx: Tx, consentId: string): Promise<void> {
    await tx.query(
      `update public.consent_records set status = 'revocato', revoked_on = '2026-11-02', revocation_mode = 'verbale'
        where practice_id = $1 and id = $2`,
      [PRACTICE_A, consentId],
    );
  }

  it("tecnica, togli_tecnica e campi con la risposta al trattamento rispondono col testo; il colloquio si salva", async () => {
    const r = await inUserA(db, async (tx) => {
      const { patientId, cycleId, visitId } = await setup(tx);
      const consentId = await consent(tx, patientId, cycleId, "2026-10-01");
      await run(tx, visitId, tecnica("lumbar", "energia_muscolare"));
      await revoke(tx, consentId);
      await expectDomainError(run(tx, visitId, tecnica("lumbar", "tessuti_molli")), CONSENT_REVOKED);
      await expectDomainError(run(tx, visitId, { op: "togli_tecnica", treatmentId: idOf(await treatmentsOf(tx, visitId)) }), CONSENT_REVOKED);
      await expectDomainError(run(tx, visitId, { op: "campi", values: { treatmentResponse: "migliorato" } }), CONSENT_REVOKED);
      await run(tx, visitId, { op: "campi", values: { subjectiveUpdate: "Vuole parlare prima di continuare" } });
      const [visit] = await tx.query<{ subjectiveUpdate: string | null; treatmentResponse: string | null }>(
        'select subjective_update as "subjectiveUpdate", treatment_response as "treatmentResponse" from public.visits where id = $1',
        [visitId],
      );
      return { visit, rows: await treatmentsOf(tx, visitId) };
    });
    expect(r.visit).toEqual({ subjectiveUpdate: "Vuole parlare prima di continuare", treatmentResponse: null });
    expect(r.rows.map((t) => t.techniqueCode)).toEqual(["energia_muscolare"]);
  });

  it("con un consenso valido firmato dopo la revoca, o senza nessun consenso, la tecnica si salva", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { patientId, cycleId, visitId } = await setup(tx);
      await run(tx, visitId, tecnica("lumbar", "funzionale"));
      await revoke(tx, await consent(tx, patientId, cycleId, "2026-10-01"));
      await consent(tx, patientId, cycleId, "2026-11-03");
      await run(tx, visitId, tecnica("lumbar", "tessuti_molli"));
      return treatmentsOf(tx, visitId);
    });
    expect(rows.map((t) => t.techniqueCode)).toEqual(["funzionale", "tessuti_molli"]);
  });

  it("con il consenso revocato la sola nota di una riga salvata passa; tolleranza o risposta cambiate no", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { patientId, cycleId, visitId } = await setup(tx);
      const consentId = await consent(tx, patientId, cycleId, "2026-10-01");
      await run(tx, visitId, tecnica("lumbar", "energia_muscolare"));
      await revoke(tx, consentId);
      await run(tx, visitId, tecnica("lumbar", "energia_muscolare", { note: "Interrotta su richiesta: vuole parlarne col medico" }));
      await expectDomainError(run(tx, visitId, tecnica("lumbar", "energia_muscolare", { tolerance: "fastidio" })), CONSENT_REVOKED);
      await expectDomainError(run(tx, visitId, tecnica("lumbar", "energia_muscolare", { response: "migliorato" })), CONSENT_REVOKED);
      return treatmentsOf(tx, visitId);
    });
    expect(rows.map((t) => [t.techniqueCode, t.tolerance, t.response, t.note])).toEqual([
      ["energia_muscolare", "buona", null, "Interrotta su richiesta: vuole parlarne col medico"],
    ]);
  });

  it("con il consenso revocato una riga copiata non si conferma con la nota", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { patientId, cycleId, visitId } = await setup(tx);
      await tx.query(
        `insert into public.visit_treatments (practice_id, visit_id, region, technique_code, family, copied)
         values ($1, $2, 'lumbar', 'tessuti_molli', 'direct', true)`,
        [PRACTICE_A, visitId],
      );
      await revoke(tx, await consent(tx, patientId, cycleId, "2026-10-01"));
      await expectDomainError(run(tx, visitId, tecnica("lumbar", "tessuti_molli", { note: "Solo colloquio" })), CONSENT_REVOKED);
      return treatmentsOf(tx, visitId);
    });
    expect(rows.map((t) => [t.copied, t.note])).toEqual([[true, null]]);
  });

  it("un minore alla data della visita: il consenso del genitore revocato blocca, quello da adulto revocato no", async () => {
    const r = await inUserA(db, async (tx) => {
      const minor = await setup(tx, { birthDate: "2012-03-10" });
      await revoke(tx, await consent(tx, minor.patientId, minor.cycleId, "2026-10-01", "trattamento_minore"));
      await expectDomainError(run(tx, minor.visitId, tecnica("lumbar", "tessuti_molli")), CONSENT_REVOKED);

      const other = await setup(tx, { birthDate: "2012-03-10" });
      await revoke(tx, await consent(tx, other.patientId, other.cycleId, "2026-10-01", "trattamento"));
      await run(tx, other.visitId, tecnica("lumbar", "tessuti_molli"));
      return { minor: await treatmentsOf(tx, minor.visitId), other: await treatmentsOf(tx, other.visitId) };
    });
    expect(r.minor).toEqual([]);
    expect(r.other.map((t) => t.techniqueCode)).toEqual(["tessuti_molli"]);
  });
});

describe("consiglio", () => {
  const PAUSE = ADVICE_TEMPLATES.find((t) => t.code === "pause_attive");

  it("dal modello pause_attive copia il testo con «A voce»; un testo modificato lo sostituisce; lo stesso modello non si raddoppia", async () => {
    const { first, edited } = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, { op: "consiglio", templateCode: "pause_attive", text: null, communicatedVia: ["a_voce"] });
      const first = await adviceOf(tx, visitId);
      await run(tx, visitId, {
        op: "consiglio",
        adviceId: idOf(first),
        templateCode: "pause_attive",
        text: "Ogni 30 minuti alzati e cammina un minuto.",
        communicatedVia: ["a_voce", "foglio_stampato"],
      });
      await run(tx, visitId, { op: "consiglio", templateCode: "pause_attive", text: null, communicatedVia: ["a_voce", "foglio_stampato"] });
      await run(tx, visitId, { op: "consiglio", templateCode: "camminata", text: "  Cammina 20 minuti al giorno.  ", communicatedVia: ["a_voce"] });
      return { first, edited: await adviceOf(tx, visitId) };
    });
    expect(first).toEqual([
      { id: first[0]?.id, templateCode: "pause_attive", text: PAUSE?.body, communicatedVia: ["a_voce"], copied: false },
    ]);
    expect(edited.map((a) => [a.templateCode, a.text, a.communicatedVia])).toEqual([
      ["camminata", "Cammina 20 minuti al giorno.", ["a_voce"]],
      ["pause_attive", PAUSE?.body, ["a_voce", "foglio_stampato"]],
    ]);
    expect(edited.find((a) => a.templateCode === "pause_attive")?.id).toBe(first[0]?.id);
  });

  it("nessun canale è «Scegli almeno un canale.»; un canale e un modello sconosciuti sono Valore non valido", async () => {
    await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      const none = await formFailure(run(tx, visitId, { op: "consiglio", templateCode: "pause_attive", text: null, communicatedVia: [] }));
      expect(none).toMatchObject({
        message: "Scegli almeno un canale.",
        fieldErrors: { "op.communicatedVia": "Scegli almeno un canale." },
      });
      // «Messaggio copiato» è un canale a parte (`advice-message.test.ts`): qui un canale che non c'è.
      const channel = await formFailure(
        run(tx, visitId, { op: "consiglio", templateCode: "pause_attive", text: null, communicatedVia: ["email"] }),
      );
      expect(channel.message).toBe(INVALID);
      const unknown = await formFailure(
        run(tx, visitId, { op: "consiglio", templateCode: "yoga", text: "Fai yoga", communicatedVia: ["a_voce"] }),
      );
      expect(unknown.message).toBe(INVALID);
      expect(await adviceOf(tx, visitId)).toEqual([]);
    });
  });

  it("togli_consiglio toglie la riga; un id che non è della visita è Operazione non permessa", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await run(tx, visitId, { op: "consiglio", templateCode: "camminata", text: null, communicatedVia: ["a_voce"] });
      await expectDomainError(
        run(tx, visitId, { op: "togli_consiglio", adviceId: "a0000000-0000-4000-8000-0000000fffff" }),
        NOT_ALLOWED,
      );
      await expectDomainError(
        run(tx, visitId, {
          op: "consiglio",
          adviceId: "a0000000-0000-4000-8000-0000000fffff",
          templateCode: "camminata",
          text: null,
          communicatedVia: ["a_voce"],
        }),
        NOT_ALLOWED,
      );
      await run(tx, visitId, { op: "togli_consiglio", adviceId: idOf(await adviceOf(tx, visitId)) });
      return adviceOf(tx, visitId);
    });
    expect(rows).toEqual([]);
  });
});

describe("conferma dei copiati", () => {
  async function copiedRows(tx: Tx, visitId: string) {
    await tx.query(
      `insert into public.visit_region_findings (practice_id, visit_id, region, severity, copied) values ($1, $2, 'lumbar', 2, true)`,
      [PRACTICE_A, visitId],
    );
    await tx.query(
      `insert into public.visit_treatments (practice_id, visit_id, region, technique_code, family, copied)
       values ($1, $2, 'lumbar', 'tessuti_molli', 'direct', true)`,
      [PRACTICE_A, visitId],
    );
    await tx.query(
      `insert into public.visit_test_results (practice_id, visit_id, test_code, side, value_numeric, copied)
       values ($1, $2, 'slr', 'dx', 60, true), ($1, $2, 'slr', 'sx', null, true), ($1, $2, 'dita_pavimento', null, null, true)`,
      [PRACTICE_A, visitId],
    );
  }

  const copiedFlags = async (tx: Tx, visitId: string) => ({
    findings: (await findingsOf(tx, visitId)).map((r) => r.copied),
    treatments: (await treatmentsOf(tx, visitId)).map((r) => r.copied),
    tests: (await testsOf(tx, visitId)).map((r) => [r.testCode, r.side, r.copied]),
  });

  it("«tutti» conferma ogni riga copiata e toglie i test copiati senza valore", async () => {
    const flags = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await copiedRows(tx, visitId);
      await run(tx, visitId, { op: "conferma", target: "tutti" });
      return copiedFlags(tx, visitId);
    });
    expect(flags).toEqual({ findings: [false], treatments: [false], tests: [["slr", "dx", false]] });
  });

  it("una riga alla volta: un test senza valore sparisce, le altre restano senza copied; un id non della visita è Operazione non permessa", async () => {
    const flags = await inUserA(db, async (tx) => {
      const { visitId } = await setup(tx);
      await copiedRows(tx, visitId);
      const tests = await testsOf(tx, visitId);
      const empty = tests.find((t) => t.testCode === "slr" && t.side === "sx");
      await run(tx, visitId, { op: "conferma", target: { table: "tests", id: String(empty?.id) } });
      await run(tx, visitId, { op: "conferma", target: { table: "treatments", id: idOf(await treatmentsOf(tx, visitId)) } });
      await expectDomainError(
        run(tx, visitId, { op: "conferma", target: { table: "findings", id: String(empty?.id) } }),
        NOT_ALLOWED,
      );
      expect((await formFailure(run(tx, visitId, { op: "conferma", target: { table: "advice", id: String(empty?.id) } }))).message).toBe(
        INVALID,
      );
      return copiedFlags(tx, visitId);
    });
    expect(flags).toEqual({
      findings: [true],
      treatments: [false],
      tests: [
        ["dita_pavimento", null, true],
        ["slr", "dx", true],
      ],
    });
  });
});

describe("come uB sui dati di A", () => {
  const snapshotOfA = () =>
    asUserA(db, async (tx) => {
      const rows = (table: string) => tx.query(`select * from public.${table} where practice_id = $1 order by id`, [PRACTICE_A]);
      return {
        visits: await rows("visits"),
        findings: await rows("visit_region_findings"),
        tests: await rows("visit_test_results"),
        treatments: await rows("visit_treatments"),
        advice: await rows("visit_advice"),
      };
    });

  it("ogni operazione è Operazione non permessa e A non cambia", async () => {
    const before = await snapshotOfA();
    const someId = "a0000000-0000-4000-8000-0000000fffff";
    await asUserB(db, async (tx) => {
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        const edit = (op: Record<string, unknown>) => editVisit(tx, practiceId, clock, { visitId: VISIT_A, op });
        for (const op of [
          { op: "disfunzione", region: "lumbar", severity: 2 },
          { op: "togli_disfunzione", region: "lumbar" },
          { op: "test", testCode: "faber", side: "dx", valueBool: true },
          { op: "togli_test", resultId: someId },
          tecnica("lumbar", "tessuti_molli"),
          { op: "togli_tecnica", treatmentId: someId },
          { op: "consiglio", templateCode: "camminata", text: null, communicatedVia: ["a_voce"] },
          { op: "togli_consiglio", adviceId: someId },
          { op: "conferma", target: "tutti" },
          { op: "conferma", target: { table: "findings", id: someId } },
        ]) {
          await expectDomainError(edit(op), NOT_ALLOWED);
        }
      }
    });
    expect(await snapshotOfA()).toEqual(before);
  });
});
