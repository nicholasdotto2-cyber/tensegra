import { beforeEach, describe, expect, it, vi } from "vitest";

import { LETTER_CHANGED } from "@/lib/clinical/labels";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";

// La route del PDF della lettera davanti a `ensureReferralPdf`: la lettera
// cambiata durante il rendering è un 409 col testo della pagina, non un 500; ogni altro errore risale.

const ensureReferralPdf = vi.fn();

vi.mock("@/server/db/next", () => ({ getRequestContext: async () => ({ db: {}, actor: {}, practiceId: "p" }) }));
vi.mock("@/server/files/disk-store", () => ({ getFileStore: () => ({}) }));
vi.mock("@/server/pdf/referral-file", () => ({ ensureReferralPdf: (...args: unknown[]) => ensureReferralPdf(...args) }));

const ID = "0b8f6d5e-5a0f-4c4e-9a52-2f1d6a1d9c11";

async function get(id: string): Promise<Response> {
  const { GET } = await import("@/app/api/rinvii/[id]/pdf/route");
  // La route usa solo `params`: il resto del contesto di Next non serve.
  return GET(new Request("http://localhost/api/rinvii") as never, { params: Promise.resolve({ id }) } as never);
}

describe("GET /api/rinvii/[id]/pdf", () => {
  beforeEach(() => {
    ensureReferralPdf.mockReset();
  });

  it("risponde 409 col testo della pagina quando la lettera è cambiata durante il rendering", async () => {
    ensureReferralPdf.mockRejectedValue(new DomainError(LETTER_CHANGED));
    const response = await get(ID);
    expect(response.status).toBe(409);
    expect(await response.text()).toBe("La lettera è cambiata mentre preparavo il PDF: riprova.");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("riconosce l'errore per nome: un errore nato in un altro bundle vale lo stesso", async () => {
    const foreign = Object.assign(new Error(LETTER_CHANGED), { name: "DomainError" });
    ensureReferralPdf.mockRejectedValue(foreign);
    expect((await get(ID)).status).toBe(409);
  });

  it("lascia salire ogni altro errore di dominio, che non è un 409", async () => {
    ensureReferralPdf.mockRejectedValue(new DomainError(NOT_ALLOWED));
    await expect(get(ID)).rejects.toThrow(NOT_ALLOWED);
  });

  it("serve il PDF con le sue intestazioni e dà 404 senza lettera o con un id che non è un uuid", async () => {
    ensureReferralPdf.mockResolvedValueOnce({ bytes: new Uint8Array([37, 80, 68, 70]), fileName: "lettera-medico-2026-11-04.pdf" });
    const ok = await get(ID);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(ok.headers.get("cache-control")).toBe("private, no-store");

    ensureReferralPdf.mockResolvedValueOnce(null);
    expect((await get(ID)).status).toBe(404);

    ensureReferralPdf.mockClear();
    expect((await get("boh")).status).toBe(404);
    expect(ensureReferralPdf).not.toHaveBeenCalled();
  });
});
