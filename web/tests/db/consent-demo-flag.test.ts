import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/clock";
import type { Db } from "@/server/db/db";
import { signConsent, uploadConsent } from "@/server/domain/consents/commands";
import { getConsentPreview } from "@/server/domain/consents/preview";
import { getConsentDocumentSource } from "@/server/domain/consents/queries";
import type { ConsentFields, ConsentTarget } from "@/server/domain/consents/schemas";
import { storageKey } from "@/server/files/keys";
import { ensureConsentDocument } from "@/server/pdf/consent-file";
import { pdfText } from "../support/pdf-text";
import { CONSENT_A, PATIENT_A1, PRACTICE_A, USER_A } from "./fixtures";
import { asServiceFor, asUserA, expectPgError, openTestDb, setPurge } from "./helpers";
import { MemoryFileStore } from "./memory-store";

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const store = new MemoryFileStore();
let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

const setDemo = (demo: boolean) => asServiceFor(db, (tx) => tx.query(
  "update public.practice_settings set is_demo=$2 where practice_id=$1", [PRACTICE_A, demo],
));
const recordOf = (id: string) => asServiceFor(db, async (tx) => (
  await tx.query("select * from public.consent_records where id=$1", [id])
)[0]!);
const sourceOf = (id: string) => asUserA(db, (tx) => getConsentDocumentSource(tx, PRACTICE_A, id));

async function collect(method: "tela" | "pdf_caricato") {
  const target: ConsentTarget = { patientId: PATIENT_A1, moduleKey: "informativa", cycleId: null, appointmentId: null, guardianId: null };
  const id = randomUUID();
  const mime = method === "tela" ? "image/png" : "application/pdf";
  const bytes = method === "tela"
    ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")
    : Buffer.from("%PDF-1.4\n%%EOF");
  const file = { id, storageKey: storageKey(PRACTICE_A, method === "tela" ? "signature" : "consent_upload", id, mime), mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  await store.put(file.storageKey, bytes);
  return asUserA(db, async (tx) => {
    const preview = (await getConsentPreview(tx, PRACTICE_A, clock, target))!;
    const fields: ConsentFields = {
      ...target, id: randomUUID(), signerName: preview.signerName, previewHash: preview.hash,
      outcome: "accetta", refusesInformation: false, refusalNote: null, trusteeName: null,
      trusteeContact: null, minorOpinionNote: null, singleGuardianDeclaration: false,
      secondGuardianName: null, notes: null, choices: { whatsapp: true, richiami: false },
    };
    const save = () => asUserA(db, (retryTx) => method === "tela"
      ? signConsent(retryTx, PRACTICE_A, clock, { fields, signature: file, secondSignature: null })
      : uploadConsent(retryTx, PRACTICE_A, clock, { fields, document: file, signedOn: clock.today() }));
    const result = method === "tela"
      ? await signConsent(tx, PRACTICE_A, clock, { fields, signature: file, secondSignature: null })
      : await uploadConsent(tx, PRACTICE_A, clock, { fields, document: file, signedOn: clock.today() });
    return { ...result, retry: save };
  });
}

describe("fotografia del flag demo nei consensi", () => {
  it("flag_scritto_alla_raccolta", async () => {
    for (const demo of [true, false]) {
      await setDemo(demo);
      for (const method of ["tela", "pdf_caricato"] as const) {
        const { id } = await collect(method);
        expect((await recordOf(id)).demo).toBe(demo);
        // Anche false resta congelato se lo studio passa successivamente in demo.
        await setDemo(!demo);
        expect((await sourceOf(id))!.demo).toBe(demo);
        await setDemo(demo);
      }
    }
  });

  it("pdf_dopo_demo_spenta", async () => {
    await setDemo(true);
    const { id } = await collect("tela");
    expect((await recordOf(id)).document_file_id).toBeNull();
    await setDemo(false);
    const document = await ensureConsentDocument({ db, actor: { userId: USER_A }, practiceId: PRACTICE_A }, clock, store, id);
    expect(document).not.toBeNull();
    // pdfText separa le pagine con un ritorno a capo: il timbro deve esserci su ognuna.
    const pages = (await pdfText(document!.bytes)).text.split("\n");
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) expect(page).toContain("DATI DI PROVA");
    expect((await recordOf(id)).document_file_id).not.toBeNull();
  });

  it("flag_immutabile", async () => {
    await setDemo(true);
    const { id } = await collect("tela");
    await expectPgError(asServiceFor(db, (tx) => tx.query(
      "update public.consent_records set demo=false where id=$1", [id],
    )), "42501", /Un consenso firmato non si modifica/);
    expect((await recordOf(id)).demo).toBe(true);
    await asServiceFor(db, async (tx) => {
      await setPurge(tx, PRACTICE_A);
      await tx.query("update public.consent_records set demo=false where id=$1", [id]);
    });
    expect((await recordOf(id)).demo).toBe(false);
  });

  it("righe_vecchie_come_oggi", async () => {
    // La fixture non scrive demo: la migrazione non deve aggiornare le righe vecchie.
    expect((await recordOf(CONSENT_A)).demo).toBeNull();
    for (const demo of [true, false]) {
      await setDemo(demo);
      expect((await sourceOf(CONSENT_A))!.demo).toBe(demo);
      expect((await recordOf(CONSENT_A)).demo).toBeNull();
    }
  });

  it("retry_riga_vecchia_conserva_null", async () => {
    await setDemo(true);
    for (const method of ["tela", "pdf_caricato"] as const) {
      const { id, retry } = await collect(method);
      // Simula la riga raccolta prima della migrazione con gli stessi campi e byte.
      await asServiceFor(db, async (tx) => {
        await setPurge(tx, PRACTICE_A);
        await tx.query("update public.consent_records set demo=null where id=$1", [id]);
      });
      const before = await recordOf(id);
      await expect(retry()).resolves.toEqual({ id });
      expect(await recordOf(id)).toEqual(before);
      expect((await sourceOf(id))!.demo).toBe(true);
    }
  });
});
