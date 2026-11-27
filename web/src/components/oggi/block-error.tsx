"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";

// Lo stato di un blocco che non si è caricato: gli altri blocchi restano e
// "Riprova" chiede alla pagina di rileggere tutto. L'agenda lo usa con la sua frase.
export function BlockError({ message = "Non riesco a caricare questo elenco." }: { message?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col items-start gap-3">
      <p>{message}</p>
      <Button variant="outline" aria-busy={pending} onClick={() => startTransition(() => router.refresh())}>
        Riprova
      </Button>
    </div>
  );
}
