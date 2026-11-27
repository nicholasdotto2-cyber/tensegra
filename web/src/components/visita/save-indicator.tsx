"use client";

import { Check, CircleAlert, LoaderCircle, TriangleAlert } from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { SaveState } from "./use-visit-save";

// Lo stato del salvataggio automatico. La regione `aria-live="polite"`
// c'è sempre, anche vuota, e dice una cosa per salvataggio: "Salvato", oppure «Non ho salvato l'ultima modifica.»
// con «Riprova» dopo un guasto, oppure il messaggio di un rifiuto (`message`), senza «Riprova» perché rimandare
// darebbe lo stesso errore. «Salvo...» si vede accanto ma resta fuori dalla regione: durante il salvataggio la
// regione si svuota, così "Salvato" si annuncia di nuovo anche dopo un altro "Salvato". Ogni stato ha testo e
// icona, mai solo il colore. «Riprova» sparisce appena riparte il salvataggio: il focus va sul testo dello stato.

const ERROR_TEXT = "Non ho salvato l'ultima modifica.";

export function SaveIndicator({
  state,
  onRetry,
  message,
}: {
  state: SaveState;
  onRetry: () => void;
  /** Il messaggio dell'ultimo rifiuto, o null. */
  message: string | null;
}) {
  const statusRef = useRef<HTMLParagraphElement>(null);

  let announced: { text: string; Icon: typeof Check; tone: "muted" | "error" } | null = null;
  if (state === "error") announced = { text: ERROR_TEXT, Icon: TriangleAlert, tone: "error" };
  else if (state !== "saving" && message !== null) announced = { text: message, Icon: CircleAlert, tone: "error" };
  else if (state === "saved") announced = { text: "Salvato", Icon: Check, tone: "muted" };

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-2 text-sm">
      {state === "saving" ? (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
          Salvo...
        </span>
      ) : null}
      <p
        ref={statusRef}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className={cn(
          "flex items-center gap-1.5 outline-none",
          announced?.tone === "error" ? "font-medium text-destructive" : "text-muted-foreground",
        )}
      >
        {announced === null ? null : (
          <>
            <announced.Icon aria-hidden="true" className="size-4 shrink-0" />
            {announced.text}
          </>
        )}
      </p>
      {state === "error" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            statusRef.current?.focus();
            onRetry();
          }}
        >
          Riprova
        </Button>
      ) : null}
    </div>
  );
}
