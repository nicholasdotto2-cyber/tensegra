import { describe, expect, it } from "vitest";
import type { Family } from "@/lib/clinical/catalog";
import { SCREENING_FIRST, suggestOutcomes, type ScreeningState } from "@/lib/clinical/rules";
import {
  closingCheck,
  planCopy,
  skippedText,
  type ClosingFacts,
  type CopySource,
} from "@/lib/clinical/visit-rules";

/** Gli esiti di Anna: TAO da anamnesi, thrust controindicato, dirette con cautela. */
function annaState(): ScreeningState {
  const suggestion = suggestOutcomes([
    { itemCode: "ci_avk", answer: "si", regions: [], subAnswers: [], fromHistory: true, note: null },
  ]);
  const chosen: Record<Family, "contraindicated" | "caution" | "indicated"> = {
    thrust: "contraindicated",
    direct: "caution",
    indirect: "indicated",
  };
  const one = (f: Family) => ({ outcome: chosen[f], localContraindicated: suggestion[f].localContraindicated });
  return { outcomes: { thrust: one("thrust"), direct: one("direct"), indirect: one("indirect") }, suggestion };
}

const source: CopySource = {
  findings: [
    {
      region: "lumbar",
      severity: 2,
      tissueTexture: true,
      asymmetry: false,
      restriction: true,
      tenderness: false,
      side: null,
      segmentNote: "L4-L5",
      isPrimary: true,
    },
    {
      region: "sacral",
      severity: 1,
      tissueTexture: false,
      asymmetry: true,
      restriction: false,
      tenderness: false,
      side: null,
      segmentNote: null,
      isPrimary: false,
    },
  ],
  tests: [
    { testCode: "dita_pavimento", customLabel: null, customUnit: null, side: null },
    { testCode: "libero", customLabel: "Rotazione anca", customUnit: "°", side: "dx" },
  ],
  treatments: [
    { region: "lumbar", techniqueCode: "hvla", customTechnique: null, approach: null },
    { region: "lumbar", techniqueCode: "funzionale", customTechnique: null, approach: null },
  ],
  advice: [
    { templateCode: "camminata", text: "Cammina 20 minuti al giorno a passo comodo, su terreno piano." },
    { templateCode: null, text: "Evita di sollevare pesi per una settimana." },
  ],
};

describe("planCopy", () => {
  it("esiti di Anna: HVLA non si copia, il funzionale sì", () => {
    const plan = planCopy(source, annaState());
    expect(plan.treatments).toEqual([{ region: "lumbar", techniqueCode: "funzionale", customTechnique: null, approach: null }]);
    expect(plan.skipped).toBe(1);
  });

  it("le disfunzioni passano tutte, i consigli uguali alla sorgente", () => {
    const plan = planCopy(source, annaState());
    expect(plan.findings).toEqual(source.findings);
    expect(plan.advice).toEqual(source.advice);
  });

  it("i test copiati non hanno valori: solo codice, etichetta, unità e lato", () => {
    const withValues = {
      ...source,
      tests: source.tests.map((t) => ({ ...t, valueNumeric: 28, valueBool: true })),
    } as CopySource;
    const plan = planCopy(withValues, annaState());
    expect(plan.tests).toEqual(source.tests);
    for (const t of plan.tests) expect(Object.keys(t).sort()).toEqual(["customLabel", "customUnit", "side", "testCode"]);
  });

  it("una tecnica con cautela si copia", () => {
    const plan = planCopy(
      { ...source, treatments: [{ region: "lumbar", techniqueCode: "tessuti_molli", customTechnique: null, approach: null }] },
      annaState(),
    );
    expect(plan.treatments).toHaveLength(1);
    expect(plan.skipped).toBe(0);
  });

  it("skippedText", () => {
    expect(skippedText(1)).toBe("1 tecnica non copiata: controindicata oggi");
    expect(skippedText(2)).toBe("2 tecniche non copiate: controindicate oggi");
    expect(skippedText(0)).toBeNull();
    expect(skippedText(1, "consenso_revocato")).toBe("1 tecnica non copiata: consenso al trattamento revocato");
    expect(skippedText(2, "consenso_revocato")).toBe("2 tecniche non copiate: consenso al trattamento revocato");
    expect(skippedText(0, "consenso_revocato")).toBeNull();
  });
});

