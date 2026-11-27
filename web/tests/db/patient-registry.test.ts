import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { BLOCKED_DELETE, isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { getRegistry } from "@/server/domain/patients/card";
import { removeGuardian, saveGuardian, updatePatientGroup } from "@/server/domain/patients/commands";
import { createPhysician } from "@/server/domain/physicians/commands";
import { listPhysicians } from "@/server/domain/physicians/queries";
import {
  FILE_A,
  GUARDIAN_A,
  PATIENT_A1,
  PATIENT_A3,
  PHYSICIAN_A,
  PHYSICIAN_B,
  PRACTICE_A,
  PRACTICE_B,
  sha256Hex,
} from "./fixtures";
import { asUserA, asUserB, expectPgError, inRollback, inUserA, openTestDb } from "./helpers";

// Anagrafica per gruppi: ogni gruppo si salva da solo; il codice
// fiscale con il carattere di controllo e le omocodie; i medici dalla rubrica; al massimo due genitori,
// per un minore esattamente un contatto, un solo intestatario con indirizzo, e il nuovo contatto o
// intestatario toglie il flag all'altro prima, nella stessa transazione. Come uA, D0 alle 08:30.

const clock = fixedClock("2026-11-04T08:30:00+01:00");

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

/** Il comando risponde con un DomainError di testo `message`: la transazione resta valida. */
async function expectDomainError(p: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
}

async function patientRow(tx: Tx, id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx.query("select * from public.patients where practice_id = $1 and id = $2", [PRACTICE_A, id]);
  return row;
}

async function guardianRows(tx: Tx, patientId: string) {
  return tx.query<Record<string, unknown>>(
    "select * from public.patient_guardians where practice_id = $1 and patient_id = $2 order by created_at, id",
    [PRACTICE_A, patientId],
  );
}

// Giulia Ferrari della fixture, 9/3/1984, con un codice inventato su X999. Controllo a mano
// (tabelle del DM): F R R G L I 8 4 C 4 9 X 9 9 9; dispari F 13, R 8, L 4, 8 19, C 5, 9 21, 9 21,
// 9 21 = 112; pari R 17, G 6, I 8, 4 4, 4 4, X 23, 9 9 = 71; 183 mod 26 = 1 = B.
const GIULIA_TAX_CODE = "FRRGLI84C49X999B";

const PERSONALI = {
  group: "personali",
  patientId: PATIENT_A1,
  firstName: " Giulia ",
  lastName: "Ferrari",
  birthDate: "1984-03-09",
  sex: "f",
  birthPlace: "Bologna",
  taxCode: GIULIA_TAX_CODE.toLowerCase(),
} as const;

const CONTATTI = {
  group: "contatti",
  patientId: PATIENT_A1,
  phone: "051 000 0000",
  email: "giulia.ferrari@example.com",
  preferredChannel: "telefono",
  addressing: "tu",
} as const;

const INDIRIZZO = {
  group: "indirizzo",
  patientId: PATIENT_A1,
  addressLine: "Via dei Prova 1",
  postalCode: "40121",
  city: "Bologna",
  province: "bo",
  country: "IT",
} as const;

const MEDICI = { group: "medici", patientId: PATIENT_A1, gpPhysicianId: PHYSICIAN_A, defaultReferringPhysicianId: null };
const NOTE = { group: "note", patientId: PATIENT_A1, adminNotes: "Preferisce la fattura via email." } as const;

/** Il padre di Sofia Greco (`PATIENT_A3`), senza flag; `GUARDIAN_A` (la madre) è contatto e intestataria. */
const PADRE = {
  patientId: PATIENT_A3,
  relationship: "padre",
  firstName: "Paolo",
  lastName: "Greco",
  taxCode: null,
  phone: "333 000 0099",
  email: null,
  addressLine: null,
  postalCode: null,
  city: null,
  province: null,
  country: "IT",
  hasParentalAuthority: true,
  isContact: false,
  isPayer: false,
} as const;

const ADDRESS = { addressLine: "Via dei Prova 3", postalCode: "40100", city: "Bologna", province: "BO" } as const;

const MINOR_NEEDS_CONTACT = "Per un minore serve un genitore di contatto.";
const TOO_MANY_GUARDIANS = "Un paziente ha al massimo due genitori o tutori.";
const PAYER_NEEDS_ADDRESS = "Per l'intestatario servono indirizzo, CAP e città.";

describe("updatePatientGroup: personali", () => {
  it("salva i dati personali con il codice fiscale in maiuscolo, e li rilegge", async () => {
    const row = await inUserA(db, async (tx) => {
      await updatePatientGroup(tx, PRACTICE_A, clock, PERSONALI);
      return patientRow(tx, PATIENT_A1);
    });
    expect(row).toMatchObject({
      first_name: "Giulia",
      last_name: "Ferrari",
      birth_date: "1984-03-09",
      sex: "f",
      birth_place: "Bologna",
      tax_code: GIULIA_TAX_CODE,
      // Gli altri gruppi non cambiano.
      phone: null,
      gp_physician_id: PHYSICIAN_A,
    });
  });

  it("campi facoltativi vuoti: null", async () => {
    const row = await inUserA(db, async (tx) => {
      await updatePatientGroup(tx, PRACTICE_A, clock, { ...PERSONALI, birthPlace: " ", taxCode: "" });
      return patientRow(tx, PATIENT_A1);
    });
    expect(row).toMatchObject({ birth_place: null, tax_code: null });
  });

  it("codice fiscale con il carattere di controllo sbagliato: errore sul campo, niente scritto", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(
        updatePatientGroup(tx, PRACTICE_A, clock, { ...PERSONALI, firstName: "Giulietta", taxCode: "FRRGLI84C49X999A" }),
      );
      expect(failure.fieldErrors).toEqual({ taxCode: "Il codice fiscale non è valido: controlla lettere e cifre." });
      expect(await patientRow(tx, PATIENT_A1)).toMatchObject({ first_name: "Giulia", tax_code: null });
    });
  });

  it("nascita nel futuro e oltre 120 anni fa: errore sulla data", async () => {
    await inUserA(db, async (tx) => {
      const future = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...PERSONALI, birthDate: "2026-11-05" }));
      expect(future.fieldErrors).toEqual({ birthDate: "La data di nascita non può essere nel futuro." });
      const old = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...PERSONALI, birthDate: "1906-11-03" }));
      expect(old.fieldErrors).toEqual({ birthDate: "La data di nascita non può essere di più di 120 anni fa." });
      expect(await patientRow(tx, PATIENT_A1)).toMatchObject({ birth_date: "1984-03-09" });
    });
  });

  it("da adulto a minore senza genitore di contatto: errore sulla data", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...PERSONALI, birthDate: "2015-05-10" }));
      expect(failure).toEqual({ ok: false, refused: true, message: MINOR_NEEDS_CONTACT, fieldErrors: { birthDate: MINOR_NEEDS_CONTACT } });
      expect(await patientRow(tx, PATIENT_A1)).toMatchObject({ birth_date: "1984-03-09" });
    });
  });

  it("un minore con il genitore di contatto cambia i suoi dati", async () => {
    const row = await inUserA(db, async (tx) => {
      await updatePatientGroup(tx, PRACTICE_A, clock, {
        ...PERSONALI,
        patientId: PATIENT_A3,
        firstName: "Sofia",
        lastName: "Greco",
        birthDate: "2016-02-15",
        taxCode: null,
      });
      return patientRow(tx, PATIENT_A3);
    });
    expect(row).toMatchObject({ first_name: "Sofia", birth_date: "2016-02-15", sex: "f" });
  });

  it("chiave in più o sesso fuori elenco: Valore non valido", async () => {
    await inUserA(db, async (tx) => {
      const extra = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...PERSONALI, archivedAt: null }));
      expect(extra.message).toBe("Valore non valido");
      const sex = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...PERSONALI, sex: "x" }));
      expect(sex.fieldErrors).toEqual({ sex: "Valore non valido" });
      const group = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...NOTE, group: "fattura" }));
      expect(group.message).toBe("Valore non valido");
    });
  });
});

