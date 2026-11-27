"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { RunOptions } from "@/lib/visits/save-queue";
import type { PerinatalRow } from "@/server/domain/history/queries";
import type { VisitEditor } from "@/server/domain/visits/editor";

import { ChoiceField, SelectField, YES_NO } from "./choice-group";
import { Block, type HistorySave, useGroup } from "./history-parts";
import { VisitTextField } from "./visit-text-field";

// L'anamnesi perinatale: sotto i 24 mesi è aperta da sola, sopra resta dietro
// «Apri l'anamnesi perinatale» (e si vede sempre se una riga è già salvata). È un gruppo che il comando riscrive
// intero: una chiave a `null` è un dato non noto.

const EMPTY_PERINATAL: PerinatalRow = {
  gestationalAgeWeeks: null,
  birthWeightG: null,
  deliveryMode: null,
  presentation: null,
  labourHours: null,
  apgar1: null,
  apgar5: null,
  nicuStay: null,
  suctionDifficulty: null,
  plagiocephalyNoted: null,
  torticollisNoted: null,
  colic: null,
  reflux: null,
  feeding: null,
  preferredHeadSide: null,
  notes: null,
};

type NumberKey = "gestationalAgeWeeks" | "birthWeightG" | "labourHours" | "apgar1" | "apgar5";
const NUMBER_FIELDS: readonly { key: NumberKey; label: string; min: number; max: number; step?: number }[] = [
  { key: "gestationalAgeWeeks", label: "Età gestazionale (settimane)", min: 22, max: 44 },
  { key: "birthWeightG", label: "Peso alla nascita (g)", min: 300, max: 6500 },
  { key: "labourHours", label: "Ore di travaglio", min: 0, max: 72, step: 0.1 },
  { key: "apgar1", label: "Apgar a 1 minuto", min: 0, max: 10 },
  { key: "apgar5", label: "Apgar a 5 minuti", min: 0, max: 10 },
];

type TriKey = "nicuStay" | "suctionDifficulty" | "plagiocephalyNoted" | "torticollisNoted" | "colic" | "reflux";
const TRI_FIELDS: readonly { key: TriKey; label: string }[] = [
  { key: "nicuStay", label: "Ricovero in neonatologia (TIN)" },
  { key: "suctionDifficulty", label: "Difficoltà di suzione" },
  { key: "plagiocephalyNoted", label: "Plagiocefalia notata" },
  { key: "torticollisNoted", label: "Torcicollo notato" },
  { key: "colic", label: "Coliche" },
  { key: "reflux", label: "Reflusso" },
];

const DELIVERY_MODES = [
  { value: "spontaneo", label: "Spontaneo" },
  { value: "operativo_ventosa", label: "Operativo con ventosa" },
  { value: "operativo_forcipe", label: "Operativo con forcipe" },
  { value: "cesareo_programmato", label: "Cesareo programmato" },
  { value: "cesareo_urgente", label: "Cesareo d'urgenza" },
] as const;
const PRESENTATIONS = [
  { value: "cefalica", label: "Cefalica" },
  { value: "podalica", label: "Podalica" },
  { value: "trasversa", label: "Trasversa" },
  { value: "altro", label: "Altra" },
] as const;
const FEEDING = [
  { value: "seno", label: "Seno" },
  { value: "artificiale", label: "Artificiale" },
  { value: "misto", label: "Misto" },
] as const;
const HEAD_SIDES = [
  { value: "dx", label: "Destro" },
  { value: "sx", label: "Sinistro" },
  { value: "nessuna", label: "Nessuno" },
] as const;

function PerinatalForm({ perinatal, disabled, save }: { perinatal: PerinatalRow | null; disabled: boolean; save: HistorySave }) {
  const { value, update } = useGroup(perinatal ?? EMPTY_PERINATAL, save, (current) => ({ kind: "perinatale", ...current }));
  const change = (patch: Partial<PerinatalRow>, options: RunOptions) => update((current) => ({ ...current, ...patch }), options);

  return (
    <Block title="Anamnesi perinatale">
      <div className="grid gap-3 sm:grid-cols-2">
        {NUMBER_FIELDS.map((field) => (
          <VisitTextField
            key={field.key}
            id={`perinatale-${field.key}`}
            label={field.label}
            type="number"
            min={field.min}
            max={field.max}
            step={field.step}
            value={value[field.key] === null ? null : String(value[field.key])}
            disabled={disabled}
            onSave={(text, options) => change({ [field.key]: text === null ? null : Number(text) }, options)}
          />
        ))}
        <SelectField<NonNullable<PerinatalRow["deliveryMode"]>>
          id="perinatale-deliveryMode"
          label="Tipo di parto"
          items={DELIVERY_MODES}
          value={value.deliveryMode}
          placeholder="Scegli il tipo di parto"
          disabled={disabled}
          onSave={(mode, options) => change({ deliveryMode: mode }, options)}
        />
      </div>
      <ChoiceField
        id="perinatale-presentation"
        label="Presentazione"
        items={PRESENTATIONS}
        value={value.presentation}
        clearable
        disabled={disabled}
        onSave={(presentation, options) => change({ presentation }, options)}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {TRI_FIELDS.map((field) => (
          <ChoiceField
            key={field.key}
            id={`perinatale-${field.key}`}
            label={field.label}
            items={YES_NO}
            value={value[field.key] === null ? null : value[field.key] ? "si" : "no"}
            clearable
            disabled={disabled}
            onSave={(answer, options) => change({ [field.key]: answer === null ? null : answer === "si" }, options)}
          />
        ))}
      </div>
      <ChoiceField
        id="perinatale-feeding"
        label="Alimentazione"
        items={FEEDING}
        value={value.feeding}
        clearable
        disabled={disabled}
        onSave={(feeding, options) => change({ feeding }, options)}
      />
      <ChoiceField
        id="perinatale-preferredHeadSide"
        label="Lato preferito della testa"
        items={HEAD_SIDES}
        value={value.preferredHeadSide}
        clearable
        disabled={disabled}
        onSave={(preferredHeadSide, options) => change({ preferredHeadSide }, options)}
      />
      <VisitTextField
        id="perinatale-notes"
        label="Note sull'anamnesi perinatale"
        value={value.notes}
        multiline
        maxLength={1000}
        disabled={disabled}
        onSave={(notes, options) => change({ notes }, options)}
      />
    </Block>
  );
}

/** Sotto i 24 mesi la perinatale è aperta da sola; sopra, resta chiusa dietro «Apri l'anamnesi perinatale». */
export function PerinatalFields({ editor, disabled, save }: { editor: VisitEditor; disabled: boolean; save: HistorySave }) {
  const { perinatal } = editor.history;
  const [opened, setOpened] = useState(false);
  if (editor.patient.ageMonths < 24 || perinatal !== null || opened) {
    return <PerinatalForm perinatal={perinatal} disabled={disabled} save={save} />;
  }
  if (disabled) return null;
  return (
    <div>
      <Button type="button" variant="outline" onClick={() => setOpened(true)}>
        Apri l&apos;anamnesi perinatale
      </Button>
    </div>
  );
}
