import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { BlockError } from "@/components/oggi/block-error";
import { LetterPreview } from "@/components/rinvio/letter-preview";
import { ReferralForm } from "@/components/rinvio/referral-form";
import { PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { fixedClock, systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { settle } from "@/server/db/settle";
import { listPhysicians } from "@/server/domain/physicians/queries";
import { getReferralLetter } from "@/server/domain/referrals/queries";

// La lettera al medico: il modulo a sinistra e il foglio A4 a destra. Una
// transazione per la pagina con due `settle`: la lettera e la rubrica dei medici. Due id che non sono uuid, una
// lettera che non c'è, di un altro paziente o di un altro studio: 404 prima di mostrare niente
// (`not-found.tsx` del segmento).

const ID = z.uuid();
const TITLE = "Lettera al medico";

function BackToCartella({ patientId }: { patientId: string }) {
  return (
    <Link href={`/pazienti/${patientId}?tab=cartella`} prefetch={false} className={buttonVariants({ variant: "outline" })}>
      Torna alla cartella
    </Link>
  );
}

export default async function ReferralPage({ params }: PageProps<"/pazienti/[id]/rinvii/[referralId]">) {
  const { id, referralId } = await params;
  // Prima di toccare il database: un id che non è un uuid non può essere di nessuna lettera.
  if (!ID.safeParse(id).success || !ID.safeParse(referralId).success) notFound();

  const ctx = await getRequestContext();
  const clock = fixedClock(systemClock.now());
  const { letter, physicians } = await ctx.db.asUser(ctx.actor, async (tx) => ({
    letter: await settle(tx, "lettera", () => getReferralLetter(tx, ctx.practiceId, referralId)),
    physicians: await settle(tx, "medici", () => listPhysicians(tx, ctx.practiceId)),
  }));

  if (!letter.ok || !physicians.ok) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} actions={<BackToCartella patientId={id} />} />
        <BlockError message="Non riesco a caricare la lettera." />
      </div>
    );
  }
  // Fuori dal `settle`: `notFound()` lancia, e un savepoint lo scambierebbe per un blocco fallito.
  if (letter.value === null || letter.value.patientId !== id) notFound();
  const value = letter.value;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={TITLE}
        subtitle={
          <>
            <span>{value.patient.name}</span> <span aria-hidden="true">·</span> <span>{value.statusLabel}</span>
          </>
        }
        actions={<BackToCartella patientId={id} />}
      />
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        {/* La chiave: un'altra lettera è un altro modulo, con i suoi valori. */}
        <ReferralForm key={value.id} letter={value} physicians={physicians.value} today={clock.today()} />
        <LetterPreview letter={value} />
      </div>
    </div>
  );
}
