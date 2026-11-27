import { NEURO_TESTS, type RegionCode } from "@/lib/clinical/catalog";

// Quali test dell'esame neurologico compatto compaiono nella sezione C, senza React: `NeuroExam`
// la usa, i test unitari la provano da sola. Il blocco si apre da solo quando c'è un'irradiazione o il gruppo dei red
// flag cervicali è aperto, o quando la visita ha già un risultato dell'esame. Il riferimento dice solo "arto superiore o
// inferiore secondo il segmento": l'arto superiore va con la cervicale e con l'irradiazione al braccio e alla mano,
// l'arto inferiore con l'irradiazione a gluteo, coscia e sotto il ginocchio. Con la sola cervicale l'arto inferiore
// porta il segno di Babinski, un segno del primo motoneurone che la valutazione cervicale chiede.

export const UPPER_SITES: readonly string[] = ["braccio", "mano"];
export const LOWER_SITES: readonly string[] = ["gluteo", "coscia", "sotto_ginocchio"];
const UPPER_MOTOR_NEURON: readonly string[] = ["babinski"];
const LIMBS = ["upper_extremity", "lower_extremity"] as const;

export interface NeuroLimb {
  limb: RegionCode;
  /** I codici dell'esame da mostrare per quell'arto, nell'ordine del catalogo. */
  codes: string[];
}

export function neuroLimbs(input: {
  radiationSites: readonly string[];
  /** Il gruppo dei red flag cervicali è visibile. */
  cervicalGroup: boolean;
  /** I codici dei risultati dell'esame neurologico già salvati nella visita. */
  savedCodes: readonly string[];
}): NeuroLimb[] {
  const saved = new Set(input.savedCodes);
  const sites = (list: readonly string[]) => input.radiationSites.some((site) => list.includes(site));
  return LIMBS.flatMap((limb): NeuroLimb[] => {
    const codes = NEURO_TESTS.filter((test) => test.region === limb).map((test) => test.code);
    const relevant = limb === "upper_extremity" ? input.cervicalGroup || sites(UPPER_SITES) : sites(LOWER_SITES);
    if (relevant || codes.some((code) => saved.has(code))) return [{ limb, codes }];
    if (limb === "lower_extremity" && input.cervicalGroup) {
      return [{ limb, codes: codes.filter((code) => UPPER_MOTOR_NEURON.includes(code)) }];
    }
    return [];
  });
}
