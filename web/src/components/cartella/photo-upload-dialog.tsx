"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { uploadPhotoAction } from "@/app/(app)/pazienti/[id]/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { VIEW_LABEL } from "@/lib/clinical/labels";
import { NOT_IMAGE_TEXT } from "@/lib/files/messages";
import { type PhotoViewCode, VIEW_CODES } from "@/lib/files/photo-views";
import { resizePhoto } from "@/lib/files/resize";

// "Carica foto": la foto si riduce nel browser (lato lungo 2000 px,
// JPEG 0,85, senza metadati) e parte con la vista, la data e la didascalia; il server riconosce il tipo dai primi
// byte e rifiuta il doppione con la data della foto già in cartella. Con `visitId` è «la foto del giorno»
// dell'editor della visita: la foto resta legata a quella visita.

const CHOOSE_FILE = "Scegli la foto.";
const CHOOSE_VIEW = "Scegli la vista.";
const NOT_SAVED = "Non ho salvato la foto. Riprova.";
const NOT_SENT = "Non ho caricato la foto. Riprova.";
const SAVED = "Foto salvata.";
const FACE_HINT = "Inquadra dal collo in giù quando il volto non serve";
const CAPTION_MAX = 200;

/** I campi del modulo che il server può rifiutare, per nome. */
const FIELDS = ["file", "view", "takenOn", "caption"] as const;

