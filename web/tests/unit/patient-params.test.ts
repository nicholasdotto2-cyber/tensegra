import { describe, expect, it } from "vitest";
import {
  PATIENT_FILTERS,
  parsePatientListParams,
  parsePatientTabParams,
  patientHref,
} from "@/lib/patients/params";

// I parametri dell'URL della lista e della scheda: un valore non
// valido torna al predefinito, mai un errore.

describe("parsePatientListParams", () => {
  it("senza parametri dà i predefiniti", () => {
    expect(parsePatientListParams({})).toEqual({ q: "", filtro: "tutti", ordina: "paziente", verso: "asc" });
  });

  it("ignora i valori non validi", () => {
    expect(parsePatientListParams({ filtro: "boh", verso: "su", ordina: "eta" })).toEqual({
      q: "",
      filtro: "tutti",
      ordina: "paziente",
      verso: "asc",
    });
  });

  it("rilegge i valori validi; di un parametro ripetuto vale il primo", () => {
    expect(
      parsePatientListParams({ q: ["ross", "bianchi"], filtro: "archiviati", ordina: "prossimo", verso: "desc" }),
    ).toEqual({ q: "ross", filtro: "archiviati", ordina: "prossimo", verso: "desc" });
  });
});

describe("PATIENT_FILTERS", () => {
  it("ha i sei filtri nel loro ordine", () => {
    expect(PATIENT_FILTERS).toEqual([
      { code: "tutti", label: "Tutti" },
      { code: "in_ciclo", label: "In ciclo" },
      { code: "da_richiamare", label: "Da richiamare" },
      { code: "consensi_mancanti", label: "Consensi mancanti" },
      { code: "senza_prossimo_passo", label: "Senza prossimo passo" },
      { code: "archiviati", label: "Archiviati" },
    ]);
  });
});

describe("parsePatientTabParams", () => {
  it("senza parametri dà Riepilogo e Cronologia", () => {
    expect(parsePatientTabParams({})).toEqual({ tab: "riepilogo", vista: "cronologia", ciclo: null, regione: null });
  });

  it("rilegge tab, vista, regione e ciclo validi", () => {
    const ciclo = "a0000000-0000-4000-8000-000000000401";
    expect(parsePatientTabParams({ tab: "cartella", vista: "test", regione: "lumbar", ciclo })).toEqual({
      tab: "cartella",
      vista: "test",
      ciclo,
      regione: "lumbar",
    });
  });

  it("accetta la tab Fatture", () => {
    expect(parsePatientTabParams({ tab: "fatture" }).tab).toBe("fatture");
    expect(patientHref("x", { tab: "fatture" })).toBe("/pazienti/x?tab=fatture");
  });

  it("un valore sconosciuto torna al predefinito", () => {
    expect(parsePatientTabParams({ tab: "sconosciuto", vista: "boh", regione: "naso", ciclo: "abc" })).toEqual({
      tab: "riepilogo",
      vista: "cronologia",
      ciclo: null,
      regione: null,
    });
  });

  it("parse_tab_messaggi", () => {
    expect(parsePatientTabParams({ tab: "messaggi" }).tab).toBe("messaggi");
    expect(patientHref("x", { tab: "messaggi" })).toBe("/pazienti/x?tab=messaggi");
    expect(parsePatientTabParams({ tab: "sconosciuto" }).tab).toBe("riepilogo");
  });
});

describe("patientHref", () => {
  it("costruisce il link con tab e vista", () => {
    expect(patientHref("x", { tab: "cartella", vista: "test" })).toBe("/pazienti/x?tab=cartella&vista=test");
  });

  it("porta anche i filtri «Ciclo» e «Regione» dei test nel tempo, dopo la vista", () => {
    expect(patientHref("x", { tab: "cartella", vista: "test", ciclo: "c1", regione: "lumbar" })).toBe(
      "/pazienti/x?tab=cartella&vista=test&ciclo=c1&regione=lumbar",
    );
    expect(patientHref("x", { tab: "cartella", vista: "test", regione: "head" })).toBe(
      "/pazienti/x?tab=cartella&vista=test&regione=head",
    );
    // Un filtro vuoto non si scrive.
    expect(patientHref("x", { tab: "cartella", vista: "test", ciclo: null, regione: null })).toBe(
      "/pazienti/x?tab=cartella&vista=test",
    );
  });

  it("senza parametri, o con i predefiniti, è la scheda", () => {
    expect(patientHref("x")).toBe("/pazienti/x");
    expect(patientHref("x", { tab: "riepilogo" })).toBe("/pazienti/x");
    expect(patientHref("x", { tab: "cartella", vista: "cronologia" })).toBe("/pazienti/x?tab=cartella");
  });
});
