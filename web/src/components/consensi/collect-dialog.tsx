"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  consentCollectionAction,
  consentPreviewAction,
  printConsentAction,
  signConsentAction,
  uploadConsentAction,
} from "@/app/(app)/pazienti/[id]/consent-actions";
import { SignatureCanvas, type SignatureValue } from "@/components/consensi/signature-canvas";
import { described } from "@/components/forms/form-parts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { NO_CYCLE, NO_GUARDIAN, PDF_NOT_CREATED } from "@/lib/consents/messages";
import { CONSENT_MODULES } from "@/lib/consents/modules";
import { signatureProblem } from "@/lib/consents/signature";
import type { ActionFailure } from "@/server/actions/result";
import type { ConsentPreview } from "@/server/domain/consents/preview";
import type { ConsentCollection } from "@/server/domain/consents/collection";
import type { ConsentTarget } from "@/server/domain/consents/schemas";

// Il dialogo di raccolta di un consenso, a tutto schermo: il testo compilato scorrevole, i
// dati mancanti con i link, i campi del modulo e due modi di firmare. Sulla tela: «Firma e salva», disattivato
// finché la tela è vuota. Su carta: «Stampa il modulo» (PDF senza firma, niente righe né eventi), poi «Carica il
// modulo firmato» con la data della firma e l'avviso fisso. Le due scelte dell'informativa partono senza
// risposta e sono distinte: «No» vale quanto «Sì». Se il modulo cambia mentre il dialogo è aperto la tela resta
// e si chiede di rileggere; il testo vecchio non si salva. Se il PDF non si crea la firma è già salvata e si
// riprova a crearlo senza firmare di nuovo.

const INCOMPLETE_CHOICES = "Indica entrambe le scelte.";
const REFUSAL_NOTE = "Indica quali informazioni non desidera ricevere.";
const SECOND_GUARDIAN = "Compila il nome e la firma del secondo genitore.";
const SINGLE_GUARDIAN_MISSING = "Conferma la dichiarazione sull'altro genitore.";
const CHANGED = "Il modulo è cambiato: rileggilo prima di firmare.";
const KEEP_PAPER = "Conserva l'originale di carta.";
const CHOOSE_DOCUMENT = "Scegli il modulo firmato.";
const SIGNED_ON_MISSING = "Indica la data della firma.";
const NOT_SENT = "Non ho salvato il consenso. Riprova.";
const LOAD_FAILED = "Non riesco a caricare il modulo.";
const NOT_AVAILABLE = "Questo modulo non si può raccogliere per questo paziente.";
const SAVED = "Consenso salvato.";
const PDF_CREATED = "PDF creato.";
const PDF_STILL_MISSING = "Il PDF non è ancora pronto. Riprova tra poco.";
const PRINT_FAILED = "Non riesco a creare il modulo da stampare. Riprova.";

const SINGLE_GUARDIAN =
  "Io sottoscritto/a dichiaro che l'altro genitore è informato e d'accordo, oppure che esercito da solo/a la responsabilità genitoriale.";
const CHOICE_TEXT = {
  whatsapp: "Acconsento a ricevere promemoria e comunicazioni organizzative su WhatsApp.",
  richiami: "Acconsento a essere ricontattato/a per i controlli periodici.",
} as const;

// I dati dello studio prima di quelli del paziente: «Mancano: numero di polizza, codice fiscale del paziente».
const MISSING_ORDER = ["studio.", "osteopata.", "polizza.", "conservazione.", "documento.", "listino.", "paziente.", "genitore."];
const PRACTITIONER_SIGNATURE = "osteopata.firma";

/** I campi che il server può rifiutare, nell'ordine del modulo: il focus va al primo. */
const FIELDS = [
  "refusalNote",
  "minorOpinionNote",
  "secondGuardianName",
  "singleGuardianDeclaration",
  "choices",
  "notes",
  "document",
  "signedOn",
  "signature",
] as const;

type Mode = "tela" | "carta";
type Choice = boolean | null;

function missingRank(key: string): number {
  const index = MISSING_ORDER.findIndex((prefix) => key.startsWith(prefix));
  return index === -1 ? MISSING_ORDER.length : index;
}

/** Il PNG della tela come Blob, senza passare dalla rete. */
function pngBlob(dataUrl: string): Blob {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  return new Blob([Uint8Array.from(binary, (c) => c.charCodeAt(0))], { type: "image/png" });
}

