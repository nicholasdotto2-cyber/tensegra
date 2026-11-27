"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  markReferralDeliveredAction,
  updateReferralAction,
} from "@/app/(app)/pazienti/[id]/rinvii/[referralId]/actions";
import { ChoiceSelect, described, Field, SaveBar, useSectionForm } from "@/components/forms/form-parts";
import { UnsavedGuard } from "@/components/forms/unsaved-guard";
import { NewPhysicianDialog } from "@/components/pazienti/new-physician-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LETTER_CHANGED, REFERRAL_LOCKED, REFERRAL_REASON_LABEL, URGENCY_LABEL } from "@/lib/clinical/labels";
import { dayField } from "@/lib/format";
import type { PhysicianOption } from "@/server/domain/physicians/queries";
import type { ReferralLetter } from "@/server/domain/referrals/queries";

// Il modulo della lettera al medico: destinatario dalla rubrica o scritto,
// motivo, urgenza, sintesi, richiesta e l'assenso del paziente, salvati insieme; sotto, le azioni sulla lettera:
// "Salva PDF in cartella" (chiede la route del PDF, che lo genera e lo congela), "Stampa" (la stessa route in una
// nuova scheda) e "Segna come consegnata al paziente". Il contenuto si modifica solo in bozza e prima del PDF; con
// il PDF salvato la bozza lascia cambiare solo l'assenso, e una lettera consegnata non cambia più. Il PDF e la
// consegna riguardano la lettera salvata: con modifiche non salvate «Salva PDF» e la consegna le salvano prima,
// «Stampa» (un link, che dopo un `await` il browser bloccherebbe) chiede di salvare. Se un'altra scheda congela
// il PDF, la pagina si rilegge quando torna in primo piano e le modifiche non salvate si scartano con una frase.

const NONE = "nessuno";
const FREE = "libero";
const MISSING_PHYSICIAN = "Medico non più in rubrica";
const AGREEMENT = "Il paziente è d'accordo a condividere queste informazioni";
const PDF_FAILED = "Non ho salvato il PDF. Riprova.";
const DELIVERY_FAILED = "Non ho segnato la lettera come consegnata.";

type Reason = keyof typeof REFERRAL_REASON_LABEL;
type Urgency = keyof typeof URGENCY_LABEL;

const REASON_ITEMS = (Object.keys(REFERRAL_REASON_LABEL) as Reason[]).map((value) => ({
  value,
  label: REFERRAL_REASON_LABEL[value],
}));
const URGENCY_ITEMS = (Object.keys(URGENCY_LABEL) as Urgency[]).map((value) => ({ value, label: URGENCY_LABEL[value] }));

interface Values {
  /** L'id del medico in rubrica, `FREE` (destinatario scritto) o `NONE` (nessuno: la lettera dice il tipo). */
  recipient: string;
  recipientFree: string;
  reason: Reason;
  urgency: Urgency;
  summaryText: string;
  requestText: string;
  agreed: boolean;
}

// Il database vincola motivo e urgenza (check di `referrals`): la guardia restringe il tipo senza un cast.
function isReason(value: string): value is Reason {
  return Object.hasOwn(REFERRAL_REASON_LABEL, value);
}
function isUrgency(value: string): value is Urgency {
  return Object.hasOwn(URGENCY_LABEL, value);
}

/** I campi del contenuto della lettera: si modificano solo in bozza e prima del PDF. */
const CONTENT_KEYS = ["recipient", "recipientFree", "reason", "urgency", "summaryText", "requestText"] as const;

function recipientOf(letter: ReferralLetter): string {
  const { physicianId, free } = letter.recipient;
  if (physicianId !== null) return physicianId;
  return free === null ? NONE : FREE;
}

function initialValues(letter: ReferralLetter): Values {
  return {
    recipient: recipientOf(letter),
    recipientFree: letter.recipient.free ?? "",
    reason: isReason(letter.reason) ? letter.reason : "altro",
    urgency: isUrgency(letter.urgency) ? letter.urgency : "programmato",
    summaryText: letter.summaryText,
    requestText: letter.requestText,
    agreed: letter.agreed,
  };
}

/**
 * Il tipo di destinatario che si salva con la scelta. Una scelta che non è cambiata tiene il tipo della lettera
 * (può essere «Medico inviante»); una scelta nuova lo ricava dal medico: il ruolo in rubrica, «Altro» per il testo.
 */
