import { describe, expect, it } from "vitest";

import { findingRowOf, normalizedFindingRow, sameFindingRow, validNewFinding } from "@/lib/visits/finding-row";
import type { EditorFinding } from "@/server/domain/visits/editor";

// La riga della disfunzione del pannello della regione: quella inviata è
// normalizzata come la salva il server, così la vista che torna combacia e il pannello la segue di nuovo.

const saved = (extra: Partial<EditorFinding> = {}): EditorFinding => ({
  id: "f1",
  region: "lower_extremity",
  severity: 0,
  tissueTexture: true,
  asymmetry: false,
  restriction: false,
  tenderness: false,
  side: null,
  segmentNote: null,
  isPrimary: false,
  copied: false,
  ...extra,
});

describe("findingRowOf", () => {
  it("senza riga una regione vuota col lato proposto; con la riga i valori salvati", () => {
    expect(findingRowOf(undefined, "dx")).toMatchObject({ severity: null, side: "dx", isPrimary: false, tissueTexture: false });
    expect(findingRowOf(saved({ severity: 2, side: "sx" }), "dx")).toMatchObject({ severity: 2, side: "sx", tissueTexture: true });
  });
});

describe("normalizedFindingRow", () => {
  it("una regione nuova salvata con la sola T combacia con la riga che il server rilegge (severità 0)", () => {
    const shown = { ...findingRowOf(undefined, null), tissueTexture: true };
    const sent = normalizedFindingRow(shown, true);
    expect(sent.severity).toBe(0);
    expect(sameFindingRow(findingRowOf(saved(), null), sent)).toBe(true);
    // Senza normalizzare la riga mostrata (severità null) non combacerebbe mai.
    expect(sameFindingRow(findingRowOf(saved(), null), shown)).toBe(false);
  });

  it("fuori dagli arti il lato non si manda; il segmento perde gli spazi ai lati e vuoto diventa null", () => {
    const row = { ...findingRowOf(undefined, "dx"), severity: 2, segmentNote: "  L4-L5 " };
    expect(normalizedFindingRow(row, false)).toMatchObject({ side: null, segmentNote: "L4-L5", severity: 2 });
    expect(normalizedFindingRow(row, true).side).toBe("dx");
    expect(normalizedFindingRow({ ...row, segmentNote: "   " }, true).segmentNote).toBeNull();
  });
});

describe("validNewFinding", () => {
  it("una regione nuova vale con severità da 1 o con una lettera TART", () => {
    const empty = findingRowOf(undefined, null);
    expect(validNewFinding(empty)).toBe(false);
    expect(validNewFinding({ ...empty, severity: 0 })).toBe(false);
    expect(validNewFinding({ ...empty, severity: 1 })).toBe(true);
    expect(validNewFinding({ ...empty, restriction: true })).toBe(true);
  });
});
