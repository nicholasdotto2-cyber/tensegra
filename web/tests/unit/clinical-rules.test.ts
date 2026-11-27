import { describe, expect, it, vi } from "vitest";
import type { Family, RegionCode, ScreeningItem } from "@/lib/clinical/catalog";
import {
  OVERRIDE_NOTE_MIN,
  SCREENING_FIRST,
  checkTreatment,
  historyAnswers,
  needsOverrideNote,
  outcomeRank,
  pillText,
  referralPrompts,
  riskTagsForDrug,
  suggestOutcomes,
  techniqueFamily,
  techniqueName,
  urgentRedFlag,
  visibleGroups,
  visibleItems,
  type Answer,
  type FamilySuggestion,
  type GroupContext,
  type PromptInput,
  type ScreeningAnswer,
  type ScreeningState,
} from "@/lib/clinical/rules";

function ans(itemCode: string, answer: Answer, extra: Partial<ScreeningAnswer> = {}): ScreeningAnswer {
  return { itemCode, answer, regions: [], subAnswers: [], fromHistory: false, note: null, ...extra };
}

function suggested(s: Record<Family, FamilySuggestion>) {
  return { thrust: s.thrust.suggested, direct: s.direct.suggested, indirect: s.indirect.suggested };
}

/** Lo stato salvato: gli esiti scelti, con le regioni locali del suggerimento. */
function state(
  suggestion: Record<Family, FamilySuggestion>,
  chosen: Partial<Record<Family, "indicated" | "caution" | "contraindicated">> = {},
): ScreeningState {
  const one = (f: Family) => ({
    outcome: chosen[f] ?? suggestion[f].suggested,
    localContraindicated: suggestion[f].localContraindicated,
  });
  return { outcomes: { thrust: one("thrust"), direct: one("direct"), indirect: one("indirect") }, suggestion };
}

const T = (region: RegionCode, techniqueCode: Parameters<typeof techniqueFamily>[0], approach: "direct" | "indirect" | null = null) => ({
  region,
  techniqueCode,
  approach,
  customTechnique: null,
});

