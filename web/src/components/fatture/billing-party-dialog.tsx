"use client";

import { type RefObject, useRef } from "react";

import { saveBillingPartyAction } from "@/app/(app)/fatture/actions";
import { Field, SaveBar, useSectionForm } from "@/components/forms/form-parts";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// "Nuovo committente" dell'editor della fattura: un dialogo sopra il pannello che salva il
// committente (`saveBillingParty`) e lo sceglie come destinatario, senza lasciare la fattura. Un codice
// destinatario vuoto vale 0000000.

export interface CreatedParty {
  id: string;
  name: string;
  withholdingAgent: boolean;
}

interface Values {
  name: string;
  vatNumber: string;
  taxCode: string;
  addressLine: string;
  postalCode: string;
  city: string;
  province: string;
  recipientCode: string;
  pec: string;
  isWithholdingAgent: boolean;
}

const EMPTY: Values = {
  name: "", vatNumber: "", taxCode: "", addressLine: "", postalCode: "", city: "", province: "",
  recipientCode: "", pec: "", isWithholdingAgent: false,
};

function PartyForm({
  firstFieldRef,
  onOpenChange,
  onCreated,
}: {
  firstFieldRef: RefObject<HTMLInputElement | null>;
  onOpenChange: (open: boolean) => void;
  onCreated: (party: CreatedParty) => void;
}) {
  const [form, formRef] = useSectionForm<Values>(EMPTY);
  const { values, errors, idOf } = form;

  const submit = () => {
    form.startSaving(async () => {
      const result = await saveBillingPartyAction({
        id: null, name: values.name, vatNumber: values.vatNumber, taxCode: values.taxCode.toUpperCase(),
        addressLine: values.addressLine, postalCode: values.postalCode, city: values.city,
        province: values.province.trim().toUpperCase(),
        // Vuoto: il comando mette 0000000.
        ...(values.recipientCode.trim() === "" ? {} : { recipientCode: values.recipientCode.trim().toUpperCase() }),
        pec: values.pec, isWithholdingAgent: values.isWithholdingAgent,
      });
      if (!result.ok) {
        form.fail(result);
        return;
      }
      onCreated({ id: result.data.id, name: values.name.trim(), withholdingAgent: values.isWithholdingAgent });
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
      <Field id={idOf("name")} label="Denominazione" required error={errors.name}>
        <Input {...form.text("name")} ref={firstFieldRef} autoComplete="off" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={idOf("vatNumber")} label="Partita IVA" error={errors.vatNumber}>
          <Input {...form.text("vatNumber")} inputMode="numeric" autoComplete="off" />
        </Field>
        <Field id={idOf("taxCode")} label="Codice fiscale" error={errors.taxCode}>
          <Input {...form.text("taxCode")} autoComplete="off" />
        </Field>
      </div>
      <Field id={idOf("addressLine")} label="Indirizzo" required error={errors.addressLine}>
        <Input {...form.text("addressLine")} autoComplete="off" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[8rem_1fr_6rem]">
        <Field id={idOf("postalCode")} label="CAP" required error={errors.postalCode}>
          <Input {...form.text("postalCode")} inputMode="numeric" autoComplete="off" />
        </Field>
        <Field id={idOf("city")} label="Città" required error={errors.city}>
          <Input {...form.text("city")} autoComplete="off" />
        </Field>
        <Field id={idOf("province")} label="Provincia" required error={errors.province}>
          <Input {...form.text("province")} maxLength={2} autoComplete="off" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={idOf("recipientCode")}
          label="Codice destinatario"
          hint="7 lettere o cifre; vuoto vale 0000000."
          error={errors.recipientCode}
        >
          <Input {...form.text("recipientCode", true)} maxLength={7} autoComplete="off" />
        </Field>
        <Field id={idOf("pec")} label="PEC" error={errors.pec}>
          <Input {...form.text("pec")} type="email" autoComplete="off" />
        </Field>
      </div>
      <Label className="min-h-6 font-normal">
        <Checkbox
          checked={values.isWithholdingAgent}
          onCheckedChange={(checked) => form.set("isWithholdingAgent", checked)}
        />
        Sostituto d&apos;imposta
      </Label>

      <div className="flex flex-col-reverse items-start gap-2 sm:flex-row sm:items-start sm:justify-end">
        <DialogClose render={<Button type="button" variant="outline" />}>Torna indietro</DialogClose>
        <SaveBar
          saving={form.saving}
          formError={form.formError}
          label="Salva il committente"
          failTitle="Non ho salvato il committente. Riprova."
        />
      </div>
    </form>
  );
}

export function BillingPartyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (party: CreatedParty) => void;
}) {
  const firstFieldRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={firstFieldRef} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuovo committente</DialogTitle>
        </DialogHeader>
        {/* Il modulo nasce a ogni apertura: i campi ripartono vuoti. */}
        <PartyForm firstFieldRef={firstFieldRef} onOpenChange={onOpenChange} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}
