"use server";

import { systemClock } from "@/server/clock";

// Il giorno di Roma di adesso, "AAAA-MM-GG", per la pagina Oggi lasciata aperta: rispetta
// APP_FIXED_NOW e non scrive niente, quindi niente transazione e niente `revalidatePath`.
export async function currentDayAction(): Promise<string> {
  return systemClock.today();
}
