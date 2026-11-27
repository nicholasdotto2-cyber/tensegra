"use client";

import { useRouter } from "next/navigation";
import {
  type ReactNode,
  type RefObject,
  startTransition,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";

import {
  bookingDefaultsAction,
  createAppointmentAction,
  previewAppointmentAction,
  suggestStartAction,
  updateAppointmentAction,
} from "@/app/(app)/agenda/actions";
import { currentDayAction } from "@/app/(app)/oggi/actions";
import { EMPTY_GUARDIAN, NewPatientFields, type NewPatientDraft } from "@/components/agenda/new-patient-fields";
import { choiceLabel, type PatientChoice, PatientPicker } from "@/components/agenda/patient-picker";
import { SedutaFattaPanel } from "@/components/agenda/seduta-fatta-panel";
import { SeriesPreview } from "@/components/agenda/series-preview";
import { CycleCloseDialog } from "@/components/cartella/cycle-close-dialog";
import { MessageComposer } from "@/components/messaggi/message-composer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { defaultSeriesCount, NEW_CYCLE_LABEL, newCycleKind, type ServiceKind } from "@/lib/agenda/defaults";
import { AGENDA_FIRST_DAY, AGENDA_LAST_DAY } from "@/lib/agenda/grid";
import { needsPastQuestion } from "@/lib/agenda/past-question";
import { clampToPicker, OUTSIDE_HOURS, PICKER_FIRST_MIN, PICKER_LAST_MIN } from "@/lib/agenda/slots";
import { VISIT_KEEPS_DAY } from "@/lib/agenda/status";
import { durationShort, isMinor, minutesLabel } from "@/lib/format";
import { centsToInput, parseEuroCents } from "@/lib/money";
import type { CreatedAppointments } from "@/server/domain/appointments/commands";
import type { AppointmentDetail, AppointmentPreview, BookingDefaults } from "@/server/domain/appointments/queries";

// Il dialogo "Nuovo appuntamento": i campi nel loro ordine.
// Scelto il paziente, prestazione, durata, prezzo, ciclo e sedute arrivano dai suoi default;
// data e ora sono quelle proposte finché non si toccano. A ogni cambio di data, ora, durata o
// ripetizione l'anteprima dice se l'orario è libero; niente blocca, si avvisa soltanto. Le regole le
// controlla il comando: il dialogo mostra i suoi errori sotto i campi e porta il focus al primo.
// In modo "Modifica" i campi partono dall'appuntamento, paziente e ciclo sono in sola
// lettura e la ripetizione non c'è; se un'altra finestra lo ha cambiato, il toast lo dice e la pagina si
// ricarica.

/** Una voce attiva del listino come la riceve il dialogo. */
export interface ServiceOption {
  id: string;
  name: string;
  kind: ServiceKind;
  durationMin: number;
  priceCents: number;
}

export interface AppointmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: readonly ServiceOption[];
  defaultIntervalWeeks: number;
  defaultExpectedSessions: number;
  /**
   * Una cella della griglia passa giorno e ora; "Fissa appuntamento" il paziente. `done` ("Nuova visita" della
   * Cartella): l'appuntamento nasce `fatto`, senza la domanda sull'orario passato.
   */
  prefill?: { day?: string; time?: string; patientId?: string; cycleId?: string; done?: boolean };
  onCreated?: (created: CreatedAppointments) => void;
  /** "Nuovo appuntamento", o "Modifica" di un appuntamento letto col dettaglio. */
  mode?: { kind: "create" } | { kind: "edit"; detail: AppointmentDetail };
  /** La modifica è salvata, o un'altra finestra l'aveva già cambiato: l'appuntamento va riletto. */
  onUpdated?: () => void;
  onMoved?: (appointmentId: string) => void;
  onConfirmMessage?: (created: CreatedAppointments) => void;
}

const TITLE = "Nuovo appuntamento";
const EDIT_TITLE = "Modifica appuntamento";
const NOT_SAVED = "Non ho salvato l'appuntamento. Riprova.";
const SAME_DAY = "L'appuntamento deve finire entro la stessa giornata.";
const PAST_QUESTION = "L'orario è già passato. Lo segno già come fatto?";
const BORN_DONE = "L'appuntamento nasce già fatto.";
const DONE_IN_FUTURE = "Un appuntamento già fatto non può essere in un giorno futuro.";
const NOTES_HINT = "Niente dati clinici qui: vanno nella visita.";

/** All'apertura l'orario si propone per 45 minuti. */
const OPENING_DURATION_MIN = 45;
const PREVIEW_DEBOUNCE_MS = 300;
const QUARTER_MIN = 15;
const NOTES_MAX = 300;

const range = (from: number, to: number, step = 1): number[] =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

