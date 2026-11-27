import { describe, expect, it } from "vitest";

import { ADVICE_TEMPLATES } from "@/lib/clinical/catalog";
import { AMEND_TARGET_TWICE } from "@/lib/clinical/labels";
import {
  type AmendOp,
  amendCount,
  amendTargets,
  amendLine,
  applyAmendOps,
  isPendingId,
  mergeAmendOp,
  type MergeResult,
  pendingAdviceId,
  pendingId,
  toAmendOp,
} from "@/lib/visits/amend-list";
import type { VisitEditor } from "@/server/domain/visits/editor";

// La lista delle modifiche di una rettifica nel client:
// una voce cambiata due volte resta una sola operazione, con la stessa chiave del server
// (`requireUniqueTargets`), così «Salva la rettifica» non inciampa in «In una rettifica ogni voce si cambia una volta
// sola.»: un'operazione che riscrive la stessa riga sostituisce quella di prima, ogni altra sovrapposizione si rifiuta;
// e la vista mostra subito le modifiche della lista.

const FINDING_LEG = "11111111-1111-4111-8111-111111111111";
const FINDING_NECK = "22222222-2222-4222-8222-222222222222";
const TEST_ROW = "33333333-3333-4333-8333-333333333333";
const TREATMENT_ROW = "44444444-4444-4444-8444-444444444444";
const ADVICE_ROW = "55555555-5555-4555-8555-555555555555";
const PSFS_ITEM = "66666666-6666-4666-8666-666666666666";

const walk = ADVICE_TEMPLATES.find((t) => t.code === "camminata");
if (walk === undefined) throw new Error("manca il modello «camminata»");

/** La vista di una visita chiusa con quello che leggono le funzioni della lista. */
function closedView(): VisitEditor {
  return {
    visit: {
      fields: { nprsPre: 6, nprsPost: 3, treatmentResponse: "migliorato", subjectiveUpdate: null },
      screeningConfirmed: true,
    },
    cycle: {
      isFirstVisit: true,
      showsOpening: true,
      opening: { goal: "Salire le scale", expectedSessions: 4, planAgreedOn: null },
      psfs: [{ id: PSFS_ITEM, activity: "Pedalare", initial: 3 }],
    },
    findings: [
      { id: FINDING_LEG, region: "lower_extremity", isPrimary: true },
      { id: FINDING_NECK, region: "cervical", isPrimary: false },
    ],
    tests: [{ id: TEST_ROW, testCode: "thomas_modificato", customLabel: null, side: "dx" }],
    treatments: [{ id: TREATMENT_ROW, region: "lower_extremity", techniqueCode: "altra", customTechnique: "Mobilizzazione" }],
    advice: [{ id: ADVICE_ROW, templateCode: "flessori_anca", text: "Testo scritto", communicatedVia: ["a_voce"] }],
    screening: {
      groups: [
        {
          code: "rf_rachide",
          label: "Red flag del rachide",
          items: [
            { item: { code: "rf_ces_saddle" }, answer: { itemCode: "rf_ces_saddle", answer: "no", regions: [], subAnswers: [], fromHistory: false, note: null } },
            { item: { code: "rf_cancer" }, answer: null },
          ],
        },
      ],
      suggestion: {
        thrust: { suggested: "indicated" },
        direct: { suggested: "indicated" },
        indirect: { suggested: "indicated" },
      },
      outcomes: {
        thrust: { suggested: "indicated", outcome: "indicated", overrideNote: null, localContraindicated: [] },
        direct: { suggested: "indicated", outcome: "indicated", overrideNote: null, localContraindicated: [] },
        indirect: { suggested: "indicated", outcome: "indicated", overrideNote: null, localContraindicated: [] },
      },
      pills: ["Thrust: indicato", "Dirette: indicato", "Indirette: indicato"],
    },
    techniqueChecks: { cervical: { tessuti_molli: { kind: "ok" } } },
    approachChecks: {},
    previousByKey: { "ober|sx": "Positivo" },
  } as unknown as VisitEditor;
}

const parse = (raw: unknown): AmendOp => {
  const op = toAmendOp(raw);
  if (op === null) throw new Error(`operazione non valida: ${JSON.stringify(raw)}`);
  return op;
};

