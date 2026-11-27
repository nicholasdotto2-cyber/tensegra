"use client";

import Link from "next/link";
import { type MouseEvent, useEffect, useId, useRef, useState } from "react";

import {
  prepareMessageAction,
  recordMessageAction,
  setMessageOutcomeAction,
} from "@/app/(app)/pazienti/[id]/message-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { copyThenRecord } from "@/lib/messages/copy";
import { whatsappHref } from "@/lib/messages/links";
import type { TemplateKey } from "@/lib/messages/templates";
import {
  COPY_FAILED,
  COPY_NOT_LOGGED,
  DEMO_NOTICE,
  MANUAL_LOGGED,
  MARKED_NOT_SENT,
  MARKED_SENT,
  MESSAGE_COPIED as COPIED,
  MESSAGE_MAX,
  MESSAGE_TOO_LONG,
  messageLength,
  OPEN_NOT_LOGGED,
  OUTCOME_NOT_SAVED,
  SENT_QUESTION,
} from "@/lib/messages/texts";
import { cn } from "@/lib/utils";
import type { PreparedMessage } from "@/server/domain/messages/queries";
import type { MessageSource } from "@/server/domain/messages/schemas";

// Il compositore di un messaggio. Il server prepara testo e permessi;
// qui l'osteopata ritocca il testo, lo copia o apre WhatsApp, e dichiara se l'ha inviato. Nessun invio:
// una copia o un'apertura non sono mai «Inviato». Ogni tentativo ha il suo id, riusato nel retry del solo
// registro, così un registro fallito non chiede di ricopiare e non duplica la riga.

const TEMPLATE_NAMES: Record<TemplateKey, string> = {
  conferma: "Conferma",
  promemoria: "Promemoria",
  spostamento: "Spostamento",
  richiamo: "Richiamo",
  consigli: "Consigli",
};
const EMPTY = "Scrivi il testo del messaggio.";
const NOT_FOUND = "Questo messaggio non si può più preparare.";

type Attempt = { id: string; action: "copiato" | "whatsapp_aperto"; body: string };
type Log =
  | { attempt: Attempt; state: "saving" | "saved" }
  | { attempt: Attempt; state: "failed" | "refused"; message: string };
type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "missing" }
  | { kind: "ready"; prepared: PreparedMessage };

function newAttempt(action: Attempt["action"], body: string): Attempt {
  return { id: crypto.randomUUID(), action, body };
}

/** Il link del testo finale, solo se il server ammette WhatsApp per questa sorgente e il testo va bene. */
function linkFor(prepared: PreparedMessage, body: string, copyReason: string | null): string | null {
  if (copyReason !== null || prepared.recipient.whatsappDisabledReason !== null) return null;
  // Il server non dà il link se il testo compilato è troppo lungo: accorciato a mano, il permesso resta il suo.
  if (prepared.whatsappHref === null && prepared.copyDisabledCode !== "troppo_lungo") return null;
  try {
    return whatsappHref(prepared.recipient, body);
  } catch {
    return null;
  }
}

