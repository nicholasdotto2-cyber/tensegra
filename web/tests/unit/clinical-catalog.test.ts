import { describe, expect, it } from "vitest";
import {
  ADVICE_TEMPLATES,
  CATALOG_VERSION,
  DEFAULT_ACTIVE_TEST_CODES,
  NEURO_TESTS,
  PREGNANCY_POSITION_NOTE,
  REGION_CODES,
  REGION_LABEL,
  RISK_TAGS,
  SCREENING_GROUPS,
  SCREENING_ITEMS,
  SIDED_REGIONS,
  SYSTEMS,
  TECHNIQUES,
  TESTS,
  screeningItem,
  technique,
  testDefinition,
  type ScreeningGroup,
} from "@/lib/clinical/catalog";
import {
  ADVERSE_LABEL,
  CHANNEL_LABEL,
  CYCLE_OUTCOME_LABEL,
  FAMILY_LABEL,
  HISTORY_KIND_LABEL,
  OUTCOME_TEXT,
  RADIATION_LABEL,
  RECIPIENT_KIND_LABEL,
  REFERRAL_REASON_LABEL,
  REFERRAL_STATUS_LABEL,
  RISK_BADGE,
  SEVERITY_LABEL,
  TART,
  URGENCY_LABEL,
} from "@/lib/clinical/labels";

// Catalogo clinico: costanti versionate con le fonti
// come sono scritte nel riferimento e codici uguali ai check del database.

const CODE_PATTERN = /^[a-z0-9_]{2,40}$/;

function unique(codes: readonly string[]): boolean {
  return new Set(codes).size === codes.length;
}

describe("codici", () => {
  it("sono unici e rispettano il pattern dei check del database", () => {
    const sets: Record<string, string[]> = {
      screening: SCREENING_ITEMS.map((i) => i.code),
      tests: [...TESTS, ...NEURO_TESTS].map((t) => t.code),
      techniques: TECHNIQUES.map((t) => t.code),
      advice: ADVICE_TEMPLATES.map((a) => a.code),
    };
    for (const [name, codes] of Object.entries(sets)) {
      expect(unique(codes), name).toBe(true);
      for (const code of codes) expect(code, `${name}:${code}`).toMatch(CODE_PATTERN);
    }
  });

  it("la versione del catalogo è 1", () => {
    expect(CATALOG_VERSION).toBe(1);
  });
});

describe("conteggi", () => {
  it.each<[ScreeningGroup, number]>([
    ["ci_sistemica", 6],
    ["ci_locale", 21],
    ["rf_cervicale_vascolare", 5],
    ["rf_rachide", 11],
    ["rf_pediatrico", 11],
    ["rf_gravidanza", 9],
  ])("gruppo %s: %i voci", (group, n) => {
    expect(SCREENING_ITEMS.filter((i) => i.group === group)).toHaveLength(n);
  });

  it("63 voci di screening, 27 test, 18 dell'esame neurologico, 16 tecniche, 9 consigli", () => {
    expect(SCREENING_ITEMS).toHaveLength(63);
    expect(SCREENING_GROUPS.map((g) => g.code).sort()).toEqual(
      ["ci_locale", "ci_sistemica", "rf_cervicale_vascolare", "rf_gravidanza", "rf_pediatrico", "rf_rachide"],
    );
    expect(TESTS).toHaveLength(27);
    expect(NEURO_TESTS).toHaveLength(18);
    expect(TECHNIQUES).toHaveLength(16);
    expect(ADVICE_TEMPLATES).toHaveLength(9);
    expect(RISK_TAGS).toHaveLength(16);
  });

  it("l'esame neurologico: 4 riflessi, 10 forze, 2 sensibilità, Babinski e Hoffmann", () => {
    const codes = NEURO_TESTS.map((t) => t.code);
    expect(codes.filter((c) => c.startsWith("riflesso_"))).toHaveLength(4);
    expect(codes.filter((c) => c.startsWith("forza_"))).toHaveLength(10);
    expect(codes).toEqual(expect.arrayContaining(["sensibilita_as", "sensibilita_ai", "babinski", "hoffmann"]));
    for (const t of NEURO_TESTS) expect(t.category).toBe("neurologico");
  });
});

