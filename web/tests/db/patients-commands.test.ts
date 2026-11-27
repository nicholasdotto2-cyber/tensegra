import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { createPatient } from "@/server/domain/patients/commands";
import { getPatientForBooking, searchPatients } from "@/server/domain/patients/queries";
import { CYCLE_A, PATIENT_A1, PATIENT_A2, PATIENT_B1, PRACTICE_A, PRACTICE_B } from "./fixtures";
import { inRollback, inUserA, openTestDb } from "./helpers";

// Pazienti per l'agenda: il mini modulo del "Nuovo paziente" con il genitore del
// minore, e la ricerca per nome, cognome o telefono dalla terza lettera, senza maiuscole né accenti,
// con % _ e \ trattati come testo.

const clock = fixedClock("2026-11-04T08:30:00+01:00");

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const MARCO = { firstName: "Marco", lastName: "Bellandì", birthDate: "1979-03-09", phone: "+39 333 000 0012" };
const SOFIA = { firstName: "Sofia", lastName: "Rinaldi", birthDate: "2026-06-24" };
const ELENA = { firstName: "Elena", lastName: "Rinaldi", phone: "340 000 0066" };

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

/** Il comando risponde con un DomainError di testo `message`: la transazione resta valida. */
async function expectDomainError(p: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
}

async function patientRow(tx: Tx, id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx.query("select * from public.patients where id = $1", [id]);
  return row;
}

async function guardianRows(tx: Tx, patientId: string) {
  return tx.query<Record<string, unknown>>(
    "select * from public.patient_guardians where patient_id = $1 order by created_at, id",
    [patientId],
  );
}

async function countPatients(tx: Tx): Promise<number> {
  const [row] = await tx.query<{ n: number }>("select count(*)::int as n from public.patients where practice_id = $1", [
    PRACTICE_A,
  ]);
  return row?.n ?? -1;
}

async function countGuardians(tx: Tx): Promise<number> {
  const [row] = await tx.query<{ n: number }>(
    "select count(*)::int as n from public.patient_guardians where practice_id = $1",
    [PRACTICE_A],
  );
  return row?.n ?? -1;
}

const BIRTH_FUTURE = "La data di nascita non può essere nel futuro.";
const BIRTH_TOO_OLD = "La data di nascita non può essere di più di 120 anni fa.";
const MINOR_NEEDS_GUARDIAN = "Per un minore servono nome e cognome di un genitore.";

