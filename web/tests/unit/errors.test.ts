import { afterEach, describe, expect, it, vi } from "vitest";
import { logDbError, pgCode, scrubDbError, toUserMessage } from "@/server/db/errors";

const e = (code: string) => Object.assign(new Error("dettaglio interno"), { code });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toUserMessage", () => {
  it("codici noti e messaggio generico", () => {
    expect(toUserMessage(e("42501"))).toBe("Operazione non permessa");
    expect(toUserMessage(e("23505"))).toBe("Esiste già");
    expect(toUserMessage(e("23503"))).toBe("Collegato a un dato che non esiste o non è dello studio");
    expect(toUserMessage(e("23514"))).toBe("Valore non valido");
    expect(toUserMessage(new Error("boom"))).toBe(
      "Qualcosa non ha funzionato. I dati già salvati sono al sicuro. Ricarica la pagina.",
    );
    expect(toUserMessage(e("42501"))).not.toContain("dettaglio");
  });

  // Una delete bloccata da una chiave `on delete restrict` risponde 23001 su Postgres 18 (PGlite) e
  // 23503 su Postgres 17 (Supabase). Il 23503 resta quello dell'insert verso un genitore che non c'è.
  it("23001, la delete bloccata da una chiave esterna, ha un messaggio suo", () => {
    expect(toUserMessage(e("23001"))).toBe("È collegato ad altri dati: non si può eliminare.");
    expect(toUserMessage(e("23001"))).not.toContain("dettaglio");
    expect(toUserMessage(e("23503"))).toBe("Collegato a un dato che non esiste o non è dello studio");
  });
});

describe("pgCode", () => {
  it("legge il codice di Postgres e niente altro", () => {
    expect(pgCode(e("23505"))).toBe("23505");
    expect(pgCode(new Error("boom"))).toBeUndefined();
    expect(pgCode("boom")).toBeUndefined();
    expect(pgCode(null)).toBeUndefined();
  });
});

describe("logDbError", () => {
  it("scrive contesto, codice e messaggio, mai i parametri", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      query: "insert into public.patients (email) values ($1)",
      params: ["mario.rossi@example.com"],
    });
    logDbError(err, "createPatient");
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls[0]?.map(String).join(" ") ?? "";
    expect(logged).toContain("createPatient");
    expect(logged).toContain("23505");
    expect(logged).toContain("duplicate key value violates unique constraint");
    expect(logged).not.toContain("mario.rossi@example.com");
  });

  // Classe 22 (data exception): Postgres scrive il valore del parametro nel messaggio, fra
  // virgolette e senza fare l'escape delle virgolette interne.
  it("negli errori della classe 22 toglie il valore fra virgolette", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logDbError(Object.assign(new Error('invalid input syntax for type uuid: "a"b"c"d"'), { code: "22P02" }), "x");
    logDbError(Object.assign(new Error('value "99999999999" is out of range for type integer'), { code: "22003" }), "y");
    expect(error.mock.calls).toEqual([
      ['[db] x: 22P02 invalid input syntax for type uuid: "…"'],
      ['[db] y: 22003 value "…" is out of range for type integer'],
    ]);
  });

  it("negli altri errori tiene i nomi fra virgolette", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logDbError(
      Object.assign(new Error('duplicate key value violates unique constraint "patients_email_key"'), { code: "23505" }),
      "z",
    );
    expect(error.mock.calls).toEqual([['[db] z: 23505 duplicate key value violates unique constraint "patients_email_key"']]);
  });
});

describe("scrubDbError", () => {
  it("toglie params e detail, e il valore dal messaggio e dallo stack della classe 22", () => {
    const error = Object.assign(new Error('invalid input syntax for type uuid: "RSSMRA85B30H501X"'), {
      code: "22P02",
      params: ["RSSMRA85B30H501X"],
      detail: "x",
      query: "select $1::uuid",
    });
    expect(scrubDbError(error)).toBe(error);
    expect(error).not.toHaveProperty("params");
    expect(error).not.toHaveProperty("detail");
    expect(error.message).toBe('invalid input syntax for type uuid: "…"');
    expect(error.stack).not.toContain("RSSMRA85B30H501X");
    expect(error).toMatchObject({ code: "22P02", query: "select $1::uuid" });
  });

  it("lascia stare gli errori che non sono di Postgres", () => {
    const own = Object.assign(new Error("boom"), { detail: "resta" });
    expect(scrubDbError(own)).toBe(own);
    expect(own).toMatchObject({ message: "boom", detail: "resta" });
    expect(scrubDbError("testo")).toBe("testo");
    expect(scrubDbError(null)).toBeNull();
  });
});