describe("regioni", () => {
  it("REGION_CODES ha l'ordine di app.region_codes() e ogni regione ha l'etichetta", () => {
    expect([...REGION_CODES]).toEqual([
      "head", "cervical", "thoracic", "lumbar", "sacral", "pelvic", "lower_extremity", "upper_extremity",
      "rib_cage", "abdomen_other",
    ]);
    expect(REGION_LABEL).toEqual({
      head: "Cranio e ATM",
      cervical: "Cervicale",
      thoracic: "Dorsale",
      lumbar: "Lombare",
      sacral: "Sacro",
      pelvic: "Bacino",
      lower_extremity: "Arto inferiore",
      upper_extremity: "Arto superiore",
      rib_cage: "Coste",
      abdomen_other: "Addome e altro",
    });
    expect([...SIDED_REGIONS]).toEqual(["lower_extremity", "upper_extremity"]);
  });

  it("ogni regione dei test e ogni regione proposta è un codice di regione", () => {
    for (const t of [...TESTS, ...NEURO_TESTS]) expect(REGION_CODES, t.code).toContain(t.region);
    for (const i of SCREENING_ITEMS) {
      for (const r of i.proposedRegions) expect(REGION_CODES, i.code).toContain(r);
    }
  });
});

describe("test attivi di partenza", () => {
  it("sono 24 e non includono i tre spenti né l'esame neurologico", () => {
    expect(DEFAULT_ACTIVE_TEST_CODES).toHaveLength(24);
    for (const off of ["schober_modificato", "trendelenburg", "ultt_a"]) {
      expect(DEFAULT_ACTIVE_TEST_CODES).not.toContain(off);
    }
    const neuro = new Set(NEURO_TESTS.map((t) => t.code));
    for (const code of DEFAULT_ACTIVE_TEST_CODES) expect(neuro.has(code), code).toBe(false);
  });
});

