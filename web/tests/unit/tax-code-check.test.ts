import { describe, expect, it } from "vitest";
import { checkTaxCode } from "@/lib/patients/tax-code";
import { PatientGroupInput } from "@/server/domain/patients/schemas";

// `checkTaxCode` è il controllo dei moduli prima di mandare il gruppo: deve dire sì e no come lo schema del
// comando, con lo stesso messaggio, senza chiedere al server.

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const VALID = "FRRGLI84C49X999B";
const NOT_VALID = "Il codice fiscale non è valido: controlla lettere e cifre.";

/** Il messaggio dello schema sul campo `taxCode`, o null se lo accetta. */
function schemaProblem(taxCode: string): string | null {
  const parsed = PatientGroupInput.safeParse({
    group: "personali",
    patientId: PATIENT_ID,
    firstName: "Giulia",
    lastName: "Ferrari",
    birthDate: "1984-03-09",
    sex: "f",
    birthPlace: "",
    taxCode,
  });
  if (parsed.success) return null;
  const issue = parsed.error.issues.find((i) => i.path.join(".") === "taxCode");
  return issue?.message ?? null;
}

describe("checkTaxCode", () => {
  it("un codice scritto bene, con minuscole e spazi, passa", () => {
    expect(checkTaxCode(VALID)).toBeNull();
    expect(checkTaxCode(` ${VALID.toLowerCase().slice(0, 8)} ${VALID.toLowerCase().slice(8)} `)).toBeNull();
  });

  it("il campo vuoto o di soli spazi passa: il codice serve per fatturare, non per salvare", () => {
    expect(checkTaxCode("")).toBeNull();
    expect(checkTaxCode("   ")).toBeNull();
  });

  it("carattere di controllo sbagliato, lunghezza e struttura sbagliate: il messaggio del campo", () => {
    expect(checkTaxCode("AAAAAA00A00A000A")).toBe(NOT_VALID);
    expect(checkTaxCode("FRRGLI84C49X999A")).toBe(NOT_VALID);
    expect(checkTaxCode("FRRGLI84C49X999")).toBe(NOT_VALID);
    expect(checkTaxCode("1234567890123456")).toBe(NOT_VALID);
  });

  it("dà lo stesso esito e lo stesso testo dello schema del comando", () => {
    const inputs = [
      VALID,
      VALID.toLowerCase(),
      ` ${VALID.slice(0, 6)} ${VALID.slice(6)} `,
      "",
      "   ",
      "AAAAAA00A00A000A",
      "FRRGLI84C49X999A",
      "FRRGLI84C49X999",
      "RSSMRA80A01H50ZM",
      "1234567890123456",
    ];
    for (const input of inputs) expect(checkTaxCode(input), JSON.stringify(input)).toBe(schemaProblem(input));
  });
});
