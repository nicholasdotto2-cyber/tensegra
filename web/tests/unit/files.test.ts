import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { HEIC_TEXT, MAX_FILE_BYTES, NOT_IMAGE_TEXT, TOO_BIG_TEXT } from "@/lib/files/messages";
import { DiskFileStore } from "@/server/files/disk-store";
import { isValidStorageKey, resolveInside, storageKey } from "@/server/files/keys";
import { checkUpload, looksLikeHeic, sha256Of, sniffMime } from "@/server/files/sniff";

// File su disco: il tipo dai primi byte e non dal nome, la chiave
// nella cartella dello studio, nessun percorso che esce dalla radice dello store.

const PRACTICE = "de000000-0000-4000-8000-000000000002";
const FILE_ID = "3f1c9a2e-7b44-4c1e-9d0a-5b2e8f6c1d77";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const ascii = (text: string): number[] => [...Buffer.from(text, "latin1")];

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"));
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00);
const WEBP = bytes(...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WEBPVP8 "));
const PDF = bytes(...ascii("%PDF-1.7\n"));
const HEIC = bytes(0x00, 0x00, 0x00, 0x18, ...ascii("ftypheic"), 0x00, 0x00, 0x00, 0x00);
const IMAGES = ["image/jpeg", "image/png", "image/webp"] as const;

describe("sniffMime", () => {
  it.each([
    ["JPEG FF D8 FF E0", JPEG, "image/jpeg"],
    ["PNG 89 50 4E 47 0D 0A 1A 0A", PNG, "image/png"],
    ["RIFF + 4 byte + WEBP", WEBP, "image/webp"],
    ["%PDF-1.7", PDF, "application/pdf"],
  ])("%s", (_name, input, expected) => {
    expect(sniffMime(input)).toBe(expected);
  });

  it('il testo "ciao" salvato come foto.jpg non è un tipo ammesso: il nome non conta', () => {
    expect(sniffMime(new TextEncoder().encode("ciao"))).toBeNull();
  });

  it("un file vuoto o più corto della firma non è un tipo ammesso", () => {
    expect(sniffMime(bytes())).toBeNull();
    expect(sniffMime(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffMime(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")))).toBeNull();
  });
});

describe("looksLikeHeic", () => {
  it("ftypheic all'offset 4", () => {
    expect(looksLikeHeic(HEIC)).toBe(true);
  });

  it("un JPEG o ftyp di un MP4 non sono HEIC", () => {
    expect(looksLikeHeic(JPEG)).toBe(false);
    expect(looksLikeHeic(bytes(0x00, 0x00, 0x00, 0x18, ...ascii("ftypisom")))).toBe(false);
  });
});

describe("sha256Of", () => {
  it("l'hash esadecimale in minuscolo, come il check di files.sha256", () => {
    expect(sha256Of(new TextEncoder().encode("ciao"))).toBe(
      "b133a0c0e9bee3be20163d2ad31d6248db292aa6dcb1ee087a2aa50e0fc75ae2",
    );
  });
});

describe("checkUpload", () => {
  it("un JPEG ammesso: tipo, sha256 e peso", () => {
    expect(checkUpload(JPEG, IMAGES)).toEqual({ ok: true, mime: "image/jpeg", sha256: sha256Of(JPEG), size: JPEG.length });
  });

  it("10485761 byte di JPEG: File troppo grande (massimo 10 MB)", () => {
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    big.set(JPEG);
    expect(checkUpload(big, IMAGES)).toEqual({ ok: false, message: "File troppo grande (massimo 10 MB)" });
    expect(TOO_BIG_TEXT).toBe("File troppo grande (massimo 10 MB)");
  });

  it("esattamente 10 MB passa", () => {
    const max = new Uint8Array(MAX_FILE_BYTES);
    max.set(JPEG);
    expect(checkUpload(max, IMAGES)).toMatchObject({ ok: true, size: 10485760 });
  });

  it("HEIC: Esporta la foto in JPEG dal telefono", () => {
    expect(checkUpload(HEIC, IMAGES)).toEqual({ ok: false, message: "Esporta la foto in JPEG dal telefono" });
    expect(HEIC_TEXT).toBe("Esporta la foto in JPEG dal telefono");
  });

  it("un PDF quando sono ammesse solo immagini", () => {
    expect(checkUpload(PDF, IMAGES)).toEqual({ ok: false, message: "Il file non è un'immagine JPEG, PNG o WebP." });
    expect(NOT_IMAGE_TEXT).toBe("Il file non è un'immagine JPEG, PNG o WebP.");
  });

  it("un testo o un file vuoto non sono immagini", () => {
    expect(checkUpload(new TextEncoder().encode("ciao"), IMAGES)).toEqual({ ok: false, message: NOT_IMAGE_TEXT });
    expect(checkUpload(bytes(), IMAGES)).toEqual({ ok: false, message: NOT_IMAGE_TEXT });
  });
});

describe("chiavi dello store", () => {
  it("storageKey: <studio>/<tipo>/<file>.<ext>, valida", () => {
    const key = storageKey(PRACTICE, "posture_photo", FILE_ID, "image/jpeg");
    expect(key).toBe("de000000-0000-4000-8000-000000000002/posture_photo/3f1c9a2e-7b44-4c1e-9d0a-5b2e8f6c1d77.jpg");
    expect(isValidStorageKey(key)).toBe(true);
    expect(storageKey(PRACTICE, "referral_pdf", FILE_ID, "application/pdf")).toBe(`${PRACTICE}/referral_pdf/${FILE_ID}.pdf`);
  });

  it("storageKey rifiuta un id che non è un uuid", () => {
    expect(() => storageKey("../altro", "posture_photo", FILE_ID, "image/jpeg")).toThrow(RangeError);
    expect(() => storageKey(PRACTICE, "posture_photo", "x/../y", "image/jpeg")).toThrow(RangeError);
  });

  it.each([
    `${PRACTICE}/posture_photo/../x.jpg`,
    `${PRACTICE}/posture_photo/${FILE_ID}.JPG`,
    `${PRACTICE}/posture_photo/${FILE_ID}.gif`,
    `${PRACTICE}/foto/${FILE_ID}.jpg`,
    `${PRACTICE}\\posture_photo\\${FILE_ID}.jpg`,
    `/${PRACTICE}/posture_photo/${FILE_ID}.jpg`,
    `${PRACTICE}/posture_photo/${FILE_ID}.jpg.part`,
    "",
  ])("isValidStorageKey(%j) è false", (key) => {
    expect(isValidStorageKey(key)).toBe(false);
  });

  it("resolveInside: dentro la radice va, ../fuori.jpg lancia RangeError", () => {
    const root = resolve("/dati/files");
    expect(resolveInside(root, `${PRACTICE}/posture_photo/${FILE_ID}.jpg`)).toBe(
      join(root, PRACTICE, "posture_photo", `${FILE_ID}.jpg`),
    );
    expect(() => resolveInside(root, "../fuori.jpg")).toThrow(RangeError);
    expect(() => resolveInside(root, "")).toThrow(RangeError);
    expect(() => resolveInside(root, join(root, "..", "fuori.jpg"))).toThrow(RangeError);
  });
});

describe("DiskFileStore", () => {
  // Una cartella sotto web/.data/test/ (gitignored), cancellata alla fine: mai la cartella di sistema.
  const root = fileURLToPath(new URL(`../../.data/test/files-${randomUUID()}`, import.meta.url));
  const store = new DiskFileStore(root);
  const key = storageKey(PRACTICE, "posture_photo", FILE_ID, "image/jpeg");

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function filesUnder(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  }

  it("put poi get restituisce gli stessi byte, e non resta nessun .part", async () => {
    await store.put(key, JPEG);
    expect(await store.get(key)).toEqual(JPEG);
    const names = await filesUnder(root);
    expect(names).toEqual([`${FILE_ID}.jpg`]);
    expect(names.some((name) => name.endsWith(".part"))).toBe(false);
  });

  it("get di una chiave assente: null; remove di una chiave assente non lancia", async () => {
    const missing = storageKey(PRACTICE, "posture_photo", randomUUID(), "image/png");
    expect(await store.get(missing)).toBeNull();
    await expect(store.remove(missing)).resolves.toBeUndefined();
  });

  it("remove toglie il file", async () => {
    const other = storageKey(PRACTICE, "posture_photo", randomUUID(), "image/png");
    await store.put(other, PNG);
    await store.remove(other);
    expect(await store.get(other)).toBeNull();
  });

  it("removeAll toglie la cartella di uno studio e lascia le altre", async () => {
    const otherPractice = "b0000000-0000-4000-8000-000000000001";
    const mine = storageKey(PRACTICE, "referral_pdf", randomUUID(), "application/pdf");
    const theirs = storageKey(otherPractice, "posture_photo", randomUUID(), "image/webp");
    await store.put(mine, PDF);
    await store.put(theirs, WEBP);
    await store.removeAll(PRACTICE);
    expect(await store.get(mine)).toBeNull();
    expect(await store.get(key)).toBeNull();
    expect(await store.get(theirs)).toEqual(WEBP);
    // Su Windows togliere una cartella può superare i 5 s di default con la macchina carica.
  }, 30_000);

  it("una chiave non valida non tocca il disco", async () => {
    await expect(store.put(`${PRACTICE}/posture_photo/../x.jpg`, JPEG)).rejects.toThrow(RangeError);
    await expect(store.get("../fuori.jpg")).rejects.toThrow(RangeError);
    await expect(store.remove("../fuori.jpg")).rejects.toThrow(RangeError);
    await expect(store.removeAll("..")).rejects.toThrow(RangeError);
    await expect(store.removeAll("")).rejects.toThrow(RangeError);
  });
});