describe("fonti", () => {
  // Fonte della tabella dei test, test 1-23: gli URL della cella nell'ordine, o il solo riferimento scritto.
  const E = "https://europepmc.org/article/";
  const EXPECTED: Record<string, string[]> = {
    flessione_in_piedi: [`${E}MED/10509062`, `${E}MED/34551460`],
    flessione_da_seduto: [`${E}MED/34551460`],
    gillet: [`${E}MED/10029942`],
    aslr: [`${E}MED/11413432`],
    provocazione_si: [`${E}MED/16038856`],
    faber: [`${E}MED/37650318`],
    trendelenburg: [`${E}MED/42152900`],
    dita_pavimento: [`${E}MED/11689977`],
    schober_modificato: [`${E}MED/16019864`, `${E}MED/38443445`],
    slump: [`${E}MED/18391677`],
    slr: ["Majlesi 2008"],
    thomas_modificato: [`${E}MED/35248293`],
    flessione_rotazione: [`${E}MED/20508964`, "https://pmc.ncbi.nlm.nih.gov/articles/PMC3452271/"],
    rom_rotazione_cervicale: [`${E}MED/1989013`],
    spurling: [`${E}MED/12544957`, `${E}MED/22806265`],
    ultt_a: ["Wainner 2003"],
    neer: [`${E}MED/17720798`],
    hawkins: [`${E}MED/22773322`],
    adams: [`${E}MED/10586455`],
    espansione_toracica: [`${E}PMC/PMC4316520`],
    apertura_bocca: [`${E}PMC/PMC4478082`],
    cvai: [`${E}PMC/PMC7766735`],
    argenta: [`${E}MED/15111792`],
    rotazione_lattante: [],
    ober: [],
    lunge_carico: [],
    derbolowsky: [],
  };

  it("ogni test 1-23 ha almeno una fonte e gli URL della tabella compaiono uguali", () => {
    for (const [code, sources] of Object.entries(EXPECTED)) {
      expect(testDefinition(code)?.sources, code).toEqual(sources);
    }
    for (const t of TESTS.slice(0, 23)) expect(t.sources.length, t.code).toBeGreaterThan(0);
  });

  it("riferimenti scritti e voci senza fonte", () => {
    expect(testDefinition("slr")?.sources).toEqual(["Majlesi 2008"]);
    expect(testDefinition("ultt_a")?.sources).toEqual(["Wainner 2003"]);
    expect(testDefinition("flessione_rotazione")?.sources).toEqual([
      "https://europepmc.org/article/MED/20508964",
      "https://pmc.ncbi.nlm.nih.gov/articles/PMC3452271/",
    ]);
    for (const code of ["rotazione_lattante", "ober", "lunge_carico", "derbolowsky"]) {
      expect(testDefinition(code)?.sources, code).toEqual([]);
    }
  });

  it("controindicazioni e red flag cervicali hanno sempre una fonte", () => {
    const groups: ScreeningGroup[] = ["ci_sistemica", "ci_locale", "rf_cervicale_vascolare"];
    for (const i of SCREENING_ITEMS.filter((x) => groups.includes(x.group))) {
      expect(i.sources.length, i.code).toBeGreaterThan(0);
    }
    expect(screeningItem("ci_coag")?.sources).toEqual(["OMS, cap. 3.1"]);
    expect(screeningItem("loc_aorta")?.sources).toEqual(["OMS, cap. 3.1 e 3.2"]);
    expect(screeningItem("cv_unlike")?.sources).toEqual(["IFOMPT Cervical Framework"]);
  });

  it("rachide, pediatria e gravidanza", () => {
    expect(screeningItem("rf_ces_urine")?.sources).toEqual(["GIRFT pag. 6"]);
    expect(screeningItem("rf_ces_saddle")?.sources).toEqual(["GIRFT"]);
    expect(screeningItem("rf_bilat_sciatica")?.sources).toEqual(["GIRFT"]);
    expect(screeningItem("rf_cancer")?.sources).toEqual(["Downie"]);
    expect(screeningItem("rf_fracture")?.sources).toEqual(["Downie"]);
    expect(screeningItem("rf_infection")?.sources).toEqual(["categorie IFOMPT"]);
    expect(screeningItem("rf_weight")?.sources).toEqual([]);
    expect(screeningItem("rf_nonmech")?.sources).toEqual([]);
    const ng1 = "https://www.nice.org.uk/guidance/ng1/chapter/Recommendations";
    expect(screeningItem("rf_ped_bilious")?.sources).toEqual([ng1]);
    expect(screeningItem("rf_ped_fever")?.sources).toEqual(["https://www.nice.org.uk/guidance/ng143/chapter/Recommendations"]);
    expect(screeningItem("rf_ped_synostosis")?.sources).toEqual([
      "https://pmc.ncbi.nlm.nih.gov/articles/PMC5176072/",
      "https://pmc.ncbi.nlm.nih.gov/articles/PMC4154975/",
    ]);
    const ng133 = "https://www.nice.org.uk/guidance/ng133/chapter/Recommendations";
    for (const code of ["rf_preg_headache", "rf_preg_vision", "rf_preg_epigastric", "rf_preg_vomiting", "rf_preg_oedema"]) {
      expect(screeningItem(code)?.sources, code).toEqual([ng133]);
    }
    for (const code of ["rf_preg_bleeding", "rf_preg_contractions", "rf_preg_movements", "rf_preg_calf"]) {
      expect(screeningItem(code)?.sources, code).toEqual([]);
    }
  });
});

