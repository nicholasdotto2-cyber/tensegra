"use client";

import { Ban, FileWarning } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useEffectEvent, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  appointmentDetailAction,
  markConfirmedAction,
  markDoneAction,
  markSkippedAction,
  restoreAppointmentAction,
  undoDoneAction,
  undoSkippedAction,
} from "@/app/(app)/agenda/actions";
import { STATUS_ICON } from "@/components/agenda/appointment-block";
import { AppointmentDialog, type ServiceOption } from "@/components/agenda/appointment-dialog";
import { CancelDialog } from "@/components/agenda/cancel-dialog";
import { DeleteDialog } from "@/components/agenda/delete-dialog";
import { DoneConfirm } from "@/components/agenda/done-confirm";
import { OpenVisitButton } from "@/components/cartella/open-visit";
import { ConsentCollectDialog } from "@/components/consensi/collect-dialog";
import { MessageComposer } from "@/components/messaggi/message-composer";
import { ReminderRow } from "@/components/messaggi/reminder-row";
import { MessagesTabView } from "@/components/pazienti/messages-tab";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { overlapWarning } from "@/lib/agenda/slots";
import { ACTION_LABEL, type AppointmentAction, STATUS_LABEL } from "@/lib/agenda/status";
import { money } from "@/lib/format";
import { patientHref } from "@/lib/patients/params";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/server/actions/result";
import type { AppointmentDetail } from "@/server/domain/appointments/queries";
import type { ConsentTarget } from "@/server/domain/consents/schemas";

// Il dettaglio dell'appuntamento: un pannello laterale caricato con
// un'azione di sola lettura, aperto da un blocco dell'agenda. Paziente (il nome è il link alla scheda),
// prestazione, data, orario e durata, ciclo e "Seduta N di M", stato, prezzo, note, la visita ("Apri
// la visita" anche prima del "fatto"), il consenso del ciclo solo se manca (con «Consenso revocato il 20/10» se una
// revoca lo decide, e «Raccogli ora» che apre il dialogo di raccolta sopra il pannello), i passi del pannello "Seduta
// fatta" per un fatto, la fattura della seduta («Fattura 273/2026» col link al dettaglio,
// o «Bozza di fattura» col link alle bozze), il promemoria per un appuntamento fra quelli di domani
// (la stessa riga di Oggi, con «Prepara il promemoria» per ritoccare il testo nel compositore) e le azioni ammesse
// della tabella degli stati con le loro etichette. Domanda, annullamento, eliminazione e modifica si aprono da qui; il pannello
// "Seduta fatta" lo apre `AgendaView` con `onMarkedDone`.

const CONSENT_MISSING = "Manca il consenso al trattamento per questo ciclo.";

