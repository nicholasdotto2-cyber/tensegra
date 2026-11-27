import { describe, expect, it } from "vitest";
import { NewPatientInput, PatientGroupInput, SaveGuardianInput } from "@/server/domain/patients/schemas";
import { ServiceInput, ServiceUpdateInput } from "@/server/domain/services/schemas";
import { StudioInput } from "@/server/domain/settings/schemas";

const ID = "c0000000-0000-4000-8000-000000000001";
const PATIENT = { firstName: "Lucia", lastName: "D’Amico", birthDate: "1990-01-01", phone: null };
const ADDRESS = { addressLine: " Via dell’Olmo 1 ", postalCode: null, city: " Città – Prova ", province: null, country: "IT" };
const GUARDIAN = {
  patientId: ID,
  relationship: "madre",
  firstName: " Lucia ",
  lastName: " D’Amico ",
  taxCode: null,
  phone: null,
  email: null,
  ...ADDRESS,
  hasParentalAuthority: true,
  isContact: true,
  isPayer: false,
};
const STUDIO = {
  practiceName: " Studio – Prova ",
  practitionerFirstName: " Lucia ",
  practitionerLastName: " D’Amico ",
  practitionerTitle: " Osteopata – D.O. ",
  addressLine: ADDRESS.addressLine,
  postalCode: null,
  city: ADDRESS.city,
  province: null,
  phone: null,
  email: null,
  pec: null,
};
const SERVICE = {
  kind: "seduta",
  name: " Seduta – controllo ",
  invoiceDescription: " Seduta – controllo ",
  durationMin: 45,
  priceCents: 5500,
  color: "petrolio",
};

describe("Latin-1 negli input dei salvataggi", () => {
  it("converte il cognome del nuovo paziente e toglie gli spazi prima della conversione", () => {
    expect(NewPatientInput.parse(PATIENT).lastName).toBe("D'Amico");
    expect(NewPatientInput.parse({ ...PATIENT, firstName: " Lucia – Maria " }).firstName).toBe("Lucia - Maria");
  });

  it("converte nome e cognome del genitore nel mini modulo", () => {
    expect(NewPatientInput.parse({ ...PATIENT, guardian: { firstName: " Lucia – Maria ", lastName: " D’Amico " } }).guardian)
      .toMatchObject({ firstName: "Lucia - Maria", lastName: "D'Amico" });
  });

  it("converte i dati personali del paziente", () => {
    expect(PatientGroupInput.parse({
      group: "personali", patientId: ID, firstName: " Lucia – Maria ", lastName: " D’Amico ",
      birthDate: PATIENT.birthDate, sex: "f", birthPlace: " Città – Prova ", taxCode: null,
    })).toMatchObject({ firstName: "Lucia - Maria", lastName: "D'Amico", birthPlace: "Città - Prova" });
  });

  it("converte indirizzo e città del paziente", () => {
    expect(PatientGroupInput.parse({ group: "indirizzo", patientId: ID, ...ADDRESS }))
      .toMatchObject({ addressLine: "Via dell'Olmo 1", city: "Città - Prova" });
  });

  it("converte nomi e indirizzo del tutore", () => {
    expect(SaveGuardianInput.parse({ ...GUARDIAN, firstName: " Lucia – Maria " }))
      .toMatchObject({ firstName: "Lucia - Maria", lastName: "D'Amico", addressLine: "Via dell'Olmo 1", city: "Città - Prova" });
  });

  it("converte i sei campi dello studio e dell'osteopata", () => {
    expect(StudioInput.parse({ ...STUDIO, practitionerFirstName: " Lucia – Maria " })).toMatchObject({
      practiceName: "Studio - Prova", practitionerFirstName: "Lucia - Maria", practitionerLastName: "D'Amico",
      practitionerTitle: "Osteopata - D.O.", addressLine: "Via dell'Olmo 1", city: "Città - Prova",
    });
  });

  it.each([ServiceInput, ServiceUpdateInput])("converte nome e descrizione del listino, anche in modifica (%#)", (schema) => {
    const input = schema === ServiceUpdateInput ? { id: ID, ...SERVICE } : SERVICE;
    expect(schema.parse(input)).toMatchObject({ name: "Seduta - controllo", invoiceDescription: "Seduta - controllo" });
  });

  it("salva senza rifiutare o alterare un cognome che resta fuori dal Latin-1", () => {
    expect(NewPatientInput.parse({ ...PATIENT, lastName: "Nguyễn" }).lastName).toBe("Nguyễn");
  });

  it.each([
    ["paziente", 60, (value: string) => NewPatientInput.safeParse({ ...PATIENT, lastName: value })],
    ["genitore", 60, (value: string) => NewPatientInput.safeParse({ ...PATIENT, guardian: { firstName: "Lucia", lastName: value } })],
    ["tutore", 60, (value: string) => SaveGuardianInput.safeParse({ ...GUARDIAN, lastName: value })],
    ["studio", 80, (value: string) => StudioInput.safeParse({ ...STUDIO, practiceName: value })],
    ["osteopata", 60, (value: string) => StudioInput.safeParse({ ...STUDIO, practitionerLastName: value })],
    ["nome listino", 60, (value: string) => ServiceInput.safeParse({ ...SERVICE, name: value })],
    ["descrizione listino", 200, (value: string) => ServiceInput.safeParse({ ...SERVICE, invoiceDescription: value })],
    ["modifica listino", 200, (value: string) => ServiceUpdateInput.safeParse({ id: ID, ...SERVICE, invoiceDescription: value })],
  ] as const)("%s: il limite conta i tre caratteri dei puntini convertiti", (_label, max, parse) => {
    expect(parse(` ${"a".repeat(max - 3)}… `).success).toBe(true);
    const tooLong = parse(`${"a".repeat(max - 2)}…`);
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) expect(tooLong.error.issues[0]?.message).toBe(`Massimo ${max} caratteri.`);
  });
});
