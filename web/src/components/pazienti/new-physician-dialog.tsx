"use client";

import { type RefObject, useRef } from "react";

import { createPhysicianAction } from "@/app/(app)/pazienti/[id]/actions";
import { ChoiceSelect, described, Field, SaveBar, useSectionForm } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { PhysicianOption } from "@/server/domain/physicians/queries";
import type { PhysicianRole } from "@/server/domain/physicians/schemas";

// "Nuovo medico" dell'anagrafica: un mini dialogo che aggiunge un medico
// alla rubrica dello studio. Il medico entra subito nelle scelte della scheda, senza lasciare la pagina.

export const PHYSICIAN_ROLE_LABEL: Record<PhysicianRole, string> = {
  mmg: "Medico di medicina generale",
  pediatra: "Pediatra",
  specialista: "Specialista",
  altro: "Altro",
};

const ROLE_ITEMS: { value: PhysicianRole; label: string }[] = (
  Object.keys(PHYSICIAN_ROLE_LABEL) as PhysicianRole[]
).map((value) => ({ value, label: PHYSICIAN_ROLE_LABEL[value] }));

interface Values {
  fullName: string;
  role: PhysicianRole;
  specialty: string;
  organization: string;
  phone: string;
  email: string;
  notes: string;
}

const EMPTY: Values = { fullName: "", role: "mmg", specialty: "", organization: "", phone: "", email: "", notes: "" };

function PhysicianForm({
  firstFieldRef,
  onOpenChange,
  onCreated,
}: {
  firstFieldRef: RefObject<HTMLInputElement | null>;
  onOpenChange: (open: boolean) => void;
  onCreated: (physician: PhysicianOption) => void;
}) {
  const [form, formRef] = useSectionForm<Values>(EMPTY);
  const { values, errors, idOf } = form;

  const submit = () => {
    form.startSaving(async () => {
      const result = await createPhysicianAction(values);
      if (!result.ok) {
        form.fail(result);
        return;
      }
      onCreated({ id: result.data.id, fullName: values.fullName.trim(), role: values.role });
      onOpenChange(false);
    });
  };

  return (
    <form
      ref={formRef}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field id={idOf("fullName")} label="Nome e titolo" required error={errors.fullName}>
        <Input {...form.text("fullName")} ref={firstFieldRef} autoComplete="off" />
      </Field>
      <ChoiceSelect
        id={idOf("role")}
        label="Ruolo"
        required
        items={ROLE_ITEMS}
        value={values.role}
        onChange={(value) => form.set("role", value)}
        error={errors.role}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={idOf("specialty")} label="Specialità" error={errors.specialty}>
          <Input {...form.text("specialty")} autoComplete="off" />
        </Field>
        <Field id={idOf("organization")} label="Struttura" error={errors.organization}>
          <Input {...form.text("organization")} autoComplete="off" />
        </Field>
        <Field id={idOf("phone")} label="Telefono" error={errors.phone}>
          <Input {...form.text("phone")} type="tel" autoComplete="off" />
        </Field>
        <Field id={idOf("email")} label="Email" error={errors.email}>
          <Input {...form.text("email")} type="email" autoComplete="off" />
        </Field>
      </div>
      <Field id={idOf("notes")} label="Note" error={errors.notes}>
        <Textarea
          id={idOf("notes")}
          value={values.notes}
          onChange={(event) => form.set("notes", event.target.value)}
          {...described(idOf("notes"), errors.notes)}
        />
      </Field>

      <div className="flex flex-col-reverse items-start gap-2 sm:flex-row sm:items-start sm:justify-end">
        <DialogClose render={<Button type="button" variant="outline" />}>Torna indietro</DialogClose>
        <SaveBar saving={form.saving} formError={form.formError} label="Salva il medico" failTitle="Non ho salvato il medico. Riprova." />
      </div>
    </form>
  );
}

export function NewPhysicianDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (physician: PhysicianOption) => void;
}) {
  const firstFieldRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={firstFieldRef} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuovo medico</DialogTitle>
        </DialogHeader>
        {/* Il modulo nasce a ogni apertura: i campi ripartono vuoti. */}
        <PhysicianForm firstFieldRef={firstFieldRef} onOpenChange={onOpenChange} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}
