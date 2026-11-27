import type { Actor } from "@/server/db/db";

// L'utente della demo: niente login in locale, ogni richiesta gira come questo
// utente. Senza "server-only": lo importano anche gli script (seed, reset) e i test.

export const DEMO_USER_ID = "de000000-0000-4000-8000-000000000001";
export const DEMO_PRACTICE_ID = "de000000-0000-4000-8000-000000000002";
export const DEMO_USER_EMAIL = "demo@studio.invalid";

export function getActor(): Actor {
  return { userId: DEMO_USER_ID };
}
