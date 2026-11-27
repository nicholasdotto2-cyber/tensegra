import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock } from "@/server/clock";
import type { Db } from "@/server/db/db";
import { removeAttachment } from "@/server/domain/attachments/commands";
import { latestAttachments, listPhotos } from "@/server/domain/attachments/queries";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { downloadName, getStoredFile, type StoredFileRow } from "@/server/domain/files/queries";
import { createPatient } from "@/server/domain/patients/commands";
import { storageKey } from "@/server/files/keys";
import { sha256Of } from "@/server/files/sniff";
import { type StoreContext, storePhoto } from "@/server/files/upload";
import {
  CYCLE_A,
  CYCLE_B,
  PATIENT_A1,
  PATIENT_A2,
  PATIENT_A3,
  PATIENT_B1,
  PRACTICE_A,
  PRACTICE_B,
  REFERRAL_A,
  USER_A,
  VISIT_A,
} from "./fixtures";
import { asServiceFor, asUserA, asUserB, inUserA, openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

// Foto posturali su disco: prima il
// file, poi la transazione con `files` e `patient_attachments`; se la transazione fallisce il file
// sparisce dallo store. `storePhoto` apre le sue transazioni e salva davvero: si chiama fuori da
// `inUserA` e le righe si rileggono come servizio. Ogni foto ha byte propri, così i test non si urtano.

const clock = fixedClock("2026-11-04T08:30:00+01:00");

let db: Db;
let pg: PGlite;
let store: MemoryFileStore;
let ctxA: StoreContext;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  ctxA = { db, actor: { userId: USER_A }, practiceId: PRACTICE_A };
});

beforeEach(() => {
  store = new MemoryFileStore();
});

afterAll(async () => {
  await pg?.close();
});

let photoCount = 0;
/** Un JPEG di prova con byte suoi (quindi sha256 suo). */
function jpeg(): Uint8Array {
  photoCount += 1;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(`foto ${photoCount} ${randomUUID()}`, "latin1")]);
}

const fields = (patientId: string, extra: Record<string, unknown> = {}) => ({
  patientId,
  view: "posteriore",
  takenOn: "2026-11-04",
  ...extra,
});

