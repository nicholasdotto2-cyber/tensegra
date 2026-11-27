import { describe, expect, it } from "vitest";
import { taxCode } from "../../seed/codes";
import { PATIENTS, STUDIO, taxCodeOf } from "../../seed/people";

// Codici fiscali e cellulari del seed: algoritmo standard con il codice comune X999,
// che non è di nessun comune né stato estero; cellulari "+39 3xx 000 00NN". Le date di nascita dipendono
// da D0, quindi i codici si controllano su più giorni.

const D0S = ["2026-11-04", "2026-10-25", "2027-01-13"];

const CODE = /^[A-Z0-9]{16}$/;
const MOBILE = /^\+393\d{2}00000\d{2}$/;

describe("taxCode", () => {
  it("l'algoritmo standard: cognome, nome, data, sesso, comune e carattere di controllo", () => {
    expect(taxCode({ lastName: "Rossi", firstName: "Mario", birthDate: "1980-01-01", sex: "m", comune: "H501" })).toBe(
      "RSSMRA80A01H501U",
    );
    expect(
      taxCode({ lastName: "Bellandi", firstName: "Marco", birthDate: "1979-03-09", sex: "m", comune: "X999" }),
    ).toBe("BLLMRC79C09X999H");
    expect(
      taxCode({ lastName: "Benedetti", firstName: "Laura", birthDate: "1985-05-20", sex: "f", comune: "X999" }),
    ).toBe("BNDLRA85E60X999X");
  });

  it("l'osteopata dello studio ha il codice con X999", () => {
    expect(STUDIO.practitionerTaxCode).toBe("BNDLRA85E60X999X");
  });
});

describe("codici fiscali dei pazienti e dei genitori", () => {
  it.each(D0S)("con D0 %s hanno X999 nelle posizioni 12-15", (d0) => {
    const people = PATIENTS.flatMap((p) => (p.contactGuardian ? [p, p.contactGuardian] : [p]));
    const codes = people.map((p) => ({ name: `${p.firstName} ${p.lastName}`, code: taxCodeOf(p, d0) }));
    for (const { name, code } of codes) {
      if (name === "Elisa Fontana") continue;
      expect(code, name).toMatch(CODE);
      expect(code?.slice(11, 15), name).toBe("X999");
    }
    expect(codes.length).toBe(15 + 3);
  });

  it("nessun codice per Elisa Fontana, uno per ogni altro paziente", () => {
    const without = PATIENTS.filter((p) => taxCodeOf(p, "2026-11-04") === null).map((p) => `${p.firstName} ${p.lastName}`);
    expect(without).toEqual(["Elisa Fontana"]);
  });
});

describe("cellulari", () => {
  it("ogni cellulare di pazienti e genitori è +39 3xx 000 00NN", () => {
    const phones = PATIENTS.flatMap((p) => [p.phone, p.contactGuardian?.phone, p.secondGuardian?.phone]).filter(
      (phone): phone is string => typeof phone === "string",
    );
    expect(phones.length).toBeGreaterThan(0);
    for (const phone of phones) expect(phone).toMatch(MOBILE);
    expect(new Set(phones).size).toBe(phones.length);
  });
});
