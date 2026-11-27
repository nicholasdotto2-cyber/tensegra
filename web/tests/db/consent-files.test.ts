import { createHash, randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES } from "@/lib/files/messages";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { attachConsentDocument, revokeConsent } from "@/server/domain/consents/commands";
import { getConsentPreview } from "@/server/domain/consents/preview";
import type { ConsentFields, ConsentTarget } from "@/server/domain/consents/schemas";
import { NOT_ALLOWED } from "@/server/domain/errors";
import { getStoredFile } from "@/server/domain/files/queries";
import { storageKey } from "@/server/files/keys";
import { checkUpload } from "@/server/files/sniff";
import type { StoreContext } from "@/server/files/upload";
import type { ConsentDocumentData } from "@/server/pdf/consent";
import { blankConsentData, ensureConsentDocument, storeConsent, storeConsentUpload } from "@/server/pdf/consent-file";
import { renderConsentPdf } from "@/server/pdf/render";
import { PDF_NOT_CREATED } from "@/lib/consents/messages";
import { pdfText } from "../support/pdf-text";
import { CONSENT_A, CYCLE_A, PATIENT_A1, PATIENT_A2, PRACTICE_A, PRACTICE_B, USER_A, USER_B } from "./fixtures";
import { asServiceFor, asUserA, asUserB, openTestDb, setPurge } from "./helpers";
import { MemoryFileStore } from "./memory-store";

// File dei consensi. Gli orchestratori aprono le loro
// transazioni e salvano davvero: le righe si rileggono come servizio, i byte dallo store in memoria.
// Oggi è mercoledì 4/11/2026 alle 08:30 di Roma; il retry avviene il 6/11 alle 17:00.

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const later = fixedClock("2026-11-06T17:00:00+01:00");
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
const same = (a: Uint8Array | null | undefined, b: Uint8Array) => Buffer.from(a ?? []).equals(Buffer.from(b));

/** Un PNG vero di 2 x 1 pixel grigi, diverso per ogni `seed`. */
function png(seed: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 0;
  const pixels = deflateSync(Buffer.from([0, seed & 255, (seed * 7) & 255]));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]));
}
const padded = (head: number[] | string, size: number) => {
  const bytes = new Uint8Array(size).fill(0x20);
  bytes.set(typeof head === "string" ? Buffer.from(head, "latin1") : head);
  return bytes;
};

let db: Db;
let pg: PGlite;
let ctxA: StoreContext;
let ctxB: StoreContext;
const store = new MemoryFileStore();
const PRACTITIONER_PNG = png(201);
const PRACTITIONER_FILE = randomUUID();

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  ctxA = { db, actor: { userId: USER_A }, practiceId: PRACTICE_A };
  ctxB = { db, actor: { userId: USER_B }, practiceId: PRACTICE_B };
  // Firma dell'osteopata, polizza, città e demo dello studio A: la fotografia li congela.
  const key = storageKey(PRACTICE_A, "signature", PRACTITIONER_FILE, "image/png");
  await store.put(key, PRACTITIONER_PNG);
  await asServiceFor(db, async (tx) => {
    await tx.query(
      `insert into public.files (id, practice_id, kind, storage_key, mime_type, size_bytes, sha256)
       values ($1, $2, 'signature', $3, 'image/png', $4, $5)`,
      [PRACTITIONER_FILE, PRACTICE_A, key, PRACTITIONER_PNG.length, sha(PRACTITIONER_PNG)],
    );
    await tx.query(
      `update public.practice_settings set practitioner_signature_file_id=$2, insurance_policy_number='POL-ORIGINALE',
              city='Bologna', is_demo=true where practice_id=$1`,
      [PRACTICE_A, PRACTITIONER_FILE],
    );
  });
});
afterAll(async () => { await pg?.close(); });

const target = (extra: Partial<ConsentTarget> = {}): ConsentTarget => ({ patientId: PATIENT_A1, moduleKey: "informativa", cycleId: null, appointmentId: null, guardianId: null, ...extra } as ConsentTarget);
const treatment = (): ConsentTarget => target({ moduleKey: "trattamento", cycleId: CYCLE_A });

