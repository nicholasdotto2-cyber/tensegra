import { demoSeededText, romeDay } from "@/lib/format";

/** Il banner offre la ricreazione solo se i dati sono di un giorno precedente a oggi. */
export function bannerState(seededAt: Date | null, today: string): { text: string; canRecreate: boolean } {
  if (seededAt === null) return { text: "", canRecreate: false };
  return { text: demoSeededText(seededAt, today), canRecreate: romeDay(seededAt) < today };
}
