"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { CancelDialog } from "@/components/fatture/cancel-dialog";
import { DOWNLOAD_ERROR, downloadFile } from "@/components/fatture/invoices-table";
import { PaymentDialog } from "@/components/fatture/payment-dialog";
import { XmlDialog } from "@/components/fatture/xml-dialog";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { datetimeAttr, dayField, romeDay, timeOf } from "@/lib/format";
import type { InvoiceDetail, InvoiceRow } from "@/server/domain/invoices/queries";

// Il dettaglio della fattura emessa o della nota di credito: a
// sinistra la copia di cortesia nell'iframe della route del PDF, che alla prima apertura lo genera e lo congela;
// a destra stato, numero e data, nome del file XML, documento collegato, le azioni che lo stato permette e la
// cronologia di `invoice_events`. Incasso e annullamento aprono i dialoghi della pagina Fatture.

/** Al posto di "Scarica XML" quando l'XML non c'è, cioè l'esente verso persona fisica. */
export const NO_XML = "In regime esente la fattura al paziente è cartacea o PDF e i dati vanno al Sistema TS (modulo non attivo)";

type Intent = InvoiceRow["actions"][number];
type DialogState = { intent: Intent; returnFocus: HTMLElement | null };

const ACTIONS: Record<Intent, string> = {
  registra_incasso: "Registra incasso", annulla_incasso: "Annulla incasso", annulla: "Annulla con nota di credito",
};

function StatusBadge({ detail }: { detail: InvoiceDetail }) {
  if (detail.docType === "TD04") return <Badge variant="outline">Nota di credito</Badge>;
  if (detail.status === "emessa") return <Badge className="bg-warning text-warning-foreground">Da incassare</Badge>;
  if (detail.status === "pagata") return <Badge className="bg-success text-success-foreground">Pagata</Badge>;
  return <Badge variant="outline">Annullata</Badge>;
}

/** I dialoghi di incasso e annullamento leggono di una riga solo id, numero, metodo e netto. */
function asRow(detail: InvoiceDetail): InvoiceRow {
  return {
    id: detail.id, docType: detail.docType, numberLabel: detail.numberLabel, issueDate: detail.issueDate,
    recipientText: "", minorText: null, serviceText: "", totalCents: detail.totalCents, netCents: detail.netCents,
    paymentMethod: detail.paymentMethod, stampDue: false, status: detail.status, hasXml: detail.hasXml,
    creditNote: detail.linked?.kind === "nota" ? { id: detail.linked.id, numberLabel: detail.linked.numberLabel } : null,
    actions: detail.actions,
  };
}

function At({ iso }: { iso: string }) {
  const at = new Date(iso);
  return <time dateTime={datetimeAttr(at)}>{dayField(romeDay(at))} alle {timeOf(at)}</time>;
}

export function InvoiceDetailView({ detail, today }: { detail: InvoiceDetail; today: string }) {
  const router = useRouter();
  const headingId = useId();
  const historyId = useId();
  const pdfButton = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [downloading, startDownload] = useTransition();
  const isNote = detail.docType === "TD04";
  const label = detail.numberLabel ?? "";
  const title = `${isNote ? "Nota di credito" : "Fattura"} n. ${label}`;

  function download(kind: "pdf" | "xml") {
    startDownload(async () => {
      try {
        await downloadFile(`/api/fatture/${detail.id}/${kind}?download=1`, `${isNote ? "nota" : "fattura"}.${kind}`);
        // La route ha scritto `pdf_scaricato` o `xml_scaricato`: la cronologia si rilegge.
        router.refresh();
      } catch {
        toast.error(DOWNLOAD_ERROR);
      }
    });
  }

  function close() {
    const target = dialog?.returnFocus;
    setDialog(null);
    // Dopo un annullamento il pulsante che ha aperto il dialogo non c'è più: il focus va su "Scarica PDF".
    requestAnimationFrame(() => (target?.isConnected ? target : pdfButton.current)?.focus());
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={title}
        actions={<Link href="/fatture" prefetch={false} className={buttonVariants({ variant: "outline" })}>Torna alle fatture</Link>}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <iframe
          title="Anteprima della fattura"
          src={`/api/fatture/${detail.id}/pdf`}
          className="aspect-[210/297] w-full rounded-xl border bg-white"
        />
        <section aria-labelledby={headingId} className="flex flex-col gap-5 rounded-xl border bg-card p-4">
          <h2 id={headingId} className="text-lg font-semibold">Dati della fattura</h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Stato</dt>
            <dd><StatusBadge detail={detail} /></dd>
            <dt className="text-muted-foreground">Numero</dt>
            <dd className="tabular-nums">{label}</dd>
            <dt className="text-muted-foreground">Data</dt>
            <dd className="tabular-nums">{detail.issueDate ? dayField(detail.issueDate) : ""}</dd>
            {detail.xmlFileName && <>
              <dt className="text-muted-foreground">File XML</dt>
              <dd className="break-all">{detail.xmlFileName}</dd>
            </>}
            {detail.linked && <>
              <dt className="text-muted-foreground">{detail.linked.kind === "nota" ? "Annullata con" : "Storna"}</dt>
              <dd>
                <Link href={`/fatture/${detail.linked.id}`} prefetch={false} className="inline-flex min-h-6 items-center underline underline-offset-4">
                  {detail.linked.kind === "nota" ? "Nota di credito" : "Fattura"} {detail.linked.numberLabel}
                </Link>
              </dd>
            </>}
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button ref={pdfButton} variant="outline" disabled={downloading} onClick={() => download("pdf")}>Scarica PDF</Button>
            {detail.hasXml ? <>
              <Button variant="outline" disabled={downloading} onClick={() => download("xml")}>Scarica XML</Button>
              <XmlDialog invoiceId={detail.id} title={`XML ${isNote ? "della nota di credito" : "della fattura"} ${label}`} />
            </> : <p className="basis-full text-sm text-muted-foreground">{NO_XML}</p>}
            {detail.actions.map((intent) => (
              <Button key={intent} variant={intent === "registra_incasso" ? "default" : "outline"}
                onClick={(e) => setDialog({ intent, returnFocus: e.currentTarget })}>
                {ACTIONS[intent]}
              </Button>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <h3 id={historyId} className="font-medium">Cronologia</h3>
            <ol aria-labelledby={historyId} className="flex flex-col gap-2 text-sm">
              {detail.events.map((event, index) => (
                <li key={`${event.at}-${index}`} className="flex flex-wrap justify-between gap-x-3">
                  <span>{event.label}</span>
                  <span className="text-muted-foreground tabular-nums"><At iso={event.at} /></span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </div>
      {dialog?.intent === "annulla" && <CancelDialog row={asRow(detail)} onClose={close} returnFocus={dialog.returnFocus} />}
      {(dialog?.intent === "registra_incasso" || dialog?.intent === "annulla_incasso") && (
        <PaymentDialog row={asRow(detail)} undo={dialog.intent === "annulla_incasso"} today={today} onClose={close} returnFocus={dialog.returnFocus} />
      )}
    </div>
  );
}
