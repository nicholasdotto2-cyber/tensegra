import { describe, expect, it } from "vitest";
import { radioKeyTarget } from "@/components/cartella/scale-parts";
import {
  areasOverlap,
  BODY_AREAS,
  BODY_SCALE,
  BODY_VIEWBOX,
  type BodyArea,
  type BodyFinding,
  type BodyView,
  findingFitsArea,
  LEFT_SIDE,
  regionFindingName,
} from "@/lib/clinical/body-map";
import { REGION_CODES, type RegionCode, SIDED_REGIONS } from "@/lib/clinical/catalog";

// La mappa del body chart: dieci regioni su due sagome con il viewBox
// 240 x 520 disegnate a scala 1,2, aree di almeno 44 x 44 unità (almeno 52 px resi) che non si sovrappongono e
// non escono dal viewBox, arti con il lato; il nome del pulsante dell'elenco.

const VIEWS: readonly BodyView[] = ["anteriore", "posteriore"];

function areasOf(region: RegionCode, view?: BodyView): BodyArea[] {
  return BODY_AREAS.filter((a) => a.region === region && (view === undefined || a.view === view));
}

function viewsOf(region: RegionCode): BodyView[] {
  return VIEWS.filter((v) => areasOf(region, v).length > 0);
}

describe("BODY_AREAS", () => {
  it("dà almeno un'area a ogni regione", () => {
    for (const region of REGION_CODES) expect(areasOf(region).length, region).toBeGreaterThan(0);
  });

  it("mette bacino, addome e coste davanti; dorsale, lombare e sacro dietro; cranio e cervicale in tutte e due", () => {
    for (const region of ["pelvic", "abdomen_other", "rib_cage"] as const) expect(viewsOf(region), region).toEqual(["anteriore"]);
    for (const region of ["thoracic", "lumbar", "sacral"] as const) expect(viewsOf(region), region).toEqual(["posteriore"]);
    for (const region of ["head", "cervical"] as const) expect(viewsOf(region), region).toEqual(["anteriore", "posteriore"]);
  });

  it("dà a ogni arto due aree per vista, dx e sx, con il destro del paziente a sinistra di chi guarda davanti", () => {
    expect(SIDED_REGIONS.length).toBeGreaterThan(0);
    for (const region of SIDED_REGIONS) {
      for (const view of VIEWS) {
        const areas = areasOf(region, view);
        expect(areas.map((a) => a.side).sort(), `${region} ${view}`).toEqual(["dx", "sx"]);
      }
      const dx = areasOf(region, "anteriore").find((a) => a.side === "dx");
      const sx = areasOf(region, "anteriore").find((a) => a.side === "sx");
      expect(dx && sx && dx.x < sx.x, region).toBe(true);
    }
  });

  it("dietro mette il destro del paziente a destra di chi guarda", () => {
    for (const region of SIDED_REGIONS) {
      const dx = areasOf(region, "posteriore").find((a) => a.side === "dx");
      const sx = areasOf(region, "posteriore").find((a) => a.side === "sx");
      expect(dx && sx && dx.x > sx.x, region).toBe(true);
    }
  });

  it("scrive sopra la sagoma il lato che sta a sinistra di chi guarda: dx davanti, sx dietro", () => {
    expect(LEFT_SIDE).toEqual({ anteriore: "dx", posteriore: "sx" });
  });

  it("lascia senza lato le regioni che non lo hanno", () => {
    for (const area of BODY_AREAS) {
      if (!SIDED_REGIONS.includes(area.region)) expect(area.side, `${area.region} ${area.view}`).toBeNull();
    }
  });

  it("misura ogni area almeno 44 x 44 unità, almeno 52 px resi, e la tiene dentro il viewBox", () => {
    expect(BODY_SCALE).toBe(1.2);
    for (const a of BODY_AREAS) {
      const name = `${a.region} ${a.view} ${a.side ?? ""}`;
      expect(a.width, name).toBeGreaterThanOrEqual(44);
      expect(a.height, name).toBeGreaterThanOrEqual(44);
      expect(Math.min(a.width, a.height) * BODY_SCALE, name).toBeGreaterThanOrEqual(52);
      expect(a.x, name).toBeGreaterThanOrEqual(0);
      expect(a.y, name).toBeGreaterThanOrEqual(0);
      expect(a.x + a.width, name).toBeLessThanOrEqual(BODY_VIEWBOX.width);
      expect(a.y + a.height, name).toBeLessThanOrEqual(BODY_VIEWBOX.height);
    }
  });

  it("non sovrappone due aree della stessa vista", () => {
    for (const view of VIEWS) {
      const areas = BODY_AREAS.filter((a) => a.view === view);
      for (let i = 0; i < areas.length; i++) {
        for (let j = i + 1; j < areas.length; j++) {
          const a = areas[i]!;
          const b = areas[j]!;
          expect(areasOverlap(a, b), `${view}: ${a.region} ${a.side ?? ""} / ${b.region} ${b.side ?? ""}`).toBe(false);
        }
      }
    }
  });
});

