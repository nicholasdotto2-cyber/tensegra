import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La route del documento di un consenso: un id che non è un uuid è 404
// prima del database, un consenso che non c'è (anche di un altro studio) è 404; nessuna cache, `nosniff`,
// la MIME salvata e un nome senza dati del paziente. Nessun evento: il comando non ne scrive.

const ensureConsentDocument = vi.fn();

vi.mock("@/server/db/next", () => ({ getRequestContext: async () => ({ db: {}, actor: {}, practiceId: "p" }) }));
vi.mock("@/server/files/disk-store", () => ({ getFileStore: () => ({}) }));
vi.mock("@/server/pdf/consent-file", () => ({
  ensureConsentDocument: (...args: unknown[]) => ensureConsentDocument(...args),
}));

const ID = "0b8f6d5e-5a0f-4c4e-9a52-2f1d6a1d9c11";

async function get(id: string, query = ""): Promise<Response> {
  const { GET } = await import("@/app/api/consensi/[id]/documento/route");
  return GET(new NextRequest(`http://localhost/api/consensi/${id}/documento${query}`), { params: Promise.resolve({ id }) } as never);
}

describe("GET /api/consensi/[id]/documento", () => {
  beforeEach(() => ensureConsentDocument.mockReset());

  it("route_isolata", async () => {
    for (const bad of ["abc", "0b8f6d5e-5a0f-4c4e-9a52-2f1d6a1d9c1", "..%2Ffiles"]) {
      const response = await get(bad, "?download=1");
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(ensureConsentDocument).not.toHaveBeenCalled();

    ensureConsentDocument.mockResolvedValue(null);
    const missing = await get(ID);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
    expect(ensureConsentDocument.mock.calls[0]?.[3]).toBe(ID);

    ensureConsentDocument.mockResolvedValue({ bytes: new Uint8Array([37, 80, 68, 70, 45]), mimeType: "application/pdf", fileName: "consenso-2026-11-04.pdf" });
    const inline = await get(ID);
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("application/pdf");
    expect(inline.headers.get("content-disposition")).toBe('inline; filename="consenso-2026-11-04.pdf"');
    expect(inline.headers.get("cache-control")).toBe("private, no-store");
    expect(inline.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await inline.arrayBuffer()).toString("latin1")).toBe("%PDF-");

    ensureConsentDocument.mockResolvedValue({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg", fileName: "consenso-2026-11-03.jpg" });
    const upload = await get(ID, "?download=1");
    expect(upload.headers.get("content-type")).toBe("image/jpeg");
    expect(upload.headers.get("content-disposition")).toBe('attachment; filename="consenso-2026-11-03.jpg"');
    expect(upload.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