/** La lista dopo tutte le operazioni, che devono passare tutte. */
const add = (ops: readonly unknown[], base = closedView()): AmendOp[] =>
  ops.reduce<AmendOp[]>((list, raw) => {
    const result = mergeAmendOp(list, parse(raw), base);
    if (!result.ok) throw new Error(`rifiutata: ${JSON.stringify(raw)}`);
    return result.list;
  }, []);

/** L'ultima operazione sulla lista delle altre. */
const then = (ops: readonly unknown[], last: unknown, base = closedView()): MergeResult =>
  mergeAmendOp(add(ops, base), parse(last), base);

describe("toAmendOp", () => {
  it("accetta solo un oggetto con il nome dell'operazione", () => {
    expect(toAmendOp({ op: "campi", values: {} })).toEqual({ op: "campi", values: {} });
    expect(toAmendOp(null)).toBeNull();
    expect(toAmendOp("campi")).toBeNull();
    expect(toAmendOp({ values: {} })).toBeNull();
    expect(toAmendOp([{ op: "campi" }])).toBeNull();
  });
});

describe("amendTargets", () => {
  const base = closedView();
  const keys = (raw: unknown) => {
    const op = toAmendOp(raw);
    if (op === null) throw new Error("operazione non valida");
    return amendTargets(op, base);
  };

  it("dà le chiavi del server: campo, ciclo, risposta, gruppo, esiti, PSFS", () => {
    expect(keys({ op: "campi", values: { nprsPost: 2, nprsPre: undefined } })).toEqual(["campo:nprsPost"]);
    expect(keys({ op: "apertura", goal: "Correre", planAgreedOn: undefined })).toEqual(["ciclo:goal"]);
    expect(keys({ op: "risposta", itemCode: "rf_ces_saddle", answer: "no" })).toEqual(["risposta:rf_ces_saddle"]);
    expect(keys({ op: "nessun_altra_voce", group: "rf_rachide" })).toContain("risposta:rf_ces_saddle");
    expect(keys({ op: "esiti", outcomes: [] })).toEqual(["esiti"]);
    expect(keys({ op: "psfs", itemId: PSFS_ITEM, score: 5 })).toEqual([`psfs:${PSFS_ITEM}`]);
  });

  it("risolve gli id nella chiave della loro riga, come il server", () => {
    expect(keys({ op: "togli_test", resultId: TEST_ROW })).toEqual(keys({ op: "test", testCode: "thomas_modificato", side: "dx" }));
    expect(keys({ op: "togli_tecnica", treatmentId: TREATMENT_ROW })).toEqual(
      keys({ op: "tecnica", region: "lower_extremity", techniqueCode: "altra", customTechnique: "MOBILIZZAZIONE" }),
    );
    expect(keys({ op: "togli_consiglio", adviceId: ADVICE_ROW })).toEqual([`consiglio:${ADVICE_ROW}`]);
    // Un consiglio senza id prende la riga del suo modello, se la visita ce l'ha.
    expect(keys({ op: "consiglio", templateCode: "flessori_anca", communicatedVia: ["a_voce"] })).toEqual([
      `consiglio:${ADVICE_ROW}`,
    ]);
    expect(keys({ op: "consiglio", templateCode: "camminata", communicatedVia: ["a_voce"] })).toEqual([
      "consiglio-modello:camminata",
    ]);
    expect(keys({ op: "conferma", target: { table: "findings", id: FINDING_NECK } })).toEqual(["disfunzione:cervical"]);
  });

  it("una disfunzione primaria tocca anche la primaria di prima e la chiave condivisa", () => {
    expect(keys({ op: "disfunzione", region: "cervical", severity: 2, isPrimary: true })).toEqual([
      "disfunzione:cervical",
      "disfunzione:primaria",
      "disfunzione:lower_extremity",
    ]);
    expect(keys({ op: "disfunzione", region: "lower_extremity", severity: 3, isPrimary: true })).toEqual([
      "disfunzione:lower_extremity",
      "disfunzione:primaria",
    ]);
    expect(keys({ op: "togli_disfunzione", region: "cervical" })).toEqual(["disfunzione:cervical"]);
  });
});

