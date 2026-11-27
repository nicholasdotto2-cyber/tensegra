import { describe, expect, it } from "vitest";
import { stampDeadline } from "@/lib/fiscal/stamp-deadline";

describe("Scadenze trimestrali del bollo", () => {
  it("500001 centesimi nel primo trimestre superano la soglia di un centesimo", () => {
    expect(stampDeadline(2026, 1, { q1Cents: 500001, q2Cents: 0 })).toBe("2026-06-01");
  });

  it("il secondo trimestre scade il 30 settembre se il primo supera già la soglia", () => {
    expect(stampDeadline(2026, 2, { q1Cents: 500001, q2Cents: 200 })).toBe("2026-09-30");
  });

  it("rinvia il primo trimestre piccolo al 30 novembre se anche il secondo è piccolo", () => {
    expect(stampDeadline(2026, 1, { q1Cents: 4000, q2Cents: 1000 })).toBe("2026-11-30");
  });

  it("oltre 5000 euro il primo trimestre slitta da domenica 31 maggio a lunedì", () => {
    expect(stampDeadline(2026, 1, { q1Cents: 500100, q2Cents: 0 })).toBe("2026-06-01");
  });

  it("il quarto trimestre 2026 slitta da domenica 28 febbraio a lunedì", () => {
    expect(stampDeadline(2026, 4, { q1Cents: 0, q2Cents: 0 })).toBe("2027-03-01");
  });

  it("il quarto trimestre 2027 scade il 29 febbraio dell'anno bisestile", () => {
    expect(stampDeadline(2027, 4, { q1Cents: 0, q2Cents: 0 })).toBe("2028-02-29");
  });

  it.each([1, 2] as const)("trimestre %i: la somma oltre soglia scade il 30 settembre", (quarter) => {
    expect(stampDeadline(2026, quarter, { q1Cents: 400000, q2Cents: 200000 }))
      .toBe("2026-09-30");
  });

  it("rinvia anche il secondo trimestre piccolo al 30 novembre", () => {
    expect(stampDeadline(2026, 2, { q1Cents: 4000, q2Cents: 1000 })).toBe("2026-11-30");
  });

  it("il terzo trimestre scade il 30 novembre", () => {
    expect(stampDeadline(2026, 3, { q1Cents: 0, q2Cents: 0 })).toBe("2026-11-30");
  });

  it("500000 centesimi esatti nel primo trimestre non superano la soglia", () => {
    expect(stampDeadline(2026, 1, { q1Cents: 500000, q2Cents: 1 })).toBe("2026-09-30");
  });

  it.each([1, 2] as const)("trimestre %i: somma di 500000 centesimi esatti rinviata a novembre", (quarter) => {
    expect(stampDeadline(2026, quarter, { q1Cents: 400000, q2Cents: 100000 }))
      .toBe("2026-11-30");
  });

  it("mantiene il sabato come giorno di scadenza", () => {
    expect(stampDeadline(2024, 3, { q1Cents: 0, q2Cents: 0 })).toBe("2024-11-30");
  });
});
