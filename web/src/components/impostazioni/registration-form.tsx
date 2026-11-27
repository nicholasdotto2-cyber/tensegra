"use client";

import { TriangleAlertIcon } from "lucide-react";

import { saveRegistrationAction } from "@/app/(app)/impostazioni/actions";
import { Field, SaveBar, described, useSectionForm } from "@/components/forms/form-parts";
import { UnsavedGuard } from "@/components/forms/unsaved-guard";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { insuranceWarning } from "@/lib/settings/insurance";
import type { PracticeSettingsView } from "@/server/domain/settings/queries";

// Iscrizione e polizza: tipo di iscrizione, Ordine, provincia, numero e data; compagnia, polizza,
// massimale in euro interi e scadenza. Sotto la scadenza compare l'avviso se la polizza è scaduta o scade
// entro 30 giorni (`insuranceWarning`), solo come sfondo `warning` con il suo testo.

export type RegistrationInitial = Pick<
  PracticeSettingsView,
  | "registrationKind"
  | "registrationOrder"
  | "registrationProvince"
  | "registrationNumber"
  | "registrationDate"
  | "insuranceCompany"
  | "insurancePolicyNumber"
  | "insuranceLimitCents"
  | "insuranceExpiresOn"
> & {
  /** Oggi a Roma, "AAAA-MM-GG": l'avviso della polizza conta i giorni da qui. */
  today: string;
};

type Kind = PracticeSettingsView["registrationKind"];

const KIND_ITEMS: readonly { value: Kind; label: string }[] = [
  { value: "nessuna", label: "Nessuna" },
  { value: "in_attesa", label: "In attesa di iscrizione" },
  { value: "ese", label: "Elenco speciale" },
  { value: "albo", label: "Albo" },
];

interface Values {
  registrationKind: Kind;
  registrationOrder: string;
  registrationProvince: string;
  registrationNumber: string;
  registrationDate: string;
  insuranceCompany: string;
  insurancePolicyNumber: string;
  /** Il massimale come lo scrive chi compila: "2.000.000", vuoto se non c'è. */
  insuranceLimitEuros: string;
  insuranceExpiresOn: string;
}

const EURO_NUMBER = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 });

function valuesOf(initial: RegistrationInitial): Values {
  return {
    registrationKind: initial.registrationKind,
    registrationOrder: initial.registrationOrder ?? "",
    registrationProvince: initial.registrationProvince ?? "",
    registrationNumber: initial.registrationNumber ?? "",
    registrationDate: initial.registrationDate ?? "",
    insuranceCompany: initial.insuranceCompany ?? "",
    insurancePolicyNumber: initial.insurancePolicyNumber ?? "",
    insuranceLimitEuros: initial.insuranceLimitCents === null ? "" : EURO_NUMBER.format(initial.insuranceLimitCents / 100),
    insuranceExpiresOn: initial.insuranceExpiresOn ?? "",
  };
}

// "2.000.000" o "2 000 000" -> 2000000. Un testo che non è un importo intero passa com'è: il comando lo
// rifiuta con il suo messaggio sotto il campo.
function limitOf(text: string): number | string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const digits = trimmed.replace(/[.\s]/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : trimmed;
}

export function RegistrationForm({ initial }: { initial: RegistrationInitial }) {
  const [form, formRef] = useSectionForm<Values>(valuesOf(initial));
  const { values, errors, idOf } = form;
  const warning = insuranceWarning(/^\d{4}-\d{2}-\d{2}$/.test(values.insuranceExpiresOn) ? values.insuranceExpiresOn : null, initial.today);
  const expiresId = idOf("insuranceExpiresOn");

  const submit = () => {
    form.startSaving(async () => {
      const result = await saveRegistrationAction({ ...values, insuranceLimitEuros: limitOf(values.insuranceLimitEuros) });
      if (!result.ok) {
        form.fail(result);
        return;
      }
      const limit = limitOf(values.insuranceLimitEuros);
      form.done({ ...values, insuranceLimitEuros: typeof limit === "number" ? EURO_NUMBER.format(limit) : values.insuranceLimitEuros.trim() });
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

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-base font-medium">Iscrizione</legend>
        <Field id={idOf("registrationKind")} label="Tipo di iscrizione" required error={errors.registrationKind}>
          <Select
            items={KIND_ITEMS}
            value={values.registrationKind}
            onValueChange={(value) => {
              if (value !== null) form.set("registrationKind", value);
            }}
          >
            <SelectTrigger
              id={idOf("registrationKind")}
              className="w-full sm:max-w-xs"
              {...described(idOf("registrationKind"), errors.registrationKind)}
            >
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
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <Field id={idOf("registrationOrder")} label="Ordine" error={errors.registrationOrder}>
            <Input {...form.text("registrationOrder")} maxLength={60} autoComplete="off" />
          </Field>
          <Field id={idOf("registrationProvince")} label="Provincia dell'Ordine" error={errors.registrationProvince}>
            <Input
              {...form.text("registrationProvince")}
              maxLength={2}
              autoComplete="off"
              onChange={(event) => form.set("registrationProvince", event.target.value.toUpperCase())}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={idOf("registrationNumber")} label="Numero di iscrizione" error={errors.registrationNumber}>
            <Input {...form.text("registrationNumber")} maxLength={60} autoComplete="off" />
          </Field>
          <Field id={idOf("registrationDate")} label="Data di iscrizione" error={errors.registrationDate}>
            <Input {...form.text("registrationDate")} type="date" />
          </Field>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-base font-medium">Polizza</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={idOf("insuranceCompany")} label="Compagnia" error={errors.insuranceCompany}>
            <Input {...form.text("insuranceCompany")} autoComplete="off" />
          </Field>
          <Field id={idOf("insurancePolicyNumber")} label="Numero di polizza" error={errors.insurancePolicyNumber}>
            <Input {...form.text("insurancePolicyNumber")} autoComplete="off" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={idOf("insuranceLimitEuros")} label="Massimale in euro" error={errors.insuranceLimitEuros}>
            <Input {...form.text("insuranceLimitEuros")} inputMode="numeric" autoComplete="off" />
          </Field>
          <Field id={expiresId} label="Scadenza della polizza" error={errors.insuranceExpiresOn}>
            <Input
              {...form.text("insuranceExpiresOn")}
              type="date"
              aria-describedby={
                [warning === null ? null : `${expiresId}-avviso`, errors.insuranceExpiresOn === undefined ? null : `${expiresId}-errore`]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            />
          </Field>
        </div>
        {warning === null ? null : (
          <p
            id={`${expiresId}-avviso`}
            className="flex w-fit items-center gap-2 rounded-lg bg-warning px-3 py-2 text-sm text-warning-foreground"
          >
            <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
            {warning}
          </p>
        )}
      </fieldset>

      <SaveBar saving={form.saving} formError={form.formError} />
    </form>
  );
}
