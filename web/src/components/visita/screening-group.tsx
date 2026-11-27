"use client";

import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { REGION_CODES, REGION_LABEL, type RegionCode } from "@/lib/clinical/catalog";
import { ANSWER_LABEL } from "@/lib/clinical/labels";
import type { Answer, ScreeningAnswer } from "@/lib/clinical/rules";
import { cn } from "@/lib/utils";
import type { RunOptions } from "@/lib/visits/save-queue";
import { refusalText } from "@/lib/visits/text-autosave";
import type { ScreeningGroupView } from "@/server/domain/visits/editor";

import { ChoiceGroup, useRowDraft } from "./choice-group";
import { refocusIfIdle } from "./refocus";
import type { VisitSectionProps } from "./visit-editor";
import { VisitTextField } from "./visit-text-field";

// Un gruppo dello screening nella sezione B: l'intestazione apre e chiude
// le voci, "Nessun'altra voce" resta sempre a portata (scrive "no" sulle voci senza risposta). Per voce tre pulsanti
// «No», «Sì», «Non so» e «da anamnesi» accanto a una risposta proposta dall'anamnesi; con «Sì» o «Non so» le caselle
// delle regioni (voci locali, obbligatorie con «Sì»), quelle delle sottovoci e la nota. Ogni modifica manda la
// risposta intera della voce (`risposta`), che sostituisce quella salvata e non è più «da anamnesi».

const ANSWERS = (["no", "si", "non_so"] as const).map((value) => ({ value, label: ANSWER_LABEL[value] }));
const FROM_HISTORY = "da anamnesi";
const NO_OTHER = "Nessun'altra voce";
const NOTE_MAX = 300;

type Item = ScreeningGroupView["items"][number]["item"];

/** La risposta di una voce come la manda l'operazione `risposta`. */
interface AnswerRow {
  answer: Answer | null;
  regions: readonly RegionCode[];
  subAnswers: readonly string[];
  note: string | null;
  fromHistory: boolean;
}

const rowOf = (answer: ScreeningAnswer | null): AnswerRow =>
  answer === null
    ? { answer: null, regions: [], subAnswers: [], note: null, fromHistory: false }
    : { answer: answer.answer, regions: answer.regions, subAnswers: answer.subAnswers, note: answer.note, fromHistory: answer.fromHistory };

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** La stessa risposta, come la riscrive il server (nota senza spazi ai lati, regioni e sottovoci senza ordine). */
function sameAnswer(a: AnswerRow, b: AnswerRow): boolean {
  return (
    a.answer === b.answer &&
    sameSet(a.regions, b.regions) &&
    sameSet(a.subAnswers, b.subAnswers) &&
    (a.note?.trim() || null) === (b.note?.trim() || null)
  );
}

