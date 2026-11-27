import type { FileStore } from "@/server/files/store";
import { isValidStorageKey, isValidStoragePrefix } from "@/server/files/keys";

/**
 * Lo store dei file in memoria, per i test db: niente disco. Come `DiskFileStore`
 * rifiuta una chiave non valida e conserva una copia dei byte; `failNextPut` fa fallire il prossimo
 * `put` senza scrivere niente, come un disco pieno.
 */
export class MemoryFileStore implements FileStore {
  private readonly files = new Map<string, Uint8Array>();
  private failPut = false;

  /** Le chiavi salvate, in ordine. */
  keys(): string[] {
    return [...this.files.keys()].sort();
  }

  failNextPut(): void {
    this.failPut = true;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    assertKey(key);
    if (this.failPut) {
      this.failPut = false;
      throw new Error("Scrittura del file fallita (prova).");
    }
    this.files.set(key, new Uint8Array(bytes));
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    const bytes = this.files.get(key);
    return bytes ? new Uint8Array(bytes) : null;
  }

  async remove(key: string): Promise<void> {
    assertKey(key);
    this.files.delete(key);
  }

  async removeAll(prefix: string): Promise<void> {
    if (!isValidStoragePrefix(prefix)) throw new RangeError("Prefisso dei file non valido.");
    const folder = prefix.endsWith("/") ? prefix : `${prefix}/`;
    for (const key of this.keys()) if (key.startsWith(folder)) this.files.delete(key);
  }
}

function assertKey(key: string): void {
  if (!isValidStorageKey(key)) throw new RangeError("Chiave del file non valida.");
}
