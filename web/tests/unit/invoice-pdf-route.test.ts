import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La route del PDF della fattura: solo un
// download vero, con `?download=1`, scrive `pdf_scaricato`; l'anteprima nell'iframe del dettaglio no. Restano le
// altre regole: un id che non è un uuid è 404 prima del database, nessuna cache, `nosniff`.

const ensureInvoicePdf = vi.fn();
const recordInvoiceDownload = vi.fn();

vi.mock("@/server/db/next", () => ({ getRequestContext: async () => ({ db: {}, actor: {}, practiceId: "p" }) }));
vi.mock("@/server/files/disk-store", () => ({ getFileStore: () => ({}) }));
vi.mock("@/server/pdf/invoice-file", () => ({
  ensureInvoicePdf: (...args: unknown[]) => ensureInvoicePdf(...args),
  recordInvoiceDownload: (...args: unknown[]) => recordInvoiceDownload(...args),
}));

const ID = "0b8f6d5e-5a0f-4c4e-9a52-2f1d6a1d9c11";
const PDF = { bytes: new Uint8Array([37, 80, 68, 70, 45]), fileName: "Fattura_3-2026.pdf" };

async function get(id: string, query = ""): Promise<Response> {
  const { GET } = await import("@/app/api/fatture/[id]/pdf/route");
  return GET(new NextRequest(`http://localhost/api/fatture/${id}/pdf${query}`), { params: Promise.resolve({ id }) } as never);
}

describe("GET /api/fatture/[id]/pdf", () => {
  beforeEach(() => {
    ensureInvoicePdf.mockReset();
    recordInvoiceDownload.mockReset();
  });

  it("l'anteprima (senza ?download=1) serve il PDF inline e non scrive l'evento", async () => {
    ensureInvoicePdf.mockResolvedValue(PDF);
    const response = await get(ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="Fattura_3-2026.pdf"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(recordInvoiceDownload).not.toHaveBeenCalled();
  });

  it("il download (?download=1) serve il PDF come allegato e scrive pdf_scaricato una volta", async () => {
    ensureInvoicePdf.mockResolvedValue(PDF);
    const response = await get(ID, "?download=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="Fattura_3-2026.pdf"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect(recordInvoiceDownload).toHaveBeenCalledTimes(1);
    expect(recordInvoiceDownload.mock.calls[0]?.[2]).toBe(ID);
    expect(recordInvoiceDownload.mock.calls[0]?.[3]).toBe("pdf");
  });

  it("un id che non è un uuid è 404 prima del database; una fattura che non c'è è 404 senza evento", async () => {
    const bad = await get("abc", "?download=1");
    expect(bad.status).toBe(404);
    expect(bad.headers.get("cache-control")).toBe("private, no-store");
    expect(ensureInvoicePdf).not.toHaveBeenCalled();

    ensureInvoicePdf.mockResolvedValue(null);
    const missing = await get(ID, "?download=1");
    expect(missing.status).toBe(404);
    expect(recordInvoiceDownload).not.toHaveBeenCalled();
  });
});
