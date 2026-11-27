"use client";

import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { saveRecipientFieldsAction } from "@/app/(app)/fatture/actions";
import { BillingPartyDialog, type CreatedParty } from "@/components/fatture/billing-party-dialog";
import { described, Field } from "@/components/forms/form-parts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { EditorRecipient } from "@/lib/fiscal/editor-state";
import { cn } from "@/lib/utils";
import type { InvoiceEditorView } from "@/server/domain/invoices/queries";

// Il destinatario dell'editor: un paziente cercato per nome, il suo
// genitore o tutore intestatario (proposto per un minore), oppure un committente dalla lista o da "Nuovo
// committente". Se mancano codice fiscale o indirizzo del paziente o del genitore, i campi compaiono qui e
// "Salva in anagrafica" li scrive nella sua anagrafica: un campo lasciato vuoto non cancella niente.

type Patient = InvoiceEditorView["recipients"]["patients"][number];
export type Party = InvoiceEditorView["recipients"]["parties"][number];

const NO_MATCH = "Nessun paziente con questo nome.";
const NOT_SAVED = "Non ho salvato i dati in anagrafica. Riprova.";
const SAVED = "Modifiche salvate.";

/** Quali dati fiscali mancano al destinatario, e i valori che ha già. */
export interface MissingFields {
  taxCode: boolean;
  address: boolean;
  known: { addressLine: string | null; postalCode: string | null; city: string | null; province: string | null } | null;
}

function patientOf(recipient: EditorRecipient | null): string | null {
  return recipient === null || recipient.kind === "committente" ? null : recipient.patientId;
}

