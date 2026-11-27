import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_PRACTICE_ID, getActor } from "@/server/auth/actor";
import { fixedClock } from "@/server/clock";
import type { Db } from "@/server/db/db";
import { recreateDemoData } from "@/server/demo/recreate";
import { removeAttachment } from "@/server/domain/attachments/commands";
import { sniffMime } from "@/server/files/sniff";
import { seedDemo } from "../../seed/demo";
import { asServiceFor, openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

// Le foto posturali di Giulia nel seed e in "Ricrea": due serie, anteriore e laterale
// destra, alla prima visita (D0-35) e all'ultima seduta fatta (D0-10). Sono sagome disegnate, mai foto
// di persone: il test fissa lo sha256 dei file committati e controlla che non abbiano EXIF.

const P = DEMO_PRACTICE_ID;
const seedClock = fixedClock("2026-11-04T08:30:00+01:00");

/** I giorni delle due visite con D0 mercoledì 4/11/2026: D0-35 e D0-10, una domenica che il seed porta al sabato. */
const FIRST_VISIT_DAY = "2026-09-30";
const LAST_VISIT_DAY = "2026-10-24";

/** Gli sha256 delle sagome committate in `seed/assets` (generate una volta con PIL). */
const ASSETS: Readonly<Record<string, string>> = {
  "giulia-anteriore-1.jpg": "89034f622f335819178a6b3c6c2060ffeafb23ccc80e965fb38384b6684f2e3a",
  "giulia-laterale-1.jpg": "b4e6dd00726255f9235c0fbfc6b9d1f69570133399985e0bdbcd3e61c95d8ba3",
  "giulia-anteriore-2.jpg": "483bfc930dd25226d3b92d7be1f04c6f141c59468d9350597e80775b1081b811",
  "giulia-laterale-2.jpg": "9acf5c583905230af014940e3e2b449952fa760f0b84b9465cb1e76b0c779267",
};

/** Lo store di memoria che fallisce alla `put` numero `n` di una foto posturale. */
class PhotoFailingStore extends MemoryFileStore {
  private countdown = 0;

  failAtPhotoPut(n: number): void {
    this.countdown = n;
  }

  override async put(key: string, bytes: Uint8Array): Promise<void> {
    if (this.countdown > 0 && key.includes("/posture_photo/")) {
      this.countdown -= 1;
      if (this.countdown === 0) throw new Error("Scrittura del file fallita (prova).");
    }
    await super.put(key, bytes);
  }
}

let db: Db;
let pg: PGlite;
let store: PhotoFailingStore;

beforeEach(async () => {
  ({ db, pg } = await openTestDb());
  store = new PhotoFailingStore();
});

afterEach(async () => {
  await pg.close();
});

interface PhotoRow {
  id: string;
  view: string;
  takenOn: string;
  visitDay: string;
  storageKey: string;
  mime: string;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
}

/** Le foto non tolte di Giulia, con il file e il giorno della visita a cui sono legate. */
function giuliaPhotos(target: Db): Promise<PhotoRow[]> {
  return asServiceFor(target, (tx) =>
    tx.query<PhotoRow>(
      `select a.id, a.view, a.taken_on::text as "takenOn", v.visit_date::text as "visitDay",
              f.storage_key as "storageKey", f.mime_type as mime, f.size_bytes::int as size, f.sha256,
              a.width_px as width, a.height_px as height
         from public.patient_attachments a
         join public.patients p on p.practice_id = a.practice_id and p.id = a.patient_id
         join public.files f on f.practice_id = a.practice_id and f.id = a.file_id
         left join public.visits v on v.practice_id = a.practice_id and v.id = a.visit_id
        where a.practice_id = $1 and p.first_name = 'Giulia' and p.last_name = 'Ferrante'
          and a.kind = 'foto_posturale' and a.deleted_at is null
        order by a.taken_on, a.view`,
      [P],
    ),
  );
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("foto posturali del seed", () => {
  it("giulia_due_serie", async () => {
    await seedDemo(db, seedClock, store);
    const rows = await giuliaPhotos(db);
    expect(rows.map((r) => [r.takenOn, r.view])).toEqual([
      [FIRST_VISIT_DAY, "anteriore"],
      [FIRST_VISIT_DAY, "laterale_dx"],
      [LAST_VISIT_DAY, "anteriore"],
      [LAST_VISIT_DAY, "laterale_dx"],
    ]);
    for (const row of rows) {
      expect(row.visitDay).toBe(row.takenOn);
      const bytes = await store.get(row.storageKey);
      expect(bytes).not.toBeNull();
      if (!bytes) continue;
      expect(sniffMime(bytes)).toBe("image/jpeg");
      expect(row.mime).toBe("image/jpeg");
      expect(sha256(bytes)).toBe(row.sha256);
      expect(bytes.length).toBe(row.size);
      expect([row.width, row.height]).toEqual([600, 900]);
    }
  });

  it("foto_inventate", async () => {
    for (const [name, expected] of Object.entries(ASSETS)) {
      const bytes = new Uint8Array(await readFile(join(process.cwd(), "seed", "assets", name)));
      expect(sha256(bytes), name).toBe(expected);
      expect(sniffMime(bytes), name).toBe("image/jpeg");
      // Nessun blocco EXIF (fotocamera, data, posizione) nei primi 64 KB.
      expect(Buffer.from(bytes.subarray(0, 65_536)).includes("Exif"), name).toBe(false);
    }
  });

  it("ricrea_rimette_le_foto", async () => {
    await seedDemo(db, seedClock, store);
    const before = await giuliaPhotos(db);
    const [first] = before;
    if (!first) throw new Error("Giulia non ha foto dopo il seed.");
    await db.asUser(getActor(), (tx) => removeAttachment(tx, P, seedClock, { attachmentId: first.id }));
    expect(await giuliaPhotos(db)).toHaveLength(3);

    await recreateDemoData(db, store, fixedClock("2026-11-04T09:00:00+01:00"), { demoMode: true });

    const after = await giuliaPhotos(db);
    expect(after.map((r) => [r.takenOn, r.view])).toEqual(before.map((r) => [r.takenOn, r.view]));
    for (const row of after) expect(await store.get(row.storageKey)).not.toBeNull();
    for (const row of before) expect(await store.get(row.storageKey)).toBeNull();
  });

  it("seed_rollback_foto", async () => {
    store.failAtPhotoPut(3);
    await expect(seedDemo(db, seedClock, store)).rejects.toThrow("Scrittura del file fallita (prova).");
    const [row] = await asServiceFor(db, (tx) =>
      tx.query<{ n: number }>("select count(*)::int as n from public.practices where id = $1", [P]),
    );
    expect(row?.n).toBe(0);
    expect(store.keys()).toEqual([]);
  });
});
