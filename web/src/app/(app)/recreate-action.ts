"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { type ActionResult, toActionFailure } from "@/server/actions/result";
import { DEMO_PRACTICE_ID } from "@/server/auth/actor";
import { systemClock } from "@/server/clock";
import { loadConfig } from "@/server/config";
import { getRequestContext } from "@/server/db/next";
import { recreateDemoData } from "@/server/demo/recreate";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { getFileStore } from "@/server/files/disk-store";

/** L'orchestratore apre la propria transazione: qui non si usa runAction. */
export async function recreateDemoDataAction(): Promise<ActionResult<void>> {
  try {
    const ctx = await getRequestContext();
    if (ctx.practiceId !== DEMO_PRACTICE_ID) throw new DomainError(NOT_ALLOWED);
    await recreateDemoData(ctx.db, getFileStore(), systemClock, { demoMode: loadConfig().demoMode });
    revalidatePath("/", "layout");
    // Il redirect del server arriva insieme al nuovo albero: un router.push dal client dopo l'azione
    // poteva restare sulla pagina di Impostazioni.
    redirect("/oggi");
  } catch (error) {
    unstable_rethrow(error);
    return toActionFailure(error, "recreateDemoData");
  }
}
