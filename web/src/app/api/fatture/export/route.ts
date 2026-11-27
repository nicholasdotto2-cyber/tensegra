import type { NextRequest } from "next/server";
import { esePeriod } from "@/lib/fiscal/redact";
import { systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { recordEseExport } from "@/server/domain/invoices/commands";
import { listEseDocuments } from "@/server/domain/invoices/queries";
import { buildEseZip } from "@/server/pdf/ese-export";

export const dynamic = "force-dynamic";

// L'export oscurato per l'elenco speciale: una transazione legge i
// documenti, lo ZIP si costruisce fuori da ogni transazione, una seconda registra `fiscal_exports` (con lo
// sha256 dello ZIP) e un evento `export_ese` per fattura, e solo dopo si risponde. Nessuna cache.

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
  const documents = await ctx.db.asUser(ctx.actor, (tx) => listEseDocuments(tx, ctx.practiceId, from, to));
  if (documents.length === 0) return text(409, "Nessuna fattura nel periodo scelto.");

  const zip = await buildEseZip({ from, to, generatedAt: systemClock.now(), documents });
  await ctx.db.asUser(ctx.actor, (tx) =>
    recordEseExport(tx, ctx.practiceId, systemClock, {
      from, to, count: zip.count, zipSha256: zip.sha256, invoiceIds: documents.map((doc) => doc.id),
    }),
  );

  return new Response(new Uint8Array(zip.bytes), {
    headers: {
      "content-type": "application/zip",
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${zip.fileName}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
