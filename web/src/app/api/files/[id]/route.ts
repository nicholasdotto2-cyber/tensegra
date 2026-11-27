import type { NextRequest } from "next/server";
import { z } from "zod";
import { getRequestContext } from "@/server/db/next";
import { downloadName, getStoredFile } from "@/server/domain/files/queries";
import { getFileStore } from "@/server/files/disk-store";

export const dynamic = "force-dynamic";

// I file privati dello studio: la riga si cerca come l'utente,
// quindi un file di un altro studio non c'è, ed è 404 come un id che non è un uuid o un file sparito dal
// disco (mai 403). Nessuna cache: `private, no-store`. Il nome scaricato non contiene il paziente.

const GONE = "Il file non è più disponibile";
const fileIdSchema = z.uuid();

function gone(): Response {
  return new Response(GONE, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/files/[id]">) {
  const { id } = await ctx.params;
  // Prima di toccare il database.
  if (!fileIdSchema.safeParse(id).success) return gone();

  const { db, actor, practiceId } = await getRequestContext();
  const row = await db.asUser(actor, (tx) => getStoredFile(tx, practiceId, id));
  if (!row) return gone();
  const bytes = await getFileStore().get(row.storageKey);
  if (!bytes) return gone();

  const disposition = request.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": row.mimeType,
      "cache-control": "private, no-store",
      "content-disposition": `${disposition}; filename="${downloadName(row)}"`,
      // Il tipo è quello letto dai primi byte al caricamento: il browser non ne indovina un altro.
      "x-content-type-options": "nosniff",
    },
  });
}