/** Un gruppo di caselle con la sua legenda e l'errore sotto. */
function CheckboxGroup<T extends string>({
  id,
  legend,
  options,
  checked,
  disabled,
  error,
  onToggle,
}: {
  id: string;
  legend: string;
  options: readonly { value: T; label: string }[];
  checked: readonly T[];
  disabled: boolean;
  error: string | undefined;
  onToggle: (value: T, on: boolean) => void;
}) {
  return (
    <fieldset
      id={id}
      tabIndex={-1}
      aria-describedby={error === undefined ? undefined : `${id}-errore`}
      aria-invalid={error === undefined ? undefined : true}
      className="flex flex-col gap-1 outline-none"
    >
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {options.map((option) => (
          <div key={option.value} className="flex min-h-8 items-center gap-2">
            <Checkbox
              id={`${id}-${option.value}`}
              checked={checked.includes(option.value)}
              disabled={disabled}
              onCheckedChange={(on) => onToggle(option.value, on)}
            />
            <Label htmlFor={`${id}-${option.value}`}>{option.label}</Label>
          </div>
        ))}
      </div>
      {error === undefined ? null : (
        <p id={`${id}-errore`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

const REGION_OPTIONS = REGION_CODES.map((code) => ({ value: code, label: REGION_LABEL[code] }));

function ScreeningItemRow({
  item,
  answer,
  disabled,
  op,
}: {
  item: Item;
  answer: ScreeningAnswer | null;
  disabled: boolean;
  op: VisitSectionProps["op"];
}) {
  const id = `voce-${item.code}`;
  const { row, send, reset } = useRowDraft(answer, rowOf, sameAnswer);
  const [error, setError] = useState<{ field: "answer" | "regions" | "subAnswers"; message: string } | null>(null);

  const save = (next: AnswerRow, field: "answer" | "regions" | "subAnswers", options?: RunOptions) => {
    if (next.answer === null) return;
    setError(null);
    send({ ...next, fromHistory: false });
    op(
      {
        op: "risposta",
        itemCode: item.code,
        answer: next.answer,
        regions: item.scope === "local" ? [...next.regions] : [],
        subAnswers: [...next.subAnswers],
        note: next.note,
      },
      options ?? {
        onRefused: (failure) => {
          reset();
          const keys = Object.keys(failure.fieldErrors ?? {});
          const target = keys.includes("regions") ? "regions" : keys.includes("subAnswers") ? "subAnswers" : field;
          setError({ field: target, message: refusalText(failure) });
          const scope = document.getElementById(id);
          const focus = target === "answer" ? scope?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') : document.getElementById(`${id}-${target}`);
          refocusIfIdle(scope, focus ?? null);
        },
      },
    );
  };

  const chooseAnswer = (value: Answer) => {
    // Un «Sì» locale parte dalle regioni proposte della voce, come una proposta dell'anamnesi; un «No» non ne ha.
    const regions =
      value === "no" ? [] : row.regions.length > 0 || value === "non_so" ? row.regions : [...item.proposedRegions];
    save({ ...row, answer: value, regions, subAnswers: value === "no" ? [] : row.subAnswers }, "answer");
  };
  const toggle = <K extends "regions" | "subAnswers">(key: K, value: string, on: boolean) => {
    const current: readonly string[] = row[key];
    const next = on ? [...current, value] : current.filter((v) => v !== value);
    save({ ...row, [key]: next }, key);
  };

  const detailed = row.answer === "si" || row.answer === "non_so";
  return (
    <li id={id} className="flex flex-col gap-3 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <ChoiceGroup
            id={`${id}-risposta`}
            label={item.label}
            items={ANSWERS}
            value={row.answer}
            disabled={disabled}
            error={error?.field === "answer" ? error.message : undefined}
            onChange={chooseAnswer}
          />
        </div>
        {row.fromHistory && row.answer !== null ? (
          <Badge variant="secondary" className="mt-0.5">
            {FROM_HISTORY}
          </Badge>
        ) : null}
      </div>
      {detailed && item.scope === "local" ? (
        <CheckboxGroup
          id={`${id}-regions`}
          legend="Regioni"
          options={REGION_OPTIONS}
          checked={row.regions}
          disabled={disabled}
          error={error?.field === "regions" ? error.message : undefined}
          onToggle={(value, on) => toggle("regions", value, on)}
        />
      ) : null}
      {detailed && item.subItems.length > 0 ? (
        <CheckboxGroup
          id={`${id}-subAnswers`}
          legend="Dettagli"
          options={item.subItems.map((sub) => ({ value: sub.code, label: sub.label }))}
          checked={row.subAnswers}
          disabled={disabled}
          error={error?.field === "subAnswers" ? error.message : undefined}
          onToggle={(value, on) => toggle("subAnswers", value, on)}
        />
      ) : null}
      {detailed || row.note !== null ? (
        <VisitTextField
          id={`${id}-nota`}
          label="Nota"
          optional
          hint={item.help ?? undefined}
          value={row.note}
          maxLength={NOTE_MAX}
          disabled={disabled}
          onSave={(value, options) => {
            if (row.answer === null) return false;
            // Il rifiuto va sotto la nota (`options` del testo) e la riga torna quella della vista.
            save({ ...row, note: value }, "answer", {
              onRefused: (failure) => {
                reset();
                options.onRefused?.(failure);
              },
            });
          }}
        />
      ) : null}
    </li>
  );
}

export function ScreeningGroup({
  group,
  disabled,
  op,
  children,
}: {
  group: ScreeningGroupView;
  disabled: boolean;
  op: VisitSectionProps["op"];
  /** Quello che il gruppo porta sotto le voci: la riga della gravidanza, la pressione col gruppo cervicale. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const headingId = useId();
  const contentId = useId();
  const errorId = useId();
  const unanswered = group.items.filter((i) => i.answer === null).length;

  return (
    <section aria-labelledby={headingId} className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 pr-2">
        <h3 id={headingId} className="min-w-0 flex-1 text-sm font-medium">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => setOpen((current) => !current)}
            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn("size-4 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-180")}
            />
            {group.label}
          </button>
        </h3>
        {unanswered > 0 ? (
          <span className="text-sm text-muted-foreground">{unanswered === 1 ? "1 senza risposta" : `${unanswered} senza risposta`}</span>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-describedby={error === undefined ? undefined : errorId}
          onClick={() => {
            setError(undefined);
            op({ op: "nessun_altra_voce", group: group.code }, { onRefused: (failure) => setError(refusalText(failure)) });
          }}
        >
          {NO_OTHER}
        </Button>
      </div>
      {error === undefined ? null : (
        <p id={errorId} className="px-3 pb-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div id={contentId} hidden={!open} className="flex flex-col gap-2 px-3 pb-3">
        <ul className="flex flex-col">
          {group.items.map(({ item, answer }) => (
            <ScreeningItemRow key={item.code} item={item} answer={answer} disabled={disabled} op={op} />
          ))}
        </ul>
        {children}
      </div>
    </section>
  );
}
