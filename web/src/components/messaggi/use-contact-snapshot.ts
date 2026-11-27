"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ActionResult } from "@/server/actions/result";

/**
 * Link e copia sono sospesi mentre permessi e destinatario vengono riletti, anche dopo un rifiuto. `pending` dice
 * che la fotografia è in rilettura (o che la rilettura è fallita): `snapshot` allora è null ma non vuol dire
 * «nessun destinatario».
 */
export function useContactSnapshot<T>(key: string, initial: T, read: () => Promise<ActionResult<T>>) {
  const [snapshot, setSnapshot] = useState<{ key: string; initial: T; value: T; pending: boolean }>({ key, initial, value: initial, pending: false });
  const sequence = useRef(0);
  // Una nuova pagina può aggiornare il dato, ma non riabilita una fotografia già invalidata.
  if (snapshot.key !== key || snapshot.initial !== initial) {
    setSnapshot({ key, initial, value: initial, pending: snapshot.key === key && snapshot.pending });
  }
  const refresh = () => {
    const request = ++sequence.current;
    setSnapshot(previous => ({ ...previous, pending: true }));
    void read().then(result => {
      if (sequence.current !== request) return;
      if (result.ok) setSnapshot(previous => previous.key === key ? { ...previous, value: result.data, pending: false } : previous);
    }).catch(() => { /* Un errore lascia le azioni sospese fino alla prossima rilettura. */ });
  };
  const onReturn = useEffectEvent(refresh);
  useEffect(() => {
    const onFocus = () => onReturn();
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key]);
  useEffect(() => () => { sequence.current++; }, []);
  const pending = snapshot.key !== key || snapshot.pending;
  return { snapshot: pending ? null : snapshot.value, pending, refresh };
}
