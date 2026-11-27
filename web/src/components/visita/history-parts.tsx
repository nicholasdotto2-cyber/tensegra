"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import type { RunOptions } from "@/lib/visits/save-queue";

// I pezzi che le parti dell'anamnesi della sezione A hanno in comune: il
// blocco con il suo titolo e il gruppo salvato intero.

/** Una voce dell'anamnesi: `input` è l'azione di `historyAction`; `settled` dice che la chiamata è finita. */
export type HistorySave = (input: Record<string, unknown>, options: RunOptions, settled?: () => void) => void;

/** Un blocco della sezione A: sezione con il titolo di livello 3. */
export function Block({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-medium">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * La copia locale di un gruppo che il comando riscrive intero (apparati, stile di vita, perinatale). Segue il server
 * quando nessuna sua scrittura è in volo; con scritture in volo vale la copia locale, così un'altra modifica parte
 * dalla copia che le contiene tutte. `server` deve essere stabile fra un render e l'altro (quello della vista).
 */
export function useGroup<T>(server: T, save: HistorySave, build: (value: T) => Record<string, unknown>) {
  const [value, setValue] = useState(server);
  const latest = useRef(server);
  const inflight = useRef(0);
  useEffect(() => {
    if (inflight.current > 0) return;
    latest.current = server;
    setValue(server);
  }, [server]);
  const update = (change: (current: T) => T, options: RunOptions) => {
    const next = change(latest.current);
    latest.current = next;
    setValue(next);
    inflight.current += 1;
    // Una sola volta per scrittura: «Riprova» rimanda la stessa chiamata e non la conta due volte.
    let settled = false;
    save(build(next), options, () => {
      if (settled) return;
      settled = true;
      inflight.current -= 1;
    });
  };
  return { value, update };
}
