"use client";

import { Field, described } from "@/components/forms/form-parts";
import { Input } from "@/components/ui/input";

// I cinque campi dell'indirizzo, uguali per il paziente (gruppo «Indirizzo (per la fattura)») e per ogni
// genitore o tutore. I valori vuoti sono "" e il comando li salva come null; il paese
// vuoto vale IT.

export interface AddressValues {
  addressLine: string;
  postalCode: string;
  city: string;
  province: string;
  country: string;
}

export function AddressFields({
  values,
  errors,
  idOf,
  onChange,
}: {
  values: AddressValues;
  errors: Readonly<Record<string, string>>;
  idOf: (field: string) => string;
  onChange: (field: keyof AddressValues, value: string) => void;
}) {
  const input = (field: keyof AddressValues, hasHint = false) => ({
    id: idOf(field),
    value: values[field],
    onChange: (event: { target: { value: string } }) => onChange(field, event.target.value),
    autoComplete: "off",
    ...described(idOf(field), errors[field], hasHint),
  });
  return (
    <div className="flex flex-col gap-4">
      <Field id={idOf("addressLine")} label="Indirizzo" error={errors.addressLine}>
        <Input {...input("addressLine")} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[8rem_1fr_6rem_8rem]">
        <Field id={idOf("postalCode")} label="CAP" error={errors.postalCode}>
          <Input {...input("postalCode")} inputMode="numeric" />
        </Field>
        <Field id={idOf("city")} label="Città" error={errors.city}>
          <Input {...input("city")} />
        </Field>
        <Field id={idOf("province")} label="Provincia" error={errors.province}>
          <Input {...input("province")} />
        </Field>
        <Field id={idOf("country")} label="Paese" hint="Sigla di 2 lettere, per esempio IT." error={errors.country}>
          <Input {...input("country", true)} maxLength={2} />
        </Field>
      </div>
    </div>
  );
}
