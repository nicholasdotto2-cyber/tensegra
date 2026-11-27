"use client";

import { useId } from "react";

import { saveClinicalSettingsAction } from "@/app/(app)/impostazioni/actions";
import { Field, REQUIRED, SaveBar, described, useSectionForm } from "@/components/forms/form-parts";
import { UnsavedGuard } from "@/components/forms/unsaved-guard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { REGION_CODES, REGION_LABEL, TESTS } from "@/lib/clinical/catalog";
import type { ClinicalSettingsView } from "@/server/domain/settings/queries";

// Cartella: i default per le sedute e i richiami (cadenza, sedute previste, intervallo),
// i tre promemoria di rinvio R1-R3 e i test attivi, un interruttore per test raggruppati per regione. Le red
// flag pediatriche si vedono spente e bloccate finché un osteopata non le rivede: nessun comando le
// scrive. Senza la riga dello studio il modulo parte dai default (6, 4, 2, R1-R3 e i 24 test di default).

export type ClinicalInitial = ClinicalSettingsView;

type Prompt = ClinicalSettingsView["referralPrompts"][number];

interface Values {
  defaultRecallWeeks: string;
  defaultExpectedSessions: string;
  defaultSessionIntervalWeeks: number;
  referralPrompts: Prompt[];
  /** Sempre in ordine alfabetico, come li salva il comando: il confronto con lo stato salvato è per testo. */
  activeTestCodes: string[];
}

const PROMPTS: readonly { code: Prompt; label: string }[] = [
  { code: "R1", label: "R1 Red flag" },
  { code: "R2", label: "R2 Peggioramento" },
  { code: "R3", label: "R3 Persistenza oltre i tempi previsti" },
];

// I test del catalogo per regione, nell'ordine delle regioni; una regione senza test non compare.
const TEST_GROUPS = REGION_CODES.map((region) => ({
  region,
  label: REGION_LABEL[region],
  tests: TESTS.filter((test) => test.region === region),
})).filter((group) => group.tests.length > 0);

// Le scelte di "Ripeti ogni", le stesse dell'intervallo fra le sedute: 1-4 settimane.
const INTERVAL_ITEMS = [1, 2, 3, 4].map((weeks) => ({
  value: weeks,
  label: weeks === 1 ? "1 settimana" : `${weeks} settimane`,
}));

// Un numero intero scritto nel campo; un testo che non lo è passa com'è e il comando lo rifiuta.
function numberOf(text: string): number | string {
  const trimmed = text.trim();
  const n = Number(trimmed);
  return trimmed !== "" && Number.isInteger(n) ? n : trimmed;
}