describe("suggestOutcomes", () => {
  it("TAO da anamnesi: thrust e dirette controindicate, indirette indicate, con il motivo", () => {
    const s = suggestOutcomes([ans("ci_avk", "si", { fromHistory: true })]);
    expect(suggested(s)).toEqual({ thrust: "contraindicated", direct: "contraindicated", indirect: "indicated" });
    expect(s.thrust.reason).toBe("terapia anticoagulante");
    expect(s.direct.reason).toBe("terapia anticoagulante");
    expect(s.indirect.reason).toBeNull();
    expect(s.direct.toVerify).toEqual([]);
  });

  it("esempio: dirette portate a con cautela, HVLA bloccata, MET e articolatoria con cautela, funzionale e craniale libere", () => {
    const s = suggestOutcomes([ans("ci_avk", "si", { fromHistory: true })]);
    const st = state(s, { thrust: "contraindicated", direct: "caution", indirect: "indicated" });
    expect(checkTreatment(T("lumbar", "hvla"), st)).toEqual({
      kind: "blocked",
      text: "HVLA controindicata in questa visita: terapia anticoagulante. Cambia l'esito dello screening se hai nuove informazioni.",
    });
    expect(checkTreatment(T("lumbar", "energia_muscolare"), st)).toEqual({ kind: "caution", text: "Con cautela" });
    expect(checkTreatment(T("lumbar", "articolatoria"), st).kind).toBe("caution");
    expect(checkTreatment(T("lumbar", "funzionale"), st)).toEqual({ kind: "ok" });
    expect(checkTreatment(T("head", "craniale", "indirect"), st)).toEqual({ kind: "ok" });
  });

  it("NAO: dirette con cautela, thrust controindicato, niente da verificare", () => {
    const s = suggestOutcomes([ans("ci_nao", "si")]);
    expect(s.direct.suggested).toBe("caution");
    expect(s.thrust.suggested).toBe("contraindicated");
    expect(s.direct.toVerify).toEqual([]);
    expect(s.thrust.toVerify).toEqual([]);
  });

  it("non_so su una voce controindicata vale con cautela e resta da verificare", () => {
    const s = suggestOutcomes([ans("ci_avk", "non_so")]);
    expect(s.direct.suggested).toBe("caution");
    expect(s.thrust.suggested).toBe("caution");
    expect(s.indirect.suggested).toBe("indicated");
    expect(s.direct.toVerify).toEqual(["da verificare"]);
    expect(s.direct.reason).toBe("terapia anticoagulante");
    expect(s.indirect.toVerify).toEqual([]);
  });

  it("le risposte no non portano niente", () => {
    const s = suggestOutcomes([ans("ci_avk", "no"), ans("rf_ces_saddle", "no")]);
    expect(suggested(s)).toEqual({ thrust: "indicated", direct: "indicated", indirect: "indicated" });
  });

  it("voce locale: l'esito globale resta indicato, la regione va fra le controindicate col suo motivo", () => {
    const s = suggestOutcomes([ans("loc_aorta", "si", { regions: ["lumbar"] })]);
    expect(suggested(s)).toEqual({ thrust: "indicated", direct: "indicated", indirect: "indicated" });
    expect(s.thrust.localContraindicated).toEqual(["lumbar"]);
    expect(s.direct.localContraindicated).toEqual(["lumbar"]);
    expect(s.indirect.localContraindicated).toEqual([]);
    expect(s.direct.localReasons.lumbar).toBe("aneurisma aortico");
    const st = state(s);
    expect(checkTreatment(T("lumbar", "tessuti_molli"), st)).toEqual({
      kind: "blocked",
      text: "Tecnica tessuti molli controindicata in questa visita: aneurisma aortico. Cambia l'esito dello screening se hai nuove informazioni.",
    });
    expect(checkTreatment(T("cervical", "tessuti_molli"), st)).toEqual({ kind: "ok" });
    expect(checkTreatment(T("lumbar", "funzionale"), st)).toEqual({ kind: "ok" });
  });

  it("voce locale con cautela: la regione va fra quelle con cautela", () => {
    const s = suggestOutcomes([ans("cv_risk", "si", { regions: ["cervical"], subAnswers: ["fumo"] })]);
    expect(s.direct.localCaution).toEqual(["cervical"]);
    expect(s.thrust.localCaution).toEqual(["cervical"]);
    expect(s.direct.suggested).toBe("indicated");
    expect(checkTreatment(T("cervical", "articolatoria"), state(s))).toEqual({ kind: "caution", text: "Con cautela" });
    expect(checkTreatment(T("lumbar", "articolatoria"), state(s))).toEqual({ kind: "ok" });
  });

  it("thrust eredita le dirette; mezzi di sintesi tocca solo il thrust", () => {
    const s = suggestOutcomes([ans("cv_trauma", "si")]);
    expect(s.thrust.suggested).toBe("contraindicated");
    expect(s.direct.suggested).toBe("caution");
    const fix = suggestOutcomes([ans("loc_fixation", "si", { regions: ["lower_extremity"] })]);
    expect(fix.thrust.localContraindicated).toEqual(["lower_extremity"]);
    expect(fix.direct.localContraindicated).toEqual([]);
    expect(fix.direct.localCaution).toEqual([]);
    const cervical = suggestOutcomes([ans("loc_whiplash", "si", { regions: ["cervical"] })]);
    expect(cervical.thrust.localCaution).toEqual(["cervical"]);
    expect(cervical.direct.localCaution).toEqual([]);
  });

  it("non_so su una voce locale senza regioni vale con cautela sulle regioni proposte", () => {
    const s = suggestOutcomes([ans("loc_aorta", "non_so")]);
    expect(suggested(s)).toEqual({ thrust: "indicated", direct: "indicated", indirect: "indicated" });
    expect(s.thrust.localCaution).toEqual(["lumbar", "abdomen_other"]);
    expect(s.direct.localCaution).toEqual(["lumbar", "abdomen_other"]);
    expect(s.indirect.localCaution).toEqual([]);
    expect(s.direct.localContraindicated).toEqual([]);
    expect(s.direct.toVerify).toEqual(["da verificare"]);
    expect(checkTreatment(T("lumbar", "hvla"), state(s))).toEqual({ kind: "caution", text: "Con cautela" });
    expect(checkTreatment(T("lumbar", "tessuti_molli"), state(s))).toEqual({ kind: "caution", text: "Con cautela" });
    expect(checkTreatment(T("cervical", "hvla"), state(s))).toEqual({ kind: "ok" });
  });

  it("una regione locale tolta dagli esiti salvati resta con cautela, mai libera", () => {
    const s = suggestOutcomes([
      ans("loc_aorta", "si", { regions: ["lumbar"] }),
      ans("loc_disc", "si", { regions: ["lumbar"] }),
    ]);
    expect(s.thrust.localContraindicated).toEqual(["lumbar"]);
    expect(s.thrust.localCaution).toEqual([]);
    const saved: ScreeningState = {
      ...state(s),
      outcomes: { ...state(s).outcomes, thrust: { outcome: "indicated", localContraindicated: [] } },
    };
    expect(checkTreatment(T("lumbar", "hvla"), saved)).toEqual({ kind: "caution", text: "Con cautela" });
    expect(checkTreatment(T("lumbar", "hvla"), state(s)).kind).toBe("blocked");
  });

  it("non_so su un red flag di emergenza: tre famiglie con cautela, tutte da verificare", () => {
    const s = suggestOutcomes([ans("rf_ces_saddle", "non_so")]);
    expect(suggested(s)).toEqual({ thrust: "caution", direct: "caution", indirect: "caution" });
    expect(s.thrust.toVerify).toEqual(["da verificare"]);
    expect(s.direct.toVerify).toEqual(["da verificare"]);
    expect(s.indirect.toVerify).toEqual(["da verificare"]);
    expect(s.indirect.reason).toBe("anestesia a sella");
  });

  it("red flag in gravidanza controindica tutte le famiglie e conta come urgente; calo di peso no", () => {
    const preg = [ans("rf_preg_bleeding", "si")];
    expect(suggested(suggestOutcomes(preg))).toEqual({
      thrust: "contraindicated",
      direct: "contraindicated",
      indirect: "contraindicated",
    });
    expect(urgentRedFlag(preg)).toBe(true);
    const weight = [ans("rf_weight", "si")];
    expect(suggested(suggestOutcomes(weight))).toEqual({ thrust: "indicated", direct: "indicated", indirect: "indicated" });
    expect(urgentRedFlag(weight)).toBe(false);
    expect(urgentRedFlag([ans("rf_preg_bleeding", "non_so")])).toBe(false);
  });

  it("il motivo è della prima voce, in ordine di catalogo, che porta il massimo", () => {
    const s = suggestOutcomes([ans("ci_osteo", "si"), ans("ci_avk", "si")]);
    expect(s.direct.suggested).toBe("contraindicated");
    expect(s.direct.reason).toBe("terapia anticoagulante");
    // ci_nao viene prima di ci_osteo nel catalogo, qualunque sia l'ordine delle risposte.
    const c = suggestOutcomes([ans("ci_osteo", "si"), ans("ci_nao", "si")]);
    expect(c.direct.suggested).toBe("caution");
    expect(c.direct.reason).toBe("terapia anticoagulante");
    const o = suggestOutcomes([ans("ci_osteo", "si"), ans("loc_aorta", "si", { regions: ["lumbar"] })]);
    expect(o.direct.reason).toBe("osteoporosi o osteopenia");
  });
});