describe("updatePatientGroup: contatti", () => {
  it("telefono in E.164, email, canale e tono", async () => {
    const row = await inUserA(db, async (tx) => {
      await updatePatientGroup(tx, PRACTICE_A, clock, CONTATTI);
      return patientRow(tx, PATIENT_A1);
    });
    expect(row).toMatchObject({
      phone: "+390510000000",
      email: "giulia.ferrari@example.com",
      preferred_channel: "telefono",
      addressing: "tu",
    });
  });

  it("email senza dominio, telefono non valido, canale fuori elenco", async () => {
    await inUserA(db, async (tx) => {
      const email = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...CONTATTI, email: "x@" }));
      expect(email.fieldErrors).toEqual({ email: "Scrivi un indirizzo email valido." });
      const phone = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...CONTATTI, phone: "12" }));
      expect(phone.fieldErrors).toEqual({ phone: "Scrivi il numero con il prefisso, per esempio +39 051 000 0000." });
      const channel = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...CONTATTI, preferredChannel: "fax" }));
      expect(channel.fieldErrors).toEqual({ preferredChannel: "Valore non valido" });
      expect(await patientRow(tx, PATIENT_A1)).toMatchObject({ phone: null, email: null, preferred_channel: "whatsapp" });
    });
  });
});

describe("updatePatientGroup: indirizzo", () => {
  it("indirizzo italiano con la provincia in maiuscolo", async () => {
    const row = await inUserA(db, async (tx) => {
      await updatePatientGroup(tx, PRACTICE_A, clock, INDIRIZZO);
      return patientRow(tx, PATIENT_A1);
    });
    expect(row).toMatchObject({
      address_line: "Via dei Prova 1",
      postal_code: "40121",
      city: "Bologna",
      province: "BO",
      country: "IT",
    });
  });

  it("CAP di 4 cifre in Italia: errore sul CAP; provincia non di 2 lettere: errore sulla provincia", async () => {
    await inUserA(db, async (tx) => {
      const cap = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...INDIRIZZO, postalCode: "4012" }));
      expect(cap.fieldErrors).toEqual({ postalCode: "Scrivi il CAP con 5 cifre." });
      const province = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...INDIRIZZO, province: "Bologna" }));
      expect(province.fieldErrors).toEqual({ province: "Scrivi la sigla della provincia, per esempio BO." });
      const country = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...INDIRIZZO, country: "Italia" }));
      expect(country.fieldErrors).toEqual({ country: "Scrivi il codice del paese di 2 lettere, per esempio IT." });
      expect(await patientRow(tx, PATIENT_A1)).toMatchObject({ postal_code: null, province: null });
    });
  });

  it("all'estero il CAP e la provincia sono liberi; il paese vuoto torna IT", async () => {
    const rows = await inUserA(db, async (tx) => {
      await updatePatientGroup(tx, PRACTICE_A, clock, {
        ...INDIRIZZO,
        addressLine: "1 Test Street",
        postalCode: "SW1A",
        city: "London",
        province: "Greater London",
        country: "gb",
      });
      const abroad = await patientRow(tx, PATIENT_A1);
      await updatePatientGroup(tx, PRACTICE_A, clock, { ...INDIRIZZO, country: "" });
      return { abroad, home: await patientRow(tx, PATIENT_A1) };
    });
    expect(rows.abroad).toMatchObject({ postal_code: "SW1A", province: "Greater London", country: "GB" });
    expect(rows.home).toMatchObject({ postal_code: "40121", country: "IT" });
  });
});

