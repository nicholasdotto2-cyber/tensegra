"use client";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { REGION_CODES, REGION_LABEL, type RegionCode } from "@/lib/clinical/catalog";
import type { RunOptions } from "@/lib/visits/save-queue";
import { refusalText } from "@/lib/visits/text-autosave";
import type { VisitEditor } from "@/server/domain/visits/editor";

import { ChoiceField, SelectField } from "./choice-group";
import { VisitTextField } from "./visit-text-field";

// I campi d'apertura del ciclo alla prima visita: motivo, regione
// principale (con «È una ricaduta di [titolo]?»), insorgenza, obiettivo, sedute previste, medico inviante e
// diagnosi medica di riferimento con la fonte. Ogni campo salva da solo: i testi alla perdita del focus e dopo 800 ms
// (`VisitTextField`), le scelte subito. Il salvataggio lo decide `SectionA`: `saveOpening` scrive i campi del ciclo
// con `cycleOpeningAction` in bozza e con l'operazione `apertura` in rettifica.

export type OpeningSave = (values: Record<string, unknown>, options: RunOptions) => void;

const ONSET_MODES = [
  { value: "acuto", label: "Acuto" },
  { value: "graduale", label: "Graduale" },
  { value: "post_traumatico", label: "Dopo un trauma" },
  { value: "ricorrente", label: "Ricorrente" },
] as const;

const DIAGNOSIS_SOURCES = [
  { value: "referto_allegato", label: "Referto allegato" },
  { value: "riferita_dal_paziente", label: "Riferita dal paziente" },
  { value: "assente", label: "Assente" },
] as const;

const REGION_ITEMS = REGION_CODES.map((code) => ({ value: code, label: REGION_LABEL[code] }));
const NO_PHYSICIAN = "nessuno";
const REGION_ID = "campo-regione-principale";
const RELAPSE_ID = "campo-ricaduta";