describe("mergeAmendOp", () => {
  it("i campi della visita stanno in una sola operazione: la scelta dopo vince", () => {
    const list = add([
      { op: "campi", values: { nprsPost: 2 } },
      { op: "campi", values: { treatmentResponse: "invariato" } },
      { op: "campi", values: { nprsPost: 1 } },
    ]);
    expect(list).toEqual([{ op: "campi", values: { nprsPost: 1, treatmentResponse: "invariato" } }]);
  });

  it("i campi d'apertura stanno in una sola operazione `apertura`", () => {
    const list = add([
      { op: "apertura", goal: "Correre" },
      { op: "psfs", itemId: PSFS_ITEM, score: 4 },
      { op: "apertura", planAgreedOn: "2026-11-02" },
      { op: "apertura", goal: "Correre 5 km" },
    ]);
    expect(list).toEqual([
      { op: "psfs", itemId: PSFS_ITEM, score: 4 },
      { op: "apertura", goal: "Correre 5 km", planAgreedOn: "2026-11-02" },
    ]);
  });

  it("una voce cambiata di nuovo sostituisce l'operazione di prima e va in fondo", () => {
    const list = add([
      { op: "tecnica", region: "lower_extremity", techniqueCode: "tessuti_molli", tolerance: "buona" },
      { op: "test", testCode: "thomas_modificato", side: "dx", valueNumeric: 10 },
      { op: "tecnica", region: "lower_extremity", techniqueCode: "tessuti_molli", tolerance: "fastidio" },
    ]);
    expect(list).toEqual([
      { op: "test", testCode: "thomas_modificato", side: "dx", valueNumeric: 10 },
      { op: "tecnica", region: "lower_extremity", techniqueCode: "tessuti_molli", tolerance: "fastidio" },
    ]);
  });

  it("togliere una riga sostituisce la sua modifica, e scriverla di nuovo sostituisce il togli", () => {
    const removed = add([
      { op: "tecnica", region: "lower_extremity", techniqueCode: "altra", customTechnique: "Mobilizzazione", note: "x" },
      { op: "togli_tecnica", treatmentId: TREATMENT_ROW },
    ]);
    expect(removed).toEqual([{ op: "togli_tecnica", treatmentId: TREATMENT_ROW }]);
    const back = add([
      { op: "togli_test", resultId: TEST_ROW },
      { op: "test", testCode: "thomas_modificato", side: "dx", valueNumeric: 12 },
    ]);
    expect(back).toEqual([{ op: "test", testCode: "thomas_modificato", side: "dx", valueNumeric: 12 }]);
  });

  it("dopo una risposta cambiata di nuovo gli esiti restano prima: il server chiede di riconfermare", () => {
    const list = add([
      { op: "risposta", itemCode: "rf_ces_saddle", answer: "si" },
      { op: "esiti", outcomes: [1] },
      { op: "risposta", itemCode: "rf_ces_saddle", answer: "no" },
      { op: "esiti", outcomes: [2] },
    ]);
    expect(list.map((o) => o.op)).toEqual(["risposta", "esiti"]);
    expect(list[0]).toMatchObject({ answer: "no" });
    expect(list[1]).toMatchObject({ outcomes: [2] });
  });

  it("«Nessun'altra voce» su un gruppo con una risposta in attesa si rifiuta, e al contrario; su un altro gruppo passa", () => {
    const answers = [
      { op: "risposta", itemCode: "rf_ces_saddle", answer: "si" },
      { op: "risposta", itemCode: "ci_avk", answer: "no" },
    ];
    expect(then(answers, { op: "nessun_altra_voce", group: "rf_rachide" })).toEqual({ ok: false, message: AMEND_TARGET_TWICE });
    expect(then([{ op: "nessun_altra_voce", group: "rf_rachide" }], answers[0])).toEqual({ ok: false, message: AMEND_TARGET_TWICE });
    expect(then(answers, { op: "nessun_altra_voce", group: "ci_locale" })).toMatchObject({ ok: true });
    // Lo stesso gruppo detto due volte è la stessa modifica.
    expect(add([{ op: "nessun_altra_voce", group: "ci_locale" }, { op: "nessun_altra_voce", group: "ci_locale" }])).toHaveLength(1);
  });

  it("la primaria di prima cambiata, poi un'altra regione primaria: rifiutata, la modifica di prima resta", () => {
    const before = [{ op: "disfunzione", region: "lower_extremity", severity: 3, isPrimary: true }];
    expect(then(before, { op: "disfunzione", region: "cervical", severity: 2, isPrimary: true })).toEqual({
      ok: false,
      message: AMEND_TARGET_TWICE,
    });
    // Anche al contrario: la regione che perde la primaria non si scrive nella stessa rettifica.
    const primary = [{ op: "disfunzione", region: "cervical", severity: 2, isPrimary: true }];
    expect(then(primary, { op: "disfunzione", region: "lower_extremity", severity: 1, isPrimary: false })).toEqual({
      ok: false,
      message: AMEND_TARGET_TWICE,
    });
  });

  it("Y primaria e poi Z primaria: Y resta con la sua modifica, senza la primaria", () => {
    const list = add([
      { op: "disfunzione", region: "cervical", severity: 2, isPrimary: true },
      { op: "disfunzione", region: "thoracic", severity: 1, tenderness: true, isPrimary: true },
    ]);
    expect(list).toEqual([
      { op: "disfunzione", region: "cervical", severity: 2, isPrimary: false },
      { op: "disfunzione", region: "thoracic", severity: 1, tenderness: true, isPrimary: true },
    ]);
  });

  it("una tecnica, un test o una disfunzione nati nella rettifica e tolti non lasciano niente", () => {
    const base = closedView();
    const soft = { op: "tecnica", region: "cervical", techniqueCode: "tessuti_molli", tolerance: "buona" };
    const view = applyAmendOps(base, add([soft], base));
    const row = view.treatments.find((t) => t.techniqueCode === "tessuti_molli");
    expect(row?.id).toBe(pendingId("tecnica:cervical:tessuti_molli:"));
    expect(isPendingId(row?.id ?? "")).toBe(true);
    expect(add([soft, { op: "togli_tecnica", treatmentId: row?.id }], base)).toEqual([]);

    const ober = { op: "test", testCode: "ober", side: "sx", valueBool: true };
    const testRow = applyAmendOps(base, add([ober], base)).tests.find((t) => t.testCode === "ober");
    expect(testRow).toMatchObject({ side: "sx", valueBool: true, copied: false });
    expect(add([ober, { op: "togli_test", resultId: testRow?.id }], base)).toEqual([]);

    const back = { op: "disfunzione", region: "thoracic", severity: 1, tenderness: true };
    expect(add([back, { op: "togli_disfunzione", region: "thoracic" }], base)).toEqual([]);
  });

  it("un consiglio spuntato e poi tolto prima di salvare non lascia niente", () => {
    const ticked = add([{ op: "consiglio", templateCode: "camminata", text: null, communicatedVia: ["a_voce"] }]);
    expect(ticked).toHaveLength(1);
    const view = applyAmendOps(closedView(), ticked);
    const pending = view.advice.find((a) => a.templateCode === "camminata");
    expect(pending?.id).toBe(pendingAdviceId("camminata"));
    expect(isPendingId(pending?.id ?? "")).toBe(true);
    expect(isPendingId(ADVICE_ROW)).toBe(false);

    // Un canale cambiato sulla riga in attesa: la stessa operazione, senza l'id che il server non conosce.
    const changed = add([
      { op: "consiglio", templateCode: "camminata", text: null, communicatedVia: ["a_voce"] },
      { op: "consiglio", adviceId: pendingAdviceId("camminata"), templateCode: "camminata", text: "Mezz'ora", communicatedVia: ["a_voce", "foglio_stampato"] },
    ]);
    expect(changed).toEqual([
      { op: "consiglio", templateCode: "camminata", text: "Mezz'ora", communicatedVia: ["a_voce", "foglio_stampato"] },
    ]);

    const untick = add([
      { op: "campi", values: { nprsPost: 2 } },
      { op: "consiglio", templateCode: "camminata", text: null, communicatedVia: ["a_voce"] },
      { op: "togli_consiglio", adviceId: pendingAdviceId("camminata") },
    ]);
    expect(untick).toEqual([{ op: "campi", values: { nprsPost: 2 } }]);
  });

  it("un consiglio salvato tolto e poi rispuntato resta una sola operazione", () => {
    const list = add([
      { op: "togli_consiglio", adviceId: ADVICE_ROW },
      { op: "consiglio", templateCode: "flessori_anca", text: null, communicatedVia: ["foglio_stampato"] },
    ]);
    expect(list).toEqual([{ op: "consiglio", templateCode: "flessori_anca", text: null, communicatedVia: ["foglio_stampato"] }]);
  });

  it("nessuna lista prodotta ha due operazioni sulla stessa voce (le rifiutate restano fuori)", () => {
    const base = closedView();
    const list = (
      [
        { op: "campi", values: { nprsPost: 2 } },
        { op: "disfunzione", region: "cervical", severity: 2, isPrimary: true },
        { op: "disfunzione", region: "lower_extremity", severity: 1 },
        { op: "risposta", itemCode: "rf_ces_saddle", answer: "si" },
        { op: "nessun_altra_voce", group: "rf_rachide" },
        { op: "esiti", outcomes: [] },
        { op: "togli_test", resultId: TEST_ROW },
        { op: "consiglio", templateCode: "flessori_anca", communicatedVia: ["a_voce"] },
        { op: "togli_consiglio", adviceId: ADVICE_ROW },
        { op: "campi", values: { nprsPost: 1 } },
      ] as const
    ).reduce<AmendOp[]>((acc, raw) => {
      const result = mergeAmendOp(acc, parse(raw), base);
      return result.ok ? result.list : acc;
    }, []);
    expect(list.map((o) => o.op)).toEqual(["disfunzione", "risposta", "esiti", "togli_test", "togli_consiglio", "campi"]);
    const seen = new Set<string>();
    for (const op of list) {
      for (const key of amendTargets(op, base)) {
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe("applyAmendOps", () => {
  it("senza modifiche la vista è la stessa", () => {
    const base = closedView();
    expect(applyAmendOps(base, [])).toBe(base);
  });

  it("mostra i campi, l'apertura, i punteggi PSFS e i consigli della lista", () => {
    const base = closedView();
    const view = applyAmendOps(
      base,
      add(
        [
          { op: "campi", values: { nprsPost: 2 } },
          { op: "apertura", planAgreedOn: "2026-11-02" },
          { op: "psfs", itemId: PSFS_ITEM, score: 5 },
          { op: "consiglio", templateCode: "camminata", text: null, communicatedVia: ["a_voce"] },
          { op: "togli_consiglio", adviceId: ADVICE_ROW },
        ],
        base,
      ),
    );
    expect(view.visit.fields.nprsPost).toBe(2);
    expect(view.visit.fields.nprsPre).toBe(6);
    expect(view.cycle.opening.planAgreedOn).toBe("2026-11-02");
    expect(view.cycle.opening.goal).toBe("Salire le scale");
    expect(view.cycle.psfs[0]?.initial).toBe(5);
    expect(view.advice).toEqual([
      { id: pendingAdviceId("camminata"), templateCode: "camminata", text: walk.body, communicatedVia: ["a_voce"] },
    ]);
    // Le parti che la lista non tocca restano le stesse: le bozze delle sezioni non ripartono.
    expect(view.findings).toBe(base.findings);
    expect(view.treatments).toBe(base.treatments);
    expect(view.screening).toBe(base.screening);
    // La vista del server non cambia.
    expect(base.visit.fields.nprsPost).toBe(3);
    expect(base.advice).toHaveLength(1);
  });

  it("mostra le risposte, gli esiti, le disfunzioni, i test e le tecniche della lista", () => {
    const base = closedView();
    const answered = applyAmendOps(base, add([{ op: "risposta", itemCode: "rf_ces_saddle", answer: "si" }], base));
    // Una risposta toglie la conferma: niente pillole finché gli esiti non sono nella lista.
    expect(answered.screening.groups[0]?.items[0]?.answer).toMatchObject({ answer: "si", fromHistory: false });
    expect(answered.screening.outcomes).toBeNull();
    expect(answered.screening.pills).toEqual([]);
    expect(answered.visit.screeningConfirmed).toBe(false);

    const outcomes = [
      { family: "thrust", outcome: "contraindicated", overrideNote: null },
      { family: "direct", outcome: "caution", overrideNote: null },
      { family: "indirect", outcome: "indicated", overrideNote: null },
    ];
    const view = applyAmendOps(
      base,
      add(
        [
          { op: "nessun_altra_voce", group: "rf_rachide" },
          { op: "esiti", outcomes },
          { op: "disfunzione", region: "thoracic", severity: 1, tenderness: true, isPrimary: true },
          { op: "test", testCode: "ober", side: "sx", valueBool: false },
          { op: "tecnica", region: "cervical", techniqueCode: "tessuti_molli", tolerance: "fastidio" },
          { op: "togli_tecnica", treatmentId: TREATMENT_ROW },
        ],
        base,
      ),
    );
    expect(view.screening.groups[0]?.items[1]?.answer).toMatchObject({ itemCode: "rf_cancer", answer: "no" });
    expect(view.screening.pills).toEqual(["Thrust: controindicato", "Dirette: con cautela", "Indirette: indicato"]);
    expect(view.visit.screeningConfirmed).toBe(true);
    expect(view.findings.map((f) => [f.region, f.isPrimary])).toEqual([
      ["cervical", false],
      ["thoracic", true],
      ["lower_extremity", false],
    ]);
    const ober = view.tests.find((t) => t.testCode === "ober");
    expect(ober).toMatchObject({ side: "sx", valueBool: false, previousText: "Positivo", name: "Test di Ober" });
    expect(view.treatments.map((t) => [t.region, t.techniqueCode, t.tolerance, t.family])).toEqual([
      ["cervical", "tessuti_molli", "fastidio", "direct"],
    ]);
    expect(view.treatments[0]?.check).toEqual({ kind: "ok" });
  });

  it("dice ogni modifica in una riga", () => {
    const base = closedView();
    const line = (raw: unknown) => amendLine(parse(raw), base);
    expect(line({ op: "campi", values: { nprsPost: 2, treatmentResponse: "invariato" } })).toBe(
      "Dolore 0-10 (NRS) a fine seduta, Risposta al trattamento",
    );
    expect(line({ op: "apertura", goal: "Correre" })).toBe("Apertura del ciclo: Obiettivo");
    expect(line({ op: "psfs", itemId: PSFS_ITEM, score: 4 })).toBe("PSFS: Pedalare");
    expect(line({ op: "disfunzione", region: "cervical", isPrimary: true })).toBe("Disfunzione: Cervicale, primaria");
    expect(line({ op: "togli_tecnica", treatmentId: TREATMENT_ROW })).toBe("Tecnica tolta: Mobilizzazione, Arto inferiore");
    expect(line({ op: "tecnica", region: "cervical", techniqueCode: "hvla" })).toBe("Tecnica: HVLA, Cervicale");
    expect(line({ op: "consiglio", templateCode: "camminata" })).toBe("Consiglio: Camminata quotidiana");
    expect(line({ op: "test", testCode: "ober", side: "sx" })).toBe("Test: Test di Ober sx");
    expect(line({ op: "esiti", outcomes: [] })).toBe("Esiti dello screening");
  });

  it("un consiglio salvato cambiato mostra il testo e i canali nuovi", () => {
    const base = closedView();
    const view = applyAmendOps(
      base,
      add([{ op: "consiglio", adviceId: ADVICE_ROW, templateCode: "flessori_anca", text: "Altro testo", communicatedVia: ["foglio_stampato"] }], base),
    );
    expect(view.advice).toEqual([
      { id: ADVICE_ROW, templateCode: "flessori_anca", text: "Altro testo", communicatedVia: ["foglio_stampato"] },
    ]);
  });
});

describe("amendCount", () => {
  it("conta le voci cambiate: ogni campo della visita o d'apertura, ogni altra operazione una volta", () => {
    expect(amendCount([])).toBe(0);
    expect(
      amendCount(
        add([
          { op: "campi", values: { nprsPost: 2 } },
          { op: "campi", values: { treatmentResponse: "invariato" } },
          { op: "apertura", goal: "Correre" },
          { op: "psfs", itemId: PSFS_ITEM, score: 4 },
        ]),
      ),
    ).toBe(4);
  });
});
