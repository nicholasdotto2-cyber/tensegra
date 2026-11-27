"use client";

import { useId } from "react";

import { NEURO_TESTS, REGION_LABEL } from "@/lib/clinical/catalog";
import { neuroLimbs } from "@/lib/visits/neuro-limbs";
import { testLabel } from "@/lib/visits/test-row";

import { TestResultRow } from "./test-result-row";
import type { VisitSectionProps } from "./visit-editor";

// L'esame neurologico compatto della sezione C: compare quando c'è un'irradiazione o il gruppo dei
// red flag cervicali è aperto, e quando la visita ha già un suo risultato. Quali arti e quali test lo decide
// `neuroLimbs` (src/lib/visits/neuro-limbs.ts). Riflessi, forza, sensibilità e i segni di Babinski e Hoffmann: una riga
// per test con i due lati accanto. I codici dell'esame non compaiono fra i test attivi né in "Test nel tempo".

const CERVICAL_GROUP = "rf_cervicale_vascolare";

export function NeuroExam({ editor, mode, op }: VisitSectionProps) {
  const headingId = useId();
  const limbs = neuroLimbs({
    radiationSites: editor.visit.fields.radiationSites,
    cervicalGroup: editor.screening.groups.some((g) => g.code === CERVICAL_GROUP),
    savedCodes: editor.tests.filter((t) => NEURO_TESTS.some((n) => n.code === t.testCode)).map((t) => t.testCode),
  });
  if (limbs.length === 0) return null;
  const disabled = mode === "lettura";

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-medium">
        Esame neurologico
      </h3>
      {limbs.map(({ limb, codes }) => (
        <fieldset key={limb} className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{REGION_LABEL[limb]}</legend>
          <ul className="flex flex-col divide-y rounded-lg border">
            {NEURO_TESTS.filter((def) => codes.includes(def.code)).map((def) => (
              <li key={def.code} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
                <span className="w-44 shrink-0 text-sm">{def.name}</span>
                {(["dx", "sx"] as const).map((side) => (
                  <div key={side} className="flex items-center gap-2">
                    <span aria-hidden="true" className="w-5 text-sm text-muted-foreground">
                      {side}
                    </span>
                    <TestResultRow
                      id={`neuro-${def.code}-${side}`}
                      label={testLabel(def.name, side)}
                      shape={def}
                      target={{ testCode: def.code, side, customLabel: null, customUnit: null }}
                      saved={editor.tests.find((t) => t.testCode === def.code && t.side === side)}
                      op={op}
                      disabled={disabled}
                      compact
                    />
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </fieldset>
      ))}
    </section>
  );
}