describe("esiti, nota e pillole", () => {
  it("ordina gli esiti e chiede la nota solo per un esito più lieve", () => {
    expect([outcomeRank("indicated"), outcomeRank("caution"), outcomeRank("contraindicated")]).toEqual([0, 1, 2]);
    expect(needsOverrideNote("contraindicated", "caution")).toBe(true);
    expect(needsOverrideNote("caution", "contraindicated")).toBe(false);
    expect(needsOverrideNote("caution", "caution")).toBe(false);
    expect(OVERRIDE_NOTE_MIN).toBe(10);
  });

  it("scrive le pillole", () => {
    expect(pillText("direct", "caution")).toBe("Dirette: con cautela");
    expect(pillText("indirect", "indicated")).toBe("Indirette: indicato");
    expect(pillText("thrust", "contraindicated")).toBe("Thrust: controindicato");
  });
});

describe("tecniche", () => {
  it("famiglia della tecnica con e senza approccio", () => {
    expect(techniqueFamily("fasciale", null)).toBe("direct");
    expect(techniqueFamily("still", null)).toBe("direct");
    expect(techniqueFamily("altra", null)).toBe("direct");
    expect(techniqueFamily("craniale", null)).toBe("indirect");
    expect(techniqueFamily("viscerale", null)).toBe("indirect");
    expect(techniqueFamily("craniale", "direct")).toBe("direct");
    expect(techniqueFamily("craniale", "indirect")).toBe("indirect");
    expect(techniqueFamily("fasciale", "indirect")).toBe("indirect");
    expect(techniqueFamily("hvla", null)).toBe("thrust");
    expect(techniqueFamily("hvla", "indirect")).toBe("thrust");
    expect(techniqueFamily("funzionale", "direct")).toBe("indirect");
  });

  it("nome della tecnica nel blocco", () => {
    expect(techniqueName("hvla", null)).toBe("HVLA");
    expect(techniqueName("energia_muscolare", null)).toBe("Tecnica energia muscolare");
    expect(techniqueName("altra", "Tecnica di Jones")).toBe("Tecnica di Jones");
  });

  it("senza screening confermato blocca con SCREENING_FIRST", () => {
    expect(checkTreatment(T("lumbar", "funzionale"), null)).toEqual({ kind: "blocked", text: SCREENING_FIRST });
    expect(SCREENING_FIRST).toBe("Conferma lo screening prima di scrivere il trattamento.");
  });

  it("altra tecnica usa il nome scritto; senza motivo vale «esito dello screening»", () => {
    const s = suggestOutcomes([]);
    const st = state(s, { direct: "contraindicated" });
    expect(
      checkTreatment({ region: "lumbar", techniqueCode: "altra", approach: "direct", customTechnique: "Tecnica di Jones" }, st),
    ).toEqual({
      kind: "blocked",
      text: "Tecnica di Jones controindicata in questa visita: esito dello screening. Cambia l'esito dello screening se hai nuove informazioni.",
    });
  });

  it("regione controindicata negli esiti salvati senza motivo vale «controindicazione locale»", () => {
    const s = suggestOutcomes([]);
    const st: ScreeningState = {
      ...state(s),
      outcomes: { ...state(s).outcomes, direct: { outcome: "indicated", localContraindicated: ["thoracic"] } },
    };
    expect(checkTreatment(T("thoracic", "articolatoria"), st)).toEqual({
      kind: "blocked",
      text: "Tecnica articolatoria controindicata in questa visita: controindicazione locale. Cambia l'esito dello screening se hai nuove informazioni.",
    });
  });
});