describe("areasOverlap", () => {
  const base: BodyArea = { region: "head", view: "anteriore", side: null, x: 10, y: 10, width: 50, height: 50 };

  it("riconosce due rettangoli che si coprono in parte, e uno dentro l'altro", () => {
    expect(areasOverlap(base, { ...base, region: "cervical", x: 40, y: 40 })).toBe(true);
    expect(areasOverlap(base, { ...base, region: "cervical", x: 20, y: 20, width: 10, height: 10 })).toBe(true);
  });

  it("non conta due aree che si toccano solo sul bordo, né due aree lontane", () => {
    expect(areasOverlap(base, { ...base, region: "cervical", y: 60 })).toBe(false);
    expect(areasOverlap(base, { ...base, region: "cervical", x: 60 })).toBe(false);
    expect(areasOverlap(base, { ...base, region: "cervical", x: 200, y: 300 })).toBe(false);
  });

  it("non conta due aree di sagome diverse", () => {
    expect(areasOverlap(base, { ...base, region: "cervical", view: "posteriore" })).toBe(false);
  });
});

function finding(region: RegionCode, extra: Partial<BodyFinding> = {}): BodyFinding {
  return { region, severity: 2, side: null, isPrimary: false, copied: false, ...extra };
}

describe("findingFitsArea", () => {
  const limb = (view: BodyView, side: "dx" | "sx") =>
    BODY_AREAS.find((a) => a.region === "lower_extremity" && a.view === view && a.side === side)!;

  it("accende solo l'area del lato della disfunzione di un arto, nelle due viste", () => {
    for (const view of VIEWS) {
      expect(findingFitsArea(finding("lower_extremity", { side: "dx" }), limb(view, "dx")), view).toBe(true);
      expect(findingFitsArea(finding("lower_extremity", { side: "dx" }), limb(view, "sx")), view).toBe(false);
      expect(findingFitsArea(finding("lower_extremity", { side: "sx" }), limb(view, "sx")), view).toBe(true);
      expect(findingFitsArea(finding("lower_extremity", { side: "sx" }), limb(view, "dx")), view).toBe(false);
    }
  });

  it("accende tutte e due le aree con bilaterale, centrale o senza lato", () => {
    for (const side of ["bilaterale", "centrale", null] as const) {
      for (const view of VIEWS) {
        expect(findingFitsArea(finding("lower_extremity", { side }), limb(view, "dx")), `${side} ${view}`).toBe(true);
        expect(findingFitsArea(finding("lower_extremity", { side }), limb(view, "sx")), `${side} ${view}`).toBe(true);
      }
    }
  });

  it("non accende l'area di un'altra regione, e accende sempre quella di una regione senza lato", () => {
    expect(findingFitsArea(finding("upper_extremity", { side: "dx" }), limb("anteriore", "dx"))).toBe(false);
    const neck = areasOf("cervical", "anteriore")[0]!;
    expect(findingFitsArea(finding("cervical"), neck)).toBe(true);
    expect(findingFitsArea(finding("head"), neck)).toBe(false);
  });
});

describe("regionFindingName", () => {
  it("dice severità, Primaria e da confermare di una regione senza lato", () => {
    expect(regionFindingName("cervical", finding("cervical", { severity: 3, isPrimary: true }))).toBe("Cervicale, severità 3, Primaria");
    expect(regionFindingName("cervical", undefined)).toBe("Cervicale, nessuna disfunzione");
    expect(regionFindingName("thoracic", finding("thoracic", { copied: true }))).toBe("Dorsale, severità 2, da confermare");
    expect(regionFindingName("head", finding("head", { severity: 0, isPrimary: true, copied: true }))).toBe(
      "Cranio e ATM, severità 0, Primaria, da confermare",
    );
  });

  it("aggiunge il lato dx, sx o bilaterale a un arto, non centrale né nessun lato", () => {
    expect(regionFindingName("lower_extremity", finding("lower_extremity", { side: "dx", isPrimary: true }))).toBe(
      "Arto inferiore dx, severità 2, Primaria",
    );
    expect(regionFindingName("upper_extremity", finding("upper_extremity", { side: "sx" }))).toBe("Arto superiore sx, severità 2");
    expect(regionFindingName("lower_extremity", finding("lower_extremity", { side: "bilaterale", severity: 1 }))).toBe(
      "Arto inferiore bilaterale, severità 1",
    );
    expect(regionFindingName("lower_extremity", finding("lower_extremity", { side: "centrale" }))).toBe("Arto inferiore, severità 2");
    expect(regionFindingName("lower_extremity", finding("lower_extremity"))).toBe("Arto inferiore, severità 2");
    expect(regionFindingName("upper_extremity", undefined)).toBe("Arto superiore, nessuna disfunzione");
  });
});

describe("radioKeyTarget", () => {
  it("con le frecce passa alla voce vicina e si ferma agli estremi", () => {
    expect(radioKeyTarget("ArrowRight", 3, 11)).toBe(4);
    expect(radioKeyTarget("ArrowDown", 3, 11)).toBe(4);
    expect(radioKeyTarget("ArrowLeft", 3, 11)).toBe(2);
    expect(radioKeyTarget("ArrowUp", 3, 11)).toBe(2);
    expect(radioKeyTarget("ArrowRight", 10, 11)).toBe(10);
    expect(radioKeyTarget("ArrowDown", 3, 4)).toBe(3);
    expect(radioKeyTarget("ArrowLeft", 0, 11)).toBe(0);
    expect(radioKeyTarget("ArrowUp", 0, 4)).toBe(0);
  });

  it("con Home e Fine va agli estremi, e gli altri tasti non muovono", () => {
    expect(radioKeyTarget("Home", 7, 11)).toBe(0);
    expect(radioKeyTarget("End", 2, 11)).toBe(10);
    expect(radioKeyTarget("End", 0, 4)).toBe(3);
    for (const key of ["Tab", "Enter", " ", "Delete", "5", "a"]) expect(radioKeyTarget(key, 5, 11), key).toBeNull();
  });
});
