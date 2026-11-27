"use client";

import { X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type Approach, technique } from "@/lib/clinical/catalog";
import { SCREENING_FIRST, type TreatmentCheck } from "@/lib/clinical/rules";
import {
  approachItems,
  blockedHint,
  fieldsOf,
  RESPONSE_ITEMS,
  sameFields,
  techniqueOp,
  techniqueSwitchName,
  TOLERANCE_ITEMS,
  type TreatmentFields,
} from "@/lib/visits/treatment-row";
import { refusalText } from "@/lib/visits/text-autosave";
import type { ActionFailure } from "@/server/actions/result";
import type { EditorTreatment } from "@/server/domain/visits/editor";

import { ChoiceGroup, useRowDraft } from "./choice-group";
import { refocusIfIdle } from "./refocus";
import type { VisitSectionProps } from "./visit-editor";
import { VisitTextField } from "./visit-text-field";

// Il pannello di una tecnica: l'approccio dove serve (fasciale, craniale,
// viscerale, Still, altra), la tolleranza («Buona» già scelta alla nascita della riga), la risposta facoltativa e la
// nota. Ogni modifica manda la riga intera (`tecnica`), costruita dalla riga mostrata (`useRowDraft`), così due
// modifiche di fila non si cancellano mentre la prima è in coda; un rifiuto (per esempio il cambio d'approccio verso una
// famiglia controindicata) mette la frase sotto il campo e riporta la riga della vista. Una tecnica in contrasto con lo
// screening (eseguita prima di un red flag) porta la nota che serve alla chiusura. Esc chiude e il pannello che lo
// apre riporta il focus sul suo pulsante.

const NOTE_MAX = 300;
const CONFLICT_NOTE_HINT = "Se l'hai eseguita prima che comparisse il sintomo segnalato nello screening, scrivilo qui.";
const RADIO_TAB_STOP = '[role="radio"][tabindex="0"]';

type Field = "approach" | "tolerance" | "response";

export interface TechniquePanelProps {
  treatment: EditorTreatment;
  op: VisitSectionProps["op"];
  readOnly: boolean;
  /** La nota resta libera anche con `readOnly` (consenso revocato: si annota soltanto). */
  noteReadOnly?: boolean;
  /** Il blocco di ogni approccio per questa tecnica in questa regione: un approccio bloccato non si sceglie. */
  approachChecks?: Partial<Record<Approach, TreatmentCheck>>;
  onClose: () => void;
  /** Aperto da un gesto sul pulsante dei dettagli: scorre nella vista e il focus va dentro. Aperto dall'interruttore, no. */
  autoFocus?: boolean;
}

export function TechniquePanel({
  treatment,
  op,
  readOnly,
  noteReadOnly = readOnly,
  approachChecks,
  onClose,
  autoFocus = true,
}: TechniquePanelProps) {
  const { row, send, reset } = useRowDraft(treatment, fieldsOf, sameFields);
  const [error, setError] = useState<{ field: Field; message: string } | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const baseId = useId();
  const ids = {
    heading: `${baseId}-titolo`,
    approach: `${baseId}-approccio`,
    tolerance: `${baseId}-tolleranza`,
    response: `${baseId}-risposta`,
    note: `${baseId}-nota-tecnica`,
  };
  // Il blocco dello screening, non la sola conferma che manca: allora la frase sta già in cima alla sezione.
  const conflict = treatment.check.kind === "blocked" && treatment.check.text !== SCREENING_FIRST;
  const definition = technique(treatment.techniqueCode);
  const variableApproach = definition?.variableApproach === true;
  const name = treatment.customTechnique ?? (definition === undefined ? treatment.techniqueCode : techniqueSwitchName(definition.label));

  useEffect(() => {
    if (!autoFocus) return;
    const panel = panelRef.current;
    panel?.scrollIntoView({ block: "nearest" });
    panel?.querySelector<HTMLElement>(RADIO_TAB_STOP)?.focus({ preventScroll: true });
  }, [autoFocus]);

  const commit = (next: TreatmentFields, onRefused: (failure: ActionFailure) => void) => {
    setError(null);
    send(next);
    op(techniqueOp(treatment, next), { onRefused });
  };

  const refused = (field: Field) => (failure: ActionFailure) => {
    reset();
    setError({ field, message: refusalText(failure) });
    const group = document.getElementById(ids[field]);
    refocusIfIdle(panelRef.current, group?.querySelector<HTMLElement>(RADIO_TAB_STOP) ?? null);
  };

  const errorFor = (field: Field) => (error?.field === field ? error.message : undefined);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };

  return (
    <section
      ref={panelRef}
      aria-labelledby={ids.heading}
      onKeyDown={onKeyDown}
      className="@container flex flex-col gap-4 rounded-xl border bg-background p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 id={ids.heading} className="text-base font-medium">
            {name}
          </h4>
          {treatment.copied ? <Badge variant="outline">Da confermare</Badge> : null}
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label="Chiudi il pannello della tecnica" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="grid gap-4 @lg:grid-cols-2">
        {variableApproach ? (
          <ChoiceGroup
            id={ids.approach}
            label="Approccio"
            items={approachItems(approachChecks, row.approach)}
            value={row.approach}
            disabled={readOnly}
            error={errorFor("approach")}
            hint={blockedHint(approachChecks, row.approach)}
            onChange={(approach) => commit({ ...row, approach }, refused("approach"))}
          />
        ) : null}
        <ChoiceGroup
          id={ids.tolerance}
          label="Tolleranza"
          items={TOLERANCE_ITEMS}
          value={row.tolerance}
          disabled={readOnly}
          error={errorFor("tolerance")}
          onChange={(tolerance) => commit({ ...row, tolerance }, refused("tolerance"))}
        />
        <ChoiceGroup
          id={ids.response}
          label="Risposta"
          items={RESPONSE_ITEMS}
          value={row.response}
          disabled={readOnly}
          error={errorFor("response")}
          onChange={(response) => commit({ ...row, response }, refused("response"))}
          onClear={() => commit({ ...row, response: null }, refused("response"))}
        />
        <VisitTextField
          id={ids.note}
          label="Nota"
          optional
          multiline
          value={row.note}
          maxLength={NOTE_MAX}
          disabled={noteReadOnly}
          hint={conflict ? CONFLICT_NOTE_HINT : undefined}
          onSave={(note, options) =>
            commit({ ...row, note }, (failure) => {
              reset();
              options.onRefused?.(failure);
            })
          }
        />
      </div>
    </section>
  );
}
