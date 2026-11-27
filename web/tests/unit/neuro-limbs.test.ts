import { describe, expect, it } from "vitest";

import { NEURO_TESTS } from "@/lib/clinical/catalog";
import { neuroLimbs } from "@/lib/visits/neuro-limbs";

// L'esame neurologico compatto: da quale irradiazione, dal gruppo cervicale o dai risultati salvati
// si apre, e quali test porta ogni arto.

const none = { radiationSites: [], cervicalGroup: false, savedCodes: [] };
const upper = NEURO_TESTS.filter((t) => t.region === "upper_extremity").map((t) => t.code);
const lower = NEURO_TESTS.filter((t) => t.region === "lower_extremity").map((t) => t.code);

describe("neuroLimbs", () => {
  it("senza irradiazione, gruppo cervicale né risultati il blocco non c'è", () => {
    expect(neuroLimbs(none)).toEqual([]);
  });

  it("il gruppo cervicale porta l'arto superiore intero e dell'inferiore solo il segno di Babinski", () => {
    expect(neuroLimbs({ ...none, cervicalGroup: true })).toEqual([
      { limb: "upper_extremity", codes: upper },
      { limb: "lower_extremity", codes: ["babinski"] },
    ]);
  });

  it("l'irradiazione a braccio o mano apre l'arto superiore, a gluteo, coscia e sotto il ginocchio l'inferiore", () => {
    for (const site of ["braccio", "mano"]) {
      expect(neuroLimbs({ ...none, radiationSites: [site] })).toEqual([{ limb: "upper_extremity", codes: upper }]);
    }
    for (const site of ["gluteo", "coscia", "sotto_ginocchio"]) {
      expect(neuroLimbs({ ...none, radiationSites: [site] })).toEqual([{ limb: "lower_extremity", codes: lower }]);
    }
    expect(neuroLimbs({ ...none, radiationSites: ["mano", "coscia"] }).map((l) => l.limb)).toEqual([
      "upper_extremity",
      "lower_extremity",
    ]);
  });

  it("un risultato già salvato tiene aperto il suo arto anche senza il motivo di prima", () => {
    expect(neuroLimbs({ ...none, savedCodes: ["forza_l5"] })).toEqual([{ limb: "lower_extremity", codes: lower }]);
    // Il solo Babinski col gruppo cervicale non basta per mostrare tutto l'arto inferiore; salvato un altro test, sì.
    expect(neuroLimbs({ ...none, cervicalGroup: true, savedCodes: ["riflesso_achilleo"] })[1]).toEqual({
      limb: "lower_extremity",
      codes: lower,
    });
  });
});
