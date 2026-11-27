"use client";

import type { RunOptions } from "@/lib/visits/save-queue";
import type { HistoryView } from "@/server/domain/history/queries";
import type { VisitEditor } from "@/server/domain/visits/editor";

import { ChoiceField } from "./choice-group";
import { Block, type HistorySave, useGroup } from "./history-parts";
import { PerinatalFields } from "./perinatal-fields";
import { RemoteHistory } from "./remote-history";
import { VisitTextField } from "./visit-text-field";

// L'anamnesi della prima visita: l'anamnesi remota come elenchi
// (`remote-history.tsx`), gli 8 apparati con «Niente da segnalare» già scelto, lo stile di vita e, sotto i 24 mesi,
// l'anamnesi perinatale (`perinatal-fields.tsx`). L'anamnesi è del paziente, non della visita: salva sempre subito con
// `historyAction`, anche in rettifica. Apparati e stile di vita sono gruppi che il comando riscrive interi: ognuno
// tiene la sua copia locale (`useGroup`), così due modifiche ravvicinate non si sovrascrivono.

export type { HistorySave } from "./history-parts";

// Apparati --------------------------------------------------------------------------------------------

const SYSTEM_STATUS = [
  { value: "nulla", label: "Niente da segnalare" },
  { value: "da_segnalare", label: "Da segnalare" },
] as const;

function SystemsReview({ systems, disabled, save }: { systems: HistoryView["systems"]; disabled: boolean; save: HistorySave }) {
  const { value: rows, update } = useGroup(systems, save, (current) => ({
    kind: "apparati",
    rows: current.map(({ system, status, note }) => ({ system, status, note })),
  }));
  const change = (system: string, patch: Partial<HistoryView["systems"][number]>, options: RunOptions) =>
    update((current) => current.map((row) => (row.system === system ? { ...row, ...patch } : row)), options);

  return (
    <Block title="Anamnesi per apparati">
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.system} className="flex flex-col gap-2">
            <ChoiceField
              id={`apparato-${row.system}`}
              label={row.label}
              items={SYSTEM_STATUS}
              value={row.status}
              disabled={disabled}
              onSave={(status, options) => change(row.system, { status }, options)}
            />
            {row.status === "da_segnalare" ? (
              <VisitTextField
                id={`apparato-${row.system}-nota`}
                label={`Nota: ${row.label}`}
                value={row.note}
                maxLength={300}
                disabled={disabled}
                onSave={(value, options) => change(row.system, { note: value }, options)}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </Block>
  );
}

// Stile di vita ---------------------------------------------------------------------------------------

type Lifestyle = NonNullable<HistoryView["lifestyle"]>;

const EMPTY_LIFESTYLE: Lifestyle = {
  occupation: null,
  sport: null,
  familyHistory: null,
  pregnancyStatus: null,
  pregnancyWeeks: null,
  lastReviewedOn: null,
};

const PREGNANCY = [
  { value: "no", label: "No" },
  { value: "in_corso", label: "In corso" },
  { value: "post_partum", label: "Dopo il parto" },
] as const;

function LifestyleFields({ lifestyle, disabled, save }: { lifestyle: HistoryView["lifestyle"]; disabled: boolean; save: HistorySave }) {
  const { value, update } = useGroup(lifestyle ?? EMPTY_LIFESTYLE, save, (current) => ({
    kind: "stile",
    occupation: current.occupation,
    sport: current.sport,
    familyHistory: current.familyHistory,
    pregnancyStatus: current.pregnancyStatus,
    pregnancyWeeks: current.pregnancyWeeks,
  }));
  const change = (patch: Partial<Lifestyle>, options: RunOptions) => update((current) => ({ ...current, ...patch }), options);

  return (
    <Block title="Stile di vita">
      <div className="grid gap-3 sm:grid-cols-2">
        <VisitTextField
          id="stile-occupazione"
          label="Occupazione"
          value={value.occupation}
          maxLength={500}
          disabled={disabled}
          onSave={(text, options) => change({ occupation: text }, options)}
        />
        <VisitTextField
          id="stile-sport"
          label="Sport"
          value={value.sport}
          maxLength={500}
          disabled={disabled}
          onSave={(text, options) => change({ sport: text }, options)}
        />
      </div>
      <VisitTextField
        id="stile-familiarita"
        label="Familiarità"
        value={value.familyHistory}
        maxLength={500}
        disabled={disabled}
        onSave={(text, options) => change({ familyHistory: text }, options)}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <ChoiceField
          id="stile-gravidanza"
          label="Gravidanza"
          items={PREGNANCY}
          value={value.pregnancyStatus}
          clearable
          disabled={disabled}
          // Le settimane ci sono solo con «In corso».
          onSave={(status, options) =>
            change({ pregnancyStatus: status, ...(status === "in_corso" ? {} : { pregnancyWeeks: null }) }, options)
          }
        />
        {value.pregnancyStatus === "in_corso" ? (
          <VisitTextField
            id="stile-settimane"
            label="Settimane di gravidanza"
            type="number"
            min={1}
            max={42}
            value={value.pregnancyWeeks === null ? null : String(value.pregnancyWeeks)}
            disabled={disabled}
            onSave={(text, options) => change({ pregnancyWeeks: text === null ? null : Number(text) }, options)}
          />
        ) : null}
      </div>
    </Block>
  );
}

export function HistoryFields({ editor, disabled, save }: { editor: VisitEditor; disabled: boolean; save: HistorySave }) {
  return (
    <div className="flex flex-col gap-6">
      <RemoteHistory history={editor.history} disabled={disabled} save={save} />
      <SystemsReview systems={editor.history.systems} disabled={disabled} save={save} />
      <LifestyleFields lifestyle={editor.history.lifestyle} disabled={disabled} save={save} />
      <PerinatalFields editor={editor} disabled={disabled} save={save} />
    </div>
  );
}
