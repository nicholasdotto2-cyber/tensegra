import { useEffect, useRef } from "react";

import type { RegionCode } from "@/lib/clinical/catalog";

// «Apri la regione» della sezione D: chiede alla sezione C di aprire il pannello di una regione. Le due
// sezioni non si conoscono: la richiesta passa da un evento della finestra, come le sezioni si aprono dai link di
// "Per chiudere" (`revealAnchor`).

const EVENT = "visita:apri-regione";

export function requestOpenRegion(region: RegionCode): void {
  window.dispatchEvent(new CustomEvent<RegionCode>(EVENT, { detail: region }));
}

/** Chi apre i pannelli delle regioni (la sezione C) ascolta le richieste con l'ultima versione di `handler`. */
export function useOpenRegionRequests(handler: (region: RegionCode) => void): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const listener = (event: Event) => latest.current((event as CustomEvent<RegionCode>).detail);
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
}
