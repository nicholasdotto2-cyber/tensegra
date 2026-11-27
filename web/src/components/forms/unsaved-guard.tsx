"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

// L'uscita con modifiche non salvate. Finché la sezione è modificata il browser
// chiede conferma a chiudere o ricaricare la scheda (`beforeunload`), e un clic su un link interno che
// porta altrove si ferma sul dialogo «Uscire senza salvare?». "Esci senza salvare" segue il link,
// "Torna indietro" resta sulla sezione. Senza modifiche non fa niente. Il tasto indietro del browser non
// passa da qui: lo copre solo `beforeunload`.

/** L'indirizzo interno verso cui porta il clic, o null se non va fermato (altra scheda, altro sito, stessa pagina). */
function internalTarget(event: MouseEvent): string | null {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  if (!(event.target instanceof Element)) return null;
  const anchor = event.target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if ((anchor.target !== "" && anchor.target !== "_self") || anchor.hasAttribute("download")) return null;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  // Un'àncora della stessa pagina ("Vai al contenuto") non lascia la sezione.
  if (url.pathname === window.location.pathname && url.search === window.location.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** La frase predefinita del dialogo: un modulo a sezioni; l'editor della visita ne passa una sua. */
const DEFAULT_DESCRIPTION = "Le modifiche di questa sezione andranno perse.";

export function UnsavedGuard({ dirty, description = DEFAULT_DESCRIPTION }: { dirty: boolean; description?: string }) {
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);
  // Dopo "Esci senza salvare" il clic che segue il link non va fermato un'altra volta.
  const leaving = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    leaving.current = false;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    // In fase di cattura sul documento, prima del gestore di `Link` di Next: fermare qui il clic
    // impedisce la navigazione.
    const onClick = (event: MouseEvent) => {
      if (leaving.current || event.defaultPrevented) return;
      const href = internalTarget(event);
      if (href === null) return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(href);
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Uscire senza salvare?</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Torna indietro</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              if (target === null) return;
              leaving.current = true;
              router.push(target);
              setTarget(null);
            }}
          >
            Esci senza salvare
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
