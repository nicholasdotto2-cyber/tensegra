import { describe, expect, it } from "vitest";
import { centsToInput, parseEuroCents } from "@/lib/money";

describe("money", () => {
  it("legge il prezzo scritto nel campo come in Italia, con la virgola o il punto", () => {
    expect(parseEuroCents("55,00")).toBe(5500);
    expect(parseEuroCents("55")).toBe(5500);
    expect(parseEuroCents("80.5")).toBe(8050);
    expect(parseEuroCents("1.234,50")).toBe(123450);
  });

  it("rifiuta ciò che non è un importo da zero in su", () => {
    expect(parseEuroCents("abc")).toBeNull();
    expect(parseEuroCents("-1")).toBeNull();
  });

  it("riporta i centesimi nel campo con la virgola e due decimali", () => {
    expect(centsToInput(5500)).toBe("55,00");
  });
});
