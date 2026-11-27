"use client";

import { ChevronDown, Ellipsis } from "lucide-react";
import { type MouseEvent, useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { prepareMessageAction, setMessageOutcomeAction, recordMessageAction } from "@/app/(app)/pazienti/[id]/message-actions";
import { useContactSnapshot } from "@/components/messaggi/use-contact-snapshot";
import { pauseRecallAction, snoozeRecallAction } from "@/app/(app)/pazienti/[id]/actions";
import { NewAppointmentButton, type ServiceOption } from "@/components/agenda/appointment-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { dayField } from "@/lib/format";
import { copyThenRecord } from "@/lib/messages/copy";
import {
  COPY_FAILED,
  COPY_NOT_LOGGED,
  DEMO_NOTICE,
  MANUAL_LOGGED,
  MARKED_NOT_SENT,
  MARKED_SENT,
  MESSAGE_COPIED,
  OPEN_NOT_LOGGED,
  OUTCOME_NOT_SAVED,
  SENT_QUESTION,
} from "@/lib/messages/texts";
import { cn } from "@/lib/utils";
import type { RecallRow } from "@/server/domain/patients/queries";

// Una riga «Da richiamare» con le sue azioni, uguale in Oggi e in Pazienti:
// «Apri WhatsApp» (il vero link, con l'avviso della demo accanto), «Copia», «Fissa appuntamento» e il menu con
// «Rimanda di 2 settimane» e «Sospendi i richiami». Il testo del richiamo l'ha preparato il server; copia e
// apertura si registrano come nel compositore e l'invio lo dichiara l'osteopata con «Sì». Il gruppo senza
// consenso ai richiami non ha azioni: nome, scadenza e la ragione.

export interface RecallBooking {
  services: readonly ServiceOption[];
  defaultIntervalWeeks: number;
  defaultExpectedSessions: number;
}

type Attempt = { id: string; action: "copiato" | "whatsapp_aperto"; body: string };
type Log = { attempt: Attempt; state: "saving" | "saved" } | { attempt: Attempt; state: "failed"; message: string };
type Outcome = { state: "saving" | "inviato" | "non_inviato" } | { state: "error"; message: string };

// "20/10" da "20/10/2026".
const dayMonth = (day: string): string => dayField(day).slice(0, 5);

/** Ultima seduta e cadenza: «Ultima seduta 20/10, ogni 8 settimane». */
function lastSessionText(row: RecallRow): string {
  return `Ultima seduta ${dayMonth(row.lastDoneDay)}, ogni ${row.cadenceWeeks} settimane`;
}

/** L'annuncio fuori dalla riga, che dopo «Sì» può uscire dalle righe mostrate. */
function outcomeAnnouncement(name: string, value: "inviato" | "non_inviato"): string {
  return `Richiamo di ${name}: ${value === "inviato" ? "segnato come inviato." : "segnato come non inviato."}`;
}

/**
 * Copia, apertura di WhatsApp e «Hai inviato il messaggio?» del richiamo preparato. Con `onOutcome` la risposta
 * salvata si annuncia fuori dalla riga, perché dopo «Sì» la riga va in fondo e in Oggi può uscire dalle 5
 * mostrate; un errore resta nella riga, che allora non si è spostata.
 */
function ContactActions({ row, onOutcome }: { row: RecallRow; onOutcome?: (text: string) => void }) {
  const { snapshot: contact, pending, refresh } = useContactSnapshot(row.patientId, row.contact, () => prepareMessageAction({ kind: "recall", patientId: row.patientId, templateKey: "richiamo" }));
  const baseId = useId();
  const demoId = `${baseId}-demo`;
  const waReasonId = `${baseId}-whatsapp`;
  const copyReasonId = `${baseId}-copia`;
  const manualRef = useRef<HTMLTextAreaElement>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<Attempt | null>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Dopo una copia fallita il testo del riquadro è già selezionato: Ctrl+C basta.
  useEffect(() => {
    if (copyFailed === null) return;
    manualRef.current?.focus();
    manualRef.current?.select();
  }, [copyFailed]);

  // Senza messaggio preparato non ci sono azioni; in rilettura spariscono solo link e copia, la domanda resta.
  if (contact === null && !pending) return null;
  const href = contact?.whatsappHref ?? null;
  const waReason = contact !== null && href === null ? (contact.copyDisabledReason ?? contact.recipient.whatsappDisabledReason) : null;

  async function record(attempt: Attempt): Promise<boolean> {
    setLog({ attempt, state: "saving" });
    // Solo l'ultimo tentativo aggiorna lo stato: una risposta vecchia non copre quella nuova.
    const apply = (next: Log) => setLog((previous) => (previous?.attempt.id === attempt.id ? next : previous));
    const result = await recordMessageAction({
      id: attempt.id,
      source: { kind: "recall", patientId: row.patientId, templateKey: "richiamo" },
      body: attempt.body,
      action: attempt.action,
    }).catch(() => ({ ok: false, message: "" }) as const);
    if (result.ok) {
      apply({ attempt, state: "saved" });
      return true;
    }
    apply({ attempt, state: "failed", message: result.message });
    if ("refused" in result && result.refused) {
      setCopyFailed(null);
      setFeedback(null);
      refresh();
    }
    return false;
  }

  const reset = () => {
    setFeedback(null);
    setCopyFailed(null);
    setOutcome(null);
  };

  const onCopy = () => {
    if (contact === null) return;
    const attempt: Attempt = { id: crypto.randomUUID(), action: "copiato", body: contact.body };
    reset();
    // writeText parte qui, dentro il clic; il registro solo dopo la copia riuscita.
    void copyThenRecord(attempt.body, navigator.clipboard, () => {
      setFeedback(MESSAGE_COPIED);
      return record(attempt);
    }).then((result) => {
      if (!result.copied) setCopyFailed(attempt);
    });
  };

  const onOpen = () => {
    // Il vero anchor apre WhatsApp col gesto; il registro parte insieme, senza fermare la navigazione.
    if (contact === null) return;
    reset();
    void record({ id: crypto.randomUUID(), action: "whatsapp_aperto", body: contact.body });
  };

  const declare = (value: "inviato" | "non_inviato") => {
    if (log?.state !== "saved") return;
    setOutcome({ state: "saving" });
    void setMessageOutcomeAction({ id: log.attempt.id, outcome: value })
      .catch(() => ({ ok: false, message: OUTCOME_NOT_SAVED }) as const)
      .then((result) => {
        setOutcome(result.ok ? { state: value } : { state: "error", message: result.message });
        if (result.ok) onOutcome?.(outcomeAnnouncement(row.name, value));
      });
  };

  return (
    <div className="flex flex-col gap-2">
      {contact === null ? null : (
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        {href === null ? (
          <div className="flex flex-col gap-1">
            <Button type="button" variant="outline" size="sm" disabled aria-describedby={waReason === null ? undefined : waReasonId}>
              Apri WhatsApp
            </Button>
            {waReason === null ? null : (
              <p id={waReasonId} className="text-sm text-muted-foreground">
                {waReason}
              </p>
            )}
          </div>
        ) : (
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
              aria-describedby={contact.recipient.isDemo ? demoId : undefined}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "self-start")}
            >
              Apri WhatsApp
            </a>
            {contact.recipient.isDemo ? (
              <p id={demoId} className="text-sm text-muted-foreground">
                {DEMO_NOTICE}
              </p>
            ) : null}
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!contact.copyAllowed || log?.state === "saving"}
            aria-describedby={contact.copyAllowed ? undefined : copyReasonId}
            onClick={onCopy}
          >
            Copia
          </Button>
          {contact.copyAllowed ? null : (
            <p id={copyReasonId} className="text-sm text-muted-foreground">
              {contact.copyDisabledReason}
            </p>
          )}
        </div>
      </div>
      )}

      {copyFailed === null || contact === null || !contact.copyAllowed ? null : (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <Label htmlFor={`${baseId}-manuale`}>{COPY_FAILED}</Label>
          <Textarea id={`${baseId}-manuale`} ref={manualRef} readOnly value={copyFailed.body} className="min-h-24" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
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

      {/* Sempre presente, così il lettore di schermo annuncia i cambi. */}
      <p role="status" className="text-sm">
        {feedback ?? ""}
      </p>

      {log?.state === "failed" ? (
        <div className="flex flex-col items-start gap-2 text-sm text-destructive">
          {log.message !== "" ? log.message : log.attempt.action === "copiato" ? COPY_NOT_LOGGED : OPEN_NOT_LOGGED}
          <Button type="button" variant="outline" size="sm" onClick={() => void record(log.attempt)}>
            Riprova
          </Button>
        </div>
      ) : null}

      {log?.state === "saved" ? (
        <div role="group" aria-labelledby={`${baseId}-domanda`} className="flex flex-wrap items-center gap-2">
          <span id={`${baseId}-domanda`}>{SENT_QUESTION}</span>
          <Button type="button" variant="outline" size="sm" disabled={outcome?.state === "saving"} onClick={() => declare("inviato")}>
            Sì
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={outcome?.state === "saving"} onClick={() => declare("non_inviato")}>
            No
          </Button>
          {outcome === null || outcome.state === "saving" || (onOutcome !== undefined && outcome.state !== "error") ? null : (
            <span role="status">
              {outcome.state === "error" ? outcome.message : outcome.state === "inviato" ? MARKED_SENT : MARKED_NOT_SENT}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** «Rimanda di 2 settimane» e «Sospendi i richiami»: la riga esce dalla lista dopo il salvataggio. */
function RecallMenu({ row }: { row: RecallRow }) {
  const [pending, startPending] = useTransition();
  const run = (action: (patientId: string) => ReturnType<typeof snoozeRecallAction>, done: string) => {
    startPending(async () => {
      const result = await action(row.patientId);
      if (result.ok) toast.success(done);
      else toast.error(result.message);
    });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="outline" size="icon-sm" aria-label={`Altre azioni del richiamo di ${row.name}`} />}
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem disabled={pending} onClick={() => run(snoozeRecallAction, "Richiamo rimandato di 2 settimane.")}>
          Rimanda di 2 settimane
        </DropdownMenuItem>
        <DropdownMenuItem disabled={pending} onClick={() => run(pauseRecallAction, "Richiami sospesi.")}>
          Sospendi i richiami
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Le azioni di una riga in regola: messaggio, appuntamento e menu. */
export function RecallActions({
  row,
  booking,
  onOutcome,
}: {
  row: RecallRow;
  booking: RecallBooking;
  onOutcome?: (text: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <ContactActions row={row} onOutcome={onOutcome} />
      <div className="flex flex-wrap items-center gap-2">
        <NewAppointmentButton {...booking} label="Fissa appuntamento" variant="outline" prefill={{ patientId: row.patientId }} />
        <RecallMenu row={row} />
      </div>
    </div>
  );
}

/** Una riga in regola di Oggi: in attesa di risposta è attenuata (e sta in fondo, lo decide `listRecalls`). */
function RecallItem({
  row,
  booking,
  onOutcome,
}: {
  row: RecallRow;
  booking: RecallBooking;
  onOutcome: (text: string) => void;
}): React.JSX.Element {
  const waiting = row.waitingUntil !== null;
  return (
    <li className="flex flex-col gap-0.5 py-3 first:pt-0 last:pb-0">
      <span className={cn("font-medium", waiting && "text-muted-foreground")}>{row.name}</span>
      <span className="text-sm text-muted-foreground">{row.dueText}</span>
      <span className="text-sm text-muted-foreground">{lastSessionText(row)}</span>
      {row.waitingText === null ? null : <span className="text-sm text-muted-foreground">{row.waitingText}</span>}
      <div className="pt-2">
        <RecallActions row={row} booking={booking} onOutcome={onOutcome} />
      </div>
    </li>
  );
}

/**
 * Le righe mostrate in Oggi, con la regione che annuncia la risposta a «Hai inviato il messaggio?»: resta anche
 * quando la riga, ora in attesa, esce dalle righe mostrate.
 */
export function RecallList({ rows, booking }: { rows: readonly RecallRow[]; booking: RecallBooking }): React.JSX.Element {
  const [announcement, setAnnouncement] = useState("");
  return (
    <>
      <ul className="divide-y">
        {rows.map((row) => (
          <RecallItem key={row.patientId} row={row} booking={booking} onOutcome={setAnnouncement} />
        ))}
      </ul>
      {/* Sempre presente, così il lettore di schermo annuncia i cambi. */}
      <p role="status" aria-label="Esito del richiamo" className="text-sm">
        {announcement}
      </p>
    </>
  );
}

/** Il gruppo chiuso «Senza consenso ai richiami (1)»: nessuna azione, la ragione sotto il nome. */
export function WithoutConsentGroup({ rows }: { rows: readonly RecallRow[] }): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <Collapsible className="flex flex-col gap-2 border-t pt-3">
      <CollapsibleTrigger
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "group/trigger -ml-2.5 w-fit justify-start")}
      >
        {`Senza consenso ai richiami (${rows.length})`}
        <ChevronDown
          aria-hidden="true"
          className="transition-transform group-data-[panel-open]/trigger:rotate-180 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.patientId} className="flex flex-col gap-0.5 py-3 first:pt-0 last:pb-0">
              <span className="font-medium">{row.name}</span>
              <span className="text-sm text-muted-foreground">{row.dueText}</span>
              <span className="text-sm text-muted-foreground">{lastSessionText(row)}</span>
              {row.withoutConsentReason === null ? null : <span className="text-sm">{row.withoutConsentReason}</span>}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