describe("referralPrompts", () => {
  const base: PromptInput = {
    enabled: ["R1", "R2", "R3"],
    answers: [],
    cycleKind: "trattamento",
    expectedSessions: null,
    sessionNumber: null,
    firstNprsPre: null,
    todayNprsPre: null,
    isFirstVisitOfCycle: false,
  };

  it("R1 su un si con rinvio, spento se non è fra le regole accese", () => {
    const answers = [ans("rf_nonmech", "si")];
    expect(referralPrompts({ ...base, answers })).toEqual([
      {
        code: "R1",
        text: "Hai segnato: Dolore costante e progressivo che non cambia con posizione e movimento. Indicazione della fonte: programmato.",
        urgency: "programmato",
      },
    ]);
    expect(referralPrompts({ ...base, enabled: ["R2", "R3"], answers })).toEqual([]);
    expect(referralPrompts({ ...base, answers: [ans("rf_nonmech", "non_so"), ans("ci_avk", "si")] })).toEqual([]);
  });

  it("R1 con due voci: ordine di catalogo e urgenza della voce", () => {
    const prompts = referralPrompts({ ...base, answers: [ans("rf_nonmech", "si"), ans("rf_ces_saddle", "si")] });
    expect(prompts.map((p) => [p.code, p.urgency])).toEqual([
      ["R1", "emergenza"],
      ["R1", "programmato"],
    ]);
    expect(prompts[0]?.text).toBe(
      "Hai segnato: Anestesia a sella: sensibilità alterata in zona perianale, perineale o genitale. Indicazione della fonte: emergenza.",
    );
  });

  it("R2: dolore di oggi di almeno 2 punti sopra la prima visita del ciclo", () => {
    expect(referralPrompts({ ...base, firstNprsPre: 5, todayNprsPre: 7 })).toEqual([
      {
        code: "R2",
        text: "Il dolore 0-10 di oggi (7) supera di almeno 2 punti quello della prima visita del ciclo (5).",
        urgency: null,
      },
    ]);
    expect(referralPrompts({ ...base, firstNprsPre: 5, todayNprsPre: 6 })).toEqual([]);
    expect(referralPrompts({ ...base, firstNprsPre: 5, todayNprsPre: null })).toEqual([]);
    expect(referralPrompts({ ...base, firstNprsPre: null, todayNprsPre: 7 })).toEqual([]);
    expect(referralPrompts({ ...base, firstNprsPre: 5, todayNprsPre: 7, isFirstVisitOfCycle: true })).toEqual([]);
    expect(referralPrompts({ ...base, enabled: ["R1", "R3"], firstNprsPre: 5, todayNprsPre: 7 })).toEqual([]);
  });

  it("R3: oltre le sedute previste con meno di 2 punti di miglioramento, solo nei cicli di trattamento", () => {
    const r3 = { ...base, expectedSessions: 4, sessionNumber: 5, firstNprsPre: 6, todayNprsPre: 5 };
    expect(referralPrompts(r3)).toEqual([
      {
        code: "R3",
        text: "Seduta 5 oltre le 4 previste e il dolore 0-10 è sceso di meno di 2 punti dalla prima visita.",
        urgency: null,
      },
    ]);
    expect(referralPrompts({ ...r3, todayNprsPre: 3 })).toEqual([]);
    expect(referralPrompts({ ...r3, todayNprsPre: 4 })).toEqual([]);
    expect(referralPrompts({ ...r3, cycleKind: "mantenimento" })).toEqual([]);
    expect(referralPrompts({ ...r3, sessionNumber: 4 })).toEqual([]);
    expect(referralPrompts({ ...r3, expectedSessions: null })).toEqual([]);
    expect(referralPrompts({ ...r3, todayNprsPre: null })).toEqual([]);
    expect(referralPrompts({ ...r3, enabled: ["R1", "R2"] })).toEqual([]);
  });

  it("R3 con una sola seduta prevista", () => {
    expect(
      referralPrompts({ ...base, expectedSessions: 1, sessionNumber: 2, firstNprsPre: 6, todayNprsPre: 5 }),
    ).toEqual([
      {
        code: "R3",
        text: "Seduta 2 oltre l'unica prevista e il dolore 0-10 è sceso di meno di 2 punti dalla prima visita.",
        urgency: null,
      },
    ]);
  });
});