/** "2 passi su 3", per 1 «1 passo su 3». */
function stepsText(done: number): string {
  return `${done} ${done === 1 ? "passo" : "passi"} su 3`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function DetailBody({
  detail,
  busy,
  onAction,
  onPrepareMessage,
  onReminderChanged,
  onCollect,
}: {
  detail: AppointmentDetail;
  busy: boolean;
  onAction: (action: AppointmentAction) => void;
  /** Apre il compositore del promemoria. */
  onPrepareMessage: () => void;
  /** Una riga registrata o un esito dichiarato dalla riga del promemoria: il dettaglio si rilegge. */
  onReminderChanged: () => void;
  /** «Raccogli ora»: apre il dialogo di raccolta sul bersaglio del server. */
  onCollect: (target: ConsentTarget) => void;
}) {
  const StatusIcon = STATUS_ICON[detail.status];
  const startAttr = `${detail.edit.day}T${detail.edit.time}`;
  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      {detail.consentMissing ? (
        // Un consenso revocato o rifiutato blocca il trattamento: stile distruttivo; uno che manca soltanto, avviso.
        <Alert
          variant={detail.consentBlockText === null ? "default" : "destructive"}
          className={detail.consentBlockText === null ? "border-transparent bg-warning text-warning-foreground" : undefined}
        >
          {detail.consentBlockText === null ? <FileWarning aria-hidden="true" /> : <Ban aria-hidden="true" />}
          <AlertDescription
            className={cn("flex flex-col items-start gap-2", detail.consentBlockText === null && "text-warning-foreground")}
          >
            {detail.consentRevocationText === null ? null : <span>{detail.consentRevocationText}</span>}
            <span>{detail.consentBlockText ?? CONSENT_MISSING}</span>
            {detail.consentTarget === null ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (detail.consentTarget !== null) onCollect(detail.consentTarget);
                }}
              >
                Raccogli ora
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      <dl className="flex flex-col gap-2">
        <Row label="Prestazione">{detail.serviceName}</Row>
        {/* Data e orario in `<time>` con data e ora di Roma dell'inizio, come le righe di Oggi. */}
        <Row label="Data">
          <time dateTime={startAttr}>{detail.dayText}</time>
        </Row>
        <Row label="Orario">
          <span className="tabular-nums">
            <time dateTime={startAttr}>{detail.timeText}</time>
            {` · ${detail.durationText}`}
          </span>
        </Row>
        <Row label="Ciclo">
          {detail.sessionLabel === null ? detail.cycleTitle : `${detail.cycleTitle} · ${detail.sessionLabel}`}
        </Row>
        <Row label="Stato">
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="flex items-center gap-1">
              <StatusIcon aria-hidden="true" className="size-4 shrink-0" />
              {STATUS_LABEL[detail.status]}
            </span>
            {detail.stepsDone === null ? null : (
              <span className="text-muted-foreground">{stepsText(detail.stepsDone)}</span>
            )}
          </span>
        </Row>
        <Row label="Prezzo concordato">
          <span className="tabular-nums">{money(detail.priceCents)}</span>
        </Row>
        {detail.notes === null ? null : <Row label="Note">{detail.notes}</Row>}
        {detail.visit === null && !detail.canOpenVisit ? null : (
          <Row label="Visita">
            {detail.visit === null ? (
              <OpenVisitButton appointmentId={detail.id} label="Apri la visita" variant="outline" />
            ) : (
              <Link
                href={`/pazienti/${detail.patientId}/visite/${detail.visit.id}`}
                prefetch={false}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                {detail.visit.status === "draft" ? "Apri la visita" : "Vedi la visita"}
              </Link>
            )}
          </Row>
        )}
        {detail.invoice === null ? null : (
          <Row label="Fattura">
            <Link
              href={detail.invoice.numberLabel === null ? "/fatture?tab=bozze" : `/fatture/${detail.invoice.id}`}
              prefetch={false}
              className="underline decoration-1 underline-offset-4"
            >
              {detail.invoice.numberLabel === null ? "Bozza di fattura" : `Fattura ${detail.invoice.numberLabel}`}
            </Link>
          </Row>
        )}
        {detail.reminder === null ? null : (
          <Row label="Promemoria">
            <div className="flex flex-col items-start gap-2">
              <ReminderRow value={detail.reminder} onChanged={onReminderChanged} />
              <Button type="button" variant="outline" size="sm" onClick={onPrepareMessage}>
                Prepara il promemoria
              </Button>
            </div>
          </Row>
        )}
      </dl>
      <section aria-label="Messaggi dell'appuntamento" className="flex flex-col gap-2">
        <h3 className="font-medium">{"Messaggi dell'appuntamento"}</h3>
        <MessagesTabView
          rows={detail.messages}
          onChanged={onReminderChanged}
          outcomeHandledId={detail.reminder?.lastMessage?.outcome === "da_confermare" ? detail.reminder.lastMessage.id : undefined}
          emptyText="Nessun messaggio preparato per questo appuntamento."
        />
      </section>
      {detail.actions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {detail.actions.map((action) => (
            <Button
              key={action}
              type="button"
              variant={action === "segna_fatta" ? "default" : action === "elimina" ? "destructive" : "outline"}
              disabled={busy}
              onClick={() => onAction(action)}
            >
              {ACTION_LABEL[action]}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AppointmentDetailSheet({
  appointmentId,
  onClose,
  onMarkedDone,
  services,
  defaultIntervalWeeks,
  defaultExpectedSessions,
}: {
  /** L'appuntamento del blocco scelto; null tiene chiuso il pannello. */
  appointmentId: string | null;
  onClose: () => void;
  /** "Segna come fatta" è andato a buon fine: chi monta il dettaglio apre il pannello "Seduta fatta". */
  onMarkedDone?: (id: string) => void;
  services: readonly ServiceOption[];
  defaultIntervalWeeks: number;
  defaultExpectedSessions: number;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<AppointmentDetail | null>(null);
  const [reloads, setReloads] = useState(0);
  const [askDone, setAskDone] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  // L'appuntamento del compositore aperto: un altro appuntamento non lo eredita.
  const [composingFor, setComposingFor] = useState<{ id: string; templateKey: "promemoria" | "spostamento" } | null>(null);
  const [movedFor, setMovedFor] = useState<string | null>(null);
  // Il bersaglio del clic: la rilettura del dettaglio dopo la firma non chiude il dialogo, che può dover rifare il PDF.
  const [collecting, setCollecting] = useState<ConsentTarget | null>(null);
  const [busy, startBusy] = useTransition();
  const reload = () => setReloads((n) => n + 1);
  // Un appuntamento eliminato in un'altra finestra non ha più dettaglio.
  const closeMissing = useEffectEvent(() => onClose());

  useEffect(() => {
    if (appointmentId === null) return;
    let current = true;
    void appointmentDetailAction(appointmentId).then((result) => {
      if (!current) return;
      if (!result.ok) toast.error(result.message);
      else if (result.data === null) closeMissing();
      else setDetail(result.data);
    });
    return () => {
      current = false;
    };
  }, [appointmentId, reloads]);

  // Mentre si chiude il pannello tiene il suo contenuto; per un altro appuntamento aspetta il suo.
  const shown = detail !== null && (appointmentId === null || detail.id === appointmentId) ? detail : null;

  /** Un cambio di stato: dopo il commit la pagina si aggiorna da sola e il dettaglio si rilegge. */
  function perform<T>(action: () => Promise<ActionResult<T>>, onOk: (data: T) => void = reload) {
    startBusy(async () => {
      const result = await action();
      if (result.ok) {
        onOk(result.data);
        return;
      }
      toast.error(result.message);
      if (result.conflict) {
        router.refresh();
        reload();
      }
    });
  }

  /** "Ripristina" e "Annulla 'saltato'": l'orario ora può sovrapporsi a un altro appuntamento. */
  const warnOverlap = ({ overlap }: { overlap: string | null }) => {
    if (overlap !== null) toast(overlapWarning(overlap));
    reload();
  };

  const markDone = (id: string) =>
    perform(
      () => markDoneAction(id),
      () => onMarkedDone?.(id),
    );

  const onAction = (action: AppointmentAction) => {
    if (shown === null) return;
    const { id } = shown;
    switch (action) {
      case "segna_confermato":
        perform(() => markConfirmedAction(id));
        return;
      case "segna_fatta":
        if (shown.doneQuestion === null) markDone(id);
        else setAskDone(true);
        return;
      case "saltato":
        perform(() => markSkippedAction(id));
        return;
      case "annulla":
        setCancelling(true);
        return;
      case "annulla_fatto":
        perform(() => undoDoneAction(id));
        return;
      case "ripristina":
        perform(() => restoreAppointmentAction(id), warnOverlap);
        return;
      case "annulla_saltato":
        perform(() => undoSkippedAction(id), warnOverlap);
        return;
      case "elimina":
        setDeleting(true);
        return;
      case "modifica":
        setMovedFor(null);
        setEditing(true);
        return;
    }
  };

  return (
    <Sheet
      open={appointmentId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {shown === null ? (
              ""
            ) : (
              <Link href={patientHref(shown.patientId)} prefetch={false} className="underline decoration-1 underline-offset-4">
                {shown.patientName}
              </Link>
            )}
          </SheetTitle>
        </SheetHeader>
        {shown === null ? (
          <div className="flex flex-col gap-3 px-4">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : (
          <>
            <DetailBody
              detail={shown}
              busy={busy}
              onAction={onAction}
              onPrepareMessage={() => setComposingFor({ id: shown.id, templateKey: "promemoria" })}
              onReminderChanged={reload}
              onCollect={setCollecting}
            />
            {movedFor === shown.id && shown.status === "prenotato" ? (
              <div className="px-4 pb-4">
                <Button type="button" variant="outline"
                  onClick={() => setComposingFor({ id: shown.id, templateKey: "spostamento" })}>
                  Copia il messaggio di spostamento
                </Button>
              </div>
            ) : null}
            <ConsentCollectDialog target={collecting} onClose={() => setCollecting(null)} onSaved={reload} />
            <MessageComposer
              source={
                composingFor?.id === shown.id
                  ? { kind: "appointment", appointmentId: shown.id, templateKey: composingFor.templateKey }
                  : null
              }
              onClose={() => {
                setComposingFor(null);
                // Una sola rilettura alla chiusura: copie, aperture ed esiti del compositore, che è modale e
                // copre la riga del promemoria finché è aperto.
                reload();
              }}
            />
            {shown.doneQuestion === null ? null : (
              <DoneConfirm
                open={askDone}
                question={shown.doneQuestion}
                onOpenChange={setAskDone}
                onConfirm={() => markDone(shown.id)}
              />
            )}
            <CancelDialog
              appointmentId={cancelling ? shown.id : null}
              seriesFollowing={shown.seriesFollowing}
              onClose={() => setCancelling(false)}
              onCancelled={reload}
            />
            <DeleteDialog appointmentId={deleting ? shown.id : null} onClose={() => setDeleting(false)} onDeleted={onClose} />
            <AppointmentDialog
              open={editing}
              onOpenChange={setEditing}
              services={services}
              defaultIntervalWeeks={defaultIntervalWeeks}
              defaultExpectedSessions={defaultExpectedSessions}
              mode={{ kind: "edit", detail: shown }}
              onUpdated={reload}
              onMoved={setMovedFor}
            />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