describe("updatePatientGroup: medici", () => {
  it("medico curante e inviante dalla rubrica dello studio", async () => {
    const row = await inUserA(db, async (tx) => {
      await updatePatientGroup(tx, PRACTICE_A, clock, { ...MEDICI, gpPhysicianId: null, defaultReferringPhysicianId: PHYSICIAN_A });
      return patientRow(tx, PATIENT_A1);
    });
    expect(row).toMatchObject({ gp_physician_id: null, default_referring_physician_id: PHYSICIAN_A });
  });

  it("il medico di un altro studio: Operazione non permessa e niente cambia", async () => {
    await inUserA(db, async (tx) => {
      await expectDomainError(
        updatePatientGroup(tx, PRACTICE_A, clock, { ...MEDICI, gpPhysicianId: null, defaultReferringPhysicianId: PHYSICIAN_B }),
        NOT_ALLOWED,
      );
      await expectDomainError(updatePatientGroup(tx, PRACTICE_A, clock, { ...MEDICI, gpPhysicianId: PHYSICIAN_B }), NOT_ALLOWED);
      expect(await patientRow(tx, PATIENT_A1)).toMatchObject({
        gp_physician_id: PHYSICIAN_A,
        default_referring_physician_id: null,
      });
    });
  });
});

describe("updatePatientGroup: note", () => {
  it("salva le note e le toglie col campo vuoto", async () => {
    const rows = await inUserA(db, async (tx) => {
      await updatePatientGroup(tx, PRACTICE_A, clock, NOTE);
      const saved = await patientRow(tx, PATIENT_A1);
      await updatePatientGroup(tx, PRACTICE_A, clock, { ...NOTE, adminNotes: "" });
      return { saved, cleared: await patientRow(tx, PATIENT_A1) };
    });
    expect(rows.saved).toMatchObject({ admin_notes: "Preferisce la fattura via email." });
    expect(rows.cleared).toMatchObject({ admin_notes: null });
  });

  it("501 caratteri: Massimo 500 caratteri.", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(updatePatientGroup(tx, PRACTICE_A, clock, { ...NOTE, adminNotes: "a".repeat(501) }));
      expect(failure.fieldErrors).toEqual({ adminNotes: "Massimo 500 caratteri." });
    });
  });
});

