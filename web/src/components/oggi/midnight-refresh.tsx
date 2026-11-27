"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent } from "react";

import { currentDayAction } from "@/app/(app)/oggi/actions";

// La demo può restare aperta per ore: al ritorno sulla scheda la pagina chiede il giorno al
// server, che rispetta APP_FIXED_NOW, e si ricarica se non è più quello mostrato. Mai l'orologio del
// browser.
export function MidnightRefresh({ day }: { day: string }) {
  const router = useRouter();

  const checkDay = useEffectEvent(async () => {
    try {
      if ((await currentDayAction()) !== day) router.refresh();
    } catch {
      // Senza rete la pagina resta com'è; il prossimo ritorno sulla scheda riprova.
    }
  });

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkDay();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  return null;
}
