import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@/server/db/db";
import { runMigrations } from "@/server/db/migrate";
import { createPglite } from "@/server/db/pglite";
import { asService } from "@/server/db/service";
import { loadFixtures } from "./fixtures";

// Preparazione dei test db: un solo PGlite in memoria con shim, migrazioni e
// fixture dei due studi, salvato come tar. Ogni file di test lo clona con `openTestDb()`
// (`loadDataDir`), che costa molto meno di rifare migrazioni e fixture.

export const TEMPLATE_PATH = fileURLToPath(new URL("../../.data/test/template.tar", import.meta.url));
const SUPABASE_DIR = fileURLToPath(new URL("../../supabase", import.meta.url));

export default async function setup(): Promise<void> {
  const pg = await createPglite();
  try {
    await runMigrations(pg, SUPABASE_DIR);
    await asService(createDb(pg), (tx) => loadFixtures(tx));
    const tar = await pg.dumpDataDir("none");
    mkdirSync(dirname(TEMPLATE_PATH), { recursive: true });
    writeFileSync(TEMPLATE_PATH, Buffer.from(await tar.arrayBuffer()));
  } finally {
    await pg.close();
  }
}
