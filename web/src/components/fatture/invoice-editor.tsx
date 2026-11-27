"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  deleteDraftAction,
  invoiceEditorAction,
  issueFromEditorAction,
  peekInvoiceNumberAction,
  saveDraftAction,
} from "@/app/(app)/fatture/actions";
import type { CreatedParty } from "@/components/fatture/billing-party-dialog";
import { EditorLines, newLineKey } from "@/components/fatture/editor-lines";
import { EditorSummary } from "@/components/fatture/editor-summary";
import { type MissingFields, type Party, RecipientFields } from "@/components/fatture/recipient-fields";
import { ChoiceSelect, described, Field } from "@/components/forms/form-parts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { computeInvoice } from "@/lib/fiscal/calc";
import {
  type EditorDraft,
  type EditorRecipient,
  type EditorState,
  liveLines,
  toDraftInput,
} from "@/lib/fiscal/editor-state";
import { documentDate, PAID_IN_FUTURE } from "@/lib/fiscal/issue-date";
import { latin1Message, latin1Offender, toLatin1 } from "@/lib/fiscal/latin1";
import { isElectronic } from "@/lib/fiscal/snapshot";
import type { PaymentMethod } from "@/lib/fiscal/types";
import { centsToInput } from "@/lib/money";
import type { ActionFailure } from "@/server/actions/result";
import type { IssuedInvoice } from "@/server/domain/invoices/emission";
import type { EditorStart, InvoiceEditorView } from "@/server/domain/invoices/queries";

// L'editor della fattura come pannello laterale, montato da chi lo apre:
// "Nuova fattura", "Emetti" su Oggi e in "Da emettere", il pannello "Seduta fatta", una bozza. All'apertura legge
// la vista (`invoiceEditorAction`, sola lettura) e poi lavora su uno stato del client: il riepilogo si calcola nel
// browser, "Salva bozza" salva, "Emetti" ed "Emetti e segna pagata" salvano ed emettono insieme dopo la conferma
// col numero previsto, e chiudere senza un'azione non lascia niente. I controlli che bloccano l'emissione portano
// al campo che li risolve, o alla pagina dove si risolvono.

const TITLE_NEW = "Nuova fattura";
const TITLE_DRAFT = "Bozza di fattura";
const GONE = "Non trovo più questa bozza o questa seduta: la pagina si rilegge.";
const DRAFT_SAVED = "Bozza salvata.";
const DRAFT_DELETED = "Bozza eliminata.";
const NOT_SAVED = "Non ho salvato la bozza. Riprova.";
const NOT_ISSUED = "Non ho emesso la fattura.";
const NOT_DELETED = "Non ho eliminato la bozza. Riprova.";
const TOTAL_ZERO = "Il totale è zero: aggiungi una riga con un importo.";
const DESCRIPTION_MISSING = "Descrizione della riga mancante";

const METHOD_ITEMS: readonly { value: PaymentMethod; label: string }[] = [
  { value: "contanti", label: "Contanti" },
  { value: "carta", label: "Carta" },
  { value: "bonifico", label: "Bonifico" },
];

interface Check {
  field: string;
  message: string;
  href: string | null;
}

/**
 * La conferma dell'emissione, dal clic alla fine della chiusura: la bozza fotografata al clic e il numero letto
 * per la sua data restano gli stessi mentre si legge il numero, mentre la conferma è aperta e mentre si chiude.
 */
interface PendingIssue {
  phase: "peek" | "open" | "closing";
  draft: EditorDraft & { id: string };
  numberLabel: string | null;
}

function sameRecipient(a: EditorRecipient | null, b: EditorRecipient | null): boolean {
  if (a === null || b === null || a.kind !== b.kind) return false;
  if (a.kind === "committente" || b.kind === "committente") {
    return a.kind === "committente" && b.kind === "committente" && a.billingPartyId === b.billingPartyId;
  }
  return a.patientId === b.patientId && (a.kind !== "tutore" || (b.kind === "tutore" && a.guardianId === b.guardianId));
}

