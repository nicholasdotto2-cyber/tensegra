import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, Tx } from "@/server/db/db";
import { invoiceDraft, issueInvoice, PRACTICE_A, PRACTICE_B } from "./fixtures";
import { asServiceFor, asUserA, asUserB, expectPgError, idOf, insertRow, openTestDb, type Values } from "./helpers";

// Numerazioni senza buchi: il numero passa solo da app.next_number, nella
// transazione che lo usa. Ogni test usa contatori suoi (serie e anno), così l'ordine dei test non conta.

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

async function nextNumber(tx: Tx, practiceId: string, series: string, year: number): Promise<number | undefined> {
  const [row] = await tx.query<{ n: number }>("select app.next_number($1, $2, $3) as n", [practiceId, series, year]);
  return row?.n;
}

const nextA = (series: string, year: number) => asUserA(db, (tx) => nextNumber(tx, PRACTICE_A, series, year));

async function lastNumber(practiceId: string, series: string, year: number): Promise<number | undefined> {
  const [row] = await asServiceFor(db, (tx) =>
    tx.query<{ n: number }>(
      "select last_number as n from public.number_series where practice_id = $1 and series = $2 and year = $3",
      [practiceId, series, year],
    ),
  );
  return row?.n;
}

describe("app.next_number", () => {
  it("uA emette 1, 2, 3 nel 2026; uB emette la sua 1", async () => {
    expect([await nextA("TD01", 2026), await nextA("TD01", 2026), await nextA("TD01", 2026)]).toEqual([1, 2, 3]);
    expect(await asUserB(db, (tx) => nextNumber(tx, PRACTICE_B, "TD01", 2026))).toBe(1);
  });

  it("una transazione fallita non consuma il numero", async () => {
    expect([await nextA("TD01", 2030), await nextA("TD01", 2030), await nextA("TD01", 2030)]).toEqual([1, 2, 3]);
    const boom = new Error("emissione fallita dopo aver preso il numero");
    await expect(
      asUserA(db, async (tx) => {
        expect(await nextNumber(tx, PRACTICE_A, "TD01", 2030)).toBe(4);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await nextA("TD01", 2030)).toBe(4);
  });

  it("ogni anno e ogni serie ha il suo contatore", async () => {
    expect(await lastNumber(PRACTICE_A, "TD01", 2025)).toBe(7);
    expect(await nextA("TD01", 2027)).toBe(1);
    expect(await nextA("TD04", 2026)).toBe(1);
    expect(await nextA("INVIO", 0)).toBe(1);
    expect(await lastNumber(PRACTICE_A, "TD01", 2025)).toBe(7);
  });

  it("INVIO con un anno: 23514", async () => {
    await expectPgError(nextA("INVIO", 2026), "23514");
  });

  it("uA chiede un numero dello studio B: 42501", async () => {
    await expectPgError(
      asUserA(db, (tx) => nextNumber(tx, PRACTICE_B, "TD04", 2026)),
      "42501",
    );
    expect(await lastNumber(PRACTICE_B, "TD04", 2026)).toBeUndefined();
  });
});

describe("number_series: authenticated ha solo select", () => {
  it("insert diretto come uA, anche per lo studio A: 42501", async () => {
    await expectPgError(
      asUserA(db, (tx) =>
        tx.query("insert into public.number_series (practice_id, series, year, last_number) values ($1, 'TD01', 2040, 0)", [
          PRACTICE_A,
        ]),
      ),
      "42501",
    );
  });

  it("update e delete diretti come uA sulla riga di A: 42501, il contatore resta", async () => {
    await expectPgError(
      asUserA(db, (tx) =>
        tx.query("update public.number_series set last_number = 0 where practice_id = $1", [PRACTICE_A]),
      ),
      "42501",
    );
    await expectPgError(
      asUserA(db, (tx) => tx.query("delete from public.number_series where practice_id = $1", [PRACTICE_A])),
      "42501",
    );
    expect(await lastNumber(PRACTICE_A, "TD01", 2025)).toBe(7);
  });
});

// Il numero arriva solo all'emissione (update diretto come uA, `issueInvoice`), una serie per
// tipo e per anno. Ogni test ha il suo anno, e le fatture emesse restano salvate nel clone di questo file.
describe("numeri delle fatture", () => {
  /** Una bozza di A1 in forfettario, pagata con carta: restituisce il suo id. */
  async function draftA(tx: Tx, extra: Values = {}): Promise<string> {
    return idOf(await insertRow(tx, "invoices", invoiceDraft(extra)));
  }

  it("una bozza cancellata non lascia buchi", async () => {
    const first = await asUserA(db, async (tx) => issueInvoice(tx, { invoiceId: await draftA(tx), issueDate: "2031-03-02" }));
    const deleted = await asUserA(db, async (tx) => {
      const draftId = await draftA(tx);
      return tx.query("delete from public.invoices where id = $1 returning id", [draftId]);
    });
    const second = await asUserA(db, async (tx) => issueInvoice(tx, { invoiceId: await draftA(tx), issueDate: "2031-03-03" }));
    expect(deleted).toHaveLength(1);
    expect([first, second]).toEqual([1, 2]);
    expect(await lastNumber(PRACTICE_A, "TD01", 2031)).toBe(2);
  });

  it("stesso numero su TD01 e TD04 passa; due TD01 uguali nello stesso anno 23505", async () => {
    const labels = await asUserA(db, async (tx) => {
      const invoiceId = await draftA(tx);
      await issueInvoice(tx, { invoiceId, issueDate: "2032-05-04" });
      const creditNoteId = await draftA(tx, { doc_type: "TD04", credited_invoice_id: invoiceId });
      await issueInvoice(tx, { invoiceId: creditNoteId, issueDate: "2032-05-06" });
      return tx.query<{ doc_type: string; number: number; number_label: string }>(
        "select doc_type, number, number_label from public.invoices where id in ($1, $2) order by doc_type",
        [invoiceId, creditNoteId],
      );
    });
    expect(labels).toEqual([
      { doc_type: "TD01", number: 1, number_label: "1/2032" },
      { doc_type: "TD04", number: 1, number_label: "NC-1/2032" },
    ]);
    await expectPgError(
      asUserA(db, async (tx) => issueInvoice(tx, { invoiceId: await draftA(tx), issueDate: "2032-05-07", number: 1 })),
      "23505",
    );
  });

  it("year diverso dall'anno di issue_date: 23514", async () => {
    await expectPgError(
      asUserA(db, async (tx) => issueInvoice(tx, { invoiceId: await draftA(tx), issueDate: "2034-01-02", year: 2033 })),
      "23514",
    );
  });
});
