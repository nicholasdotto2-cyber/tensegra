"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { closeCycleAction, createReferralAction } from "@/app/(app)/pazienti/[id]/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  type Cadence,
  CADENCE_NONE,
  CADENCE_OTHER,
  CADENCE_PRESETS,
  buildCloseCycleInput,
  type CloseOutcome,
  defaultCadence,
  initialCadence,
  isScoring,
  mapCloseErrors,
  MAX_WEEKS,
  MIN_WEEKS,
  OUTCOMES,
  parseOtherWeeks,
  SCORE_MAX,
} from "@/lib/cartella/close-cycle-form";
import { CYCLE_OUTCOME_LABEL, PSFS_SCALE_HINT, PSFS_TITLE, REFERRAL_FIRST } from "@/lib/clinical/labels";
import type { CycleClosingView } from "@/server/domain/cycles/queries";

// Il modulo della finestra "Chiudi ciclo". Cosa si manda al
// comando e come si leggono i suoi errori sta in `lib/cartella/close-cycle-form.ts`, con i suoi test; qui ci
// sono i campi, il focus e le chiamate.

const NOT_CLOSED = "Non ho chiuso il ciclo. Riprova.";
const CLOSED = "Ciclo chiuso.";
const NO_RECALL_DATE = "Il richiamo parte dall'ultima seduta fatta.";
const NO_DRAFT_HINT = "I punteggi finali si scrivono su una visita in bozza senza punteggi: qui non ce n'è una.";
const NOTE_MAX = 1000;

/** Il testo "Richiamo il 03/12/2026" di una cadenza; null senza sedute fatte o fuori scala. */
function recallText(view: CycleClosingView, weeks: number): string | null {
  return view.recallChoices?.find((c) => c.weeks === weeks)?.text ?? null;
}

