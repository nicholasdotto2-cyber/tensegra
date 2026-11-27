import type { NextRequest } from "next/server";
import { z } from "zod";
import { LETTER_CHANGED } from "@/lib/clinical/labels";
import { systemClock } from "@/server/clock";
import { getRequestContext } from "@/server/db/next";
import { isDomainError } from "@/server/domain/errors";
import { getFileStore } from "@/server/files/disk-store";
import { ensureReferralPdf } from "@/server/pdf/referral-file";

export const dynamic = "force-dynamic";

// Il PDF della lettera al medico: la prima richiesta lo genera e
// lo congela, le altre servono lo stesso file. Un id che non è un uuid o un rinvio che non c'è (anche di un
// altro studio, letto come l'utente) è 404, mai 403. Nessuna cache; il nome non contiene il paziente.

const NOT_FOUND = "Pagina non trovata";
const referralIdSchema = z.uuid();

function notFound(): Response {
  return new Response(NOT_FOUND, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/rinvii/[id]/pdf">) {
  const { id } = await ctx.params;
  // Prima di toccare il database.
  if (!referralIdSchema.safeParse(id).success) return notFound();

  const requestContext = await getRequestContext();
  let pdf;
  try {
    pdf = await ensureReferralPdf(requestContext, systemClock, getFileStore(), id);
  } catch (error) {
    // La richiesta è valida ma la lettera è cambiata sotto di lei e non si è salvato niente: 409, e il testo
    // lo mostra la pagina. Per nome, non con `instanceof` (errors.ts: un bundle per modulo).
    if (isDomainError(error) && error.message === LETTER_CHANGED) {
      return new Response(LETTER_CHANGED, {
        status: 409,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
      });
    }
    throw error;
  }
  if (!pdf) return notFound();

  return new Response(new Uint8Array(pdf.bytes), {
    headers: {
      "content-type": "application/pdf",
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${pdf.fileName}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
