"use client";

import { useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { setRecallAction } from "@/app/(app)/pazienti/[id]/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// "Cambia" il richiamo del paziente: la cadenza in settimane
// (4, 6, 8, 12 o «Altra», da 2 a 52) oppure «Nessun richiamo». «Nessun richiamo» sospende i richiami e
// lascia la cadenza com'è (`recall_paused`), così riaccenderli non la fa riscrivere; un paziente che una
// cadenza non l'ha mai avuta resta senza. Una cadenza scelta riaccende i richiami.

const PRESETS = [4, 6, 8, 12] as const;
const OTHER = "altra";
const NONE = "nessuno";
const MIN_WEEKS = 2;
const MAX_WEEKS = 52;
const INVALID_WEEKS = "Scrivi un numero di settimane da 2 a 52.";
const NOT_SAVED = "Non ho salvato il richiamo. Riprova.";

type Choice = `${(typeof PRESETS)[number]}` | typeof OTHER | typeof NONE;

function initialChoice(weeks: number | null, paused: boolean): Choice {
  if (paused || weeks === null) return NONE;
  const preset = PRESETS.find((p) => p === weeks);
  return preset === undefined ? OTHER : `${preset}`;
}

function RecallForm({
  patientId,
  weeks,
  paused,
  onClose,
}: {
  patientId: string;
  weeks: number | null;
  paused: boolean;
  onClose: () => void;
}) {
  const baseId = useId();
  const weeksId = `${baseId}-settimane`;
  const errorId = `${baseId}-errore`;
  const otherRef = useRef<HTMLInputElement>(null);
  const [choice, setChoice] = useState<Choice>(initialChoice(weeks, paused));
  const [other, setOther] = useState(weeks !== null && choice === OTHER ? `${weeks}` : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const submit = () => {
    let input: { patientId: string; weeks: number | null; paused: boolean };
    if (choice === NONE) {
      input = { patientId, weeks, paused: weeks !== null };
    } else if (choice === OTHER) {
      const typed = Number(other.trim());
      if (other.trim() === "" || !Number.isInteger(typed) || typed < MIN_WEEKS || typed > MAX_WEEKS) {
        setError(INVALID_WEEKS);
        otherRef.current?.focus();
        return;
      }
      input = { patientId, weeks: typed, paused: false };
    } else {
      input = { patientId, weeks: Number(choice), paused: false };
    }
    startSaving(async () => {
      const result = await setRecallAction(input);
      if (result.ok) {
        onClose();
        return;
      }
      setError(NOT_SAVED);
      toast.error(result.message);
    });
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <RadioGroup
        aria-label="Cadenza del richiamo"
        value={choice}
        onValueChange={(value) => {
          setChoice(value as Choice);
          setError(null);
        }}
        className="gap-1"
      >
        {PRESETS.map((preset) => (
          <Label key={preset} className="min-h-6 font-normal">
            <RadioGroupItem value={`${preset}`} />
            {`${preset} settimane`}
          </Label>
        ))}
        <Label className="min-h-6 font-normal">
          <RadioGroupItem value={OTHER} />
          Altra
        </Label>
        <Label className="min-h-6 font-normal">
          <RadioGroupItem value={NONE} />
          Nessun richiamo
        </Label>
      </RadioGroup>

      {choice === OTHER ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={weeksId}>Settimane (da 2 a 52)</Label>
          <Input
            ref={otherRef}
            id={weeksId}
            type="number"
            inputMode="numeric"
            min={MIN_WEEKS}
            max={MAX_WEEKS}
            step={1}
            value={other}
            onChange={(event) => {
              setOther(event.target.value);
              setError(null);
            }}
            aria-invalid={error === INVALID_WEEKS ? true : undefined}
            aria-describedby={error === null ? undefined : errorId}
            className="max-w-28"
          />
        </div>
      ) : null}
      {error === null ? null : (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Torna indietro</DialogClose>
        <Button type="submit" disabled={saving}>
          Salva il richiamo
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RecallDialog({
  patientId,
  weeks,
  paused,
}: {
  patientId: string;
  weeks: number | null;
  paused: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Cambia
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Richiamo</DialogTitle>
          </DialogHeader>
          {/* Il modulo nasce a ogni apertura: la scelta riparte da ciò che è salvato. */}
          <RecallForm patientId={patientId} weeks={weeks} paused={paused} onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
