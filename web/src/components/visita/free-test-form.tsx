"use client";

import { type KeyboardEvent, useId, useState } from "react";

import { described, Field } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FREE_TEST } from "@/lib/clinical/catalog";
import { keptOf, NO_VALUE, previousFor, type TestTarget, targetOf, testLabel, testOp } from "@/lib/visits/test-row";
import type { ActionFailure } from "@/server/actions/result";

import { ChoiceGroup, useUnsavedDraft } from "./choice-group";
import { freeShape, TestResultRow } from "./test-result-row";
import type { VisitSectionProps } from "./visit-editor";

// Il «Test libero» della sezione C: un test con il suo nome, il valore numerico,
// l'unità e il lato. I test liberi della visita sono righe con il loro valore e «Togli»; il modulo per aggiungerne uno
// riparte vuoto subito, e un rifiuto del comando lo rimette com'era con la frase sotto il campo.

const NAME_MAX = 60;
const UNIT_MAX = 10;
const LABEL_REQUIRED = "Scrivi il nome del test.";
const VALUE_REQUIRED = "Scrivi il valore.";

interface FreeForm {
  label: string;
  value: string;
  unit: string;
  side: "dx" | "sx" | null;
}
const EMPTY_FORM: FreeForm = { label: "", value: "", unit: "", side: null };

type FreeField = "label" | "value" | "unit" | "side";
type FreeErrors = Partial<Record<FreeField | "general", string>>;

/** Le chiavi del rifiuto del comando e il campo del modulo a cui appartengono. */
const FIELD_OF: Record<string, FreeField> = { customLabel: "label", valueNumeric: "value", customUnit: "unit", side: "side" };

const SIDES = [
  { value: "dx", label: "dx" },
  { value: "sx", label: "sx" },
] as const;

function freeErrors(failure: ActionFailure): FreeErrors {
  const errors: FreeErrors = {};
  for (const [key, message] of Object.entries(failure.fieldErrors ?? {})) {
    const field = FIELD_OF[key];
    if (field !== undefined && errors[field] === undefined) errors[field] = message;
  }
  return Object.keys(errors).length > 0 ? errors : { general: failure.message };
}

function FreeTestForm({ op }: { op: VisitSectionProps["op"] }) {
  const baseId = useId();
  const idOf = (field: string) => `${baseId}-${field}`;
  const [form, setForm] = useState<FreeForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FreeErrors>({});
  useUnsavedDraft(form.label !== "" || form.value !== "" || form.unit !== "" || form.side !== null);

  const focusFirst = (found: FreeErrors) => {
    const first = (["label", "value", "unit", "side"] as const).find((field) => found[field] !== undefined);
    if (first === undefined) return;
    const target = document.getElementById(idOf(first));
    (first === "side" ? target?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') : target)?.focus();
  };

  const submit = () => {
    const label = form.label.trim();
    const raw = form.value.trim().replace(",", ".");
    const value = raw === "" ? Number.NaN : Number(raw);
    const missing: FreeErrors = {};
    if (label === "") missing.label = LABEL_REQUIRED;
    if (!Number.isFinite(value)) missing.value = VALUE_REQUIRED;
    if (Object.keys(missing).length > 0) {
      setErrors(missing);
      focusFirst(missing);
      return;
    }
    const sent = form;
    setErrors({});
    setForm(EMPTY_FORM);
    const target: TestTarget = { testCode: FREE_TEST, side: sent.side, customLabel: label, customUnit: sent.unit.trim() || null };
    op(testOp(target, { ...NO_VALUE, valueNumeric: value }, keptOf(undefined)), {
      onRefused: (failure) => {
        const found = freeErrors(failure);
        setForm(sent);
        setErrors(found);
        focusFirst(found);
      },
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    submit();
  };
  const clear = (field: FreeField) => setErrors((current) => ({ ...current, [field]: undefined, general: undefined }));

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <Field id={idOf("label")} label="Nome del test" required error={errors.label} className="w-60">
          <Input
            id={idOf("label")}
            value={form.label}
            maxLength={NAME_MAX}
            autoComplete="off"
            onChange={(event) => {
              setForm({ ...form, label: event.target.value });
              clear("label");
            }}
            {...described(idOf("label"), errors.label)}
          />
        </Field>
        <Field id={idOf("value")} label="Valore" required error={errors.value} className="w-32">
          <Input
            id={idOf("value")}
            value={form.value}
            inputMode="decimal"
            autoComplete="off"
            onChange={(event) => {
              setForm({ ...form, value: event.target.value });
              clear("value");
            }}
            {...described(idOf("value"), errors.value)}
          />
        </Field>
        <Field id={idOf("unit")} label="Unità" optional error={errors.unit} className="w-32">
          <Input
            id={idOf("unit")}
            value={form.unit}
            maxLength={UNIT_MAX}
            autoComplete="off"
            onChange={(event) => {
              setForm({ ...form, unit: event.target.value });
              clear("unit");
            }}
            {...described(idOf("unit"), errors.unit)}
          />
        </Field>
        <ChoiceGroup
          id={idOf("side")}
          label="Lato"
          items={SIDES}
          value={form.side}
          error={errors.side}
          onChange={(side) => {
            setForm({ ...form, side });
            clear("side");
          }}
          onClear={() => setForm({ ...form, side: null })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Button type="button" variant="outline" className="self-start" onClick={submit}>
          Aggiungi il test
        </Button>
        {errors.general === undefined ? null : <p className="text-sm text-destructive">{errors.general}</p>}
      </div>
    </div>
  );
}

/** I test liberi della visita, ognuno con il suo valore e «Togli»; il modulo per aggiungerne uno c'è solo in una bozza. */
export function FreeTests({ editor, op, disabled }: Pick<VisitSectionProps, "editor" | "op"> & { disabled: boolean }) {
  const free = editor.tests.filter((t) => t.testCode === FREE_TEST);
  if (disabled && free.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium">Test libero</legend>
      {free.length === 0 ? null : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {free.map((test) => {
            const label = testLabel(test.name, test.side);
            const target = targetOf(test);
            return (
              <li key={test.id} className="flex flex-wrap items-start gap-3 p-3">
                <TestResultRow
                  id={`libero-${test.id}`}
                  label={label}
                  shape={freeShape(test)}
                  target={target}
                  saved={test}
                  previous={previousFor(editor.previousByKey, target)}
                  op={op}
                  disabled={disabled}
                />
                {disabled ? null : (
                  <div className="pt-6">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Togli il test: ${label}`}
                      onClick={() => op({ op: "togli_test", resultId: test.id })}
                    >
                      Togli
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {disabled ? null : <FreeTestForm op={op} />}
    </fieldset>
  );
}