describe("saveGuardian e removeGuardian", () => {
  it("il padre senza flag, poi contatto e intestatario: i flag passano dalla madre al padre", async () => {
    const steps = await inUserA(db, async (tx) => {
      const { id } = await saveGuardian(tx, PRACTICE_A, clock, PADRE);
      const added = await guardianRows(tx, PATIENT_A3);
      await saveGuardian(tx, PRACTICE_A, clock, { ...PADRE, ...ADDRESS, guardianId: id, isContact: true, isPayer: true });
      return { id, added, swapped: await guardianRows(tx, PATIENT_A3) };
    });
    expect(steps.added).toHaveLength(2);
    expect(steps.added.find((g) => g.id === steps.id)).toMatchObject({
      practice_id: PRACTICE_A,
      relationship: "padre",
      first_name: "Paolo",
      last_name: "Greco",
      phone: "+393330000099",
      has_parental_authority: true,
      is_contact: false,
      is_payer: false,
    });
    expect(steps.swapped).toHaveLength(2);
    expect(steps.swapped.find((g) => g.id === steps.id)).toMatchObject({
      is_contact: true,
      is_payer: true,
      address_line: "Via dei Prova 3",
      postal_code: "40100",
      city: "Bologna",
      province: "BO",
    });
    expect(steps.swapped.find((g) => g.id === GUARDIAN_A)).toMatchObject({ is_contact: false, is_payer: false });
  });

  it("un terzo genitore: rifiutato e le righe non cambiano", async () => {
    await inUserA(db, async (tx) => {
      await saveGuardian(tx, PRACTICE_A, clock, PADRE);
      const before = await guardianRows(tx, PATIENT_A3);
      await expectDomainError(
        saveGuardian(tx, PRACTICE_A, clock, { ...PADRE, relationship: "tutore", firstName: "Marta" }),
        TOO_MANY_GUARDIANS,
      );
      expect(await guardianRows(tx, PATIENT_A3)).toEqual(before);
    });
  });

  it("togliere l'unico contatto di un minore: rifiutato", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await saveGuardian(tx, PRACTICE_A, clock, { ...PADRE, ...ADDRESS, isContact: true, isPayer: true });
      await expectDomainError(removeGuardian(tx, PRACTICE_A, clock, { guardianId: id }), MINOR_NEEDS_CONTACT);
      expect(await guardianRows(tx, PATIENT_A3)).toHaveLength(2);
    });
  });

  it("togliere il contatto a un minore senza altri contatti: rifiutato sul campo", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(
        saveGuardian(tx, PRACTICE_A, clock, {
          ...PADRE,
          guardianId: GUARDIAN_A,
          relationship: "madre",
          firstName: "Laura",
          isContact: false,
        }),
      );
      expect(failure.fieldErrors).toEqual({ isContact: MINOR_NEEDS_CONTACT });
      expect((await guardianRows(tx, PATIENT_A3))[0]).toMatchObject({ id: GUARDIAN_A, is_contact: true, is_payer: true });
    });
  });

  it("intestatario senza indirizzo: rifiutato e niente scritto", async () => {
    await inUserA(db, async (tx) => {
      const failure = await formFailure(saveGuardian(tx, PRACTICE_A, clock, { ...PADRE, isPayer: true }));
      expect(failure).toEqual({ ok: false, refused: true, message: PAYER_NEEDS_ADDRESS, fieldErrors: { addressLine: PAYER_NEEDS_ADDRESS } });
      const noCity = await formFailure(saveGuardian(tx, PRACTICE_A, clock, { ...PADRE, ...ADDRESS, city: " ", isPayer: true }));
      expect(noCity.fieldErrors).toEqual({ city: PAYER_NEEDS_ADDRESS });
      const rows = await guardianRows(tx, PATIENT_A3);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: GUARDIAN_A, is_payer: true });
    });
  });

  it("codice fiscale, CAP e relazione del genitore si controllano come sul paziente", async () => {
    await inUserA(db, async (tx) => {
      const code = await formFailure(saveGuardian(tx, PRACTICE_A, clock, { ...PADRE, taxCode: "GRCPLA80A01X999A" }));
      expect(code.fieldErrors).toEqual({ taxCode: "Il codice fiscale non è valido: controlla lettere e cifre." });
      const cap = await formFailure(saveGuardian(tx, PRACTICE_A, clock, { ...PADRE, ...ADDRESS, postalCode: "401" }));
      expect(cap.fieldErrors).toEqual({ postalCode: "Scrivi il CAP con 5 cifre." });
      const country = await formFailure(saveGuardian(tx, PRACTICE_A, clock, { ...PADRE, country: "Italia" }));
      expect(country.fieldErrors).toEqual({ country: "Scrivi il codice del paese di 2 lettere, per esempio IT." });
      const relationship = await formFailure(saveGuardian(tx, PRACTICE_A, clock, { ...PADRE, relationship: "nonno" }));
      expect(relationship.fieldErrors).toEqual({ relationship: "Valore non valido" });
      expect(await guardianRows(tx, PATIENT_A3)).toHaveLength(1);
    });
  });

  it("un genitore nuovo per un adulto: Valore non valido, come createPatient, e niente scritto", async () => {
    await inUserA(db, async (tx) => {
      await expectDomainError(saveGuardian(tx, PRACTICE_A, clock, { ...PADRE, patientId: PATIENT_A1 }), "Valore non valido");
      expect(await guardianRows(tx, PATIENT_A1)).toEqual([]);
    });
  });

  it("un adulto che ha già un genitore lo modifica ancora", async () => {
    const rows = await inUserA(db, async (tx) => {
      // Sofia diventa maggiorenne a oggi: la madre resta, contatto e intestataria.
      await updatePatientGroup(tx, PRACTICE_A, clock, {
        ...PERSONALI,
        patientId: PATIENT_A3,
        firstName: "Sofia",
        lastName: "Greco",
        birthDate: "2008-02-14",
        taxCode: null,
      });
      await expectDomainError(saveGuardian(tx, PRACTICE_A, clock, PADRE), "Valore non valido");
      await saveGuardian(tx, PRACTICE_A, clock, {
        ...PADRE,
        guardianId: GUARDIAN_A,
        relationship: "madre",
        firstName: "Laura",
        email: "laura.greco@example.com",
        isContact: true,
      });
      return guardianRows(tx, PATIENT_A3);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: GUARDIAN_A, email: "laura.greco@example.com", is_contact: true, is_payer: false });
  });

  it("togliere un genitore che non è l'unico contatto: la riga sparisce", async () => {
    const rows = await inUserA(db, async (tx) => {
      const { id } = await saveGuardian(tx, PRACTICE_A, clock, PADRE);
      await removeGuardian(tx, PRACTICE_A, clock, { guardianId: id });
      return guardianRows(tx, PATIENT_A3);
    });
    expect(rows.map((g) => g.id)).toEqual([GUARDIAN_A]);
  });

  it("togliere un genitore che ha firmato un consenso: bloccato con il testo della delete", async () => {
    await inUserA(db, async (tx) => {
      const { id } = await saveGuardian(tx, PRACTICE_A, clock, { ...PADRE, ...ADDRESS, isContact: true, isPayer: true });
      const text = "Informativa sul trattamento dei dati personali. Io sottoscritta Laura Greco, genitore di Sofia Greco.";
      await tx.query(
        `insert into public.consent_records (practice_id, patient_id, module_key, module_version, rendered_text, rendered_hash,
                                             signer_kind, signer_name, guardian_id, method, signature_file_id, signed_on)
         values ($1, $2, 'informativa', '2026.1', $3, $4, 'genitore', 'Laura Greco', $5, 'tela', $6, '2026-10-06')`,
        [PRACTICE_A, PATIENT_A3, text, sha256Hex(text), GUARDIAN_A, FILE_A],
      );
      await expectDomainError(removeGuardian(tx, PRACTICE_A, clock, { guardianId: GUARDIAN_A }), BLOCKED_DELETE);
      expect((await guardianRows(tx, PATIENT_A3)).map((g) => g.id).sort()).toEqual([GUARDIAN_A, id].sort());
    });
  });

  it("un genitore di un altro paziente o che non c'è: Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      await expectDomainError(saveGuardian(tx, PRACTICE_A, clock, { ...PADRE, patientId: PATIENT_A1, guardianId: GUARDIAN_A }), NOT_ALLOWED);
      await expectDomainError(
        removeGuardian(tx, PRACTICE_A, clock, { guardianId: "a0000000-0000-4000-8000-0000000002ff" }),
        NOT_ALLOWED,
      );
      expect(await guardianRows(tx, PATIENT_A3)).toHaveLength(1);
    });
  });
});

