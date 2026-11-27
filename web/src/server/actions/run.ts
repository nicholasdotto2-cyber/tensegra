import "server-only";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { type Clock, fixedClock, systemClock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { getRequestContext } from "@/server/db/next";
import { type ActionResult, toActionFailure } from "./result";

// Il corpo di ogni Server Action: una transazione come l'utente, un istante per tutta
// l'azione, la pagina ricaricata dopo il commit e gli errori attesi restituiti come valori.

export interface CommandContext {
  tx: Tx;
  practiceId: string;
  clock: Clock;
}

export async function runAction<T>(
  name: string,
  fn: (ctx: CommandContext) => Promise<T>,
  options: { revalidate?: boolean } = {},
): Promise<ActionResult<T>> {
  try {
    const ctx = await getRequestContext();
    const clock = fixedClock(systemClock.now()); // un istante per tutta l'azione
    const data = await ctx.db.asUser(ctx.actor, (tx) => fn({ tx, practiceId: ctx.practiceId, clock }));
    if (options.revalidate ?? true) revalidatePath("/", "layout"); // dopo il commit
    return { ok: true, data };
  } catch (err) {
    // redirect() e notFound() lanciano: Next li gestisce lui, non sono errori da mostrare.
    unstable_rethrow(err);
    return toActionFailure(err, name);
  }
}
