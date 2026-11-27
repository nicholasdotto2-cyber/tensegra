import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";

// Unico elenco delle estensioni del database. Chi apre PGlite le passa tutte
// in `extensions`; le migrazioni le creano con `create extension if not exists <nome>
// with schema extensions`, e solo queste due.
export const EXTENSIONS = { pg_trgm, unaccent } as const;
