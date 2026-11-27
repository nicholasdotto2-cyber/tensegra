import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { InvoiceDetailView } from "@/components/fatture/invoice-detail";
import { BlockError } from "@/components/oggi/block-error";
import { PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { fixedClock, systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { settle } from "@/server/db/settle";
import { getInvoiceDetail } from "@/server/domain/invoices/queries";

// Il dettaglio della fattura emessa o della nota di credito: l'anteprima della copia di cortesia e il
// pannello con stato, numero, data, file XML, cronologia, documento collegato e le azioni che lo stato permette.
// Una transazione con un `settle`. Un id che non è un uuid, una fattura che non c'è, di un altro studio o ancora
// in bozza (la bozza si apre nell'editor): 404 "Fattura non trovata." (`not-found.tsx` del segmento).

const INVOICE_ID = z.uuid();

export default async function InvoicePage({ params }: PageProps<"/fatture/[id]">) {
  const { id } = await params;
  // Prima di toccare il database: un id che non è un uuid non può essere di nessuna fattura.
  if (!INVOICE_ID.safeParse(id).success) notFound();

  const ctx = await getRequestContext();
  const clock = fixedClock(systemClock.now());
  const detail = await ctx.db.asUser(ctx.actor, (tx) =>
    settle(tx, "fattura", () => getInvoiceDetail(tx, ctx.practiceId, id)),
  );

  if (!detail.ok) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Fattura"
          actions={<Link href="/fatture" prefetch={false} className={buttonVariants({ variant: "outline" })}>Torna alle fatture</Link>}
        />
        <BlockError message="Non riesco a caricare la fattura." />
      </div>
    );
  }
  // Fuori dal `settle`: `notFound()` lancia, e un savepoint lo scambierebbe per un blocco fallito.
  if (detail.value === null || detail.value.status === "bozza") notFound();

  return <InvoiceDetailView detail={detail.value} today={clock.today()} />;
}