function UploadForm({
  patientId,
  today,
  visitId,
  cycleId,
  onClose,
}: {
  patientId: string;
  today: string;
  visitId?: string;
  cycleId?: string;
  onClose: () => void;
}) {
  const baseId = useId();
  const idOf = (field: string) => `${baseId}-${field}`;
  const formRef = useRef<HTMLFormElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [view, setView] = useState<PhotoViewCode | null>(null);
  const [takenOn, setTakenOn] = useState(today);
  const [caption, setCaption] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorsShown, setErrorsShown] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  // Dopo un salvataggio rifiutato il focus va al primo campo in errore, nell'ordine del modulo.
  useEffect(() => {
    if (errorsShown === 0) return;
    formRef.current?.querySelector<HTMLElement>("[data-invalid='true']")?.focus();
  }, [errorsShown]);

  const clearError = (field: string) =>
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== field)));

  const showErrors = (next: Record<string, string>) => {
    setErrors(next);
    setFormError(null);
    setErrorsShown((n) => n + 1);
  };

  const submit = () => {
    const missing: Record<string, string> = {};
    if (file === null) missing.file = CHOOSE_FILE;
    if (view === null) missing.view = CHOOSE_VIEW;
    if (file === null || view === null) {
      showErrors(missing);
      return;
    }
    startSaving(async () => {
      let resized: Awaited<ReturnType<typeof resizePhoto>>;
      try {
        resized = await resizePhoto(file);
      } catch (error) {
        showErrors({ file: error instanceof Error ? error.message : NOT_IMAGE_TEXT });
        return;
      }
      const body = new FormData();
      // Il nome del file non parte: il server non lo conserva.
      body.set("file", resized.blob, "foto.jpg");
      body.set("patientId", patientId);
      body.set("view", view);
      body.set("takenOn", takenOn);
      body.set("caption", caption);
      body.set("widthPx", String(resized.width));
      body.set("heightPx", String(resized.height));
      if (visitId !== undefined) body.set("visitId", visitId);
      if (cycleId !== undefined) body.set("cycleId", cycleId);

      let result: Awaited<ReturnType<typeof uploadPhotoAction>>;
      try {
        result = await uploadPhotoAction(body);
      } catch {
        // La rete cade o il server rifiuta il corpo prima dell'azione (413): l'azione non ha risposto.
        setErrors({});
        setFormError(NOT_SENT);
        return;
      }
      if (result.ok) {
        toast.success(SAVED);
        onClose();
        return;
      }
      const fieldErrors = Object.fromEntries(
        FIELDS.flatMap((field) => {
          const message = result.fieldErrors?.[field];
          return message === undefined ? [] : [[field, message] as const];
        }),
      );
      if (Object.keys(fieldErrors).length > 0) {
        showErrors(fieldErrors);
      } else {
        setErrors({});
        setFormError(result.message);
      }
    });
  };

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        // Il dialogo può stare dentro un altro modulo (l'editor della visita): il suo invio non deve salire.
        event.stopPropagation();
        submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={idOf("file")}>
          Foto <span className="font-normal text-muted-foreground">(obbligatorio)</span>
        </Label>
        <Input
          id={idOf("file")}
          type="file"
          accept="image/*,.heic,.heif"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            clearError("file");
          }}
          aria-invalid={errors.file === undefined ? undefined : true}
          data-invalid={errors.file === undefined ? undefined : true}
          aria-describedby={errors.file === undefined ? undefined : idOf("file-errore")}
          className="h-auto py-1.5"
        />
        {errors.file === undefined ? null : (
          <p id={idOf("file-errore")} className="text-sm text-destructive">
            {errors.file}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline gap-1 text-sm leading-none">
          <span id={idOf("vista")} className="font-medium">
            Vista
          </span>
          <span className="text-muted-foreground">(obbligatorio)</span>
        </div>
        <RadioGroup
          aria-labelledby={idOf("vista")}
          aria-describedby={errors.view === undefined ? undefined : idOf("vista-errore")}
          value={view ?? ""}
          onValueChange={(value) => {
            setView(VIEW_CODES.find((code) => code === value) ?? null);
            clearError("view");
          }}
          className="gap-1"
        >
          {VIEW_CODES.map((code, index) => (
            <Label key={code} className="min-h-6 font-normal">
              <RadioGroupItem value={code} data-invalid={index === 0 && errors.view !== undefined ? true : undefined} />
              {VIEW_LABEL[code]}
            </Label>
          ))}
        </RadioGroup>
        {errors.view === undefined ? null : (
          <p id={idOf("vista-errore")} className="text-sm text-destructive">
            {errors.view}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={idOf("data")}>Data</Label>
        <Input
          id={idOf("data")}
          type="date"
          value={takenOn}
          onChange={(event) => {
            setTakenOn(event.target.value);
            clearError("takenOn");
          }}
          aria-invalid={errors.takenOn === undefined ? undefined : true}
          data-invalid={errors.takenOn === undefined ? undefined : true}
          aria-describedby={errors.takenOn === undefined ? undefined : idOf("data-errore")}
          className="max-w-44"
        />
        {errors.takenOn === undefined ? null : (
          <p id={idOf("data-errore")} className="text-sm text-destructive">
            {errors.takenOn}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={idOf("didascalia")}>Didascalia</Label>
        <Input
          id={idOf("didascalia")}
          type="text"
          maxLength={CAPTION_MAX}
          value={caption}
          onChange={(event) => {
            setCaption(event.target.value);
            clearError("caption");
          }}
          aria-invalid={errors.caption === undefined ? undefined : true}
          data-invalid={errors.caption === undefined ? undefined : true}
          aria-describedby={errors.caption === undefined ? undefined : idOf("didascalia-errore")}
        />
        {errors.caption === undefined ? null : (
          <p id={idOf("didascalia-errore")} className="text-sm text-destructive">
            {errors.caption}
          </p>
        )}
      </div>

      {formError === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>{formError === NOT_SENT ? NOT_SENT : NOT_SAVED}</AlertTitle>
          {formError === NOT_SAVED || formError === NOT_SENT ? null : <AlertDescription>{formError}</AlertDescription>}
        </Alert>
      )}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Torna indietro</DialogClose>
        <Button type="submit" disabled={saving}>
          Salva
        </Button>
      </DialogFooter>
    </form>
  );
}

export function PhotoUploadDialog({
  patientId,
  today,
  open,
  onOpenChange,
  visitId,
  cycleId,
}: {
  patientId: string;
  /** "AAAA-MM-GG": oggi a Roma, la data predefinita della foto. */
  today: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Con la visita, la foto resta legata a quella visita ("la foto del giorno" dell'editor). */
  visitId?: string;
  cycleId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Carica foto</DialogTitle>
          <DialogDescription>{FACE_HINT}</DialogDescription>
        </DialogHeader>
        {/* Il modulo nasce a ogni apertura: vista, data e didascalia ripartono dai valori predefiniti. */}
        <UploadForm
          patientId={patientId}
          today={today}
          visitId={visitId}
          cycleId={cycleId}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
