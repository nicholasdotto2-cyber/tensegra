import Link from "next/link";

import type { ServiceOption } from "@/components/agenda/appointment-dialog";
import { BlockCard } from "@/components/oggi/block-card";
import { BlockError } from "@/components/oggi/block-error";
import { RecallList, WithoutConsentGroup } from "@/components/pazienti/recall-actions";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Settled } from "@/server/db/settle";
import { type RecallBlock, TODAY_RECALL_ROWS } from "@/server/domain/patients/queries";

// Blocco 5 di Oggi: il titolo conta tutti i richiami in
// regola, anche quelli in attesa di risposta, e la lista ne mostra al massimo 5, con l'attesa in fondo. Ogni
// riga in regola ha «Apri WhatsApp», «Copia», «Fissa appuntamento» e il menu con «Rimanda di 2 settimane» e
// «Sospendi i richiami» (`RecallList`), e solo quelle 5 hanno il messaggio preparato (`listTodayRecalls`). Chi è in regola per data ma non ha il consenso ai richiami sta in un
// gruppo chiuso, senza azioni, con la ragione. "Vedi tutti", in coda, apre Pazienti col filtro "Da richiamare".

const TITLE = "Da richiamare";
const ALL_HREF = "/pazienti?filtro=da_richiamare";

export function RecallsBlock({
  state,
  services,
  defaultIntervalWeeks,
  defaultExpectedSessions,
}: {
  state: Settled<RecallBlock>;
  services: readonly ServiceOption[];
  defaultIntervalWeeks: number;
  defaultExpectedSessions: number;
}) {
  if (!state.ok) {
    return (
      <BlockCard title={TITLE} count={null}>
        <BlockError />
      </BlockCard>
    );
  }

  const { rows, withoutConsent } = state.value;
  const booking = { services, defaultIntervalWeeks, defaultExpectedSessions };
  return (
    <BlockCard title={TITLE} count={rows.length}>
      <div className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="text-muted-foreground">Nessun richiamo in scadenza questa settimana.</p>
        ) : (
          <RecallList rows={rows.slice(0, TODAY_RECALL_ROWS)} booking={booking} />
        )}
        <WithoutConsentGroup rows={withoutConsent} />
        {/* Pagina dinamica con i dati dello studio: niente prefetch. */}
        <Link
          href={ALL_HREF}
          prefetch={false}
          className={cn(buttonVariants({ variant: "link", size: "sm" }), "-ml-2.5 w-fit")}
        >
          Vedi tutti
        </Link>
      </div>
    </BlockCard>
  );
}