function fieldsFor(t: ConsentTarget, signedOn?: string): Promise<ConsentFields> {
  return asUserA(db, async (tx) => {
    const p = await getConsentPreview(tx, PRACTICE_A, clock, t, signedOn);
    expect(p).not.toBeNull();
    return {
      ...t, id: randomUUID(), signerName: p!.signerName, previewHash: p!.hash, outcome: "accetta", refusesInformation: false,
      refusalNote: null, trusteeName: null, trusteeContact: null, minorOpinionNote: p!.minorOpinionDefault,
      singleGuardianDeclaration: p!.signerKind !== "paziente", secondGuardianName: null, notes: null,
      choices: t.moduleKey === "informativa" ? { whatsapp: true, richiami: false } : null,
    } as ConsentFields;
  });
}

const service = <T>(fn: (tx: Tx) => Promise<T>) => asServiceFor(db, fn);
const recordOf = (id: string) => service(async (tx) => (await tx.query<Record<string, unknown>>("select * from public.consent_records where id=$1", [id]))[0]);
const fileRow = (id: unknown) => service(async (tx) => (await tx.query<{ storage_key: string; mime_type: string; size_bytes: number; sha256: string; kind: string }>(
  "select storage_key, mime_type, size_bytes, sha256, kind from public.files where id=$1", [String(id)]))[0]);
const keysOf = (kind: string) => store.keys().filter((key) => key.includes(`/${kind}/`));
const countFiles = (kind: string) => service(async (tx) => Number((await tx.query<{ n: number }>("select count(*)::int as n from public.files where practice_id=$1 and kind=$2", [PRACTICE_A, kind]))[0]!.n));

