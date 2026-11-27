import { ADVICE_MESSAGE_REASON } from "@/lib/messages/texts";
import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { DomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { amendVisit, editVisit } from "@/server/domain/visits/commands";
import { loadVisit } from "@/server/domain/visits/ops";
import type { VisitOp } from "@/server/domain/visits/schemas";

// I consigli preparati come messaggio. Ogni uso del
// modello `consigli` aggiunge `messaggio_copiato` ai consigli scelti, nella transazione della riga del registro. Passa
// dai comandi della visita, mai da un UPDATE diretto: in bozza `editVisit`, sulla visita chiusa `amendVisit` con il
// motivo fisso (un UPDATE sulle figlie di una visita chiusa dà 42501).

type Channel = "a_voce" | "foglio_stampato" | "messaggio_copiato";

/**
 * Chiamata da `recordMessage` dopo il controllo del retry e prima della riga del registro: il retry dello stesso id
 * non arriva qui, quindi non aggiunge rettifiche. Ogni consiglio scelto deve essere della visita e venire da un modello
 * (un consiglio scritto senza modello rifiuta tutto, prima di toccare registro o visita). L'operazione è la `consiglio`
 * esistente, costruita dalla riga letta qui: testo e canali di prima restano, si aggiunge solo il canale. Le righe che
 * lo hanno già non cambiano; se lo hanno tutte, nessuna rettifica.
 */
export async function markAdviceMessagePrepared(
  tx: Tx,
  practiceId: string,
  clock: Clock,
  input: { visitId: string; adviceIds: readonly string[] },
): Promise<void> {
  const visit = await loadVisit(tx, practiceId, input.visitId);
  if (!visit) throw new DomainError(NOT_ALLOWED);
  const ids = [...new Set(input.adviceIds)];
  const rows = await tx.query<{ id: string; templateCode: string | null; text: string; communicatedVia: Channel[] }>(
    `select id, template_code as "templateCode", text, communicated_via as "communicatedVia"
       from public.visit_advice
      where practice_id = $1 and visit_id = $2 and id = any($3::uuid[])
      order by id`,
    [practiceId, visit.id, ids],
  );
  if (ids.length === 0 || rows.length !== ids.length) throw new DomainError(NOT_ALLOWED);
  const ops: VisitOp[] = [];
  for (const row of rows) {
    if (row.templateCode === null) throw new DomainError(NOT_ALLOWED);
    if (row.communicatedVia.includes("messaggio_copiato")) continue;
    ops.push({
      op: "consiglio",
      adviceId: row.id,
      templateCode: row.templateCode,
      text: row.text,
      communicatedVia: [...row.communicatedVia, "messaggio_copiato"],
    });
  }
  if (ops.length === 0) return;
  if (visit.status === "draft") {
    for (const op of ops) await editVisit(tx, practiceId, clock, { visitId: visit.id, op });
    return;
  }
  await amendVisit(tx, practiceId, clock, { visitId: visit.id, reason: ADVICE_MESSAGE_REASON, ops });
}