describe("anamnesi", () => {
  it("etichette di rischio dal nome del farmaco", () => {
    expect(riskTagsForDrug("Warfarin 5 mg")).toEqual(["anticoagulante_tao"]);
    expect(riskTagsForDrug("Eliquis 5")).toEqual(["anticoagulante_nao"]);
    expect(riskTagsForDrug("RIVAROXABAN 20 mg")).toEqual(["anticoagulante_nao"]);
    expect(riskTagsForDrug("Paracetamolo")).toEqual([]);
  });

  it("risposte proposte dall'anamnesi", () => {
    expect(historyAnswers(["anticoagulante_tao"])).toEqual([
      { itemCode: "ci_avk", answer: "si", regions: [], subAnswers: [], fromHistory: true, note: null },
    ]);
    expect(historyAnswers([])).toEqual([]);
    expect(historyAnswers(["colpo_di_frusta"])).toEqual([
      { itemCode: "loc_whiplash", answer: "si", regions: ["cervical"], subAnswers: [], fromHistory: true, note: null },
    ]);
  });
});

describe("gruppi e voci visibili", () => {
  const ctx: GroupContext = {
    firstVisit: true,
    mainRegion: "cervical",
    cervicalDirectOrThrust: false,
    pregnancyInProgress: false,
    ageMonths: 400,
    pediatricEnabled: false,
    answeredGroups: [],
  };

  it("prima visita cervicale apre il gruppo cervicale", () => {
    expect(visibleGroups(ctx)).toEqual(["ci_sistemica", "ci_locale", "rf_rachide", "rf_cervicale_vascolare"]);
    expect(visibleGroups({ ...ctx, mainRegion: "head" })).toContain("rf_cervicale_vascolare");
    expect(visibleGroups({ ...ctx, mainRegion: "lumbar" })).toEqual(["ci_sistemica", "ci_locale", "rf_rachide"]);
    expect(visibleGroups({ ...ctx, firstVisit: false })).toEqual(["ci_sistemica", "ci_locale", "rf_rachide"]);
    expect(visibleGroups({ ...ctx, firstVisit: false, cervicalDirectOrThrust: true })).toContain("rf_cervicale_vascolare");
    expect(visibleGroups({ ...ctx, firstVisit: false, answeredGroups: ["rf_cervicale_vascolare"] })).toContain(
      "rf_cervicale_vascolare",
    );
  });

  it("gravidanza e pediatrico", () => {
    expect(visibleGroups({ ...ctx, pregnancyInProgress: true })).toEqual([
      "ci_sistemica",
      "ci_locale",
      "rf_rachide",
      "rf_cervicale_vascolare",
      "rf_gravidanza",
    ]);
    expect(visibleGroups({ ...ctx, ageMonths: 4 })).not.toContain("rf_pediatrico");
    expect(visibleGroups({ ...ctx, ageMonths: 4, pediatricEnabled: true })).toContain("rf_pediatrico");
    expect(visibleGroups({ ...ctx, ageMonths: 12, pediatricEnabled: true })).not.toContain("rf_pediatrico");
  });

  it("voci pediatriche secondo l'età in mesi", () => {
    const at4 = visibleItems("rf_pediatrico", 4).map((i) => i.code);
    expect(at4).not.toContain("rf_ped_projectile");
    expect(at4).not.toContain("rf_ped_fever");
    expect(at4).toContain("rf_ped_bilious");
    const at1 = visibleItems("rf_pediatrico", 1).map((i) => i.code);
    expect(at1).toContain("rf_ped_projectile");
    expect(at1).toContain("rf_ped_fever");
    expect(visibleItems("ci_sistemica", 400).map((i) => i.code)).toEqual([
      "ci_coag",
      "ci_avk",
      "ci_nao",
      "ci_connective",
      "ci_integrity",
      "ci_osteo",
    ]);
  });
});