describe("etichette e short", () => {
  it("nessuna etichetta porta note di costruzione", () => {
    for (const i of SCREENING_ITEMS) {
      expect(i.label, i.code).not.toMatch(/sottocaselle/i);
      expect(i.label, i.code).not.toMatch(/\btag\b/i);
    }
  });

  it("testi verbatim del riferimento", () => {
    expect(screeningItem("ci_nao")?.label).toBe(
      "Terapia con anticoagulanti diretti (NAO: apixaban, rivaroxaban, dabigatran, edoxaban; Eliquis, Xarelto, Pradaxa, Lixiana)",
    );
    expect(screeningItem("rf_cancer")?.label).toBe("Storia di tumore maligno");
    expect(screeningItem("rf_ces_saddle")?.short).toBe("anestesia a sella");
    expect(screeningItem("cv_neuro")?.short).toBe("segni neurologici acuti");
    expect(screeningItem("loc_aorta")?.short).toBe("aneurisma aortico");
    expect(screeningItem("cv_risk")?.subItems[2]).toEqual({ code: "colesterolo", label: "Colesterolo alto" });
  });

  it("short = parte della label prima della prima virgola, parentesi o due punti, con l'iniziale minuscola, salvo sei eccezioni", () => {
    const exceptions: Record<string, string> = {
      ci_avk: "terapia anticoagulante",
      ci_nao: "terapia anticoagulante",
      loc_cerebral: "patologia cerebrale acuta",
      cv_neuro: "segni neurologici acuti",
      rf_fracture: "sospetta frattura",
      rf_infection: "sospetta infezione",
    };
    for (const i of SCREENING_ITEMS) {
      const prefix = i.label.split(/[,(:]/)[0]!.trim();
      const derived = prefix.charAt(0).toLowerCase() + prefix.slice(1);
      expect(i.short, i.code).toBe(exceptions[i.code] ?? derived);
    }
  });

  it("rf_ped_fever: label senza la nota della fonte, short con l'unità °C maiuscola", () => {
    const item = screeningItem("rf_ped_fever");
    expect(item?.label).toBe("Età sotto i 3 mesi con temperatura di 38 °C o più");
    expect(item?.short).toBe("età sotto i 3 mesi con temperatura di 38 °C o più");
    expect(item?.sources).toEqual(["https://www.nice.org.uk/guidance/ng143/chapter/Recommendations"]);
  });

  it("le sottovoci stanno solo dove il riferimento le prevede", () => {
    const withSub = SCREENING_ITEMS.filter((i) => i.subItems.length > 0).map((i) => i.code);
    expect(withSub.sort()).toEqual(["ci_nao", "cv_risk", "rf_fracture", "rf_infection", "rf_ped_synostosis"]);
    expect(screeningItem("ci_nao")?.subItems).toEqual([
      { code: "assunzione_regolare", label: "Assunzione regolare" },
      { code: "sanguinamenti_recenti", label: "Sanguinamenti recenti" },
    ]);
    expect(screeningItem("cv_risk")?.subItems).toHaveLength(8);
    expect(screeningItem("rf_fracture")?.subItems.map((s) => s.code)).toEqual([
      "trauma_importante", "eta_avanzata", "corticosteroidi", "contusione",
    ]);
    expect(screeningItem("rf_ped_synostosis")?.subItems.map((s) => s.code)).toEqual(["cresta", "trapezio", "mastoide"]);
  });

  it("help solo per ci_avk e ci_nao", () => {
    for (const i of SCREENING_ITEMS) {
      if (i.code === "ci_avk") expect(i.help).toBe("Annota l'INR e la data dal libretto TAO.");
      else if (i.code === "ci_nao") expect(i.help).toBe("Annota l'assunzione regolare e l'assenza di sanguinamenti recenti.");
      else expect(i.help, i.code).toBeNull();
    }
  });
});

describe("regole di screening del catalogo", () => {
  it("regioni proposte", () => {
    expect(screeningItem("loc_aorta")?.proposedRegions).toEqual(["abdomen_other", "lumbar"]);
    expect(screeningItem("loc_wound")?.proposedRegions).toHaveLength(10);
    expect(screeningItem("loc_vascular")?.proposedRegions).toEqual(["cervical"]);
    expect(screeningItem("loc_ces")?.proposedRegions).toEqual(["lumbar", "sacral"]);
    expect(screeningItem("loc_eye")?.proposedRegions).toEqual(["head"]);
  });

  it("ci_avk", () => {
    const item = screeningItem("ci_avk");
    expect(item?.effect).toEqual({ thrust: "contraindicated", direct: "contraindicated", indirect: "none" });
    expect(item?.linkedRiskTag).toBe("anticoagulante_tao");
    expect(item?.short).toBe("terapia anticoagulante");
  });

  it("ci_nao, loc_fixation, rf_weight, cv_trauma, cv_risk", () => {
    const nao = screeningItem("ci_nao");
    expect(nao?.effect.direct).toBe("caution");
    expect(nao?.subItems).toHaveLength(2);
    const fix = screeningItem("loc_fixation");
    expect(fix?.scope).toBe("local");
    expect(fix?.linkedRiskTag).toBe("mezzi_di_sintesi");
    const weight = screeningItem("rf_weight");
    expect(weight?.referral).toBe("programmato");
    expect(weight?.effect).toEqual({ thrust: "none", direct: "none", indirect: "none" });
    const trauma = screeningItem("cv_trauma");
    expect(trauma?.effect.thrust).toBe("contraindicated");
    expect(trauma?.effect.direct).toBe("caution");
    const risk = screeningItem("cv_risk");
    expect(risk?.scope).toBe("local");
    expect(risk?.proposedRegions).toEqual(["cervical"]);
  });

  it("solo ci_locale e cv_risk sono locali; l'età massima è su due voci pediatriche", () => {
    for (const i of SCREENING_ITEMS) {
      const local = i.group === "ci_locale" || i.code === "cv_risk";
      expect(i.scope, i.code).toBe(local ? "local" : "global");
      const age = i.code === "rf_ped_projectile" ? 2 : i.code === "rf_ped_fever" ? 3 : null;
      expect(i.ageMaxMonths, i.code).toBe(age);
    }
  });

  it("red flag urgenti o di emergenza bloccano tutte le famiglie, i programmati non cambiano l'esito", () => {
    const raised = SCREENING_ITEMS.filter(
      (i) => (i.group === "rf_rachide" || i.group === "rf_pediatrico" || i.group === "rf_gravidanza") ,
    );
    for (const i of raised) {
      const blocking = i.referral === "urgente" || i.referral === "emergenza";
      const expected = blocking ? "contraindicated" : "none";
      expect(i.effect, i.code).toEqual({ thrust: expected, direct: expected, indirect: expected });
    }
    expect(screeningItem("cv_unlike")?.effect).toEqual({
      thrust: "contraindicated", direct: "contraindicated", indirect: "contraindicated",
    });
    expect(screeningItem("cv_neuro")?.referral).toBe("emergenza");
  });

  it("sort = posizione nella tabella × 10, senza doppioni dentro il gruppo", () => {
    for (const g of SCREENING_GROUPS) {
      const sorts = SCREENING_ITEMS.filter((i) => i.group === g.code).map((i) => i.sort);
      expect(sorts).toEqual(sorts.map((_, idx) => (idx + 1) * 10));
    }
  });

  it("gravidanza: promemoria di posizione", () => {
    expect(PREGNANCY_POSITION_NOTE).toBe(
      "Dopo le 20 settimane evita la posizione supina prolungata, preferisci il fianco sinistro",
    );
  });
});

describe("tecniche", () => {
  it("i codici sono quelli del check del database", () => {
    expect(TECHNIQUES.map((t) => t.code)).toEqual([
      "tessuti_molli", "articolatoria", "hvla", "energia_muscolare", "got", "inibizione", "fasciale",
      "craniale", "viscerale", "still", "funzionale", "counterstrain", "blt", "linfatica", "riflessi", "altra",
    ]);
  });

  it("famiglie, approccio variabile e nome nel blocco", () => {
    expect(technique("hvla")).toMatchObject({ families: ["thrust"], blockName: "HVLA" });
    expect(technique("fasciale")?.variableApproach).toBe(true);
    expect(technique("hvla")?.variableApproach).toBe(false);
    expect(technique("still")?.blockName).toBe("Tecnica di Still");
    expect(technique("tessuti_molli")?.blockName).toBe("Tecnica tessuti molli");
    expect(technique("got")?.blockName).toBe("Tecnica TOG");
    expect(technique("altra")?.blockName).toBe("");
    expect(technique("funzionale")?.families).toEqual(["indirect"]);
    expect(technique("craniale")?.families).toContain("direct");
    expect(technique("hvla")?.label).toBe("HVLA (thrust ad alta velocità e bassa ampiezza)");
  });
});

describe("test", () => {
  it("flessione_rotazione e dita_pavimento", () => {
    expect(testDefinition("flessione_rotazione")).toMatchObject({
      region: "cervical", perSide: true, betterDirection: "higher", unit: "°",
    });
    expect(testDefinition("dita_pavimento")).toMatchObject({ unit: "cm", betterDirection: "lower" });
  });

  it("riflessi ordinali e ricerca in entrambi gli elenchi", () => {
    expect(testDefinition("riflesso_rotuleo")?.ordinalLabels).toEqual(["normale", "ridotto", "assente"]);
    expect(testDefinition("riflesso_rotuleo")?.perSide).toBe(true);
    expect(testDefinition("forza_c5")).toMatchObject({ resultType: "numeric", min: 0, max: 5, step: 1 });
    expect(testDefinition("non_esiste")).toBeUndefined();
  });

  it("i test numerici hanno un intervallo e un passo, gli altri no", () => {
    for (const t of [...TESTS, ...NEURO_TESTS]) {
      if (t.resultType === "numeric") {
        expect(t.min, t.code).not.toBeNull();
        expect(t.max, t.code).not.toBeNull();
        expect(t.step, t.code).not.toBeNull();
        expect(t.max!, t.code).toBeGreaterThan(t.min!);
      } else {
        expect([t.min, t.max, t.step], t.code).toEqual([null, null, null]);
      }
      if (t.resultType === "ordinal") expect(t.ordinalLabels?.length, t.code).toBeGreaterThanOrEqual(3);
      else expect(t.ordinalLabels, t.code).toBeNull();
    }
    expect(testDefinition("aslr")?.ordinalLabels).toHaveLength(6);
    expect(testDefinition("argenta")?.ordinalLabels).toEqual(["Tipo I", "Tipo II", "Tipo III", "Tipo IV", "Tipo V"]);
  });
});

describe("modelli di consiglio", () => {
  it("titolo fino a 60, testo fino a 600, niente punti esclamativi né trattini lunghi", () => {
    for (const a of ADVICE_TEMPLATES) {
      expect(a.title.length, a.code).toBeLessThanOrEqual(60);
      expect(a.body.length, a.code).toBeLessThanOrEqual(600);
      expect(a.title + a.body, a.code).not.toMatch(/!|—/);
    }
  });

  it("solo lattante_testa è per i lattanti", () => {
    expect(ADVICE_TEMPLATES.filter((a) => a.infantOnly).map((a) => a.code)).toEqual(["lattante_testa"]);
  });
});

describe("codici uguali ai check del database", () => {
  it("apparati dell'anamnesi", () => {
    expect(SYSTEMS.map((s) => s.code)).toEqual([
      "digerente", "urogenitale", "respiratorio", "cardiocircolatorio", "orl_vista", "stomatognatico", "sonno",
      "stress_umore",
    ]);
    expect(SYSTEMS.map((s) => s.label)).toEqual([
      "Digerente", "Urogenitale e ginecologico", "Respiratorio", "Cardiocircolatorio", "ORL e vista",
      "Stomatognatico (bite, apparecchio, bruxismo)", "Sonno", "Stress e umore",
    ]);
  });

  it("chiavi delle etichette", () => {
    expect(Object.keys(RADIATION_LABEL)).toEqual(["gluteo", "coscia", "sotto_ginocchio", "braccio", "mano"]);
    expect(Object.keys(ADVERSE_LABEL)).toEqual(["nessuna", "lieve", "moderata", "grave"]);
    expect(Object.keys(CHANNEL_LABEL)).toEqual(["a_voce", "foglio_stampato", "messaggio_copiato"]);
    expect(Object.keys(CYCLE_OUTCOME_LABEL)).toEqual([
      "raggiunto", "parzialmente_raggiunto", "non_raggiunto", "interrotto_dal_paziente", "rinviato_al_medico",
    ]);
    expect(Object.keys(REFERRAL_REASON_LABEL)).toEqual([
      "red_flag", "sintomi_persistenti", "peggioramento", "fuori_competenza", "richiesta_paziente", "altro",
    ]);
    expect(Object.keys(URGENCY_LABEL)).toEqual(["emergenza", "urgente", "programmato"]);
    expect(Object.keys(RECIPIENT_KIND_LABEL)).toEqual([
      "medico_curante", "medico_inviante", "specialista", "pronto_soccorso", "altro",
    ]);
    expect(Object.keys(REFERRAL_STATUS_LABEL)).toEqual(["bozza", "stampata", "consegnata_al_paziente", "inviata"]);
    expect(Object.keys(HISTORY_KIND_LABEL)).toEqual(["patologia", "farmaco", "intervento", "trauma", "allergia", "esame"]);
  });
});

describe("etichette di presentazione", () => {
  it("famiglie, esiti, severità e TART", () => {
    expect(FAMILY_LABEL).toEqual({ thrust: "Thrust", direct: "Dirette", indirect: "Indirette" });
    expect(OUTCOME_TEXT).toEqual({ indicated: "indicato", caution: "con cautela", contraindicated: "controindicato" });
    expect(SEVERITY_LABEL).toEqual({
      0: "Assente o di fondo", 1: "Lieve", 2: "Evidente", 3: "Marcata (disfunzione primaria)",
    });
    expect(TART.map((t) => t.letter).join("")).toBe("TART");
    expect(TART.map((t) => t.key)).toEqual(["tissueTexture", "asymmetry", "restriction", "tenderness"]);
  });

  it("badge di rischio dall'anamnesi", () => {
    expect(RISK_BADGE).toEqual({
      anticoagulante_tao: "TAO",
      anticoagulante_nao: "NAO",
      storia_di_tumore: "Storia di tumore",
      osteoporosi: "Osteoporosi",
    });
  });
});
