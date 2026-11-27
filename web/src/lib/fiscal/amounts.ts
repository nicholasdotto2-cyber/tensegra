export const STAMP_THRESHOLD_CENTS = 7747;
export const STAMP_CENTS = 200;

/** Percentuale in punti base su centesimi interi, con metà arrotondata per eccesso. */
export function arr(x: number, bp: number): number {
  return Number((BigInt(x) * BigInt(bp) + BigInt(5000)) / BigInt(10000));
}

/** Divisione di interi non negativi, con metà arrotondata per eccesso. */
export function rdiv(a: bigint, b: bigint): bigint {
  return (BigInt(2) * a + b) / (BigInt(2) * b);
}