function PatientSearch({
  id,
  patients,
  value,
  onChange,
  error,
}: {
  id: string;
  patients: readonly Patient[];
  value: Patient | null;
  onChange: (patient: Patient | null) => void;
  error: string | undefined;
}) {
  const [inputValue, setInputValue] = useState(value?.name ?? "");
  // Un paziente scelto da fuori (una seduta aggiunta, una bozza) riempie il campo col suo nome.
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    if (value !== null) setInputValue(value.name);
  }
  const needle = inputValue.trim().toLocaleLowerCase("it-IT");
  const options = needle === "" ? [] : patients.filter((p) => p.name.toLocaleLowerCase("it-IT").includes(needle));

  return (
    <Combobox<Patient>
      items={options}
      filter={null}
      value={value}
      onValueChange={(next, details) => {
        // Esc con un paziente scelto non lo toglie: chiude il pannello, come in ogni altro campo.
        if (details.reason === "escape-key") {
          details.allowPropagation();
          return;
        }
        onChange(next);
      }}
      inputValue={inputValue}
      onInputValueChange={(text, details) => {
        if (details.reason === "escape-key") {
          details.allowPropagation();
          return;
        }
        setInputValue(text);
        if (details.reason === "input-change" && value !== null) onChange(null);
      }}
      itemToStringLabel={(patient) => patient.name}
      isItemEqualToValue={(a, b) => a.id === b.id}
    >
      <ComboboxInput
        id={id}
        className="w-full"
        showTrigger={false}
        autoComplete="off"
        {...described(id, error)}
      />
      <ComboboxContent className={cn(needle === "" && "hidden")}>
        <ComboboxEmpty>{NO_MATCH}</ComboboxEmpty>
        <ComboboxList>
          {(patient: Patient) => (
            <ComboboxItem key={patient.id} value={patient}>
              {patient.name}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function MissingFieldsForm({
  recipient,
  missing,
  idOf,
  onSaved,
}: {
  recipient: Exclude<EditorRecipient, { kind: "committente" }>;
  missing: MissingFields;
  idOf: (field: string) => string;
  onSaved: () => void;
}) {
  const [taxCode, setTaxCode] = useState("");
  const [address, setAddress] = useState({
    addressLine: missing.known?.addressLine ?? "", postalCode: missing.known?.postalCode ?? "",
    city: missing.known?.city ?? "", province: missing.known?.province ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const who = recipient.kind === "tutore" ? "del genitore" : "del paziente";

  const save = () => {
    startSaving(async () => {
      const result = await saveRecipientFieldsAction({
        ...recipient,
        ...(missing.taxCode ? { taxCode: taxCode.trim().toUpperCase() } : {}),
        ...(missing.address ? { address: { ...address, province: address.province.trim().toUpperCase() } } : {}),
      });
      if (!result.ok) {
        const fieldErrors = result.fieldErrors ?? {};
        if (Object.keys(fieldErrors).length > 0) {
          setErrors(fieldErrors);
          setFormError(null);
          const first = Object.keys(fieldErrors)[0]!;
          const target = first === "address.addressLine" ? "recipient.address" : `recipient.${first}`;
          document.getElementById(idOf(target))?.focus();
        } else {
          setErrors({});
          setFormError(result.message);
        }
        return;
      }
      setErrors({});
      setFormError(null);
      toast.success(SAVED);
      onSaved();
    });
  };

  const addressInput = (field: keyof typeof address) => {
    const id = idOf(field === "addressLine" ? "recipient.address" : `recipient.address.${field}`);
    return {
      id,
      value: address[field],
      autoComplete: "off",
      onChange: (event: { target: { value: string } }) => setAddress((current) => ({ ...current, [field]: event.target.value })),
      ...described(id, errors[`address.${field}`]),
    };
  };

  return (
    <div role="group" aria-label={`Dati fiscali ${who}`} className="flex flex-col gap-4 rounded-lg border p-3">
      <p className="text-sm text-muted-foreground">{`Mancano dati ${who}: si salvano anche in anagrafica.`}</p>
      {missing.taxCode ? (
        <Field id={idOf("recipient.taxCode")} label="Codice fiscale" error={errors.taxCode}>
          <Input
            id={idOf("recipient.taxCode")}
            value={taxCode}
            maxLength={16}
            autoComplete="off"
            onChange={(event) => setTaxCode(event.target.value)}
            {...described(idOf("recipient.taxCode"), errors.taxCode)}
          />
        </Field>
      ) : null}
      {missing.address ? (
        <>
          <Field id={idOf("recipient.address")} label="Indirizzo" error={errors["address.addressLine"]}>
            <Input {...addressInput("addressLine")} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr_6rem]">
            <Field id={idOf("recipient.address.postalCode")} label="CAP" error={errors["address.postalCode"]}>
              <Input {...addressInput("postalCode")} inputMode="numeric" />
            </Field>
            <Field id={idOf("recipient.address.city")} label="Città" error={errors["address.city"]}>
              <Input {...addressInput("city")} />
            </Field>
            <Field id={idOf("recipient.address.province")} label="Provincia" error={errors["address.province"]}>
              <Input {...addressInput("province")} maxLength={2} />
            </Field>
          </div>
        </>
      ) : null}
      {formError === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>{NOT_SAVED}</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button type="button" variant="outline" disabled={saving} onClick={save}>
          Salva in anagrafica
        </Button>
      </div>
    </div>
  );
}

export function RecipientFields({
  patients,
  parties,
  value,
  onChange,
  onPartyCreated,
  error,
  idOf,
  missing,
  onFieldsSaved,
}: {
  patients: readonly Patient[];
  parties: readonly Party[];
  value: EditorRecipient | null;
  onChange: (recipient: EditorRecipient | null) => void;
  onPartyCreated: (party: CreatedParty) => void;
  error: string | undefined;
  idOf: (field: string) => string;
  /** Null se i dati del destinatario ci sono o non si conoscono ancora. */
  missing: MissingFields | null;
  onFieldsSaved: () => void;
}) {
  const headingId = useId();
  const kindLabelId = useId();
  const payerLabelId = useId();
  const [mode, setMode] = useState<"persona" | "committente">(value?.kind === "committente" ? "committente" : "persona");
  const [partyOpen, setPartyOpen] = useState(false);
  const patientId = patientOf(value);
  const patient = patientId === null ? null : (patients.find((p) => p.id === patientId) ?? null);
  const partyId = value?.kind === "committente" ? value.billingPartyId : null;
  const partyItems = parties.map((party) => ({ value: party.id, label: party.name }));
  const fieldId = idOf("recipient");

  const choosePatient = (next: Patient | null) => {
    if (next === null) onChange(null);
    // Un minore con un genitore intestatario va al genitore; si può sempre cambiare.
    else if (next.minor && next.payerGuardian !== null) {
      onChange({ kind: "tutore", patientId: next.id, guardianId: next.payerGuardian.id });
    } else onChange({ kind: "paziente", patientId: next.id });
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h3 id={headingId} className="font-medium">
        Destinatario
      </h3>
      <div className="flex flex-col gap-2">
        <span id={kindLabelId} className="text-sm leading-none font-medium">
          Intestata a
        </span>
        <RadioGroup
          aria-labelledby={kindLabelId}
          value={mode}
          onValueChange={(next) => {
            if (next !== "persona" && next !== "committente") return;
            setMode(next);
            if (next !== mode) onChange(null);
          }}
          className="flex flex-wrap gap-4"
        >
          <Label className="min-h-6 font-normal">
            <RadioGroupItem value="persona" />
            Paziente
          </Label>
          <Label className="min-h-6 font-normal">
            <RadioGroupItem value="committente" />
            Committente
          </Label>
        </RadioGroup>
      </div>

      {mode === "persona" ? (
        <>
          <Field id={fieldId} label="Paziente" error={error}>
            <PatientSearch id={fieldId} patients={patients} value={patient} onChange={choosePatient} error={error} />
          </Field>
          {patient !== null && patient.payerGuardian !== null && value !== null && value.kind !== "committente" ? (
            <div className="flex flex-col gap-2">
              <span id={payerLabelId} className="text-sm leading-none font-medium">
                Intestatario
              </span>
              <RadioGroup
                aria-labelledby={payerLabelId}
                value={value.kind}
                onValueChange={(next) => {
                  if (next === "paziente") onChange({ kind: "paziente", patientId: patient.id });
                  if (next === "tutore" && patient.payerGuardian !== null) {
                    onChange({ kind: "tutore", patientId: patient.id, guardianId: patient.payerGuardian.id });
                  }
                }}
                className="flex flex-col gap-2"
              >
                <Label className="min-h-6 font-normal">
                  <RadioGroupItem value="paziente" />
                  {patient.name}
                </Label>
                <Label className="min-h-6 font-normal">
                  <RadioGroupItem value="tutore" />
                  {`Genitore o tutore: ${patient.payerGuardian.name}`}
                </Label>
              </RadioGroup>
            </div>
          ) : null}
          {missing !== null && value !== null && value.kind !== "committente" ? (
            <MissingFieldsForm
              key={JSON.stringify(value)}
              recipient={value}
              missing={missing}
              idOf={idOf}
              onSaved={onFieldsSaved}
            />
          ) : null}
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <Field id={fieldId} label="Committente" error={error}>
            <Select
              items={partyItems}
              value={partyId}
              onValueChange={(next) => {
                if (next !== null) onChange({ kind: "committente", billingPartyId: next });
              }}
            >
              <SelectTrigger id={fieldId} className="w-full" {...described(fieldId, error)}>
                <SelectValue placeholder="Scegli il committente" />
              </SelectTrigger>
              <SelectContent>
                {partyItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div>
            <Button type="button" variant="outline" onClick={() => setPartyOpen(true)}>
              Nuovo committente
            </Button>
          </div>
          <BillingPartyDialog
            open={partyOpen}
            onOpenChange={setPartyOpen}
            onCreated={(party) => {
              onPartyCreated(party);
              onChange({ kind: "committente", billingPartyId: party.id });
            }}
          />
        </div>
      )}
    </section>
  );
}
