import type { NextRequest } from "next/server";
import { z } from "zod";
import { systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { getFileStore } from "@/server/files/disk-store";
import { ensureInvoicePdf, recordInvoiceDownload } from "@/server/pdf/invoice-file";

export const dynamic = "force-dynamic";

// Il PDF di cortesia della fattura o della nota di credito: la
// prima richiesta lo genera e lo congela, le altre servono lo stesso file. Un id che non è un uuid, una
// bozza o una fattura che non c'è (anche di un altro studio, letta come l'utente) è 404, mai 403. Solo il
// download, con `?download=1` e `attachment`, scrive l'evento `pdf_scaricato`; l'anteprima nell'iframe del
// dettaglio è `inline` e non lo scrive. Nessuna cache; il nome non contiene il destinatario.

const NOT_FOUND = "Pagina non trovata";
const invoiceIdSchema = z.uuid();

function notFound(): Response {
  return new Response(NOT_FOUND, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/fatture/[id]/pdf">) {
  const { id } = await ctx.params;
  // Prima di toccare il database.
  if (!invoiceIdSchema.safeParse(id).success) return notFound();

  const requestContext = await getRequestContext();
  const pdf = await ensureInvoicePdf(requestContext, systemClock, getFileStore(), id);
  if (!pdf) return notFound();
  const isDownload = request.nextUrl.searchParams.get("download") === "1";
  if (isDownload) await recordInvoiceDownload(requestContext, systemClock, id, "pdf");

  const disposition = isDownload ? "attachment" : "inline";
  return new Response(new Uint8Array(pdf.bytes), {
    headers: {
      "content-type": "application/pdf",
      "cache-control": "private, no-store",
      "content-disposition": `${disposition}; filename="${pdf.fileName}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
