import { describe, expect, it } from "vitest";

// Serve solo a provare la catena di test (vitest + typecheck + lint).
describe("smoke", () => {
  it("somma due numeri", () => {
    expect(1 + 1).toBe(2);
  });
});
