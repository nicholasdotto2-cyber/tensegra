import { describe, expect, it } from "vitest";
import { insuranceWarning } from "@/lib/settings/insurance";

// Avviso della polizza: scaduta, o in scadenza entro 30 giorni.

describe("insuranceWarning", () => {
  it("scaduta", () => {
    expect(insuranceWarning("2026-11-14", "2026-11-20")).toBe("La polizza è scaduta il 14/11/2026.");
    expect(insuranceWarning("2026-11-14", "2026-11-15")).toBe("La polizza è scaduta il 14/11/2026.");
  });

  it("in scadenza entro 30 giorni, oggi compreso", () => {
    expect(insuranceWarning("2026-11-14", "2026-10-22")).toBe("La polizza scade il 14/11/2026.");
    expect(insuranceWarning("2026-11-14", "2026-11-14")).toBe("La polizza scade il 14/11/2026.");
    expect(insuranceWarning("2026-11-21", "2026-10-22")).toBe("La polizza scade il 21/11/2026.");
  });

  it("oltre 30 giorni, nessun avviso", () => {
    expect(insuranceWarning("2027-05-10", "2026-10-22")).toBeNull();
    expect(insuranceWarning("2026-11-22", "2026-10-22")).toBeNull();
  });

  it("30 giorni anche attraverso il cambio d'ora", () => {
    expect(insuranceWarning("2027-04-17", "2027-03-18")).toBe("La polizza scade il 17/04/2027.");
    expect(insuranceWarning("2027-04-18", "2027-03-18")).toBeNull();
  });

  it("senza scadenza, nessun avviso", () => {
    expect(insuranceWarning(null, "2026-10-22")).toBeNull();
  });
});
