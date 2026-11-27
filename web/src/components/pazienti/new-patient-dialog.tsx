"use client";

import { useRouter } from "next/navigation";
import { type RefObject, startTransition, useEffect, useRef, useState, useTransition } from "react";

import { createPatientAction } from "@/app/(app)/pazienti/actions";
import { AppointmentDialog, createdDone, type ServiceOption } from "@/components/agenda/appointment-dialog";
import { EMPTY_GUARDIAN, type NewPatientDraft, NewPatientFields } from "@/components/agenda/new-patient-fields";
import { SedutaFattaPanel } from "@/components/agenda/seduta-fatta-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isMinor } from "@/lib/format";
import { patientHref } from "@/lib/patients/params";

// Il dialogo "Nuovo paziente" della lista: nome, cognome, data di nascita e telefono, e per
// un minore il blocco "Genitore o tutore". I campi sono quelli del mini modulo dell'agenda
// (`NewPatientFields`). "Salva e apri la scheda" porta alla scheda; "Salva e fissa un appuntamento"
// apre il dialogo dell'appuntamento sul paziente appena creato. Le regole le controlla il comando: il
// dialogo mostra i suoi errori sotto i campi e porta il focus al primo.

export interface NewPatientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Il cognome già scritto, per esempio il testo che la ricerca non ha trovato. */
  initialLastName?: string;
  /** Oggi, "AAAA-MM-GG": dice se la data di nascita è di un minore. */
  today: string;
  services: readonly ServiceOption[];
  defaultIntervalWeeks: number;
  defaultExpectedSessions: number;
}

const TITLE = "Nuovo paziente";
const NOT_SAVED = "Non ho salvato il paziente. Riprova.";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** I percorsi degli errori del comando che `NewPatientFields` mostra sotto un campo. */
const FIELD_PATHS = new Set([
  "firstName",
  "lastName",
  "birthDate",
  "phone",
  "guardian",
  "guardian.firstName",
  "guardian.lastName",
  "guardian.phone",
]);

/** Minore a oggi; una data a metà o dopo oggi non lo è ancora. */
function minorOn(birthDate: string, today: string): boolean {
  if (!DAY_PATTERN.test(birthDate) || birthDate > today) return false;
  try {
    return isMinor(birthDate, today);
  } catch {
    return false;
  }
}

const hasText = (guardian: NewPatientDraft["guardian"]): boolean =>
  [guardian.firstName, guardian.lastName, guardian.phone].some((part) => part.trim() !== "");

type After = "open" | "book";

