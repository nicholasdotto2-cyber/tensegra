"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";

import { removeGuardianAction, saveGuardianAction } from "@/app/(app)/pazienti/[id]/actions";
import {
  ChoiceSelect,
  described,
  Field,
  SaveBar,
  useReportDirty,
  useSectionForm,
} from "@/components/forms/form-parts";
import { AddressFields } from "@/components/pazienti/address-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { checkTaxCode } from "@/lib/patients/tax-code";
import { phoneDisplay } from "@/lib/phone";
import type { RegistryGuardian } from "@/server/domain/patients/card";

// Un genitore o tutore dell'anagrafica: un modulo per genitore, col suo
// "Salva", e "Togli" nell'intestazione (per un genitore ancora da salvare, "Annulla"). Le regole di
// contatto e intestatario le applica `saveGuardian`: chi diventa contatto o intestatario toglie il flag
// all'altro. Qui si mostrano i suoi errori sotto il campo; il codice fiscale si controlla anche prima. Dopo
// "Salva" i valori di partenza sono quelli che il server ha risposto, non una copia di ciò che si è scritto.

export type Relationship = RegistryGuardian["relationship"];

export const RELATIONSHIP_LABEL: Record<Relationship, string> = {
  madre: "Madre",
  padre: "Padre",
  tutore: "Tutore",
  altro: "Altro",
};

const RELATIONSHIP_ITEMS: { value: Relationship; label: string }[] = (
  Object.keys(RELATIONSHIP_LABEL) as Relationship[]
).map((value) => ({ value, label: RELATIONSHIP_LABEL[value] }));

const ITALY = "IT";
const NOT_REMOVED = "Non ho tolto il genitore o tutore. Riprova.";

interface Values {
  relationship: Relationship;
  firstName: string;
  lastName: string;
  taxCode: string;
  phone: string;
  email: string;
  addressLine: string;
  postalCode: string;
  city: string;
  province: string;
  country: string;
  hasParentalAuthority: boolean;
  isContact: boolean;
  isPayer: boolean;
}

/** Il genitore come lo ha salvato il server: il telefono si legge "+39 051 000 0000". */
function valuesOf(g: RegistryGuardian): Values {
  return {
    relationship: g.relationship,
    firstName: g.firstName,
    lastName: g.lastName,
    taxCode: g.taxCode,
    phone: g.phone === "" ? "" : phoneDisplay(g.phone),
    email: g.email,
    addressLine: g.addressLine,
    postalCode: g.postalCode,
    city: g.city,
    province: g.province,
    country: g.country,
    hasParentalAuthority: g.hasParentalAuthority,
    isContact: g.isContact,
    isPayer: g.isPayer,
  };
}

/** Il genitore ancora da salvare: la relazione e il contatto li propone chi lo apre. */
export function newGuardianValues(relationship: Relationship, isContact: boolean): Values {
  return {
    relationship,
    firstName: "",
    lastName: "",
    taxCode: "",
    phone: "",
    email: "",
    addressLine: "",
    postalCode: "",
    city: "",
    province: "",
    country: ITALY,
    hasParentalAuthority: true,
    isContact,
    isPayer: false,
  };
}

