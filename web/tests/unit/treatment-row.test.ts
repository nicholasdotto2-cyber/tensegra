import { describe, expect, it } from "vitest";

import { APPROACH_DECLARED, TECHNIQUES } from "@/lib/clinical/catalog";
import type { TreatmentCheck } from "@/lib/clinical/rules";
import {
  approachItems,
  blockedHint,
  defaultApproach,
  newFields,
  sameFields,
  techniqueOp,
  techniqueSwitchDescription,
  techniqueSwitchName,
  treatmentKey,
  treatmentLocks,
} from "@/lib/visits/treatment-row";
import { VisitOpInput } from "@/server/domain/visits/schemas";

// La riga di una tecnica nella sezione D.

const ok: TreatmentCheck = { kind: "ok" };
const blocked: TreatmentCheck = { kind: "blocked", text: "Fasciale controindicata in questa visita: prova." };

describe("techniqueSwitchName", () => {
  it("il nome dell'interruttore è l'etichetta prima di ' (' e la descrizione l'etichetta intera", () => {
    const names = Object.fromEntries(TECHNIQUES.map((t) => [t.code, techniqueSwitchName(t.label)]));
    expect(names.hvla).toBe("HVLA");
    expect(names.got).toBe("TOG");
    expect(names.energia_muscolare).toBe("Energia muscolare");
    expect(names.tessuti_molli).toBe("Tessuti molli");
    expect(names.altra).toBe("Altra tecnica");
    expect(techniqueSwitchDescription("HVLA (thrust ad alta velocità e bassa ampiezza)")).toBe(
      "HVLA (thrust ad alta velocità e bassa ampiezza)",
    );
    // Senza parentesi la descrizione non direbbe niente di più del nome.
    expect(techniqueSwitchDescription("Tessuti molli")).toBeNull();
  });

  it("le 16 tecniche del catalogo hanno 16 nomi diversi", () => {
    expect(new Set(TECHNIQUES.map((t) => techniqueSwitchName(t.label))).size).toBe(16);
  });
});

describe("treatmentKey", () => {
  it("una riga per codice e, per «Altra tecnica», per nome senza maiuscole", () => {
    expect(treatmentKey({ techniqueCode: "hvla", customTechnique: null })).toBe("hvla:");
    expect(treatmentKey({ techniqueCode: "altra", customTechnique: " Mobilizzazione " })).toBe("altra:mobilizzazione");
    expect(treatmentKey({ techniqueCode: "altra", customTechnique: "MOBILIZZAZIONE" })).toBe(
      treatmentKey({ techniqueCode: "altra", customTechnique: "mobilizzazione" }),
    );
  });
});

describe("defaultApproach", () => {
  it("parte da Indiretto; Diretto solo se l'indiretto è bloccato e il diretto no", () => {
    expect(defaultApproach(undefined)).toBe("indirect");
    expect(defaultApproach({ direct: ok, indirect: ok })).toBe("indirect");
    expect(defaultApproach({ direct: ok, indirect: blocked })).toBe("direct");
    expect(defaultApproach({ direct: blocked, indirect: blocked })).toBe("indirect");
  });

  it("le tecniche con l'approccio dichiarato sono fasciale, Still e altra", () => {
    expect([...APPROACH_DECLARED]).toEqual(["fasciale", "still", "altra"]);
    expect(TECHNIQUES.filter((t) => APPROACH_DECLARED.includes(t.code)).every((t) => t.variableApproach)).toBe(true);
  });
});

