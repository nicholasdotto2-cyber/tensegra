import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db, SqlParam, Tx } from "@/server/db/db";
import { PRACTICE_A, PRACTICE_B, USER_A, USER_B } from "./fixtures";
import { asServiceFor, asUserA, expectPgError, openTestDb } from "./helpers";

// Vincoli di public.files: la chiave di storage non esce dalla cartella
// dello studio, tipo e peso sono limitati, created_by lo scrive il trigger.

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

interface FileInput {
  storageKey?: string;
  mimeType?: string;
  sizeBytes?: number;
  createdBy?: string | null;
}

/** Inserisce un file dello studio A (valido salvo ciò che `input` cambia); `returning` dà chiave e created_by. */
async function insertFile(tx: Tx, input: FileInput = {}): Promise<{ storage_key: string; created_by: string | null }[]> {
  const params: SqlParam[] = [
    PRACTICE_A,
    input.storageKey ?? `${PRACTICE_A}/posture_photo/${randomUUID()}.jpg`,
    input.mimeType ?? "image/jpeg",
    input.sizeBytes ?? 2048,
    "f".repeat(64),
    input.createdBy ?? null,
  ];
  return tx.query(
    `insert into public.files (practice_id, kind, storage_key, mime_type, size_bytes, sha256, created_by)
     values ($1, 'posture_photo', $2, $3, $4, $5, $6)
     returning storage_key, created_by`,
    params,
  );
}

describe("public.files", () => {
  it("accetta una chiave <studio>/<tipo>/<uuid>.jpg", async () => {
    const key = `${PRACTICE_A}/posture_photo/${randomUUID()}.jpg`;
    const rows = await asUserA(db, (tx) => insertFile(tx, { storageKey: key }));
    expect(rows.map((row) => row.storage_key)).toEqual([key]);
  });

  it("rifiuta una chiave con ..: 23514", async () => {
    const key = `${PRACTICE_A}/posture_photo/../${randomUUID()}.jpg`;
    await expectPgError(
      asUserA(db, (tx) => insertFile(tx, { storageKey: key })),
      "23514",
    );
  });

  it("rifiuta su una riga di A una chiave nella cartella di B: 23514", async () => {
    const key = `${PRACTICE_B}/posture_photo/${randomUUID()}.jpg`;
    await expectPgError(
      asUserA(db, (tx) => insertFile(tx, { storageKey: key })),
      "23514",
    );
  });

  it("rifiuta un file oltre 10 MB: 23514", async () => {
    await expectPgError(
      asUserA(db, (tx) => insertFile(tx, { sizeBytes: 10485761 })),
      "23514",
    );
  });

  it("rifiuta image/heic: 23514", async () => {
    await expectPgError(
      asUserA(db, (tx) => insertFile(tx, { mimeType: "image/heic" })),
      "23514",
    );
  });

  it("created_by lo scrive il trigger: uA che passa USER_B ottiene USER_A, il servizio null", async () => {
    const byUser = await asUserA(db, (tx) => insertFile(tx, { createdBy: USER_B }));
    expect(byUser.map((row) => row.created_by)).toEqual([USER_A]);
    const byService = await asServiceFor(db, (tx) => insertFile(tx, { createdBy: USER_A }));
    expect(byService.map((row) => row.created_by)).toEqual([null]);
  });

  it("uA cerca per id un file di B: 0 righe", async () => {
    const [fileOfB] = await asServiceFor(db, (tx) =>
      tx.query<{ id: string }>("select id from public.files where practice_id = $1 limit 1", [PRACTICE_B]),
    );
    if (!fileOfB) throw new Error("le fixture non hanno un file dello studio B");
    expect(await asUserA(db, (tx) => tx.query("select id from public.files where id = $1", [fileOfB.id]))).toEqual([]);
  });
});
