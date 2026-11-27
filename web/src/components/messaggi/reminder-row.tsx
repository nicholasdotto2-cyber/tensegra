"use client";

import Link from "next/link";
import { type MouseEvent, useEffect, useId, useRef, useState } from "react";

import { prepareMessageAction, recordMessageAction, setMessageOutcomeAction } from "@/app/(app)/pazienti/[id]/message-actions";
import { useContactSnapshot } from "@/components/messaggi/use-contact-snapshot";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { copyThenRecord } from "@/lib/messages/copy";
import { whatsappPhoneProblem } from "@/lib/messages/links";
import { reminderView } from "@/lib/messages/reminder-view";
import { DEMO_NOTICE } from "@/lib/messages/texts";
import { patientHref } from "@/lib/patients/params";
import { cn } from "@/lib/utils";
import type { ReminderBlock } from "@/server/domain/appointments/queries";

// Lo stato e le azioni del promemoria di un appuntamento, nella
// riga di «Promemoria per domani» e nel dettaglio dell'appuntamento. Il server prepara testo, permessi e stato;
// qui l'osteopata copia o apre WhatsApp col testo compilato (per ritoccarlo c'è il compositore) e dichiara se
// l'ha inviato. Copia e apertura non sono mai «Inviato»: la riga parte da confermare, e «Sì» o «No» cambiano
// l'esito di quella riga, senza un secondo evento. Dopo ogni registrazione la pagina si rilegge (revalidate);
// il dettaglio, caricato con un'azione, si rilegge con `onChanged`.

const COPIED = "Messaggio copiato. Incollalo in WhatsApp.";
const COPY_FAILED = "Copia non riuscita: premi Ctrl+C per copiare il testo selezionato.";
const COPY_NOT_LOGGED = "Messaggio copiato, ma non registrato. Riprova a registrarlo.";
const OPEN_NOT_LOGGED = "WhatsApp aperto, ma non registrato. Riprova a registrarlo.";
const MANUAL_LOGGED = "Copia registrata.";
const OUTCOME_FAILED = "Non ho salvato la risposta. Riprova.";

type Attempt = { id: string; action: "copiato" | "whatsapp_aperto"; body: string };
type Log =
  | { attempt: Attempt; state: "saving" | "saved" }
  | { attempt: Attempt; state: "failed" | "refused"; message: string };
type Outcome = { id: string; state: "saving" | "done" } | { id: string; state: "error"; message: string };

