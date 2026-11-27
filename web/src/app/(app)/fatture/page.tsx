import { InvoicesPage } from "@/components/fatture/invoices-page";
import { parseInvoiceListParams } from "@/lib/fiscal/list-params";
import { fixedClock, systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { settle } from "@/server/db/settle";
import { getMonthTiles, listDrafts, listInvoices, listToInvoice } from "@/server/domain/invoices/queries";

export default async function FatturePage({ searchParams }: PageProps<"/fatture">) {
  const ctx = await getRequestContext();
  const clock = fixedClock(systemClock.now());
  const params = parseInvoiceListParams(await searchParams, clock.today());
  // Una transazione, un savepoint per blocco. Un elenco guasto non nasconde gli altri.
  const data = await ctx.db.asUser(ctx.actor, async (tx) => ({
    toInvoice: await settle(tx, "da_emettere", () => listToInvoice(tx, ctx.practiceId, clock)),
    drafts: await settle(tx, "bozze", () => listDrafts(tx, ctx.practiceId)),
    invoices: await settle(tx, "emesse", () => listInvoices(tx, ctx.practiceId, params)),
    tiles: await settle(tx, "riquadri", () => getMonthTiles(tx, ctx.practiceId, params.mese)),
  }));
  return <InvoicesPage params={params} today={clock.today()} {...data} />;
}
