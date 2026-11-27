import { describe, expect, it } from "vitest";
import { clampStrokes, SIGNATURE_HEIGHT, SIGNATURE_WIDTH, type SignaturePoint, signatureProblem } from "@/lib/consents/signature";

// Il controllo minimo della firma sulla tela: almeno 2 tratti e 30 punti. È un controllo per
// l'interfaccia, non una certificazione biometrica.

const INCOMPLETE = "La firma sembra incompleta. Firma di nuovo.";

/** Un tratto orizzontale di `points` punti dentro la tela. */
function stroke(points: number, y = 100): SignaturePoint[] {
  return Array.from({ length: points }, (_, i) => ({ x: 20 + i * 2, y }));
}

describe("firma_minima", () => {
  it("rifiuta la tela vuota", () => {
    expect(signatureProblem([])).not.toBeNull();
    expect(signatureProblem([[]])).not.toBeNull();
  });

  it("un solo tratto, anche lungo, è incompleto", () => {
    expect(signatureProblem([stroke(100)])).toBe(INCOMPLETE);
  });

  it("due tratti con 29 punti in tutto sono incompleti", () => {
    expect(signatureProblem([stroke(15), stroke(14, 120)])).toBe(INCOMPLETE);
  });

  it("due tratti con 30 punti in tutto vanno bene", () => {
    expect(signatureProblem([stroke(15), stroke(15, 120)])).toBeNull();
  });

  it("rifiuta coordinate non numeriche o fuori dalla tela", () => {
    const good = [stroke(15), stroke(15, 120)];
    for (const bad of [
      { x: Number.NaN, y: 10 },
      { x: 10, y: Number.POSITIVE_INFINITY },
      { x: -1, y: 10 },
      { x: 10, y: -0.5 },
      { x: SIGNATURE_WIDTH + 1, y: 10 },
      { x: 10, y: SIGNATURE_HEIGHT + 1 },
    ]) {
      expect(signatureProblem([...good, [bad]])).not.toBeNull();
    }
    // I bordi sono dentro la tela.
    expect(signatureProblem([...good, [{ x: 0, y: 0 }, { x: SIGNATURE_WIDTH, y: SIGNATURE_HEIGHT }]])).toBeNull();
  });
});

describe("firma_oltre_il_bordo", () => {
  // signature_pad segue il puntatore anche fuori dalla tela: una firma vera che esce dal bordo non si rifiuta.
  it("i punti fuori dalla tela si portano sul bordo, poi la firma basta", () => {
    const outside: SignaturePoint[][] = [
      [...stroke(15), { x: SIGNATURE_WIDTH + 40, y: 100 }, { x: 600, y: SIGNATURE_HEIGHT + 25 }],
      [{ x: -12, y: -3 }, ...stroke(15, 120)],
    ];
    const clamped = clampStrokes(outside);
    expect(signatureProblem(clamped)).toBeNull();
    expect(clamped[0]?.at(-2)).toEqual({ x: SIGNATURE_WIDTH, y: 100 });
    expect(clamped[0]?.at(-1)).toEqual({ x: SIGNATURE_WIDTH, y: SIGNATURE_HEIGHT });
    expect(clamped[1]?.[0]).toEqual({ x: 0, y: 0 });
    // I punti dentro non cambiano, e il numero di punti resta quello disegnato.
    expect(clamped[1]?.slice(1)).toEqual(stroke(15, 120));
    expect(clamped.flat()).toHaveLength(33);
  });

  it("una coordinata non numerica resta rifiutata", () => {
    const clamped = clampStrokes([stroke(15), [...stroke(15, 120), { x: Number.NaN, y: 10 }]]);
    expect(signatureProblem(clamped)).toBe(INCOMPLETE);
  });
});