describe("techniqueOp", () => {
  it("la riga intera: tolleranza «buona» di partenza, nessuna risposta né nota", () => {
    const op = techniqueOp({ region: "lower_extremity", techniqueCode: "tessuti_molli", customTechnique: null }, newFields(null));
    expect(op).toEqual({
      op: "tecnica",
      region: "lower_extremity",
      techniqueCode: "tessuti_molli",
      customTechnique: null,
      approach: null,
      tolerance: "buona",
      response: null,
      note: null,
    });
    expect(VisitOpInput.safeParse(op).success).toBe(true);
  });

  it("craniale parte da Indiretto, fasciale senza approccio è rifiutato dal comando, altra vuole nome e approccio", () => {
    const base = { region: "cervical" as const };
    expect(VisitOpInput.safeParse(techniqueOp({ ...base, techniqueCode: "craniale", customTechnique: null }, newFields("indirect"))).success).toBe(
      true,
    );
    const fascial = VisitOpInput.safeParse(techniqueOp({ ...base, techniqueCode: "fasciale", customTechnique: null }, newFields(null)));
    expect(fascial.success).toBe(false);
    const other = VisitOpInput.safeParse(techniqueOp({ ...base, techniqueCode: "altra", customTechnique: "Prova" }, newFields("direct")));
    expect(other.success).toBe(true);
  });
});

describe("sameFields", () => {
  it("la nota si confronta senza spazi ai lati, vuota e null sono lo stesso", () => {
    const a = { ...newFields("direct"), note: "  qualcosa " };
    expect(sameFields(a, { ...a, note: "qualcosa" })).toBe(true);
    expect(sameFields({ ...a, note: "" }, { ...a, note: null })).toBe(true);
    expect(sameFields(a, { ...a, tolerance: "fastidio" })).toBe(false);
    expect(sameFields(a, { ...a, approach: "indirect" })).toBe(false);
  });
});

describe("approachItems e blockedHint", () => {
  const direct: TreatmentCheck = { kind: "blocked", text: "Fasciale controindicata in questa visita: prova." };

  it("gli approcci bloccati sono disattivati e il loro motivo si legge in una frase; l'approccio già salvato resta libero", () => {
    expect(approachItems({ direct, indirect: ok }).map((i) => [i.label, i.disabled])).toEqual([
      ["Diretto", true],
      ["Indiretto", false],
    ]);
    expect(blockedHint({ direct, indirect: ok })).toBe(direct.text);
    expect(blockedHint({ direct, indirect: ok }, "direct")).toBeUndefined();
    expect(approachItems({ direct, indirect: ok }, "direct")[0]?.disabled).toBe(false);
    expect(approachItems(undefined).every((i) => !i.disabled)).toBe(true);
    expect(blockedHint({ direct: ok, indirect: ok })).toBeUndefined();
  });
});

describe("treatmentLocks", () => {
  const locks = (o: { readOnly?: boolean; revoked?: boolean; confirmed?: boolean }) =>
    treatmentLocks({ readOnly: false, revoked: false, confirmed: true, ...o });

  it("in bozza con lo screening confermato tutto è libero", () => {
    const l = locks({});
    expect([l.add, l.fields, l.remove(false), l.remove(true), l.note(false), l.note(true)]).toEqual([
      false, false, false, false, false, false,
    ]);
  });

  it("con lo screening non confermato niente si accende né si cambia, una riga accesa si spegne", () => {
    const l = locks({ confirmed: false });
    expect([l.add, l.fields, l.note(false)]).toEqual([true, true, true]);
    expect([l.remove(false), l.remove(true)]).toEqual([false, false]);
  });

  it("con il consenso revocato restano la nota di una riga salvata e il togli di una riga copiata (come il server)", () => {
    const l = locks({ revoked: true });
    expect([l.add, l.fields]).toEqual([true, true]);
    expect(l.note(false)).toBe(false);
    expect(l.note(true)).toBe(true);
    expect(l.remove(true)).toBe(false);
    expect(l.remove(false)).toBe(true);
  });

  it("in lettura niente si tocca", () => {
    const l = locks({ readOnly: true });
    expect([l.add, l.fields, l.remove(false), l.remove(true), l.note(false), l.note(true)]).toEqual([
      true, true, true, true, true, true,
    ]);
  });
});
