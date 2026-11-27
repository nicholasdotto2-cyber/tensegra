"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { setMessageOutcomeAction } from "@/app/(app)/pazienti/[id]/message-actions";
import { Button } from "@/components/ui/button";
import { datetimeAttr, dayField, romeDay, timeOf } from "@/lib/format";
import { MARKED_NOT_SENT, MARKED_SENT, OUTCOME_NOT_SAVED, SENT_QUESTION } from "@/lib/messages/texts";
import type { MessageLogRow } from "@/server/domain/messages/queries";

const TEMPLATE_LABEL = {
  conferma: "Conferma",
  promemoria: "Promemoria",
  spostamento: "Spostamento",
  richiamo: "Richiamo",
  consigli: "Consigli",
};
const OUTCOME_LABEL = { da_confermare: "Da confermare", inviato: "Inviato", non_inviato: "Non inviato" };

function MessageRow({ row, onChanged, outcomeHandled }: { row: MessageLogRow; onChanged?: () => void; outcomeHandled: boolean }) {
  const router = useRouter();
  const questionId = useId();
  const [busy, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const declare = (outcome: "inviato" | "non_inviato") => {
    setError(null);
    setFeedback(null);
    startSaving(async () => {
      try {
        const result = await setMessageOutcomeAction({ id: row.id, outcome });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setFeedback(outcome === "inviato" ? MARKED_SENT : MARKED_NOT_SENT);
        router.refresh();
        onChanged?.();
      } catch {
        setError(OUTCOME_NOT_SAVED);
      }
    });
  };

  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border p-3" data-message-id={row.id}>
      <p className="flex flex-wrap gap-x-2 text-sm">
        <time dateTime={datetimeAttr(row.createdAt)}>{`${dayField(romeDay(row.createdAt))} alle ${timeOf(row.createdAt)}`}</time>
        <span>{TEMPLATE_LABEL[row.templateKey]}</span>
      </p>
      <p className="text-sm">{`A ${row.recipientName}${row.recipientPhone === null ? "" : `, ${row.recipientPhone}`}`}</p>
      <p className="text-sm">{row.action === "copiato" ? "Copiato" : "Aperto in WhatsApp"}</p>
      <p className="text-sm font-medium">
        <span>{OUTCOME_LABEL[row.outcome]}</span>
        {row.outcomeAt === null ? null : (
          <time dateTime={datetimeAttr(row.outcomeAt)}>{` il ${dayField(romeDay(row.outcomeAt))} alle ${timeOf(row.outcomeAt)}`}</time>
        )}
      </p>
      {outcomeHandled ? null : (
        <div role="group" aria-labelledby={questionId} className="flex flex-wrap items-center gap-2 text-sm">
          <span id={questionId}>{SENT_QUESTION}</span>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => declare("inviato")}>
            Sì
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => declare("non_inviato")}>
            No
          </Button>
        </div>
      )}
      <details className="text-sm">
        <summary className="min-h-6 cursor-pointer underline underline-offset-4">Testo del messaggio</summary>
        <p className="whitespace-pre-wrap break-words pt-2">{row.body}</p>
      </details>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      )}
      <p role="status" className="text-sm">{feedback ?? ""}</p>
    </li>
  );
}

/** Stesso registro in scheda, riepilogo e dettaglio: il corpo è congelato, solo l'esito si rettifica. */
export function MessagesTabView({ rows, onChanged, outcomeHandledId, emptyText = "Nessun messaggio preparato per questo paziente." }: {
  rows: MessageLogRow[];
  onChanged?: () => void;
  /** La riga che ha già Sì/No nel promemoria del dettaglio: qui resta visibile solo lo stato. */
  outcomeHandledId?: string;
  emptyText?: string;
}): React.JSX.Element {
  if (rows.length === 0) return <p>{emptyText}</p>;
  return (
    <ul aria-label="Cronologia messaggi" className="flex min-w-0 flex-col gap-3">
      {rows.map((row) => <MessageRow key={row.id} row={row} onChanged={onChanged} outcomeHandled={row.id === outcomeHandledId} />)}
    </ul>
  );
}
