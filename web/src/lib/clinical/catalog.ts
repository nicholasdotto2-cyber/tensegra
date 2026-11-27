// Catalogo clinico: screening, tecniche, test e modelli di consiglio come costanti versionate.
// Le visite salvano i codici e il testo
// copiato, quindi nessuna tabella è condivisa fra studi. Sicuro per il client: nessun import dal server.
// Un codice non si riusa mai con un significato diverso.

export const CATALOG_VERSION = 1;

// ---------------------------------------------------------------------------------------------------
// Regioni: stesso ordine di `app.region_codes()`.

export type RegionCode =
  | "head"
  | "cervical"
  | "thoracic"
  | "lumbar"
  | "sacral"
  | "pelvic"
  | "lower_extremity"
  | "upper_extremity"
  | "rib_cage"
  | "abdomen_other";

export const REGION_CODES: readonly RegionCode[] = [
  "head",
  "cervical",
  "thoracic",
  "lumbar",
  "sacral",
  "pelvic",
  "lower_extremity",
  "upper_extremity",
  "rib_cage",
  "abdomen_other",
];

export const REGION_LABEL: Record<RegionCode, string> = {
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
};

/** Le regioni dove il lato (dx o sx) ha senso: il resto si registra come regione unica. */
export const SIDED_REGIONS: readonly RegionCode[] = ["lower_extremity", "upper_extremity"];

// ---------------------------------------------------------------------------------------------------
// Tipi comuni.

export type Family = "thrust" | "direct" | "indirect";
export const FAMILIES: readonly Family[] = ["thrust", "direct", "indirect"];
export type Effect = "none" | "caution" | "contraindicated";
export type Outcome = "indicated" | "caution" | "contraindicated";
export type Approach = "direct" | "indirect";

export type ScreeningGroup =
  | "ci_sistemica"
  | "ci_locale"
  | "rf_rachide"
  | "rf_cervicale_vascolare"
  | "rf_gravidanza"
  | "rf_pediatrico";

export const SCREENING_GROUPS: readonly { code: ScreeningGroup; label: string }[] = [
  { code: "ci_sistemica", label: "Controindicazioni sistemiche" },
  { code: "ci_locale", label: "Controindicazioni locali" },
  { code: "rf_rachide", label: "Red flag del rachide" },
  { code: "rf_cervicale_vascolare", label: "Red flag cervicali" },
  { code: "rf_gravidanza", label: "Gravidanza" },
  { code: "rf_pediatrico", label: "Red flag pediatriche" },
];

export type ReferralLevel = "none" | "programmato" | "urgente" | "emergenza";

/** Vocabolario di `patient_history_entries.risk_tags`. */
export const RISK_TAGS = [
  "anticoagulante_tao",
  "anticoagulante_nao",
  "disturbo_coagulazione",
  "corticosteroide_lungo_termine",
  "osteoporosi",
  "malattia_tessuto_connettivo",
  "storia_di_tumore",
  "mezzi_di_sintesi",
  "colpo_di_frusta",
  "trauma_cranico",
  "gravidanza",
  "ipertensione",
  "fumo",
  "emicrania",
  "contraccettivo_orale",
  "cicatrice",
] as const;
export type RiskTag = (typeof RISK_TAGS)[number];

/** Farmaci che accendono da soli l'etichetta di rischio, senza maiuscole e accenti. */
export const TAO_DRUGS: readonly string[] = ["warfarin", "acenocumarolo", "coumadin", "sintrom"];
export const NAO_DRUGS: readonly string[] = ["apixaban", "rivaroxaban", "dabigatran", "edoxaban", "eliquis", "xarelto", "pradaxa", "lixiana"];

/** Gli apparati dell'anamnesi (`patient_systems_review.system`). */
export const SYSTEMS: readonly { code: string; label: string }[] = [
  { code: "digerente", label: "Digerente" },
  { code: "urogenitale", label: "Urogenitale e ginecologico" },
  { code: "respiratorio", label: "Respiratorio" },
  { code: "cardiocircolatorio", label: "Cardiocircolatorio" },
  { code: "orl_vista", label: "ORL e vista" },
  { code: "stomatognatico", label: "Stomatognatico (bite, apparecchio, bruxismo)" },
  { code: "sonno", label: "Sonno" },
  { code: "stress_umore", label: "Stress e umore" },
];

/** Promemoria di posizionamento accanto al gruppo gravidanza: non è una voce. */
export const PREGNANCY_POSITION_NOTE =
  "Dopo le 20 settimane evita la posizione supina prolungata, preferisci il fianco sinistro";

// ---------------------------------------------------------------------------------------------------
// Screening. `sort` = posizione nella tabella di riferimento x 10.

export interface ScreeningItem {
  code: string;
  group: ScreeningGroup;
  label: string;
  /** Il motivo nel testo del blocco ("HVLA controindicata in questa visita: terapia anticoagulante"). */
  short: string;
  help: string | null;
  effect: Record<Family, Effect>;
  scope: "global" | "local";
  proposedRegions: readonly RegionCode[];
  referral: ReferralLevel;
  subItems: readonly { code: string; label: string }[];
  linkedRiskTag: RiskTag | null;
  ageMaxMonths: number | null;
  sources: readonly string[];
  sort: number;
}