export function ReminderRow({
  value,
  onChanged,
}: {
  value: ReminderBlock["rows"][number];
  /** Dopo una riga registrata o un esito dichiarato, per chi non si rilegge con la pagina (il dettaglio). */
  onChanged?: () => void;
}): React.JSX.Element {
  const { lastMessage, statusText } = value;
  const { snapshot, refresh } = useContactSnapshot(JSON.stringify(value.prepared.source), value.prepared, () => prepareMessageAction(value.prepared.source));
  const prepared = snapshot ?? value.prepared;
  const baseId = useId();
  const demoId = `${baseId}-demo`;
  const askId = `${baseId}-domanda`;
  const manualRef = useRef<HTMLTextAreaElement>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<Attempt | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Dopo una copia fallita il testo del riquadro è già selezionato: Ctrl+C basta.
  useEffect(() => {
    if (copyFailed === null) return;
    manualRef.current?.focus();
    manualRef.current?.select();
  }, [copyFailed]);

  const source = prepared.source;
  // Numero, canale o consenso fermano WhatsApp (gli stati prima dello storico): resta la copia organizzativa.
  const blocked = prepared.recipient.whatsappDisabledReason !== null;
  // Domanda, stato e azioni: la regola sta in reminderView, con i suoi test.
  const view = reminderView({
    blocked,
    statusText,
    lastMessage,
    recordedId: log?.state === "saved" ? log.attempt.id : null,
    answer: outcome === null ? null : { id: outcome.id, state: outcome.state },
  });
  const { askId: pendingId } = view;
  const busy = log?.state === "saving";
  const href = prepared.whatsappHref;

  /** true se la riga è registrata. */
  async function record(attempt: Attempt): Promise<boolean> {
    setLog({ attempt, state: "saving" });
    // Solo l'ultimo tentativo aggiorna lo stato: una risposta vecchia non copre quella nuova.
    const apply = (next: Log) => setLog((previous) => (previous?.attempt.id === attempt.id ? next : previous));
    let result: Awaited<ReturnType<typeof recordMessageAction>>;
    try {
      result = await recordMessageAction({ id: attempt.id, source, body: attempt.body, action: attempt.action });
    } catch {
      // La richiesta non è arrivata: si riprova con lo stesso id, senza ricopiare.
      apply({ attempt, state: "failed", message: "" });
      return false;
    }
    if (!result.ok) {
      apply({ attempt, state: result.refused ? "refused" : "failed", message: result.message });
      if (result.refused) {
        setCopyFailed(null);
        setFeedback(null);
        refresh();
      }
      return false;
    }
    apply({ attempt, state: "saved" });
    onChanged?.();
    return true;
  }

  const newAttempt = (action: Attempt["action"]): Attempt => ({ id: crypto.randomUUID(), action, body: prepared.body });

  const onCopy = () => {
    const attempt = newAttempt("copiato");
    setFeedback(null);
    setCopyFailed(null);
    // writeText parte qui, dentro il clic; il registro solo dopo la copia riuscita.
    void copyThenRecord(attempt.body, navigator.clipboard, () => {
      setFeedback(COPIED);
      return record(attempt);
    }).then((result) => {
      if (!result.copied) setCopyFailed(attempt);
    });
  };

  const onOpen = () => {
    // Il vero anchor apre WhatsApp col gesto; il registro parte insieme, senza fermare la navigazione.
    setFeedback(null);
    setCopyFailed(null);
    void record(newAttempt("whatsapp_aperto"));
  };

  const declare = (id: string, value: "inviato" | "non_inviato") => {
    setOutcome({ id, state: "saving" });
    void setMessageOutcomeAction({ id, outcome: value })
      .catch(() => ({ ok: false, message: OUTCOME_FAILED }) as const)
      .then((result) => {
        if (!result.ok) {
          setOutcome({ id, state: "error", message: result.message });
          return;
        }
        // La domanda resta ferma finché la pagina o il dettaglio non portano l'esito (reminderView).
        setOutcome({ id, state: "done" });
        setFeedback(null);
        onChanged?.();
      });
  };

  return (
    <div className="flex flex-col items-start gap-2">
      {pendingId === null ? null : (
        <div role="group" aria-labelledby={askId} className="flex flex-wrap items-center gap-2">
          <span id={askId}>{view.question}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={view.answerLocked}
            onClick={() => declare(pendingId, "inviato")}
          >
            Sì
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={view.answerLocked}
            onClick={() => declare(pendingId, "non_inviato")}
          >
            No
          </Button>
        </div>
      )}
      {!view.showStatus ? null : whatsappPhoneProblem(prepared.recipient.phone) === "Numero mancante" ? (
        <Link
          href={patientHref(prepared.patientId, { tab: "anagrafica" })}
          prefetch={false}
          className="text-sm text-warning-foreground underline decoration-1 underline-offset-4"
        >
          {statusText}
        </Link>
      ) : (
        <p className={cn("text-sm", blocked ? "text-warning-foreground" : "text-muted-foreground")}>{statusText}</p>
      )}
      {outcome?.state === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {outcome.message}
        </p>
      ) : null}

      {snapshot !== null && (view.showCopy || view.showWhatsapp) ? (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          {href === null || !view.showWhatsapp ? null : (
            <div className="flex flex-col gap-1">
              <a
                href={href}
                target="_blank"
                rel="noopener"
                onClick={onOpen}
                // Il clic centrale apre la scheda senza onClick: si registra lo stesso.
                onAuxClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  if (event.button === 1) onOpen();
                }}
                aria-describedby={prepared.recipient.isDemo ? demoId : undefined}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "self-start")}
              >
                Apri WhatsApp
              </a>
              {prepared.recipient.isDemo ? (
                <p id={demoId} className="text-sm text-muted-foreground">
                  {DEMO_NOTICE}
                </p>
              ) : null}
            </div>
          )}
          {view.showCopy ? (
            <Button type="button" variant="outline" size="sm" disabled={!prepared.copyAllowed || busy} onClick={onCopy}>
              Copia
            </Button>
          ) : null}
        </div>
      ) : null}
      {view.showCopy && prepared.copyDisabledReason !== null ? (
        <p className="text-sm text-muted-foreground">{prepared.copyDisabledReason}</p>
      ) : null}

      {copyFailed === null || snapshot === null || !prepared.copyAllowed ? null : (
        <div className="flex w-full flex-col gap-2 rounded-lg border p-3">
          <Label htmlFor={`${baseId}-manuale`}>{COPY_FAILED}</Label>
          <Textarea id={`${baseId}-manuale`} ref={manualRef} readOnly value={copyFailed.body} className="min-h-24" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={busy}
            onClick={() => {
              const attempt = copyFailed;
              setCopyFailed(null);
              void record(attempt).then((saved) => {
                if (saved) setFeedback(MANUAL_LOGGED);
              });
            }}
          >
            Ho copiato il testo
          </Button>
        </div>
      )}

      {log === null || (log.state !== "failed" && log.state !== "refused") ? null : (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm text-destructive">
          {log.state === "failed" ? (
            <>
              {log.attempt.action === "copiato" ? COPY_NOT_LOGGED : OPEN_NOT_LOGGED}
              <Button type="button" variant="outline" size="sm" onClick={() => void record(log.attempt)}>
                Riprova
              </Button>
            </>
          ) : (
            log.message
          )}
        </div>
      )}

      {/* Sempre presente, così il lettore di schermo annuncia i cambi. */}
      <p role="status" className="text-sm">
        {feedback ?? ""}
      </p>
    </div>
  );
}
