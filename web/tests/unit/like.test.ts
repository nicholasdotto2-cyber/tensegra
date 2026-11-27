import { describe, expect, it } from "vitest";
import { escapeLike } from "@/lib/like";

describe("escapeLike", () => {
  it("mette la barra davanti a %, _ e \\, così diventano testo", () => {
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });

  it("lascia com'è il testo senza jolly", () => {
    expect(escapeLike("Bellandì Marco")).toBe("Bellandì Marco");
    expect(escapeLike("")).toBe("");
  });

  it("protegge ogni occorrenza, anche consecutive", () => {
    expect(escapeLike("%%__\\\\")).toBe("\\%\\%\\_\\_\\\\\\\\");
  });
});
