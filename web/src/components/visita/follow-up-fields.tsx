"use client";

import { useId, useState } from "react";

import { ADVERSE_LABEL, RADIATION_LABEL } from "@/lib/clinical/labels";
import { cn } from "@/lib/utils";
import type { RunOptions } from "@/lib/visits/save-queue";
import { refusalText } from "@/lib/visits/text-autosave";
import type { VisitEditor } from "@/server/domain/visits/editor";

import { ChoiceField, useChosen } from "./choice-group";
import { VisitTextField } from "./visit-text-field";

// Le visite dopo la prima: al posto dei campi d'apertura, come sta il paziente
// dall'ultima seduta: le novità in una riga, le reazioni con quattro pulsanti e una nota, e l'irradiazione con i siti
// e il lato. Tutto passa dall'operazione `campi` (`saveFields`).

export type FieldsSave = (values: Record<string, unknown>, options: RunOptions) => void;

const ADVERSE = (Object.keys(ADVERSE_LABEL) as (keyof typeof ADVERSE_LABEL)[]).map((value) => ({
  value,
  label: ADVERSE_LABEL[value],
}));
const SIDES = [
  { value: "dx", label: "Destro" },
  { value: "sx", label: "Sinistro" },
  { value: "bilaterale", label: "Bilaterale" },
] as const;

type Site = keyof typeof RADIATION_LABEL;
const RADIATION_SITES = Object.keys(RADIATION_LABEL) as Site[];

/** «Irradiazione»: «No» oppure uno o più siti, con il lato. I siti sono interruttori, il lato una scelta. */
function Radiation({ editor, disabled, saveFields }: { editor: VisitEditor; disabled: boolean; saveFields: FieldsSave }) {
  const { fields } = editor.visit;
  const legendId = useId();
  const [error, setError] = useState<string | undefined>(undefined);
  const { shown, choose, reset } = useChosen<string>(fields.radiationSites.join(","));
  const sites = shown === "" ? [] : (shown.split(",") as Site[]);

  const save = (next: Site[], values: Record<string, unknown>) => {
    setError(undefined);
    choose(next.join(","));
    saveFields(
      { radiationSites: next, ...values },
      {
        onRefused: (failure) => {
          reset();
          setError(refusalText(failure));
        },
      },
    );
  };
  const toggle = (site: Site) => {
    const next = sites.includes(site) ? sites.filter((s) => s !== site) : RADIATION_SITES.filter((s) => s === site || sites.includes(s));
    // Senza siti non c'è un lato.
    save(next, next.length === 0 ? { radiationSide: null } : {});
  };

  const button = (pressed: boolean, label: string, onClick: () => void, key: string) => (
    <button
      key={key}
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-8 items-center justify-center rounded-md border px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        pressed ? "border-primary bg-primary font-semibold text-primary-foreground" : "border-border bg-background hover:bg-muted",
      )}
    >
      {label}
    </button>
  );

  return (
    <fieldset id="campo-irradiazione" aria-describedby={error === undefined ? undefined : `${legendId}-errore`} className="flex flex-col gap-2">
      <legend id={legendId} className="mb-1.5 text-sm font-medium">
        Irradiazione
      </legend>
      <div className="flex flex-wrap gap-1">
        {button(sites.length === 0, "No", () => save([], { radiationSide: null }), "no")}
        {RADIATION_SITES.map((site) => button(sites.includes(site), RADIATION_LABEL[site], () => toggle(site), site))}
      </div>
      {sites.length === 0 ? null : (
        <ChoiceField
          id="campo-irradiazione-lato"
          label="Lato dell'irradiazione"
          items={SIDES}
          value={fields.radiationSide}
          disabled={disabled}
          onSave={(side, options) => saveFields({ radiationSide: side }, options)}
        />
      )}
      {error === undefined ? null : (
        <p id={`${legendId}-errore`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function FollowUpFields({ editor, disabled, saveFields }: { editor: VisitEditor; disabled: boolean; saveFields: FieldsSave }) {
  const { fields } = editor.visit;
  const reactionNeedsNote = fields.adverseReaction !== null && fields.adverseReaction !== "nessuna";
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-base font-medium">Come sta dall&apos;ultima seduta</h3>
      <VisitTextField
        id="campo-novita"
        label="Novità dall'ultima seduta"
        value={fields.subjectiveUpdate}
        maxLength={1000}
        disabled={disabled}
        onSave={(value, options) => saveFields({ subjectiveUpdate: value }, options)}
      />
      <ChoiceField
        id="campo-reazioni"
        label="Reazioni dopo l'ultima seduta"
        items={ADVERSE}
        value={fields.adverseReaction}
        clearable
        disabled={disabled}
        onSave={(value, options) => saveFields({ adverseReaction: value }, options)}
      />
      {reactionNeedsNote ? (
        <VisitTextField
          id="campo-reazione"
          label="Nota sulla reazione"
          value={fields.adverseReactionNote}
          maxLength={500}
          disabled={disabled}
          onSave={(value, options) => saveFields({ adverseReactionNote: value }, options)}
        />
      ) : null}
      <Radiation editor={editor} disabled={disabled} saveFields={saveFields} />
    </div>
  );
}