/** Scarica un file costruito nel browser: il nome non contiene il paziente. */
function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Il download parte dal clic: l'URL si libera dopo, quando il browser l'ha già letto.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function targetKey(target: ConsentTarget): string {
  return [target.moduleKey, target.patientId, target.cycleId, target.guardianId, target.appointmentId].join(":");
}

export function ConsentCollectDialog({
  target,
  onClose,
  onSaved,
}: {
  /** Che cosa raccogliere; null tiene chiuso il dialogo. */
  target: ConsentTarget | null;
  onClose: () => void;
  /** Il consenso è salvato (anche se il PDF non è ancora pronto). */
  onSaved?: (id: string) => void;
}): React.JSX.Element {
  // Mentre il dialogo si chiude tiene il bersaglio che mostrava.
  const [shown, setShown] = useState(target);
  const [shownModule, setShownModule] = useState(target?.moduleKey ?? "informativa");
  if (target !== null && (shown === null || targetKey(target) !== targetKey(shown))) {
    setShown(target);
    setShownModule(target.moduleKey);
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="top-0 left-0 flex h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-4 overflow-y-auto rounded-none p-4 sm:max-w-none sm:p-6">
        <DialogHeader>
          <DialogTitle>{shown === null ? "Consenso" : CONSENT_MODULES[shownModule].title}</DialogTitle>
          <DialogDescription>Leggi il testo con chi firma, compila i campi e scegli come firmare.</DialogDescription>
        </DialogHeader>
        {/* Il modulo nasce a ogni apertura: campi, tela e risposte ripartono vuoti. */}
        {shown === null ? null : <CollectBody key={targetKey(shown)} target={shown} onClose={onClose} onSaved={onSaved} onModuleChange={setShownModule} />}
      </DialogContent>
    </Dialog>
  );
}

type Loaded = { preview: ConsentPreview } | { error: string };

function CollectBody({
  target,
  onClose,
  onSaved,
  onModuleChange,
}: {
  target: ConsentTarget;
  onClose: () => void;
  onSaved?: (id: string) => void;
  onModuleChange: (key: ConsentTarget["moduleKey"]) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let current = true;
    void consentPreviewAction(target)
      .then((result) => {
        if (!current) return;
        if (!result.ok) setLoaded({ error: result.message });
        else if (result.data === null) setLoaded({ error: NOT_AVAILABLE });
        else setLoaded({ preview: result.data });
      })
      .catch(() => {
        if (current) setLoaded({ error: LOAD_FAILED });
      });
    return () => {
      current = false;
    };
  }, [target]);

  if (loaded === null) {
    return (
      <div className="flex flex-col gap-3" aria-hidden="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if ("error" in loaded) {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert">{loaded.error}</p>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Torna indietro</DialogClose>
        </DialogFooter>
      </div>
    );
  }
  return <CollectForm target={target} initial={loaded.preview} onClose={onClose} onSaved={onSaved} onModuleChange={onModuleChange} />;
}