function SwitchRow({
  id,
  label,
  checked,
  onCheckedChange,
  error,
}: {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  error: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} {...described(id, error)} />
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
      </div>
      {error === undefined ? null : (
        <p id={`${id}-errore`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function GuardianForm({
  patientId,
  guardian,
  start,
  report,
  onSaved,
  onGone,
  focus,
}: {
  patientId: string;
  /** Il genitore salvato; null per uno nuovo. */
  guardian: RegistryGuardian | null;
  /** I valori di partenza di un genitore nuovo. */
  start?: Values;
  report: (key: string, dirty: boolean) => void;
  /** Dopo "Salva" di un genitore nuovo: l'id che ha preso. */
  onSaved?: (id: string) => void;
  /** Dopo "Togli" o "Annulla". */
  onGone: () => void;
  /** Il focus all'apparire: sul primo campo di un genitore nuovo, sul titolo di uno appena salvato. */
  focus: "first" | "heading" | null;
}) {
  const [form, formRef] = useSectionForm<Values>(
    guardian === null ? (start ?? newGuardianValues("madre", false)) : valuesOf(guardian),
  );
  const { values, errors, idOf } = form;
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const [removing, startRemoving] = useTransition();
  const [removeError, setRemoveError] = useState<string | null>(null);

  useReportDirty(report, guardian?.id ?? "nuovo", form.dirty);

  // Se un altro genitore prende il contatto o l'intestazione, qui il flag cambia da solo: il modulo lo segue
  // (come valore e come stato salvato) senza toccare ciò che si sta scrivendo.
  const flags = guardian === null ? null : `${guardian.isContact}/${guardian.isPayer}`;
  const [seenFlags, setSeenFlags] = useState(flags);
  if (flags !== seenFlags) {
    setSeenFlags(flags);
    if (guardian !== null) form.patch({ isContact: guardian.isContact, isPayer: guardian.isPayer });
  }

  useEffect(() => {
    if (focus === "first") firstRef.current?.focus();
    if (focus === "heading") headingRef.current?.focus();
  }, [focus]);

  const submit = () => {
    const problem = checkTaxCode(values.taxCode);
    if (problem !== null) {
      form.showErrors({ taxCode: problem });
      return;
    }
    form.startSaving(async () => {
      const result = await saveGuardianAction({
        patientId,
        ...(guardian === null ? {} : { guardianId: guardian.id }),
        ...values,
      });
      if (!result.ok) {
        form.fail(result);
        return;
      }
      form.done(valuesOf(result.data.guardian));
      if (guardian === null) onSaved?.(result.data.id);
    });
  };

  const remove = () => {
    if (guardian === null) {
      onGone();
      return;
    }
    startRemoving(async () => {
      const result = await removeGuardianAction({ guardianId: guardian.id });
      if (!result.ok) {
        setRemoveError(result.message);
        return;
      }
      onGone();
    });
  };

  const title =
    guardian === null
      ? "Nuovo genitore o tutore"
      : `${RELATIONSHIP_LABEL[guardian.relationship]}: ${guardian.firstName} ${guardian.lastName}`;

  return (
    <form
      ref={formRef}
      aria-labelledby={headingId}
      noValidate
      className="flex flex-col gap-4 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h3
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="rounded-sm text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {title}
        </h3>
        <Button type="button" variant="outline" size="sm" disabled={removing} onClick={remove}>
          {guardian === null ? "Annulla" : "Togli"}
        </Button>
      </div>
      {removeError === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>{NOT_REMOVED}</AlertTitle>
          <AlertDescription>{removeError}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <ChoiceSelect
          id={idOf("relationship")}
          label="Relazione"
          required
          items={RELATIONSHIP_ITEMS}
          value={values.relationship}
          onChange={(value) => form.set("relationship", value)}
          error={errors.relationship}
          triggerRef={firstRef}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={idOf("firstName")} label="Nome" required error={errors.firstName}>
          <Input {...form.text("firstName")} maxLength={60} autoComplete="off" />
        </Field>
        <Field id={idOf("lastName")} label="Cognome" required error={errors.lastName}>
          <Input {...form.text("lastName")} maxLength={60} autoComplete="off" />
        </Field>
        <Field id={idOf("taxCode")} label="Codice fiscale" error={errors.taxCode}>
          <Input {...form.text("taxCode")} autoComplete="off" />
        </Field>
        <Field id={idOf("phone")} label="Telefono" error={errors.phone}>
          <Input {...form.text("phone")} type="tel" autoComplete="off" />
        </Field>
        <Field id={idOf("email")} label="Email" error={errors.email}>
          <Input {...form.text("email")} type="email" autoComplete="off" />
        </Field>
      </div>

      <AddressFields values={values} errors={errors} idOf={idOf} onChange={(field, value) => form.set(field, value)} />

      <div className="flex flex-col gap-3">
        <SwitchRow
          id={idOf("hasParentalAuthority")}
          label="Responsabilità genitoriale"
          checked={values.hasParentalAuthority}
          onCheckedChange={(checked) => form.set("hasParentalAuthority", checked)}
          error={errors.hasParentalAuthority}
        />
        <SwitchRow
          id={idOf("isContact")}
          label="Genitore di contatto"
          checked={values.isContact}
          onCheckedChange={(checked) => form.set("isContact", checked)}
          error={errors.isContact}
        />
        <SwitchRow
          id={idOf("isPayer")}
          label="Intestatario delle fatture"
          checked={values.isPayer}
          onCheckedChange={(checked) => form.set("isPayer", checked)}
          error={errors.isPayer}
        />
      </div>

      <SaveBar saving={form.saving} formError={form.formError} />
    </form>
  );
}
