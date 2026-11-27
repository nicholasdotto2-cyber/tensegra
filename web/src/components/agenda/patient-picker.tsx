"use client";

import { type Ref, useEffect, useState } from "react";

import { searchPatientsAction } from "@/app/(app)/agenda/actions";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox";
import { dayField, lastFirst } from "@/lib/format";
import { phoneDisplay } from "@/lib/phone";
import { cn } from "@/lib/utils";
import type { PatientHit } from "@/server/domain/patients/queries";

// Il campo "Paziente" del dialogo "Nuovo appuntamento": cerca da 3
// caratteri, 250 ms dopo l'ultimo tasto, per nome, cognome o telefono. Gli archiviati compaiono dopo
// gli attivi, non selezionabili, col loro testo; l'ultima voce è "Nuovo paziente: {testo cercato}".

/** Il paziente scelto: uno esistente, o il testo da cui nasce il mini modulo "Nuovo paziente". */
export type PatientChoice = { kind: "existing"; hit: PatientHit } | { kind: "new"; text: string };

const SEARCH_MIN_CHARS = 3;
const SEARCH_DEBOUNCE_MS = 250;
const ARCHIVED = "Paziente archiviato: ripristinalo dalla sua scheda.";
const LOAD_FAILED = "Non riesco a caricare questo elenco.";

/** Il testo del campo per una scelta: "Cognome Nome" come nella lista, o la voce del paziente nuovo. */
export function choiceLabel(choice: PatientChoice): string {
  return choice.kind === "existing" ? lastFirst(choice.hit) : `Nuovo paziente: ${choice.text}`;
}

const choiceKey = (choice: PatientChoice): string => (choice.kind === "existing" ? choice.hit.id : `new:${choice.text}`);

function HitText({ hit }: { hit: PatientHit }) {
  // La data di nascita e il telefono distinguono due omonimi.
  const details = [dayField(hit.birthDate), hit.phone === null ? null : phoneDisplay(hit.phone)].filter(Boolean).join(", ");
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">{lastFirst(hit)}</span>
      <span className="text-xs text-muted-foreground">{hit.archived ? ARCHIVED : details}</span>
    </span>
  );
}

export function PatientPicker({
  id,
  value,
  onChange,
  inputRef,
  invalid,
  describedBy,
}: {
  id: string;
  value: PatientChoice | null;
  onChange: (choice: PatientChoice | null) => void;
  inputRef?: Ref<HTMLInputElement>;
  invalid: boolean;
  describedBy?: string;
}) {
  const [inputValue, setInputValue] = useState(value === null ? "" : choiceLabel(value));
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<PatientChoice[]>([]);
  const [failed, setFailed] = useState(false);

  // Un paziente scelto da fuori (i default di "Fissa appuntamento") riempie il campo col suo nome.
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    if (value !== null) setInputValue(choiceLabel(value));
  }

  useEffect(() => {
    const text = search.trim();
    if (text.length < SEARCH_MIN_CHARS) return;
    let current = true;
    const timer = setTimeout(() => {
      void searchPatientsAction(text).then((result) => {
        if (!current) return;
        setFailed(!result.ok);
        // Le voci cambiano tutte insieme, a risposta arrivata: Freccia giù non prende una lista vecchia.
        setOptions(result.ok ? [...result.data.map((hit) => ({ kind: "existing" as const, hit })), { kind: "new", text }] : []);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [search]);

  return (
    <Combobox<PatientChoice>
      items={options}
      // Filtra il server: le voci arrivano già scelte.
      filter={null}
      value={value}
      onValueChange={(next, details) => {
        // Esc con un paziente scelto non lo toglie: chiude il dialogo, come in ogni altro campo.
        if (details.reason === "escape-key") {
          details.allowPropagation();
          return;
        }
        onChange(next);
      }}
      inputValue={inputValue}
      onInputValueChange={(text, details) => {
        if (details.reason === "escape-key") {
          details.allowPropagation();
          return;
        }
        setInputValue(text);
        if (details.reason !== "input-change") return;
        setSearch(text);
        if (text.trim().length < SEARCH_MIN_CHARS) {
          setOptions([]);
          setFailed(false);
        }
        // Chi riscrive il nome sta cercando un altro paziente.
        if (value !== null) onChange(null);
      }}
      itemToStringLabel={choiceLabel}
      isItemEqualToValue={(a, b) => choiceKey(a) === choiceKey(b)}
    >
      <ComboboxInput
        id={id}
        ref={inputRef}
        className="w-full"
        showTrigger={false}
        autoComplete="off"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
      {/* Sotto i 3 caratteri non c'è niente da mostrare: l'elenco vuoto non si vede. */}
      <ComboboxContent className={cn(!failed && "data-empty:hidden")}>
        <ComboboxEmpty>{failed ? LOAD_FAILED : null}</ComboboxEmpty>
        <ComboboxList>
          {(option: PatientChoice) => (
            <ComboboxItem
              key={choiceKey(option)}
              value={option}
              disabled={option.kind === "existing" && option.hit.archived}
              className="py-1.5"
            >
              {option.kind === "existing" ? <HitText hit={option.hit} /> : choiceLabel(option)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