/** Una visita in regola: nessun bloccante, nessun avviso. */
function okFacts(extra: Partial<ClosingFacts> = {}): ClosingFacts {
  return {
    screeningConfirmed: true,
    treatments: [{ region: "lumbar", check: { kind: "ok" }, note: null }],
    copiedCount: 0,
    othersPresent: null,
    othersPresentConsented: null,
    adverseReaction: "nessuna",
    adverseReactionNote: null,
    radiationSites: [],
    radiationSide: null,
    firstVisitOfTreatmentCycle: false,
    opening: { chiefComplaint: "Lombalgia", mainRegion: "lumbar", goal: "Allacciarsi le scarpe", expectedSessions: 4 },
    nprsPre: 5,
    adviceCount: 1,
    findingRegions: ["lumbar"],
    treatmentConsentMissing: false,
    minorAtVisit: false,
    planAgreed: true,
    psfsCount: 1,
    firstVisitOfCycle: false,
    ...extra,
  };
}

const blocked = { kind: "blocked" as const, text: "HVLA controindicata in questa visita: terapia anticoagulante." };
const CONFLICT =
  'Una tecnica è in contrasto con lo screening: scrivi nella riga "tecnica eseguita prima della comparsa del sintomo" o toglila.';

describe("closingCheck", () => {
  it("tutto in regola", () => {
    expect(closingCheck(okFacts())).toEqual({ blocking: [], warnings: [] });
  });

  it("screening non confermato", () => {
    expect(closingCheck(okFacts({ screeningConfirmed: false })).blocking).toEqual([
      { code: "screening", text: "Conferma lo screening.", anchor: "sezione-b" },
    ]);
  });

  it("con lo screening da confermare le righe bloccate da SCREENING_FIRST non sono conflitti", () => {
    const f = okFacts({
      screeningConfirmed: false,
      treatments: [{ region: "lumbar", check: { kind: "blocked", text: SCREENING_FIRST }, note: null }],
    });
    expect(closingCheck(f).blocking.map((b) => b.code)).toEqual(["screening"]);
  });

  it("tecnica in contrasto senza nota blocca, con la nota no", () => {
    expect(closingCheck(okFacts({ treatments: [{ region: "lumbar", check: blocked, note: null }] })).blocking).toEqual([
      { code: "conflitto", text: CONFLICT, anchor: "riga-tecnica-lumbar" },
    ]);
    expect(closingCheck(okFacts({ treatments: [{ region: "lumbar", check: blocked, note: "   " }] })).blocking).toHaveLength(1);
    expect(
      closingCheck(
        okFacts({
          treatments: [{ region: "lumbar", check: blocked, note: "tecnica eseguita prima della comparsa del sintomo" }],
        }),
      ),
    ).toEqual({ blocking: [], warnings: [] });
  });

  it("una tecnica con cautela non blocca", () => {
    const f = okFacts({ treatments: [{ region: "lumbar", check: { kind: "caution", text: "Con cautela" }, note: null }] });
    expect(closingCheck(f)).toEqual({ blocking: [], warnings: [] });
  });

  it("dati copiati da confermare", () => {
    expect(closingCheck(okFacts({ copiedCount: 2 })).blocking).toEqual([
      { code: "copiati", text: "Conferma i dati copiati.", anchor: "sezione-c" },
    ]);
  });

  it("altre persone presenti senza il consenso indicato", () => {
    expect(closingCheck(okFacts({ othersPresent: "madre", othersPresentConsented: null })).blocking).toEqual([
      { code: "presenti", text: "Indica se il paziente acconsente alla presenza di altre persone.", anchor: "campo-presenti" },
    ]);
    expect(closingCheck(okFacts({ othersPresent: "madre", othersPresentConsented: false })).blocking).toEqual([]);
    expect(closingCheck(okFacts({ othersPresent: "  ", othersPresentConsented: null })).blocking).toEqual([]);
  });

  it("reazione avversa senza nota", () => {
    expect(closingCheck(okFacts({ adverseReaction: "lieve", adverseReactionNote: null })).blocking).toEqual([
      { code: "reazione", text: "Scrivi una nota sulla reazione dall'ultima visita.", anchor: "campo-reazione" },
    ]);
    expect(closingCheck(okFacts({ adverseReaction: "lieve", adverseReactionNote: "Rigidità la sera" })).blocking).toEqual([]);
    expect(closingCheck(okFacts({ adverseReaction: null })).blocking).toEqual([]);
  });

  it("irradiazione senza lato", () => {
    expect(closingCheck(okFacts({ radiationSites: ["gluteo"], radiationSide: null })).blocking).toEqual([
      { code: "irradiazione", text: "Scegli il lato dell'irradiazione.", anchor: "campo-irradiazione" },
    ]);
    expect(closingCheck(okFacts({ radiationSites: ["gluteo"], radiationSide: "dx" })).blocking).toEqual([]);
  });

  it("prima visita di un ciclo di trattamento senza obiettivo", () => {
    const opening = { chiefComplaint: "Lombalgia", mainRegion: "lumbar" as const, goal: null, expectedSessions: 4 };
    expect(closingCheck(okFacts({ firstVisitOfTreatmentCycle: true, opening })).blocking).toEqual([
      {
        code: "apertura",
        text: "Per la prima visita servono motivo, regione principale, obiettivo e sedute previste.",
        anchor: "apertura-ciclo",
      },
    ]);
    expect(closingCheck(okFacts({ firstVisitOfTreatmentCycle: false, opening })).blocking).toEqual([]);
    expect(closingCheck(okFacts({ firstVisitOfTreatmentCycle: true })).blocking).toEqual([]);
  });

  it("i bloccanti nell'ordine dei codici", () => {
    const f = okFacts({
      screeningConfirmed: false,
      copiedCount: 1,
      othersPresent: "madre",
      adverseReaction: "grave",
      radiationSites: ["coscia"],
      firstVisitOfTreatmentCycle: true,
      opening: { chiefComplaint: null, mainRegion: null, goal: null, expectedSessions: null },
    });
    expect(closingCheck(f).blocking.map((b) => b.code)).toEqual([
      "screening",
      "copiati",
      "presenti",
      "reazione",
      "irradiazione",
      "apertura",
    ]);
  });

  it("avvisi gialli", () => {
    const w = (extra: Partial<ClosingFacts>) => closingCheck(okFacts(extra));
    expect(w({ nprsPre: null }).warnings).toEqual([
      { code: "dolore", text: "Manca il dolore 0-10 a inizio seduta.", anchor: "campo-dolore-inizio" },
    ]);
    expect(w({ adviceCount: 0 }).warnings).toEqual([{ code: "consigli", text: "Nessun consiglio dato.", anchor: "sezione-e" }]);
    expect(w({ findingRegions: ["sacral"] }).warnings).toEqual([
      { code: "senza_tart", text: "Regione trattata senza disfunzioni somatiche (TART)", anchor: "riga-tecnica-lumbar" },
    ]);
    expect(w({ treatmentConsentMissing: true }).warnings).toEqual([
      { code: "consenso", text: "Manca il consenso al trattamento per questo ciclo.", anchor: "sezione-d" },
    ]);
    expect(w({ minorAtVisit: true, othersPresent: null }).warnings).toEqual([
      { code: "genitore", text: "Minore senza un genitore fra i presenti.", anchor: "campo-presenti" },
    ]);
    expect(w({ firstVisitOfCycle: true, planAgreed: false }).warnings).toEqual([
      { code: "piano", text: "Piano non segnato come spiegato e accettato.", anchor: "sezione-e" },
    ]);
    expect(w({ firstVisitOfCycle: true, psfsCount: 0 }).warnings).toEqual([
      { code: "psfs", text: "Nessuna attività PSFS per questo ciclo.", anchor: "apertura-ciclo" },
    ]);
  });

  it("piano e PSFS avvisano solo alla prima visita del ciclo", () => {
    expect(closingCheck(okFacts({ firstVisitOfCycle: false, planAgreed: false, psfsCount: 0 })).warnings).toEqual([]);
  });

  it("minore: madre, padre, genitore o tutore fra i presenti, senza maiuscole e accenti", () => {
    for (const othersPresent of ["madre", "Il Padre", "un genitore", "i genitori", "TUTORE legale"]) {
      expect(
        closingCheck(okFacts({ minorAtVisit: true, othersPresent, othersPresentConsented: true })).warnings,
      ).toEqual([]);
    }
    expect(
      closingCheck(okFacts({ minorAtVisit: true, othersPresent: "nonna", othersPresentConsented: true })).warnings.map(
        (x) => x.code,
      ),
    ).toEqual(["genitore"]);
  });

  it("una regione trattata con più tecniche dà una voce sola", () => {
    const f = okFacts({
      findingRegions: [],
      treatments: [
        { region: "lumbar", check: blocked, note: null },
        { region: "lumbar", check: blocked, note: null },
        { region: "sacral", check: { kind: "ok" }, note: null },
      ],
    });
    const c = closingCheck(f);
    expect(c.blocking.map((b) => b.anchor)).toEqual(["riga-tecnica-lumbar"]);
    expect(c.warnings.map((x) => x.anchor)).toEqual(["riga-tecnica-lumbar", "riga-tecnica-sacral"]);
  });

  it("gli avvisi nell'ordine dei codici", () => {
    const f = okFacts({
      nprsPre: null,
      adviceCount: 0,
      findingRegions: [],
      treatmentConsentMissing: true,
      minorAtVisit: true,
      firstVisitOfCycle: true,
      planAgreed: false,
      psfsCount: 0,
    });
    expect(closingCheck(f).warnings.map((x) => x.code)).toEqual([
      "dolore",
      "consigli",
      "senza_tart",
      "consenso",
      "genitore",
      "piano",
      "psfs",
    ]);
  });
});
