import type { NextRequest } from "next/server";
import { z } from "zod";
import { systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { getFileStore } from "@/server/files/disk-store";
import { ensureConsentDocument } from "@/server/pdf/consent-file";

export const dynamic = "force-dynamic";

// Il documento di un consenso: il PDF firmato sulla tela, creato alla
// prima richiesta e poi servito sempre uguale, o il modulo caricato nella sua MIME, senza trasformazioni. È
// l'unica via per i file dei consensi: `/api/files` non serve firme né documenti. Un id che non è un uuid, un
// consenso che non c'è (anche di un altro studio, letto come l'utente) o un file mancante o cambiato è 404,
// mai 403. Un consenso revocato resta scaricabile. Nessuna cache, nessun evento; il nome non contiene il paziente.

const NOT_FOUND = "Pagina non trovata";
const consentIdSchema = z.uuid();

function notFound(): Response {
  return new Response(NOT_FOUND, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/consensi/[id]/documento">) {
  const { id } = await ctx.params;
  // Prima di toccare il database.
  if (!consentIdSchema.safeParse(id).success) return notFound();

  const document = await ensureConsentDocument(await getRequestContext(), systemClock, getFileStore(), id);
  if (!document) return notFound();

  const disposition = request.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
  return new Response(new Uint8Array(document.bytes), {
    headers: {
      "content-type": document.mimeType,
      "cache-control": "private, no-store",
      "content-disposition": `${disposition}; filename="${document.fileName}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
