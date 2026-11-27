// Dove stanno i byte dei file: oggi `DiskFileStore` sotto `<dataDir>/files/`, domani uno
// store su Supabase Storage con le stesse chiavi. Lo store non tocca il database: le righe di `files`
// le scrive la transazione di chi lo usa. Senza `server-only`: lo caricano Vitest e il seed.

export interface FileStore {
  /** Scrive il file alla chiave, sostituendo quello che c'era. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** I byte alla chiave, o null se il file non c'è. */
  get(key: string): Promise<Uint8Array | null>;
  /** Toglie il file; una chiave assente non è un errore. */
  remove(key: string): Promise<void>;
  /** Toglie ogni file sotto il prefisso (`<practice_id>` o `<practice_id>/<kind>`). */
  removeAll(prefix: string): Promise<void>;
}