describe("createPatient", () => {
  it("scrive un adulto con il tono dello studio e il telefono in E.164", async () => {
    const saved = await inUserA(db, async (tx) => {
      const { id } = await createPatient(tx, PRACTICE_A, clock, MARCO);
      return { id, row: await patientRow(tx, id), guardians: await guardianRows(tx, id) };
    });
    expect(saved.row).toMatchObject({
      id: saved.id,
      practice_id: PRACTICE_A,
      first_name: "Marco",
      last_name: "Bellandì",
      birth_date: "1979-03-09",
      phone: "+393330000012",
      // Il default dello studio nella fixture.
      addressing: "lei",
      archived_at: null,
    });
    expect(saved.guardians).toEqual([]);
  });

  it("il tono viene da practice_settings.default_addressing", async () => {
    const addressing = await inUserA(db, async (tx) => {
      await tx.query("update public.practice_settings set default_addressing = 'tu' where practice_id = $1", [
        PRACTICE_A,
      ]);
      const { id } = await createPatient(tx, PRACTICE_A, clock, MARCO);
      return (await patientRow(tx, id))?.addressing;
    });
    expect(addressing).toBe("tu");
  });

  it("toglie gli spazi ai lati e salva null per il telefono vuoto o assente", async () => {
    const rows = await inUserA(db, async (tx) => {
      const blank = await createPatient(tx, PRACTICE_A, clock, {
        ...MARCO,
        firstName: "  Marco ",
        lastName: " Bellandì  ",
        phone: "  ",
      });
      const missing = await createPatient(tx, PRACTICE_A, clock, { firstName: "Anna", lastName: "Neri", birthDate: "1980-01-01" });
      return { blank: await patientRow(tx, blank.id), missing: await patientRow(tx, missing.id) };
    });
    expect(rows.blank).toMatchObject({ first_name: "Marco", last_name: "Bellandì", phone: null });
    expect(rows.missing).toMatchObject({ first_name: "Anna", phone: null });
  });

  it("un adulto di 120 anni passa, uno di un giorno in più no", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(createPatient(tx, PRACTICE_A, clock, { ...MARCO, birthDate: "1906-11-03" }));
      expect(failure).toEqual({ ok: false, refused: true, message: BIRTH_TOO_OLD, fieldErrors: { birthDate: BIRTH_TOO_OLD } });
      expect(await countPatients(tx)).toBe(3);

      const { id } = await createPatient(tx, PRACTICE_A, clock, { ...MARCO, birthDate: "1906-11-04" });
      expect((await patientRow(tx, id))?.birth_date).toBe("1906-11-04");
    });
  });

  it("rifiuta una data di nascita nel futuro, anche di un solo giorno, prima di chiedere il genitore", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(createPatient(tx, PRACTICE_A, clock, { ...SOFIA, birthDate: "2026-11-05" }));
      expect(failure).toEqual({ ok: false, refused: true, message: BIRTH_FUTURE, fieldErrors: { birthDate: BIRTH_FUTURE } });
      expect(await countPatients(tx)).toBe(3);
    });
  });

  it("chi nasce oggi è un minore e ha il genitore", async () => {
    await inUserA(db, async (tx) => {
      await expectDomainError(createPatient(tx, PRACTICE_A, clock, { ...SOFIA, birthDate: "2026-11-04" }), MINOR_NEEDS_GUARDIAN);
      const { id } = await createPatient(tx, PRACTICE_A, clock, { ...SOFIA, birthDate: "2026-11-04", guardian: ELENA });
      expect((await guardianRows(tx, id)).length).toBe(1);
    });
  });

  it("un minore senza genitore è rifiutato sul campo guardian.firstName e non scrive niente", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(createPatient(tx, PRACTICE_A, clock, SOFIA));
      expect(failure).toEqual({
        ok: false,
        refused: true,
        message: MINOR_NEEDS_GUARDIAN,
        fieldErrors: { "guardian.firstName": MINOR_NEEDS_GUARDIAN },
      });
      expect(await countPatients(tx)).toBe(3);
      expect(await countGuardians(tx)).toBe(1);
    });
  });

  it("un minore con il genitore scrive il paziente e un genitore contatto e intestatario", async () => {
    const saved = await inUserA(db, async (tx) => {
      const { id } = await createPatient(tx, PRACTICE_A, clock, { ...SOFIA, guardian: ELENA });
      return { id, row: await patientRow(tx, id), guardians: await guardianRows(tx, id) };
    });
    expect(saved.row).toMatchObject({ first_name: "Sofia", last_name: "Rinaldi", birth_date: "2026-06-24", phone: null });
    expect(saved.guardians).toHaveLength(1);
    expect(saved.guardians[0]).toMatchObject({
      practice_id: PRACTICE_A,
      patient_id: saved.id,
      relationship: "altro",
      first_name: "Elena",
      last_name: "Rinaldi",
      phone: "+393400000066",
      is_contact: true,
      is_payer: true,
      has_parental_authority: true,
    });
  });

  it("il genitore senza nome o cognome è rifiutato sul suo campo e il minore non nasce", async () => {
    await inUserA(db, async (tx) => {
      const noLastName = await formFailure(
        createPatient(tx, PRACTICE_A, clock, { ...SOFIA, guardian: { firstName: "Elena", lastName: " " } }),
      );
      expect(noLastName.fieldErrors).toEqual({ "guardian.lastName": "Campo obbligatorio." });
      const badPhone = await formFailure(
        createPatient(tx, PRACTICE_A, clock, { ...SOFIA, guardian: { ...ELENA, phone: "abc" } }),
      );
      expect(badPhone.fieldErrors).toEqual({
        "guardian.phone": "Scrivi il numero con il prefisso, per esempio +39 051 000 0000.",
      });
      expect(await countPatients(tx)).toBe(3);
    });
  });

  it("un adulto con un genitore è un modulo che l'interfaccia non produce", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(createPatient(tx, PRACTICE_A, clock, { ...MARCO, guardian: ELENA }));
      expect(failure).toEqual({ ok: false, refused: true, message: "Valore non valido", fieldErrors: { guardian: "Valore non valido" } });
      expect(await countPatients(tx)).toBe(3);
    });
  });

  it("rifiuta una chiave in più (codice fiscale, studio) e non scrive niente", async () => {
    await inUserA(db, async (tx) => {
      for (const extra of [{ taxCode: "BLLMRC79C09A944X" }, { practiceId: PRACTICE_B }, { archivedAt: "2026-11-04" }]) {
        const failure = await formFailure(createPatient(tx, PRACTICE_A, clock, { ...MARCO, ...extra }));
        expect(failure.ok).toBe(false);
      }
      // Anche dentro il genitore.
      await formFailure(createPatient(tx, PRACTICE_A, clock, { ...SOFIA, guardian: { ...ELENA, taxCode: "RNLLNE80A41A944X" } }));
      expect(await countPatients(tx)).toBe(3);
      expect(await countGuardians(tx)).toBe(1);
    });
  });

  it.each([
    ["nome vuoto", { firstName: "  " }, "firstName", "Campo obbligatorio."],
    ["nome oltre 60 caratteri", { firstName: "a".repeat(61) }, "firstName", "Massimo 60 caratteri."],
    ["cognome vuoto", { lastName: "" }, "lastName", "Campo obbligatorio."],
    ["cognome oltre 60 caratteri", { lastName: "a".repeat(61) }, "lastName", "Massimo 60 caratteri."],
    ["data scritta come nel campo", { birthDate: "09/03/1979" }, "birthDate", "Scrivi la data nel formato 22/10/2026."],
    ["data che non esiste", { birthDate: "1979-02-30" }, "birthDate", "Scrivi la data nel formato 22/10/2026."],
    ["data vuota", { birthDate: "" }, "birthDate", "Campo obbligatorio."],
    ["telefono che non lo è", { phone: "abc" }, "phone", "Scrivi il numero con il prefisso, per esempio +39 051 000 0000."],
  ])("%s è rifiutato sul campo %s", async (_name, patch, field, message) => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(createPatient(tx, PRACTICE_A, clock, { ...MARCO, ...patch }));
      expect(failure.fieldErrors).toEqual({ [field]: message });
      expect(await countPatients(tx)).toBe(3);
    });
  });

  it("come uB sullo studio di A risponde Operazione non permessa", async () => {
    await inRollback(db, "B", async (tx) => {
      await expectDomainError(createPatient(tx, PRACTICE_A, clock, MARCO), NOT_ALLOWED);
      await expectDomainError(createPatient(tx, PRACTICE_A, clock, { ...SOFIA, guardian: ELENA }), NOT_ALLOWED);
    });
  });
});

