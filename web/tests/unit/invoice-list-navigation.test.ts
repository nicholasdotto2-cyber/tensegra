import { describe, expect, it } from "vitest";
import type { InvoiceListParams } from "@/lib/fiscal/list-params";
import { patchInvoiceList } from "@/lib/fiscal/list-navigation";

// Due cambi rapidi dei filtri di /fatture perdevano il primo cambio, perché il secondo
// partiva dai parametri della pagina, non ancora aggiornati dalla risposta del router.

const novembre: InvoiceListParams = { tab: "emesse", anno: 2026, mese: "2026-11", stato: "tutte", q: "" };

describe("patchInvoiceList", () => {
  it("due_patch: il secondo filtro parte dal primo, non dalla pagina", () => {
    const first = patchInvoiceList(novembre, { stato: "pagate" });
    const result = patchInvoiceList(first, { mese: "2026-10" });
    expect(result).toMatchObject({ stato: "pagate", mese: "2026-10" });
    expect(result).toEqual({ tab: "emesse", anno: 2026, mese: "2026-10", stato: "pagate", q: "" });
    expect(novembre).toEqual({ tab: "emesse", anno: 2026, mese: "2026-11", stato: "tutte", q: "" });
  });

  it("due_patch: la ricerca pendente e il secondo filtro restano entrambi", () => {
    const searched = patchInvoiceList(novembre, { q: "Bellandi" });
    const result = patchInvoiceList(searched, { stato: "pagate" });
    expect(result).toEqual({ tab: "emesse", anno: 2026, mese: "2026-11", stato: "pagate", q: "Bellandi" });
    expect(patchInvoiceList(result, { mese: "2025-10" })).toEqual({
      tab: "emesse", anno: 2025, mese: "2025-10", stato: "pagate", q: "Bellandi",
    });
  });

  it("due_patch: l'anno cambiato tiene il mese appena chiesto, non quello della pagina", () => {
    const october = patchInvoiceList(novembre, { mese: "2026-10" });
    expect(patchInvoiceList(october, { anno: 2025 })).toEqual({
      tab: "emesse", anno: 2025, mese: "2025-10", stato: "tutte", q: "",
    });
  });
});
