"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { z } from "zod";

import { buttonVariants } from "@/components/ui/button";

// Una lettera che non c'è, è di un altro paziente o di un altro studio, o un id che non è un uuid:
// una frase e la strada per tornare alla Cartella del paziente dell'indirizzo. `not-found.tsx` non
// riceve props: l'id del paziente lo legge `useParams`, e se non è un uuid la strada porta alla lista dei pazienti.

const ID = z.uuid();

export default function ReferralNotFound() {
  const params = useParams<{ id?: string }>();
  const patientId = params.id;
  const href = patientId !== undefined && ID.safeParse(patientId).success ? `/pazienti/${patientId}?tab=cartella` : "/pazienti";
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Lettera non trovata.</h1>
      <Link href={href} prefetch={false} className={buttonVariants()}>
        Torna alla cartella
      </Link>
    </div>
  );
}