function initialState(view: InvoiceEditorView, markPaid: boolean): EditorState {
  const source = view.draft ?? view.prefill;
  return {
    invoiceId: view.draft?.invoiceId ?? null,
    recipient: source?.recipient ?? null,
    lines: (source?.lines ?? []).map((line) => ({
      key: newLineKey(), serviceId: line.serviceId, appointmentId: line.appointmentId, description: line.description,
      serviceDate: line.serviceDate, quantity: String(line.quantity), price: centsToInput(line.unitPriceCents),
    })),
    paymentMethod: source?.paymentMethod ?? view.defaultPaymentMethod,
    paid: view.draft === null ? markPaid : view.draft.paidOn !== null,
    paidOn: view.draft?.paidOn ?? view.today,
    stampMarkCode: view.draft?.stampMarkCode ?? "",
    internalNotes: view.draft?.internalNotes ?? null,
  };
}

// I percorsi degli errori del comando che hanno un campo nel pannello, nel nome che il pannello usa.
function formField(path: string): string | null {
  const line = /^lines\.(\d+)\.(description|serviceDate|quantity|unitPriceCents)$/.exec(path);
  if (line) return `lines.${line[1]}.${line[2] === "unitPriceCents" ? "price" : line[2]}`;
  if (path === "lines" || path === "paidOn" || path === "stampMarkCode") return path;
  if (path === "recipient" || /^recipient\.(patientId|guardianId|billingPartyId|kind)$/.test(path)) return "recipient";
  return null;
}

function IssuedState({ issued, onClose }: { issued: IssuedInvoice; onClose: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      <h3 ref={headingRef} tabIndex={-1} className="text-lg font-medium outline-none">
        {`Fattura ${issued.numberLabel} emessa`}
      </h3>
      {issued.warnings.map((warning) => (
        <Alert key={warning}>
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ))}
      <div className="flex flex-wrap gap-2">
        <a href={`/api/fatture/${issued.id}/pdf?download=1`} download className={buttonVariants()}>
          Scarica PDF
        </a>
        {issued.hasXml ? (
          <a href={`/api/fatture/${issued.id}/xml`} download className={buttonVariants({ variant: "outline" })}>
            Scarica XML
          </a>
        ) : null}
        <Button type="button" variant="outline" onClick={onClose}>
          Chiudi
        </Button>
      </div>
    </div>
  );
}

