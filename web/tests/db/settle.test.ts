import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/db";
import { settle } from "@/server/db/settle";
import { PRACTICE_A } from "./fixtures";
import { asServiceFor, asUserA, inUserA, openTestDb } from "./helpers";

// Un blocco di Oggi che fallisce non deve fermare la transazione della pagina:
// ogni blocco gira dentro un savepoint.

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("settle", () => {
  it("settle: un blocco che fallisce non ferma la transazione", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const settled = await asUserA(db, async (tx) => {
      const result = await settle(tx, "blocco_a", () => tx.query("select 1 / 0"));
      // Dopo il blocco fallito la transazione scrive ancora.
      await tx.query("update public.practice_settings set practitioner_title = $2 where practice_id = $1", [
        PRACTICE_A,
        "Osteopata D.O.",
      ]);
      return result;
    });
    expect(settled).toEqual({ ok: false });
    // Dopo il commit, come servizio: la scrittura fatta dopo il blocco fallito è salvata.
    const [row] = await asServiceFor(db, (tx) =>
      tx.query<{ practitioner_title: string }>(
        "select practitioner_title from public.practice_settings where practice_id = $1",
        [PRACTICE_A],
      ),
    );
    expect(row?.practitioner_title).toBe("Osteopata D.O.");
  });

  it("settle: le scritture di un blocco fallito tornano indietro, quelle degli altri restano", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const titles = await inUserA(db, async (tx) => {
      const failed = await settle(tx, "blocco_b", async () => {
        await tx.query("update public.practice_settings set practitioner_title = 'Da annullare' where practice_id = $1", [
          PRACTICE_A,
        ]);
        return tx.query("select 1 / 0");
      });
      const ok = await settle(tx, "blocco_c", () =>
        tx.query("update public.practice_settings set practitioner_title = 'Tenuto' where practice_id = $1", [PRACTICE_A]),
      );
      const rows = await tx.query<{ practitioner_title: string }>(
        "select practitioner_title from public.practice_settings where practice_id = $1",
        [PRACTICE_A],
      );
      return { failed, ok, title: rows[0]?.practitioner_title };
    });
    expect(titles.failed).toEqual({ ok: false });
    expect(titles.ok).toEqual({ ok: true, value: [] });
    expect(titles.title).toBe("Tenuto");
  });

  it("settle: restituisce il valore", async () => {
    const settled = await inUserA(db, (tx) => settle(tx, "blocco_a", () => tx.query("select 1 as n")));
    expect(settled).toEqual({ ok: true, value: [{ n: 1 }] });
  });

  it("settle: un errore che non è del database fallisce lo stesso il blocco, non la pagina", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const settled = await inUserA(db, async (tx) => {
      const result = await settle(tx, "blocco_a", async () => {
        throw new TypeError("campo mancante");
      });
      const next = await tx.query("select 2 as n");
      return { result, next };
    });
    expect(settled.result).toEqual({ ok: false });
    expect(settled.next).toEqual([{ n: 2 }]);
  });

  it("settle: nome non valido", async () => {
    await inUserA(db, async (tx) => {
      for (const name of ["a-b", "A", "1a", "", "a b", "a;drop table x", "blocco_a; select 1"]) {
        await expect(settle(tx, name, () => tx.query("select 1"))).rejects.toBeInstanceOf(RangeError);
      }
    });
  });

  it("settle: scrive nel log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await inUserA(db, (tx) => settle(tx, "blocco_a", () => tx.query("select 1 / 0")));
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.map(String).join(" ")).toContain("[db] blocco_a: 22012");
  });
});