// Le scelte dei campi: ora dalle 07:00 alle 21:00 e durata da 15 a 120 minuti a passi di 15, ripetizione
// ogni 1-4 settimane, da 2 a 12 sedute.
const TIME_ITEMS = range(PICKER_FIRST_MIN, PICKER_LAST_MIN, QUARTER_MIN).map((min) => {
  const label = minutesLabel(min);
  return { value: label, label };
});
const DURATION_ITEMS = range(15, 120, QUARTER_MIN).map((min) => ({ value: min, label: durationShort(min) }));
const INTERVAL_ITEMS = range(1, 4).map((weeks) => ({
  value: weeks,
  label: weeks === 1 ? "1 settimana" : `${weeks} settimane`,
}));
const COUNT_ITEMS = range(2, 12).map((count) => ({ value: count, label: String(count) }));
const STATUS_ITEMS = [
  { value: "prenotato", label: "Prenotato" },
  { value: "confermato", label: "Confermato" },
] as const;
type BookableStatus = (typeof STATUS_ITEMS)[number]["value"];

const EMPTY_DRAFT: NewPatientDraft = { firstName: "", lastName: "", birthDate: "", phone: "", guardian: EMPTY_GUARDIAN };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const validDay = (day: string): boolean => DAY_PATTERN.test(day) && day >= AGENDA_FIRST_DAY && day <= AGENDA_LAST_DAY;
const toMinutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Minore a oggi; una data a metà o dopo oggi non lo è ancora. */
function minorToday(birthDate: string, today: string | null): boolean {
  if (today === null || !DAY_PATTERN.test(birthDate) || birthDate > today) return false;
  try {
    return isMinor(birthDate, today);
  } catch {
    return false;
  }
}

/**
 * I percorsi degli errori del comando sui campi del dialogo: il paziente scelto, il ciclo e la
 * ripetizione rispondono ciascuno su un campo solo; quelli del paziente nuovo restano dove sono
 * (`patient.birthDate`).
 */
function fieldOf(path: string): string {
  if (path === "patient.patientId" || path === "patient.kind") return "patient";
  if (path.startsWith("cycle")) return "cycle";
  return path;
}

function normalizeErrors(fieldErrors: Record<string, string> | undefined): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [path, message] of Object.entries(fieldErrors ?? {})) {
    const field = fieldOf(path);
    if (!(field in errors)) errors[field] = message;
  }
  return errors;
}