describe("createPhysician e listPhysicians", () => {
  const FERRI = { fullName: "Dott. Luca Ferri", role: "mmg", phone: "051 000 0001", email: "l.ferri@example.com" } as const;

  it("nome di un carattere: Scrivi da 2 a 120 caratteri.", async () => {
    await inUserA(db, async (tx) => {
      const short = await formFailure(createPhysician(tx, PRACTICE_A, clock, { ...FERRI, fullName: "D" }));
      expect(short.fieldErrors).toEqual({ fullName: "Scrivi da 2 a 120 caratteri." });
      const long = await formFailure(createPhysician(tx, PRACTICE_A, clock, { ...FERRI, fullName: "D".repeat(121) }));
      expect(long.fieldErrors).toEqual({ fullName: "Scrivi da 2 a 120 caratteri." });
      const role = await formFailure(createPhysician(tx, PRACTICE_A, clock, { ...FERRI, role: "primario" }));
      expect(role.fieldErrors).toEqual({ role: "Valore non valido" });
      const notes = await formFailure(createPhysician(tx, PRACTICE_A, clock, { ...FERRI, notes: "n".repeat(501) }));
      expect(notes.fieldErrors).toEqual({ notes: "Massimo 500 caratteri." });
      const email = await formFailure(createPhysician(tx, PRACTICE_A, clock, { ...FERRI, email: "ferri@" }));
      expect(email.fieldErrors).toEqual({ email: "Scrivi un indirizzo email valido." });
    });
  });

  it("crea il medico, riletto dalla tabella; listPhysicians lo contiene, per nome e senza gli archiviati", async () => {
    const seen = await inUserA(db, async (tx) => {
      const { id } = await createPhysician(tx, PRACTICE_A, clock, { ...FERRI, specialty: "", organization: "Studio associato Prova" });
      const [row] = await tx.query("select * from public.physicians where practice_id = $1 and id = $2", [PRACTICE_A, id]);
      const archived = await createPhysician(tx, PRACTICE_A, clock, { fullName: "Dott. Archiviato Prova", role: "altro" });
      await tx.query("update public.physicians set archived_at = $3 where practice_id = $1 and id = $2", [
        PRACTICE_A,
        archived.id,
        clock.now(),
      ]);
      return { id, row, list: await listPhysicians(tx, PRACTICE_A) };
    });
    expect(seen.row).toMatchObject({
      practice_id: PRACTICE_A,
      full_name: "Dott. Luca Ferri",
      role: "mmg",
      specialty: null,
      organization: "Studio associato Prova",
      phone: "+390510000001",
      email: "l.ferri@example.com",
      notes: null,
      archived_at: null,
    });
    // "dott. luca" viene prima di "dott.ssa": lo spazio precede la s.
    expect(seen.list).toEqual([
      { id: seen.id, fullName: "Dott. Luca Ferri", role: "mmg" },
      { id: PHYSICIAN_A, fullName: "Dott.ssa Anna Verdi", role: "mmg" },
    ]);
  });

  it("come uB il medico di A non c'è (zero righe)", async () => {
    const created = await inRollback(db, "B", async (tx) => ({
      own: await listPhysicians(tx, PRACTICE_B),
      ofA: await listPhysicians(tx, PRACTICE_A),
    }));
    expect(created).toEqual({ own: [{ id: PHYSICIAN_B, fullName: "Dott. Piero Rinaldi", role: "pediatra" }], ofA: [] });
  });
});

