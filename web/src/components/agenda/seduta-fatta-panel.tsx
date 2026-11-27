"use client";

import { Ban, Circle, CircleCheck, FileWarning } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, type RefObject, useEffect, useEffectEvent, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { createAppointmentAction, savePaymentMethodAction, sedutaFattaAction } from "@/app/(app)/agenda/actions";
import { AppointmentDialog, type ServiceOption } from "@/components/agenda/appointment-dialog";
import { CycleCloseDialog } from "@/components/cartella/cycle-close-dialog";
import { ConsentCollectDialog } from "@/components/consensi/collect-dialog";
import { OpenVisitButton } from "@/components/cartella/open-visit";
import { InvoiceEditorSheet } from "@/components/fatture/invoice-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { SedutaFattaView } from "@/server/domain/appointments/queries";
import type { ConsentTarget } from "@/server/domain/consents/schemas";

// Il pannello "Seduta fatta": si apre dopo "Segna come fatta" e dopo un
// appuntamento creato già fatto. Tre passi nell'ordine del banco, ciascuno "da fare" o "fatto" (testo
// più icona): l'incasso, la prossima seduta, la visita. Se manca il consenso al trattamento del ciclo, in cima
// il banner con «Raccogli ora» (il dialogo di raccolta si apre sopra il pannello, che resta e si
// rilegge dopo la firma) e «L'ho raccolto su carta, lo carico dopo», che nasconde il banner senza registrare
// niente; con una revoca il banner dice «Consenso revocato il 20/10». Nessuno dei due ferma il "fatto".
// Il passo 1 offre sotto i metodi «Emetti e segna pagata» con un metodo scelto, «Emetti fattura» con "Non
// ancora incassato" o senza metodo, poi "Più tardi": i due aprono l'editor della fattura come pannello sopra
// questo (`InvoiceEditorSheet`), e dopo l'emissione il pannello si rilegge; con il
// passo fatto resta «Fattura 273/2026» col link. Il passo 2 offre "Chiudi il ciclo" o "Chiudi il
// mantenimento" (la finestra `CycleCloseDialog`, poi il pannello si rilegge) e il passo 3 "Compila ora". Il
// pannello si chiude quando si vuole; i passi non fatti restano sul dettaglio e su Oggi.

type Method = NonNullable<SedutaFattaView["paymentMethod"]>;

const METHODS: readonly { value: Method | null; label: string }[] = [
  { value: "contanti", label: "Contanti" },
  { value: "carta", label: "Carta" },
  { value: "bonifico", label: "Bonifico" },
  { value: null, label: "Non ancora incassato" },
];

const CONSENT_MISSING = "Manca il consenso al trattamento per questo ciclo.";

interface PanelProps {
  /** L'appuntamento fatto; null tiene chiuso il pannello. */
  appointmentId: string | null;
  onClose: () => void;
  services: readonly ServiceOption[];
  defaultIntervalWeeks: number;
  defaultExpectedSessions: number;
}

function StepStatus({ done }: { done: boolean }) {
  const Icon = done ? CircleCheck : Circle;
  return (
    <span
      data-slot="step-status"
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium",
        done ? "bg-success text-success-foreground" : "bg-muted text-foreground",
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {done ? "fatto" : "da fare"}
    </span>
  );
}

