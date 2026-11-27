import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

// Pagina o paziente inesistente: una frase e la strada per tornare. Il contenitore
// (`main` fuori dalla shell, `main#contenuto` dentro) lo mettono i due `not-found.tsx`.
export function NotFoundState() {
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Pagina non trovata</h1>
      <Link href="/oggi" className={buttonVariants()}>
        Torna a Oggi
      </Link>
    </div>
  );
}
