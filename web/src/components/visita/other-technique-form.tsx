"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { described, Field } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Approach, RegionCode } from "@/lib/clinical/catalog";
import { APPROACH_REQUIRED, TECHNIQUE_NAME_REQUIRED } from "@/lib/clinical/labels";
import type { TreatmentCheck } from "@/lib/clinical/rules";
import { approachItems, blockedHint, newFields, techniqueOp, treatmentKey } from "@/lib/visits/treatment-row";

import { ChoiceGroup, useUnsavedDraft } from "./choice-group";
import type { VisitSectionProps } from "./visit-editor";

// «Altra tecnica»: il nome libero e l'approccio, senza predefinito. Un approccio che
// lo screening blocca è disattivato col suo motivo (`approachChecks`). Il modulo resta aperto finché il comando non
// risponde: una riga nata chiude il modulo (lo fa la riga della regione, che vede la tecnica comparire), un rifiuto
// lascia il nome scritto con la frase sotto il campo. Il nome non ancora salvato conta per l'avviso di uscita.

const NAME_MAX = 60;
const ALREADY_THERE = "Questa tecnica è già nella riga.";
const OTHER_CODE = "altra";
const RADIO_TAB_STOP = '[role="radio"][tabindex="0"]';

interface Errors {
  name?: string;
  approach?: string;
}

export function OtherTechniqueForm({
  region,
  op,
  approachChecks,
  existing,
  onSent,
  onClose,
}: {
  region: RegionCode;
  op: VisitSectionProps["op"];
  /** Il blocco di ogni approccio per «Altra tecnica» in questa regione (`VisitEditor.approachChecks`). */
  approachChecks: Partial<Record<Approach, TreatmentCheck>> | undefined;
  /** Le chiavi delle altre tecniche già nella riga. */
  existing: ReadonlySet<string>;
  /** La chiave inviata, o null dopo un rifiuto: la riga della regione chiude il modulo quando la tecnica compare. */
  onSent: (key: string | null) => void;
  onClose: () => void;
}) {
  const baseId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [approach, setApproach] = useState<Approach | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  useUnsavedDraft(name !== "");
  useEffect(() => nameRef.current?.focus(), []);

  const focusApproach = () => document.getElementById(`${baseId}-approccio`)?.querySelector<HTMLElement>(RADIO_TAB_STOP)?.focus();
  const show = (found: Errors) => {
    setErrors(found);
    if (found.name !== undefined) nameRef.current?.focus();
    else focusApproach();
  };

  const submit = () => {
    if (pending) return;
    const clean = name.trim();
    const key = treatmentKey({ techniqueCode: OTHER_CODE, customTechnique: clean });
    if (clean === "" || approach === null) {
      show({
        name: clean === "" ? TECHNIQUE_NAME_REQUIRED : undefined,
        approach: approach === null ? APPROACH_REQUIRED : undefined,
      });
      return;
    }
    if (existing.has(key)) {
      show({ name: ALREADY_THERE });
      return;
    }
    setErrors({});
    setPending(true);
    onSent(key);
    op(techniqueOp({ region, techniqueCode: OTHER_CODE, customTechnique: clean }, newFields(approach)), {
      onRefused: (failure) => {
        const fields = failure.fieldErrors ?? {};
        setPending(false);
        onSent(null);
        // Una frase che non è di un campo (il blocco dello screening) è un problema dell'approccio.
        show(
          fields.customTechnique === undefined && fields.approach === undefined
            ? { approach: failure.message }
            : { name: fields.customTechnique, approach: fields.approach },
        );
      },
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" onKeyDown={onKeyDown}>
      <Field id={`${baseId}-nome`} label="Nome della tecnica" required error={errors.name}>
        <Input
          id={`${baseId}-nome`}
          ref={nameRef}
          value={name}
          maxLength={NAME_MAX}
          autoComplete="off"
          onChange={(event) => {
            setName(event.target.value);
            setErrors({});
          }}
          {...described(`${baseId}-nome`, errors.name)}
        />
      </Field>
      <ChoiceGroup
        id={`${baseId}-approccio`}
        label="Approccio della tecnica"
        required
        items={approachItems(approachChecks)}
        value={approach}
        error={errors.approach}
        hint={blockedHint(approachChecks)}
        onChange={(next) => {
          setApproach(next);
          setErrors({});
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={submit}>
          Aggiungi la tecnica
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Torna indietro
        </Button>
      </div>
    </div>
  );
}
