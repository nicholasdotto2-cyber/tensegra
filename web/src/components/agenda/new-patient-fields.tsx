"use client";

import { type Ref, useId } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Il mini modulo "Nuovo paziente" dentro il dialogo dell'appuntamento: nome,
// cognome, data di nascita e telefono; per un minore a oggi anche il genitore o tutore. Il paziente si
// salva con l'appuntamento, nella stessa transazione. Gli errori arrivano dal comando sotto `patient.`
// (per esempio `patient.birthDate`, `patient.guardian.firstName`).

export interface NewPatientDraft {
  firstName: string;
  lastName: string;
  /** "AAAA-MM-GG", "" finché non è scritta. */
  birthDate: string;
  phone: string;
  guardian: { firstName: string; lastName: string; phone: string };
}

export const EMPTY_GUARDIAN: NewPatientDraft["guardian"] = { firstName: "", lastName: "", phone: "" };

type FieldName = "firstName" | "lastName" | "birthDate" | "phone";

function TextField({
  label,
  required,
  value,
  onChange,
  error,
  type = "text",
  autoComplete,
  inputRef,
}: {
  label: string;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
  type?: "text" | "date" | "tel";
  autoComplete?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  const errorId = `${id}-errore`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="font-normal text-muted-foreground">(obbligatorio)</span> : null}
      </Label>
      <Input
        ref={inputRef}
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        data-field-error={error === undefined ? undefined : ""}
      />
      {error === undefined ? null : (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function NewPatientFields({
  draft,
  onChange,
  minor,
  errors,
  firstFieldRef,
  bare = false,
}: {
  draft: NewPatientDraft;
  onChange: (draft: NewPatientDraft) => void;
  /** Minore a oggi: serve il genitore o tutore. */
  minor: boolean;
  /** Gli errori del comando, per percorso. */
  errors: Readonly<Record<string, string>>;
  firstFieldRef?: Ref<HTMLInputElement>;
  /** Nel dialogo "Nuovo paziente" il titolo c'è già: niente riquadro, legenda solo per i lettori di schermo. */
  bare?: boolean;
}) {
  const set = (field: FieldName) => (value: string) => onChange({ ...draft, [field]: value });
  const setGuardian = (field: keyof NewPatientDraft["guardian"]) => (value: string) =>
    onChange({ ...draft, guardian: { ...draft.guardian, [field]: value } });

  return (
    <fieldset className={cn("flex flex-col gap-3", !bare && "rounded-lg border p-3")}>
      <legend className={bare ? "sr-only" : "px-1 text-sm font-medium"}>Nuovo paziente</legend>
      <p className="text-sm text-muted-foreground">Versione di prova: inserisci solo dati inventati.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Nome"
          required
          value={draft.firstName}
          onChange={set("firstName")}
          error={errors["patient.firstName"]}
          autoComplete="off"
          inputRef={firstFieldRef}
        />
        <TextField
          label="Cognome"
          required
          value={draft.lastName}
          onChange={set("lastName")}
          error={errors["patient.lastName"]}
          autoComplete="off"
        />
        <TextField
          label="Data di nascita"
          required
          type="date"
          value={draft.birthDate}
          onChange={set("birthDate")}
          error={errors["patient.birthDate"]}
        />
        <TextField
          label="Telefono"
          type="tel"
          value={draft.phone}
          onChange={set("phone")}
          error={errors["patient.phone"]}
          autoComplete="off"
        />
      </div>
      {minor ? (
        <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Genitore o tutore</legend>
          {errors["patient.guardian"] === undefined ? null : (
            <p className="text-sm text-destructive">{errors["patient.guardian"]}</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Nome"
              required
              value={draft.guardian.firstName}
              onChange={setGuardian("firstName")}
              error={errors["patient.guardian.firstName"]}
              autoComplete="off"
            />
            <TextField
              label="Cognome"
              required
              value={draft.guardian.lastName}
              onChange={setGuardian("lastName")}
              error={errors["patient.guardian.lastName"]}
              autoComplete="off"
            />
            <TextField
              label="Telefono"
              type="tel"
              value={draft.guardian.phone}
              onChange={setGuardian("phone")}
              error={errors["patient.guardian.phone"]}
              autoComplete="off"
            />
          </div>
        </fieldset>
      ) : null}
    </fieldset>
  );
}