/** L'errore con cui la promessa fallisce; se riesce, il test fallisce. */
function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (value: unknown) => expect.fail(`atteso un errore, invece ha restituito ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );
}

async function expectDomainError(p: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
}

interface FileRow {
  id: string;
  practice_id: string;
  kind: string;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  original_name: string | null;
  created_by: string | null;
}

interface AttachmentRow {
  id: string;
  practice_id: string;
  patient_id: string;
  visit_id: string | null;
  cycle_id: string | null;
  file_id: string;
  kind: string;
  view: string | null;
  taken_on: string;
  width_px: number | null;
  height_px: number | null;
  caption: string | null;
  deleted_at: Date | null;
  created_by: string | null;
}

/** Le righe di `files` con questo sha256, in tutti gli studi (come servizio). */
function filesWithSha(sha256: string): Promise<FileRow[]> {
  return asServiceFor(db, (tx) =>
    tx.query<FileRow>(
      `select id, practice_id, kind, storage_key, mime_type, size_bytes, sha256, original_name, created_by
         from public.files where sha256 = $1 order by created_at, id`,
      [sha256],
    ),
  );
}

async function attachmentRow(id: string): Promise<AttachmentRow | undefined> {
  const [row] = await asServiceFor(db, (tx) =>
    tx.query<AttachmentRow>(
      `select id, practice_id, patient_id, visit_id, cycle_id, file_id, kind, view, taken_on, width_px, height_px,
              caption, deleted_at, created_by
         from public.patient_attachments where id = $1`,
      [id],
    ),
  );
  return row;
}

async function attachmentsWithSha(sha256: string): Promise<number> {
  const [row] = await asServiceFor(db, (tx) =>
    tx.query<{ n: number }>(
      `select count(*)::int as n from public.patient_attachments a
         join public.files f on f.practice_id = a.practice_id and f.id = a.file_id
        where f.sha256 = $1`,
      [sha256],
    ),
  );
  return row?.n ?? -1;
}

const remove = (attachmentId: string, at = clock) =>
  asUserA(db, (tx) => removeAttachment(tx, PRACTICE_A, at, { attachmentId }));

describe("storePhoto", () => {
  it("un JPEG su PATIENT_A1: riga in files, riga in patient_attachments e il file nello store alla stessa chiave", async () => {
    const bytes = jpeg();
    const { id } = await storePhoto(ctxA, clock, store, {
      bytes,
      fields: fields(PATIENT_A1, { caption: "  In piedi, a riposo  ", widthPx: 1500, heightPx: 2000 }),
    });

    const attachment = await attachmentRow(id);
    expect(attachment).toMatchObject({
      practice_id: PRACTICE_A,
      patient_id: PATIENT_A1,
      visit_id: null,
      cycle_id: null,
      kind: "foto_posturale",
      view: "posteriore",
      taken_on: "2026-11-04",
      width_px: 1500,
      height_px: 2000,
      caption: "In piedi, a riposo",
      deleted_at: null,
      created_by: USER_A,
    });

    const files = await filesWithSha(sha256Of(bytes));
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toEqual({
      id: attachment?.file_id,
      practice_id: PRACTICE_A,
      kind: "posture_photo",
      storage_key: storageKey(PRACTICE_A, "posture_photo", attachment?.file_id ?? "", "image/jpeg"),
      mime_type: "image/jpeg",
      size_bytes: bytes.length,
      sha256: sha256Of(bytes),
      original_name: null,
      created_by: USER_A,
    });
    expect(store.keys()).toEqual([file?.storage_key]);
    expect(await store.get(file?.storage_key ?? "")).toEqual(bytes);
  });

  it("collega la foto a ciclo e visita del paziente; un ciclo o una visita di un altro paziente o studio no", async () => {
    const bytes = jpeg();
    const { id } = await storePhoto(ctxA, clock, store, {
      bytes,
      fields: fields(PATIENT_A1, { cycleId: CYCLE_A, visitId: VISIT_A, caption: "" }),
    });
    expect(await attachmentRow(id)).toMatchObject({ cycle_id: CYCLE_A, visit_id: VISIT_A, caption: null });

    const other = new MemoryFileStore();
    for (const extra of [{ cycleId: CYCLE_A }, { visitId: VISIT_A }, { cycleId: CYCLE_B }]) {
      const photo = jpeg();
      await expectDomainError(
        storePhoto(ctxA, clock, other, { bytes: photo, fields: fields(PATIENT_A2, extra) }),
        NOT_ALLOWED,
      );
      expect(await filesWithSha(sha256Of(photo))).toEqual([]);
    }
    expect(other.keys()).toEqual([]);
  });

  it("la stessa foto di nuovo sullo stesso paziente: Questa foto è già nella cartella del 04/11, e niente resta", async () => {
    const bytes = jpeg();
    const sha = sha256Of(bytes);
    const first = await storePhoto(ctxA, clock, store, { bytes, fields: fields(PATIENT_A1) });
    const [firstKey] = store.keys();

    const error = await rejectionOf(storePhoto(ctxA, clock, store, { bytes, fields: fields(PATIENT_A1) }));
    expect(toActionFailure(error, "test")).toEqual({
      ok: false,
      refused: true,
      message: "Questa foto è già nella cartella del 04/11",
      fieldErrors: { file: "Questa foto è già nella cartella del 04/11" },
    });
    // Il file del secondo tentativo è stato scritto e poi tolto.
    expect(store.keys()).toEqual([firstKey]);
    expect(await filesWithSha(sha)).toHaveLength(1);
    expect(await attachmentsWithSha(sha)).toBe(1);

    // Tolta la prima, la stessa foto passa.
    await remove(first.id);
    await storePhoto(ctxA, clock, store, { bytes, fields: fields(PATIENT_A1) });
    expect(await filesWithSha(sha)).toHaveLength(2);
    expect(store.keys()).toHaveLength(2);

    // Il doppione è per paziente: la stessa foto su PATIENT_A2 passa.
    await storePhoto(ctxA, clock, store, { bytes, fields: fields(PATIENT_A2) });
    expect(await filesWithSha(sha)).toHaveLength(3);
    expect(store.keys()).toHaveLength(3);
  });

  it("il doppione dice la data della foto già in cartella, non quella di oggi", async () => {
    const bytes = jpeg();
    await storePhoto(ctxA, clock, store, { bytes, fields: fields(PATIENT_A2, { takenOn: "2026-10-15" }) });
    await expectDomainError(
      storePhoto(ctxA, clock, store, { bytes, fields: fields(PATIENT_A2) }),
      "Questa foto è già nella cartella del 15/10",
    );
  });

  it("un paziente di B come uA fallisce e non lascia né file nello store né righe", async () => {
    const bytes = jpeg();
    await expectDomainError(storePhoto(ctxA, clock, store, { bytes, fields: fields(PATIENT_B1) }), NOT_ALLOWED);
    expect(store.keys()).toEqual([]);
    expect(await filesWithSha(sha256Of(bytes))).toEqual([]);
    expect(await attachmentsWithSha(sha256Of(bytes))).toBe(0);
  });

  it("lo store che fallisce non lascia righe", async () => {
    const bytes = jpeg();
    store.failNextPut();
    await expect(storePhoto(ctxA, clock, store, { bytes, fields: fields(PATIENT_A1) })).rejects.toThrow(
      "Scrittura del file fallita (prova).",
    );
    expect(store.keys()).toEqual([]);
    expect(await filesWithSha(sha256Of(bytes))).toEqual([]);
  });

  it("i campi si controllano prima di scrivere: vista assente, didascalia di 201 caratteri, chiave in più", async () => {
    const noView = await rejectionOf(
      storePhoto(ctxA, clock, store, { bytes: jpeg(), fields: { patientId: PATIENT_A1, takenOn: "2026-11-04" } }),
    );
    expect(toActionFailure(noView, "test").fieldErrors).toEqual({ view: "Scegli la vista." });

    const badView = await rejectionOf(
      storePhoto(ctxA, clock, store, { bytes: jpeg(), fields: fields(PATIENT_A1, { view: "frontale" }) }),
    );
    expect(toActionFailure(badView, "test").fieldErrors).toEqual({ view: "Valore non valido" });

    const longCaption = await rejectionOf(
      storePhoto(ctxA, clock, store, { bytes: jpeg(), fields: fields(PATIENT_A1, { caption: "a".repeat(201) }) }),
    );
    expect(toActionFailure(longCaption, "test").fieldErrors).toEqual({ caption: "Massimo 200 caratteri." });

    const noDate = await rejectionOf(
      storePhoto(ctxA, clock, store, { bytes: jpeg(), fields: fields(PATIENT_A1, { takenOn: "04/11/2026" }) }),
    );
    expect(toActionFailure(noDate, "test").fieldErrors).toEqual({ takenOn: "Scrivi la data nel formato 22/10/2026." });

    const extraKey = await rejectionOf(
      storePhoto(ctxA, clock, store, { bytes: jpeg(), fields: fields(PATIENT_A1, { practiceId: PRACTICE_B }) }),
    );
    expect(toActionFailure(extraKey, "test").ok).toBe(false);
    expect(store.keys()).toEqual([]);
  });

  // Come `closed_on` e `delivered_on`, il giorno della foto non va oltre oggi.
  it("una foto di domani: «La foto non può essere nel futuro.» sul campo della data, e niente scritto; di oggi passa", async () => {
    const bytes = jpeg();
    const error = await rejectionOf(
      storePhoto(ctxA, clock, store, { bytes, fields: fields(PATIENT_A1, { takenOn: "2026-11-05" }) }),
    );
    expect(toActionFailure(error, "test")).toEqual({
      ok: false,
      refused: true,
      message: "La foto non può essere nel futuro.",
      fieldErrors: { takenOn: "La foto non può essere nel futuro." },
    });
    expect(store.keys()).toEqual([]);
    expect(await filesWithSha(sha256Of(bytes))).toEqual([]);
    expect(await attachmentsWithSha(sha256Of(bytes))).toBe(0);
    await storePhoto(ctxA, clock, store, { bytes, fields: fields(PATIENT_A1, { takenOn: "2026-11-04" }) });
    expect(await attachmentsWithSha(sha256Of(bytes))).toBe(1);
  });

  it("un file che non è un'immagine: il messaggio sul campo file, e niente scritto", async () => {
    const pdf = new Uint8Array(Buffer.from("%PDF-1.7\n", "latin1"));
    const error = await rejectionOf(storePhoto(ctxA, clock, store, { bytes: pdf, fields: fields(PATIENT_A1) }));
    expect(toActionFailure(error, "test")).toEqual({
      ok: false,
      refused: true,
      message: "Il file non è un'immagine JPEG, PNG o WebP.",
      fieldErrors: { file: "Il file non è un'immagine JPEG, PNG o WebP." },
    });
    expect(store.keys()).toEqual([]);
    expect(await filesWithSha(sha256Of(pdf))).toEqual([]);
  });
});

describe("removeAttachment", () => {
  it("scrive deleted_at uguale all'istante del clock; una seconda volta non lo cambia", async () => {
    const { id } = await storePhoto(ctxA, clock, store, { bytes: jpeg(), fields: fields(PATIENT_A1) });
    await remove(id);
    expect((await attachmentRow(id))?.deleted_at?.toISOString()).toBe(clock.now().toISOString());
    await remove(id, fixedClock("2026-11-05T10:00:00+01:00"));
    expect((await attachmentRow(id))?.deleted_at?.toISOString()).toBe(clock.now().toISOString());
  });

  it("uB sull'allegato di A: Operazione non permessa, e niente cambia", async () => {
    const { id } = await storePhoto(ctxA, clock, store, { bytes: jpeg(), fields: fields(PATIENT_A1) });
    for (const practiceId of [PRACTICE_B, PRACTICE_A]) {
      await expectDomainError(
        asUserB(db, (tx) => removeAttachment(tx, practiceId, clock, { attachmentId: id })),
        NOT_ALLOWED,
      );
    }
    expect((await attachmentRow(id))?.deleted_at).toBeNull();
  });

  it("un id che non c'è: Operazione non permessa; una chiave in più è rifiutata", async () => {
    await expectDomainError(
      inUserA(db, (tx) => removeAttachment(tx, PRACTICE_A, clock, { attachmentId: randomUUID() })),
      NOT_ALLOWED,
    );
    const error = await rejectionOf(
      inUserA(db, (tx) => removeAttachment(tx, PRACTICE_A, clock, { attachmentId: randomUUID(), at: "ora" })),
    );
    expect((error as { name?: unknown }).name).toBe("ZodError");
  });
});

describe("getStoredFile e downloadName", () => {
  it("la foto di A: chiave, tipo e giorno della foto; il nome scaricato è foto-2026-11-04.jpg", async () => {
    const { id } = await storePhoto(ctxA, clock, store, { bytes: jpeg(), fields: fields(PATIENT_A3) });
    const fileId = (await attachmentRow(id))?.file_id ?? "";
    const row = await asUserA(db, (tx) => getStoredFile(tx, PRACTICE_A, fileId));
    expect(row).toEqual({
      id: fileId,
      storageKey: storageKey(PRACTICE_A, "posture_photo", fileId, "image/jpeg"),
      mimeType: "image/jpeg",
      kind: "posture_photo",
      day: "2026-11-04",
    });
    expect(row && downloadName(row)).toBe("foto-2026-11-04.jpg");
  });

  it("uB sull'id di A: null, con lo studio di B e con quello di A", async () => {
    const { id } = await storePhoto(ctxA, clock, store, { bytes: jpeg(), fields: fields(PATIENT_A3) });
    const fileId = (await attachmentRow(id))?.file_id ?? "";
    expect(await asUserB(db, (tx) => getStoredFile(tx, PRACTICE_B, fileId))).toBeNull();
    expect(await asUserB(db, (tx) => getStoredFile(tx, PRACTICE_A, fileId))).toBeNull();
  });

  it("un id che non c'è e la foto tolta: null", async () => {
    expect(await asUserA(db, (tx) => getStoredFile(tx, PRACTICE_A, randomUUID()))).toBeNull();
    const { id } = await storePhoto(ctxA, clock, store, { bytes: jpeg(), fields: fields(PATIENT_A3) });
    const fileId = (await attachmentRow(id))?.file_id ?? "";
    await remove(id);
    expect(await asUserA(db, (tx) => getStoredFile(tx, PRACTICE_A, fileId))).toBeNull();
  });

  it("il PDF della lettera prende il giorno del rinvio: lettera-medico-2026-10-05.pdf", async () => {
    const row = await inUserA(db, async (tx) => {
      const fileId = randomUUID();
      await tx.query(
        `insert into public.files (id, practice_id, kind, storage_key, mime_type, size_bytes, sha256)
         values ($1, $2, 'referral_pdf', $3, 'application/pdf', 2048, $4)`,
        [fileId, PRACTICE_A, storageKey(PRACTICE_A, "referral_pdf", fileId, "application/pdf"), "e".repeat(64)],
      );
      await tx.query("update public.referrals set letter_file_id = $3 where practice_id = $1 and id = $2", [
        PRACTICE_A,
        REFERRAL_A,
        fileId,
      ]);
      return getStoredFile(tx, PRACTICE_A, fileId);
    });
    expect(row).toMatchObject({ kind: "referral_pdf", mimeType: "application/pdf", day: "2026-10-05" });
    expect(row && downloadName(row)).toBe("lettera-medico-2026-10-05.pdf");
  });

  it("i nomi non contengono mai il paziente: foto, lettera, allegato", () => {
    const row = (kind: StoredFileRow["kind"], mimeType: StoredFileRow["mimeType"]): StoredFileRow => ({
      id: randomUUID(),
      storageKey: "",
      mimeType,
      kind,
      day: "2026-11-04",
    });
    expect(downloadName(row("posture_photo", "image/png"))).toBe("foto-2026-11-04.png");
    expect(downloadName(row("referral_pdf", "application/pdf"))).toBe("lettera-medico-2026-11-04.pdf");
    expect(downloadName(row("clinical_doc", "application/pdf"))).toBe("allegato-2026-11-04.pdf");
    expect(downloadName(row("clinical_doc", "image/webp"))).toBe("allegato-2026-11-04.webp");
  });
});

describe("listPhotos e latestAttachments", () => {
  it("per taken_on decrescente, senza le foto tolte, con vista e data in chiaro", async () => {
    // Un paziente nuovo, così l'elenco ha solo le foto di questo test.
    const { id: patientId } = await asUserA(db, (tx) =>
      createPatient(tx, PRACTICE_A, clock, { firstName: "Lucia", lastName: "Prova", birthDate: "1985-02-11" }),
    );
    expect(await asUserA(db, (tx) => listPhotos(tx, PRACTICE_A, patientId))).toEqual([]);

    const october = await storePhoto(ctxA, clock, store, {
      bytes: jpeg(),
      fields: { patientId, view: "anteriore", takenOn: "2026-10-01", caption: "Prima seduta" },
    });
    const november = await storePhoto(ctxA, clock, store, {
      bytes: jpeg(),
      fields: { patientId, view: "laterale_dx", takenOn: "2026-11-02", widthPx: 1200, heightPx: 1600 },
    });
    const removed = await storePhoto(ctxA, clock, store, {
      bytes: jpeg(),
      fields: { patientId, view: "posteriore", takenOn: "2026-10-20" },
    });
    await remove(removed.id);

    const photos = await asUserA(db, (tx) => listPhotos(tx, PRACTICE_A, patientId));
    expect(photos.map((photo) => photo.id)).toEqual([november.id, october.id]);
    expect(photos[0]).toEqual({
      id: november.id,
      fileId: (await attachmentRow(november.id))?.file_id,
      view: "laterale_dx",
      viewLabel: "Laterale destra",
      takenOn: "2026-11-02",
      dateText: "lun 2 nov",
      caption: null,
      widthPx: 1200,
      heightPx: 1600,
    });
    expect(photos[1]).toMatchObject({ view: "anteriore", viewLabel: "Anteriore", caption: "Prima seduta" });

    expect((await asUserA(db, (tx) => latestAttachments(tx, PRACTICE_A, patientId, 1))).map((p) => p.id)).toEqual([
      november.id,
    ]);
    expect((await asUserA(db, (tx) => latestAttachments(tx, PRACTICE_A, patientId))).map((p) => p.id)).toEqual([
      november.id,
      october.id,
    ]);
  });

  it("0 righe: un paziente di un altro studio, o uB sul paziente di A", async () => {
    expect(await asUserA(db, (tx) => listPhotos(tx, PRACTICE_A, PATIENT_B1))).toEqual([]);
    expect(await asUserB(db, (tx) => listPhotos(tx, PRACTICE_B, PATIENT_A1))).toEqual([]);
    expect(await asUserB(db, (tx) => latestAttachments(tx, PRACTICE_A, PATIENT_A1))).toEqual([]);
  });
});