function ComposerBody({
  source,
  onRecorded,
}: {
  source: MessageSource;
  onRecorded?: (id: string) => void;
}) {
  const baseId = useId();
  const textId = `${baseId}-testo`;
  const countId = `${baseId}-conteggio`;
  const lengthErrorId = `${baseId}-lunghezza`;
  const demoId = `${baseId}-demo`;
  const waReasonId = `${baseId}-whatsapp`;
  const manualRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<HTMLAnchorElement>(null);

  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  // Il testo ritoccato vince sulle risposte che arrivano dopo («ritocco_durante_preview»).
  const [draft, setDraft] = useState<{ body: string; edited: boolean }>({ body: "", edited: false });
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<Attempt | null>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [outcome, setOutcome] = useState<{ state: "saving" | "inviato" | "non_inviato" } | { state: "error"; message: string } | null>(null);
  const reload = () => setReloads((n) => n + 1);

  useEffect(() => {
    let current = true;
    const failed = { ok: false, message: "Non riesco a preparare il messaggio. Riprova." } as const;
    void prepareMessageAction(source).catch(() => failed).then((result) => {
      if (!current) return;
      if (!result.ok) {
        // Un errore di una rilettura non toglie il messaggio già mostrato.
        setLoaded((previous) => (previous.kind === "ready" ? previous : { kind: "error", message: result.message }));
        return;
      }
      if (result.data === null) {
        setLoaded({ kind: "missing" });
        return;
      }
      const prepared = result.data;
      setLoaded({ kind: "ready", prepared });
      setDraft((previous) => (previous.edited ? previous : { body: prepared.body, edited: false }));
    });
    return () => {
      current = false;
    };
  }, [source, reloads]);

  // Al ritorno sulla scheda (dopo WhatsApp o un'altra finestra) consenso, canale e numero si rileggono.
  useEffect(() => {
    const onFocus = () => setReloads((n) => n + 1);
    const onVisible = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Dopo una copia fallita il testo del riquadro è già selezionato: Ctrl+C basta.
  useEffect(() => {
    if (copyFailed === null) return;
    manualRef.current?.focus();
    manualRef.current?.select();
  }, [copyFailed]);

  /** true se la riga è registrata. */
  async function record(attempt: Attempt): Promise<boolean> {
    setLog({ attempt, state: "saving" });
    // Solo l'ultimo tentativo aggiorna lo stato: una risposta vecchia non copre quella nuova.
    const apply = (next: Log) => setLog((previous) => (previous?.attempt.id === attempt.id ? next : previous));
    let result: Awaited<ReturnType<typeof recordMessageAction>>;
    try {
      result = await recordMessageAction({ id: attempt.id, source, body: attempt.body, action: attempt.action });
    } catch {
      // La richiesta non è arrivata (server fermo, rete): si riprova con lo stesso id.
      apply({ attempt, state: "failed", message: "" });
      return false;
    }
    if (result.ok) {
      apply({ attempt, state: "saved" });
      onRecorded?.(result.data.id);
      return true;
    }
    apply({ attempt, state: result.refused ? "refused" : "failed", message: result.message });
    // Un rifiuto dice che permessi o dati sono cambiati: l'anteprima si rilegge.
    if (result.refused) reload();
    return false;
  }

  if (loaded.kind === "loading") {
    return (
      <p role="status" className="text-muted-foreground">
        Preparo il messaggio.
      </p>
    );
  }
  if (loaded.kind === "missing") return <p>{NOT_FOUND}</p>;
  if (loaded.kind === "error") {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-col items-start gap-2">
          {loaded.message}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setLoaded({ kind: "loading" });
              reload();
            }}
          >
            Riprova
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const { prepared } = loaded;
  const body = draft.body;
  const length = messageLength(body);
  const tooLong = length > MESSAGE_MAX;
  // Il motivo del server (modello non valido, consenso del modello) vale anche per il testo ritoccato.
  const serverReason = prepared.copyDisabledCode === "non_ammesso" ? prepared.copyDisabledReason : null;
  const copyReason = serverReason ?? (tooLong ? MESSAGE_TOO_LONG : body.trim() === "" ? EMPTY : null);
  const href = linkFor(prepared, body, copyReason);
  const waReason = href === null ? (serverReason ?? prepared.recipient.whatsappDisabledReason ?? copyReason) : null;
  const busy = log?.state === "saving";
  // Dopo ogni riga registrata, copia o apertura: l'esito lo dichiara l'osteopata («Da confermare»).
  const askSent = log?.state === "saved";

  const onCopy = () => {
    const attempt = newAttempt("copiato", body);
    setFeedback(null);
    setCopyFailed(null);
    setOutcome(null);
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
    const attempt = newAttempt("whatsapp_aperto", body);
    setFeedback(null);
    setCopyFailed(null);
    setOutcome(null);
    void record(attempt);
  };

  const declare = (value: "inviato" | "non_inviato") => {
    if (log?.state !== "saved") return;
    const { id } = log.attempt;
    setOutcome({ state: "saving" });
    void setMessageOutcomeAction({ id, outcome: value })
      .catch(() => ({ ok: false, message: OUTCOME_NOT_SAVED }) as const)
      .then((result) => {
        setOutcome(result.ok ? { state: value } : { state: "error", message: result.message });
      });
  };

  const describedBy = [countId, tooLong ? lengthErrorId : null].filter(Boolean).join(" ");

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground">{`A ${prepared.recipient.name}`}</p>
      {prepared.missing.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {prepared.missing.map((item) => (
            <li key={item.key}>
              <Link href={item.href} prefetch={false} className="text-warning-foreground underline decoration-1 underline-offset-4">
                {item.message}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {serverReason === null ? null : (
        <Alert className="border-transparent bg-warning text-warning-foreground">
          <AlertDescription className="text-warning-foreground">{serverReason}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={textId}>Testo del messaggio</Label>
        <Textarea
          ref={textRef}
          id={textId}
          value={body}
          onChange={(event) => {
            setDraft({ body: event.target.value, edited: true });
            // Esito e domanda parlano del testo di allora: spariscono quando il testo cambia. Un registro fallito
            // resta, perché il suo retry riusa il testo copiato.
            setFeedback(null);
            setOutcome(null);
            setLog((previous) => (previous?.state === "refused" || previous?.state === "saved" ? null : previous));
          }}
          aria-invalid={tooLong ? true : undefined}
          aria-describedby={describedBy}
          className="min-h-40"
        />
        <p id={countId} className={cn("text-sm tabular-nums text-muted-foreground", tooLong && "text-destructive")}>
          {`${length} di ${MESSAGE_MAX} caratteri`}
        </p>
        {tooLong ? (
          <p id={lengthErrorId} className="text-sm text-destructive">
            {MESSAGE_TOO_LONG}
          </p>
        ) : null}
      </div>

      {copyFailed === null ? null : (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <Label htmlFor={`${baseId}-manuale`}>{COPY_FAILED}</Label>
          <Textarea id={`${baseId}-manuale`} ref={manualRef} readOnly value={copyFailed.body} className="min-h-24" />
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={busy}
            onClick={() => {
              const attempt = copyFailed;
              // Il pulsante sparisce: il focus passa al controllo successivo, non al corpo della pagina.
              const next = anchorRef.current ?? (copyRef.current?.disabled ? null : copyRef.current) ?? textRef.current;
              next?.focus();
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

      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Button ref={copyRef} type="button" disabled={copyReason !== null} onClick={onCopy}>
          Copia
        </Button>
        {href === null ? (
          <div className="flex flex-col gap-1">
            <Button type="button" variant="outline" disabled aria-describedby={waReason === null ? undefined : waReasonId}>
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
              ref={anchorRef}
              href={href}
              target="_blank"
              rel="noopener"
              onClick={onOpen}
              // Il clic centrale apre la scheda senza onClick: si registra lo stesso. «Apri in una nuova scheda» dal
              // menu del browser non manda eventi alla pagina.
              onAuxClick={(event: MouseEvent<HTMLAnchorElement>) => {
                if (event.button === 1) onOpen();
              }}
              aria-describedby={prepared.recipient.isDemo ? demoId : undefined}
              className={cn(buttonVariants({ variant: "outline" }), "self-start")}
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
      </div>

      {/* Sempre presente, così il lettore di schermo annuncia i cambi. */}
      <p role="status" className="text-sm">
        {feedback ?? ""}
      </p>

      {log === null || (log.state !== "failed" && log.state !== "refused") ? null : (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-2">
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
          </AlertDescription>
        </Alert>
      )}

      {askSent ? (
        <div role="group" aria-labelledby={`${baseId}-domanda`} className="flex flex-wrap items-center gap-2">
          <span id={`${baseId}-domanda`}>{SENT_QUESTION}</span>
          <Button type="button" variant="outline" size="sm" disabled={outcome?.state === "saving"} onClick={() => declare("inviato")}>
            Sì
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={outcome?.state === "saving"} onClick={() => declare("non_inviato")}>
            No
          </Button>
          {outcome === null || outcome.state === "saving" ? null : (
            <span role="status">
              {outcome.state === "error"
                ? outcome.message
                : outcome.state === "inviato"
                  ? MARKED_SENT
                  : MARKED_NOT_SENT}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function MessageComposer({
  source,
  onClose,
  onRecorded,
}: {
  /** La sorgente del messaggio; null tiene chiuso il compositore. */
  source: MessageSource | null;
  onClose: () => void;
  onRecorded?: (id: string) => void;
}): React.JSX.Element {
  // Mentre si chiude il dialogo tiene il suo contenuto.
  const [shown, setShown] = useState<MessageSource | null>(source);
  const key = shown === null ? "" : JSON.stringify(shown);
  // Confronto per contenuto: un oggetto nuovo con la stessa sorgente non rilegge l'anteprima.
  if (source !== null && JSON.stringify(source) !== key) setShown(source);
  return (
    <Dialog
      open={source !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Prepara il messaggio</DialogTitle>
          <DialogDescription>{shown === null ? "" : TEMPLATE_NAMES[shown.templateKey]}</DialogDescription>
        </DialogHeader>
        {/* Una sorgente nuova riparte da zero: testo, tentativo e registro sono di quel messaggio. */}
        {shown === null ? null : <ComposerBody key={key} source={shown} onRecorded={onRecorded} />}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Chiudi
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
