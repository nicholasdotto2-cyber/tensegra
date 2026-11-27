import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConflictError, DomainError, isConflictError, isDomainError } from "@/server/domain/errors";
import { toActionFailure } from "@/server/actions/result";

// Le azioni restituiscono gli errori attesi come valori, in italiano, con il
// campo a cui appartengono; il resto del mondo (database, bug) diventa un testo generico.

afterEach(() => {
  vi.restoreAllMocks();
});

const GENERIC = "Qualcosa non ha funzionato. I dati già salvati sono al sicuro. Ricarica la pagina.";

describe("toActionFailure: errori di dominio", () => {
  it("un DomainError con un campo", () => {
    const failure = toActionFailure(new DomainError("Scegli il paziente.", { field: "patientId" }), "ctx");
    expect(failure).toEqual({
      ok: false,
      message: "Scegli il paziente.",
      fieldErrors: { patientId: "Scegli il paziente." },
      refused: true,
    });
  });

  it("un DomainError senza campo non ha fieldErrors", () => {
    const failure = toActionFailure(new DomainError("C'è già una visita"), "ctx");
    expect(failure).toEqual({ ok: false, message: "C'è già una visita", refused: true });
    expect("fieldErrors" in failure).toBe(false);
  });

  // Turbopack compila i moduli una volta per bundle: un errore nato in un altro bundle non è
  // un `instanceof` di questa classe e si riconosce per `name`.
  it("un oggetto con name DomainError, di un altro bundle", () => {
    const failure = toActionFailure({ name: "DomainError", message: "x", field: "day" }, "ctx");
    expect(failure).toEqual({ ok: false, message: "x", fieldErrors: { day: "x" }, refused: true });
  });

  it("con fieldErrors porta tutti gli errori del modulo, il messaggio è il primo", () => {
    const first = "L'ora di fine deve venire dopo l'inizio.";
    const err = new DomainError(first, {
      field: "days.0.bands.0.closes",
      fieldErrors: {
        "days.0.bands.0.closes": first,
        "days.1.bands.1.opens": "Le due fasce si sovrappongono.",
      },
    });
    expect(toActionFailure(err, "ctx")).toEqual({
      ok: false,
      refused: true,
      message: first,
      fieldErrors: {
        "days.0.bands.0.closes": first,
        "days.1.bands.1.opens": "Le due fasce si sovrappongono.",
      },
    });
  });

  it("il ConflictError ha il suo testo e la sua bandiera", () => {
    expect(toActionFailure(new ConflictError(), "ctx")).toEqual({
      ok: false,
      message: "L'appuntamento è stato modificato in un'altra finestra. Ricarico i dati.",
      conflict: true,
    });
  });
});

describe("isDomainError e isConflictError", () => {
  it("riconoscono per name, non per classe", () => {
    expect(isDomainError(new DomainError("x"))).toBe(true);
    expect(isDomainError({ name: "DomainError", message: "x" })).toBe(true);
    expect(isDomainError(new ConflictError())).toBe(false);
    expect(isDomainError(new Error("x"))).toBe(false);
    expect(isDomainError(null)).toBe(false);
    expect(isDomainError("DomainError")).toBe(false);
    expect(isConflictError(new ConflictError())).toBe(true);
    expect(isConflictError({ name: "ConflictError", message: "x" })).toBe(true);
    expect(isConflictError(new DomainError("x"))).toBe(false);
    expect(isConflictError(undefined)).toBe(false);
  });

  it("i nomi delle classi", () => {
    expect(new DomainError("x").name).toBe("DomainError");
    expect(new ConflictError().name).toBe("ConflictError");
  });
});

