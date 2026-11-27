import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type AppConfig, loadConfig } from "@/server/config";
import { isValidStorageKey, isValidStoragePrefix, resolveInside } from "./keys";
import type { FileStore } from "./store";

// I file su disco sotto `<dataDir>/files/`. Si scrive `<key>.part` e lo si rinomina: un
// file a metà non ha mai il nome vero, e se la scrittura fallisce (disco pieno) il `.part` sparisce.
// Ogni percorso passa da `isValidStorageKey` (o `isValidStoragePrefix`) e da `resolveInside`.

const isMissing = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "ENOENT";

export class DiskFileStore implements FileStore {
  constructor(private readonly root: string) {}

  private pathOf(key: string): string {
    if (!isValidStorageKey(key)) throw new RangeError("Chiave del file non valida.");
    return resolveInside(this.root, key);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathOf(key);
    const part = `${target}.part`;
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(part, bytes);
      await rename(part, target);
    } catch (error) {
      await rm(part, { force: true }).catch(() => {});
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const target = this.pathOf(key);
    try {
      const buffer = await readFile(target);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async removeAll(prefix: string): Promise<void> {
    if (!isValidStoragePrefix(prefix)) throw new RangeError("Prefisso dei file non valido.");
    await rm(resolveInside(this.root, prefix), { recursive: true, force: true });
  }
}

/** La cartella dei file dell'app: `<dataDir>/files`, quella che `pnpm db:reset` ricrea. */
export function filesRoot(cfg: AppConfig): string {
  return path.join(cfg.dataDir, "files");
}

/** Lo store dei file dell'app, nella cartella dati di `APP_DATA_DIR`. */
export function getFileStore(): FileStore {
  return new DiskFileStore(filesRoot(loadConfig()));
}