function InvoiceEditor({
  view,
  markPaid,
  onClose,
  onDirtyChange,
  onDraftSaved,
  onReload,
  onIssued,
}: {
  view: InvoiceEditorView;
  markPaid: boolean;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /** La bozza salvata: il pannello si rilegge su quella bozza. */
  onDraftSaved: (invoiceId: string) => void;
  onReload: () => void;
  onIssued: (issued: IssuedInvoice) => void;
}) {
  const router = useRouter();
  const baseId = useId();
  const idOf = (field: string) => `${baseId}-${field.replaceAll(".", "-")}`;
  const checksRef = useRef<HTMLHeadingElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [draftId] = useState(() => view.draft?.invoiceId ?? crypto.randomUUID());
  const [state, setState] = useState<EditorState>(() => initialState(view, markPaid));
  const [baseline, setBaseline] = useState(() => JSON.stringify(state));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorsShown, setErrorsShown] = useState(0);
  const [checksShown, setChecksShown] = useState(0);
  const [refusals, setRefusals] = useState<Check[]>([]);
  const [formError, setFormError] = useState<{ title: string; message: string } | null>(null);
  const [extraParties, setExtraParties] = useState<Party[]>([]);
  const [pendingIssue, setPendingIssue] = useState<PendingIssue | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [issued, setIssued] = useState<IssuedInvoice | null>(null);
  const [busy, startBusy] = useTransition();

  const dirty = issued === null && JSON.stringify(state) !== baseline;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // Dopo un'azione rifiutata il focus va al primo campo in errore, nell'ordine del pannello.
  useEffect(() => {
    if (errorsShown === 0) return;
    containerRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [errorsShown]);

  // I controlli nascono anche da un rifiuto: il focus ci va dopo che sono comparsi.
  useEffect(() => {
    if (checksShown === 0) return;
    checksRef.current?.focus();
  }, [checksShown]);

  const set = (part: Partial<EditorState>) => setState((current) => ({ ...current, ...part }));

  const parties = [...view.recipients.parties, ...extraParties.filter((p) => !view.recipients.parties.some((q) => q.id === p.id))];
  const recipient = state.recipient;
  const recipientKind = recipient?.kind ?? "paziente";
  const party = recipient?.kind === "committente" ? parties.find((p) => p.id === recipient.billingPartyId) : undefined;
  const computation = computeInvoice({
    regime: view.regime, rates: view.rates, recipientKind,
    withholdingAgent: party?.withholdingAgent ?? false, lines: liveLines(state.lines),
  });
  const electronic = isElectronic(view.regime, recipientKind);
  const futurePaid = state.paid && state.paidOn !== "" && state.paidOn > view.today;
  const paidOn = state.paid && state.paidOn !== "" && !futurePaid ? state.paidOn : null;
  const issueDate = documentDate({ paidOn, today: view.today, electronic });

  // Controlli: quelli della vista che non dipendono da ciò che si scrive nel pannello, quelli
  // del destinatario solo se è lo stesso della vista, quelli delle righe calcolati qui, e i rifiuti del comando.
  const loadedRecipient = view.draft?.recipient ?? view.prefill?.recipient ?? null;
  const sameAsView = sameRecipient(recipient, loadedRecipient);
  const checks: Check[] = view.problems.filter((p) =>
    p.field.startsWith("supplier.") || p.field.startsWith("texts.")
    || (p.field.startsWith("payment.") && state.paymentMethod === "bonifico")
    || ((p.field.startsWith("recipient.") || p.field.startsWith("sdi.")) && sameAsView));
  state.lines.forEach((line, index) => {
    const field = `lines.${index}.description`;
    if (line.description.trim() === "") checks.push({ field, message: DESCRIPTION_MISSING, href: null });
    else if (electronic && latin1Offender(toLatin1(line.description))) {
      checks.push({ field, message: latin1Message("Il testo della riga", "fattura"), href: null });
    }
  });
  if (state.lines.length > 0 && computation.totalCents === 0 && liveLines(state.lines).length === state.lines.length) {
    checks.push({ field: "computation.totalCents", message: TOTAL_ZERO, href: null });
  }
  for (const refusal of refusals) {
    if (!checks.some((c) => c.field === refusal.field && c.message === refusal.message)) checks.push(refusal);
  }

  const person = recipient !== null && recipient.kind !== "committente";
  const missingTaxCode = person && checks.some((c) => c.field === "recipient.taxCode");
  const missingAddress = person && checks.some((c) => c.field.startsWith("recipient.address") && c.field !== "recipient.address.country");
  const missing: MissingFields | null = missingTaxCode || missingAddress
    ? { taxCode: missingTaxCode, address: missingAddress, known: sameAsView ? (view.recipientFields?.address ?? null) : null }
    : null;

  /** Dove porta un controllo: un campo del pannello, l'anagrafica del paziente o la pagina indicata. */
  const targetOf = (check: Check): { id: string } | { href: string } | null => {
    if (check.href !== null) return { href: check.href };
    if (check.field === "recipient.taxCode" && missingTaxCode) return { id: idOf("recipient.taxCode") };
    if (check.field.startsWith("recipient.address") && missingAddress) return { id: idOf("recipient.address") };
    if (/^recipient\.(firstName|lastName)$/.test(check.field) && person) {
      return { href: `/pazienti/${recipient.patientId}?tab=anagrafica` };
    }
    if (/^lines\.\d+\.description$/.test(check.field)) return { id: idOf(check.field) };
    if (check.field === "computation.totalCents" && state.lines.length > 0) return { id: idOf("lines.0.price") };
    return null;
  };

  const showErrors = (next: Record<string, string>) => {
    setErrors(next);
    setErrorsShown((n) => n + 1);
  };

  /** I rifiuti del comando: sotto il campo se il pannello lo ha, fra i controlli se no, altrimenti in alto. */
  const showFailure = (result: ActionFailure, title: string) => {
    const fields: Record<string, string> = {};
    const others: Check[] = [];
    for (const [path, message] of Object.entries(result.fieldErrors ?? {})) {
      const field = formField(path);
      if (field !== null) fields[field] ??= message;
      else others.push({ field: path, message, href: null });
    }
    setRefusals(others);
    if (Object.keys(fields).length > 0) {
      setFormError(null);
      showErrors(fields);
    } else if (others.length > 0) {
      setErrors({});
      setFormError(null);
      setChecksShown((n) => n + 1);
    } else {
      setErrors({});
      setFormError({ title, message: result.message });
    }
    if (result.conflict) router.refresh();
  };

  /** L'input della bozza, o null dopo aver mostrato gli errori dei campi. */
  const validated = (next: EditorState): (EditorDraft & { id: string }) | null => {
    const draft = toDraftInput(next);
    const fieldErrors = "errors" in draft ? { ...draft.errors } : {};
    if (next.paid && next.paidOn > view.today) fieldErrors.paidOn = PAID_IN_FUTURE;
    if (Object.keys(fieldErrors).length > 0 || "errors" in draft) {
      setFormError(null);
      showErrors(fieldErrors);
      return null;
    }
    setErrors({});
    return { ...draft, id: draftId };
  };

  const saveDraft = () => {
    const draft = validated(state);
    if (draft === null) return;
    startBusy(async () => {
      const result = await saveDraftAction(draft);
      if (!result.ok) {
        showFailure(result, NOT_SAVED);
        return;
      }
      const saved = { ...state, invoiceId: result.data.id };
      setState((current) => ({ ...current, invoiceId: result.data.id }));
      setBaseline(JSON.stringify(saved));
      setRefusals([]);
      setFormError(null);
      toast.success(DRAFT_SAVED);
      onDraftSaved(result.data.id);
    });
  };

  /** "Emetti e segna pagata" mette la spunta e la data di oggi se manca; "Emetti" prende il pannello com'è. */
  const requestIssue = (markPaid: boolean) => {
    const next = markPaid ? { ...state, paid: true, paidOn: state.paidOn === "" ? view.today : state.paidOn } : state;
    if (markPaid) setState(next);
    const draft = validated(next);
    if (draft === null) return;
    if (checks.length > 0) {
      setChecksShown((n) => n + 1);
      return;
    }
    const plannedDate = documentDate({ paidOn: draft.paidOn, today: view.today, electronic });
    // Da qui i campi sono disabilitati: niente modifiche che la conferma non mostrerebbe.
    setPendingIssue({ phase: "peek", draft, numberLabel: null });
    startBusy(async () => {
      const result = await peekInvoiceNumberAction({ issueDate: plannedDate });
      if (!result.ok) {
        setPendingIssue(null);
        showFailure(result, NOT_ISSUED);
        return;
      }
      setPendingIssue((current) => current?.phase === "peek" && current.draft === draft
        ? { ...current, phase: "open", numberLabel: result.data } : current);
    });
  };

  const closeConfirm = () => setPendingIssue((current) => current === null ? null : { ...current, phase: "closing" });

  const issue = () => {
    if (pendingIssue === null || pendingIssue.phase !== "open") return;
    const { draft } = pendingIssue;
    startBusy(async () => {
      const result = await issueFromEditorAction(draft);
      closeConfirm();
      if (!result.ok) {
        showFailure(result, NOT_ISSUED);
        return;
      }
      setIssued(result.data);
      onIssued(result.data);
    });
  };

  const deleteDraft = () => {
    if (state.invoiceId === null) return;
    const invoiceId = state.invoiceId;
    startBusy(async () => {
      const result = await deleteDraftAction({ invoiceId });
      setConfirmDelete(false);
      if (!result.ok) {
        showFailure(result, NOT_DELETED);
        return;
      }
      toast.success(DRAFT_DELETED);
      onClose();
    });
  };

  if (issued !== null) return <IssuedState issued={issued} onClose={onClose} />;

  const patientId = recipient !== null && recipient.kind !== "committente" ? recipient.patientId : null;
  const checksId = `${baseId}-controlli`;

  return (
    <div ref={containerRef} className="flex flex-col gap-6 px-4 pb-4">
      <fieldset disabled={pendingIssue !== null} className="flex min-w-0 flex-col gap-6">
        <RecipientFields
          patients={view.recipients.patients}
          parties={parties}
          value={recipient}
          onChange={(next) => {
            set({ recipient: next });
            setRefusals((current) => current.filter((r) => !r.field.startsWith("recipient.")));
          }}
          onPartyCreated={(created: CreatedParty) => setExtraParties((current) => [...current, created])}
          error={errors.recipient}
          idOf={idOf}
          missing={missing}
          onFieldsSaved={() => {
            setRefusals((current) => current.filter((r) => !r.field.startsWith("recipient.")));
            onReload();
          }}
        />

        <EditorLines
          lines={state.lines}
          onChange={(lines) => set({ lines })}
          errors={errors}
          idOf={idOf}
          services={view.services}
          sessions={view.toInvoice}
          patientId={patientId}
          showPatient={patientId === null}
          today={view.today}
        />

        <EditorSummary
          regime={view.regime}
          regimeChanged={view.regimeChanged}
          computation={computation}
          issueDate={issueDate}
          today={view.today}
        />

        <section aria-labelledby={`${baseId}-pagamento`} className="flex flex-col gap-4">
          <h3 id={`${baseId}-pagamento`} className="font-medium">
            Pagamento
          </h3>
          <ChoiceSelect
            id={idOf("paymentMethod")}
            label="Metodo"
            items={METHOD_ITEMS}
            value={state.paymentMethod}
            onChange={(paymentMethod) => {
              set({ paymentMethod });
              setRefusals((current) => current.filter((p) => !p.field.startsWith("payment.")));
            }}
            error={errors.paymentMethod}
          />
          <Label className="min-h-6 font-normal">
            {/* La Checkbox di Base UI non è un controllo nativo: il fieldset disabilitato non la blocca. */}
            <Checkbox checked={state.paid} disabled={pendingIssue !== null} onCheckedChange={(paid) => set({ paid })} />
            Già incassata
          </Label>
          {state.paid ? (
            <Field id={idOf("paidOn")} label="Data dell'incasso" error={errors.paidOn}>
              <Input
                id={idOf("paidOn")}
                type="date"
                max={view.today}
                value={state.paidOn}
                onChange={(event) => set({ paidOn: event.target.value })}
                {...described(idOf("paidOn"), errors.paidOn)}
              />
            </Field>
          ) : null}
          {electronic ? null : (
            <Field id={idOf("stampMarkCode")} label="Numero del contrassegno" optional error={errors.stampMarkCode}>
              <Input
                id={idOf("stampMarkCode")}
                value={state.stampMarkCode}
                maxLength={30}
                autoComplete="off"
                onChange={(event) => set({ stampMarkCode: event.target.value })}
                {...described(idOf("stampMarkCode"), errors.stampMarkCode)}
              />
            </Field>
          )}
        </section>
      </fieldset>

      {checks.length === 0 ? null : (
        <section aria-labelledby={checksId} className="flex flex-col gap-2 rounded-lg border border-destructive/40 p-4">
          <h3 id={checksId} ref={checksRef} tabIndex={-1} className="font-medium outline-none">
            Controlli
          </h3>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {checks.map((check) => {
              const target = targetOf(check);
              return (
                <li key={`${check.field}:${check.message}`}>
                  {target === null ? (
                    check.message
                  ) : "href" in target ? (
                    <Link href={target.href} className="underline underline-offset-2">
                      {check.message}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="min-h-6 text-left underline underline-offset-2"
                      onClick={() => document.getElementById(target.id)?.focus()}
                    >
                      {check.message}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {formError === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>{formError.title}</AlertTitle>
          <AlertDescription>{formError.message}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={() => requestIssue(true)}>
          <Check aria-hidden="true" />
          Emetti e segna pagata
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => requestIssue(false)}>
          Emetti
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={saveDraft}>
          Salva bozza
        </Button>
        {state.invoiceId === null ? null : (
          <Button type="button" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Elimina bozza
          </Button>
        )}
      </div>

      <AlertDialog
        open={pendingIssue?.phase === "open"}
        onOpenChange={(open) => {
          if (!open) closeConfirm();
        }}
        onOpenChangeComplete={(open) => {
          if (!open) setPendingIssue((current) => current?.phase === "closing" ? null : current);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Emettere la fattura?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingIssue?.numberLabel ? `Alla fattura verrà assegnato il numero ${pendingIssue.numberLabel}. Il numero non si può riusare.` : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Torna indietro</AlertDialogCancel>
            <Button type="button" disabled={busy} onClick={issue}>
              Emetti fattura
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminare la bozza?</AlertDialogTitle>
            <AlertDialogDescription>Le sedute della bozza tornano fra quelle da fatturare.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Torna indietro</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={busy} onClick={deleteDraft}>
              Elimina bozza
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type Loaded = { session: number; view: InvoiceEditorView } | { session: number; error: string };

export function InvoiceEditorSheet({
  start,
  markPaid = false,
  onClose,
  onIssued,
}: {
  /** Da dove parte l'editor; null tiene chiuso il pannello. */
  start: EditorStart | null;
  markPaid?: boolean;
  onClose: () => void;
  onIssued?: (issued: IssuedInvoice) => void;
}) {
  const router = useRouter();
  const startKey = start === null ? null : JSON.stringify(start);
  const open = startKey !== null;
  // A ogni apertura il pannello riparte: rilegge la vista e dimentica la bozza salvata e le modifiche.
  // Mentre si chiude tiene il suo contenuto.
  const [wasOpen, setWasOpen] = useState(false);
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const [session, setSession] = useState(0);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const loadedSession = useRef(-1);
  if (open !== wasOpen || (open && startKey !== openedKey)) {
    setWasOpen(open);
    if (open) {
      setOpenedKey(startKey);
      setSession((n) => n + 1);
      setSavedId(null);
      setDirty(false);
    }
  }

  const closeGone = useEffectEvent(() => {
    toast.error(GONE);
    router.refresh();
    onClose();
  });

  useEffect(() => {
    if (!open || openedKey === null) return;
    const request: EditorStart = savedId !== null ? { kind: "draft", invoiceId: savedId } : (JSON.parse(openedKey) as EditorStart);
    let current = true;
    void invoiceEditorAction(request).then((result) => {
      if (!current) return;
      if (!result.ok) {
        // Una rilettura che non riesce lascia il pannello com'era.
        if (loadedSession.current === session) toast.error(result.message);
        else setLoaded({ session, error: result.message });
      } else if (result.data === null) closeGone();
      else {
        loadedSession.current = session;
        setLoaded({ session, view: result.data });
      }
    });
    return () => {
      current = false;
    };
  }, [open, openedKey, session, savedId, reloads]);

  const shown = loaded !== null && loaded.session === session ? loaded : null;
  const draftTitle = savedId !== null || (openedKey !== null && (JSON.parse(openedKey) as EditorStart).kind === "draft");

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      disablePointerDismissal={dirty}
    >
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{draftTitle ? TITLE_DRAFT : TITLE_NEW}</SheetTitle>
        </SheetHeader>
        {shown === null ? (
          <div className="flex flex-col gap-3 px-4" aria-hidden="true">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : "error" in shown ? (
          <div className="flex flex-col gap-4 px-4">
            <p role="alert">{shown.error}</p>
            <div>
              <Button type="button" variant="outline" onClick={onClose}>
                Torna indietro
              </Button>
            </div>
          </div>
        ) : (
          <InvoiceEditor
            key={session}
            view={shown.view}
            markPaid={markPaid}
            onClose={onClose}
            onDirtyChange={setDirty}
            onDraftSaved={(invoiceId) => {
              setSavedId(invoiceId);
              setReloads((n) => n + 1);
            }}
            onReload={() => setReloads((n) => n + 1)}
            onIssued={(issued) => {
              setDirty(false);
              onIssued?.(issued);
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