// Studio B sui dati di A: un database tutto suo, perché qui le transazioni di uB arrivano al commit
// (un DomainError lascia la transazione valida) e si rilegge A dopo.
describe("studio B sugli id di A", () => {
  let isolated: Db;
  let isolatedPg: PGlite;

  beforeAll(async () => {
    ({ db: isolated, pg: isolatedPg } = await openTestDb());
  });

  afterAll(async () => {
    await isolatedPg?.close();
  });

  const snapshotOfA = () =>
    asUserA(isolated, async (tx) => ({
      patients: await tx.query("select * from public.patients where practice_id = $1 order by id", [PRACTICE_A]),
      guardians: await tx.query("select * from public.patient_guardians where practice_id = $1 order by id", [PRACTICE_A]),
      physicians: await tx.query("select * from public.physicians where practice_id = $1 order by id", [PRACTICE_A]),
    }));

  it("ogni gruppo, saveGuardian e removeGuardian: Operazione non permessa e A non cambia", async () => {
    const before = await snapshotOfA();
    await asUserB(isolated, async (tx) => {
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        for (const group of [PERSONALI, CONTATTI, INDIRIZZO, { ...MEDICI, gpPhysicianId: null }, NOTE]) {
          await expectDomainError(updatePatientGroup(tx, practiceId, clock, group), NOT_ALLOWED);
        }
        await expectDomainError(saveGuardian(tx, practiceId, clock, PADRE), NOT_ALLOWED);
        await expectDomainError(saveGuardian(tx, practiceId, clock, { ...PADRE, guardianId: GUARDIAN_A }), NOT_ALLOWED);
        await expectDomainError(removeGuardian(tx, practiceId, clock, { guardianId: GUARDIAN_A }), NOT_ALLOWED);
      }
    });
    expect(await snapshotOfA()).toEqual(before);
  });

  it("createPhysician come uB su PRACTICE_A: rifiutato dal database con Operazione non permessa, A non cambia", async () => {
    const before = await snapshotOfA();
    const failure = await rejectionOf(
      inRollback(isolated, "B", (tx) => createPhysician(tx, PRACTICE_A, clock, { fullName: "Dott. Preso", role: "mmg" })),
    );
    await expectPgError(Promise.reject(failure), "42501", /row-level security policy for table "physicians"/);
    expect(toActionFailure(failure, "test").message).toBe(NOT_ALLOWED);
    expect(await snapshotOfA()).toEqual(before);
  });
});

