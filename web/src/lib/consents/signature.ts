// Il controllo minimo della firma sulla tela: meno di 2 tratti o meno di 30 punti chiede di firmare di
// nuovo. È un controllo per chi firma, non una certificazione biometrica: il server verifica il PNG, non i tratti.
// Le coordinate sono in pixel CSS della tela, che ha una misura fissa: su uno schermo stretto scorre il
// contenitore, la tela non si rimpicciolisce e le coordinate salvate non cambiano scala.

export type SignaturePoint = { x: number; y: number };

/** La tela della firma in pixel CSS: almeno 560 x 200. */
export const SIGNATURE_WIDTH = 560;
export const SIGNATURE_HEIGHT = 200;

export const SIGNATURE_INCOMPLETE = "La firma sembra incompleta. Firma di nuovo.";

const MIN_STROKES = 2;
const MIN_POINTS = 30;

function inside(point: SignaturePoint): boolean {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.x <= SIGNATURE_WIDTH &&
    point.y >= 0 &&
    point.y <= SIGNATURE_HEIGHT
  );
}

/** Null se la firma basta; altrimenti la frase da mostrare sotto la tela. Una tela vuota non basta. */
export function signatureProblem(strokes: readonly (readonly SignaturePoint[])[]): string | null {
  const drawn = strokes.filter((stroke) => stroke.length > 0);
  // Un punto non numerico o fuori dalla tela (dopo `clampStrokes`) non viene da chi firma: la firma si rifà.
  if (drawn.some((stroke) => !stroke.every(inside))) return SIGNATURE_INCOMPLETE;
  const points = drawn.reduce((sum, stroke) => sum + stroke.length, 0);
  return drawn.length < MIN_STROKES || points < MIN_POINTS ? SIGNATURE_INCOMPLETE : null;
}

const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);

/**
 * I tratti con i punti fuori dalla tela portati sul bordo: signature_pad segue il puntatore anche oltre il
 * bordo, e una firma vera che esce dal riquadro non è incompleta. Una coordinata non numerica resta com'è, così
 * `signatureProblem` la rifiuta.
 */
export function clampStrokes(strokes: readonly (readonly SignaturePoint[])[]): SignaturePoint[][] {
  return strokes.map((stroke) =>
    stroke.map((point) =>
      Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { x: clamp(point.x, SIGNATURE_WIDTH), y: clamp(point.y, SIGNATURE_HEIGHT) }
        : { x: point.x, y: point.y },
    ),
  );
}
