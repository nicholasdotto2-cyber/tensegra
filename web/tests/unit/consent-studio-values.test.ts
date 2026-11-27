import { describe, expect, it } from "vitest";
import { renderConsentBody } from "@/lib/consents/render";
import { type StudioConsentSettings, studioConsentValues } from "@/lib/consents/studio-values";
import { DEFAULT_SERVICES } from "@/server/domain/services/commands";
import { STUDIO } from "../../seed/people";

// L'iscrizione nei moduli (esempio di {osteopata.iscrizione}): il campo dell'ordine contiene il nome
// intero ("Ordine TSRM PSTRP di Bologna"), quindi la frase non ripete «Ordine» né aggiunge la provincia.

const SETTINGS: StudioConsentSettings = {
  practiceName: STUDIO.practiceName, addressLine: STUDIO.address.line, postalCode: STUDIO.address.postalCode,
  city: STUDIO.address.city, province: STUDIO.address.province, phone: "+390510000000", email: STUDIO.email, pec: null,
  practitionerFirstName: STUDIO.practitionerFirstName, practitionerLastName: STUDIO.practitionerLastName,
  registrationKind: STUDIO.registration.kind, registrationOrder: STUDIO.registration.order,
  registrationNumber: STUDIO.registration.number, registrationProvince: STUDIO.registration.province,
  insuranceCompany: STUDIO.insurance.company, insurancePolicyNumber: STUDIO.insurance.policyNumber,
  insuranceLimitCents: STUDIO.insurance.limitEuros * 100,
};

const iscrizione = (settings: StudioConsentSettings) => studioConsentValues(settings, DEFAULT_SERVICES, "2026-11-04")["osteopata.iscrizione"];

describe("iscrizione dell'osteopata nei moduli", () => {
  it("elenco speciale con i valori del seed: la frase del modulo", () => {
    expect(iscrizione(SETTINGS)).toBe("iscrizione all'elenco speciale ad esaurimento degli osteopati presso l'Ordine TSRM PSTRP di Bologna, n. 0000");
    const body = renderConsentBody("trattamento", studioConsentValues(SETTINGS, DEFAULT_SERVICES, "2026-11-04")).text;
    expect(body).toContain("Osteopata: Laura Benedetti, iscrizione all'elenco speciale ad esaurimento degli osteopati presso l'Ordine TSRM PSTRP di Bologna, n. 0000. Studio: ");
    expect(body).not.toContain("Ordine Ordine");
    expect(body).not.toContain("di BO");
  });

  it("albo: stesso ordine e numero, senza la provincia", () => {
    expect(iscrizione({ ...SETTINGS, registrationKind: "albo" })).toBe("iscrizione all'albo presso l'Ordine TSRM PSTRP di Bologna, n. 0000");
    // La provincia non entra nella frase: senza, la riga c'è lo stesso.
    expect(iscrizione({ ...SETTINGS, registrationProvince: null })).toBe("iscrizione all'elenco speciale ad esaurimento degli osteopati presso l'Ordine TSRM PSTRP di Bologna, n. 0000");
  });

  it("senza ordine o numero l'iscrizione manca; in attesa e nessuna restano come prima", () => {
    expect(iscrizione({ ...SETTINGS, registrationOrder: null })).toBeNull();
    expect(iscrizione({ ...SETTINGS, registrationNumber: null })).toBeNull();
    expect(iscrizione({ ...SETTINGS, registrationKind: "in_attesa" })).toBe("in attesa di iscrizione");
    expect(iscrizione({ ...SETTINGS, registrationKind: "nessuna" })).toBe("nessuna iscrizione");
  });
});