// I moduli ripartono da ciò che i comandi rispondono, non da una copia delle loro regole: la risposta è
// quello che `getRegistry` rilegge dalla tabella, anche per i valori che gli schemi cambiano.
describe("i valori restituiti sono quelli salvati", () => {
  it("ogni gruppo risponde con ciò che si rilegge, coi valori scritti male già normalizzati", async () => {
    const rows = await inUserA(db, async (tx) => {
      const personali = await updatePatientGroup(tx, PRACTICE_A, clock, {
        ...PERSONALI,
        taxCode: ` ${GIULIA_TAX_CODE.slice(0, 8).toLowerCase()} ${GIULIA_TAX_CODE.slice(8)} `,
        birthPlace: " ",
      });
      const contatti = await updatePatientGroup(tx, PRACTICE_A, clock, { ...CONTATTI, email: " giulia.ferrari@example.com " });
      const indirizzo = await updatePatientGroup(tx, PRACTICE_A, clock, { ...INDIRIZZO, province: "bo", country: "" });
      const medici = await updatePatientGroup(tx, PRACTICE_A, clock, { ...MEDICI, gpPhysicianId: null, defaultReferringPhysicianId: PHYSICIAN_A });
      const note = await updatePatientGroup(tx, PRACTICE_A, clock, { ...NOTE, adminNotes: "  Preferisce la mail.  " });
      return { personali, contatti, indirizzo, medici, note, read: await getRegistry(tx, PRACTICE_A, PATIENT_A1) };
    });
    expect(rows.personali).toEqual({ group: "personali", values: rows.read?.personali });
    expect(rows.contatti).toEqual({ group: "contatti", values: rows.read?.contatti });
    expect(rows.indirizzo).toEqual({ group: "indirizzo", values: rows.read?.indirizzo });
    expect(rows.medici).toEqual({ group: "medici", values: rows.read?.medici });
    expect(rows.note).toEqual({ group: "note", values: rows.read?.note });
    // E in particolare: i valori che lo schema cambia.
    expect(rows.personali.values).toMatchObject({ firstName: "Giulia", taxCode: GIULIA_TAX_CODE, birthPlace: "" });
    expect(rows.contatti.values).toMatchObject({ phone: "+390510000000", email: "giulia.ferrari@example.com" });
    expect(rows.indirizzo.values).toMatchObject({ province: "BO", country: "IT" });
    expect(rows.medici.values).toEqual({ gpPhysicianId: "", defaultReferringPhysicianId: PHYSICIAN_A });
    expect(rows.note.values).toEqual({ adminNotes: "Preferisce la mail." });
  });

  it("il genitore risponde con la riga salvata: telefono in E.164, vuoti come \"\", paese predefinito", async () => {
    const rows = await inUserA(db, async (tx) => {
      const saved = await saveGuardian(tx, PRACTICE_A, clock, {
        ...PADRE,
        ...ADDRESS,
        province: "bo",
        country: "",
        firstName: " Paolo ",
        taxCode: " ",
        isContact: true,
        isPayer: true,
      });
      const read = await getRegistry(tx, PRACTICE_A, PATIENT_A3);
      return { saved, read: read?.guardians.find((g) => g.id === saved.id) };
    });
    expect(rows.saved.guardian).toEqual(rows.read);
    expect(rows.saved.guardian).toMatchObject({
      id: rows.saved.id,
      firstName: "Paolo",
      taxCode: "",
      phone: "+393330000099",
      email: "",
      province: "BO",
      country: "IT",
      isContact: true,
      isPayer: true,
    });
  });
});
