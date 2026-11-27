import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, templateProblem, type TemplateKey } from "@/lib/messages/templates";
import { missingMessage, renderMessage } from "@/lib/messages/render";

// Fixture letterali dei modelli, indipendenti dal catalogo applicativo.
const literal = {
  conferma: {
    tu: "Ciao {nome}, ti confermo l'appuntamento{per_paziente} di {quando} alle {ora}, in {indirizzo}. Se hai un imprevisto, scrivimi pure qui. {osteopata}, {studio}",
    lei: "Buongiorno {nome}, le confermo l'appuntamento{per_paziente} di {quando} alle {ora}, in {indirizzo}. Per qualsiasi imprevisto può scrivermi a questo numero. {osteopata}, {studio}",
  },
  promemoria: {
    tu: "Ciao {nome}, ti ricordo l'appuntamento{per_paziente} di {quando} alle {ora}, in {indirizzo}. Se non riesci a venire, avvisami qui: così posso dare l'orario a qualcun altro. A presto. {osteopata}, {studio}",
    lei: "Buongiorno {nome}, le ricordo l'appuntamento{per_paziente} di {quando} alle {ora}, in {indirizzo}. Se non potesse venire, mi avvisi qui: potrò offrire l'orario a un'altra persona. Cordiali saluti. {osteopata}, {studio}",
  },
  spostamento: {
    tu: "Ciao {nome}, ho spostato l'appuntamento{per_paziente}: ti aspetto {quando} alle {ora}, in {indirizzo}. Se il nuovo orario non va bene, scrivimi. {osteopata}, {studio}",
    lei: "Buongiorno {nome}, l'appuntamento{per_paziente} è stato spostato a {quando} alle {ora}, in {indirizzo}. Se il nuovo orario non le fosse comodo, mi scriva pure. {osteopata}, {studio}",
  },
  richiamo: {
    tu: "Ciao {nome}, sono {osteopata}. Sono passate {settimane} settimane dall'ultima seduta{di_paziente}: se ti va, fissiamo un controllo. Scrivimi quando ti è comodo e ti propongo un orario. {studio}",
    lei: "Buongiorno {nome}, sono {osteopata}. Sono trascorse {settimane} settimane dall'ultima seduta{di_paziente}: se lo desidera, possiamo fissare un controllo. Mi scriva quando le è comodo e le propongo un orario. {studio}",
  },
  consigli: {
    tu: "Ciao {nome}, come promesso ecco i consigli di oggi: {consigli} Se nei prossimi giorni noti qualcosa di insolito, scrivimi. {osteopata}, {studio}",
    lei: "Buongiorno {nome}, come d'accordo le riporto i consigli di oggi: {consigli} Se nei prossimi giorni nota qualcosa di insolito, mi scriva. {osteopata}, {studio}",
  },
};

describe("modelli messaggi", () => {
  it("dieci_testi_letterali", () => {
    expect(DEFAULT_TEMPLATES).toEqual(literal);
    for (const [key, variants] of Object.entries(literal)) {
      for (const body of Object.values(variants)) {
        expect(templateProblem(key as TemplateKey, body)).toBeNull();
        if (key !== "consigli") expect(body).not.toMatch(/\{consigli\}|dolore|diagnosi|lombalgia|patologia/i);
      }
    }
  });

  it("segnaposti", () => {
    for (const key of ["nme", "consigli", "settimane"]) {
      expect(templateProblem("conferma", `{${key}}`)).toBe(`Segnaposto non riconosciuto: {${key}}.`);
    }
    for (const body of ["{nome", "nome}", "{{nome}}", "{}", "{nome}}{"]) expect(templateProblem("conferma", body)).not.toBeNull();
    expect(templateProblem("conferma", "a".repeat(700))).toBeNull();
    expect(templateProblem("conferma", "a".repeat(701))).not.toBeNull();
    expect(templateProblem("conferma", "   ")).not.toBeNull();
    expect(templateProblem("consigli", "{quando}")).toBe("Segnaposto non riconosciuto: {quando}.");
    expect(templateProblem("richiamo", "{consigli}")).toBe("Segnaposto non riconosciuto: {consigli}.");
  });

  it("limite_code_points", () => {
    expect(templateProblem("conferma", "\u{1D11E}".repeat(700))).toBeNull();
    expect(templateProblem("conferma", "\u{1D11E}".repeat(701))).not.toBeNull();
  });

  it("mancanti_vuoti_senza_segnaposti_residui", () => {
    expect(renderMessage("conferma", "{nome}{per_paziente}: {indirizzo}, {indirizzo}", { nome: "Chiara", per_paziente: "", indirizzo: null }))
      .toEqual({ text: "Chiara: , ", missing: ["indirizzo"] });
    expect(renderMessage("richiamo", "{di_paziente}", { di_paziente: "" })).toEqual({ text: "", missing: [] });
    expect(renderMessage("consigli", "{consigli}", { consigli: "Testo {nome} & $&" }).text).toBe("Testo {nome} & $&");
  });

  it.each([
    ["indirizzo", "Manca l'indirizzo dello studio", "/impostazioni/studio"],
    ["studio", "Manca il nome dello studio", "/impostazioni/studio"],
    ["telefono_studio", "Manca il telefono dello studio", "/impostazioni/studio"],
    ["osteopata", "Manca il nome dell'osteopata", "/impostazioni/studio"],
    ["nome", "Manca il nome del destinatario", "/pazienti/paziente-autorizzato?tab=anagrafica"],
    ["quando", "Manca la data dell'appuntamento", "/agenda"],
    ["ora", "Manca l'ora dell'appuntamento", "/agenda"],
    // Le altre cinque chiavi: l'ultima seduta e i consigli si correggono nella scheda.
    ["durata", "Manca la durata dell'appuntamento", "/agenda"],
    ["settimane", "Manca la data dell'ultima seduta", "/pazienti/paziente-autorizzato?tab=appuntamenti"],
    ["consigli", "Mancano i consigli della visita", "/pazienti/paziente-autorizzato?tab=cartella"],
    ["per_paziente", "Manca il nome del paziente", "/pazienti/paziente-autorizzato?tab=anagrafica"],
    ["di_paziente", "Manca il nome del paziente", "/pazienti/paziente-autorizzato?tab=anagrafica"],
    // Non è un segnaposto: il link di un modello salvato che non si compila.
    ["modello", "Correggi il modello in Impostazioni, Messaggi", "/impostazioni/messaggi"],
  ])("mancanti_messaggi: %s", (key, message, href) => {
    expect(missingMessage(key!, "paziente-autorizzato")).toEqual({ key, message, href });
  });
});
