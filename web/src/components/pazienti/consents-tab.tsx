"use client";

import { useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { recordChoiceAction, revokeConsentAction } from "@/app/(app)/pazienti/[id]/consent-actions";
import { ConsentCollectDialog, ConsentCollectLauncher } from "@/components/consensi/collect-dialog";
import { described } from "@/components/forms/form-parts";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ConsentTarget } from "@/server/domain/consents/schemas";
import type { ChoiceLine, CollectTargets, ConsentLine } from "@/server/domain/patients/card";

// La tab Consensi: i due pulsanti di raccolta, poi lo storico di tutti i documenti
// (sostituiti e revocati compresi: niente si cancella) con modulo, ciclo, versione, data, metodo e stato, e per
// riga «Scarica PDF» (il PDF nasce alla prima richiesta; un modulo caricato come immagine si scarica com'è),
// «Registra revoca» per un documento valido e «Raccogli di nuovo» sull'ultimo documento del suo modulo. Sotto, le
// due scelte dell'informativa, che si revocano una per volta e separate dal documento. Ogni revoca è un dialogo
// con data (oggi, non futura), modalità e nota, e una sola conferma.

// Il vuoto della tab Consensi.
const EMPTY = "Nessun consenso raccolto.";
// Un consenso firmato con segnaposto vuoti.
const MISSING_DATA = "Firmato con dati mancanti";
const MODE_MISSING = "Indica come è arrivata la revoca.";
const DATE_MISSING = "Indica la data della revoca.";
const REVOKED = "Revoca registrata.";
const NOT_SAVED = "Non ho registrato la revoca. Riprova.";

const METHOD_LABEL: Record<ConsentLine["method"], string> = {
  tela: "Firma sulla tela",
  pdf_caricato: "Modulo caricato",
};

type Mode = "verbale" | "scritta" | "messaggio";
const MODES: readonly { value: Mode; label: string }[] = [
  { value: "verbale", label: "A voce" },
  { value: "scritta", label: "Per iscritto" },
  { value: "messaggio", label: "Con un messaggio" },
];

/** Cosa si revoca: un documento della tabella o una scelta dell'informativa. */
type Subject =
  | { kind: "documento"; id: string; title: string; description: string }
  | { kind: "scelta"; choice: ChoiceLine["choice"]; title: string; description: string };

/** Un modulo caricato come immagine si scarica com'è: l'etichetta lo dice. */
function downloadLabel(row: ConsentLine): string {
  return row.method === "pdf_caricato" && row.documentMime !== null && row.documentMime.startsWith("image/")
    ? "Scarica l'immagine"
    : "Scarica PDF";
}

function RevokeForm({
  subject,
  patientId,
  today,
  onClose,
  firstRef,
}: {
  subject: Subject;
  patientId: string;
  today: string;
  onClose: () => void;
  firstRef: React.RefObject<HTMLInputElement | null>;
}) {
  const id = useId();
  const modeRef = useRef<HTMLButtonElement>(null);
  const [day, setDay] = useState(today);
  const [mode, setMode] = useState<Mode | null>(null);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ day?: string; mode?: string }>({});
  const [saving, startSaving] = useTransition();
  const dayField = subject.kind === "documento" ? "revokedOn" : "decidedOn";

  const submit = () => {
    if (day === "") {
      setErrors({ day: DATE_MISSING });
      firstRef.current?.focus();
      return;
    }
    if (mode === null) {
      setErrors({ mode: MODE_MISSING });
      modeRef.current?.focus();
      return;
    }
    const trimmed = note.trim() === "" ? null : note.trim();
    startSaving(async () => {
      const result =
        subject.kind === "documento"
          ? await revokeConsentAction({ id: subject.id, revokedOn: day, mode, note: trimmed })
          : await recordChoiceAction({ patientId, choice: subject.choice, value: false, decidedOn: day, mode, note: trimmed });
      if (result.ok) {
        toast.success(REVOKED);
        onClose();
        return;
      }
      const dayError = result.fieldErrors?.[dayField];
      if (dayError !== undefined) {
        setErrors({ day: dayError });
        firstRef.current?.focus();
        return;
      }
      toast.error(result.refused ? result.message : NOT_SAVED);
    });
  };

  const modeLabelId = `${id}-modo`;
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-data`}>Data della revoca</Label>
        <Input
          ref={firstRef}
          id={`${id}-data`}
          type="date"
          max={today}
          value={day}
          onChange={(event) => {
            setDay(event.target.value);
            setErrors((e) => ({ ...e, day: undefined }));
          }}
          {...described(`${id}-data`, errors.day)}
        />
        {errors.day === undefined ? null : (
          <p id={`${id}-data-errore`} className="text-sm text-destructive">
            {errors.day}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <span id={modeLabelId} className="text-sm leading-none font-medium">
          Come è arrivata
        </span>
        <RadioGroup
          aria-labelledby={modeLabelId}
          aria-describedby={errors.mode === undefined ? undefined : `${id}-modo-errore`}
          value={mode}
          onValueChange={(value) => {
            setMode(MODES.find((m) => m.value === value)?.value ?? null);
            setErrors((e) => ({ ...e, mode: undefined }));
          }}
          className="flex flex-wrap gap-x-6"
        >
          {MODES.map((item, index) => (
            <Label key={item.value} className="min-h-6 font-normal">
              <RadioGroupItem
                value={item.value}
                ref={index === 0 ? modeRef : undefined}
                aria-invalid={errors.mode === undefined ? undefined : true}
              />
              {item.label}
            </Label>
          ))}
        </RadioGroup>
        {errors.mode === undefined ? null : (
          <p id={`${id}-modo-errore`} className="text-sm text-destructive">
            {errors.mode}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-nota`}>
          Nota <span className="font-normal text-muted-foreground">(facoltativa)</span>
        </Label>
        <Textarea id={`${id}-nota`} maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel>Torna indietro</AlertDialogCancel>
        <Button type="submit" variant="destructive" disabled={saving}>
          Registra revoca
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

