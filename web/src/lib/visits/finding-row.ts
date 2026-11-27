import type { FindingSide } from "@/lib/clinical/body-map";
import { TART } from "@/lib/clinical/labels";
import type { EditorFinding } from "@/server/domain/visits/editor";

// La riga di una disfunzione somatica come la modifica il pannello della regione dell'editor della visita,
// senza React: `RegionPanel` la usa, i test unitari la provano da sola. La riga
// mostrata ammette una severità non ancora scelta (null); quella inviata è normalizzata come la scrive il server
// (severità 0 se non scelta, nessun lato fuori dagli arti), così la vista che torna combacia con l'ultima inviata.

export interface FindingRow {
  /** null: la regione non ha ancora una severità scelta. */
  severity: number | null;
  tissueTexture: boolean;
  asymmetry: boolean;
  restriction: boolean;
  tenderness: boolean;
  side: FindingSide | null;
  segmentNote: string | null;
  isPrimary: boolean;
}

/** La riga della disfunzione salvata; senza riga una regione vuota, col lato proposto dalla sagoma. */
export function findingRowOf(finding: EditorFinding | undefined, proposedSide: "dx" | "sx" | null): FindingRow {
  if (finding === undefined) {
    return {
      severity: null,
      tissueTexture: false,
      asymmetry: false,
      restriction: false,
      tenderness: false,
      side: proposedSide,
      segmentNote: null,
      isPrimary: false,
    };
  }
  return {
    severity: finding.severity,
    tissueTexture: finding.tissueTexture,
    asymmetry: finding.asymmetry,
    restriction: finding.restriction,
    tenderness: finding.tenderness,
    side: finding.side,
    segmentNote: finding.segmentNote,
    isPrimary: finding.isPrimary,
  };
}

/** La riga come la salva il server: severità 0 se non scelta, lato solo per gli arti, segmento senza spazi ai lati. */
export function normalizedFindingRow(row: FindingRow, sided: boolean): FindingRow {
  return {
    ...row,
    severity: row.severity ?? 0,
    side: sided ? row.side : null,
    segmentNote: row.segmentNote?.trim() || null,
  };
}

/** La stessa riga (il segmento confrontato senza spazi ai lati, come lo riscrive il server). */
export function sameFindingRow(a: FindingRow, b: FindingRow): boolean {
  return (
    a.severity === b.severity &&
    TART.every(({ key }) => a[key] === b[key]) &&
    a.side === b.side &&
    (a.segmentNote?.trim() || null) === (b.segmentNote?.trim() || null) &&
    a.isPrimary === b.isPrimary
  );
}

/** Una riga che il server accetta come nuova: severità da 1, o una lettera TART (severità 0 vuole una lettera). */
export function validNewFinding(row: FindingRow): boolean {
  return (row.severity ?? 0) > 0 || TART.some(({ key }) => row[key]);
}
