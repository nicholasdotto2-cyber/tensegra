"use client";

import { type FormEvent, useId, useState } from "react";

import { PainScale } from "@/components/cartella/pain-scale";
import { described, Field, REQUIRED } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PSFS_SCALE_HINT, PSFS_TITLE } from "@/lib/clinical/labels";
import type { RunOptions } from "@/lib/visits/save-queue";
import { refusalText } from "@/lib/visits/text-autosave";
import type { VisitEditor } from "@/server/domain/visits/editor";

import { useChosen } from "./choice-group";
import { VisitTextField } from "./visit-text-field";

// Le attività PSFS della prima visita: da 0 a 3 attività con il punteggio
// iniziale 0-10. Nome, aggiunta e «Togli» passano da `psfsItemAction` (`saveItem`); il punteggio è l'operazione
// `psfs` (`saveScore`), che vale anche in rettifica. In rettifica le attività non si cambiano: la rettifica scrive
// i punteggi, non l'elenco delle attività del ciclo.

const MAX_ITEMS = 3;

type Item = VisitEditor["cycle"]["psfs"][number];

export type PsfsItemSave = (input: Record<string, unknown>, options: RunOptions) => void;
export type PsfsScoreSave = (itemId: string, score: number | null, options: RunOptions) => void;

/** Un'attività: il nome (si rinomina), il punteggio iniziale e «Togli». */
function PsfsRow({
  item,
  position,
  readOnly,
  disabled,
  saveItem,
  saveScore,
}: {
  item: Item;
  position: number;
  /** Lettura o rettifica: nome e «Togli» fermi. */
  readOnly: boolean;
  /** Lettura: anche il punteggio fermo. */
  disabled: boolean;
  saveItem: PsfsItemSave;
  saveScore: PsfsScoreSave;
}) {
  const [scoreError, setScoreError] = useState<string | undefined>(undefined);
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);
  const { shown, choose, reset } = useChosen<number | null>(item.initial);
  const scoreErrorId = useId();
  const removeErrorId = useId();

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <VisitTextField
          id={`psfs-${item.id}`}
          label={`Attività ${position}`}
          className="min-w-0 flex-1"
          value={item.activity}
          maxLength={120}
          disabled={readOnly}
          // Il nome di un'attività non si svuota: per toglierla c'è «Togli».
          onSave={(value, options) => {
            if (value === null) return false;
            saveItem({ kind: "rinomina", itemId: item.id, activity: value }, options);
          }}
        />
        {readOnly ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Togli l'attività: ${item.activity}`}
            aria-describedby={removeError === undefined ? undefined : removeErrorId}
            onClick={() => {
              setRemoveError(undefined);
              saveItem({ kind: "togli", itemId: item.id }, { onRefused: (failure) => setRemoveError(refusalText(failure)) });
            }}
          >
            Togli
          </Button>
        )}
      </div>
      <PainScale
        id={`psfs-${item.id}-punteggio`}
        label={`Punteggio iniziale: ${item.activity}`}
        value={shown}
        disabled={disabled}
        describedBy={scoreError === undefined ? undefined : scoreErrorId}
        invalid={scoreError !== undefined}
        onChange={(score) => {
          setScoreError(undefined);
          choose(score);
          saveScore(item.id, score, {
            onRefused: (failure) => {
              reset();
              setScoreError(refusalText(failure));
            },
          });
        }}
      />
      {scoreError === undefined ? null : (
        <p id={scoreErrorId} className="text-sm text-destructive">
          {scoreError}
        </p>
      )}
      {removeError === undefined ? null : (
        <p id={removeErrorId} className="text-sm text-destructive">
          {removeError}
        </p>
      )}
    </li>
  );
}

/** «Aggiungi attività»: il nome in un campo suo, perché un'attività nasce solo con il nome (un'attività vuota non c'è). */
function AddActivity({ saveItem }: { saveItem: PsfsItemSave }) {
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const activity = text.trim();
    if (activity === "") {
      setError(REQUIRED);
      document.getElementById(id)?.focus();
      return;
    }
    setError(undefined);
    setText("");
    saveItem(
      { kind: "aggiungi", activity },
      {
        // Il nome torna nel campo, con la frase del rifiuto.
        onRefused: (failure) => {
          setText(activity);
          setError(refusalText(failure));
          document.getElementById(id)?.focus();
        },
      },
    );
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <Field id={id} label="Nuova attività" error={error} className="min-w-0 flex-1">
        <Input
          id={id}
          value={text}
          maxLength={120}
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            setError(undefined);
          }}
          {...described(id, error)}
        />
      </Field>
      <Button type="submit" variant="outline">
        Aggiungi attività
      </Button>
    </form>
  );
}

export function PsfsFields({
  editor,
  mode,
  saveItem,
  saveScore,
}: {
  editor: VisitEditor;
  mode: "bozza" | "rettifica" | "lettura";
  saveItem: PsfsItemSave;
  saveScore: PsfsScoreSave;
}) {
  const headingId = useId();
  const items = editor.cycle.psfs;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-medium">
        {PSFS_TITLE}
      </h3>
      <p className="text-sm text-muted-foreground">{PSFS_SCALE_HINT}</p>
      {items.length === 0 ? null : (
        <ul className="flex flex-col gap-3">
          {items.map((item, index) => (
            <PsfsRow
              key={item.id}
              item={item}
              position={index + 1}
              readOnly={mode !== "bozza"}
              disabled={mode === "lettura"}
              saveItem={saveItem}
              saveScore={saveScore}
            />
          ))}
        </ul>
      )}
      {mode === "bozza" && items.length < MAX_ITEMS ? <AddActivity saveItem={saveItem} /> : null}
    </section>
  );
}