function RevokeDialog({
  subject,
  patientId,
  today,
  onClose,
}: {
  /** Che cosa si revoca; null tiene chiuso il dialogo. */
  subject: Subject | null;
  patientId: string;
  today: string;
  onClose: () => void;
}) {
  const firstRef = useRef<HTMLInputElement>(null);
  // Il modulo resta mentre il dialogo si chiude e nasce di nuovo a ogni apertura.
  const [shown, setShown] = useState<{ subject: Subject; opening: number } | null>(null);
  const [previous, setPrevious] = useState<Subject | null>(null);
  if (subject !== previous) {
    setPrevious(subject);
    if (subject !== null) setShown({ subject, opening: (shown?.opening ?? 0) + 1 });
  }
  return (
    <AlertDialog
      open={subject !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent initialFocus={firstRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{shown?.subject.title ?? "Registra revoca"}</AlertDialogTitle>
          <AlertDialogDescription>{shown?.subject.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {shown === null ? null : (
          <RevokeForm
            key={shown.opening}
            subject={shown.subject}
            patientId={patientId}
            today={today}
            onClose={onClose}
            firstRef={firstRef}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConsentRow({
  row,
  onRevoke,
  onCollect,
}: {
  row: ConsentLine;
  onRevoke: (subject: Subject) => void;
  onCollect: (target: ConsentTarget) => void;
}) {
  const id = useId();
  const what = `${id}-modulo`;
  return (
    <TableRow>
      <TableCell id={what} className="font-medium">
        {row.moduleLabel}
        <span className="sr-only">{` del ${row.signedOnText}`}</span>
      </TableCell>
      <TableCell>{row.cycleTitle ?? "Fuori ciclo"}</TableCell>
      <TableCell className="tabular-nums">{row.moduleVersion}</TableCell>
      <TableCell className="tabular-nums">{row.signedOnText}</TableCell>
      <TableCell>{METHOD_LABEL[row.method]}</TableCell>
      <TableCell>
        <span className="flex flex-col">
          <span>{row.statusLabel}</span>
          {row.missingFields.length === 0 ? null : <span className="text-sm text-muted-foreground">{MISSING_DATA}</span>}
        </span>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-2">
          {/* Il PDF di una firma sulla tela nasce qui alla prima richiesta; un documento revocato resta scaricabile. */}
          <a
            href={`/api/consensi/${row.id}/documento?download=1`}
            download
            aria-describedby={what}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            {downloadLabel(row)}
          </a>
          {row.canRevoke ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-describedby={what}
              onClick={() =>
                onRevoke({
                  kind: "documento",
                  id: row.id,
                  title: "Registrare la revoca?",
                  description: `${row.moduleLabel} del ${row.signedOnText}. Il documento resta nello storico e si può scaricare.`,
                })
              }
            >
              Registra revoca
            </Button>
          ) : null}
          {row.current ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={row.targetProblem !== null}
                aria-describedby={row.targetProblem === null ? what : `${what} ${id}-motivo`}
                onClick={() => onCollect(row.target)}
              >
                Raccogli di nuovo
              </Button>
              {row.targetProblem === null ? null : (
                <span id={`${id}-motivo`} className="text-sm text-muted-foreground">
                  {row.targetProblem}
                </span>
              )}
            </>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function ConsentsTabView({
  patientId,
  rows,
  choices,
  collect,
  today,
}: {
  patientId: string;
  rows: ConsentLine[];
  choices: ChoiceLine[];
  collect: CollectTargets;
  /** Il giorno del server, per la data predefinita della revoca. */
  today: string;
}) {
  const choicesId = useId();
  const [revoking, setRevoking] = useState<Subject | null>(null);
  const [collecting, setCollecting] = useState<ConsentTarget | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <ConsentCollectLauncher informativa={collect.informativa} treatment={collect.treatment} noGuardian={collect.noGuardian} />
      {rows.length === 0 ? (
        <p>{EMPTY}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Modulo</TableHead>
              <TableHead>Ciclo</TableHead>
              <TableHead>Versione</TableHead>
              <TableHead>Data</TableHead>
              <TableHead>Metodo</TableHead>
              <TableHead>Stato</TableHead>
              <TableHead>Azioni</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <ConsentRow key={row.id} row={row} onRevoke={setRevoking} onCollect={setCollecting} />
            ))}
          </TableBody>
        </Table>
      )}

      <section aria-labelledby={choicesId} className="flex flex-col gap-2">
        <h2 id={choicesId} className="font-medium">
          Scelte dell&apos;informativa
        </h2>
        <ul className="flex flex-col gap-2">
          {choices.map((choice) => (
            <li key={choice.choice} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span id={`${choicesId}-${choice.choice}`}>{`${choice.label}: ${choice.stateText}`}</span>
              {choice.value ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-describedby={`${choicesId}-${choice.choice}`}
                  onClick={() =>
                    setRevoking({
                      kind: "scelta",
                      choice: choice.choice,
                      title: "Registrare la revoca della scelta?",
                      description: `${choice.label}. Il modulo firmato resta com'è.`,
                    })
                  }
                >
                  Revoca la scelta
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <RevokeDialog subject={revoking} patientId={patientId} today={today} onClose={() => setRevoking(null)} />
      <ConsentCollectDialog target={collecting} onClose={() => setCollecting(null)} />
    </div>
  );
}
