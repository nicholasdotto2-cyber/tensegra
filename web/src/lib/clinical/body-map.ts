// La mappa del body chart: le aree delle 10 regioni su due sagome
// stilizzate, anteriore e posteriore, nelle unità del viewBox. La sagoma si disegna a scala `BODY_SCALE` (1,2:
// 288 x 624 px), quindi un'area di almeno 44 x 44 unità misura almeno 52 px e il testo di 10 unità dentro le
// aree esce a 12 px. Ogni area non tocca le altre della stessa vista e sta dentro il viewBox. Gli arti hanno
// un'area per lato: davanti il lato destro del paziente sta a sinistra di chi guarda, dietro a destra; una
// disfunzione di un arto accende solo l'area del suo lato (`visit_region_findings.side`).
// Sicuro per il client: nessun import dal server.

import { REGION_LABEL, type RegionCode, SIDED_REGIONS } from "./catalog";
import { SIDE_LABEL } from "./labels";

export type BodyView = "anteriore" | "posteriore";

/** Il lato salvato con la disfunzione (`visit_region_findings.side`). */
export type FindingSide = "dx" | "sx" | "bilaterale" | "centrale";

export type SeverityLevel = 0 | 1 | 2 | 3;

export interface BodyArea {
  region: RegionCode;
  view: BodyView;
  side: "dx" | "sx" | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Una regione con la sua disfunzione, come la disegnano la sagoma e l'elenco. */
export interface BodyFinding {
  region: RegionCode;
  severity: number;
  side: FindingSide | null;
  isPrimary: boolean;
  copied: boolean;
}

export const BODY_VIEWBOX = { width: 240, height: 520 } as const;
/** Quanti pixel vale un'unità del viewBox nelle sagome grandi. */
export const BODY_SCALE = 1.2;

/** Le parole scritte con la severità, nella sagoma e nell'elenco. */
export const PRIMARY_TEXT = "Primaria";
export const COPIED_TEXT = "da confermare";

// Le caselle della sagoma: le stesse nelle due viste, cambia la regione che ci sta sopra. Testa, collo, bacino
// e sacro sono alti 52 per stare il numero, «Primaria» e «da confermare»; gli arti sono larghi 64 per
// «confermare» a 10 unità.
const HEAD = { x: 78, y: 4, width: 84, height: 52 };
const NECK = { x: 78, y: 60, width: 84, height: 52 };
const CHEST = { x: 72, y: 116, width: 96, height: 72 };
const BELLY = { x: 72, y: 192, width: 96, height: 56 };
const PELVIS = { x: 72, y: 252, width: 96, height: 52 };
const ARM_LEFT = { x: 4, y: 116, width: 64, height: 168 };
const ARM_RIGHT = { x: 172, y: 116, width: 64, height: 168 };
const LEG_LEFT = { x: 54, y: 310, width: 64, height: 196 };
const LEG_RIGHT = { x: 122, y: 310, width: 64, height: 196 };

/** Sinistra e destra di chi guarda: davanti il dx del paziente sta a sinistra, dietro a destra. */
function limbs(view: BodyView, region: RegionCode, left: typeof ARM_LEFT, right: typeof ARM_RIGHT): BodyArea[] {
  const [leftSide, rightSide] = view === "anteriore" ? (["dx", "sx"] as const) : (["sx", "dx"] as const);
  return [
    { region, view, side: leftSide, ...left },
    { region, view, side: rightSide, ...right },
  ];
}

export const BODY_AREAS: readonly BodyArea[] = [
  { region: "head", view: "anteriore", side: null, ...HEAD },
  { region: "cervical", view: "anteriore", side: null, ...NECK },
  { region: "rib_cage", view: "anteriore", side: null, ...CHEST },
  { region: "abdomen_other", view: "anteriore", side: null, ...BELLY },
  { region: "pelvic", view: "anteriore", side: null, ...PELVIS },
  ...limbs("anteriore", "upper_extremity", ARM_LEFT, ARM_RIGHT),
  ...limbs("anteriore", "lower_extremity", LEG_LEFT, LEG_RIGHT),
  { region: "head", view: "posteriore", side: null, ...HEAD },
  { region: "cervical", view: "posteriore", side: null, ...NECK },
  { region: "thoracic", view: "posteriore", side: null, ...CHEST },
  { region: "lumbar", view: "posteriore", side: null, ...BELLY },
  { region: "sacral", view: "posteriore", side: null, ...PELVIS },
  ...limbs("posteriore", "upper_extremity", ARM_LEFT, ARM_RIGHT),
  ...limbs("posteriore", "lower_extremity", LEG_LEFT, LEG_RIGHT),
];

/** Il lato del paziente che sta a sinistra di chi guarda, letto dalle aree degli arti. */
function leftSideOf(view: BodyView): "dx" | "sx" {
  const [a, b] = BODY_AREAS.filter((area) => area.view === view && area.side !== null && area.region === SIDED_REGIONS[0]);
  if (!a || !b) throw new Error(`Nessun arto nella vista ${view}`);
  return (a.x < b.x ? a.side : b.side) ?? "dx";
}

export const LEFT_SIDE: Record<BodyView, "dx" | "sx"> = {
  anteriore: leftSideOf("anteriore"),
  posteriore: leftSideOf("posteriore"),
};

// Una figura stilizzata disegnata a mano: testa, collo, tronco, braccia e gambe come forme semplici, tutte in
// senso orario, così le parti che si toccano restano piene. Davanti e dietro la forma è la stessa: la vista
// la dicono l'etichetta e i lati scritti sopra.
const FIGURE = [
  // testa
  "M120 8a22 24 0 1 1 0 48a22 24 0 1 1 0-48Z",
  // collo
  "M110 54H130V92H110Z",
  // tronco e bacino
  "M86 92H154C166 92 170 100 170 112C170 160 160 190 160 220C160 250 170 270 170 290L170 300Q170 306 164 306H76Q70 306 70 300L70 290C70 270 80 250 80 220C80 190 70 160 70 112C70 100 74 92 86 92Z",
  // braccio a sinistra di chi guarda
  "M56 98C64 96 72 100 74 110L56 200L50 270Q50 290 38 292Q24 292 24 276L28 200L38 120C40 106 46 100 56 98Z",
  // braccio a destra di chi guarda
  "M184 98C194 100 200 106 202 120L212 200L216 276Q216 292 202 292Q190 290 190 270L184 200L166 110C168 100 176 96 184 98Z",
  // gamba a sinistra di chi guarda
  "M66 296H118L112 400L106 490Q106 506 94 506H80Q68 506 70 494L66 400L62 320Q62 300 66 296Z",
  // gamba a destra di chi guarda
  "M174 296Q178 300 178 320L174 400L170 494Q172 506 160 506H146Q134 506 134 490L128 400L122 296Z",
].join("");

export const SILHOUETTE: Record<BodyView, string> = {
  anteriore: FIGURE,
  posteriore: FIGURE,
};

/** Due aree si sovrappongono se stanno sulla stessa sagoma e hanno in comune più del solo bordo. */
export function areasOverlap(a: BodyArea, b: BodyArea): boolean {
  if (a.view !== b.view) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Se la disfunzione si disegna su quest'area: la regione deve essere la stessa; in un arto il lato dx accende
 * solo l'area dx, sx solo la sx, bilaterale, centrale o nessun lato tutte e due.
 */
export function findingFitsArea(finding: BodyFinding, area: BodyArea): boolean {
  if (finding.region !== area.region) return false;
  if (area.side === null) return true;
  return finding.side === area.side || finding.side === null || finding.side === "bilaterale" || finding.side === "centrale";
}

/** La severità come uno dei 4 livelli disegnati (fuori scala si ferma a 0 o a 3). */
export function severityLevel(severity: number): SeverityLevel {
  return Math.min(3, Math.max(0, Math.round(severity))) as SeverityLevel;
}

/** Il nome della regione con il lato, se è un arto con un lato che si dice (dx, sx, bilaterale). */
export function regionLabelWithSide(region: RegionCode, finding: BodyFinding | undefined): string {
  const label = REGION_LABEL[region];
  const side = finding?.side;
  if (!SIDED_REGIONS.includes(region) || side === undefined || side === null || side === "centrale") return label;
  return `${label} ${SIDE_LABEL[side]}`;
}

/**
 * Il nome accessibile del pulsante della regione nell'elenco: «Cervicale, severità 3, Primaria»,
 * «Arto inferiore dx, severità 2, Primaria», «Cervicale, nessuna disfunzione»; «, da confermare» se copiata.
 */
export function regionFindingName(region: RegionCode, finding: BodyFinding | undefined): string {
  const label = regionLabelWithSide(region, finding);
  if (!finding) return `${label}, nessuna disfunzione`;
  const parts = [label, `severità ${finding.severity}`];
  if (finding.isPrimary) parts.push(PRIMARY_TEXT);
  if (finding.copied) parts.push(COPIED_TEXT);
  return parts.join(", ");
}
