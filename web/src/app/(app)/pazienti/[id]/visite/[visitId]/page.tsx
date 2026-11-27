import { notFound } from "next/navigation";
import { z } from "zod";

import type { ServiceOption } from "@/components/agenda/appointment-dialog";
import { BlockError } from "@/components/oggi/block-error";
import { PageHeader } from "@/components/shell/page-header";
import { VisitEditorView } from "@/components/visita/visit-editor";
import { fixedClock, systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { settle } from "@/server/db/settle";
import { listActiveServices } from "@/server/domain/services/queries";
import { getClinicalSettings } from "@/server/domain/settings/queries";
import { getVisitEditor } from "@/server/domain/visits/editor";

// L'editor della visita. Una transazione per la pagina con due `settle`: la
// vista dell'editor intera, che poi vive nel client e si aggiorna con le risposte delle sue Server Action, e le
// prestazioni con i default che servono a "Fissa il prossimo appuntamento" della sezione E (senza, il pulsante non
// c'è). Due id che non sono uuid, una visita che non c'è, di un altro paziente o di un altro studio: 404 prima di
// mostrare niente.

const ID = z.uuid();

// I default della tabella `clinical_settings`, se la riga dello studio manca (come nella scheda del paziente).
const DEFAULT_INTERVAL_WEEKS = 2;
const DEFAULT_EXPECTED_SESSIONS = 4;

export default async function VisitPage({ params }: PageProps<"/pazienti/[id]/visite/[visitId]">) {
  const { id, visitId } = await params;
  // Prima di toccare il database: un id che non è un uuid non può essere di nessuna visita.
  if (!ID.safeParse(id).success || !ID.safeParse(visitId).success) notFound();

  const ctx = await getRequestContext();
  const clock = fixedClock(systemClock.now());
  const { editor, booking } = await ctx.db.asUser(ctx.actor, async (tx) => ({
    editor: await settle(tx, "editor", () => getVisitEditor(tx, ctx.practiceId, clock, id, visitId)),
    booking: await settle(tx, "prestazioni", async () => {
      const services = await listActiveServices(tx, ctx.practiceId);
      const clinical = await getClinicalSettings(tx, ctx.practiceId);
      return {
        services: services.map(
          (s): ServiceOption => ({ id: s.id, name: s.name, kind: s.kind, durationMin: s.durationMin, priceCents: s.priceCents }),
        ),
        defaultIntervalWeeks: clinical?.defaultSessionIntervalWeeks ?? DEFAULT_INTERVAL_WEEKS,
        defaultExpectedSessions: clinical?.defaultExpectedSessions ?? DEFAULT_EXPECTED_SESSIONS,
      };
    }),
  }));

  if (!editor.ok) {
    return (
      <>
        <PageHeader title="Visita" />
        <BlockError message="Non riesco a caricare la visita." />
      </>
    );
  }
  // Fuori dal `settle`: `notFound()` lancia, e un savepoint lo scambierebbe per un blocco fallito.
  if (editor.value === null) notFound();

  // La chiave: un'altra visita è un altro editor, con la sua coda e il suo stato.
  return (
    <VisitEditorView key={editor.value.visit.id} initial={editor.value} booking={booking.ok ? booking.value : null} />
  );
}
