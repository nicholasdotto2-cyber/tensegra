import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

// Un paziente che non c'è, non è di questo studio o il cui id non è un uuid: una frase e la
// strada per tornare alla lista. Sidebar e banner restano, perché il segmento sta dentro la shell.
export default function PatientNotFound() {
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Paziente non trovato.</h1>
      <Link href="/pazienti" className={buttonVariants()}>
        Torna ai pazienti
      </Link>
    </div>
  );
}
