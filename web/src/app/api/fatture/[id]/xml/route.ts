import type { NextRequest } from "next/server";
import { z } from "zod";
import { systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { readInvoiceXml } from "@/server/pdf/invoice-file";

export const dynamic = "force-dynamic";

// L'XML della fattura elettronica: il file salvato all'emissione,
// byte per byte, sempre in download. Nel demo il nome ha `PROVA_` davanti. Un id che non è un uuid, una
// bozza, una fattura senza XML (l'esente verso persona fisica) o di un altro studio è 404, mai 403. Ogni 200
// scrive l'evento `xml_scaricato`. Nessuna cache; il nome non contiene il destinatario.

const NOT_FOUND = "Pagina non trovata";
const invoiceIdSchema = z.uuid();

function notFound(): Response {
  return new Response(NOT_FOUND, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/fatture/[id]/xml">) {
  const { id } = await ctx.params;
  // Prima di toccare il database.
  if (!invoiceIdSchema.safeParse(id).success) return notFound();

  const requestContext = await getRequestContext();
  const file = await readInvoiceXml(requestContext, systemClock, id);
  if (!file) return notFound();

  return new Response(file.xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
