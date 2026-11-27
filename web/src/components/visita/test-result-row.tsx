"use client";

import { ArrowDown, ArrowUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { FREE_TEST, type TestDefinition } from "@/lib/clinical/catalog";
import type { Change, Trend } from "@/lib/clinical/compare";
import type { RunOptions } from "@/lib/visits/save-queue";
import {
  changeArrow,
  choiceItems,
  choiceKind,
  choiceOf,
  clearTestOp,
  keptOf,
  NO_VALUE,
  type TestTarget,
  type TestValue,
  testOp,
  valueOfChoice,
} from "@/lib/visits/test-row";
import type { EditorTest } from "@/server/domain/visits/editor";

import { ChoiceField } from "./choice-group";
import type { VisitSectionProps } from "./visit-editor";
import { VisitTextField } from "./visit-text-field";

// Il risultato di un test e lato: il controllo del suo tipo
// (pulsanti o campo numerico), in grigio il valore precedente (anche senza una riga di oggi: arriva da
// `VisitEditor.previousByKey`) e, sulla riga, la variazione dalla prima misura con la freccia e il segno. Lo usano i
// test della sezione C, i test liberi e l'esame neurologico compatto.

export type TestShape = Pick<TestDefinition, "code" | "resultType" | "min" | "max" | "step" | "ordinalLabels" | "unit">;

const TREND_TEXT: Record<Trend, string> = {
  improved: "migliorato",
  worsened: "peggiorato",
  unchanged: "invariato",
};

/** L'id del controllo di un test e lato: lì va il focus quando il test si apre dall'elenco. */
export const testRowId = (code: string, side: "dx" | "sx" | null): string => `test-${code}-${side ?? "x"}`;

/** Il tipo di un test libero: un numero, o sì e no se la riga salvata ha un valore booleano. */
export function freeShape(saved: EditorTest | undefined): TestShape {
  const boolean = saved !== undefined && saved.valueBool !== null && saved.valueNumeric === null;
  return {
    code: FREE_TEST,
    resultType: boolean ? "binary" : "numeric",
    min: null,
    max: null,
    step: null,
    ordinalLabels: null,
    unit: saved?.customUnit ?? null,
  };
}

/** La variazione dalla prima misura: il segno e il numero, la freccia dal segno, il giudizio in una parola nascosta. */
function ChangeText({ change }: { change: Change }) {
  const direction = changeArrow(change);
  const Arrow = direction === "up" ? ArrowUp : direction === "down" ? ArrowDown : null;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="sr-only">Variazione dalla prima misura:</span>
      {Arrow === null ? null : <Arrow aria-hidden="true" className="size-4 shrink-0" />}
      <span className="tabular-nums">{change.text}</span>
      {direction === null || change.trend === null ? null : <span className="sr-only">{`(${TREND_TEXT[change.trend]})`}</span>}
    </span>
  );
}

export interface TestResultRowProps {
  id: string;
  /** Il nome con il lato ("Test di Ober dx"): è il nome accessibile del controllo. */
  label: string;
  shape: TestShape;
  target: TestTarget;
  saved: EditorTest | undefined;
  /** Il valore precedente ("28°"), in grigio sotto il controllo. */
  previous?: string;
  op: VisitSectionProps["op"];
  disabled: boolean;
  /** Nella tabella dell'esame neurologico: etichetta solo per i lettori di schermo, senza valore precedente. */
  compact?: boolean;
}

export function TestResultRow({ id, label, shape, target, saved, previous, op, disabled, compact = false }: TestResultRowProps) {
  const unit = shape.unit ?? target.customUnit;
  const hint = compact || previous === undefined ? undefined : `Precedente: ${previous}`;

  // Il valore salvato non si cancella dal client: senza una riga salvata non c'è niente da togliere.
  const send = (value: TestValue | null, options: RunOptions) => {
    if (value !== null) op(testOp(target, value, keptOf(saved)), options);
    else if (saved !== undefined) op(clearTestOp(saved), options);
  };

  const control =
    choiceKind(shape) === "number" ? (
      <VisitTextField
        id={id}
        label={unit === null ? label : `${label} (${unit})`}
        type="number"
        min={shape.min ?? undefined}
        max={shape.max ?? undefined}
        step={shape.step ?? undefined}
        className="w-56"
        value={saved === undefined || saved.valueNumeric === null ? null : String(saved.valueNumeric)}
        disabled={disabled}
        hint={hint}
        onSave={(next, options) => send(next === null ? null : { ...NO_VALUE, valueNumeric: Number(next) }, options)}
      />
    ) : (
      <ChoiceField
        id={id}
        label={label}
        hideLabel={compact}
        clearable
        items={choiceItems(shape)}
        value={choiceOf(shape, saved)}
        disabled={disabled}
        hint={hint}
        onSave={(choice, options) => send(choice === null ? null : valueOfChoice(shape, choice), options)}
      />
    );

  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
      {control}
      {saved === undefined || (saved.change === null && !saved.copied) ? null : (
        <div className={compact ? "flex h-8 items-center gap-2 text-sm" : "flex h-8 items-center gap-2 pt-6 text-sm"}>
          {saved.change === null ? null : <ChangeText change={saved.change} />}
          {saved.copied ? <Badge variant="outline">Da confermare</Badge> : null}
        </div>
      )}
    </div>
  );
}
