"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { REGION_LABEL, TESTS, type TestDefinition } from "@/lib/clinical/catalog";
import { matchesSearch, previousFor, testLabel } from "@/lib/visits/test-row";

import { FreeTests } from "./free-test-form";
import { TestResultRow, testRowId } from "./test-result-row";
import type { VisitSectionProps } from "./visit-editor";

// I test della sezione C, «Valutazione»: sotto il body chart i
// test attivi della regione principale sono già aperti, gli altri stanno in un elenco con ricerca e si aprono con un
// tocco (un test aperto e senza risultato si richiude). Ogni test ha una riga per lato, con il valore nel campo del suo
// tipo (`TestResultRow`): in grigio il valore precedente (anche prima della prima misura di oggi) e sulla riga la
// variazione dalla prima misura del ciclo. Ogni scelta salva subito la riga intera (`test`). In una visita chiusa si
// leggono soltanto i risultati: niente ricerca, elenco né modulo del test libero.

export function TestsBlock({ editor, mode, op }: VisitSectionProps) {
  const disabled = mode === "lettura";
  const headingId = useId();
  const searchId = useId();
  const othersId = useId();
  const [opened, setOpened] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  // Il test appena aperto dall'elenco prende il focus dopo il disegno, perché prima il suo controllo non c'è.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const code = pendingFocus.current;
    if (code === null) return;
    pendingFocus.current = null;
    const first = document.getElementById(testRowId(code, TESTS.find((t) => t.code === code)?.perSide ? "dx" : null));
    (first?.matches("input") ? first : first?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]'))?.focus();
  });

  const main = editor.cycle.opening.mainRegion;
  const active = new Set(editor.activeTestCodes);
  const withResult = new Set(editor.tests.map((t) => t.testCode));
  // Aperti: i test attivi della regione principale, quelli aperti a mano e quelli che hanno già un risultato (anche se
  // poi spenti nelle impostazioni: la riga salvata si legge e si aggiorna ancora).
  const isOpen = (def: TestDefinition) =>
    withResult.has(def.code) || (!disabled && active.has(def.code) && (def.region === main || opened.includes(def.code)));
  const open = [...TESTS.filter((d) => isOpen(d) && d.region === main), ...TESTS.filter((d) => isOpen(d) && d.region !== main)];
  const rest = disabled ? [] : TESTS.filter((d) => active.has(d.code) && !isOpen(d));
  const found = rest.filter((d) => matchesSearch(query, d.name, REGION_LABEL[d.region]));

  const openFromList = (def: TestDefinition) => {
    pendingFocus.current = def.code;
    setOpened((current) => [...current, def.code]);
    setQuery("");
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h3 id={headingId} className="text-base font-medium">
        Test
      </h3>
      {open.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {disabled ? "Nessun test registrato." : "Nessun test aperto. Cerca un test nell'elenco."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {open.flatMap((def) => {
            const sides = def.perSide ? (["dx", "sx"] as const) : ([null] as const);
            const closable = !withResult.has(def.code) && def.region !== main;
            return sides.map((side, index) => {
              const target = { testCode: def.code, side, customLabel: null, customUnit: null };
              return (
                <li key={`${def.code}-${side ?? "x"}`} className="flex flex-wrap items-start gap-3 p-3">
                  <TestResultRow
                    id={testRowId(def.code, side)}
                    label={testLabel(def.name, side)}
                    shape={def}
                    target={target}
                    saved={editor.tests.find((t) => t.testCode === def.code && t.side === side)}
                    previous={previousFor(editor.previousByKey, target)}
                    op={op}
                    disabled={disabled}
                  />
                  {closable && index === sides.length - 1 ? (
                    <div className="pt-6">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Chiudi: ${def.name}`}
                        onClick={() => setOpened((current) => current.filter((code) => code !== def.code))}
                      >
                        <X aria-hidden="true" />
                        Chiudi
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            });
          })}
        </ul>
      )}

      {rest.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <Label htmlFor={searchId}>Cerca un test</Label>
          <Input
            id={searchId}
            value={query}
            autoComplete="off"
            className="max-w-72"
            onChange={(event) => setQuery(event.target.value)}
          />
          <p id={othersId} className="text-sm font-medium">
            Altri test
          </p>
          {found.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessun test trovato.</p>
          ) : (
            <ul aria-labelledby={othersId} className="flex max-h-60 flex-col gap-1 overflow-y-auto">
              {found.map((def) => (
                <li key={def.code}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-auto min-h-7 w-full justify-between gap-3 py-1 text-left whitespace-normal"
                    onClick={() => openFromList(def)}
                  >
                    <span>{def.name}</span>
                    <span className="shrink-0 font-normal text-muted-foreground">{REGION_LABEL[def.region]}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <FreeTests editor={editor} op={op} disabled={disabled} />
    </section>
  );
}
