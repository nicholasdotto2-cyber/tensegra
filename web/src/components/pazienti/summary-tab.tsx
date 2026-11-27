import Link from "next/link";
import { type ReactNode, useId } from "react";

import { MessagesTabView } from "@/components/pazienti/messages-tab";
import { RecallDialog } from "@/components/pazienti/recall-dialog";
import { Sparkline } from "@/components/pazienti/sparkline";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { patientHref } from "@/lib/patients/params";
import type { SummaryTab } from "@/server/domain/patients/card";

// La tab Riepilogo: prossimo appuntamento, ciclo in corso con il dolore
// 0-10 a inizio seduta, richiamo con "Cambia", stato dell'informativa e del consenso del ciclo, medico
// curante e inviante, ultimi tre messaggi con link alla cronologia completa.

const NO_NEXT = "Nessun appuntamento fissato.";
const NO_CYCLE = "Nessun ciclo aperto.";
const NO_RECALL = "Nessun richiamo previsto.";
// Come la Cartella e il rinvio al medico: un valore che manca è "non rilevato".
const NOT_WRITTEN = "non rilevato";
const NOT_INDICATED = "non indicato";

function Block({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id={headingId}>{title}</h2>
          </CardTitle>
          {action === undefined ? null : <CardAction>{action}</CardAction>}
        </CardHeader>
        <CardContent className="flex flex-col gap-1">{children}</CardContent>
      </Card>
    </section>
  );
}

/** Le righe del richiamo: la scadenza del richiamo se c'è una data, poi la cadenza; "Sospeso" con la pausa. */
function recallLines(recall: SummaryTab["recall"]): string[] {
  const cadence = recall.weeks === null ? null : `Ogni ${recall.weeks} settimane`;
  if (recall.paused) return cadence === null ? ["Sospeso"] : ["Sospeso", cadence];
  if (cadence === null) return [NO_RECALL];
  return recall.dueText === null ? [cadence] : [recall.dueText, cadence];
}

export function SummaryTabView({ tab, patientId }: { tab: SummaryTab; patientId: string }) {
  const { next, cycle, recall } = tab;
  const painText = cycle?.pain.map((v) => (v === null ? NOT_WRITTEN : `${v}`)).join(" → ") ?? "";
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Block title="Prossimo appuntamento">
        {next === null ? <p>{NO_NEXT}</p> : <time dateTime={next.at}>{next.text}</time>}
      </Block>

      <Block title="Ciclo in corso">
        {cycle === null ? (
          <p>{NO_CYCLE}</p>
        ) : (
          <>
            <p className="font-medium">{cycle.title}</p>
            {cycle.goal === null ? null : <p className="text-muted-foreground">{cycle.goal}</p>}
            <p>{cycle.doneText}</p>
            {cycle.pain.length === 0 ? null : (
              <div className="flex items-center gap-3 pt-1">
                <Sparkline values={cycle.pain} max={10} label={`Dolore 0-10 a inizio seduta: ${painText}`} />
                <p className="text-sm">
                  <span className="text-muted-foreground">Dolore 0-10 a inizio seduta: </span>
                  <span className="tabular-nums">{painText}</span>
                </p>
              </div>
            )}
          </>
        )}
      </Block>

      <Block
        title="Richiamo"
        action={<RecallDialog patientId={patientId} weeks={recall.weeks} paused={recall.paused} />}
      >
        {recallLines(recall).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </Block>

      <Block title="Consensi">
        <dl className="flex flex-col gap-1">
          {tab.consents.map((consent) => (
            <div key={consent.label} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
              <dt className="text-muted-foreground">{consent.label}</dt>
              <dd>{consent.state}</dd>
            </div>
          ))}
        </dl>
      </Block>

      <Block title="Medici">
        <p>{`Medico curante: ${tab.gp ?? NOT_INDICATED}`}</p>
        <p>{`Medico inviante: ${tab.referring ?? NOT_INDICATED}`}</p>
      </Block>
      <Block
        title="Ultimi messaggi"
        action={
          <Link href={patientHref(patientId, { tab: "messaggi" })} prefetch={false} className="text-sm underline underline-offset-4">
            Vedi tutti
          </Link>
        }
      >
        <MessagesTabView rows={tab.messages} />
      </Block>
    </div>
  );
}