function Step({
  title,
  done,
  headingRef,
  children,
}: {
  title: string;
  done: boolean;
  /** Dove va il focus quando il pulsante che ha aperto una finestra non c'è più. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <h3 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="font-medium outline-none">
          {title}
        </h3>
        <StepStatus done={done} />
      </div>
      {children}
    </li>
  );
}

function PanelBody({
  view,
  onClose,
  reload,
  booking,
}: {
  view: SedutaFattaView;
  onClose: () => void;
  reload: () => void;
  booking: Omit<PanelProps, "appointmentId" | "onClose">;
}) {
  const router = useRouter();
  const [method, setMethod] = useState<Method | null>(view.paymentMethod);
  const [paymentLater, setPaymentLater] = useState(false);
  const [consentNoted, setConsentNoted] = useState(false);
  // Il bersaglio aperto resta quello del clic: la rilettura del pannello dopo la firma non chiude il dialogo, che
  // può ancora dover rifare il PDF.
  const [collecting, setCollecting] = useState<ConsentTarget | null>(null);
  const [otherTime, setOtherTime] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [invoicing, setInvoicing] = useState(false);
  const [busy, startBusy] = useTransition();
  const nextRef = useRef<HTMLHeadingElement>(null);
  const incassoRef = useRef<HTMLHeadingElement>(null);
  // Salvata o emessa la fattura, l'apertura non c'è più: chiuso l'editor il focus va al titolo del passo 1.
  const issuedRef = useRef(false);
  // Chiuso il ciclo, il pulsante che aveva aperto la finestra non c'è più: il focus va al titolo del passo.
  const closedRef = useRef(false);
  const { next, steps, invoice } = view;

  useEffect(() => {
    if (invoicing || !issuedRef.current || !steps.incasso) return;
    issuedRef.current = false;
    incassoRef.current?.focus();
  }, [invoicing, steps.incasso]);

  const chooseMethod = (value: Method | null) => {
    const previous = method;
    setMethod(value);
    startBusy(async () => {
      const result = await savePaymentMethodAction({ id: view.appointmentId, method: value });
      if (result.ok) return;
      setMethod(previous);
      toast.error(result.message);
      if (result.conflict) router.refresh();
    });
  };

  const book = () => {
    if (next.kind !== "proposal") return;
    startBusy(async () => {
      const result = await createAppointmentAction({
        patient: { kind: "existing", patientId: view.patient.id },
        serviceId: next.serviceId,
        day: next.day,
        time: next.time,
        durationMin: next.durationMin,
        cycle: { kind: "existing", cycleId: view.cycleId },
        priceCents: next.priceCents,
        status: "prenotato",
      });
      if (result.ok) reload();
      else toast.error(result.message);
    });
  };

  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      {view.consentMissing && !consentNoted ? (
        // Un consenso revocato o rifiutato blocca il trattamento: stile distruttivo; uno che manca soltanto, avviso.
        <Alert
          variant={view.consentBlockText === null ? "default" : "destructive"}
          className={view.consentBlockText === null ? "border-transparent bg-warning text-warning-foreground" : undefined}
        >
          {view.consentBlockText === null ? <FileWarning aria-hidden="true" /> : <Ban aria-hidden="true" />}
          <AlertDescription
            className={cn("flex flex-col items-start gap-2", view.consentBlockText === null && "text-warning-foreground")}
          >
            {view.consentRevocationText === null ? null : <span>{view.consentRevocationText}</span>}
            <span>{view.consentBlockText ?? CONSENT_MISSING}</span>
            <div className="flex flex-wrap gap-2">
              {view.consentTarget === null ? null : (
                <Button type="button" variant="outline" size="sm" onClick={() => setCollecting(view.consentTarget)}>
                  Raccogli ora
                </Button>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => setConsentNoted(true)}>
                L&apos;ho raccolto su carta, lo carico dopo
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      <ConsentCollectDialog
        target={collecting}
        onClose={() => setCollecting(null)}
        onSaved={reload}
      />

      <ol className="flex flex-col divide-y">
        <Step title="Incasso e fattura" done={steps.incasso} headingRef={incassoRef}>
          {steps.incasso ? (
            invoice === null ? null : (
              <p>
                <Link
                  href={invoice.numberLabel === null ? "/fatture?tab=bozze" : `/fatture/${invoice.id}`}
                  prefetch={false}
                  className="underline decoration-1 underline-offset-4"
                >
                  {invoice.numberLabel === null ? "Bozza di fattura" : `Fattura ${invoice.numberLabel}`}
                </Link>
              </p>
            )
          ) : paymentLater ? null : (
            <>
              <div className="flex flex-wrap gap-2">
                {METHODS.map((item) => (
                  <Button
                    key={item.label}
                    type="button"
                    size="sm"
                    variant={method === item.value ? "default" : "outline"}
                    aria-pressed={method === item.value}
                    disabled={busy}
                    onClick={() => chooseMethod(item.value)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {/* L'editor legge il metodo salvato sull'appuntamento: si apre dopo il salvataggio del metodo. */}
                <Button type="button" size="sm" disabled={busy} onClick={() => setInvoicing(true)}>
                  {method === null ? "Emetti fattura" : "Emetti e segna pagata"}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setPaymentLater(true)}>
                  Più tardi
                </Button>
              </div>
            </>
          )}
        </Step>

        <Step title="Prossima seduta" done={steps.prossima} headingRef={nextRef}>
          {next.kind === "booked" || next.kind === "proposal" ? <p>{next.text}</p> : null}
          {steps.prossima && !view.canCloseCycle ? null : (
            <div className="flex flex-wrap gap-2">
              {steps.prossima ? null : (
                <>
                  {next.kind === "proposal" ? (
                    <Button type="button" size="sm" disabled={busy} onClick={book}>
                      Fissa
                    </Button>
                  ) : null}
                  <Button type="button" size="sm" variant="outline" onClick={() => setOtherTime(true)}>
                    Scegli un altro orario
                  </Button>
                </>
              )}
              {view.canCloseCycle ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    closedRef.current = false;
                    setClosing(view.cycleId);
                  }}
                >
                  {view.cycleKind === "mantenimento" ? "Chiudi il mantenimento" : "Chiudi il ciclo"}
                </Button>
              ) : null}
            </div>
          )}
        </Step>

        <Step title="Visita" done={steps.visita}>
          {steps.visita ? null : (
            <div className="flex flex-wrap gap-2">
              {view.visitId === null ? (
                <OpenVisitButton appointmentId={view.appointmentId} label="Compila ora" />
              ) : (
                <Link
                  href={`/pazienti/${view.patient.id}/visite/${view.visitId}`}
                  prefetch={false}
                  className={cn(buttonVariants({ size: "sm" }))}
                >
                  Compila ora
                </Link>
              )}
              <Button type="button" size="sm" variant="outline" onClick={onClose}>
                Compila più tardi
              </Button>
            </div>
          )}
        </Step>
      </ol>

      <CycleCloseDialog
        cycleId={closing}
        onClose={() => setClosing(null)}
        onClosed={() => {
          closedRef.current = true;
          reload();
        }}
        finalFocus={() => (closedRef.current ? nextRef.current : true)}
      />

      <InvoiceEditorSheet
        start={invoicing ? { kind: "appointment", appointmentId: view.appointmentId } : null}
        markPaid={method !== null}
        onClose={() => {
          issuedRef.current = true;
          setInvoicing(false);
          // Anche una bozza salvata dall'editor fa il passo 1: il pannello si rilegge.
          reload();
        }}
        onIssued={() => {
          issuedRef.current = true;
          reload();
        }}
      />

      <AppointmentDialog
        open={otherTime}
        onOpenChange={setOtherTime}
        {...booking}
        prefill={{ patientId: view.patient.id, cycleId: view.cycleId }}
        onCreated={reload}
      />
    </div>
  );
}