describe("toActionFailure: errori di validazione", () => {
  it("uno ZodError diventa fieldErrors con il messaggio della regola", () => {
    const parsed = z
      .object({ day: z.iso.date({ error: "Scrivi la data nel formato 22/10/2026." }) })
      .safeParse({ day: "x" });
    if (parsed.success) throw new Error("la validazione doveva fallire");
    expect(toActionFailure(parsed.error, "ctx")).toEqual({
      ok: false,
      message: "Scrivi la data nel formato 22/10/2026.",
      fieldErrors: { day: "Scrivi la data nel formato 22/10/2026." },
      refused: true,
    });
  });

  it("i percorsi annidati si uniscono con il punto, vale la prima issue di ogni percorso", () => {
    const schema = z.object({
      days: z.array(
        z.object({
          bands: z.array(z.object({ closes: z.string({ error: "Scegli l'ora." }).min(5, { error: "Ora troppo corta." }) })),
        }),
      ),
    });
    const parsed = schema.safeParse({ days: [{ bands: [{ closes: "09:00" }, { closes: "9" }] }] });
    if (parsed.success) throw new Error("la validazione doveva fallire");
    const failure = toActionFailure(parsed.error, "ctx");
    expect(failure).toEqual({
      ok: false,
      message: "Ora troppo corta.",
      fieldErrors: { "days.0.bands.1.closes": "Ora troppo corta." },
      refused: true,
    });
  });

  it("due issue sullo stesso percorso: tiene la prima", () => {
    const parsed = z
      .object({ phone: z.string().min(8, { error: "Troppo corto." }).regex(/^\+/, { error: "Manca il prefisso." }) })
      .safeParse({ phone: "12" });
    if (parsed.success) throw new Error("la validazione doveva fallire");
    expect(toActionFailure(parsed.error, "ctx")).toEqual({
      ok: false,
      message: "Troppo corto.",
      fieldErrors: { phone: "Troppo corto." },
      refused: true,
    });
  });

  it("una issue senza percorso dà il messaggio e nessun campo", () => {
    const parsed = z
      .object({ a: z.string() })
      .refine(() => false, { error: "Dati non coerenti." })
      .safeParse({ a: "x" });
    if (parsed.success) throw new Error("la validazione doveva fallire");
    const failure = toActionFailure(parsed.error, "ctx");
    expect(failure).toEqual({ ok: false, message: "Dati non coerenti.", refused: true });
    expect("fieldErrors" in failure).toBe(false);
  });
});

describe("toActionFailure: database e imprevisti", () => {
  it("una regola del database: testo italiano e rifiuto, nel log contesto e codice ma mai i parametri", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = toActionFailure({ code: "23505", message: "duplicate key", params: ["segreto"] }, "ctx");
    expect(failure).toEqual({ ok: false, message: "Esiste già", refused: true });
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls[0]?.map(String).join(" ") ?? "";
    expect(logged.startsWith("[db] ctx: 23505")).toBe(true);
    expect(logged).not.toContain("segreto");
  });

  it("la delete bloccata ha il suo testo", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = toActionFailure(Object.assign(new Error("restrict"), { code: "23001" }), "ctx");
    expect(failure).toEqual({ ok: false, message: "È collegato ad altri dati: non si può eliminare.", refused: true });
  });

  // Un rifiuto non si riprova; un errore imprevisto sì: senza `refused` l'editor della visita ferma la coda con «Riprova».
  it("un altro errore di Postgres non è un rifiuto: testo generico", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = toActionFailure({ code: "40001", message: "could not serialize access" }, "ctx");
    expect(failure).toEqual({ ok: false, message: GENERIC });
    expect("refused" in failure).toBe(false);
  });

  it("i cinque codici con il loro testo sono rifiuti", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const code of ["23514", "23505", "23503", "23001", "42501"]) {
      expect(toActionFailure({ code, message: "x" }, "ctx")).toMatchObject({ ok: false, refused: true });
    }
  });

  it("un errore qualunque: testo generico, il dettaglio solo nel log", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = toActionFailure(new Error("boom"), "creaAppuntamento");
    expect(failure).toEqual({ ok: false, message: GENERIC });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.map(String).join(" ")).toBe("[app] creaAppuntamento: boom");
  });

  it("un valore che non è un errore non fa saltare la risposta", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(toActionFailure("boom", "ctx")).toEqual({ ok: false, message: GENERIC });
    expect(toActionFailure(undefined, "ctx")).toEqual({ ok: false, message: GENERIC });
  });
});