/** Etichetta, campo, suggerimento ed errore con i loro id: l'errore sta sotto il campo. */
function Field({
  id,
  label,
  required,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="font-normal text-muted-foreground">(obbligatorio)</span> : null}
      </Label>
      {children}
      {hint === undefined ? null : (
        <p id={`${id}-suggerimento`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={`${id}-errore`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Gli attributi del campo per il suo errore e il suo suggerimento. */
function described(id: string, error: string | undefined, hint = false) {
  const ids = [hint ? `${id}-suggerimento` : null, error === undefined ? null : `${id}-errore`].filter(Boolean);
  return {
    "aria-invalid": error === undefined ? undefined : true,
    "aria-describedby": ids.length > 0 ? ids.join(" ") : undefined,
  } as const;
}

type CycleField = BookingDefaults["cycle"];

function AppointmentForm({
  services,
  defaultIntervalWeeks,
  defaultExpectedSessions,
  prefill,
  onOpenChange,
  onCreated,
  mode,
  onUpdated,
  onMoved,
  onConfirmMessage,
  patientRef,
  onDirty: markFormDirty,
}: Omit<AppointmentDialogProps, "open"> & {
  patientRef: RefObject<HTMLInputElement | null>;
  /** L'utente ha cambiato un campo: da qui un clic fuori non chiude più il dialogo. */
  onDirty: () => void;
}) {
  const router = useRouter();
  const editing = mode?.kind === "edit" ? mode.detail : null;
  // Con una visita il giorno resta, l'ora cambia: il comando ripete la regola.
  const dayFixed = editing !== null && editing.visit !== null;
  // "Nuova visita": l'appuntamento nasce fatto, qualunque sia l'ora.
  const bornDone = editing === null && prefill?.done === true;
  const baseId = useId();
  const idOf = (field: string) => `${baseId}-${field.replaceAll(".", "-")}`;
  const formRef = useRef<HTMLFormElement>(null);
  const firstNameRef = useRef<HTMLInputElement>(null);
  const cycleRef = useRef<HTMLInputElement>(null);
  // Il mantenimento è stato chiuso: il link che aveva aperto la finestra sparisce, il focus va al campo Ciclo.
  const maintenanceClosed = useRef(false);
  const repeatTextId = `${baseId}-ripeti`;
  const statusLabelId = `${baseId}-stato`;

  const [patient, setPatient] = useState<PatientChoice | null>(
    editing === null ? null : { kind: "existing", hit: editing.patient },
  );
  const [draft, setDraft] = useState<NewPatientDraft>(EMPTY_DRAFT);
  const [today, setToday] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(editing?.serviceId ?? null);
  const [day, setDay] = useState(editing?.edit.day ?? prefill?.day ?? "");
  const [time, setTime] = useState(() => {
    if (editing !== null) return editing.edit.time;
    return prefill?.time !== undefined && TIME_PATTERN.test(prefill.time)
      ? minutesLabel(clampToPicker(toMinutes(prefill.time)))
      : "";
  });
  const [durationMin, setDurationMin] = useState(editing?.edit.durationMin ?? OPENING_DURATION_MIN);
  const [cycle, setCycle] = useState<CycleField | null>(null);
  const [priceText, setPriceText] = useState(editing === null ? "" : centsToInput(editing.priceCents));
  const [repeat, setRepeat] = useState(false);
  const [intervalWeeks, setIntervalWeeks] = useState(defaultIntervalWeeks);
  const [count, setCount] = useState(defaultSeriesCount(defaultExpectedSessions, 0));
  const [status, setStatus] = useState<BookableStatus>(editing?.status === "confermato" ? "confermato" : "prenotato");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [preview, setPreview] = useState<{ key: string; data: AppointmentPreview } | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorsShown, setErrorsShown] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [askPast, setAskPast] = useState<{ revision: number; confirmMessage: boolean } | null>(null);
  const revision = useRef(0);
  const previewRequest = useRef(0);
  // L'input dell'anteprima a cui appartengono le date tolte: la rilettura dopo un submit le conserva.
  const excludedFor = useRef<string | null>(null);
  const submitting = useRef(false);
  const submitControl = useRef<HTMLElement | null>(null);
  const restoreSubmitFocus = useRef(false);
  const [checking, setChecking] = useState(false);
  // Il mantenimento aperto che "Chiudi il mantenimento" sta chiudendo.
  const [closingCycle, setClosingCycle] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const invalidateSubmission = () => {
    revision.current += 1;
    setAskPast(null);
  };
  const onDirty = () => {
    invalidateSubmission();
    markFormDirty();
  };
  useEffect(() => () => { revision.current += 1; }, []);

  // Data e ora proposte si ricalcolano finché l'utente non le tocca; una cella o la modifica le danno già.
  const touchedWhen = useRef(editing !== null || prefill?.day !== undefined || prefill?.time !== undefined);
  const suggestRequest = useRef(0);
  const defaultsRequest = useRef(0);

  const service = services.find((s) => s.id === serviceId) ?? null;

  const suggestFor = (minutes: number) => {
    if (touchedWhen.current) return;
    const request = ++suggestRequest.current;
    void suggestStartAction(minutes).then((result) => {
      if (request !== suggestRequest.current || touchedWhen.current || !result.ok) return;
      invalidateSubmission();
      setDay(result.data.day);
      setTime(result.data.time);
    });
  };

  const changeDuration = (minutes: number) => {
    setDurationMin(minutes);
    suggestFor(minutes);
  };

  /** La prestazione porta la sua durata e il suo prezzo; per un ciclo nuovo anche le sedute previste. */
  const applyService = (next: ServiceOption, nextCycle: CycleField | null) => {
    setServiceId(next.id);
    setPriceText(centsToInput(next.priceCents));
    if (nextCycle?.kind === "new") {
      const expected = newCycleKind(next.kind) === "trattamento" ? defaultExpectedSessions : null;
      setCount(defaultSeriesCount(expected, 0));
    }
    changeDuration(next.durationMin);
  };

  // Con keepService la prestazione scelta resta (dopo "Chiudi il mantenimento" serve proprio quella): cambiano
  // il ciclo, l'intervallo e, per un ciclo nuovo, le sedute.
  const applyDefaults = (defaults: BookingDefaults, keepService: boolean) => {
    invalidateSubmission();
    setPatient({ kind: "existing", hit: defaults.patient });
    setCycle(defaults.cycle);
    setIntervalWeeks(defaults.intervalWeeks);
    const proposed = keepService ? service : services.find((s) => s.id === defaults.serviceId);
    if (proposed) applyService(proposed, defaults.cycle);
    if (!keepService) setCount(defaults.seriesCount);
  };

  const loadDefaults = (patientId: string, keepService = false) => {
    const request = ++defaultsRequest.current;
    void bookingDefaultsAction(patientId).then((result) => {
      if (request !== defaultsRequest.current) return;
      if (result.ok) applyDefaults(result.data, keepService);
      else setErrors((prev) => ({ ...prev, patient: result.message }));
    });
  };

  const choosePatient = (choice: PatientChoice | null) => {
    onDirty();
    defaultsRequest.current += 1;
    setPatient(choice);
    setErrors((prev) => {
      const next = { ...prev };
      delete next.patient;
      return next;
    });
    if (choice === null) {
      // Il ciclo era di quel paziente.
      setCycle(null);
      return;
    }
    if (choice.kind === "existing") {
      loadDefaults(choice.hit.id);
      return;
    }
    // "Nuovo paziente: Font": il testo cercato va nel cognome; un paziente nuovo non ha
    // appuntamenti fatti né cicli, quindi prima visita e un ciclo di trattamento nuovo.
    setDraft({ ...EMPTY_DRAFT, lastName: choice.text });
    const newCycle: CycleField = { kind: "new" };
    setCycle(newCycle);
    const firstVisit = services.find((s) => s.kind === "prima_visita");
    if (firstVisit) applyService(firstVisit, newCycle);
    if (today === null) void currentDayAction().then(setToday);
    requestAnimationFrame(() => firstNameRef.current?.focus());
  };

  const onOpen = useEffectEvent(() => {
    if (editing !== null) return;
    if (prefill?.patientId !== undefined) loadDefaults(prefill.patientId);
    suggestFor(OPENING_DURATION_MIN);
  });
  useEffect(() => {
    onOpen();
  }, []);

  // L'anteprima, 300 ms dopo l'ultimo cambio di data, ora, durata o ripetizione. Le righe nuove
  // nascono tutte spuntate. Nella modifica l'appuntamento non si sovrappone a sé stesso.
  const editingId = editing?.id ?? null;
  const previewKey = JSON.stringify({ day, time, durationMin, repeat, intervalWeeks, count, editingId });
  useEffect(() => {
    if (submitting.current) return;
    if (!validDay(day) || !TIME_PATTERN.test(time)) return;
    let current = true;
    const request = ++previewRequest.current;
    const timer = setTimeout(() => {
      if (request !== previewRequest.current) return;
      void previewAppointmentAction({
        day,
        time,
        durationMin,
        ...(repeat ? { repeat: { intervalWeeks, count } } : {}),
        ...(editingId === null ? {} : { ignoreAppointmentId: editingId }),
      }).then((result) => {
        if (!current || request !== previewRequest.current) return;
        setPreview(result.ok ? { key: previewKey, data: result.data } : null);
        if (excludedFor.current !== previewKey) {
          excludedFor.current = previewKey;
          setExcluded(new Set());
        }
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [day, time, durationMin, repeat, intervalWeeks, count, editingId, previewKey, checking]);

  // Dopo un salvataggio rifiutato il focus va al primo campo in errore, nell'ordine della pagina.
  useEffect(() => {
    if (errorsShown === 0 || saving || checking) return;
    formRef.current?.querySelector<HTMLElement>("[aria-invalid='true'], [data-invalid='true']")?.focus();
  }, [errorsShown, saving, checking]);

  useEffect(() => {
    if (saving || checking || !restoreSubmitFocus.current) return;
    restoreSubmitFocus.current = false;
    submitControl.current?.focus();
  }, [saving, checking, formError]);

  const shownPreview = preview?.key === previewKey ? preview.data : null;
  const rows = repeat ? (shownPreview?.rows ?? []) : [];
  const overlapping = repeat
    ? rows.some((row) => row.state === "sovrapposto" && !excluded.has(row.day))
    : (shownPreview?.warnings.some((warning) => warning !== OUTSIDE_HOURS) ?? false);
  // Se il comando chiede il genitore (il giorno di oggi non è ancora arrivato), il blocco si apre comunque.
  const minor =
    patient?.kind === "new" &&
    (minorToday(draft.birthDate, today) || Object.keys(errors).some((path) => path.startsWith("patient.guardian.")));
  // Un mantenimento aperto e una prestazione che apre un ciclo di trattamento: prima si chiude il mantenimento.
  const maintenanceToClose =
    editing === null &&
    cycle?.kind === "existing" &&
    cycle.cycleKind === "mantenimento" &&
    (service?.kind === "prima_visita" || service?.kind === "seduta")
      ? cycle.cycleId
      : null;
  const cycleText =
    editing !== null
      ? editing.cycleTitle
      : cycle === null
        ? ""
        : cycle.kind === "existing"
          ? cycle.title
          : NEW_CYCLE_LABEL[newCycleKind(service?.kind ?? "prima_visita")];
  // La voce dell'appuntamento resta fra le scelte anche se nel frattempo è stata archiviata.
  const serviceItems = services.map((s) => ({ value: s.id, label: s.name }));
  if (editing !== null && !services.some((s) => s.id === editing.serviceId)) {
    serviceItems.unshift({ value: editing.serviceId, label: editing.serviceName });
  }
  // Un orario salvato fuori dalla scelta (le 22:00) resta quello dell'appuntamento.
  const timeItems =
    time === "" || TIME_ITEMS.some((item) => item.value === time)
      ? TIME_ITEMS
      : [...TIME_ITEMS, { value: time, label: time }].sort((a, b) => (a.value < b.value ? -1 : 1));
  const timeError = errors.time ?? (shownPreview?.endsNextDay ? SAME_DAY : undefined);

  const touchWhen = () => {
    onDirty();
    touchedWhen.current = true;
    suggestRequest.current += 1;
  };

  const patientInput = () => {
    if (patient === null) return undefined;
    if (patient.kind === "existing") return { kind: "existing" as const, patientId: patient.hit.id };
    return {
      kind: "new" as const,
      firstName: draft.firstName,
      lastName: draft.lastName,
      birthDate: draft.birthDate,
      phone: draft.phone,
      ...(minor ? { guardian: draft.guardian } : {}),
    };
  };

  const showErrors = (next: Record<string, string>) => {
    setErrors(next);
    setFormError(null);
    setErrorsShown((n) => n + 1);
  };

  const showFailure = (result: { message: string; fieldErrors?: Record<string, string> }) => {
    const fieldErrors = normalizeErrors(result.fieldErrors);
    // Un appuntamento nato fatto può essere rifiutato solo perché il giorno è futuro.
    if (bornDone && fieldErrors.status !== undefined) fieldErrors.status = DONE_IN_FUTURE;
    if (Object.keys(fieldErrors).length > 0) {
      showErrors(fieldErrors);
    } else {
      setErrors({});
      setFormError(result.message);
      restoreSubmitFocus.current = true;
    }
  };

  const saveEdit = (detail: AppointmentDetail) => {
    const priceCents = parseEuroCents(priceText);
    const input = {
      id: detail.id,
      expectedUpdatedAt: detail.edit.updatedAt,
      serviceId: serviceId ?? undefined,
      day,
      time,
      durationMin,
      ...(priceCents === null ? {} : { priceCents }),
      status,
      notes,
    };
    startSaving(async () => {
      const result = await updateAppointmentAction(input);
      if (result.ok || result.conflict) {
        startTransition(() => onOpenChange(false));
        onUpdated?.();
      }
      if (result.ok) {
        if (result.data.movedFromConfirmed) onMoved?.(detail.id);
        return;
      }
      if (result.conflict) {
        // Un'altra finestra ha scritto: i dati del dialogo sono vecchi.
        toast(result.message);
        router.refresh();
        return;
      }
      showFailure(result);
    });
  };

  const save = (options: { asDone?: boolean; confirmedRevision?: number; confirmMessage?: boolean } = {}, control?: HTMLElement | null) => {
    if (submitting.current || saving) return;
    // La risposta alla domanda conserva il controllo che aveva avviato il salvataggio.
    if (options.confirmedRevision === undefined) submitControl.current = control ?? null;
    if (editing !== null) {
      saveEdit(editing);
      return;
    }
    // Una visita già fatta non è in un giorno futuro: lo si dice sul campo, senza chiamare il comando.
    if (bornDone && prefill?.day !== undefined && DAY_PATTERN.test(day) && day > prefill.day) {
      showErrors({ day: DONE_IN_FUTURE });
      return;
    }
    const priceCents = parseEuroCents(priceText);
    // Un orario passato chiede se segnarlo già come fatto, ma solo per un modulo completo: senza
    // paziente la risposta è l'errore sul campo. Una serie resta prenotata.
    const complete = patient !== null && serviceId !== null && priceCents !== null;
    const snapshotRevision = revision.current;
    const confirmedChoice = options.confirmedRevision === snapshotRevision;
    const input = {
      patient: patientInput(),
      serviceId: serviceId ?? undefined,
      day,
      time,
      durationMin,
      // Senza paziente l'errore è sul paziente, non sul ciclo.
      cycle: cycle?.kind === "existing" ? { kind: "existing" as const, cycleId: cycle.cycleId } : { kind: "new" as const },
      // Un prezzo che il modulo non sa leggere ("abc") non parte: il comando lo segnala come mancante,
      // con "Valore non valido" sotto il campo, insieme agli altri errori.
      ...(priceCents === null ? {} : { priceCents }),
      status: bornDone || (confirmedChoice && options.asDone) ? ("fatto" as const)
        : confirmedChoice ? ("prenotato" as const) : status,
      notes,
      ...(repeat ? { repeat: { intervalWeeks, count, excludedDays: [...excluded] } } : {}),
    };
    submitting.current = true;
    setChecking(true);
    // Invalida anche una richiesta del debounce già partita. Il submit verifica sempre questo input,
    // anche quando l'anteprima visibile è di un orario precedente o non è ancora arrivata.
    const request = ++previewRequest.current;
    startSaving(async () => {
      try {
        if (complete && validDay(day) && TIME_PATTERN.test(time)) {
          const result = await previewAppointmentAction({
            day, time, durationMin, ...(repeat ? { repeat: { intervalWeeks, count } } : {}),
          });
          if (snapshotRevision !== revision.current || request !== previewRequest.current) return;
          if (!result.ok) { showFailure(result); return; }
          setPreview({ key: previewKey, data: result.data });
          if (needsPastQuestion({ complete, bornDone, repeat, pastStart: result.data.pastStart, confirmedChoice })) {
            setAskPast({ revision: snapshotRevision, confirmMessage: options.confirmMessage === true });
            return;
          }
        }
        const saved = await createAppointmentAction(input);
        if (saved.ok) {
          startTransition(() => onOpenChange(false));
          onCreated?.(saved.data);
          if (options.confirmMessage && saved.data.appointments[0]?.status !== "fatto") onConfirmMessage?.(saved.data);
          return;
        }
        if (snapshotRevision !== revision.current) return;
        showFailure(saved);
      } catch {
        if (snapshotRevision === revision.current) {
          setErrors({});
          setFormError(NOT_SAVED);
          restoreSubmitFocus.current = true;
        }
      } finally {
        submitting.current = false;
        setChecking(false);
      }
    });
  };

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-4"
      // I campi di testo (paziente cercato, paziente nuovo, data, prezzo, note) arrivano qui; le scelte
      // da un elenco, la casella e i pulsanti di scelta chiamano `onDirty` da sé.
      onInput={onDirty}
      onSubmit={(event) => {
        event.preventDefault();
        save({}, (event.nativeEvent as SubmitEvent).submitter);
      }}
    >
      <fieldset disabled={saving || checking} className="contents">
      <Field id={idOf("patient")} label="Paziente" required error={errors.patient}>
        {editing === null ? (
          <PatientPicker
            id={idOf("patient")}
            value={patient}
            onChange={choosePatient}
            inputRef={patientRef}
            invalid={errors.patient !== undefined}
            describedBy={errors.patient === undefined ? undefined : `${idOf("patient")}-errore`}
          />
        ) : (
          // Paziente e ciclo non cambiano con la modifica.
          <Input
            id={idOf("patient")}
            ref={patientRef}
            readOnly
            value={choiceLabel({ kind: "existing", hit: editing.patient })}
            className="bg-transparent"
            {...described(idOf("patient"), errors.patient)}
          />
        )}
      </Field>
      {patient?.kind === "new" ? (
        <NewPatientFields draft={draft} onChange={setDraft} minor={minor} errors={errors} firstFieldRef={firstNameRef} />
      ) : null}

      <Field id={idOf("serviceId")} label="Prestazione" required error={errors.serviceId}>
        <Select
          items={serviceItems}
          value={serviceId}
          onValueChange={(id) => {
            const next = services.find((s) => s.id === id);
            onDirty();
            if (next) applyService(next, cycle);
          }}
        >
          <SelectTrigger id={idOf("serviceId")} className="w-full" {...described(idOf("serviceId"), errors.serviceId)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {serviceItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="flex flex-col">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field id={idOf("day")} label="Data" hint={dayFixed ? VISIT_KEEPS_DAY : undefined} error={errors.day}>
            <Input
              id={idOf("day")}
              type="date"
              value={day}
              min={AGENDA_FIRST_DAY}
              // Nato fatto: non oltre oggi (`prefill.day`); la regola la ripete il comando.
              max={bornDone && prefill?.day !== undefined ? prefill.day : AGENDA_LAST_DAY}
              disabled={dayFixed}
              onChange={(event) => {
                touchWhen();
                setDay(event.target.value);
              }}
              {...described(idOf("day"), errors.day, dayFixed)}
            />
          </Field>
          <Field id={idOf("time")} label="Ora di inizio" error={timeError}>
            <Select
              items={timeItems}
              value={time === "" ? null : time}
              onValueChange={(value) => {
                if (value === null) return;
                touchWhen();
                setTime(value);
              }}
            >
              <SelectTrigger id={idOf("time")} className="w-full tabular-nums" {...described(idOf("time"), timeError)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {timeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value} className="tabular-nums">
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id={idOf("durationMin")} label="Durata" error={errors.durationMin}>
            <Select
              items={DURATION_ITEMS}
              value={durationMin}
              onValueChange={(value) => {
                if (value === null) return;
                onDirty();
                changeDuration(value);
              }}
            >
              <SelectTrigger id={idOf("durationMin")} className="w-full" {...described(idOf("durationMin"), errors.durationMin)}>
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
        </div>
        {/* La regione resta montata finché il dialogo è aperto e cambia solo il contenuto: un lettore di
            schermo annuncia gli avvisi solo dentro una regione che c'era già (WCAG 4.1.3). La fine dopo la
            mezzanotte è anche sotto il campo dell'ora; qui la si annuncia. */}
        <div aria-live="polite" data-slot="time-warnings">
          {shownPreview && shownPreview.warnings.length > 0 ? (
            <ul className="mt-4 flex flex-col gap-1 rounded-lg bg-warning px-3 py-2 text-sm text-warning-foreground">
              {shownPreview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {shownPreview?.endsNextDay ? <p className="sr-only">{SAME_DAY}</p> : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <Field id={idOf("cycle")} label="Ciclo" required error={errors.cycle}>
          {/* Il ciclo aperto è l'unica scelta, altrimenti se ne apre uno nuovo. */}
          <Input id={idOf("cycle")} ref={cycleRef} readOnly value={cycleText} className="bg-transparent" {...described(idOf("cycle"), errors.cycle)} />
          {maintenanceToClose === null ? null : (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="self-start px-0"
              onClick={() => {
                maintenanceClosed.current = false;
                setClosingCycle(maintenanceToClose);
              }}
            >
              Chiudi il mantenimento
            </Button>
          )}
        </Field>
        <Field id={idOf("priceCents")} label="Prezzo concordato" error={errors.priceCents}>
          <Input
            id={idOf("priceCents")}
            inputMode="decimal"
            autoComplete="off"
            value={priceText}
            onChange={(event) => setPriceText(event.target.value)}
            {...described(idOf("priceCents"), errors.priceCents)}
          />
        </Field>
      </div>

      {editing !== null || bornDone ? null : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex min-h-8 items-center gap-2">
              <Checkbox
                id={idOf("repeat")}
                aria-labelledby={repeatTextId}
                checked={repeat}
                onCheckedChange={(checked) => {
                  onDirty();
                  setRepeat(checked);
                }}
              />
              <Label id={repeatTextId} htmlFor={idOf("repeat")}>
                Ripeti ogni
              </Label>
            </div>
            {repeat ? (
              <Select
                items={INTERVAL_ITEMS}
                value={intervalWeeks}
                onValueChange={(value) => {
                  if (value === null) return;
                  onDirty();
                  setIntervalWeeks(value);
                }}
              >
                <SelectTrigger aria-labelledby={repeatTextId} {...described(idOf("repeat.intervalWeeks"), errors["repeat.intervalWeeks"])}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          {repeat ? (
            <>
              <Field id={idOf("repeat.count")} label="Numero di sedute in totale" error={errors["repeat.count"]}>
                <Select
                  items={COUNT_ITEMS}
                  value={count}
                  onValueChange={(value) => {
                    if (value === null) return;
                    onDirty();
                    setCount(value);
                  }}
                >
                  <SelectTrigger id={idOf("repeat.count")} className="w-24" {...described(idOf("repeat.count"), errors["repeat.count"])}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNT_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {rows.length > 0 ? (
                <SeriesPreview
                  rows={rows}
                  excluded={excluded}
                  invalid={errors["repeat.excludedDays"] !== undefined}
                  onToggle={(rowDay, included) => {
                    onDirty();
                    // Le righe mostrate sono sempre dell'input corrente.
                    excludedFor.current = previewKey;
                    setExcluded((prev) => {
                      const next = new Set(prev);
                      if (included) next.delete(rowDay);
                      else next.add(rowDay);
                      return next;
                    });
                  }}
                />
              ) : null}
              {errors["repeat.excludedDays"] === undefined ? null : (
                <p className="text-sm text-destructive">{errors["repeat.excludedDays"]}</p>
              )}
            </>
          ) : null}
        </div>
      )}

      {bornDone ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm">{BORN_DONE}</p>
          {errors.status === undefined ? null : (
            // Il comando risponde sul campo «status»: senza il gruppo Stato l'errore sta sotto la frase e prende il focus.
            <p tabIndex={-1} data-invalid="true" className="text-sm text-destructive outline-none">
              {errors.status}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span id={statusLabelId} className="text-sm leading-none font-medium">
            Stato
          </span>
          <RadioGroup
            aria-labelledby={statusLabelId}
            value={status}
            onValueChange={(value) => {
              onDirty();
              setStatus(value === "confermato" ? "confermato" : "prenotato");
            }}
            className="flex flex-wrap gap-x-6"
          >
            {STATUS_ITEMS.map((item) => (
              <Label key={item.value} className="min-h-6 font-normal">
                <RadioGroupItem value={item.value} />
                {item.label}
              </Label>
            ))}
          </RadioGroup>
          {errors.status === undefined ? null : <p className="text-sm text-destructive">{errors.status}</p>}
        </div>
      )}

      <Field id={idOf("notes")} label="Note" hint={NOTES_HINT} error={errors.notes}>
        <Textarea
          id={idOf("notes")}
          maxLength={NOTES_MAX}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          {...described(idOf("notes"), errors.notes, true)}
        />
      </Field>

      {formError === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>{NOT_SAVED}</AlertTitle>
          {formError === NOT_SAVED ? null : <AlertDescription>{formError}</AlertDescription>}
        </Alert>
      )}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Annulla</DialogClose>
        {editing === null && !bornDone && onConfirmMessage !== undefined ? (
          <Button type="button" variant="outline" disabled={saving || checking}
            aria-describedby={repeat ? `${baseId}-conferma-serie` : undefined}
            onClick={(event) => save({ confirmMessage: true }, event.currentTarget)}>
            Salva e copia la conferma
          </Button>
        ) : null}
        <Button type="submit" disabled={saving || checking}>
          {overlapping ? "Salva comunque" : "Salva"}
        </Button>
      </DialogFooter>
      {repeat && onConfirmMessage !== undefined ? (
        <p id={`${baseId}-conferma-serie`} className="text-sm text-muted-foreground">Conferma del primo appuntamento</p>
      ) : null}
      </fieldset>

      <AlertDialog open={askPast !== null} onOpenChange={(open) => { if (!open) setAskPast(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{PAST_QUESTION}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (askPast === null) return;
                const choice = askPast;
                setAskPast(null);
                save({ confirmedRevision: choice.revision, confirmMessage: choice.confirmMessage });
              }}
            >
              No, lascia prenotato
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (askPast === null) return;
                const choice = askPast;
                setAskPast(null);
                save({ asDone: true, confirmedRevision: choice.revision, confirmMessage: choice.confirmMessage });
              }}
            >
              Sì, è fatto
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Il suo invio sale fino a questo modulo attraverso il portale (React): la finestra lo ferma da sé. */}
      <CycleCloseDialog
        cycleId={closingCycle}
        onClose={() => setClosingCycle(null)}
        onClosed={() => {
          maintenanceClosed.current = true;
          if (patient?.kind === "existing") loadDefaults(patient.hit.id, true);
        }}
        finalFocus={() => (maintenanceClosed.current ? cycleRef.current : true)}
      />
    </form>
  );
}

export function AppointmentDialog({ open, ...props }: AppointmentDialogProps) {
  const patientRef = useRef<HTMLInputElement>(null);
  // Un modulo cambiato non si butta con un clic fuori: Esc e "Annulla" chiudono ancora. A ogni
  // apertura il modulo riparte pulito.
  const [dirty, setDirty] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDirty(false);
  }
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange} disablePointerDismissal={dirty}>
      <DialogContent initialFocus={patientRef} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{props.mode?.kind === "edit" ? EDIT_TITLE : TITLE}</DialogTitle>
        </DialogHeader>
        {/* Il modulo nasce a ogni apertura: i campi ripartono dai default. */}
        <AppointmentForm {...props} patientRef={patientRef} onDirty={() => setDirty(true)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Il primo appuntamento creato già fatto (con "Sì, è fatto"): il pannello "Seduta fatta" si apre su di
 * lui. Una serie resta prenotata, quindi non c'è.
 */
export function createdDone(created: CreatedAppointments): string | null {
  return created.appointments.find((a) => a.status === "fatto")?.id ?? null;
}

/** "Nuovo appuntamento" dell'intestazione di Oggi e "Fissa appuntamento" dei richiami. */
export function NewAppointmentButton({
  services,
  defaultIntervalWeeks,
  defaultExpectedSessions,
  prefill,
  label = TITLE,
  variant = "default",
}: {
  services: readonly ServiceOption[];
  defaultIntervalWeeks: number;
  defaultExpectedSessions: number;
  prefill?: AppointmentDialogProps["prefill"];
  label?: string;
  variant?: "default" | "outline";
}) {
  const [open, setOpen] = useState(false);
  const [doneId, setDoneId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const booking = { services, defaultIntervalWeeks, defaultExpectedSessions };
  return (
    <>
      <Button type="button" variant={variant} size={variant === "outline" ? "sm" : "default"} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AppointmentDialog
        open={open}
        onOpenChange={setOpen}
        {...booking}
        prefill={prefill}
        onCreated={(created) => setDoneId(createdDone(created))}
        onConfirmMessage={(created) => setConfirmId(created.appointments[0]?.id ?? null)}
      />
      <SedutaFattaPanel appointmentId={doneId} onClose={() => setDoneId(null)} {...booking} />
      <MessageComposer source={confirmId === null ? null : { kind: "appointment", appointmentId: confirmId, templateKey: "conferma" }}
        onClose={() => setConfirmId(null)} />
    </>
  );
}
