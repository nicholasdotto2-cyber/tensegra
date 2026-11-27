import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

// Una fattura che non c'è, è di un altro studio, è ancora in bozza o il cui id non è un uuid: una
// frase e la strada per tornare alle fatture. Sidebar e banner restano, perché il segmento sta dentro la shell.
export default function InvoiceNotFound() {
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Fattura non trovata.</h1>
      <Link href="/fatture" prefetch={false} className={buttonVariants()}>
        Torna alle fatture
      </Link>
    </div>
  );
}