function CollectForm({
  target,
  initial,
  onClose,
  onSaved,
  onModuleChange,
}: {
  target: ConsentTarget;
  initial: ConsentPreview;
  onClose: () => void;
  onSaved?: (id: string) => void;
  onModuleChange: (key: ConsentTarget["moduleKey"]) => void;
}) {
  const baseId = useId();
  const idOf = (field: string) => `${baseId}-${field}`;
  const formRef = useRef<HTMLFormElement>(null);
  // Un id per tentativo: un nuovo invio dopo una risposta persa ritrova lo stesso consenso, non ne crea un altro.
  const [consentId] = useState(() => crypto.randomUUID());

  const [preview, setPreview] = useState(initial);
  const [changed, setChanged] = useState(false);
  const [mode, setMode] = useState<Mode>("tela");
  const [outcome, setOutcome] = useState<"accetta" | "rifiuta">("accetta");
  const [refusesInformation, setRefusesInformation] = useState(false);
  const [refusalNote, setRefusalNote] = useState("");
  const [trusteeName, setTrusteeName] = useState("");
  const [trusteeContact, setTrusteeContact] = useState("");
  // La voce predefinita vale finché l'osteopata non scrive nel campo, e torna solo se cambia il modulo risolto.
  const [minorNote, setMinorNote] = useState({ text: initial.minorOpinionDefault ?? "", edited: false, moduleKey: initial.target.moduleKey });
  const minorOpinionNote = minorNote.text;
  const [singleGuardian, setSingleGuardian] = useState(false);
  const [secondGuardianName, setSecondGuardianName] = useState("");
  const [notes, setNotes] = useState("");
  const [choices, setChoices] = useState<{ whatsapp: Choice; richiami: Choice }>({ whatsapp: null, richiami: null });
  const [signature, setSignature] = useState<SignatureValue | null>(null);
  const [secondSignature, setSecondSignature] = useState<SignatureValue | null>(null);
  const [paper, setPaper] = useState<File | null>(null);
  const [signedOn, setSignedOn] = useState("");
  const [guardianChoice, setGuardianChoice] = useState<string | undefined>();
  const requestKey = `${mode}:${signedOn}:${guardianChoice ?? ""}`;
  const [collection, setCollection] = useState<{ key: string; data: ConsentCollection | null; error: string | null }>({
    key: "tela::", data: { target, preview: initial, guardians: [], problem: null }, error: null,
  });
  const collectionReady = collection.key === requestKey && collection.data?.preview !== null && collection.data !== null;

  useEffect(() => {
    let current = true;
    const key = `${mode}:${signedOn}:${guardianChoice ?? ""}`;
    // La carta senza data mostra il modulo di oggi per la stampa; il caricamento richiede comunque la data.
    void consentCollectionAction(target, mode === "carta" && signedOn !== "" ? signedOn : undefined, guardianChoice)
      .then(result => {
        if (!current) return;
        const data = result.ok ? result.data : null;
        setCollection({ key, data, error: result.ok ? data?.problem ?? (data === null ? NOT_AVAILABLE : null) : result.message });
        if (data?.preview) {
          const resolved = data.preview;
          setPreview(resolved);
          setMinorNote(previous => previous.edited && previous.moduleKey === resolved.target.moduleKey
            ? previous
            : { text: resolved.minorOpinionDefault ?? "", edited: false, moduleKey: resolved.target.moduleKey });
          onModuleChange(data.target.moduleKey);
        }
      }).catch(() => {
        if (current) setCollection({ key, data: null, error: LOAD_FAILED });
      });
    return () => { current = false; };
  }, [target, mode, signedOn, guardianChoice, onModuleChange]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorsShown, setErrorsShown] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [printing, startPrinting] = useTransition();
  // L'id del consenso salvato dal server, quando il PDF resta da creare.
  const [pdfPending, setPdfPending] = useState<string | null>(null);
  const [retrying, startRetrying] = useTransition();
  const [retryError, setRetryError] = useState<string | null>(null);

  const activeTarget = preview.target;
  const isInformativa = activeTarget.moduleKey === "informativa";
  const isMinorModule = activeTarget.moduleKey === "trattamento_minore";
  const isTreatment = !isInformativa;
  const secondNamed = secondGuardianName.trim() !== "";

  // Dopo un salvataggio rifiutato il focus va al primo campo in errore, nell'ordine del modulo, una volta per
  // rifiuto. Un rifiuto del server arriva mentre il salvataggio è in corso e i campi sono disattivati: un campo
  // disattivato non prende il focus, quindi si aspetta la fine del salvataggio.
  const focusedErrors = useRef(0);
  useEffect(() => {
    if (saving || errorsShown === focusedErrors.current) return;
    focusedErrors.current = errorsShown;
    formRef.current?.querySelector<HTMLElement>("[data-invalid='true']")?.focus();
  }, [errorsShown, saving]);

  // Un rifiuto legato a un campo sparisce quando cambia quel campo.
  const clearError = (field: string) => {
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== field)));
    setFormError(null);
  };

  const showErrors = (next: Record<string, string>) => {
    setErrors(next);
    setFormError(null);
    setErrorsShown((n) => n + 1);
  };

  const fieldsFor = (hash: string) => ({
    ...activeTarget,
    id: consentId,
    signerName: preview.signerName,
    outcome: isInformativa ? "accetta" : outcome,
    refusesInformation: isTreatment && refusesInformation,
    refusalNote: isTreatment && refusesInformation ? refusalNote : null,
    trusteeName: isTreatment ? trusteeName : null,
    trusteeContact: isTreatment ? trusteeContact : null,
    minorOpinionNote: isMinorModule ? minorOpinionNote : null,
    singleGuardianDeclaration: isMinorModule && !secondNamed && singleGuardian,
    secondGuardianName: isMinorModule ? secondGuardianName : null,
    notes,
    choices: isInformativa ? { whatsapp: choices.whatsapp === true, richiami: choices.richiami === true } : null,
    previewHash: hash,
  });

  /** I controlli che il browser può fare da solo, con le stesse frasi del server. */
  const localErrors = (): Record<string, string> => {
    const found: Record<string, string> = {};
    if (isTreatment && refusesInformation && refusalNote.trim() === "") found.refusalNote = REFUSAL_NOTE;
    if (isMinorModule && mode === "tela" && secondNamed !== (secondSignature !== null)) found.secondGuardianName = SECOND_GUARDIAN;
    if (isMinorModule && !secondNamed && !singleGuardian) found.singleGuardianDeclaration = SINGLE_GUARDIAN_MISSING;
    if (isInformativa && (choices.whatsapp === null || choices.richiami === null)) found.choices = INCOMPLETE_CHOICES;
    if (mode === "carta") {
      if (paper === null) found.document = CHOOSE_DOCUMENT;
      if (signedOn === "") found.signedOn = SIGNED_ON_MISSING;
    } else {
      const problem = signature === null ? signatureProblem([]) : signatureProblem(signature.strokes);
      if (problem !== null) found.signature = problem;
      const secondProblem = secondSignature === null ? null : signatureProblem(secondSignature.strokes);
      if (isMinorModule && secondNamed && secondProblem !== null) found.secondSignature = secondProblem;
    }
    return found;
  };

  /**
   * Dopo un rifiuto senza campo il modulo si rilegge: se il testo è cambiato si mostra quello nuovo, la tela
   * resta e si chiede di rileggere prima di firmare di nuovo. Niente del testo vecchio si salva.
   */
  const recheck = async (usedHash: string): Promise<boolean> => {
    // Un modulo caricato si confronta al suo giorno dichiarato, come l'hash che è partito.
    const fresh = await consentPreviewAction(activeTarget, mode === "carta" ? signedOn : undefined).catch(() => null);
    if (fresh === null || !fresh.ok || fresh.data === null || fresh.data.hash === usedHash) return false;
    setPreview(fresh.data);
    setChanged(true);
    return true;
  };

  const handleFailure = async (result: ActionFailure, usedHash: string) => {
    const fieldErrors = Object.fromEntries(
      FIELDS.flatMap((field) => {
        const message = result.fieldErrors?.[field];
        return message === undefined ? [] : [[field, message] as const];
      }),
    );
    if (Object.keys(fieldErrors).length > 0) {
      showErrors(fieldErrors);
      return;
    }
    if (await recheck(usedHash)) {
      setErrors({});
      setFormError(null);
      return;
    }
    setErrors({});
    setFormError(result.message);
  };

  /** L'hash del testo mostrato al giorno dichiarato di un modulo caricato; null se il testo non è più quello. */
  const uploadHash = async (): Promise<string | null> => {
    const atDay = await consentPreviewAction(activeTarget, signedOn).catch(() => null);
    // Un modulo che non va con l'età a quel giorno: il comando risponde con la frase sulla data.
    if (atDay === null || !atDay.ok || atDay.data === null) return preview.hash;
    if (atDay.data.rendered.text !== preview.rendered.text) {
      setPreview(atDay.data);
      setChanged(true);
      return null;
    }
    return atDay.data.hash;
  };

  const submit = () => {
    if (!collectionReady) return;
    const found = localErrors();
    if (Object.keys(found).length > 0) {
      showErrors(found);
      return;
    }
    startSaving(async () => {
      setChanged(false);
      if (mode === "carta" && paper !== null) {
        const hash = await uploadHash();
        if (hash === null) return;
        const body = new FormData();
        body.set("fields", JSON.stringify(fieldsFor(hash)));
        // Il nome del file non parte: il server non lo conserva.
        body.set("document", paper, "modulo");
        body.set("signedOn", signedOn);
        let result: Awaited<ReturnType<typeof uploadConsentAction>>;
        try {
          result = await uploadConsentAction(body);
        } catch {
          setErrors({});
          setFormError(NOT_SENT);
          return;
        }
        if (!result.ok) {
          await handleFailure(result, hash);
          return;
        }
        toast.success(SAVED);
        onSaved?.(result.data.id);
        onClose();
        return;
      }
      if (signature === null) return;
      const body = new FormData();
      body.set("fields", JSON.stringify(fieldsFor(preview.hash)));
      body.set("signature", pngBlob(signature.png), "firma.png");
      if (isMinorModule && secondNamed && secondSignature !== null) {
        body.set("secondSignature", pngBlob(secondSignature.png), "firma-2.png");
      }
      let result: Awaited<ReturnType<typeof signConsentAction>>;
      try {
        result = await signConsentAction(body);
      } catch {
        // La rete cade o il server rifiuta il corpo prima dell'azione: l'azione non ha risposto.
        setErrors({});
        setFormError(NOT_SENT);
        return;
      }
      if (!result.ok) {
        await handleFailure(result, preview.hash);
        return;
      }
      onSaved?.(result.data.id);
      if (!result.data.pdfReady) {
        // La firma è salvata: resta solo il PDF, che si riprova senza la tela.
        setPdfPending(result.data.id);
        return;
      }
      toast.success(SAVED);
      onClose();
    });
  };

  const retryPdf = () => {
    startRetrying(async () => {
      setRetryError(null);
      try {
        const response = await fetch(`/api/consensi/${pdfPending}/documento`, { cache: "no-store" });
        if (!response.ok) {
          setRetryError(PDF_STILL_MISSING);
          return;
        }
        await response.arrayBuffer();
      } catch {
        setRetryError(PDF_STILL_MISSING);
        return;
      }
      toast.success(PDF_CREATED);
      onClose();
    });
  };

  const print = () => {
    startPrinting(async () => {
      const result = await printConsentAction(activeTarget, mode === "carta" && signedOn !== "" ? signedOn : undefined).catch(() => null);
      if (result === null || !result.ok) {
        toast.error(result?.message ?? PRINT_FAILED);
        return;
      }
      const binary = atob(result.data.pdfBase64);
      download(new Blob([Uint8Array.from(binary, (c) => c.charCodeAt(0))], { type: "application/pdf" }), "modulo-da-firmare.pdf");
    });
  };

  if (pdfPending !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="destructive">
          <AlertTitle>{PDF_NOT_CREATED}</AlertTitle>
          {retryError === null ? null : <AlertDescription>{retryError}</AlertDescription>}
        </Alert>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" className="h-11" />}>Chiudi</DialogClose>
          <Button type="button" className="h-11" onClick={retryPdf} disabled={retrying}>
            Riprova a crearlo
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const missing = preview.missingLinks
    .filter((link) => link.key !== PRACTITIONER_SIGNATURE)
    .sort((a, b) => missingRank(a.key) - missingRank(b.key));
  const practitionerMissing = preview.missingLinks.find((link) => link.key === PRACTITIONER_SIGNATURE);

  const choiceGroup = (key: "whatsapp" | "richiami", first: boolean) => {
    const value = choices[key];
    const invalid = errors.choices !== undefined && value === null;
    return (
      <div className="flex flex-col gap-1.5">
        <p id={idOf(`scelta-${key}`)} className="text-sm">
          {CHOICE_TEXT[key]}
        </p>
        <RadioGroup
          aria-labelledby={idOf(`scelta-${key}`)}
          aria-describedby={errors.choices === undefined ? undefined : idOf("choices-errore")}
          value={value === null ? "" : value ? "si" : "no"}
          onValueChange={(next) => {
            setChoices((prev) => ({ ...prev, [key]: next === "si" }));
            clearError("choices");
          }}
          className="flex gap-6"
        >
          {(["si", "no"] as const).map((option, index) => (
            <Label key={option} className="min-h-6 font-normal">
              <RadioGroupItem
                value={option}
                aria-invalid={invalid ? true : undefined}
                data-invalid={invalid && index === 0 && (first || choices.whatsapp !== null) ? true : undefined}
              />
              {option === "si" ? "Sì" : "No"}
            </Label>
          ))}
        </RadioGroup>
      </div>
    );
  };

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        submit();
      }}
    >
      {changed ? (
        <Alert variant="destructive">
          <AlertTitle>{CHANGED}</AlertTitle>
        </Alert>
      ) : null}

      {missing.length === 0 ? null : (
        <Alert>
          <AlertTitle>
            Mancano:{" "}
            {missing.map((link, index) => (
              <span key={link.key}>
                {index === 0 ? "" : ", "}
                <Link href={link.href} className="underline underline-offset-2">
                  {link.label}
                </Link>
              </span>
            ))}
          </AlertTitle>
          <AlertDescription>Si può firmare lo stesso: il dato mancante si scrive a penna sulla stampa.</AlertDescription>
        </Alert>
      )}
      {practitionerMissing === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          Manca la firma dell&apos;osteopata: nel PDF resta la riga «Firma dell&apos;osteopata».{" "}
          <Link href={practitionerMissing.href} className="underline underline-offset-2">
            Aggiungila nelle impostazioni
          </Link>
        </p>
      )}

      <div
        role="region"
        aria-label="Testo del modulo"
        tabIndex={0}
        className="max-h-[45dvh] overflow-y-auto rounded-md border bg-card p-4 text-sm leading-relaxed whitespace-pre-line outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {preview.rendered.text}
      </div>

      {collection.key !== requestKey ? <p role="status">Rileggo il modulo per la data della firma.</p> : collection.error === null ? null : <p role="alert">{collection.error}</p>}

      <fieldset disabled={saving} className="flex flex-col gap-5">
        {mode !== "carta" || !collectionReady || collection.data!.guardians.length === 0 ? null : (
          <div className="flex max-w-md flex-col gap-1.5">
            <Label htmlFor={idOf("guardian")}>Genitore o tutore che ha firmato</Label>
            <select id={idOf("guardian")} value={activeTarget.guardianId ?? ""} className="h-11 rounded-md border px-3"
              onChange={event => { setGuardianChoice(event.target.value); setSingleGuardian(false); setSecondGuardianName(""); }}>
              {collection.data!.guardians.map(guardian => <option key={guardian.id} value={guardian.id}>{guardian.name}</option>)}
            </select>
          </div>
        )}
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor={idOf("firmatario")}>Chi firma</Label>
          <Input id={idOf("firmatario")} value={preview.signerName} readOnly />
        </div>

        {isTreatment ? (
          <div className="flex flex-col gap-1.5">
            <p id={idOf("esito")} className="text-sm font-medium">
              Esito
            </p>
            <RadioGroup
              aria-labelledby={idOf("esito")}
              value={outcome}
              onValueChange={(next) => setOutcome(next === "rifiuta" ? "rifiuta" : "accetta")}
              className="gap-1"
            >
              <Label className="min-h-6 font-normal">
                <RadioGroupItem value="accetta" />
                Acconsente al trattamento
              </Label>
              <Label className="min-h-6 font-normal">
                <RadioGroupItem value="rifiuta" />
                Rifiuta il trattamento
              </Label>
            </RadioGroup>
          </div>
        ) : null}

        {isTreatment ? (
          <div className="flex flex-col gap-3">
            <Label className="min-h-6 font-normal">
              <Checkbox
                checked={refusesInformation}
                onCheckedChange={(checked) => {
                  setRefusesInformation(checked);
                  clearError("refusalNote");
                }}
              />
              Non desidera ricevere alcune informazioni
            </Label>
            {refusesInformation ? (
              <div className="flex max-w-xl flex-col gap-1.5">
                <Label htmlFor={idOf("refusalNote")}>
                  Quali informazioni <span className="font-normal text-muted-foreground">(obbligatorio)</span>
                </Label>
                <Textarea
                  id={idOf("refusalNote")}
                  value={refusalNote}
                  onChange={(event) => {
                    setRefusalNote(event.target.value);
                    clearError("refusalNote");
                  }}
                  data-invalid={errors.refusalNote === undefined ? undefined : true}
                  {...described(idOf("refusalNote"), errors.refusalNote)}
                />
                {errors.refusalNote === undefined ? null : (
                  <p id={`${idOf("refusalNote")}-errore`} className="text-sm text-destructive">
                    {errors.refusalNote}
                  </p>
                )}
              </div>
            ) : null}
            <div className="grid max-w-xl gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={idOf("trusteeName")}>
                  Persona che riceve le informazioni{" "}
                  <span className="font-normal text-muted-foreground">(facoltativo)</span>
                </Label>
                <Input id={idOf("trusteeName")} value={trusteeName} onChange={(event) => setTrusteeName(event.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={idOf("trusteeContact")}>
                  Suo recapito <span className="font-normal text-muted-foreground">(facoltativo)</span>
                </Label>
                <Input
                  id={idOf("trusteeContact")}
                  value={trusteeContact}
                  onChange={(event) => setTrusteeContact(event.target.value)}
                />
              </div>
            </div>
          </div>
        ) : null}

        {isMinorModule ? (
          <div className="flex max-w-xl flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={idOf("minorOpinionNote")}>Voce del minore</Label>
              <Textarea
                id={idOf("minorOpinionNote")}
                value={minorOpinionNote}
                onChange={(event) => {
                  const text = event.target.value;
                  setMinorNote(previous => ({ ...previous, text, edited: true }));
                  clearError("minorOpinionNote");
                }}
                data-invalid={errors.minorOpinionNote === undefined ? undefined : true}
                {...described(idOf("minorOpinionNote"), errors.minorOpinionNote)}
              />
              {errors.minorOpinionNote === undefined ? null : (
                <p id={`${idOf("minorOpinionNote")}-errore`} className="text-sm text-destructive">
                  {errors.minorOpinionNote}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={idOf("secondGuardianName")}>
                Secondo genitore <span className="font-normal text-muted-foreground">(facoltativo)</span>
              </Label>
              <Input
                id={idOf("secondGuardianName")}
                value={secondGuardianName}
                onChange={(event) => {
                  setSecondGuardianName(event.target.value);
                  // Senza nome la seconda tela sparisce: la sua firma non deve restare in memoria.
                  if (event.target.value.trim() === "") setSecondSignature(null);
                  clearError("secondGuardianName");
                  clearError("singleGuardianDeclaration");
                }}
                data-invalid={errors.secondGuardianName === undefined ? undefined : true}
                {...described(idOf("secondGuardianName"), errors.secondGuardianName)}
              />
              {errors.secondGuardianName === undefined ? null : (
                <p id={`${idOf("secondGuardianName")}-errore`} className="text-sm text-destructive">
                  {errors.secondGuardianName}
                </p>
              )}
            </div>
            {secondNamed ? null : (
              <div className="flex flex-col gap-1.5">
                <Label className="min-h-6 items-start font-normal">
                  <Checkbox
                    className="mt-0.5"
                    checked={singleGuardian}
                    onCheckedChange={(checked) => {
                      setSingleGuardian(checked);
                      clearError("singleGuardianDeclaration");
                    }}
                    data-invalid={errors.singleGuardianDeclaration === undefined ? undefined : true}
                    {...described(idOf("singleGuardianDeclaration"), errors.singleGuardianDeclaration)}
                  />
                  {SINGLE_GUARDIAN}
                </Label>
                {errors.singleGuardianDeclaration === undefined ? null : (
                  <p id={`${idOf("singleGuardianDeclaration")}-errore`} className="text-sm text-destructive">
                    {errors.singleGuardianDeclaration}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : null}

        {isInformativa ? (
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 text-sm font-medium">
              Consensi facoltativi <span className="font-normal text-muted-foreground">(rispondi a entrambi)</span>
            </legend>
            {choiceGroup("whatsapp", true)}
            {choiceGroup("richiami", false)}
            {errors.choices === undefined ? null : (
              <p id={idOf("choices-errore")} className="text-sm text-destructive">
                {errors.choices}
              </p>
            )}
          </fieldset>
        ) : null}

        <div className="flex max-w-xl flex-col gap-1.5">
          <Label htmlFor={idOf("notes")}>
            Note <span className="font-normal text-muted-foreground">(facoltativo)</span>
          </Label>
          <Textarea id={idOf("notes")} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </div>

        <div className="flex flex-col gap-1.5">
          <p id={idOf("modo")} className="text-sm font-medium">
            Come firma
          </p>
          <RadioGroup
            aria-labelledby={idOf("modo")}
            value={mode}
            onValueChange={(next) => {
              setMode(next === "carta" ? "carta" : "tela");
              setGuardianChoice(undefined);
              setErrors({});
              setFormError(null);
            }}
            className="flex flex-wrap gap-6"
          >
            <Label className="min-h-6 font-normal">
              <RadioGroupItem value="tela" />
              Firma sulla tela
            </Label>
            <Label className="min-h-6 font-normal">
              <RadioGroupItem value="carta" />
              Firma su carta e carico il modulo
            </Label>
          </RadioGroup>
        </div>

        {/* La tela resta montata anche su carta: tornando indietro la firma c'è ancora. */}
        <div hidden={mode !== "tela"} className="flex flex-col gap-4">
          <SignatureCanvas
            label={`Firma di ${preview.signerName}`}
            error={errors.signature}
            disabled={saving}
            onChange={(value) => {
              setSignature(value);
              clearError("signature");
            }}
          />
          {isMinorModule && secondNamed ? (
            <SignatureCanvas
              label="Firma del secondo genitore"
              error={errors.secondSignature}
              disabled={saving}
              onChange={(value) => {
                setSecondSignature(value);
                clearError("secondSignature");
                clearError("secondGuardianName");
              }}
            />
          ) : null}
        </div>

        {mode === "carta" ? (
          <div className="flex max-w-xl flex-col gap-4">
            <div>
              <Button type="button" variant="outline" className="h-11 px-4" onClick={print} disabled={printing || !collectionReady}>
                Stampa il modulo
              </Button>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={idOf("document")}>
                Modulo firmato <span className="font-normal text-muted-foreground">(obbligatorio)</span>
              </Label>
              <Input
                id={idOf("document")}
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                className="h-auto py-1.5"
                onChange={(event) => {
                  setPaper(event.target.files?.[0] ?? null);
                  clearError("document");
                }}
                data-invalid={errors.document === undefined ? undefined : true}
                {...described(idOf("document"), errors.document, true)}
              />
              <p id={`${idOf("document")}-nota`} className="text-sm text-muted-foreground">
                PDF, JPG o PNG, fino a 10 MB.
              </p>
              {errors.document === undefined ? null : (
                <p id={`${idOf("document")}-errore`} className="text-sm text-destructive">
                  {errors.document}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={idOf("signedOn")}>
                Data della firma <span className="font-normal text-muted-foreground">(obbligatorio)</span>
              </Label>
              <Input
                id={idOf("signedOn")}
                type="date"
                value={signedOn}
                className="max-w-44"
                onChange={(event) => {
                  setSignedOn(event.target.value);
                  setGuardianChoice(undefined);
                  setSingleGuardian(false);
                  clearError("signedOn");
                }}
                data-invalid={errors.signedOn === undefined ? undefined : true}
                {...described(idOf("signedOn"), errors.signedOn)}
              />
              {errors.signedOn === undefined ? null : (
                <p id={`${idOf("signedOn")}-errore`} className="text-sm text-destructive">
                  {errors.signedOn}
                </p>
              )}
            </div>
            <Alert>
              <AlertTitle>{KEEP_PAPER}</AlertTitle>
            </Alert>
          </div>
        ) : null}
      </fieldset>

      {formError === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>{formError}</AlertTitle>
        </Alert>
      )}

      <DialogFooter className="sticky bottom-0 bg-popover py-2">
        <DialogClose render={<Button type="button" variant="outline" className="h-11 px-4" />}>Torna indietro</DialogClose>
        {mode === "tela" ? (
          <Button type="submit" className="h-11 px-4" disabled={saving || signature === null || !collectionReady}>
            Firma e salva
          </Button>
        ) : (
          <Button type="submit" className="h-11 px-4" disabled={saving || !collectionReady}>
            Carica il modulo firmato
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

/**
 * I due pulsanti di raccolta della tab Consensi, con il dialogo. Il bersaglio lo calcola il server; senza un
 * ciclo aperto il consenso al trattamento non si raccoglie, e per un minore senza genitore con responsabilità
 * o tutore non si raccoglie nessuno dei due: la frase dice il motivo vero.
 */
export function ConsentCollectLauncher({
  informativa,
  treatment,
  noGuardian = false,
}: {
  informativa: ConsentTarget | null;
  treatment: ConsentTarget | null;
  /** Un minore senza un genitore o tutore che possa firmare. */
  noGuardian?: boolean;
}): React.JSX.Element {
  const [target, setTarget] = useState<ConsentTarget | null>(null);
  const reasonId = useId();
  const reason = noGuardian ? NO_GUARDIAN : treatment === null ? NO_CYCLE : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={informativa === null}
          aria-describedby={informativa === null && reason !== null ? reasonId : undefined}
          onClick={() => setTarget(informativa)}
        >
          Raccogli l&apos;informativa
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={treatment === null}
          aria-describedby={treatment === null && reason !== null ? reasonId : undefined}
          onClick={() => setTarget(treatment)}
        >
          Raccogli il consenso al trattamento
        </Button>
      </div>
      {reason === null ? null : (
        <p id={reasonId} className="text-sm text-muted-foreground">
          {reason}
        </p>
      )}
      <ConsentCollectDialog target={target} onClose={() => setTarget(null)} />
    </div>
  );
}