describe("searchPatients", () => {
  const MARCO_SEARCH = { firstName: "Marco", lastName: "Bellandì", birthDate: "1979-03-09", phone: "+39 333 000 0012" };

  /** Marco Bellandì come lo trova il selettore. */
  async function withMarco(tx: Tx) {
    const { id } = await createPatient(tx, PRACTICE_A, clock, MARCO_SEARCH);
    return { id, hit: { id, firstName: "Marco", lastName: "Bellandì", birthDate: "1979-03-09", phone: "+393330000012", archived: false } };
  }

  it.each(["bellandi", "BELLANDÌ marco", "marco bellandi", "  Bellandì  ", "ell", "bellandì m"])(
    "trova Marco Bellandì scrivendo %j",
    async (text) => {
      const hits = await inUserA(db, async (tx) => {
        const { hit } = await withMarco(tx);
        return { expected: hit, found: await searchPatients(tx, PRACTICE_A, text) };
      });
      expect(hits.found).toEqual([hits.expected]);
    },
  );

  it.each(["", "b", "be", "  be  ", "\t\tb "])("sotto le tre lettere (%j) non cerca e risponde []", async (text) => {
    const found = await inUserA(db, async (tx) => {
      await withMarco(tx);
      return searchPatients(tx, PRACTICE_A, text);
    });
    expect(found).toEqual([]);
  });

  it.each(["333 000 00", "3330000012", "+39 333", "393330000012", "000 0012"])(
    "trova Marco dalle cifre del telefono: %j",
    async (text) => {
      const found = await inUserA(db, async (tx) => {
        const { hit } = await withMarco(tx);
        return { expected: hit, found: await searchPatients(tx, PRACTICE_A, text) };
      });
      expect(found.found).toEqual([found.expected]);
    },
  );

  it("con meno di tre cifre nel testo il telefono non entra nella ricerca", async () => {
    const found = await inUserA(db, async (tx) => {
      await withMarco(tx);
      // Tre caratteri, ma solo due cifre: il numero contiene "12" e non deve bastare.
      return searchPatients(tx, PRACTICE_A, "x12");
    });
    expect(found).toEqual([]);
  });

  it("tratta %, _ e \\ come testo: senza protezione tutti e tre troverebbero Giulia Ferrari", async () => {
    const control = await inUserA(db, (tx) => searchPatients(tx, PRACTICE_A, "ferr"));
    expect(control.map((hit) => hit.lastName)).toEqual(["Ferrari"]);

    const found = await inUserA(db, async (tx) => ({
      percent: await searchPatients(tx, PRACTICE_A, "fer%"),
      underscore: await searchPatients(tx, PRACTICE_A, "fe_r"),
      backslash: await searchPatients(tx, PRACTICE_A, "fe\\r"),
      wildcardOnly: await searchPatients(tx, PRACTICE_A, "%%%"),
      underscoresOnly: await searchPatients(tx, PRACTICE_A, "___"),
    }));
    expect(found).toEqual({ percent: [], underscore: [], backslash: [], wildcardOnly: [], underscoresOnly: [] });
  });

  it("il trattino basso cercato è quello del cognome, non un jolly", async () => {
    const found = await inUserA(db, async (tx) => {
      const low = await createPatient(tx, PRACTICE_A, clock, { firstName: "Luca", lastName: "D_Angelo", birthDate: "1990-05-05" });
      await createPatient(tx, PRACTICE_A, clock, { firstName: "Luca", lastName: "Dxangelo", birthDate: "1991-06-06" });
      return { low, hits: await searchPatients(tx, PRACTICE_A, "d_a") };
    });
    expect(found.hits.map((hit) => [hit.id, hit.lastName])).toEqual([[found.low.id, "D_Angelo"]]);
  });

  it("il segno % e la barra cercati sono quelli scritti nel cognome", async () => {
    const found = await inUserA(db, async (tx) => {
      const pct = await createPatient(tx, PRACTICE_A, clock, { firstName: "Gino", lastName: "Cento%", birthDate: "1950-01-01" });
      const back = await createPatient(tx, PRACTICE_A, clock, { firstName: "Gino", lastName: "Back\\slash", birthDate: "1950-01-02" });
      return {
        pct,
        back,
        percent: await searchPatients(tx, PRACTICE_A, "cento%"),
        backslash: await searchPatients(tx, PRACTICE_A, "back\\sl"),
      };
    });
    expect(found.percent.map((hit) => hit.id)).toEqual([found.pct.id]);
    expect(found.backslash.map((hit) => hit.id)).toEqual([found.back.id]);
  });

  it("ordina per cognome e nome, e i risultati portano i campi del selettore", async () => {
    const hits = await inUserA(db, async (tx) => {
      await createPatient(tx, PRACTICE_A, clock, { firstName: "Marco", lastName: "Bellandì", birthDate: "1979-03-09" });
      await createPatient(tx, PRACTICE_A, clock, { firstName: "anna", lastName: "bellandi", birthDate: "1985-12-24" });
      return searchPatients(tx, PRACTICE_A, "bellandi");
    });
    expect(hits.map((hit) => `${hit.lastName} ${hit.firstName}`)).toEqual(["bellandi anna", "Bellandì Marco"]);
    expect(hits[0]).toEqual({
      id: expect.any(String),
      firstName: "anna",
      lastName: "bellandi",
      birthDate: "1985-12-24",
      phone: null,
      archived: false,
    });
  });

  it("un paziente archiviato esce dopo gli attivi, con archived true", async () => {
    const hits = await inUserA(db, async (tx) => {
      const first = await createPatient(tx, PRACTICE_A, clock, { firstName: "Anna", lastName: "Bellandì", birthDate: "1985-12-24" });
      await createPatient(tx, PRACTICE_A, clock, { firstName: "Marco", lastName: "Bellandì", birthDate: "1979-03-09" });
      await tx.query("update public.patients set archived_at = $2 where id = $1", [first.id, clock.now()]);
      return searchPatients(tx, PRACTICE_A, "bellandi");
    });
    // Anna verrebbe prima per nome: archiviata, viene dopo.
    expect(hits.map((hit) => [hit.firstName, hit.archived])).toEqual([
      ["Marco", false],
      ["Anna", true],
    ]);
  });

  it("restituisce al massimo 8 pazienti, o il limite dato", async () => {
    const found = await inUserA(db, async (tx) => {
      for (let n = 1; n <= 10; n++) {
        await createPatient(tx, PRACTICE_A, clock, { firstName: `Paolo${String(n).padStart(2, "0")}`, lastName: "Verdi", birthDate: "1970-01-01" });
      }
      return { byDefault: await searchPatients(tx, PRACTICE_A, "verdi"), two: await searchPatients(tx, PRACTICE_A, "verdi", 2) };
    });
    expect(found.byDefault.map((hit) => hit.firstName)).toEqual(
      Array.from({ length: 8 }, (_, i) => `Paolo${String(i + 1).padStart(2, "0")}`),
    );
    expect(found.two.map((hit) => hit.firstName)).toEqual(["Paolo01", "Paolo02"]);
  });

  it("studio B: come uB cerca solo fra i suoi, e Ferrari non c'è", async () => {
    await inRollback(db, "B", async (tx) => {
      expect(await searchPatients(tx, PRACTICE_B, "Ferrari")).toEqual([]);
      // Neppure indicando lo studio di A: la RLS non fa vedere le sue righe.
      expect(await searchPatients(tx, PRACTICE_A, "Ferrari")).toEqual([]);
      expect((await searchPatients(tx, PRACTICE_B, "Conti")).map((hit) => hit.lastName)).toEqual(["Conti"]);
    });
  });

  it("studio A: uA non trova i pazienti di B nemmeno indicando lo studio di B", async () => {
    await inUserA(db, async (tx) => {
      expect(await searchPatients(tx, PRACTICE_A, "Conti")).toEqual([]);
      expect(await searchPatients(tx, PRACTICE_B, "Conti")).toEqual([]);
    });
  });
});