type Eff = "ci" | "ca" | "no";
const EFFECT: Record<Eff, Effect> = { ci: "contraindicated", ca: "caution", no: "none" };

/** Dati di una riga di tabella: i campi che non cambiano vengono dai valori predefiniti di `row`. */
interface Row {
  code: string;
  label: string;
  /** Eccezione alla regola generale: altrimenti la label fino alla prima virgola, parentesi o due punti, con l'iniziale minuscola. */
  short?: string;
  help?: string;
  /** thrust, direct, indirect. */
  fx: readonly [Eff, Eff, Eff];
  local?: boolean;
  regions?: readonly RegionCode[];
  referral?: ReferralLevel;
  sub?: readonly (readonly [string, string])[];
  tag?: RiskTag;
  ageMax?: number;
  sources: readonly string[];
}

const ALL_REGIONS: readonly RegionCode[] = REGION_CODES;
const BLOCK: readonly [Eff, Eff, Eff] = ["ci", "ci", "ci"];
const NONE: readonly [Eff, Eff, Eff] = ["no", "no", "no"];

function deriveShort(label: string): string {
  const prefix = (label.split(/[,(:]/)[0] ?? label).trim();
  return prefix.charAt(0).toLowerCase() + prefix.slice(1);
}

function build(group: ScreeningGroup, rows: readonly Row[]): ScreeningItem[] {
  return rows.map((r, i) => ({
    code: r.code,
    group,
    label: r.label,
    short: r.short ?? deriveShort(r.label),
    help: r.help ?? null,
    effect: { thrust: EFFECT[r.fx[0]], direct: EFFECT[r.fx[1]], indirect: EFFECT[r.fx[2]] },
    scope: r.local ? "local" : "global",
    proposedRegions: r.regions ?? [],
    referral: r.referral ?? "none",
    subItems: (r.sub ?? []).map(([code, label]) => ({ code, label })),
    linkedRiskTag: r.tag ?? null,
    ageMaxMonths: r.ageMax ?? null,
    sources: r.sources,
    sort: (i + 1) * 10,
  }));
}

/** I red flag con rinvio urgente o di emergenza controindicano tutte le famiglie. */
function redFlagEffect(referral: ReferralLevel): readonly [Eff, Eff, Eff] {
  return referral === "urgente" || referral === "emergenza" ? BLOCK : NONE;
}

const OMS_SYSTEMIC = ["OMS, cap. 3.1"];
const OMS_LOCAL = ["OMS, cap. 3.1 e 3.2"];
const IFOMPT_CERVICAL = ["IFOMPT Cervical Framework"];

const SYSTEMIC: readonly ScreeningItem[] = build("ci_sistemica", [
  {
    code: "ci_coag",
    label: "Disturbo emorragico sospetto, tempi di sanguinamento prolungati o anomalie della coagulazione",
    fx: ["ci", "ci", "no"],
    tag: "disturbo_coagulazione",
    sources: OMS_SYSTEMIC,
  },
  {
    code: "ci_avk",
    label: "Terapia anticoagulante orale (TAO: warfarin, acenocumarolo; Coumadin, Sintrom) senza INR recente nel range",
    short: "terapia anticoagulante",
    help: "Annota l'INR e la data dal libretto TAO.",
    fx: ["ci", "ci", "no"],
    tag: "anticoagulante_tao",
    sources: OMS_SYSTEMIC,
  },
  {
    code: "ci_nao",
    label:
      "Terapia con anticoagulanti diretti (NAO: apixaban, rivaroxaban, dabigatran, edoxaban; Eliquis, Xarelto, Pradaxa, Lixiana)",
    short: "terapia anticoagulante",
    help: "Annota l'assunzione regolare e l'assenza di sanguinamenti recenti.",
    fx: ["ci", "ca", "no"],
    sub: [
      ["assunzione_regolare", "Assunzione regolare"],
      ["sanguinamenti_recenti", "Sanguinamenti recenti"],
    ],
    tag: "anticoagulante_nao",
    sources: OMS_SYSTEMIC,
  },
  {
    code: "ci_connective",
    label: "Malattia del tessuto connettivo con integrità dei tessuti compromessa",
    fx: ["ci", "ci", "no"],
    tag: "malattia_tessuto_connettivo",
    sources: OMS_SYSTEMIC,
  },
  {
    code: "ci_integrity",
    label:
      "Integrità di osso, tendine, legamento o articolazione compromessa (malattie metaboliche, metastasi, malattie reumatiche)",
    fx: ["ci", "ci", "no"],
    sources: OMS_SYSTEMIC,
  },
  {
    code: "ci_osteo",
    label: "Osteoporosi o osteopenia",
    fx: ["ca", "ca", "no"],
    tag: "osteoporosi",
    sources: OMS_SYSTEMIC,
  },
]);

const LOCAL_ROWS: readonly Omit<Row, "local" | "sources">[] = [
  { code: "loc_aorta", label: "Aneurisma aortico", fx: ["ci", "ci", "no"], regions: ["abdomen_other", "lumbar"] },
  {
    code: "loc_wound",
    label: "Ferite aperte, cute alterata, intervento chirurgico recente",
    fx: ["ci", "ci", "no"],
    regions: ALL_REGIONS,
  },
  {
    code: "loc_cerebral",
    label:
      "Idrocefalo acuto o non indagato, emorragia cerebrale acuta, ischemia cerebrale acuta anche transitoria, malformazione artero-venosa sospetta, aneurisma cerebrale",
    short: "patologia cerebrale acuta",
    fx: BLOCK,
    regions: ["head"],
  },
  {
    code: "loc_head_injury_recent",
    label: "Trauma cranico chiuso recente (acuto o subacuto)",
    fx: BLOCK,
    regions: ["head"],
  },
  {
    code: "loc_head_injury_past",
    label: "Trauma cranico chiuso non recente",
    fx: ["no", "no", "ca"],
    regions: ["head"],
  },
  { code: "loc_abd_pain", label: "Dolore addominale", fx: ["ci", "ci", "no"], regions: ["abdomen_other"] },
  {
    code: "loc_visceral_acute",
    label: "Appendicite, colecistite o altra malattia viscerale acuta con sospetta perforazione; peritonite acuta sospetta",
    fx: BLOCK,
    regions: ["abdomen_other"],
  },
  {
    code: "loc_disc_prog",
    label: "Ernia discale acuta con segni neurologici progressivi",
    fx: ["ci", "ci", "no"],
    regions: ["cervical", "lumbar"],
  },
  {
    code: "loc_vascular",
    label: "Sospetto compromesso vascolare, sospetto compromesso dell'arteria vertebrale",
    fx: ["ci", "ci", "no"],
    regions: ["cervical"],
  },
  { code: "loc_congenital", label: "Malformazione congenita nota", fx: ["ci", "ci", "no"], regions: ALL_REGIONS },
  {
    code: "loc_ces",
    label: "Sindrome della cauda equina acuta",
    fx: ["ci", "ci", "no"],
    regions: ["lumbar", "sacral"],
  },
  {
    code: "loc_eye",
    label: "Impianto del cristallino recente, glaucoma non controllato",
    fx: ["ci", "ci", "no"],
    regions: ["head"],
  },
  { code: "loc_neoplasm", label: "Neoplasia o metastasi nella sede", fx: ["ci", "ci", "ca"], regions: ALL_REGIONS },
  {
    code: "loc_bone_infection",
    label: "Sospetta compromissione ossea (osteomielite, tubercolosi ossea)",
    fx: ["ci", "ci", "no"],
    regions: ALL_REGIONS,
  },
  {
    code: "loc_fixation",
    label: "Mezzi di sintesi chirurgica nell'articolazione",
    fx: ["ci", "no", "no"],
    regions: ALL_REGIONS,
    tag: "mezzi_di_sintesi",
  },
  {
    code: "loc_joint_instab",
    label: "Stabilità ossea o articolare compromessa (artrite settica, malattie reumatiche)",
    fx: ["ci", "no", "no"],
    regions: ALL_REGIONS,
  },
  { code: "loc_fracture", label: "Frattura acuta", fx: ["ci", "no", "no"], regions: ALL_REGIONS },
  { code: "loc_haematoma", label: "Ematoma osseo o intramuscolare, ascesso", fx: ["ci", "no", "no"], regions: ALL_REGIONS },
  {
    code: "loc_disc",
    label: "Ernia discale (senza segni progressivi)",
    fx: ["ca", "no", "no"],
    regions: ["cervical", "lumbar"],
  },
  { code: "loc_ligament", label: "Legamenti distorti nella sede", fx: ["ca", "no", "no"], regions: ALL_REGIONS },
  {
    code: "loc_whiplash",
    label: "Lesione acuta da accelerazione-decelerazione del collo",
    fx: ["ca", "no", "no"],
    regions: ["cervical"],
    tag: "colpo_di_frusta",
  },
];

const LOCAL: readonly ScreeningItem[] = build(
  "ci_locale",
  LOCAL_ROWS.map((r) => ({ ...r, local: true, sources: OMS_LOCAL })),
);

const CERVICAL: readonly ScreeningItem[] = build("rf_cervicale_vascolare", [
  {
    code: "cv_unlike",
    label: 'Dolore al collo o cefalea acuti, "diversi da qualsiasi altro"',
    fx: BLOCK,
    referral: "urgente",
    sources: IFOMPT_CERVICAL,
  },
  {
    code: "cv_neuro",
    label:
      "Uno o più fra: vertigini o instabilità, disturbi visivi, difficoltà a parlare o a deglutire, palpebra calante, paralisi del volto, debolezza o formicolii agli arti o al volto, nausea o vomito, perdita di coscienza, confusione, sonnolenza",
    short: "segni neurologici acuti",
    fx: BLOCK,
    referral: "emergenza",
    sources: IFOMPT_CERVICAL,
  },
  {
    code: "cv_trauma",
    label: "Trauma recente a collo o testa",
    fx: ["ci", "ca", "no"],
    referral: "programmato",
    sources: IFOMPT_CERVICAL,
  },
  {
    code: "cv_risk",
    label:
      "Fattori di rischio vascolare (fumo, ipertensione, colesterolo alto, emicrania, infezione recente, contraccettivi orali, familiarità per ictus, anomalia vascolare nota)",
    fx: ["ca", "ca", "no"],
    local: true,
    regions: ["cervical"],
    sub: [
      ["fumo", "Fumo"],
      ["ipertensione", "Ipertensione"],
      ["colesterolo", "Colesterolo alto"],
      ["emicrania", "Emicrania"],
      ["infezione_recente", "Infezione recente"],
      ["contraccettivi_orali", "Contraccettivi orali"],
      ["familiarita_ictus", "Familiarità per ictus"],
      ["anomalia_vascolare", "Anomalia vascolare nota"],
    ],
    sources: IFOMPT_CERVICAL,
  },
  {
    code: "cv_instab",
    label: "Comportamento da instabilità cervicale alta (ansia, sostiene la testa con le mani)",
    fx: ["ci", "ca", "no"],
    referral: "programmato",
    sources: IFOMPT_CERVICAL,
  },
]);

/** Riga di red flag: l'effetto segue il rinvio, salvo dove `extra` dice altro. */
function flag(
  code: string,
  label: string,
  referral: ReferralLevel,
  sources: readonly string[],
  extra: Partial<Row> = {},
): Row {
  return { code, label, referral, sources, fx: redFlagEffect(referral), ...extra };
}

const GIRFT = ["GIRFT"];
const DOWNIE = ["Downie"];

const SPINE: readonly ScreeningItem[] = build("rf_rachide", [
  flag("rf_ces_urine", "Difficoltà a iniziare la minzione o ridotta sensibilità del flusso, comparsa recente", "emergenza", ["GIRFT pag. 6"]),
  flag("rf_ces_saddle", "Anestesia a sella: sensibilità alterata in zona perianale, perineale o genitale", "emergenza", GIRFT),
  flag("rf_ces_legs", "Deficit neurologico grave o progressivo a entrambe le gambe", "emergenza", GIRFT),
  flag("rf_ces_rectal", "Perdita della sensazione di riempimento rettale", "emergenza", GIRFT),
  flag("rf_ces_sexual", "Disfunzione sessuale di comparsa recente", "emergenza", GIRFT),
  flag("rf_bilat_sciatica", "Sciatalgia comparsa bilaterale o diventata bilaterale, senza i sintomi sopra", "urgente", GIRFT),
  flag("rf_cancer", "Storia di tumore maligno", "programmato", DOWNIE, { tag: "storia_di_tumore" }),
  flag(
    "rf_fracture",
    "Trauma importante, età avanzata, uso prolungato di corticosteroidi, contusione o abrasione nella zona",
    "urgente",
    DOWNIE,
    {
      short: "sospetta frattura",
      sub: [
        ["trauma_importante", "Trauma importante"],
        ["eta_avanzata", "Età avanzata"],
        ["corticosteroidi", "Uso prolungato di corticosteroidi"],
        ["contusione", "Contusione o abrasione nella zona"],
      ],
    },
  ),
  flag("rf_weight", "Calo di peso non spiegato", "programmato", []),
  flag(
    "rf_infection",
    "Febbre o malessere generale, immunosoppressione, infezione o procedura spinale recente, uso di droghe per via endovenosa",
    "urgente",
    ["categorie IFOMPT"],
    {
      short: "sospetta infezione",
      sub: [
        ["febbre", "Febbre o malessere generale"],
        ["immunosoppressione", "Immunosoppressione"],
        ["procedura_recente", "Infezione o procedura spinale recente"],
        ["droghe_ev", "Uso di droghe per via endovenosa"],
      ],
    },
  ),
  flag("rf_nonmech", "Dolore costante e progressivo che non cambia con posizione e movimento", "programmato", []),
]);

const NICE_NG1 = ["https://www.nice.org.uk/guidance/ng1/chapter/Recommendations"];
const NICE_NG143 = ["https://www.nice.org.uk/guidance/ng143/chapter/Recommendations"];
const SYNOSTOSIS_SOURCES = ["https://pmc.ncbi.nlm.nih.gov/articles/PMC5176072/", "https://pmc.ncbi.nlm.nih.gov/articles/PMC4154975/"];

const PEDIATRIC: readonly ScreeningItem[] = build("rf_pediatrico", [
  flag("rf_ped_bilious", "Vomito verde o giallo-verde", "emergenza", NICE_NG1),
  flag("rf_ped_projectile", "Vomito a getto frequente sotto i 2 mesi", "urgente", NICE_NG1, { ageMax: 2 }),
  flag("rf_ped_blood_vomit", "Sangue nel vomito", "urgente", NICE_NG1),
  flag("rf_ped_blood_stool", "Sangue nelle feci", "urgente", NICE_NG1),
  flag("rf_ped_abdomen", "Addome disteso, dolente o con massa", "urgente", NICE_NG1),
  flag("rf_ped_late_reflux", "Rigurgito comparso dopo i 6 mesi o che continua oltre l'anno", "programmato", NICE_NG1),
  flag("rf_ped_fontanelle", "Fontanella bombata", "urgente", NICE_NG1),
  flag("rf_ped_head_growth", "Circonferenza cranica che cresce più di 1 cm a settimana", "urgente", NICE_NG1),
  flag("rf_ped_responsiveness", "Letargia o irritabilità insolite", "urgente", NICE_NG1),
  flag(
    "rf_ped_fever",
    "Età sotto i 3 mesi con temperatura di 38 °C o più",
    "urgente",
    NICE_NG143,
    { ageMax: 3 },
  ),
  flag(
    "rf_ped_synostosis",
    "Segni di craniosinostosi: cresta palpabile su una sutura; testa a trapezio vista dall'alto con l'orecchio del lato piatto spostato indietro; mastoide sporgente",
    "programmato",
    SYNOSTOSIS_SOURCES,
    {
      sub: [
        ["cresta", "Cresta palpabile su una sutura"],
        ["trapezio", "Testa a trapezio vista dall'alto con l'orecchio del lato piatto spostato indietro"],
        ["mastoide", "Mastoide sporgente"],
      ],
    },
  ),
]);

const NICE_NG133 = ["https://www.nice.org.uk/guidance/ng133/chapter/Recommendations"];

const PREGNANCY: readonly ScreeningItem[] = build("rf_gravidanza", [
  flag("rf_preg_headache", "Cefalea forte", "emergenza", NICE_NG133),
  flag("rf_preg_vision", "Disturbi della vista (vista offuscata, lampi)", "emergenza", NICE_NG133),
  flag("rf_preg_epigastric", "Dolore forte appena sotto le costole", "emergenza", NICE_NG133),
  flag("rf_preg_vomiting", "Vomito", "emergenza", NICE_NG133),
  flag("rf_preg_oedema", "Gonfiore improvviso di viso, mani o piedi", "emergenza", NICE_NG133),
  flag("rf_preg_bleeding", "Perdite di sangue o di liquido", "emergenza", []),
  flag("rf_preg_contractions", "Contrazioni regolari prima delle 37 settimane", "emergenza", []),
  flag("rf_preg_movements", "Movimenti del bambino ridotti", "emergenza", []),
  flag("rf_preg_calf", "Polpaccio dolente e gonfio", "urgente", []),
]);

export const SCREENING_ITEMS: readonly ScreeningItem[] = [
  ...SYSTEMIC,
  ...LOCAL,
  ...CERVICAL,
  ...SPINE,
  ...PEDIATRIC,
  ...PREGNANCY,
];

export function screeningItem(code: string): ScreeningItem | undefined {
  return SCREENING_ITEMS.find((i) => i.code === code);
}

// ---------------------------------------------------------------------------------------------------
// Tecniche. Codici uguali al check di `visit_treatments.technique_code`.

export type TechniqueCode =
  | "tessuti_molli"
  | "articolatoria"
  | "hvla"
  | "energia_muscolare"
  | "got"
  | "inibizione"
  | "fasciale"
  | "craniale"
  | "viscerale"
  | "still"
  | "funzionale"
  | "counterstrain"
  | "blt"
  | "linfatica"
  | "riflessi"
  | "altra";

export interface Technique {
  code: TechniqueCode;
  label: string;
  /** Il nome nel testo del blocco ("Tecnica tessuti molli controindicata in questa visita: ..."). */
  blockName: string;
  /** Le famiglie di screening ammesse, la predefinita per prima. */
  families: readonly Family[];
  variableApproach: boolean;
}

function tech(
  code: TechniqueCode,
  label: string,
  families: readonly Family[],
  variableApproach = false,
  blockName?: string,
): Technique {
  return { code, label, blockName: blockName ?? `Tecnica ${lowerFirst(label.split(" (")[0] ?? label)}`, families, variableApproach };
}

/** Iniziale minuscola, tranne per le sigle (TOG). */
function lowerFirst(text: string): string {
  const first = text.split(" ")[0] ?? "";
  return first === first.toUpperCase() && first.length > 1 ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

export const TECHNIQUES: readonly Technique[] = [
  tech("tessuti_molli", "Tessuti molli", ["direct"]),
  tech("articolatoria", "Articolatoria", ["direct"]),
  tech("hvla", "HVLA (thrust ad alta velocità e bassa ampiezza)", ["thrust"], false, "HVLA"),
  tech("energia_muscolare", "Energia muscolare (MET)", ["direct"]),
  tech("got", "TOG (trattamento osteopatico generale)", ["direct"]),
  tech("inibizione", "Inibizione", ["direct"]),
  tech("fasciale", "Fasciale (rilascio miofasciale)", ["direct", "indirect"], true),
  tech("craniale", "Craniale (osteopatia in campo craniale)", ["indirect", "direct"], true),
  tech("viscerale", "Viscerale", ["indirect", "direct"], true),
  tech("still", "Tecnica di Still", ["direct", "indirect"], true, "Tecnica di Still"),
  tech("funzionale", "Funzionale", ["indirect"]),
  tech("counterstrain", "Strain-counterstrain", ["indirect"]),
  tech("blt", "Tensione legamentosa bilanciata", ["indirect"]),
  tech("linfatica", "Pompa linfatica", ["indirect"]),
  tech("riflessi", "Neuromuscolare e punti riflessi", ["indirect"]),
  tech("altra", "Altra tecnica", ["direct", "indirect"], true, ""),
];

/**
 * Le tecniche il cui approccio si dichiara sempre: fasciale, Still e "Altra tecnica". Craniale e
 * viscerale senza approccio valgono la famiglia predefinita del catalogo (indiretta).
 */
export const APPROACH_DECLARED: readonly TechniqueCode[] = ["fasciale", "still", "altra"];

export function technique(code: string): Technique | undefined {
  return TECHNIQUES.find((t) => t.code === code);
}

// ---------------------------------------------------------------------------------------------------
// Test. Il codice `libero` non è nel catalogo: il test libero ha il suo nome (`custom_label`).

export type ResultType = "binary" | "lateral" | "numeric" | "ordinal";

/** Il codice del test libero: non è nel catalogo, ha il suo nome (`custom_label`). */
export const FREE_TEST = "libero";
type TestCategory = "osteopatico" | "ortopedico" | "neurodinamico" | "neurologico" | "mobilita" | "pediatrico";
type Better = "higher" | "lower" | "none";

export interface TestDefinition {
  code: string;
  name: string;
  region: RegionCode;
  category: TestCategory;
  resultType: ResultType;
  unit: string | null;
  min: number | null;
  max: number | null;
  step: number | null;
  perSide: boolean;
  betterDirection: Better;
  ordinalLabels: readonly string[] | null;
  instructions: string | null;
  sources: readonly string[];
  activeByDefault: boolean;
  sort: number;
}

interface TestRow {
  code: string;
  name: string;
  region: RegionCode;
  category: TestCategory;
  type: ResultType;
  /** Unità, intervallo e passo dei test numerici. */
  num?: { unit: string | null; min: number; max: number; step: number };
  labels?: readonly string[];
  perSide: boolean;
  better: Better;
  sources?: readonly string[];
  off?: boolean;
}

function buildTests(rows: readonly TestRow[]): TestDefinition[] {
  return rows.map((r, i) => ({
    code: r.code,
    name: r.name,
    region: r.region,
    category: r.category,
    resultType: r.type,
    unit: r.num?.unit ?? null,
    min: r.num?.min ?? null,
    max: r.num?.max ?? null,
    step: r.num?.step ?? null,
    perSide: r.perSide,
    betterDirection: r.better,
    ordinalLabels: r.labels ?? null,
    instructions: null,
    sources: r.sources ?? [],
    activeByDefault: !r.off,
    sort: (i + 1) * 10,
  }));
}

const E = "https://europepmc.org/article/";
const DEGREES = { unit: "°", min: 0, max: 180, step: 1 };
const CERVICAL_DEGREES = { unit: "°", min: 0, max: 90, step: 1 };
const CM = { unit: "cm", min: 0, max: 60, step: 0.5 };
const ASLR_LABELS = [
  "0 nessuna difficoltà",
  "1 minima",
  "2 un po' difficile",
  "3 abbastanza difficile",
  "4 molto difficile",
  "5 impossibile",
];

export const TESTS: readonly TestDefinition[] = buildTests([
  { code: "flessione_in_piedi", name: "TFE (test di flessione eretta)", region: "pelvic", category: "osteopatico", type: "lateral", perSide: false, better: "none", sources: [`${E}MED/10509062`, `${E}MED/34551460`] },
  { code: "flessione_da_seduto", name: "TFS (test di flessione seduta)", region: "sacral", category: "osteopatico", type: "lateral", perSide: false, better: "none", sources: [`${E}MED/34551460`] },
  { code: "gillet", name: "Test di Gillet (cicogna)", region: "pelvic", category: "osteopatico", type: "lateral", perSide: false, better: "none", sources: [`${E}MED/10029942`] },
  { code: "aslr", name: "Sollevamento attivo della gamba tesa (ASLR)", region: "pelvic", category: "ortopedico", type: "ordinal", labels: ASLR_LABELS, perSide: true, better: "lower", sources: [`${E}MED/11413432`] },
  { code: "provocazione_si", name: "Provocazione sacroiliaca (5 test di Laslett)", region: "sacral", category: "ortopedico", type: "numeric", num: { unit: null, min: 0, max: 5, step: 1 }, perSide: false, better: "lower", sources: [`${E}MED/16038856`] },
  { code: "faber", name: "Test di Patrick (FABER)", region: "pelvic", category: "ortopedico", type: "binary", perSide: true, better: "none", sources: [`${E}MED/37650318`] },
  { code: "trendelenburg", name: "Test di Trendelenburg", region: "pelvic", category: "ortopedico", type: "binary", perSide: true, better: "none", sources: [`${E}MED/42152900`], off: true },
  { code: "dita_pavimento", name: "Distanza dita-pavimento", region: "lumbar", category: "mobilita", type: "numeric", num: CM, perSide: false, better: "lower", sources: [`${E}MED/11689977`] },
  { code: "schober_modificato", name: "Schober modificato", region: "lumbar", category: "mobilita", type: "numeric", num: CM, perSide: false, better: "higher", sources: [`${E}MED/16019864`, `${E}MED/38443445`], off: true },
  { code: "slump", name: "Slump test", region: "lumbar", category: "neurodinamico", type: "binary", perSide: true, better: "none", sources: [`${E}MED/18391677`] },
  { code: "slr", name: "Test di Lasègue (sollevamento passivo della gamba tesa)", region: "lower_extremity", category: "neurodinamico", type: "numeric", num: DEGREES, perSide: true, better: "higher", sources: ["Majlesi 2008"] },
  { code: "thomas_modificato", name: "Test di Thomas modificato", region: "lower_extremity", category: "mobilita", type: "binary", perSide: true, better: "none", sources: [`${E}MED/35248293`] },
  { code: "flessione_rotazione", name: "Flessione-rotazione cervicale (cefalea cervicogenica)", region: "cervical", category: "mobilita", type: "numeric", num: CERVICAL_DEGREES, perSide: true, better: "higher", sources: [`${E}MED/20508964`, "https://pmc.ncbi.nlm.nih.gov/articles/PMC3452271/"] },
  { code: "rom_rotazione_cervicale", name: "Rotazione cervicale attiva", region: "cervical", category: "mobilita", type: "numeric", num: CERVICAL_DEGREES, perSide: true, better: "higher", sources: [`${E}MED/1989013`] },
  { code: "spurling", name: "Test di Spurling (compressione foraminale)", region: "cervical", category: "ortopedico", type: "binary", perSide: true, better: "none", sources: [`${E}MED/12544957`, `${E}MED/22806265`] },
  { code: "ultt_a", name: "Neurodinamico arto superiore (mediano)", region: "upper_extremity", category: "neurodinamico", type: "binary", perSide: true, better: "none", sources: ["Wainner 2003"], off: true },
  { code: "neer", name: "Segno di Neer", region: "upper_extremity", category: "ortopedico", type: "binary", perSide: true, better: "none", sources: [`${E}MED/17720798`] },
  { code: "hawkins", name: "Hawkins-Kennedy", region: "upper_extremity", category: "ortopedico", type: "binary", perSide: true, better: "none", sources: [`${E}MED/22773322`] },
  { code: "adams", name: "Test di Adams (flessione in avanti)", region: "thoracic", category: "ortopedico", type: "lateral", perSide: false, better: "none", sources: [`${E}MED/10586455`] },
  { code: "espansione_toracica", name: "Espansione toracica", region: "rib_cage", category: "mobilita", type: "numeric", num: { unit: "cm", min: 0, max: 15, step: 0.5 }, perSide: false, better: "higher", sources: [`${E}PMC/PMC4316520`] },
  { code: "apertura_bocca", name: "Apertura massima della bocca", region: "head", category: "mobilita", type: "numeric", num: { unit: "mm", min: 0, max: 80, step: 1 }, perSide: false, better: "higher", sources: [`${E}PMC/PMC4478082`] },
  { code: "cvai", name: "Indice di asimmetria della volta cranica (CVAI)", region: "head", category: "pediatrico", type: "numeric", num: { unit: "%", min: 0, max: 30, step: 0.1 }, perSide: false, better: "lower", sources: [`${E}PMC/PMC7766735`] },
  { code: "argenta", name: "Classificazione di Argenta della plagiocefalia", region: "head", category: "pediatrico", type: "ordinal", labels: ["Tipo I", "Tipo II", "Tipo III", "Tipo IV", "Tipo V"], perSide: false, better: "lower", sources: [`${E}MED/15111792`] },
  { code: "rotazione_lattante", name: "Rotazione cervicale passiva nel lattante", region: "cervical", category: "pediatrico", type: "numeric", num: CERVICAL_DEGREES, perSide: true, better: "higher" },
  { code: "ober", name: "Test di Ober", region: "lower_extremity", category: "ortopedico", type: "binary", perSide: true, better: "none" },
  { code: "lunge_carico", name: "Lunge test in carico (distanza dal muro)", region: "lower_extremity", category: "mobilita", type: "numeric", num: { unit: "cm", min: 0, max: 20, step: 0.5 }, perSide: true, better: "higher" },
  { code: "derbolowsky", name: "Lunghezza degli arti inferiori (Derbolowsky)", region: "pelvic", category: "osteopatico", type: "lateral", perSide: false, better: "none" },
]);

const REFLEX_LABELS = ["normale", "ridotto", "assente"];
const STRENGTH = { unit: null, min: 0, max: 5, step: 1 };

/** Esame neurologico: non conta fra i test attivi e non compare nell'elenco dei test. */
export const NEURO_TESTS: readonly TestDefinition[] = buildTests([
  { code: "riflesso_bicipitale", name: "Riflesso bicipitale", region: "upper_extremity", category: "neurologico", type: "ordinal", labels: REFLEX_LABELS, perSide: true, better: "lower" },
  { code: "riflesso_tricipitale", name: "Riflesso tricipitale", region: "upper_extremity", category: "neurologico", type: "ordinal", labels: REFLEX_LABELS, perSide: true, better: "lower" },
  { code: "riflesso_rotuleo", name: "Riflesso rotuleo", region: "lower_extremity", category: "neurologico", type: "ordinal", labels: REFLEX_LABELS, perSide: true, better: "lower" },
  { code: "riflesso_achilleo", name: "Riflesso achilleo", region: "lower_extremity", category: "neurologico", type: "ordinal", labels: REFLEX_LABELS, perSide: true, better: "lower" },
  ...(["c5", "c6", "c7", "c8", "t1"] as const).map((s): TestRow => ({ code: `forza_${s}`, name: `Forza ${s.toUpperCase()}`, region: "upper_extremity", category: "neurologico", type: "numeric", num: STRENGTH, perSide: true, better: "higher" })),
  ...(["l2", "l3", "l4", "l5", "s1"] as const).map((s): TestRow => ({ code: `forza_${s}`, name: `Forza ${s.toUpperCase()}`, region: "lower_extremity", category: "neurologico", type: "numeric", num: STRENGTH, perSide: true, better: "higher" })),
  { code: "sensibilita_as", name: "Sensibilità arto superiore", region: "upper_extremity", category: "neurologico", type: "binary", perSide: true, better: "none" },
  { code: "sensibilita_ai", name: "Sensibilità arto inferiore", region: "lower_extremity", category: "neurologico", type: "binary", perSide: true, better: "none" },
  { code: "babinski", name: "Babinski", region: "lower_extremity", category: "neurologico", type: "binary", perSide: true, better: "none" },
  { code: "hoffmann", name: "Hoffmann", region: "upper_extremity", category: "neurologico", type: "binary", perSide: true, better: "none" },
]);

export function testDefinition(code: string): TestDefinition | undefined {
  return TESTS.find((t) => t.code === code) ?? NEURO_TESTS.find((t) => t.code === code);
}

/** I 24 test accesi alla creazione delle impostazioni cliniche. */
export const DEFAULT_ACTIVE_TEST_CODES: readonly string[] = TESTS.filter((t) => t.activeByDefault).map((t) => t.code);

// ---------------------------------------------------------------------------------------------------
// Modelli di consiglio: proposte da far rileggere a un osteopata.

export interface AdviceTemplate {
  code: string;
  title: string;
  body: string;
  regions: readonly RegionCode[] | "all";
  infantOnly: boolean;
}

export const ADVICE_TEMPLATES: readonly AdviceTemplate[] = [
  {
    code: "idratazione_riposo",
    title: "Idratazione e riposo",
    body: "Oggi bevi un po' più del solito e tieni un ritmo tranquillo per il resto della giornata.",
    regions: "all",
    infantOnly: false,
  },
  {
    code: "indolenzimento",
    title: "Possibile indolenzimento",
    body: "Nelle 24-48 ore puoi sentire un leggero indolenzimento: è frequente e passa da solo. Se il dolore aumenta molto o compaiono sintomi nuovi, scrivimi.",
    regions: "all",
    infantOnly: false,
  },
  {
    code: "collo_3_movimenti",
    title: "Mobilità del collo",
    body: "Tre volte al giorno, piano e senza forzare: 5 rotazioni per lato, 5 inclinazioni per lato, 5 flessioni in avanti.",
    regions: ["head", "cervical"],
    infantOnly: false,
  },
  {
    code: "flessori_anca",
    title: "Allungamento dei flessori dell'anca",
    body: "In affondo con un ginocchio a terra, porta il bacino in avanti finché senti tirare davanti all'anca. 30 secondi per lato, 2 volte.",
    regions: ["lumbar", "pelvic", "lower_extremity"],
    infantOnly: false,
  },
  {
    code: "respirazione",
    title: "Respirazione diaframmatica",
    body: "Sdraiato o seduto, una mano sulla pancia: inspira dal naso gonfiando la pancia, espira piano dalla bocca. 5 minuti al giorno.",
    regions: ["thoracic", "rib_cage", "abdomen_other"],
    infantOnly: false,
  },
  {
    code: "pause_attive",
    title: "Pause attive al computer",
    body: "Ogni 45 minuti alzati, cammina un minuto e muovi spalle e collo.",
    regions: ["cervical", "thoracic", "lumbar", "upper_extremity"],
    infantOnly: false,
  },
  {
    code: "posizione_sonno",
    title: "Posizione nel sonno",
    body: "Dormi su un fianco con un cuscino fra le ginocchia, o a pancia in su con un cuscino sotto le ginocchia.",
    regions: ["cervical", "lumbar", "sacral", "pelvic"],
    infantOnly: false,
  },
  {
    code: "camminata",
    title: "Camminata quotidiana",
    body: "Cammina 20 minuti al giorno a passo comodo, su terreno piano.",
    regions: ["lumbar", "sacral", "pelvic", "lower_extremity"],
    infantOnly: false,
  },
  {
    code: "lattante_testa",
    title: "Posizione della testa",
    body: "Alterna il lato su cui appoggia la testa quando dorme e, da sveglio e sotto sorveglianza, mettilo a pancia in giù più volte al giorno.",
    regions: ["head", "cervical"],
    infantOnly: true,
  },
];
