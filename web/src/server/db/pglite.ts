import { PGlite, types } from "@electric-sql/pglite";
import { EXTENSIONS } from "./extensions";

// L'unico modo di creare un PGlite: l'app (openDb), gli script e i test lo aprono
// tutti qui, così una query dà lo stesso risultato nei test e sotto `next start`.
// Senza "server-only": lo importano anche Vitest e gli script.

export interface CreatePgliteOptions {
  /** Cartella su disco; senza, PGlite sta in memoria. */
  dataDir?: string;
  /** Un dump di `dumpDataDir` da cui partire (il modello dei test db). */
  loadDataDir?: Blob;
}

export async function createPglite(opts: CreatePgliteOptions = {}): Promise<PGlite> {
  const pg = await PGlite.create({
    ...opts,
    extensions: EXTENSIONS,
    // Una date resta "AAAA-MM-GG": come Date diventerebbe la mezzanotte UTC di quel giorno.
    parsers: { [types.DATE]: (value: string) => value },
  });
  try {
    // Su PGlite 0.5.11 `alter database postgres set timezone` dello shim non arriva alla
    // sessione: vale solo questo set, fuori da ogni transazione, quindi per tutta la sessione.
    await pg.exec("set timezone to 'UTC'");
  } catch (error) {
    await pg.close().catch(() => {});
    throw error;
  }
  return pg;
}
