import { describe, expect, it } from "vitest";
import { phoneDisplay, toE164 } from "@/lib/phone";

describe("phone", () => {
  it("porta il numero scritto nel campo in E.164, con +39 se manca il prefisso", () => {
    expect(toE164("+39 051 000 0000")).toBe("+390510000000");
    expect(toE164("051 000 0000")).toBe("+390510000000");
    expect(toE164("+39 333 000 0012")).toBe("+393330000012");
  });

  it("rifiuta ciò che la regex del database rifiuta", () => {
    expect(toE164("abc")).toBeNull();
    expect(toE164("+39 12")).toBeNull();
  });

  it("mostra i numeri italiani a gruppi, gli altri come sono", () => {
    expect(phoneDisplay("+390510000000")).toBe("+39 051 000 0000");
    expect(phoneDisplay("+393330000012")).toBe("+39 333 000 0012");
    expect(phoneDisplay("+41441234567")).toBe("+41441234567");
  });
});
