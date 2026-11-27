import type { NextRequest } from "next/server";
import { esePeriod } from "@/lib/fiscal/redact";
import { getRequestContext } from "@/server/db/next";
import { listEseDocuments } from "@/server/domain/invoices/queries";
import { renderInvoicePdf } from "@/server/pdf/render";

export const dynamic = "force-dynamic";

// L'anteprima dell'export: il PDF oscurato del primo documento del periodo, `inline`, per vedere
// com'è fatto prima di scaricare lo ZIP. Non registra niente: nessun export e nessun evento.

const PERIOD_MONTH = /^\d{4}-\d{2}$/;

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function GET(request: NextRequest) {
  const from = request.nextUrl.searchParams.get("da") ?? "";
  const to = request.nextUrl.searchParams.get("a") ?? "";
  if (!PERIOD_MONTH.test(from) || !PERIOD_MONTH.test(to) || !esePeriod(from, to)) return text(400, "Periodo non valido.");

  const ctx = await getRequestContext();
  const [first] = await ctx.db.asUser(ctx.actor, (tx) => listEseDocuments(tx, ctx.practiceId, from, to));
  if (!first) return text(409, "Nessuna fattura nel periodo scelto.");

  const bytes = await renderInvoicePdf(first.snapshot, "oscurata", first.standardDescriptions);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "cache-control": "private, no-store",
      "content-disposition": 'inline; filename="anteprima-oscurata.pdf"',
      "x-content-type-options": "nosniff",
    },
  });
}