describe("il thrust eredita le dirette, con una voce iniettata nel catalogo", () => {
  it("il thrust eredita una controindicazione delle sole dirette", async () => {
    // Nessuna voce vera ha le dirette più severe del thrust: la regola si prova su una voce finta.
    vi.resetModules();
    vi.doMock("@/lib/clinical/catalog", async (importOriginal) => {
      const real = await importOriginal<typeof import("@/lib/clinical/catalog")>();
      const fake: ScreeningItem = {
        ...(real.screeningItem("ci_osteo") as ScreeningItem),
        code: "zz_direct_only",
        short: "voce di prova",
        effect: { thrust: "none", direct: "contraindicated", indirect: "none" },
      };
      return { ...real, SCREENING_ITEMS: [...real.SCREENING_ITEMS, fake] };
    });
    try {
      const rules = await import("@/lib/clinical/rules");
      const si = rules.suggestOutcomes([ans("zz_direct_only", "si")]);
      expect(si.thrust.suggested).toBe("contraindicated");
      expect(si.thrust.reason).toBe("voce di prova");
      expect(si.indirect.suggested).toBe("indicated");
      const dubbio = rules.suggestOutcomes([ans("zz_direct_only", "non_so")]);
      expect(dubbio.thrust.suggested).toBe("caution");
      expect(dubbio.thrust.toVerify).toEqual(["da verificare"]);
    } finally {
      vi.doUnmock("@/lib/clinical/catalog");
      vi.resetModules();
    }
  });
});
