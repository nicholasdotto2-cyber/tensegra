import { describe, expect, it } from "vitest";
import { expectBlockedDelete } from "./helpers";

// `expectBlockedDelete` deve dare lo stesso verdetto su Postgres 18 (PGlite) e su Postgres 17 (Supabase),
// ma PGlite risponde solo nel modo del 18: qui i due errori sono costruiti a mano, con i testi di Postgres.

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

// REL_18_STABLE: la delete ferma da `on delete restrict` ha il suo codice e il suo testo.
const RESTRICT_18 = pgError(
  "23001",
  'update or delete on table "services" violates RESTRICT setting of foreign key constraint "appointments_service_fk" on table "appointments"',
);
// REL_17_STABLE: restrict e no action rispondono con il codice generico delle chiavi esterne.
const BLOCKED_17 = pgError(
  "23503",
  'update or delete on table "services" violates foreign key constraint "appointments_service_fk" on table "appointments"',
);
// Lo stesso codice, ma di un insert verso un genitore che non c'è: non è una delete bloccata.
const MISSING_PARENT = pgError(
  "23503",
  'insert or update on table "appointments" violates foreign key constraint "appointments_service_fk"',
);

describe("expectBlockedDelete", () => {
  it("accetta la delete bloccata di Postgres 18 (23001) e di Postgres 17 (23503)", async () => {
    await expectBlockedDelete(Promise.reject(RESTRICT_18));
    await expectBlockedDelete(Promise.reject(BLOCKED_17));
  });

  it("rifiuta il 23503 di un insert verso un genitore che non c'è", async () => {
    await expect(expectBlockedDelete(Promise.reject(MISSING_PARENT))).rejects.toThrow();
  });

  it("rifiuta un altro codice e una promessa che si risolve", async () => {
    await expect(expectBlockedDelete(Promise.reject(pgError("42501", "permission denied")))).rejects.toThrow();
    await expect(expectBlockedDelete(Promise.reject(new Error("boom")))).rejects.toThrow();
    await expect(expectBlockedDelete(Promise.resolve([]))).rejects.toThrow();
  });
});
