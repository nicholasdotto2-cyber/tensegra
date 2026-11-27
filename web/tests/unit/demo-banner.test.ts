import { beforeEach, describe, expect, it, vi } from "vitest";
import { bannerState } from "@/lib/demo-banner";
import { recreateDemoDataAction } from "@/app/(app)/recreate-action";
import { DEMO_PRACTICE_ID } from "@/server/auth/actor";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";

const deps = vi.hoisted(() => ({
  context: vi.fn(), recreate: vi.fn(), revalidate: vi.fn(), config: vi.fn(), store: {},
}));
vi.mock("@/server/db/next", () => ({ getRequestContext: deps.context }));
vi.mock("@/server/demo/recreate", () => ({ recreateDemoData: deps.recreate }));
vi.mock("@/server/config", () => ({ loadConfig: deps.config }));
vi.mock("@/server/files/disk-store", () => ({ getFileStore: () => deps.store }));
vi.mock("next/cache", () => ({ revalidatePath: deps.revalidate }));
// Come in Next: redirect lancia un segnale che unstable_rethrow rilancia.
const REDIRECT = new Error("NEXT_REDIRECT");
const redirect = vi.fn(() => { throw REDIRECT; });
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirect(...(args as [])),
  unstable_rethrow: (error: unknown) => { if (error === REDIRECT) throw error; },
}));

describe("banner_state", () => {
  it("mostra l'ora del seed di oggi senza offrire Ricrea", () => {
    expect(bannerState(new Date("2026-10-22T08:12:00+02:00"), "2026-10-22"))
      .toEqual({ text: "Creati oggi alle 08:12", canRecreate: false });
  });
  it("offre Ricrea per il seed di lunedì 19 ottobre", () => {
    expect(bannerState(new Date("2026-10-19T08:12:00+02:00"), "2026-10-22"))
      .toEqual({ text: "Creati lunedì 19/10", canRecreate: true });
  });
  it("senza seed non offre Ricrea e non mostra testo", () => {
    expect(bannerState(null, "2026-10-22")).toEqual({ text: "", canRecreate: false });
  });
  it("confronta il giorno di Roma anche a cavallo della mezzanotte UTC", () => {
    expect(bannerState(new Date("2026-10-21T23:12:00Z"), "2026-10-22"))
      .toEqual({ text: "Creati oggi alle 01:12", canRecreate: false });
  });
  it("non offre Ricrea per un seed futuro", () => {
    expect(bannerState(new Date("2026-10-23T08:12:00+02:00"), "2026-10-22"))
      .toEqual({ text: "Creati venerdì 23/10", canRecreate: false });
  });
});

describe("recreateDemoDataAction", () => {
  const db = {};
  beforeEach(() => {
    vi.clearAllMocks();
    deps.context.mockResolvedValue({ db, practiceId: DEMO_PRACTICE_ID });
    deps.config.mockReturnValue({ demoMode: true });
    deps.recreate.mockResolvedValue(undefined);
  });
  it("passa la modalità configurata e invalida il layout dopo la ricreazione", async () => {
    deps.recreate.mockImplementation(async () => {
      expect(deps.revalidate).not.toHaveBeenCalled();
    });
    await expect(recreateDemoDataAction()).rejects.toBe(REDIRECT);
    expect(deps.recreate).toHaveBeenCalledWith(db, deps.store, expect.objectContaining({ today: expect.any(Function) }), { demoMode: true });
    expect(deps.revalidate).toHaveBeenCalledWith("/", "layout");
    expect(redirect).toHaveBeenCalledWith("/oggi");
  });
  it("passa demoMode false all'orchestratore senza aggirare il rifiuto", async () => {
    deps.config.mockReturnValue({ demoMode: false });
    deps.recreate.mockRejectedValue(new DomainError(NOT_ALLOWED));
    expect(await recreateDemoDataAction()).toMatchObject({ ok: false, message: NOT_ALLOWED });
    expect(deps.recreate).toHaveBeenCalledWith(db, deps.store, expect.anything(), { demoMode: false });
    expect(deps.revalidate).not.toHaveBeenCalled();
  });
  it("rifiuta una richiesta di un altro studio prima della ricreazione", async () => {
    deps.context.mockResolvedValue({ db, practiceId: "altro-studio" });
    expect(await recreateDemoDataAction()).toMatchObject({ ok: false, message: NOT_ALLOWED });
    expect(deps.recreate).not.toHaveBeenCalled();
  });
  it("restituisce il messaggio di dominio senza invalidare i dati in caso di errore", async () => {
    deps.recreate.mockRejectedValue(new DomainError("Ricreazione non disponibile."));
    expect(await recreateDemoDataAction()).toMatchObject({ ok: false, message: "Ricreazione non disponibile." });
    expect(deps.revalidate).not.toHaveBeenCalled();
  });
});
