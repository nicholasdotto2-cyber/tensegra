import { describe, expect, it } from "vitest";
import {
  fiscalCodeProblem, IBAN_INVALID, ibanProblem, isPostalCode, isProvince,
  TAX_CODE_INVALID, VAT_INVALID, vatNumberProblem,
} from "@/lib/fiscal/validators";
import { PATIENTS, STUDIO, taxCodeOf } from "../../seed/people";

const D0 = "2026-11-04";
const people = PATIENTS.flatMap((patient) => patient.contactGuardian
  ? [patient, patient.contactGuardian]
  : [patient]);

describe("Codici fiscali e bancari della demo", () => {
  it.each(["SMPCHR85M41X999B", "PRVMRC90A01X999S", STUDIO.practitionerTaxCode])(
    "%s è valido e usa il comune inventato X999", (code) => {
      expect(fiscalCodeProblem(code)).toBeNull();
      expect(code.slice(11, 15)).toBe("X999");
    },
  );

  it.each(people)("codice di $firstName $lastName con D0 fisso", (person) => {
    const code = taxCodeOf(person, D0);
    if (code === null) return;
    expect(fiscalCodeProblem(code)).toBeNull();
    expect(code.slice(11, 15)).toBe("X999");
  });

  it.each(["01234560009", "09876540007", STUDIO.vatNumber])("%s: partita IVA e CF numerico validi con ufficio 000", (code) => {
    expect(vatNumberProblem(code)).toBeNull();
    expect(fiscalCodeProblem(code)).toBeNull();
    expect(code.slice(7, 10)).toBe("000");
  });

  it.each(["IT80N0000001000000000123456", STUDIO.iban])("%s: IBAN valido con ABI 00000", (code) => {
    expect(ibanProblem(code)).toBeNull();
    expect(code.slice(5, 10)).toBe("00000");
  });

  it("rifiuta le cifre di controllo errate con il messaggio previsto", () => {
    expect(VAT_INVALID).toBe("La partita IVA non è valida: controlla le cifre");
    expect(TAX_CODE_INVALID).toBe("Il codice fiscale non è valido: controlla lettere e cifre.");
    expect(IBAN_INVALID).toBe("L'IBAN non è valido: controlla le cifre.");
    expect(vatNumberProblem("01234560008")).toBe(VAT_INVALID);
    expect(ibanProblem("IT81N0000001000000000123456")).toBe(IBAN_INVALID);
    expect(fiscalCodeProblem("12345678901")).toBe(TAX_CODE_INVALID);
    expect(fiscalCodeProblem("09876540007")).toBeNull();
  });

  it("CAP di cinque cifre e provincia di due lettere maiuscole", () => {
    expect(isPostalCode("00100")).toBe(true);
    expect(isPostalCode("1000")).toBe(false);
    expect(isPostalCode("001000")).toBe(false);
    expect(isPostalCode("00A00")).toBe(false);
    expect(isProvince("BO")).toBe(true);
    expect(isProvince("Bo")).toBe(false);
    expect(isProvince("BOL")).toBe(false);
    expect(isProvince("B1")).toBe(false);
  });
});