describe("file dei consensi", () => {
  it("pdf_fallisce_firma_resta", async () => {
    expect(PDF_NOT_CREATED).toBe("Firma salvata, ma il PDF non è stato creato. Riprova a crearlo.");
    const signatureKeys = keysOf("signature").length;
    // Una firma rifiutata dalla transazione 1 non lascia byte nello store.
    const stale = { ...(await fieldsFor(target({ patientId: PATIENT_A2 }))), previewHash: "0".repeat(64) };
    await expect(storeConsent(ctxA, clock, store, { fields: stale, signaturePng: png(10), secondSignaturePng: null })).rejects.toThrow("Il modulo è cambiato");
    expect(keysOf("signature")).toHaveLength(signatureKeys);

    const f = await fieldsFor(target({ patientId: PATIENT_A2 }));
    const signature = png(11);
    const failing = vi.fn(async (): Promise<Buffer> => { throw new Error("render rotto"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(storeConsent(ctxA, clock, store, { fields: f, signaturePng: signature, secondSignaturePng: null }, { renderPdf: failing })).resolves.toEqual({ id: f.id, pdfReady: false });
    expect(failing).toHaveBeenCalledTimes(1);
    // L'errore del PDF si registra nel log, senza dati del paziente.
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toBe("[app] storeConsent: PDF del consenso non creato: render rotto");
    expect(String(log.mock.calls[0]?.[0])).not.toMatch(/romano|luca/i);
    log.mockRestore();
    const saved = (await recordOf(f.id))!;
    expect(saved).toMatchObject({ document_file_id: null, signed_on: "2026-11-04", signed_at: clock.now(), practitioner_signature_file_id: PRACTITIONER_FILE });
    const savedSignature = (await fileRow(saved.signature_file_id))!;
    expect(savedSignature).toMatchObject({ kind: "signature", mime_type: "image/png", size_bytes: signature.length, sha256: sha(signature) });
    expect(same(await store.get(savedSignature.storage_key), signature)).toBe(true);
    const choices = () => service((tx) => tx.query("select choice, value from public.consent_choices where consent_record_id=$1 order by choice", [f.id]));
    expect(await choices()).toEqual([{ choice: "richiami", value: false }, { choice: "whatsapp", value: true }]);
    expect(keysOf("consent_pdf")).toEqual([]);

    // Il retry della firma non rifirma: stessi byte, nessun file nuovo nello store o nella tabella.
    const signaturesBefore = await countFiles("signature");
    await expect(storeConsent(ctxA, clock, store, { fields: f, signaturePng: signature, secondSignaturePng: null }, { renderPdf: failing })).resolves.toEqual({ id: f.id, pdfReady: false });
    expect(keysOf("signature")).toHaveLength(signatureKeys + 1);
    expect(await countFiles("signature")).toBe(signaturesBefore);

    await expect(ensureConsentDocument(ctxA, later, store, f.id, { renderPdf: failing })).rejects.toThrow("render rotto");
    expect((await recordOf(f.id))!.document_file_id).toBeNull();
    expect(keysOf("consent_pdf")).toEqual([]);

    // Polizza e firma dell'osteopata cambiano dopo la firma: il PDF stampa la fotografia.
    const newPractitioner = randomUUID(); const newPng = png(202);
    await store.put(storageKey(PRACTICE_A, "signature", newPractitioner, "image/png"), newPng);
    await service(async (tx) => {
      await tx.query("insert into public.files (id, practice_id, kind, storage_key, mime_type, size_bytes, sha256) values ($1,$2,'signature',$3,'image/png',$4,$5)",
        [newPractitioner, PRACTICE_A, storageKey(PRACTICE_A, "signature", newPractitioner, "image/png"), newPng.length, sha(newPng)]);
      await tx.query("update public.practice_settings set practitioner_signature_file_id=$2, insurance_policy_number='POL-NUOVA' where practice_id=$1", [PRACTICE_A, newPractitioner]);
    });
    let captured: ConsentDocumentData | undefined;
    const doc = await ensureConsentDocument(ctxA, later, store, f.id, { renderPdf: async (d) => { captured = d; return renderConsentPdf(d); } });
    await service((tx) => tx.query("update public.practice_settings set practitioner_signature_file_id=$2, insurance_policy_number='POL-ORIGINALE' where practice_id=$1", [PRACTICE_A, PRACTITIONER_FILE]));
    expect(doc).toMatchObject({ mimeType: "application/pdf", fileName: "consenso-2026-11-04.pdf" });
    expect(captured).toMatchObject({ mode: "signed", text: saved.rendered_text, signerName: saved.signer_name, signedOn: "2026-11-04", signedAt: clock.now().toISOString(), place: "Bologna", demo: true, version: "2026.1", secondSignaturePng: null });
    expect(same(captured!.signaturePng, signature)).toBe(true);
    expect(same(captured!.practitionerSignaturePng, PRACTITIONER_PNG)).toBe(true);
    const text = (await pdfText(doc!.bytes)).text.replace(/\s+/g, " ");
    expect(text).toContain("Firmato a Bologna il 04/11/2026 alle 08:30.");
    expect(text).toContain("Promemoria e comunicazioni su WhatsApp: Sì");
    expect(text).not.toContain("17:00");

    const after = (await recordOf(f.id))!;
    expect(after.document_file_id).not.toBeNull();
    for (const column of ["rendered_text", "rendered_hash", "signature_file_id", "signed_at", "practitioner_signature_file_id"]) expect(after[column]).toEqual(saved[column]);
    const pdfRow = (await fileRow(after.document_file_id))!;
    expect(pdfRow).toMatchObject({ kind: "consent_pdf", mime_type: "application/pdf", size_bytes: doc!.bytes.length, sha256: sha(doc!.bytes) });
    expect(sha((await store.get(pdfRow.storage_key))!)).toBe(pdfRow.sha256);
    expect(await choices()).toHaveLength(2);
    expect(await service((tx) => tx.query("select id from public.consent_records where patient_id=$1 and module_key='informativa'", [PATIENT_A2]))).toHaveLength(1);
  });

  it("upload_sniff", async () => {
    const accepted: [string, Uint8Array, string, string][] = [
      ["PDF di 10 MB", padded("%PDF-1.4\n", MAX_FILE_BYTES), "application/pdf", "pdf"],
      ["JPG", padded([0xff, 0xd8, 0xff, 0xe0], 4096), "image/jpeg", "jpg"],
      ["PNG", png(31), "image/png", "png"],
    ];
    for (const [, bytes, mime, ext] of accepted) {
      const f = await fieldsFor(target(), clock.today());
      const { id } = await storeConsentUpload(ctxA, clock, store, { fields: f, signedOn: clock.today(), bytes });
      expect(id).toBe(f.id);
      const record = (await recordOf(id))!;
      const row = (await fileRow(record.document_file_id))!;
      expect(row).toMatchObject({ kind: "consent_upload", mime_type: mime, size_bytes: bytes.length, sha256: sha(bytes) });
      const kept = (await store.get(row.storage_key))!;
      expect(same(kept, bytes)).toBe(true);
      expect(sha(kept)).toBe(row.sha256);
      const served = (await ensureConsentDocument(ctxA, later, store, id, { renderPdf: vi.fn() }))!;
      expect(served.mimeType).toBe(mime);
      expect(served.fileName).toBe(`consenso-2026-11-04.${ext}`);
      expect(same(served.bytes, bytes)).toBe(true);
    }
    const rejected: [Uint8Array, string][] = [
      [padded("%PDF-1.4\n", MAX_FILE_BYTES + 1), "Il file supera i 10 MB."],
      [padded("RIFF\x24\x00\x00\x00WEBPVP8 ", 64), "Il file non è un PDF o un'immagine."],
      [new TextEncoder().encode("ciao, sono un modulo.pdf"), "Il file non è un PDF o un'immagine."],
    ];
    for (const [bytes, message] of rejected) {
      const keys = store.keys();
      const f = await fieldsFor(target(), clock.today());
      await expect(storeConsentUpload(ctxA, clock, store, { fields: f, signedOn: clock.today(), bytes })).rejects.toThrow(message);
      expect(store.keys()).toEqual(keys);
      expect(await recordOf(f.id)).toBeUndefined();
    }
    // Le frasi delle foto restano quelle globali.
    expect(checkUpload(padded([0xff, 0xd8, 0xff], MAX_FILE_BYTES + 1), ["image/jpeg"])).toEqual({ ok: false, message: "File troppo grande (massimo 10 MB)" });
    expect(checkUpload(new TextEncoder().encode("ciao"), ["image/jpeg"])).toEqual({ ok: false, message: "Il file non è un'immagine JPEG, PNG o WebP." });
  });

  it("seconda_richiesta", async () => {
    const f = await fieldsFor(treatment());
    await expect(storeConsent(ctxA, clock, store, { fields: f, signaturePng: png(41), secondSignaturePng: null })).resolves.toEqual({ id: f.id, pdfReady: true });
    const first = (await ensureConsentDocument(ctxA, later, store, f.id))!;
    const never = vi.fn();
    const second = (await ensureConsentDocument(ctxA, later, store, f.id, { renderPdf: never }))!;
    expect(never).not.toHaveBeenCalled();
    expect(same(second.bytes, first.bytes)).toBe(true);
    expect((await pdfText(first.bytes)).text.replace(/\s+/g, " ")).toContain("POL-ORIGINALE");
    const documentId = (await recordOf(f.id))!.document_file_id;

    // Un secondo collegamento non sostituisce il documento.
    const otherId = randomUUID();
    const other = { id: otherId, storageKey: storageKey(PRACTICE_A, "consent_pdf", otherId, "application/pdf"), mime: "application/pdf", size: first.bytes.length, sha256: sha(first.bytes) };
    await expect(asUserA(db, (tx) => attachConsentDocument(tx, PRACTICE_A, clock, { consentId: f.id, file: other }))).rejects.toThrow(NOT_ALLOWED);
    expect((await recordOf(f.id))!.document_file_id).toBe(documentId);
    expect(await fileRow(otherId)).toBeUndefined();

    // Due richieste insieme: si serve il PDF salvato per primo, il perdente toglie solo il suo file.
    const g = await fieldsFor(target());
    await storeConsent(ctxA, clock, store, { fields: g, signaturePng: png(42), secondSignaturePng: null }, { renderPdf: async () => { throw new Error("render rotto"); } });
    const pdfKeys = keysOf("consent_pdf").length;
    let calls = 0; let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = async (d: ConsentDocumentData) => { calls += 1; if (calls === 2) release(); await gate; return renderConsentPdf(d); };
    const [x, y] = await Promise.all([ensureConsentDocument(ctxA, clock, store, g.id, { renderPdf: slow }), ensureConsentDocument(ctxA, clock, store, g.id, { renderPdf: slow })]);
    expect(calls).toBe(2);
    expect(same(x!.bytes, y!.bytes)).toBe(true);
    expect(keysOf("consent_pdf")).toHaveLength(pdfKeys + 1);
    const winner = (await fileRow((await recordOf(g.id))!.document_file_id))!;
    expect(sha(x!.bytes)).toBe(winner.sha256);
    expect(store.keys()).toContain(winner.storage_key);
  });

  it("file_assente", async () => {
    const f = await fieldsFor(target({ patientId: PATIENT_A2 }));
    expect((await storeConsent(ctxA, clock, store, { fields: f, signaturePng: png(51), secondSignaturePng: null })).pdfReady).toBe(true);
    const documentId = (await recordOf(f.id))!.document_file_id;
    const row = (await fileRow(documentId))!;
    const bytes = (await store.get(row.storage_key))!;
    const pdfFiles = await countFiles("consent_pdf");
    const render = vi.fn();

    await store.remove(row.storage_key);
    expect(await ensureConsentDocument(ctxA, later, store, f.id, { renderPdf: render })).toBeNull();
    await store.put(row.storage_key, padded("%PDF-1.4\n", bytes.length));
    expect(await ensureConsentDocument(ctxA, later, store, f.id, { renderPdf: render })).toBeNull();
    expect(render).not.toHaveBeenCalled();
    expect((await recordOf(f.id))!.document_file_id).toBe(documentId);
    expect(await countFiles("consent_pdf")).toBe(pdfFiles);

    await store.put(row.storage_key, bytes);
    await asUserA(db, (tx) => revokeConsent(tx, PRACTICE_A, clock, { id: f.id, revokedOn: clock.today(), mode: "verbale", note: null }));
    expect((await recordOf(f.id))!.status).toBe("revocato");
    const revoked = (await ensureConsentDocument(ctxA, later, store, f.id, { renderPdf: render }))!;
    expect(same(revoked.bytes, bytes)).toBe(true);
  });

  it("etichetta_sconosciuta", async () => {
    const message = "Dato mancante senza etichetta: chiave.sconosciuta";
    const preview = (await asUserA(db, (tx) => getConsentPreview(tx, PRACTICE_A, clock, treatment())))!;
    expect(() => blankConsentData({ ...preview, rendered: { ...preview.rendered, missingFields: ["chiave.sconosciuta"] } }, clock.today())).toThrow(message);

    const f = await fieldsFor(treatment());
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    await storeConsent(ctxA, clock, store, { fields: f, signaturePng: png(71), secondSignaturePng: null }, { renderPdf: async () => { throw new Error("render rotto"); } });
    await service(async (tx) => {
      await setPurge(tx, PRACTICE_A);
      await tx.query("update public.consent_records set missing_fields = array_append(missing_fields, 'chiave.sconosciuta') where id=$1", [f.id]);
    });
    const render = vi.fn();
    await expect(ensureConsentDocument(ctxA, clock, store, f.id, { renderPdf: render })).rejects.toThrow(message);
    expect(render).not.toHaveBeenCalled();
    expect((await recordOf(f.id))!.document_file_id).toBeNull();
  });

  it("stampa_senza_righe", async () => {
    const counts = () => service(async (tx) => (await tx.query<Record<string, number>>(
      `select (select count(*)::int from public.consent_records) as records, (select count(*)::int from public.consent_choices) as choices,
              (select count(*)::int from public.files) as files, (select count(*)::int from public.message_log) as messages,
              (select count(*)::int from public.invoice_events) as invoice_events`))[0]);
    const before = await counts();
    const keys = store.keys();
    const preview = (await asUserA(db, (tx) => getConsentPreview(tx, PRACTICE_A, clock, treatment())))!;
    const data = blankConsentData(preview, clock.today());
    expect(data).toMatchObject({ mode: "blank", text: preview.rendered.text, signaturePng: null, practitionerSignaturePng: null, signedAt: null });
    const text = (await pdfText(new Uint8Array(await renderConsentPdf(data)))).text.replace(/\s+/g, " ");
    expect(text).toContain("POL-ORIGINALE");
    expect(text).not.toMatch(/Firmat/);
    expect(await counts()).toEqual(before);
    expect(store.keys()).toEqual(keys);
  });

  it("route_isolata", async () => {
    // Firmato senza PDF: se l'isolamento cedesse, la richiesta di B lo genererebbe.
    const f = await fieldsFor(target());
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    await storeConsent(ctxA, clock, store, { fields: f, signaturePng: png(61), secondSignaturePng: null }, { renderPdf: async () => { throw new Error("render rotto"); } });
    const u = await fieldsFor(target(), clock.today());
    await storeConsentUpload(ctxA, clock, store, { fields: u, signedOn: clock.today(), bytes: padded("%PDF-1.4\n", 2048) });
    const before = await recordOf(f.id);
    const filesBefore = store.keys();
    const render = vi.fn();
    const asB = [ctxB, { ...ctxA, practiceId: PRACTICE_B }] as const;
    for (const ctx of asB) for (const id of [f.id, u.id]) expect(await ensureConsentDocument(ctx, clock, store, id, { renderPdf: render })).toBeNull();
    expect(await ensureConsentDocument(ctxA, clock, store, "abc", { renderPdf: render })).toBeNull();
    // La firma della fixture è una foto e non è nello store: niente documento, niente file nuovi.
    expect(await ensureConsentDocument(ctxA, clock, store, CONSENT_A, { renderPdf: render })).toBeNull();
    expect(render).not.toHaveBeenCalled();
    const fileId = randomUUID();
    const file = { id: fileId, storageKey: storageKey(PRACTICE_B, "consent_pdf", fileId, "application/pdf"), mime: "application/pdf", size: 10, sha256: "0".repeat(64) };
    for (const practice of [PRACTICE_A, PRACTICE_B]) {
      await expect(asUserB(db, (tx) => attachConsentDocument(tx, practice, clock, { consentId: f.id, file }))).rejects.toThrow(NOT_ALLOWED);
    }
    expect(await recordOf(f.id)).toEqual(before);
    expect(store.keys()).toEqual(filesBefore);

    // Gli stessi due consensi si servono ad A: il null di B non viene da un documento mancante.
    const doc = (await ensureConsentDocument(ctxA, clock, store, f.id))!;
    expect(doc.fileName).toBe("consenso-2026-11-04.pdf");
    expect(doc.fileName).not.toMatch(/ferrari|giulia/i);
    expect(await ensureConsentDocument(ctxA, clock, store, u.id)).not.toBeNull();
    for (const ctx of asB) for (const id of [f.id, u.id]) expect(await ensureConsentDocument(ctx, clock, store, id, { renderPdf: render })).toBeNull();
    expect(render).not.toHaveBeenCalled();
    // Firme e documenti dei consensi non passano da /api/files.
    const record = (await recordOf(f.id))!;
    await asUserA(db, async (tx) => {
      for (const id of [record.signature_file_id, record.document_file_id, PRACTITIONER_FILE]) expect(await getStoredFile(tx, PRACTICE_A, String(id))).toBeNull();
    });
  });
});