function kindOf(letter: ReferralLetter, recipient: string, options: readonly PhysicianOption[]): string {
  if (recipient === recipientOf(letter)) return letter.recipient.kind;
  if (recipient === FREE) return "altro";
  if (recipient === NONE) return "medico_curante";
  const role = options.find((physician) => physician.id === recipient)?.role;
  if (role === "specialista") return "specialista";
  return role === "altro" ? "altro" : "medico_curante";
}

export function ReferralForm({
  letter,
  physicians,
  today,
}: {
  letter: ReferralLetter;
  physicians: PhysicianOption[];
  /** Il giorno di oggi per l'orologio del server: la data di consegna proposta. */
  today: string;
}) {
  const router = useRouter();
  const [form, formRef] = useSectionForm<Values>(initialValues(letter));
  const { values, errors, idOf } = form;
  const [dialogOpen, setDialogOpen] = useState(false);
  // I medici appena creati: la scelta li ha subito, prima che la pagina si rilegga.
  const [created, setCreated] = useState<PhysicianOption[]>([]);
  const [pdfPending, startPdf] = useTransition();
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [deliveredOn, setDeliveredOn] = useState(today);
  const [dateError, setDateError] = useState<string | undefined>(undefined);
  const [dateErrorShown, setDateErrorShown] = useState(0);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const dateId = useId();
  const dateRef = useRef<HTMLInputElement>(null);
  const deliveredRef = useRef<HTMLParagraphElement>(null);
  const focusDelivered = useRef(false);
  const [printBlocked, setPrintBlocked] = useState(false);
  // La lettera si è bloccata mentre il modulo aveva modifiche non salvate: sono state scartate, e la pagina lo dice.
  const [discarded, setDiscarded] = useState(false);
  const [editableSeen, setEditableSeen] = useState(letter.editable);

  // Dopo una consegna rifiutata per la data il focus va al campo, come per gli altri errori.
  useEffect(() => {
    if (dateErrorShown > 0) dateRef.current?.focus();
  }, [dateErrorShown]);

  const contentLocked = !letter.editable;
  const agreementLocked = letter.status !== "bozza";

  // Un altro PDF o un'altra consegna hanno bloccato la lettera (la pagina si è riletta): il contenuto scritto qui e
  // non salvato non può più entrare. Si torna ai valori salvati, senza toccare l'assenso, e lo si dice.
  if (editableSeen !== letter.editable) {
    setEditableSeen(letter.editable);
    if (!letter.editable) {
      const saved = initialValues(letter);
      if (CONTENT_KEYS.some((key) => values[key].trim() !== saved[key].trim())) {
        form.patch({
          recipient: saved.recipient,
          recipientFree: saved.recipientFree,
          reason: saved.reason,
          urgency: saved.urgency,
          summaryText: saved.summaryText,
          requestText: saved.requestText,
        });
        setDiscarded(true);
      }
    }
  }

  // Finché la lettera è modificabile un'altra scheda può congelarla (con «Stampa»): quando questa torna in primo
  // piano la pagina si rilegge, e il blocco compare.
  useEffect(() => {
    if (!letter.editable) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [letter.editable, router]);

  // Dopo la consegna il pulsante premuto sparisce: il focus passa alla riga «Consegnata al paziente il ...».
  useEffect(() => {
    if (letter.deliveredOn !== null && focusDelivered.current) {
      focusDelivered.current = false;
      deliveredRef.current?.focus();
    }
  }, [letter.deliveredOn]);

  const options = [...physicians, ...created.filter((c) => !physicians.some((p) => p.id === c.id))].sort((a, b) =>
    a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase(), "it"),
  );
  // Un medico scelto che non è più in rubrica si vede com'è: salvando, quell'id resterebbe.
  const missing =
    values.recipient === NONE || values.recipient === FREE || options.some((p) => p.id === values.recipient)
      ? []
      : [values.recipient];
  const recipientItems = [
    { value: NONE, label: "Nessun medico scelto" },
    ...options.map((p) => ({ value: p.id, label: p.fullName })),
    { value: FREE, label: "Scrivi il destinatario" },
    ...missing.map((id) => ({ value: id, label: MISSING_PHYSICIAN })),
  ];

  /** Salva il modulo; `false` se il comando l'ha rifiutato (gli errori sono già sotto i campi). */
  const save = async (): Promise<boolean> => {
    const onlyPhysician = values.recipient !== NONE && values.recipient !== FREE;
    const result = await updateReferralAction({
      referralId: letter.id,
      recipientKind: kindOf(letter, values.recipient, options),
      physicianId: onlyPhysician ? values.recipient : null,
      recipientFree: values.recipient === FREE ? values.recipientFree : null,
      reason: values.reason,
      urgency: values.urgency,
      summaryText: values.summaryText,
      requestText: values.requestText,
      patientAgreedToShare: values.agreed,
    });
    if (!result.ok) {
      form.fail(result);
      return false;
    }
    form.done(values);
    return true;
  };

  const deliver = () => {
    form.startSaving(async () => {
      setDeliveryError(null);
      setDateError(undefined);
      if (form.dirty && !(await save())) return;
      const result = await markReferralDeliveredAction({ referralId: letter.id, deliveredOn });
      if (!result.ok) {
        const fieldErrors = result.fieldErrors ?? {};
        if (fieldErrors.patientAgreedToShare !== undefined) {
          form.showErrors({ patientAgreedToShare: fieldErrors.patientAgreedToShare });
        } else if (fieldErrors.deliveredOn !== undefined) {
          setDateError(fieldErrors.deliveredOn);
          setDateErrorShown((n) => n + 1);
        } else {
          setDeliveryError(result.message);
        }
        return;
      }
      focusDelivered.current = true;
      toast.success("Lettera consegnata al paziente.");
    });
  };

  const savePdf = () => {
    startPdf(async () => {
      setPdfError(null);
      setPrintBlocked(false);
      // Il PDF congela il testo salvato, e non si disfa: ciò che è sullo schermo si salva prima.
      if (form.dirty && !(await save())) return;
      try {
        const response = await fetch(`/api/rinvii/${letter.id}/pdf`);
        if (response.status === 409 && (await response.text()) === LETTER_CHANGED) {
          // La lettera è cambiata sotto la richiesta e non si è salvato niente: la pagina si rilegge.
          setPdfError(LETTER_CHANGED);
          router.refresh();
          return;
        }
        if (!response.ok) throw new Error(`PDF ${response.status}`);
      } catch {
        setPdfError(PDF_FAILED);
        return;
      }
      toast.success("PDF salvato in cartella.");
      router.refresh();
    });
  };

  const showPrintHint = printBlocked && form.dirty && letter.editable;
  const agreementError = errors.patientAgreedToShare;
  const agreementId = idOf("agreed");

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <UnsavedGuard dirty={form.dirty} />
      {letter.deliveredOn === null ? null : (
        <p ref={deliveredRef} tabIndex={-1} className="outline-none">
          Consegnata al paziente il <time dateTime={letter.deliveredOn}>{dayField(letter.deliveredOn)}</time>.
        </p>
      )}
      <form
        ref={formRef}
        noValidate
        aria-label="Contenuto della lettera"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          form.startSaving(async () => {
            await save();
          });
        }}
      >
        {contentLocked ? (
          // Una frase sullo stato della pagina, non un evento: senza `role="alert"`, che si annuncerebbe a ogni apertura.
          <Alert role="note">
            <AlertDescription>{REFERRAL_LOCKED}</AlertDescription>
          </Alert>
        ) : null}
        {discarded ? (
          <Alert>
            <AlertDescription>Le modifiche che stavi scrivendo non sono state salvate.</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2">
          <ChoiceSelect
            id={idOf("recipient")}
            label="Destinatario"
            items={recipientItems}
            value={values.recipient}
            onChange={(value) => form.set("recipient", value)}
            error={errors.physicianId ?? errors.recipientKind}
            readOnly={contentLocked}
          />
          {values.recipient === FREE ? (
            <Field id={idOf("recipientFree")} label="Nome del destinatario" error={errors.recipientFree}>
              <Input {...form.text("recipientFree")} readOnly={contentLocked} autoComplete="off" />
            </Field>
          ) : null}
          {contentLocked ? null : (
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
                Nuovo medico
              </Button>
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <ChoiceSelect
            id={idOf("reason")}
            label="Motivo"
            items={REASON_ITEMS}
            value={values.reason}
            onChange={(value) => form.set("reason", value)}
            error={errors.reason}
            readOnly={contentLocked}
          />
          <ChoiceSelect
            id={idOf("urgency")}
            label="Urgenza"
            items={URGENCY_ITEMS}
            value={values.urgency}
            onChange={(value) => form.set("urgency", value)}
            error={errors.urgency}
            readOnly={contentLocked}
          />
        </div>

        <Field id={idOf("summaryText")} label="Sintesi" required error={errors.summaryText}>
          <Textarea
            id={idOf("summaryText")}
            value={values.summaryText}
            onChange={(event) => form.set("summaryText", event.target.value)}
            readOnly={contentLocked}
            className="min-h-48"
            {...described(idOf("summaryText"), errors.summaryText)}
          />
        </Field>
        <Field id={idOf("requestText")} label="Richiesta" required error={errors.requestText}>
          <Textarea
            id={idOf("requestText")}
            value={values.requestText}
            onChange={(event) => form.set("requestText", event.target.value)}
            readOnly={contentLocked}
            className="min-h-24"
            {...described(idOf("requestText"), errors.requestText)}
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <div className="flex min-h-8 items-center gap-2">
            <Checkbox
              id={agreementId}
              checked={values.agreed}
              readOnly={agreementLocked}
              onCheckedChange={(checked) => {
                form.set("agreed", checked);
                form.clearError("patientAgreedToShare");
              }}
              {...described(agreementId, agreementError)}
            />
            <Label htmlFor={agreementId}>{AGREEMENT}</Label>
          </div>
          {agreementError === undefined ? null : (
            <p id={`${agreementId}-errore`} className="text-sm text-destructive">
              {agreementError}
            </p>
          )}
        </div>

        {agreementLocked ? null : <SaveBar saving={form.saving || pdfPending} formError={form.formError} />}
      </form>

      <section aria-label="Azioni sulla lettera" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={pdfPending || form.saving || letter.letterFileId !== null}
            onClick={savePdf}
          >
            Salva PDF in cartella
          </Button>
          <a
            href={`/api/rinvii/${letter.id}/pdf`}
            target="_blank"
            rel="noopener"
            aria-describedby={showPrintHint ? `${dateId}-stampa` : undefined}
            className={buttonVariants({ variant: "outline" })}
            onClick={(event) => {
              // Con modifiche non salvate il PDF sarebbe quello vecchio: si ferma il link e si dice perché.
              if (form.dirty && letter.editable) {
                event.preventDefault();
                setPrintBlocked(true);
              } else {
                setPrintBlocked(false);
              }
            }}
          >
            Stampa<span className="sr-only"> (si apre in una nuova scheda)</span>
          </a>
        </div>
        {letter.letterFileId === null ? null : (
          <p className="text-sm text-muted-foreground">Il PDF di questa lettera è salvato in cartella.</p>
        )}
        {showPrintHint ? (
          <p id={`${dateId}-stampa`} role="alert" className="text-sm text-destructive">
            Salva le modifiche prima di stampare.
          </p>
        ) : null}
        {pdfError === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {pdfError}
          </p>
        )}

        {letter.status === "bozza" ? (
          <div className="flex flex-col items-start gap-3">
            <Field id={dateId} label="Data di consegna" required error={dateError} className="w-48">
              <Input
                id={dateId}
                ref={dateRef}
                type="date"
                value={deliveredOn}
                max={today}
                onChange={(event) => setDeliveredOn(event.target.value)}
                {...described(dateId, dateError)}
              />
            </Field>
            {deliveryError === null ? null : (
              <Alert variant="destructive">
                <AlertTitle>{DELIVERY_FAILED}</AlertTitle>
                <AlertDescription>{deliveryError}</AlertDescription>
              </Alert>
            )}
            <Button type="button" disabled={form.saving || pdfPending} onClick={deliver}>
              Segna come consegnata al paziente
            </Button>
          </div>
        ) : null}
      </section>

      {/* Fuori dal modulo: il dialogo ha il suo, e un invio al suo interno non deve arrivare a questo. */}
      <NewPhysicianDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(physician) => {
          setCreated((current) => [...current, physician]);
          form.set("recipient", physician.id);
        }}
      />
    </div>
  );
}
