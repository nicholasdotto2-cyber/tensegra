import type { ModuleKey } from "./required";

export const CONSENT_VERSION = "2026.1";

// Chiavi senza delimitatori, come in ConsentValues e missingFields.
export const CONSENT_PLACEHOLDERS: readonly string[] = Object.freeze([
  "studio.nome", "studio.indirizzo", "studio.telefono", "studio.email", "studio.pec",
  "osteopata.nome_completo", "osteopata.iscrizione",
  "polizza.compagnia", "polizza.numero", "polizza.massimale",
  "paziente.nome_completo", "paziente.data_nascita", "paziente.luogo_nascita",
  "paziente.codice_fiscale", "paziente.indirizzo", "paziente.medico_curante", "paziente.medico_inviante",
  "genitore.nome_completo", "genitore.codice_fiscale",
  "listino.prima_visita", "listino.seduta", "listino.controllo",
  "conservazione.anni", "documento.data", "documento.luogo",
]);

// Le frasi dei moduli, senza tag editoriali e fonti esterne. I riferimenti
// normativi nelle frasi restano. I rinvii riusano gli stessi testi.
const treatment = {
  identity: "Paziente: {paziente.nome_completo}, nato/a a {paziente.luogo_nascita} il {paziente.data_nascita}, codice fiscale {paziente.codice_fiscale}. Osteopata: {osteopata.nome_completo}, {osteopata.iscrizione}. Studio: {studio.nome}, {studio.indirizzo}. Medico curante: {paziente.medico_curante}. Medico inviante: {paziente.medico_inviante}.",
  profession: "Professione sanitaria (L. 3/2018 art. 7; DPR 131/2021). Valuta con osservazione, palpazione e test. Usa solo tecniche manuali, non invasive ed esterne. Non fa diagnosi mediche, non prescrive farmaci né esami. Se ciò che emerge non è di sua competenza, indirizza il paziente al medico.",
  session: "Contatto fisico con le mani. Al paziente può essere chiesto di togliere alcuni indumenti: può tenerli o farsi accompagnare. Tecniche possibili: tessuti molli, articolatorie, energia muscolare, manipolazioni ad alta velocità e bassa ampiezza (con avviso e richiesta di permesso prima di usarle), craniali, viscerali, fasciali.",
  risks: "Benefici attesi rispetto al problema per cui il paziente si rivolge allo studio; nessun risultato garantito. Dopo il trattamento circa una persona su due può avere disturbi lievi e passeggeri (indolenzimento, rigidità, mal di testa, stanchezza), di solito per uno o due giorni. Gli eventi gravi sono molto rari; dopo manipolazioni del collo sono descritte, molto raramente, lesioni delle arterie del collo: per questo prima di usarle l'osteopata valuta i fattori di rischio e chiede il permesso. Sintomi nuovi, forti o che peggiorano vanno segnalati subito.",
  alternatives: "Alternative: non trattare, attendere, rivolgersi al medico o ad altri professionisti. Se il paziente rifiuta il trattamento non ci sono conseguenze sul rapporto con lo studio; se i sintomi persistono o peggiorano, l'indicazione è sentire il medico.",
  conditions: "Il paziente segnala gravidanza, terapia anticoagulante, osteoporosi, interventi o traumi recenti, malattie in corso, sintomi nuovi non spiegati. La valutazione di indicazione e controindicazione l'osteopata la registra in cartella.",
  plan: "Dopo la valutazione l'osteopata spiega obiettivo e numero indicativo di sedute; il piano viene annotato in cartella e rivisto a ogni seduta.",
  fees: "Prima visita {listino.prima_visita}, seduta {listino.seduta}, controllo {listino.controllo}. Il compenso non dipende dall'esito.",
  insurance: "Polizza di responsabilità civile professionale {polizza.compagnia}, n. {polizza.numero}, massimale {polizza.massimale} (L. 24/2017 art. 10; DPR 137/2012 art. 5).",
  rights: "Può fare domande in ogni momento; può rifiutare o revocare il consenso in qualsiasi momento, anche a seduta iniziata (L. 219/2017 art. 1 c. 5); può chiedere di non ricevere alcune informazioni o indicare chi le riceva al suo posto (art. 1 c. 3).",
};

function forMinor(paragraph: string): string {
  return paragraph
    .replaceAll("Se il paziente rifiuta", "Se il genitore o il tutore rifiuta")
    .replaceAll("Il paziente segnala", "Il genitore o il tutore segnala")
    .replaceAll("il paziente", "il minore")
    .replaceAll("Il paziente", "Il minore").replaceAll("Al paziente", "Al minore");
}

interface ConsentModule {
  title: string;
  version: string;
  requiresResign: boolean;
  body: string;
}