export function ClinicalForm({ initial }: { initial: ClinicalInitial }) {
  const [form, formRef] = useSectionForm<Values>({
    defaultRecallWeeks: String(initial.defaultRecallWeeks),
    defaultExpectedSessions: String(initial.defaultExpectedSessions),
    defaultSessionIntervalWeeks: initial.defaultSessionIntervalWeeks,
    referralPrompts: [...initial.referralPrompts].sort(),
    activeTestCodes: [...initial.activeTestCodes].sort(),
  });
  const { values, errors, idOf } = form;
  const promptsId = useId();
  const testsId = useId();
  const pediatricId = useId();

  const togglePrompt = (code: Prompt, on: boolean) =>
    form.set(
      "referralPrompts",
      PROMPTS.map((p) => p.code).filter((c) => (c === code ? on : values.referralPrompts.includes(c))),
    );

  const toggleTest = (code: string, on: boolean) =>
    form.set(
      "activeTestCodes",
      on ? [...values.activeTestCodes, code].sort() : values.activeTestCodes.filter((active) => active !== code),
    );

  const submit = () => {
    // Un campo lasciato vuoto è «Campo obbligatorio.» e non parte: non ha senso chiedere al comando.
    const empty: Record<string, string> = {};
    if (values.defaultRecallWeeks.trim() === "") empty.defaultRecallWeeks = REQUIRED;
    if (values.defaultExpectedSessions.trim() === "") empty.defaultExpectedSessions = REQUIRED;
    if (Object.keys(empty).length > 0) {
      form.showErrors(empty);
      return;
    }
    form.startSaving(async () => {
      const result = await saveClinicalSettingsAction({
        defaultRecallWeeks: numberOf(values.defaultRecallWeeks),
        defaultExpectedSessions: numberOf(values.defaultExpectedSessions),
        defaultSessionIntervalWeeks: values.defaultSessionIntervalWeeks,
        referralPrompts: values.referralPrompts,
        activeTestCodes: values.activeTestCodes,
      });
      if (!result.ok) {
        form.fail(result);
        return;
      }
      form.done({
        ...values,
        defaultRecallWeeks: values.defaultRecallWeeks.trim(),
        defaultExpectedSessions: values.defaultExpectedSessions.trim(),
      });
    });
  };

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <UnsavedGuard dirty={form.dirty} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={idOf("defaultRecallWeeks")}
          label="Cadenza di richiamo predefinita"
          required
          hint="In settimane, da 2 a 52."
          error={errors.defaultRecallWeeks}
        >
          <Input {...form.text("defaultRecallWeeks", true)} type="number" inputMode="numeric" min={2} max={52} />
        </Field>
        <Field
          id={idOf("defaultExpectedSessions")}
          label="Sedute previste predefinite"
          required
          hint="Da 1 a 20."
          error={errors.defaultExpectedSessions}
        >
          <Input {...form.text("defaultExpectedSessions", true)} type="number" inputMode="numeric" min={1} max={20} />
        </Field>
        <Field
          id={idOf("defaultSessionIntervalWeeks")}
          label="Intervallo fra le sedute"
          required
          error={errors.defaultSessionIntervalWeeks}
        >
          <Select
            items={INTERVAL_ITEMS}
            value={values.defaultSessionIntervalWeeks}
            onValueChange={(value) => {
              if (value !== null) form.set("defaultSessionIntervalWeeks", value);
            }}
          >
            <SelectTrigger
              id={idOf("defaultSessionIntervalWeeks")}
              className="w-full"
              {...described(idOf("defaultSessionIntervalWeeks"), errors.defaultSessionIntervalWeeks)}
            >
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
        </Field>
      </div>

      <fieldset className="flex flex-col gap-3" aria-describedby={errors.referralPrompts === undefined ? undefined : `${promptsId}-errore`}>
        <legend className="mb-1 text-sm font-medium">Promemoria di rinvio</legend>
        {PROMPTS.map(({ code, label }) => {
          const switchId = idOf(`prompt-${code}`);
          return (
            <div key={code} className="flex items-center gap-2">
              <Switch
                id={switchId}
                checked={values.referralPrompts.includes(code)}
                onCheckedChange={(checked) => togglePrompt(code, checked)}
              />
              <Label htmlFor={switchId} className="font-normal">
                {label}
              </Label>
            </div>
          );
        })}
        {errors.referralPrompts === undefined ? null : (
          <p id={`${promptsId}-errore`} className="text-sm text-destructive">
            {errors.referralPrompts}
          </p>
        )}
      </fieldset>

      <fieldset
        className="flex flex-col gap-4"
        aria-describedby={errors.activeTestCodes === undefined ? undefined : `${testsId}-errore`}
      >
        <legend className="mb-1 text-sm font-medium">Test attivi</legend>
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {TEST_GROUPS.map((group) => (
            <fieldset key={group.region} className="flex flex-col gap-2">
              <legend className="mb-1 text-sm text-muted-foreground">{group.label}</legend>
              {group.tests.map((test) => {
                const switchId = idOf(`test-${test.code}`);
                return (
                  <div key={test.code} className="flex items-center gap-2">
                    <Switch
                      id={switchId}
                      checked={values.activeTestCodes.includes(test.code)}
                      onCheckedChange={(checked) => toggleTest(test.code, checked)}
                    />
                    <Label htmlFor={switchId} className="font-normal">
                      {test.name}
                    </Label>
                  </div>
                );
              })}
            </fieldset>
          ))}
        </div>
        {errors.activeTestCodes === undefined ? null : (
          <p id={`${testsId}-errore`} className="text-sm text-destructive">
            {errors.activeTestCodes}
          </p>
        )}
      </fieldset>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Switch id={pediatricId} checked={false} disabled aria-describedby={`${pediatricId}-nota`} />
          <Label htmlFor={pediatricId} className="font-normal">
            Red flag pediatriche
          </Label>
        </div>
        <p id={`${pediatricId}-nota`} className="text-sm text-muted-foreground">
          Spente finché un osteopata non le rivede.
        </p>
      </div>

      <SaveBar saving={form.saving} formError={form.formError} />
    </form>
  );
}
