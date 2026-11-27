"use client";

import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { ChoiceSelect, described, Field, REQUIRED } from "@/components/forms/form-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { REGION_CODES, REGION_LABEL, type RegionCode, RISK_TAGS, type RiskTag } from "@/lib/clinical/catalog";
import { HISTORY_KIND_LABEL, RISK_BADGE, RISK_TAG_LABEL } from "@/lib/clinical/labels";
import { riskTagsForDrug } from "@/lib/clinical/rules";
import type { ActionFailure } from "@/server/actions/result";
import { refusalText } from "@/lib/visits/text-autosave";
import type { HistoryItemRow, HistoryView } from "@/server/domain/history/queries";

import type { ChoiceItem } from "./choice-group";
import { Block, type HistorySave } from "./history-parts";

// L'anamnesi remota della prima visita: quattro elenchi con "Aggiungi
// farmaco", "Aggiungi intervento" (con la regione), "Aggiungi trauma" e "Aggiungi patologia". Una voce si aggiunge, si
// modifica e si toglie con un modulo che ha il suo «Salva»: la voce nasce con un nome, e un nome a metà non è una
// voce. Il modulo ha anche i segnali di rischio (TAO, NAO, osteoporosi, cicatrice...): da quelli vengono i badge in
// testata e le risposte dello screening che nascono dall'anamnesi, e l'osteopata li toglie o li mette a mano.
// Per un farmaco partono dal suo nome (`riskTagsForDrug`) e lo seguono finché non ne tocca uno.

type ListKind = "farmaco" | "intervento" | "trauma" | "patologia";

const LISTS: readonly { kind: ListKind; plural: string; add: string; save: string }[] = [
  { kind: "farmaco", plural: "Farmaci", add: "Aggiungi farmaco", save: "Salva il farmaco" },
  { kind: "intervento", plural: "Interventi", add: "Aggiungi intervento", save: "Salva l'intervento" },
  { kind: "trauma", plural: "Traumi", add: "Aggiungi trauma", save: "Salva il trauma" },
  { kind: "patologia", plural: "Patologie", add: "Aggiungi patologia", save: "Salva la patologia" },
];

/** Interventi e traumi hanno la regione e l'etichetta cicatrice. */
const SCAR_KINDS: readonly string[] = ["intervento", "trauma"];

const NO_REGION = "nessuna";
const REGION_ITEMS: readonly ChoiceItem<string>[] = [
  { value: NO_REGION, label: "Nessuna" },
  ...REGION_CODES.map((code) => ({ value: code as string, label: REGION_LABEL[code] })),
];

interface ItemValues {
  label: string;
  region: string;
  year: string;
  ongoing: boolean;
  note: string;
  riskTags: readonly RiskTag[];
  /** L'utente ha toccato una casella: le etichette non seguono più il nome del farmaco. */
  tagsTouched: boolean;
}

const EMPTY_ITEM: ItemValues = { label: "", region: NO_REGION, year: "", ongoing: false, note: "", riskTags: [], tagsTouched: false };

const sameTags = (a: readonly RiskTag[], b: readonly RiskTag[]): boolean => a.length === b.length && a.every((tag) => b.includes(tag));

function valuesOf(item: HistoryItemRow): ItemValues {
  return {
    label: item.label,
    region: item.region ?? NO_REGION,
    year: String(item.occurredYear ?? (item.occurredOn === null ? "" : item.occurredOn.slice(0, 4))),
    ongoing: item.ongoing,
    note: item.note ?? "",
    riskTags: item.riskTags,
    // Etichette diverse da quelle del nome le ha scelte l'osteopata: restano.
    tagsTouched: item.kind !== "farmaco" || !sameTags(item.riskTags, riskTagsForDrug(item.label)),
  };
}

