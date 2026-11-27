"use client";

import { useId } from "react";

import {
  cycleOpeningAction,
  historyAction,
  psfsItemAction,
  relapseAction,
} from "@/app/(app)/pazienti/[id]/visite/[visitId]/actions";
import type { RunOptions } from "@/lib/visits/save-queue";

import { ChoiceField, YES_NO } from "./choice-group";
import { FirstVisitFields } from "./first-visit-fields";
import { FollowUpFields } from "./follow-up-fields";
import { type HistorySave, HistoryFields } from "./history-fields";
import { PsfsFields } from "./psfs-fields";
import type { VisitSectionProps } from "./visit-editor";
import { VisitTextField } from "./visit-text-field";

// La sezione A dell'editor della visita, «Come sta». Alla
// prima visita del ciclo i campi d'apertura, le attività PSFS con il punteggio iniziale e l'anamnesi; nelle visite
// dopo, le novità, le reazioni e l'irradiazione; in fondo, per tutte, «Altri dati» (luogo e presenti). Qui si decide
// come salvare ciascuna parte:
// - bozza: i campi d'apertura con `cycleOpeningAction`, le attività con `psfsItemAction`, la ricaduta con
//   `relapseAction`; il punteggio PSFS e i campi della visita sono operazioni (`op`);
// - rettifica: i campi d'apertura passano da `op` come operazione `apertura` e i punteggi come `psfs`; l'elenco delle
//   attività non cambia; l'anamnesi continua a salvare subito con `historyAction`, perché è del paziente e non
//   della visita chiusa;
// - lettura: tutto è disattivato.
// La prima visita del ciclo che non tiene l'apertura (la tiene una visita chiusa prima di lei) mostra l'apertura e le
// attività in sola lettura, in bozza come in rettifica, con la frase della visita da rettificare (`openingLock`);
// l'anamnesi resta del paziente.
// La visita chiusa che tiene l'apertura senza essere la prima mostra l'apertura sopra le sue novità.

const HISTORY_NOW = "L'anamnesi si salva subito: non fa parte della rettifica.";

const LOCATIONS = [
  { value: "studio", label: "Studio" },
  { value: "domicilio", label: "Domicilio" },
  { value: "altro", label: "Altro" },
] as const;

/** «Altri dati»: il luogo della visita, chi è presente e se il paziente acconsente. */
function OtherData({
  fields,
  disabled,
  saveFields,
}: {
  fields: VisitSectionProps["editor"]["visit"]["fields"];
  disabled: boolean;
  saveFields: (values: Record<string, unknown>, options: RunOptions) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h3 id={headingId} className="text-base font-medium">
        Altri dati
      </h3>
      <ChoiceField
        id="campo-luogo"
        label="Luogo della visita"
        items={LOCATIONS}
        value={fields.location}
        disabled={disabled}
        onSave={(value, options) => saveFields({ location: value }, options)}
      />
      <VisitTextField
        id="campo-presenti"
        label="Presenti alla visita"
        value={fields.othersPresent}
        maxLength={200}
        disabled={disabled}
        onSave={(value, options) => saveFields({ othersPresent: value }, options)}
      />
      {fields.othersPresent === null ? null : (
        <ChoiceField
          id="campo-consenso-presenti"
          label="Il paziente acconsente alla presenza di altre persone"
          items={YES_NO}
          value={fields.othersPresentConsented === null ? null : fields.othersPresentConsented ? "si" : "no"}
          clearable
          disabled={disabled}
          onSave={(value, options) => saveFields({ othersPresentConsented: value === null ? null : value === "si" }, options)}
        />
      )}
    </section>
  );
}

export function SectionA({ editor, mode, op, run }: VisitSectionProps) {
  const visitId = editor.visit.id;
  const disabled = mode === "lettura";
  const { openingLock } = editor.cycle;
  // L'apertura in sola lettura: nessuna scrittura parte dai suoi campi né dalle attività.
  const openingMode = openingLock === null ? mode : "lettura";

  const saveFields = (values: Record<string, unknown>, options: RunOptions) => op({ op: "campi", values }, options);

  const saveOpening = (values: Record<string, unknown>, options: RunOptions) => {
    if (mode === "rettifica") op({ op: "apertura", ...values }, options);
    else if (mode === "bozza") run(() => cycleOpeningAction(visitId, values), options);
  };
  const saveRelapse = (previousCycleId: string, options: RunOptions) => {
    if (mode === "bozza") run(() => relapseAction(visitId, { previousCycleId }), options);
  };
  const savePsfsItem = (input: Record<string, unknown>, options: RunOptions) => {
    if (mode === "bozza") run((id) => psfsItemAction(visitId, input.kind === "aggiungi" ? { ...input, id } : input), options);
  };
  const savePsfsScore = (itemId: string, score: number | null, options: RunOptions) =>
    op({ op: "psfs", itemId, score }, options);
  // Una chiamata dell'anamnesi dice quando è finita: i gruppi salvati interi seguono il server solo a coda vuota. Finita
  // vuol dire una risposta (buona o rifiutata): un guasto di rete ferma la coda e la chiamata resta in testa, per «Riprova».
  const saveHistory: HistorySave = (input, options, settled) => {
    if (mode === "lettura") return;
    run(async () => {
      const result = await historyAction(visitId, input);
      if (result.ok || result.refused) settled?.();
      return result;
    }, options);
  };

  return (
    <div className="flex flex-col gap-6">
      {editor.cycle.showsOpening ? (
        <>
          {openingLock === null ? null : (
            <p role="note" className="rounded-lg bg-muted px-2.5 py-2 text-sm">
              {openingLock}
            </p>
          )}
          <FirstVisitFields
            editor={editor}
            disabled={openingMode === "lettura"}
            saveOpening={saveOpening}
            saveRelapse={saveRelapse}
          />
          <PsfsFields editor={editor} mode={openingMode} saveItem={savePsfsItem} saveScore={savePsfsScore} />
          {mode === "rettifica" ? (
            // L'anamnesi è del paziente, non della visita chiusa: salva subito e «Annulla la rettifica» non la tocca.
            <p role="note" className="rounded-lg bg-muted px-2.5 py-2 text-sm">
              {HISTORY_NOW}
            </p>
          ) : null}
          <HistoryFields editor={editor} disabled={disabled} save={saveHistory} />
        </>
      ) : null}
      {editor.cycle.isFirstVisit ? null : <FollowUpFields editor={editor} disabled={disabled} saveFields={saveFields} />}
      <OtherData fields={editor.visit.fields} disabled={disabled} saveFields={saveFields} />
    </div>
  );
}