export function CloseForm({
  view,
  onClose,
  onClosed,
}: {
  view: CycleClosingView;
  onClose: () => void;
  onClosed?: () => void;
}) {
  const router = useRouter();
  const baseId = useId();
  const idOf = (field: string) => `${baseId}-${field}`;
  const formRef = useRef<HTMLFormElement>(null);
  const firstOutcomeRef = useRef<HTMLButtonElement>(null);

  const start = initialCadence(view.proposedWeeks);
  const [outcome, setOutcome] = useState<CloseOutcome | null>(null);
  const [note, setNote] = useState("");
  const [closedOn, setClosedOn] = useState(view.today);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [notReturned, setNotReturned] = useState(false);
  const [cadence, setCadence] = useState<Cadence>(start.cadence);
  const [cadenceTouched, setCadenceTouched] = useState(false);
  const [other, setOther] = useState(start.other);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorsShown, setErrorsShown] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [preparing, startPreparing] = useTransition();

  // Il focus va al primo esito appena la finestra ha i suoi dati (prima c'era lo scheletro).
  useEffect(() => {
    firstOutcomeRef.current?.focus();
  }, []);
  // Dopo un salvataggio rifiutato il focus va al primo campo in errore, nell'ordine della finestra.
  useEffect(() => {
    if (errorsShown === 0) return;
    formRef.current?.querySelector<HTMLElement>("[aria-invalid='true'], [data-invalid='true']")?.focus();
  }, [errorsShown]);

  const hasActivities = view.psfs.length > 0;
  const scoring = isScoring(view, notReturned);
  const needsLetter = outcome === "rinviato_al_medico" && !view.hasReferral;
  const otherWeeks = parseOtherWeeks(other);

  const clearErrors = (...keys: string[]) =>
    setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !keys.includes(key))));

  const showErrors = (next: Record<string, string>) => {
    setErrors(next);
    setFormError(null);
    setErrorsShown((n) => n + 1);
  };

  const chooseOutcome = (next: CloseOutcome) => {
    setOutcome(next);
    clearErrors("outcome", "letter");
    // «Rinviato al medico» propone «Nessun richiamo», se la cadenza non è già stata scelta.
    if (!cadenceTouched) setCadence(defaultCadence(next, start.cadence));
  };

  const submit = () => {
    const built = buildCloseCycleInput(view, { outcome, note, closedOn, scores, notReturned, cadence, other });
    if (!built.ok) {
      showErrors(built.errors);
      return;
    }
    startSaving(async () => {
      const result = await closeCycleAction(built.input);
      if (result.ok) {
        toast.success(CLOSED);
        onClosed?.();
        onClose();
        return;
      }
      const fieldErrors = mapCloseErrors(result.fieldErrors);
      if (Object.keys(fieldErrors).length > 0) {
        showErrors(fieldErrors);
      } else {
        setErrors({});
        setFormError(result.message);
      }
    });
  };

  const prepareLetter = () => {
    startPreparing(async () => {
      const result = await createReferralAction({ patientId: view.patientId, cycleId: view.cycleId });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      onClose();
      router.push(`/pazienti/${result.data.patientId}/rinvii/${result.data.id}`);
    });
  };

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        // La finestra può stare dentro un altro modulo (dialogo dell'appuntamento): il suo invio non deve salire.
        event.stopPropagation();
        submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline gap-1 text-sm leading-none">
          <span id={idOf("esito")} className="font-medium">
            Esito del ciclo
          </span>
          <span className="text-muted-foreground">(obbligatorio)</span>
        </div>
        <div
          role="group"
          aria-labelledby={idOf("esito")}
          aria-describedby={errors.outcome === undefined ? undefined : idOf("esito-errore")}
          className="flex flex-wrap gap-2"
        >
          {OUTCOMES.map((code, index) => (
            <Button
              key={code}
              ref={index === 0 ? firstOutcomeRef : undefined}
              type="button"
              size="sm"
              variant={outcome === code ? "default" : "outline"}
              aria-pressed={outcome === code}
              // Un pulsante non ha `aria-invalid`: l'errore lo dice il gruppo (`aria-describedby`), il focus torna qui.
              data-invalid={index === 0 && errors.outcome !== undefined ? true : undefined}
              onClick={() => chooseOutcome(code)}
            >
              {CYCLE_OUTCOME_LABEL[code]}
            </Button>
          ))}
        </div>
        {errors.outcome === undefined ? null : (
          <p id={idOf("esito-errore")} className="text-sm text-destructive">
            {errors.outcome}
          </p>
        )}
        {needsLetter ? (
          <Alert className="border-transparent bg-warning text-warning-foreground">
            <AlertDescription className="flex flex-col items-start gap-2 text-warning-foreground">
              <span>{REFERRAL_FIRST}</span>
              {/* Chiudere senza lettera è rifiutato prima del server: il focus va a questo pulsante. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={preparing}
                data-invalid={errors.letter === undefined ? undefined : true}
                onClick={prepareLetter}
              >
                Prepara la lettera
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={idOf("nota")}>Nota</Label>
        <Textarea
          id={idOf("nota")}
          maxLength={NOTE_MAX}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          aria-invalid={errors.outcomeNote === undefined ? undefined : true}
          aria-describedby={errors.outcomeNote === undefined ? undefined : idOf("nota-errore")}
        />
        {errors.outcomeNote === undefined ? null : (
          <p id={idOf("nota-errore")} className="text-sm text-destructive">
            {errors.outcomeNote}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={idOf("data")}>Data di chiusura</Label>
        <Input
          id={idOf("data")}
          type="date"
          min={view.openedOn}
          max={view.today}
          value={closedOn}
          onChange={(event) => setClosedOn(event.target.value)}
          aria-invalid={errors.closedOn === undefined ? undefined : true}
          aria-describedby={errors.closedOn === undefined ? undefined : idOf("data-errore")}
          className="max-w-44"
        />
        {errors.closedOn === undefined ? null : (
          <p id={idOf("data-errore")} className="text-sm text-destructive">
            {errors.closedOn}
          </p>
        )}
      </div>

      {hasActivities ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{PSFS_TITLE}</legend>
          <p className="text-sm text-muted-foreground">{PSFS_SCALE_HINT}</p>
          <ul className="flex flex-col gap-3">
            {view.psfs.map((item) => {
              const error = errors[`score-${item.itemId}`];
              const initialId = idOf(`iniziale-${item.itemId}`);
              return (
                <li key={item.itemId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {scoring ? (
                    <Label htmlFor={idOf(`score-${item.itemId}`)} className="min-w-0 flex-1 basis-48">
                      {item.activity}
                    </Label>
                  ) : (
                    <span className="min-w-0 flex-1 basis-48 text-sm font-medium">{item.activity}</span>
                  )}
                  <span id={initialId} className="text-sm text-muted-foreground">
                    {item.initial === null ? "Iniziale: non scritto" : `Iniziale: ${item.initial}`}
                  </span>
                  {scoring ? (
                    <div className="flex flex-col gap-1">
                      <Input
                        id={idOf(`score-${item.itemId}`)}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={SCORE_MAX}
                        step={1}
                        value={scores[item.itemId] ?? ""}
                        onChange={(event) => {
                          setScores((prev) => ({ ...prev, [item.itemId]: event.target.value }));
                          clearErrors(`score-${item.itemId}`, "scores");
                        }}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={[initialId, error ? idOf(`score-${item.itemId}-errore`) : null]
                          .filter(Boolean)
                          .join(" ")}
                        className="w-24"
                      />
                      {error ? (
                        <p id={idOf(`score-${item.itemId}-errore`)} className="text-sm text-destructive">
                          {error}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {errors.scores ? (
            // L'errore dei punteggi tutti insieme (dal comando) non ha un campo: prende lui il focus.
            <p tabIndex={-1} data-invalid="true" className="text-sm text-destructive outline-none">
              {errors.scores}
            </p>
          ) : null}
          <div className="flex min-h-8 items-center gap-2">
            <Checkbox
              id={idOf("non-tornato")}
              checked={notReturned || !view.canScoreFinal}
              disabled={!view.canScoreFinal}
              onCheckedChange={(checked) => setNotReturned(checked)}
              aria-describedby={view.canScoreFinal ? undefined : idOf("non-tornato-aiuto")}
            />
            <Label htmlFor={idOf("non-tornato")}>Paziente non tornato</Label>
          </div>
          {view.canScoreFinal ? null : (
            <p id={idOf("non-tornato-aiuto")} className="text-sm text-muted-foreground">
              {NO_DRAFT_HINT}
            </p>
          )}
        </fieldset>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <span id={idOf("richiamo")} className="text-sm leading-none font-medium">
          Richiamo
        </span>
        <RadioGroup
          aria-labelledby={idOf("richiamo")}
          value={cadence}
          onValueChange={(value) => {
            setCadence(value as Cadence);
            setCadenceTouched(true);
            clearErrors("weeks");
          }}
          className="gap-1"
        >
          {CADENCE_PRESETS.map((weeks) => (
            <Label key={weeks} className="min-h-6 font-normal">
              <RadioGroupItem value={`${weeks}`} />
              <span>{`${weeks} settimane`}</span>{" "}
              <span className="text-muted-foreground">{recallText(view, weeks)}</span>
            </Label>
          ))}
          <Label className="min-h-6 font-normal">
            <RadioGroupItem value={CADENCE_OTHER} />
            Altra
          </Label>
          <Label className="min-h-6 font-normal">
            <RadioGroupItem value={CADENCE_NONE} />
            Nessun richiamo
          </Label>
        </RadioGroup>
        {cadence === CADENCE_OTHER ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={idOf("settimane")}>Settimane (da 2 a 52)</Label>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                id={idOf("settimane")}
                type="number"
                inputMode="numeric"
                min={MIN_WEEKS}
                max={MAX_WEEKS}
                step={1}
                value={other}
                onChange={(event) => {
                  setOther(event.target.value);
                  clearErrors("weeks");
                }}
                aria-invalid={errors.weeks ? true : undefined}
                aria-describedby={errors.weeks ? idOf("settimane-errore") : undefined}
                className="w-28"
              />
              {otherWeeks === null ? null : (
                <span className="text-sm text-muted-foreground">{recallText(view, otherWeeks)}</span>
              )}
            </div>
            {errors.weeks ? (
              <p id={idOf("settimane-errore")} className="text-sm text-destructive">
                {errors.weeks}
              </p>
            ) : null}
          </div>
        ) : null}
        {view.recallChoices === null ? <p className="text-sm text-muted-foreground">{NO_RECALL_DATE}</p> : null}
      </div>

      {formError === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>{NOT_CLOSED}</AlertTitle>
          {formError === NOT_CLOSED ? null : <AlertDescription>{formError}</AlertDescription>}
        </Alert>
      )}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Torna indietro</DialogClose>
        <Button type="submit" disabled={saving}>
          Chiudi ciclo
        </Button>
      </DialogFooter>
    </form>
  );
}
