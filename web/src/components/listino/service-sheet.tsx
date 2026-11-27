"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, type RefObject, startTransition, useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { applyPriceToFutureAction, createServiceAction, updateServiceAction } from "@/app/(app)/listino/actions";
import { PriceQuestion } from "@/components/listino/price-question";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { type ServiceColor, type ServiceKind, KIND_DEFAULTS, KIND_LABEL } from "@/lib/agenda/defaults";
import { COLOR_LABEL, SERVICE_COLOR_CLASS } from "@/lib/agenda/colors";
import { durationShort } from "@/lib/format";
import { centsToInput, parseEuroCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { ServiceRow } from "@/server/domain/services/queries";

// Il pannello "Nuova prestazione" e "Modifica" del Listino: nome, tipo,
// durata, prezzo, colore (con il nome scritto accanto) e descrizione in fattura. Una voce nuova parte dai
// valori del suo tipo (`KIND_DEFAULTS`); finché durata e colore non si toccano, un altro tipo li cambia.
// Gli errori del comando stanno sotto il campo e il focus va al primo. Dopo un cambio di prezzo con
// appuntamenti futuri ancora al prezzo vecchio il pannello si chiude e compare la domanda.

const REQUIRED = "Campo obbligatorio.";
const NOT_SAVED = "Non ho salvato la prestazione. Riprova.";
const NEW_KIND: ServiceKind = "seduta";
const NAME_MAX = 60;
const DESCRIPTION_MAX = 200;

const KINDS: readonly ServiceKind[] = ["prima_visita", "seduta", "controllo", "altro"];
const COLORS: readonly ServiceColor[] = ["petrolio", "salvia", "oceano", "ocra", "corallo", "ardesia"];
const KIND_ITEMS = KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }));
// Le durate che il database ammette: da 15 a 120 minuti a passi di 15.
const DURATION_ITEMS = Array.from({ length: 8 }, (_, index) => {
  const min = (index + 1) * 15;
  return { value: min, label: durationShort(min) };
});

/** Il nome del campo del modulo per il percorso dell'errore del comando. */
function fieldOf(path: string): string {
  return path === "priceCents" ? "price" : path;
}

function normalizeErrors(fieldErrors: Record<string, string> | undefined): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [path, message] of Object.entries(fieldErrors ?? {})) {
    const field = fieldOf(path);
    if (!(field in errors)) errors[field] = message;
  }
  return errors;
}

