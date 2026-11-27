import Link from "next/link";
import { type ReactNode, useId } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CartellaTab } from "@/server/domain/cartella/queries";

// I riquadri laterali della Cartella: «Rinvii al medico» (tutti, dal più
// recente, con lo stato e il link alla lettera), «Ultimi allegati» (le ultime 3 foto) e «Richiamo» (il testo
// della cella della lista, o «Nessun richiamo previsto.»).

const NO_REFERRALS = "Nessun rinvio.";
const NO_ATTACHMENTS = "Nessun allegato.";

function Box({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <Card size="sm">
        <CardHeader>
          <CardTitle>
            <h2 id={headingId}>{title}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">{children}</CardContent>
      </Card>
    </section>
  );
}

export function SideBoxes({
  referrals,
  attachments,
  recallText,
  patientId,
}: {
  referrals: CartellaTab["referrals"];
  attachments: CartellaTab["attachments"];
  recallText: string;
  patientId: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Box title="Rinvii al medico">
        {referrals.length === 0 ? (
          <p className="text-muted-foreground">{NO_REFERRALS}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {referrals.map((referral) => (
              <li key={referral.id} className="flex flex-col">
                <Link
                  href={`/pazienti/${patientId}/rinvii/${referral.id}`}
                  prefetch={false}
                  className="w-fit font-medium underline-offset-4 hover:underline"
                >
                  {referral.text}
                </Link>
                <span className="text-muted-foreground">{referral.statusLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </Box>

      <Box title="Ultimi allegati">
        {attachments.length === 0 ? (
          <p className="text-muted-foreground">{NO_ATTACHMENTS}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {attachments.map((photo) => (
              <li key={photo.id}>
                {/* Il file è privato (cookie di sessione): si apre in un'altra scheda, senza `next/link`. */}
                <a
                  href={`/api/files/${photo.fileId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline-offset-4 hover:underline"
                >
                  <time dateTime={photo.takenOn}>{photo.dateText}</time>
                  {`, ${photo.viewLabel}`}
                  <span className="sr-only"> (si apre in una nuova scheda)</span>
                </a>
                {photo.caption === null ? null : <p className="text-muted-foreground">{photo.caption}</p>}
              </li>
            ))}
          </ul>
        )}
      </Box>

      <Box title="Richiamo">
        <p>{recallText}</p>
      </Box>
    </div>
  );
}
