"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { z } from "zod";

import { buttonVariants } from "@/components/ui/button";

// Una visita che non c'è, è di un altro paziente o di un altro studio, o un id che non è un uuid:
// una frase e la strada per tornare alla scheda del paziente dell'indirizzo. `not-found.tsx` non riceve props:
// l'id del paziente lo legge `useParams`, e se non è un uuid la strada porta alla lista dei pazienti.

const ID = z.uuid();

export default function VisitNotFound() {
  const params = useParams<{ id?: string }>();
  const patientId = params.id;
  const href = patientId !== undefined && ID.safeParse(patientId).success ? `/pazienti/${patientId}` : "/pazienti";
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Visita non trovata.</h1>
      <Link href={href} prefetch={false} className={buttonVariants()}>
        Torna alla scheda
      </Link>
    </div>
  );
}