export function SedutaFattaPanel({ appointmentId, onClose, ...booking }: PanelProps) {
  const [view, setView] = useState<SedutaFattaView | null>(null);
  const [reloads, setReloads] = useState(0);
  // Un appuntamento che non è (più) fatto non ha il pannello.
  const closeMissing = useEffectEvent(() => onClose());

  // Il pannello si legge all'apertura e dopo ogni passo fatto da qui ("Fissa", un altro orario).
  useEffect(() => {
    if (appointmentId === null) return;
    let current = true;
    void sedutaFattaAction(appointmentId).then((result) => {
      if (!current) return;
      if (!result.ok) toast.error(result.message);
      else if (result.data === null) closeMissing();
      else setView(result.data);
    });
    return () => {
      current = false;
    };
  }, [appointmentId, reloads]);

  // Mentre si chiude il pannello tiene il suo contenuto; per un altro appuntamento aspetta il suo.
  const shown = view !== null && (appointmentId === null || view.appointmentId === appointmentId) ? view : null;

  return (
    <Sheet
      open={appointmentId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{shown?.title ?? "Seduta fatta"}</SheetTitle>
        </SheetHeader>
        {shown === null ? (
          <div className="flex flex-col gap-3 px-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <PanelBody
            key={shown.appointmentId}
            view={shown}
            onClose={onClose}
            reload={() => setReloads((n) => n + 1)}
            booking={booking}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