/** «È una ricaduta di [titolo]?»: «Sì, è una ricaduta» collega il ciclo chiuso, «No» chiude la domanda. */
function RelapseQuestion({
  title,
  onYes,
  onNo,
}: {
  title: string;
  onYes: (options: RunOptions) => void;
  onNo: () => void;
}) {
  const [error, setError] = useState<string | undefined>(undefined);
  const errorId = useId();
  // La domanda sparisce con «No» o dopo «Sì»: il pulsante col focus se ne va, e il focus passa alla regione.
  // Il controllo aspetta un giro: in sviluppo React smonta e rimonta, e allora la domanda c'è ancora.
  useEffect(
    () => () => {
      setTimeout(() => {
        if (document.activeElement === document.body && document.getElementById(RELAPSE_ID) === null) {
          document.getElementById(REGION_ID)?.focus();
        }
      }, 0);
    },
    [],
  );
  return (
    <div id={RELAPSE_ID} role="group" aria-label="Ricaduta" className="flex flex-col gap-2 rounded-lg border bg-muted/50 p-3 text-sm">
      <p className="font-medium">{`È una ricaduta di ${title}?`}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          aria-describedby={error === undefined ? undefined : errorId}
          onClick={() => {
            setError(undefined);
            onYes({ onRefused: (failure) => setError(refusalText(failure)) });
          }}
        >
          Sì, è una ricaduta
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onNo}>
          No
        </Button>
      </div>
      {error === undefined ? null : (
        <p id={errorId} className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function FirstVisitFields({
  editor,
  disabled,
  saveOpening,
  saveRelapse,
}: {
  editor: VisitEditor;
  disabled: boolean;
  saveOpening: OpeningSave;
  saveRelapse: (previousCycleId: string, options: RunOptions) => void;
}) {
  const { cycle, physicians } = editor;
  const { opening } = cycle;
  const [dismissedRelapse, setDismissedRelapse] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | undefined>(undefined);
  const proposalErrorId = useId();
  // Senza questi quattro la prima visita di un ciclo di trattamento non si chiude: lo dice l'etichetta.
  const required = cycle.kind === "trattamento";

  const physicianItems = [
    { value: NO_PHYSICIAN, label: "Nessuno" },
    ...physicians.map((physician) => ({ value: physician.id, label: physician.fullName })),
    // Un medico scelto che non è più in rubrica si vede com'è: non diventa «Nessuno».
    ...(opening.referringPhysicianId === null || physicians.some((p) => p.id === opening.referringPhysicianId)
      ? []
      : [{ value: opening.referringPhysicianId, label: "Medico non più in rubrica" }]),
  ];
  const proposed = physicians.find((physician) => physician.id === opening.proposedReferringPhysicianId) ?? null;
  const showProposal = opening.referringPhysicianId === null && proposed !== null && !disabled;
  const relapse = cycle.relapse !== null && cycle.relapse.id !== dismissedRelapse && !disabled ? cycle.relapse : null;

  return (
    <div id="apertura-ciclo" className="flex flex-col gap-4">
      <h3 className="text-base font-medium">Apertura del ciclo</h3>
      <VisitTextField
        id="campo-motivo"
        label="Motivo della visita, con le parole del paziente"
        value={opening.chiefComplaint}
        multiline
        maxLength={500}
        required={required}
        disabled={disabled}
        onSave={(value, options) => saveOpening({ chiefComplaint: value }, options)}
      />
      <SelectField<RegionCode>
        id={REGION_ID}
        label="Regione principale"
        items={REGION_ITEMS}
        value={opening.mainRegion}
        placeholder="Scegli la regione"
        required={required}
        disabled={disabled}
        onSave={(value, options) => saveOpening({ mainRegion: value }, options)}
      />
      {relapse === null ? null : (
        <RelapseQuestion
          title={relapse.title}
          onYes={(options) => saveRelapse(relapse.id, options)}
          onNo={() => setDismissedRelapse(relapse.id)}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <VisitTextField
          id="campo-da-quando"
          label="Da quando"
          type="date"
          value={opening.onsetOn}
          disabled={disabled}
          onSave={(value, options) => saveOpening({ onsetOn: value }, options)}
        />
        <ChoiceField
          id="campo-come-iniziato"
          label="Come è iniziato"
          items={ONSET_MODES}
          value={opening.onsetMode}
          clearable
          disabled={disabled}
          onSave={(value, options) => saveOpening({ onsetMode: value }, options)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <VisitTextField
          id="campo-obiettivo"
          label="Obiettivo"
          value={opening.goal}
          maxLength={300}
          required={required}
          disabled={disabled}
          onSave={(value, options) => saveOpening({ goal: value }, options)}
        />
        <VisitTextField
          id="campo-sedute-previste"
          label="Sedute previste"
          type="number"
          min={1}
          max={20}
          value={opening.expectedSessions === null ? null : String(opening.expectedSessions)}
          required={required}
          disabled={disabled}
          // Le sedute previste non si svuotano: un campo lasciato vuoto torna al valore salvato.
          onSave={(value, options) => {
            if (value === null) return false;
            saveOpening({ expectedSessions: Number(value) }, options);
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        <SelectField<string>
          id="campo-medico-inviante"
          label="Medico inviante"
          items={physicianItems}
          value={opening.referringPhysicianId ?? NO_PHYSICIAN}
          placeholder="Scegli il medico"
          disabled={disabled}
          // Senza inviante il paziente è venuto da solo (accesso diretto).
          onSave={(value, options) =>
            saveOpening(
              value === NO_PHYSICIAN
                ? { referringPhysicianId: null, selfReferred: true }
                : { referringPhysicianId: value, selfReferred: false },
              options,
            )
          }
        />
        {showProposal ? (
          <div className="flex flex-col gap-1">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span>{`Medico inviante abituale del paziente: ${proposed.fullName}.`}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-describedby={proposalError === undefined ? undefined : proposalErrorId}
                onClick={() => {
                  setProposalError(undefined);
                  saveOpening(
                    { referringPhysicianId: proposed.id, selfReferred: false },
                    { onRefused: (failure) => setProposalError(refusalText(failure)) },
                  );
                }}
              >
                {`Usa ${proposed.fullName}`}
              </Button>
            </p>
            {proposalError === undefined ? null : (
              <p id={proposalErrorId} className="text-sm text-destructive">
                {proposalError}
              </p>
            )}
          </div>
        ) : null}
      </div>
      <div className="grid gap-4">
        <VisitTextField
          id="campo-diagnosi-medica"
          label="Diagnosi medica di riferimento"
          value={opening.medicalDiagnosisText}
          maxLength={300}
          disabled={disabled}
          onSave={(value, options) => saveOpening({ medicalDiagnosisText: value }, options)}
        />
        <ChoiceField
          id="campo-fonte-diagnosi"
          label="Fonte della diagnosi medica"
          items={DIAGNOSIS_SOURCES}
          value={opening.medicalDiagnosisSource}
          disabled={disabled}
          onSave={(value, options) => saveOpening({ medicalDiagnosisSource: value }, options)}
        />
      </div>
    </div>
  );
}