function NewPatientForm({
  initialLastName,
  today,
  firstFieldRef,
  onOpenChange,
  onBook,
  onDirty,
}: {
  initialLastName: string;
  today: string;
  firstFieldRef: RefObject<HTMLInputElement | null>;
  onOpenChange: (open: boolean) => void;
  onBook: (patientId: string) => void;
  onDirty: () => void;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<NewPatientDraft>({
    firstName: "",
    lastName: initialLastName,
    birthDate: "",
    phone: "",
    guardian: EMPTY_GUARDIAN,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorsShown, setErrorsShown] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  // Un salvataggio parte una volta sola: finché dura, e dopo che è riuscito, i due pulsanti e Invio
  // non ne fanno partire un altro (il paziente sarebbe creato due volte).
  const busy = useRef(false);
  const [saved, setSaved] = useState(false);

  // Dopo un salvataggio rifiutato il focus va al primo campo in errore, nell'ordine della pagina.
  useEffect(() => {
    if (errorsShown === 0) return;
    formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [errorsShown]);

  // Se il comando chiede il genitore, il blocco si apre comunque.
  const minor = minorOn(draft.birthDate, today) || Object.keys(errors).some((path) => path.startsWith("patient.guardian"));

  const save = (after: After) => {
    if (busy.current) return;
    busy.current = true;
    // Un genitore lasciato in bianco non parte: così il comando risponde con la sua frase per il minore.
    const guardian = minor && hasText(draft.guardian) ? { guardian: draft.guardian } : {};
    const input = {
      firstName: draft.firstName,
      lastName: draft.lastName,
      birthDate: draft.birthDate,
      phone: draft.phone,
      ...guardian,
    };
    startSaving(async () => {
      const result = await createPatientAction(input);
      if (result.ok) {
        setSaved(true);
        // Il dialogo si chiude insieme alla pagina che segue (guida `interactive-apps`, passo 6).
        startTransition(() => {
          onOpenChange(false);
          if (after === "open") router.push(patientHref(result.data.id));
        });
        if (after === "book") onBook(result.data.id);
        return;
      }
      busy.current = false;
      const entries = Object.entries(result.fieldErrors ?? {});
      if (entries.length > 0 && entries.every(([path]) => FIELD_PATHS.has(path))) {
        setErrors(Object.fromEntries(entries.map(([path, message]) => [`patient.${path}`, message])));
        setFormError(null);
        setErrorsShown((n) => n + 1);
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
      // I campi di testo arrivano qui: da questo momento un clic fuori non chiude più il dialogo.
      onChange={onDirty}
      onSubmit={(event) => {
        event.preventDefault();
        save("open");
      }}
    >
      <NewPatientFields
        draft={draft}
        onChange={setDraft}
        minor={minor}
        errors={errors}
        firstFieldRef={firstFieldRef}
        bare
      />

      {formError === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>{NOT_SAVED}</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Annulla</DialogClose>
        <Button type="button" variant="outline" disabled={saving || saved} onClick={() => save("book")}>
          Salva e fissa un appuntamento
        </Button>
        <Button type="submit" disabled={saving || saved}>
          Salva e apri la scheda
        </Button>
      </DialogFooter>
    </form>
  );
}

export function NewPatientDialog({
  open,
  onOpenChange,
  initialLastName = "",
  today,
  services,
  defaultIntervalWeeks,
  defaultExpectedSessions,
}: NewPatientDialogProps) {
  const firstFieldRef = useRef<HTMLInputElement>(null);
  // Un modulo cambiato non si butta con un clic fuori: Esc e "Annulla" chiudono ancora. A ogni
  // apertura il modulo riparte pulito.
  const [dirty, setDirty] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDirty(false);
  }
  // Il paziente appena creato per cui si fissa l'appuntamento, e l'appuntamento creato già fatto.
  const [bookingFor, setBookingFor] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const booking = { services, defaultIntervalWeeks, defaultExpectedSessions };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal={dirty}>
        <DialogContent initialFocus={firstFieldRef} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{TITLE}</DialogTitle>
          </DialogHeader>
          {/* Il modulo nasce a ogni apertura: i campi ripartono vuoti, col cognome già scritto. */}
          <NewPatientForm
            initialLastName={initialLastName}
            today={today}
            firstFieldRef={firstFieldRef}
            onOpenChange={onOpenChange}
            onBook={setBookingFor}
            onDirty={() => setDirty(true)}
          />
        </DialogContent>
      </Dialog>
      <AppointmentDialog
        open={bookingFor !== null}
        onOpenChange={(next) => {
          if (!next) setBookingFor(null);
        }}
        {...booking}
        prefill={bookingFor === null ? undefined : { patientId: bookingFor }}
        onCreated={(created) => setDoneId(createdDone(created))}
      />
      <SedutaFattaPanel appointmentId={doneId} onClose={() => setDoneId(null)} {...booking} />
    </>
  );
}

/** "Nuovo paziente" dell'intestazione e "Crea Rossi come nuovo paziente" del vuoto della ricerca. */
export function NewPatientButton({
  label = TITLE,
  ...props
}: Omit<NewPatientDialogProps, "open" | "onOpenChange"> & { label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <NewPatientDialog open={open} onOpenChange={setOpen} {...props} />
    </>
  );
}