describe("getPatientForBooking", () => {
  it("un paziente con un ciclo aperto e nessun appuntamento fatto", async () => {
    const patient = await inUserA(db, (tx) => getPatientForBooking(tx, PRACTICE_A, PATIENT_A1));
    expect(patient).toEqual({
      id: PATIENT_A1,
      firstName: "Giulia",
      lastName: "Ferrari",
      birthDate: "1984-03-09",
      phone: null,
      archived: false,
      hasDoneAppointment: false,
      hasClosedCycle: false,
      openCycle: {
        id: CYCLE_A,
        kind: "trattamento",
        title: "Lombalgia, ottobre 2026",
        expectedSessions: 4,
        openedOn: "2026-10-01",
      },
    });
  });

  it("un paziente senza cicli: nessun ciclo aperto e nessuno chiuso", async () => {
    const patient = await inUserA(db, (tx) => getPatientForBooking(tx, PRACTICE_A, PATIENT_A2));
    expect(patient).toMatchObject({ id: PATIENT_A2, openCycle: null, hasClosedCycle: false, hasDoneAppointment: false });
  });

  it("riconosce un appuntamento fatto e un ciclo chiuso", async () => {
    const patient = await inUserA(db, async (tx) => {
      await tx.query("update public.appointments set status = 'fatto' where patient_id = $1", [PATIENT_A1]);
      await tx.query(
        "update public.treatment_cycles set status = 'closed', closed_on = '2026-10-20', outcome = 'raggiunto' where patient_id = $1",
        [PATIENT_A1],
      );
      return getPatientForBooking(tx, PRACTICE_A, PATIENT_A1);
    });
    expect(patient).toMatchObject({ hasDoneAppointment: true, hasClosedCycle: true, openCycle: null });
  });

  it("un appuntamento saltato o annullato non conta come fatto", async () => {
    const patient = await inUserA(db, async (tx) => {
      await tx.query("update public.appointments set status = 'saltato' where patient_id = $1", [PATIENT_A1]);
      return getPatientForBooking(tx, PRACTICE_A, PATIENT_A1);
    });
    expect(patient?.hasDoneAppointment).toBe(false);
  });

  it("un paziente archiviato si legge, con archived true", async () => {
    const patient = await inUserA(db, async (tx) => {
      await tx.query("update public.patients set archived_at = $2 where id = $1", [PATIENT_A2, clock.now()]);
      return getPatientForBooking(tx, PRACTICE_A, PATIENT_A2);
    });
    expect(patient?.archived).toBe(true);
  });

  it("un id che non c'è, o di un altro studio, dà null", async () => {
    await inUserA(db, async (tx) => {
      expect(await getPatientForBooking(tx, PRACTICE_A, "c0000000-0000-4000-8000-0000000000ff")).toBeNull();
      expect(await getPatientForBooking(tx, PRACTICE_A, PATIENT_B1)).toBeNull();
    });
    await inRollback(db, "B", async (tx) => {
      expect(await getPatientForBooking(tx, PRACTICE_A, PATIENT_A1)).toBeNull();
      expect(await getPatientForBooking(tx, PRACTICE_B, PATIENT_A1)).toBeNull();
    });
  });
});