/** Il testo di una voce sotto il nome: regione, anno, «in corso» e nota. */
function detailsOf(item: HistoryItemRow): string {
  const year = item.occurredYear ?? (item.occurredOn === null ? null : Number(item.occurredOn.slice(0, 4)));
  return [
    item.region === null ? null : (REGION_LABEL[item.region as RegionCode] ?? item.region),
    year === null ? null : String(year),
    item.ongoing ? "in corso" : null,
    item.note,
  ]
    .filter((part) => part !== null && part !== "")
    .join(", ");
}

/** I campi del modulo a cui il server può attaccare una frase: le altre chiavi vanno sotto il nome. */
const FORM_FIELDS = ["label", "region", "occurredYear", "riskTags", "note"] as const;

/** Le frasi di un rifiuto, ognuna sotto il suo campo (chiave del campo del comando); senza campi, tutte sotto il nome. */
function formErrors(failure: ActionFailure): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [path, message] of Object.entries(failure.fieldErrors ?? {})) {
    const field = FORM_FIELDS.find((name) => name === path) ?? "label";
    errors[field] ??= message;
  }
  if (Object.keys(errors).length === 0) errors.label = refusalText(failure);
  return errors;
}

/** Il modulo di una voce nuova o modificata: «Salva» manda la voce, «Annulla» lo chiude. */
function ItemForm({
  kind,
  save,
  initial,
  errors,
  onSubmit,
  onCancel,
}: {
  kind: ListKind;
  save: string;
  initial: ItemValues;
  errors: Record<string, string>;
  onSubmit: (values: ItemValues) => void;
  onCancel: () => void;
}) {
  const baseId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState(initial);
  const [labelError, setLabelError] = useState<string | undefined>(undefined);
  const scarKind = SCAR_KINDS.includes(kind);
  const ids = { name: `${baseId}-nome`, region: `${baseId}-regione`, year: `${baseId}-anno`, note: `${baseId}-nota`, tags: `${baseId}-segnali` };
  const set = <K extends keyof ItemValues>(key: K, value: ItemValues[K]) => setValues((current) => ({ ...current, [key]: value }));
  const nameError = labelError ?? errors.label;
  const invalid = [nameError, errors.region, errors.occurredYear, errors.riskTags, errors.note].join("|");

  // Il modulo si apre sul nome; dopo un rifiuto o un nome mancante il focus va al primo campo in errore.
  useEffect(() => {
    const form = formRef.current;
    const first = form?.querySelector<HTMLElement>("[aria-invalid='true'], [data-invalid='true']");
    (first ?? form?.querySelector<HTMLElement>("input"))?.focus();
  }, [invalid]);

  const changeLabel = (label: string) =>
    setValues((current) => ({
      ...current,
      label,
      // Un farmaco prende le etichette dal nome finché l'utente non ne tocca una.
      riskTags: kind === "farmaco" && !current.tagsTouched ? riskTagsForDrug(label) : current.riskTags,
    }));
  const toggleTag = (tag: RiskTag, on: boolean) =>
    setValues((current) => ({
      ...current,
      tagsTouched: true,
      riskTags: RISK_TAGS.filter((t) => (t === tag ? on : current.riskTags.includes(t))),
    }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (values.label.trim() === "") {
      setLabelError(REQUIRED);
      return;
    }
    setLabelError(undefined);
    onSubmit(values);
  };

  return (
    <form ref={formRef} noValidate onSubmit={submit} className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3">
      <Field id={ids.name} label={HISTORY_KIND_LABEL[kind]} required error={nameError}>
        <Input
          id={ids.name}
          value={values.label}
          maxLength={200}
          autoComplete="off"
          onChange={(event) => {
            changeLabel(event.target.value);
            setLabelError(undefined);
          }}
          {...described(ids.name, nameError)}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        {scarKind ? (
          <ChoiceSelect
            id={ids.region}
            label="Regione interessata"
            items={REGION_ITEMS}
            value={values.region}
            onChange={(value) => set("region", value)}
            error={errors.region}
          />
        ) : null}
        <Field id={ids.year} label="Anno" error={errors.occurredYear}>
          <Input
            id={ids.year}
            type="number"
            min={1900}
            max={2100}
            value={values.year}
            onChange={(event) => set("year", event.target.value)}
            {...described(ids.year, errors.occurredYear)}
          />
        </Field>
      </div>
      <div className="flex min-h-8 items-center gap-2">
        <Checkbox id={`${baseId}-in-corso`} checked={values.ongoing} onCheckedChange={(checked) => set("ongoing", checked)} />
        <Label htmlFor={`${baseId}-in-corso`}>In corso</Label>
      </div>
      <fieldset
        tabIndex={-1}
        data-invalid={errors.riskTags === undefined ? undefined : "true"}
        aria-describedby={[kind === "farmaco" ? `${ids.tags}-nota` : null, errors.riskTags === undefined ? null : `${ids.tags}-errore`]
          .filter(Boolean)
          .join(" ") || undefined}
        className="flex flex-col gap-2 outline-none"
      >
        <legend className="mb-1 text-sm font-medium">Segnali di rischio</legend>
        {kind === "farmaco" ? (
          <p id={`${ids.tags}-nota`} className="text-sm text-muted-foreground">
            Per un farmaco partono dal suo nome: puoi cambiarli.
          </p>
        ) : null}
        <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {RISK_TAGS.filter((tag) => scarKind || tag !== "cicatrice").map((tag) => (
            <div key={tag} className="flex min-h-8 items-center gap-2">
              <Checkbox
                id={`${ids.tags}-${tag}`}
                checked={values.riskTags.includes(tag)}
                onCheckedChange={(checked) => toggleTag(tag, checked)}
              />
              <Label htmlFor={`${ids.tags}-${tag}`}>{RISK_TAG_LABEL[tag]}</Label>
            </div>
          ))}
        </div>
        {errors.riskTags === undefined ? null : (
          <p id={`${ids.tags}-errore`} className="text-sm text-destructive">
            {errors.riskTags}
          </p>
        )}
      </fieldset>
      <Field id={ids.note} label="Nota" error={errors.note}>
        <Input
          id={ids.note}
          value={values.note}
          maxLength={500}
          autoComplete="off"
          onChange={(event) => set("note", event.target.value)}
          {...described(ids.note, errors.note)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit">{save}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Annulla
        </Button>
      </div>
    </form>
  );
}

interface OpenForm {
  kind: ListKind;
  itemId: string | null;
  values: ItemValues;
  errors: Record<string, string>;
}

function HistoryItemRowView({
  item,
  disabled,
  onEdit,
  onRemove,
  error,
}: {
  item: HistoryItemRow;
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
  error: string | undefined;
}) {
  const errorId = useId();
  const details = detailsOf(item);
  const badges = item.riskTags.flatMap((tag) => (tag === "cicatrice" ? ["Cicatrice"] : RISK_BADGE[tag] ? [RISK_BADGE[tag]] : []));
  const describedBy = error === undefined ? undefined : errorId;
  return (
    <li className="flex flex-col gap-1 rounded-lg border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="font-medium">{item.label}</span>
          {details === "" ? null : <span className="text-muted-foreground">{`, ${details}`}</span>}
        </span>
        {badges.map((badge) => (
          <Badge key={badge} variant="secondary">
            {badge}
          </Badge>
        ))}
        {disabled ? null : (
          <>
            <Button type="button" variant="ghost" size="sm" aria-label={`Modifica: ${item.label}`} onClick={onEdit}>
              Modifica
            </Button>
            <Button type="button" variant="ghost" size="sm" aria-label={`Togli: ${item.label}`} aria-describedby={describedBy} onClick={onRemove}>
              Togli
            </Button>
          </>
        )}
      </div>
      {error === undefined ? null : (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

export function RemoteHistory({ history, disabled, save }: { history: HistoryView; disabled: boolean; save: HistorySave }) {
  const [form, setForm] = useState<OpenForm | null>(null);
  const [removeError, setRemoveError] = useState<{ itemId: string; message: string } | null>(null);
  const addRefs = useRef<Partial<Record<ListKind, HTMLButtonElement | null>>>({});

  // Il pulsante «Aggiungi» torna al suo posto dopo che il modulo si è chiuso: il focus lo segue.
  const focusAdd = (kind: ListKind) => setTimeout(() => addRefs.current[kind]?.focus(), 0);

  const submit = (open: OpenForm, values: ItemValues) => {
    const scarKind = SCAR_KINDS.includes(open.kind);
    const item = {
      ...(open.itemId === null ? {} : { itemId: open.itemId }),
      kind: open.kind,
      label: values.label.trim(),
      region: scarKind && values.region !== NO_REGION ? values.region : null,
      occurredOn: null,
      occurredYear: values.year.trim() === "" ? null : Number(values.year),
      ongoing: values.ongoing,
      // Le etichette partono sempre: quelle scelte, non quelle che il server tirerebbe fuori dal nome.
      riskTags: RISK_TAGS.filter((tag) => values.riskTags.includes(tag) && (scarKind || tag !== "cicatrice")),
      note: values.note.trim() === "" ? null : values.note.trim(),
    };
    setForm(null);
    focusAdd(open.kind);
    save(
      { kind: "voce", item },
      // Il modulo torna aperto con i valori scritti e la frase sotto il suo campo.
      { onRefused: (failure) => setForm({ ...open, values, errors: formErrors(failure) }) },
    );
  };

  const others = history.items.filter((item) => !LISTS.some((list) => list.kind === item.kind));

  return (
    <Block title="Anamnesi remota">
      {LISTS.map((list) => {
        const items = history.items.filter((item) => item.kind === list.kind);
        const open = form?.kind === list.kind ? form : null;
        return (
          <div key={list.kind} role="group" aria-label={list.plural} className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">{list.plural}</h4>
            {items.length === 0 ? <p className="text-sm text-muted-foreground">Nessuna voce.</p> : null}
            {items.length === 0 ? null : (
              <ul className="flex flex-col gap-2">
                {items.map((item) =>
                  open?.itemId === item.id ? null : (
                    <HistoryItemRowView
                      key={item.id}
                      item={item}
                      disabled={disabled}
                      error={removeError?.itemId === item.id ? removeError.message : undefined}
                      onEdit={() => setForm({ kind: list.kind, itemId: item.id, values: valuesOf(item), errors: {} })}
                      onRemove={() => {
                        setRemoveError(null);
                        save(
                          { kind: "togli_voce", itemId: item.id },
                          { onRefused: (failure) => setRemoveError({ itemId: item.id, message: refusalText(failure) }) },
                        );
                      }}
                    />
                  ),
                )}
              </ul>
            )}
            {open === null ? null : (
              <ItemForm
                key={open.itemId ?? "nuova"}
                kind={list.kind}
                save={list.save}
                initial={open.values}
                errors={open.errors}
                onSubmit={(values) => submit(open, values)}
                onCancel={() => {
                  setForm(null);
                  focusAdd(list.kind);
                }}
              />
            )}
            {disabled || open !== null ? null : (
              <div>
                <Button
                  ref={(el) => {
                    addRefs.current[list.kind] = el;
                  }}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setForm({ kind: list.kind, itemId: null, values: EMPTY_ITEM, errors: {} })}
                >
                  {list.add}
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {others.length === 0 ? null : (
        <div role="group" aria-label="Altre voci" className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">Altre voci</h4>
          <ul className="flex flex-col gap-2">
            {others.map((item) => (
              <HistoryItemRowView key={item.id} item={item} disabled onEdit={() => undefined} onRemove={() => undefined} error={undefined} />
            ))}
          </ul>
        </div>
      )}
    </Block>
  );
}
