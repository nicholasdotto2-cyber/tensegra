"use client";

import { saveStudioAction } from "@/app/(app)/impostazioni/actions";
import { Field, SaveBar, useSectionForm } from "@/components/forms/form-parts";
import { UnsavedGuard } from "@/components/forms/unsaved-guard";
import { Input } from "@/components/ui/input";
import { phoneDisplay, toE164 } from "@/lib/phone";
import type { PracticeSettingsView } from "@/server/domain/settings/queries";

// Studio: nome dello studio, osteopata, sede e contatti. Alimenta moduli, messaggi e fatture.
// I campi vuoti partono come "" (il comando li salva come null); il telefono si mostra "+39 051 000 0000"
// e il comando lo salva in E.164.

export type StudioInitial = Pick<
  PracticeSettingsView,
  | "practiceName"
  | "practitionerFirstName"
  | "practitionerLastName"
  | "practitionerTitle"
  | "addressLine"
  | "postalCode"
  | "city"
  | "province"
  | "phone"
  | "email"
  | "pec"
>;

interface StudioValues {
  practiceName: string;
  practitionerFirstName: string;
  practitionerLastName: string;
  practitionerTitle: string;
  addressLine: string;
  postalCode: string;
  city: string;
  province: string;
  phone: string;
  email: string;
  pec: string;
}

function valuesOf(initial: StudioInitial): StudioValues {
  return {
    practiceName: initial.practiceName,
    practitionerFirstName: initial.practitionerFirstName,
    practitionerLastName: initial.practitionerLastName,
    practitionerTitle: initial.practitionerTitle,
    addressLine: initial.addressLine ?? "",
    postalCode: initial.postalCode ?? "",
    city: initial.city ?? "",
    province: initial.province ?? "",
    phone: initial.phone === null ? "" : phoneDisplay(initial.phone),
    email: initial.email ?? "",
    pec: initial.pec ?? "",
  };
}

export function StudioForm({ initial }: { initial: StudioInitial }) {
  const [form, formRef] = useSectionForm<StudioValues>(valuesOf(initial));
  const { values, errors, idOf } = form;

  const submit = () => {
    form.startSaving(async () => {
      const result = await saveStudioAction(values);
      if (!result.ok) {
        form.fail(result);
        return;
      }
      // Il telefono salvato è quello in E.164: il campo lo riscrive nella forma a schermo.
      const e164 = toE164(values.phone);
      form.done({ ...values, phone: e164 === null ? values.phone.trim() : phoneDisplay(e164) });
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

      <Field id={idOf("practiceName")} label="Nome dello studio" required error={errors.practiceName}>
        <Input {...form.text("practiceName")} maxLength={80} autoComplete="off" />
      </Field>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-base font-medium">Osteopata</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={idOf("practitionerFirstName")} label="Nome" required error={errors.practitionerFirstName}>
            <Input {...form.text("practitionerFirstName")} maxLength={60} autoComplete="off" />
          </Field>
          <Field id={idOf("practitionerLastName")} label="Cognome" required error={errors.practitionerLastName}>
            <Input {...form.text("practitionerLastName")} maxLength={60} autoComplete="off" />
          </Field>
        </div>
        <Field id={idOf("practitionerTitle")} label="Titolo" required error={errors.practitionerTitle}>
          <Input {...form.text("practitionerTitle")} autoComplete="off" />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-base font-medium">Sede</legend>
        <Field id={idOf("addressLine")} label="Indirizzo" error={errors.addressLine}>
          <Input {...form.text("addressLine")} autoComplete="off" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[8rem_1fr_8rem]">
          <Field id={idOf("postalCode")} label="CAP" error={errors.postalCode}>
            <Input {...form.text("postalCode")} inputMode="numeric" maxLength={5} autoComplete="off" />
          </Field>
          <Field id={idOf("city")} label="Città" error={errors.city}>
            <Input {...form.text("city")} autoComplete="off" />
          </Field>
          <Field id={idOf("province")} label="Provincia" error={errors.province}>
            <Input
              {...form.text("province")}
              maxLength={2}
              autoComplete="off"
              onChange={(event) => form.set("province", event.target.value.toUpperCase())}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-base font-medium">Contatti</legend>
        <Field id={idOf("phone")} label="Telefono" error={errors.phone}>
          <Input {...form.text("phone")} type="tel" autoComplete="off" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={idOf("email")} label="Email" error={errors.email}>
            <Input {...form.text("email")} type="email" autoComplete="off" />
          </Field>
          <Field id={idOf("pec")} label="PEC" error={errors.pec}>
            <Input {...form.text("pec")} type="email" autoComplete="off" />
          </Field>
        </div>
      </fieldset>

      <SaveBar saving={form.saving} formError={form.formError} />
    </form>
  );
}
