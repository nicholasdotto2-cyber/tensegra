"use client";

import Image from "next/image";
import { startTransition, useEffect, useId, useRef, useState } from "react";
import { saveCommunicationSettingsAction, storePractitionerSignatureAction } from "@/app/(app)/impostazioni/actions";
import { SignatureCanvas, type SignatureValue } from "@/components/consensi/signature-canvas";
import { described, Field, SaveBar } from "@/components/forms/form-parts";
import { UnsavedGuard } from "@/components/forms/unsaved-guard";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CONSENT_MODULES } from "@/lib/consents/modules";
import type { ConsentValues } from "@/lib/consents/render";
import type { ModuleKey } from "@/lib/consents/required";
import { clampStrokes, signatureProblem } from "@/lib/consents/signature";
import { settingsConsentPreview } from "@/lib/consents/studio-values";

const RETENTION_ERROR = "Scrivi un numero di anni da 1 a 30.";
const NOT_SAVED = "Non ho salvato le modifiche. Riprova.";
type Feedback = { error: string | undefined; formError: string | null; status: string; errorsShown: number; saving: boolean; revision: number };
const feedback: Feedback = { error: undefined, formError: null, status: "", errorsShown: 0, saving: false, revision: 0 };

/** Catalogo non modificabile. Conservazione e firma si salvano separatamente, come le altre sezioni. */
export function ConsentsSection({ retentionYears, signaturePng, signatureUnreadable = false, previewValues }: {
  retentionYears: number; signaturePng: string | null; previewValues: ConsentValues;
  /** La firma risulta salvata, ma i suoi byte mancano o non corrispondono all'hash. */
  signatureUnreadable?: boolean;
}) {
  const id = useId();
  const retentionInput = useRef<HTMLInputElement>(null);
  const retentionForm = useRef<HTMLFormElement>(null);
  const signatureForm = useRef<HTMLFormElement>(null);
  const retentionPending = useRef(false);
  const signaturePending = useRef(false);
  const [retention, setRetention] = useState({ ...feedback, value: String(retentionYears), saved: String(retentionYears) });
  const [signature, setSignature] = useState({ ...feedback, value: null as SignatureValue | null, savedPng: signaturePng });
  const signatureDirty = signature.value !== null && signature.value.png !== signature.savedPng;

  useEffect(() => {
    if (retention.errorsShown) {
      if (retention.error) retentionInput.current?.focus();
      else retentionForm.current?.querySelector<HTMLElement>("[role='alert']")?.focus();
    }
  }, [retention.errorsShown, retention.error]);
  useEffect(() => {
    if (signature.errorsShown) signatureForm.current?.querySelector<HTMLElement>(signature.error ? "canvas" : "[role='alert']")?.focus();
  }, [signature.errorsShown, signature.error]);

  const saveRetention = async () => {
    if (retentionPending.current) return;
    const value = Number(retention.value);
    if (!retention.value.trim() || !Number.isInteger(value) || value < 1 || value > 30) {
      setRetention(current => ({ ...current, error: RETENTION_ERROR, formError: null, errorsShown: current.errorsShown + 1 }));
      return;
    }
    retentionPending.current = true;
    const sent = { value: String(value), revision: retention.revision };
    setRetention(current => ({ ...current, saving: true, error: undefined, formError: null, status: "" }));
    try {
      const result = await saveCommunicationSettingsAction({ section: "consensi", retentionYears: value });
      setRetention(current => {
        if (result.ok) {
          const value = current.revision === sent.revision ? sent.value : current.value;
          return { ...current, value, saved: sent.value, status: value === sent.value ? "Conservazione salvata." : "Conservazione salvata. Restano modifiche non salvate." };
        }
        const error = result.fieldErrors?.retentionYears;
        if (error && current.revision !== sent.revision) return current;
        return { ...current, error, formError: error ? null : result.message, errorsShown: current.errorsShown + 1 };
      });
    } catch {
      setRetention(current => ({ ...current, formError: NOT_SAVED, errorsShown: current.errorsShown + 1 }));
    } finally {
      retentionPending.current = false;
      setRetention(current => ({ ...current, saving: false }));
    }
  };

  const saveSignature = async () => {
    if (signaturePending.current) return;
    const value = signature.value;
    const error = value ? signatureProblem(clampStrokes(value.strokes)) : "Disegna la firma prima di salvarla.";
    if (!value || error) {
      setSignature(current => ({ ...current, error: error ?? undefined, formError: null, errorsShown: current.errorsShown + 1 }));
      return;
    }
    signaturePending.current = true;
    const sent = { png: value.png, revision: signature.revision };
    setSignature(current => ({ ...current, saving: true, error: undefined, formError: null, status: "" }));
    try {
      const bytes = Uint8Array.from(atob(sent.png.slice(sent.png.indexOf(",") + 1)), char => char.charCodeAt(0));
      const data = new FormData();
      data.set("file", new File([bytes], "firma.png", { type: "image/png" }));
      const result = await storePractitionerSignatureAction(data);
      setSignature(current => {
        if (result.ok) return { ...current, savedPng: sent.png, status: current.value === null || current.value.png === sent.png ? "Firma salvata." : "Firma salvata. Restano modifiche non salvate." };
        const error = result.fieldErrors?.file;
        if (error && current.revision !== sent.revision) return current;
        return { ...current, error, formError: error ? null : result.message, errorsShown: current.errorsShown + 1 };
      });
    } catch {
      setSignature(current => ({ ...current, formError: NOT_SAVED, errorsShown: current.errorsShown + 1 }));
    } finally {
      signaturePending.current = false;
      setSignature(current => ({ ...current, saving: false }));
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <UnsavedGuard dirty={retention.value !== retention.saved || signatureDirty} />
      <p className="text-sm text-muted-foreground">I tre moduli sono in sola lettura. L&apos;anteprima usa i dati dello studio e il listino; i dati del paziente vengono compilati durante la raccolta del consenso.</p>
      {(Object.keys(CONSENT_MODULES) as ModuleKey[]).map(key => {
        const consentModule = CONSENT_MODULES[key];
        return (
          <fieldset key={key} className="flex min-w-0 flex-col gap-3 rounded-lg border p-4">
            <legend className="px-1 font-medium">{consentModule.title}</legend>
            <p className="text-sm text-muted-foreground">Versione {consentModule.version}</p>
            <Dialog>
              <DialogTrigger render={<Button type="button" variant="outline" className="self-start" />}>Anteprima</DialogTrigger>
              <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{consentModule.title}</DialogTitle>
                  <DialogDescription>Testo di esempio, da far verificare prima dell&apos;uso con pazienti reali.</DialogDescription>
                </DialogHeader>
                <p className="text-sm">Versione {consentModule.version}</p>
                <div className="whitespace-pre-wrap text-sm leading-relaxed">{settingsConsentPreview(key, previewValues, retention.value)}</div>
              </DialogContent>
            </Dialog>
          </fieldset>
        );
      })}
      <form ref={retentionForm} noValidate aria-busy={retention.saving} className="flex flex-col gap-4 border-t pt-6" onSubmit={event => { event.preventDefault(); startTransition(() => saveRetention()); }}>
        <Field id={id} label="Conservazione della documentazione clinica (anni)" error={retention.error} hint="Da 1 a 30 anni dall'ultima prestazione. I consensi già raccolti mantengono il testo firmato.">
          <Input ref={retentionInput} id={id} type="number" min={1} max={30} step={1} value={retention.value} {...described(id, retention.error, true)} onChange={event => {
            const value = event.target.value;
            setRetention(current => ({ ...current, value, revision: current.revision + 1, error: undefined, formError: null, status: "" }));
          }} />
        </Field>
        {retention.formError ? <p role="alert" tabIndex={-1} className="text-sm text-destructive">{retention.formError}</p> : null}
        <SaveBar saving={retention.saving} formError={null} label="Salva conservazione" />
        <p role="status" className="text-sm">{retention.status}</p>
      </form>
      <form ref={signatureForm} noValidate aria-busy={signature.saving} className="flex min-w-0 flex-col gap-4 border-t pt-6" onSubmit={event => { event.preventDefault(); startTransition(() => saveSignature()); }}>
        <p className="text-sm text-muted-foreground">La firma salvata sarà usata per le prossime raccolte e per le nuove lettere al medico. I consensi firmati e le lettere già salvate restano invariati.</p>
        {signature.savedPng ? <Image unoptimized src={signature.savedPng} alt="Firma salvata dell'osteopata" width={280} height={100} className="rounded border bg-white object-contain" /> : signatureUnreadable ? <p className="text-sm text-destructive">La firma salvata non si legge: disegnala e salvala di nuovo.</p> : <p className="text-sm">Nessuna firma salvata.</p>}
        <SignatureCanvas label="Firma dell'osteopata" error={signature.error} onChange={value => {
          setSignature(current => ({ ...current, value, revision: current.revision + 1, error: undefined, formError: null, status: "" }));
        }} />
        {signature.formError ? <p role="alert" tabIndex={-1} className="text-sm text-destructive">{signature.formError}</p> : null}
        <div className="[&_button]:min-h-11"><SaveBar saving={signature.saving} formError={null} label="Salva firma" /></div>
        <p role="status" className="text-sm">{signature.status}</p>
      </form>
    </div>
  );
}