// Catalogo demo non modificabile. La versione iniziale
// non impone una rifirma; le versioni successive lo dichiareranno esplicitamente.
export const CONSENT_MODULES: Readonly<Record<ModuleKey, Readonly<ConsentModule>>> = Object.freeze({
  trattamento: Object.freeze({
    title: "Consenso informato al trattamento osteopatico",
    version: CONSENT_VERSION,
    requiresResign: false,
    body: [
      `1. Chi firma e chi tratta. ${treatment.identity}`,
      `2. Che cosa fa l'osteopata. ${treatment.profession}`,
      `3. Come si svolge la seduta. ${treatment.session}`,
      `4. Benefici, rischi e reazioni. ${treatment.risks}`,
      `5. Alternative e rifiuto. ${treatment.alternatives}`,
      `6. Cosa segnalare all'osteopata. ${treatment.conditions}`,
      `7. Piano. ${treatment.plan}`,
      `8. Compenso. ${treatment.fees}`,
      `9. Assicurazione. ${treatment.insurance}`,
      `10. Diritti del paziente. ${treatment.rights}`,
      '11. Dichiarazione. "Io sottoscritto/a dichiaro di aver letto queste informazioni, di aver potuto fare domande e di aver ricevuto risposte chiare. Acconsento al trattamento osteopatico descritto." {documento.data}, {documento.luogo}. Firma del paziente. Firma dell\'osteopata.',
    ].join("\n\n"),
  }),
  informativa: Object.freeze({
    title: "Informativa sul trattamento dei dati personali (art. 13 del Regolamento UE 2016/679)",
    version: CONSENT_VERSION,
    requiresResign: false,
    body: [
      "1. Titolare. {studio.nome}, {osteopata.nome_completo}, {studio.indirizzo}, {studio.email}, {studio.pec}, {studio.telefono}. Responsabile della protezione dei dati: non nominato, non obbligatorio per il singolo professionista.",
      "2. Quali dati. Anagrafici e di contatto; relativi alla salute (anamnesi, valutazioni, trattamenti, foto posturali); per la fattura.",
      "3. Perché e su quale base. Valutazione, trattamento, cartella: art. 9 par. 2 lett. h e par. 3 GDPR, da un professionista sanitario tenuto al segreto, senza consenso. Fatture: obbligo di legge (art. 6 par. 1 lett. c). Appuntamenti e promemoria organizzativi per telefono o SMS: esecuzione della prestazione (art. 6 par. 1 lett. b). Facoltativi, solo con consenso: ogni messaggio via WhatsApp (promemoria compresi); richiami per i controlli periodici.",
      "4. Obbligo di dare i dati. Senza dati sanitari non si valuta né si tratta; senza dati fiscali non si emette la fattura.",
      "5. A chi vanno. Commercialista o CAF; Agenzia delle Entrate tramite SdI per la fattura elettronica; medico curante o specialista solo in caso di invio, con l'accordo dell'interessato; autorità quando la legge lo impone.",
      "6. Fuori dall'UE. Lo studio non trasferisce dati fuori dall'UE; se l'interessato sceglie WhatsApp, il servizio è regolato dalle condizioni di WhatsApp.",
      "7. Per quanto tempo. Documentazione clinica: {conservazione.anni} anni dall'ultima prestazione. Fatture: 10 anni. Dati per i richiami: fino alla revoca.",
      "8. Diritti. Accesso, rettifica, cancellazione (salvo obblighi di conservazione), limitazione, opposizione, portabilità; revoca dei consensi facoltativi in ogni momento senza effetti sul passato; reclamo al Garante, www.garanteprivacy.it.",
      "9. Decisioni automatizzate. Nessuna.",
      '10. Presa visione e consensi facoltativi. "Io sottoscritto/a dichiaro di aver ricevuto e letto l\'informativa." Poi due scelte separate, non preselezionate, con "Sì" e "No": "Acconsento a ricevere promemoria e comunicazioni organizzative su WhatsApp." / "Acconsento a essere ricontattato/a per i controlli periodici."',
    ].join("\n\n"),
  }),
  trattamento_minore: Object.freeze({
    title: "Consenso informato al trattamento osteopatico di persona minore",
    version: CONSENT_VERSION,
    requiresResign: false,
    body: [
      "1. Chi è il minore e chi firma. Minore: {paziente.nome_completo}, nato/a il {paziente.data_nascita}. Firmatario: {genitore.nome_completo}, codice fiscale {genitore.codice_fiscale}, in qualità di genitore o tutore. Secondo genitore (facoltativo): nome e firma.",
      `2. Che cosa fa l'osteopata. ${forMinor(treatment.profession)}`,
      `3. Come si svolge la seduta. ${forMinor(treatment.session)} Un genitore o il tutore resta presente per tutta la seduta; tecniche adattate all'età; nei lattanti solo tecniche dolci.`,
      `4. Benefici, rischi, alternative e cosa segnalare. ${forMinor(treatment.risks)} ${forMinor(treatment.alternatives)} ${forMinor(treatment.conditions)}`,
      `5. Piano, compenso, assicurazione. ${treatment.plan} ${treatment.fees} ${treatment.insurance}`,
      '6. La voce del minore. "L\'osteopata ha spiegato al minore, in modo adatto alla sua età, che cosa si farà, e ha tenuto conto di ciò che pensa." Campo note. Sotto i 6 anni "Non applicabile per l\'età", modificabile.',
      `7. Diritti, esercitati dal genitore o tutore. ${treatment.rights}`,
      '8. Dichiarazione sull\'altro genitore (se firma uno solo). "Io sottoscritto/a dichiaro che l\'altro genitore è informato e d\'accordo, oppure che esercito da solo/a la responsabilità genitoriale."',
      '9. Dichiarazione e firme. "Io sottoscritto/a, in qualità di genitore o tutore, dichiaro di aver letto queste informazioni, di aver potuto fare domande e di aver ricevuto risposte chiare, e acconsento al trattamento osteopatico del minore descritto." {documento.data}, {documento.luogo}, firma del genitore o tutore, eventuale secondo genitore, firma dell\'osteopata.',
    ].join("\n\n"),
  }),
});

/** Nessuna scadenza implicita: è il catalogo a richiedere una nuova firma. */
export function isCurrentVersion(moduleKey: ModuleKey, version: string, catalog = CONSENT_MODULES): boolean {
  const entry = catalog[moduleKey];
  return !entry.requiresResign || entry.version === version;
}