/** Etichetta, campo ed errore con i loro id: l'errore sta sotto il campo. */
function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        <span className="font-normal text-muted-foreground">(obbligatorio)</span>
      </Label>
      {children}
      {error === undefined ? null : (
        <p id={`${id}-errore`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Gli attributi del campo per il suo errore. */
function described(id: string, error: string | undefined) {
  return {
    "aria-invalid": error === undefined ? undefined : true,
    "aria-describedby": error === undefined ? undefined : `${id}-errore`,
  } as const;
}

interface Saved {
  serviceId: string;
  oldPriceCents: number;
  futureAtOldPrice: number;
}

function ServiceForm({
  service,
  onClose,
  onSaved,
  nameRef,
  onDirty,
}: {
  service: ServiceRow | null;
  onClose: () => void;
  onSaved: (saved: Saved) => void;
  nameRef: RefObject<HTMLInputElement | null>;
  /** L'utente ha cambiato un campo: da qui un clic fuori non chiude più il pannello. */
  onDirty: () => void;
}) {
  const baseId = useId();
  const idOf = (field: string) => `${baseId}-${field}`;
  const formRef = useRef<HTMLFormElement>(null);
  const colorLabelId = `${baseId}-colore`;

  const [kind, setKind] = useState<ServiceKind>(service?.kind ?? NEW_KIND);
  const [name, setName] = useState(service?.name ?? "");
  const [durationMin, setDurationMin] = useState(service?.durationMin ?? KIND_DEFAULTS[NEW_KIND].durationMin);
  const [priceText, setPriceText] = useState(service === null ? "" : centsToInput(service.priceCents));
  const [color, setColor] = useState<ServiceColor>(service?.color ?? KIND_DEFAULTS[NEW_KIND].color);
  const [description, setDescription] = useState(service?.invoiceDescription ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorsShown, setErrorsShown] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  // Una voce nuova segue i default del tipo finché durata e colore non sono scelti a mano.
  const touched = useRef({ duration: service !== null, color: service !== null });

  // Dopo un salvataggio rifiutato il focus va al primo campo in errore, nell'ordine della pagina.
  useEffect(() => {
    if (errorsShown === 0) return;
    formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [errorsShown]);

  const changeKind = (next: ServiceKind) => {
    setKind(next);
    if (!touched.current.duration) setDurationMin(KIND_DEFAULTS[next].durationMin);
    if (!touched.current.color) setColor(KIND_DEFAULTS[next].color);
  };

  const showFailure = (result: { message: string; fieldErrors?: Record<string, string> }) => {
    const fieldErrors = normalizeErrors(result.fieldErrors);
    // Un prezzo lasciato vuoto parte senza importo: il comando lo chiama «Valore non valido», il campo
    // vuoto è «Campo obbligatorio.» come gli altri.
    if (priceText.trim() === "" && "price" in fieldErrors) fieldErrors.price = REQUIRED;
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      setFormError(null);
      setErrorsShown((n) => n + 1);
    } else {
      setErrors({});
      setFormError(result.message);
    }
  };

  const submit = () => {
    // Un prezzo che non si legge ("abc") parte senza importo e il comando risponde «Valore non valido»
    // sotto il campo, insieme agli errori degli altri campi.
    const priceCents = parseEuroCents(priceText);
    const fields = {
      kind,
      name,
      invoiceDescription: description,
      durationMin,
      ...(priceCents === null ? {} : { priceCents }),
      color,
    };
    startSaving(async () => {
      if (service === null) {
        const result = await createServiceAction(fields);
        if (result.ok) {
          onClose();
          return;
        }
        showFailure(result);
        return;
      }
      const result = await updateServiceAction({ id: service.id, ...fields });
      if (result.ok) {
        onSaved({
          serviceId: service.id,
          oldPriceCents: result.data.oldPriceCents,
          futureAtOldPrice: result.data.futureAtOldPrice,
        });
        return;
      }
      showFailure(result);
    });
  };

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-1 flex-col gap-4 px-4"
      // I campi di testo arrivano qui; le scelte da un elenco e i colori chiamano `onDirty` da sé.
      onInput={onDirty}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field id={idOf("name")} label="Nome" error={errors.name}>
        <Input
          ref={nameRef}
          id={idOf("name")}
          value={name}
          maxLength={NAME_MAX}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
          {...described(idOf("name"), errors.name)}
        />
      </Field>

      <Field id={idOf("kind")} label="Tipo" error={errors.kind}>
        <Select
          items={KIND_ITEMS}
          value={kind}
          onValueChange={(value) => {
            if (value === null) return;
            onDirty();
            changeKind(value);
          }}
        >
          <SelectTrigger id={idOf("kind")} className="w-full" {...described(idOf("kind"), errors.kind)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={idOf("durationMin")} label="Durata" error={errors.durationMin}>
          <Select
            items={DURATION_ITEMS}
            value={durationMin}
            onValueChange={(value) => {
              if (value === null) return;
              onDirty();
              touched.current.duration = true;
              setDurationMin(value);
            }}
          >
            <SelectTrigger
              id={idOf("durationMin")}
              className="w-full"
              {...described(idOf("durationMin"), errors.durationMin)}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DURATION_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id={idOf("price")} label="Prezzo" error={errors.price}>
          <Input
            id={idOf("price")}
            inputMode="decimal"
            autoComplete="off"
            value={priceText}
            onChange={(event) => setPriceText(event.target.value)}
            {...described(idOf("price"), errors.price)}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-2">
        <span id={colorLabelId} className="text-sm leading-none font-medium">
          Colore <span className="font-normal text-muted-foreground">(obbligatorio)</span>
        </span>
        <RadioGroup
          aria-labelledby={colorLabelId}
          aria-describedby={errors.color === undefined ? undefined : `${idOf("color")}-errore`}
          value={color}
          onValueChange={(value) => {
            const next = COLORS.find((c) => c === value);
            if (next === undefined) return;
            onDirty();
            touched.current.color = true;
            setColor(next);
          }}
          className="grid-cols-2"
        >
          {COLORS.map((item) => (
            <Label key={item} className="min-h-6 font-normal">
              <RadioGroupItem value={item} aria-invalid={errors.color === undefined ? undefined : true} />
              <span aria-hidden="true" className={cn("inline-block h-4 w-6 rounded-sm", SERVICE_COLOR_CLASS[item])} />
              {COLOR_LABEL[item]}
            </Label>
          ))}
        </RadioGroup>
        {errors.color === undefined ? null : (
          <p id={`${idOf("color")}-errore`} className="text-sm text-destructive">
            {errors.color}
          </p>
        )}
      </div>

      <Field id={idOf("invoiceDescription")} label="Descrizione in fattura" error={errors.invoiceDescription}>
        <Input
          id={idOf("invoiceDescription")}
          value={description}
          maxLength={DESCRIPTION_MAX}
          autoComplete="off"
          onChange={(event) => setDescription(event.target.value)}
          {...described(idOf("invoiceDescription"), errors.invoiceDescription)}
        />
      </Field>

      {formError === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>{NOT_SAVED}</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <SheetFooter className="mt-auto px-0">
        <Button type="submit" disabled={saving}>
          Salva
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          Annulla
        </Button>
      </SheetFooter>
    </form>
  );
}

export function ServiceSheet({
  open,
  onOpenChange,
  service,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** La voce da modificare; null per una voce nuova. */
  service: ServiceRow | null;
}) {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement>(null);
  // La domanda sul prezzo vive qui e non nel modulo: il pannello si chiude, la domanda resta.
  const [question, setQuestion] = useState<(Saved & { open: boolean }) | null>(null);
  const [applying, startApplying] = useTransition();
  // Una voce cambiata non si butta con un clic fuori: Esc e "Annulla" chiudono ancora. A ogni
  // apertura il modulo riparte pulito.
  const [dirty, setDirty] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDirty(false);
  }

  const close = () => onOpenChange(false);

  const keep = () => setQuestion((current) => (current === null ? null : { ...current, open: false }));

  const update = () => {
    if (question === null) return;
    const { serviceId, oldPriceCents } = question;
    startApplying(async () => {
      const result = await applyPriceToFutureAction({ serviceId, oldPriceCents });
      keep();
      if (!result.ok) {
        toast.error(result.message);
        if (result.conflict) router.refresh();
      }
    });
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} disablePointerDismissal={dirty}>
        <SheetContent initialFocus={nameRef} className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{service === null ? "Nuova prestazione" : "Modifica prestazione"}</SheetTitle>
          </SheetHeader>
          {/* Il modulo nasce a ogni apertura: i campi ripartono dai valori della voce. */}
          <ServiceForm
            service={service}
            nameRef={nameRef}
            onDirty={() => setDirty(true)}
            onClose={() => startTransition(close)}
            onSaved={(saved) => {
              if (saved.futureAtOldPrice > 0) setQuestion({ ...saved, open: true });
              startTransition(close);
            }}
          />
        </SheetContent>
      </Sheet>
      {question === null ? null : (
        <PriceQuestion
          open={question.open}
          count={question.futureAtOldPrice}
          pending={applying}
          onUpdate={update}
          onKeep={keep}
        />
      )}
    </>
  );
}

/** "Nuova prestazione" dell'intestazione: il pulsante e il suo pannello. */
export function NewServiceButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Nuova prestazione
      </Button>
      <ServiceSheet open={open} onOpenChange={setOpen} service={null} />
    </>
  );
}
