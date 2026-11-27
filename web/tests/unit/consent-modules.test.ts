import { describe, expect, it } from "vitest";
import { CONSENT_MODULES, CONSENT_PLACEHOLDERS, CONSENT_VERSION } from "@/lib/consents/modules";
import * as modules from "@/lib/consents/modules";
import { renderConsent } from "@/lib/consents/render";
import type { ModuleKey } from "@/lib/consents/required";
import { ADULT_VALUES, SOFIA_VALUES } from "../support/consent-cases";

const MODULE_KEYS: ModuleKey[] = ["trattamento", "informativa", "trattamento_minore"];

describe("moduli di consenso demo", () => {
  it("compila_sofia_senza_vuoti", () => {
    const { text, missingFields } = renderConsent("trattamento_minore", SOFIA_VALUES);
    expect(missingFields).toEqual([]);
    expect(text).not.toContain("________");
    expect(text).toContain("Elena Rinaldi");
    expect(text).toContain("80,00");
    expect(text).toContain("55,00");
    expect(text).toContain("45,00");
    expect(text).toContain("1.000.000,00");
    expect(text).toContain("RC-0000-DEMO");
    expect(text).toContain("12/05/2020");
    expect(text).toContain("04/11/2026");
  });

  it("contiene_tutti_i_punti", () => {
    // Attesi fissi, indipendenti dal catalogo di produzione.
    const common = [
      "Professione sanitaria (L. 3/2018 art. 7; DPR 131/2021).",
      "Valuta con osservazione, palpazione e test.",
      "Usa solo tecniche manuali, non invasive ed esterne.",
      "Non fa diagnosi mediche, non prescrive farmaci né esami.",
      "Contatto fisico con le mani.",
      "manipolazioni ad alta velocità e bassa ampiezza (con avviso e richiesta di permesso prima di usarle)",
      "nessun risultato garantito.",
      "Dopo il trattamento circa una persona su due può avere disturbi lievi e passeggeri (indolenzimento, rigidità, mal di testa, stanchezza), di solito per uno o due giorni.",
      "Gli eventi gravi sono molto rari; dopo manipolazioni del collo sono descritte, molto raramente, lesioni delle arterie del collo: per questo prima di usarle l'osteopata valuta i fattori di rischio e chiede il permesso.",
      "Sintomi nuovi, forti o che peggiorano vanno segnalati subito.",
      "Alternative: non trattare, attendere, rivolgersi al medico o ad altri professionisti.",
      "non ci sono conseguenze sul rapporto con lo studio; se i sintomi persistono o peggiorano, l'indicazione è sentire il medico.",
      "gravidanza, terapia anticoagulante, osteoporosi, interventi o traumi recenti, malattie in corso, sintomi nuovi non spiegati.",
      "La valutazione di indicazione e controindicazione l'osteopata la registra in cartella.",
      "Dopo la valutazione l'osteopata spiega obiettivo e numero indicativo di sedute; il piano viene annotato in cartella e rivisto a ogni seduta.",
      "Prima visita 80,00", "seduta 55,00", "controllo 45,00",
      "Il compenso non dipende dall'esito.",
      "Polizza di responsabilità civile professionale Assicurazioni Esempio, n. RC-0000-DEMO, massimale 1.000.000,00",
      "Può fare domande in ogni momento; può rifiutare o revocare il consenso in qualsiasi momento, anche a seduta iniziata",
      "può chiedere di non ricevere alcune informazioni o indicare chi le riceva al suo posto",
    ];
    for (const key of ["trattamento", "trattamento_minore"] as const) {
      const { text } = renderConsent(key, key === "trattamento" ? ADULT_VALUES : SOFIA_VALUES);
      for (const sentence of common) expect(text).toContain(sentence);
    }
    const adult = renderConsent("trattamento", ADULT_VALUES).text;
    for (const sentence of [
      "Paziente: Marco Prova, nato/a a Verona il 01/01/1990, codice fiscale PRVMRC90A01X999S.",
      "Medico curante: Dott.ssa Ada Esempio.",
      "Io sottoscritto/a dichiaro di aver letto queste informazioni, di aver potuto fare domande e di aver ricevuto risposte chiare. Acconsento al trattamento osteopatico descritto.",
      "Firma del paziente. Firma dell'osteopata.",
    ]) expect(adult).toContain(sentence);
    const minor = renderConsent("trattamento_minore", SOFIA_VALUES).text;
    for (const sentence of [
      "Secondo genitore (facoltativo): nome e firma.",
      "Un genitore o il tutore resta presente per tutta la seduta",
      "tecniche adattate all'età; nei lattanti solo tecniche dolci",
      "L'osteopata ha spiegato al minore, in modo adatto alla sua età, che cosa si farà, e ha tenuto conto di ciò che pensa.",
      "Io sottoscritto/a dichiaro che l'altro genitore è informato e d'accordo, oppure che esercito da solo/a la responsabilità genitoriale.",
      "Io sottoscritto/a, in qualità di genitore o tutore, dichiaro di aver letto queste informazioni, di aver potuto fare domande e di aver ricevuto risposte chiare, e acconsento al trattamento osteopatico del minore descritto.",
    ]) expect(minor).toContain(sentence);
    const privacy = renderConsent("informativa", ADULT_VALUES).text;
    for (const sentence of [
      "Responsabile della protezione dei dati: non nominato, non obbligatorio per il singolo professionista",
      "Anagrafici e di contatto; relativi alla salute (anamnesi, valutazioni, trattamenti, foto posturali); per la fattura.",
      "Valutazione, trattamento, cartella: art. 9 par. 2 lett. h e par. 3 GDPR, da un professionista sanitario tenuto al segreto, senza consenso.",
      "Fatture: obbligo di legge (art. 6 par. 1 lett. c).",
      "Appuntamenti e promemoria organizzativi per telefono o SMS: esecuzione della prestazione (art. 6 par. 1 lett. b)",
      "Facoltativi, solo con consenso: ogni messaggio via WhatsApp (promemoria compresi); richiami per i controlli periodici.",
      "Senza dati sanitari non si valuta né si tratta; senza dati fiscali non si emette la fattura.",
      "Commercialista o CAF; Agenzia delle Entrate tramite SdI per la fattura elettronica; medico curante o specialista solo in caso di invio, con l'accordo dell'interessato; autorità quando la legge lo impone.",
      "Lo studio non trasferisce dati fuori dall'UE; se l'interessato sceglie WhatsApp, il servizio è regolato dalle condizioni di WhatsApp",
      "Documentazione clinica: 10 anni dall'ultima prestazione. Fatture: 10 anni",
      "Dati per i richiami: fino alla revoca.",
      "Accesso, rettifica, cancellazione (salvo obblighi di conservazione), limitazione, opposizione, portabilità; revoca dei consensi facoltativi in ogni momento senza effetti sul passato; reclamo al Garante, www.garanteprivacy.it.",
      "Decisioni automatizzate. Nessuna.",
      "Io sottoscritto/a dichiaro di aver ricevuto e letto l'informativa.",
      'due scelte separate, non preselezionate, con "Sì" e "No"',
      "Acconsento a ricevere promemoria e comunicazioni organizzative su WhatsApp.",
      "Acconsento a essere ricontattato/a per i controlli periodici.",
    ]) expect(privacy).toContain(sentence);
    expect(CONSENT_VERSION).toBe("2026.1");
    expect(CONSENT_PLACEHOLDERS).toHaveLength(25);
    // Lista scritta a mano, indipendente dai valori della fixture.
    expect([...CONSENT_PLACEHOLDERS]).toEqual([
      "studio.nome", "studio.indirizzo", "studio.telefono", "studio.email", "studio.pec",
      "osteopata.nome_completo", "osteopata.iscrizione", "polizza.compagnia", "polizza.numero", "polizza.massimale",
      "paziente.nome_completo", "paziente.data_nascita", "paziente.luogo_nascita", "paziente.codice_fiscale",
      "paziente.indirizzo", "paziente.medico_curante", "paziente.medico_inviante", "genitore.nome_completo",
      "genitore.codice_fiscale", "listino.prima_visita", "listino.seduta", "listino.controllo",
      "conservazione.anni", "documento.data", "documento.luogo",
    ]);
    for (const key of MODULE_KEYS) {
      expect(CONSENT_MODULES[key].version).toBe("2026.1");
      expect(CONSENT_MODULES[key].requiresResign).toBe(false);
      expect(renderConsent(key, SOFIA_VALUES).text).toContain("Testo di esempio, da far verificare prima dell'uso con pazienti reali.");
    }
  });

  it("versione_richiede_firma", () => {
    const catalog = { ...CONSENT_MODULES, informativa: { ...CONSENT_MODULES.informativa, version: "2026.2", requiresResign: true } };
    expect(modules.isCurrentVersion("informativa", "2026.1", catalog)).toBe(false);
    expect(modules.isCurrentVersion("informativa", "2026.2", catalog)).toBe(true);
    catalog.informativa.requiresResign = false;
    expect(modules.isCurrentVersion("informativa", "2026.1", catalog)).toBe(true);
  });

  it("minore_riferito_al_bambino_e_alle_decisioni_del_genitore", () => {
    const text = renderConsent("trattamento_minore", SOFIA_VALUES).text;
    expect(text).toContain("Se il genitore o il tutore rifiuta il trattamento non ci sono conseguenze sul rapporto con lo studio;");
    expect(text).toContain("Il genitore o il tutore segnala gravidanza, terapia anticoagulante, osteoporosi, interventi o traumi recenti, malattie in corso, sintomi nuovi non spiegati.");
    expect(text).not.toMatch(/paziente/i);
    // I nomi dei segnaposto restano quelli previsti.
    expect(CONSENT_MODULES.trattamento_minore.body.replace(/\{[^{}]+\}/g, "")).not.toMatch(/paziente/i);
  });

  it.each(["abc", "80,50", "80.5", "Infinity", "9007199254740992", "-500"])("importo_malformato_mancante: %s", (value) => {
    const result = renderConsent("trattamento", { ...ADULT_VALUES, "listino.prima_visita": value });
    expect(result.text).toContain("Prima visita ________,");
    expect(result.missingFields).toEqual(["listino.prima_visita"]);
  });

  it("mancanti_non_inventati", () => {
    const result = renderConsent("trattamento", {
      ...ADULT_VALUES, "polizza.numero": null, "paziente.codice_fiscale": null,
      "paziente.medico_inviante": null, "studio.pec": null, "genitore.nome_completo": null,
    });
    expect(result.missingFields.sort()).toEqual(["paziente.codice_fiscale", "polizza.numero"]);
    expect(result.text.match(/________/g)).toHaveLength(2);
    expect(result.text).toContain("Medico inviante: accesso diretto.");
    expect(result.text).not.toContain('oppure "accesso diretto"');
    const privacy = renderConsent("informativa", { ...ADULT_VALUES, "studio.pec": null, "polizza.numero": null });
    expect(privacy.text).toContain("non indicata");
    expect(privacy.missingFields).toEqual([]);
    const doctor = renderConsent("trattamento", {
      ...ADULT_VALUES, "paziente.medico_curante": "   ", "paziente.medico_inviante": "", "studio.pec": "",
    });
    expect(doctor.missingFields).toEqual(["paziente.medico_curante"]);
    expect(doctor.text).toContain("Medico curante: ________.");
    // Chiavi assenti e ripetute: non inventare e segnalare una sola volta.
    expect(renderConsent("informativa", {}).missingFields).toEqual([
      "studio.nome", "osteopata.nome_completo", "studio.indirizzo", "studio.email", "studio.telefono", "conservazione.anni",
    ]);
  });

  it("nessun_dato_del_ciclo", () => {
    for (const key of MODULE_KEYS) {
      const { text, missingFields } = renderConsent(key, SOFIA_VALUES);
      expect(missingFields).toEqual([]);
      expect(text).not.toMatch(/\{.*\}|sedute previste/);
      expect(text).not.toContain("\u2014");
      expect(text).not.toMatch(/APP_NAME|Tensegra/);
    }
    const literal = renderConsent("trattamento", { ...ADULT_VALUES, "studio.nome": "Studio {polizza.numero} $&" });
    expect(literal.text).toContain("Studio: Studio {polizza.numero} $&,");
    expect(literal.missingFields).toEqual([]);
  });
});
