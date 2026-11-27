"use client";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { FAMILIES, type Family, type Outcome } from "@/lib/clinical/catalog";
import { FAMILY_LABEL, OUTCOME_TEXT } from "@/lib/clinical/labels";
import { needsOverrideNote, OVERRIDE_NOTE_MIN, pillText } from "@/lib/clinical/rules";
import { cn } from "@/lib/utils";
import { markUnsaved, refusalText } from "@/lib/visits/text-autosave";
import type { ActionFailure } from "@/server/actions/result";
import type { VisitEditor } from "@/server/domain/visits/editor";

import { ChoiceGroup } from "./choice-group";
import { refocusIfIdle } from "./refocus";
import { ScreeningGroup } from "./screening-group";
import type { VisitSectionProps } from "./visit-editor";
import { VisitTextField } from "./visit-text-field";

// La sezione B dell'editor della visita, «Screening». In cima le tre
// pillole degli esiti salvati e, nelle visite dopo la prima, "Nessuna variazione dal 15/10"; poi i gruppi visibili
// (`ScreeningGroup`), con la riga della posizione nel gruppo gravidanza e la pressione facoltativa nel gruppo
// cervicale; in fondo l'esito per famiglia e «Conferma lo screening». L'esito suggerito viene dalle regole sulle
// risposte salvate; quello scelto, con la nota quando è più lieve del suggerito, si salva con la
// conferma, che vuole una risposta per ogni voce visibile. Su uno screening già confermato un esito cambiato
// riconferma subito (le scelte salvano subito), se la nota che serve c'è già; altrimenti aspetta la
// nota, che alla perdita del focus riconferma.

const CONFIRM = "Conferma lo screening";
const CONFIRM_ID = "conferma-screening";
const CERVICAL = "rf_cervicale_vascolare";
const PREGNANCY = "rf_gravidanza";
const OVERRIDE_NOTE_MAX = 500;

const OUTCOMES: readonly { value: Outcome; label: string }[] = [
  { value: "indicated", label: "Indicato" },
  { value: "caution", label: "Con cautela" },
  { value: "contraindicated", label: "Controindicato" },
];

// Il colore non è l'unico portatore: la pillola scrive l'esito; `warning` solo come sfondo col suo `-foreground`,
// il rosso come la variante `destructive` di Badge.
const PILL_TONE: Record<Outcome, string> = {
  indicated: "border-border bg-background text-foreground",
  caution: "border-transparent bg-warning text-warning-foreground",
  contraindicated: "border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20",
};

type Screening = VisitEditor["screening"];
type Saved = Screening["outcomes"];

/** Le tre pillole degli esiti salvati: "Thrust: controindicato", "Dirette: con cautela", "Indirette: indicato". */
function Pills({ outcomes }: { outcomes: NonNullable<Saved> }) {
  return (
    <ul aria-label="Esiti dello screening" className="flex flex-wrap gap-2">
      {FAMILIES.map((family) => {
        const outcome = outcomes[family].outcome;
        return (
          <li key={family} className={cn("rounded-full border px-3 py-1 text-sm font-medium", PILL_TONE[outcome])}>
            {pillText(family, outcome)}
          </li>
        );
      })}
    </ul>
  );
}

/** Il suggerito di una famiglia: «Suggerito: controindicato (terapia anticoagulante)». */
function suggestionText(s: Screening["suggestion"][Family]): string {
  const reasons = [s.reason, ...s.toVerify].filter((r): r is string => r !== null);
  return `Suggerito: ${OUTCOME_TEXT[s.suggested]}${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}`;
}

/** Le scelte fatte qui e non ancora salvate: l'esito e la nota di ogni famiglia toccata. */
interface Draft {
  choices: Partial<Record<Family, Outcome>>;
  notes: Partial<Record<Family, string | null>>;
}
const NO_DRAFT: Draft = { choices: {}, notes: {} };

/** Le scelte che dicono già quello che è salvato non sono più da salvare. */
function withoutSaved(draft: Draft, saved: NonNullable<Saved>): Draft {
  const choices: Draft["choices"] = {};
  const notes: Draft["notes"] = {};
  for (const f of FAMILIES) {
    const choice = draft.choices[f];
    if (choice !== undefined && choice !== saved[f].outcome) choices[f] = choice;
    if (f in draft.notes && (draft.notes[f] ?? null) !== saved[f].overrideNote) notes[f] = draft.notes[f] ?? null;
  }
  return { choices, notes };
}

function sameSaved(a: Saved, b: Saved): boolean {
  if (a === null || b === null) return a === b;
  return FAMILIES.every((f) => a[f].outcome === b[f].outcome && a[f].overrideNote === b[f].overrideNote);
}

/**
 * L'esito per famiglia e «Conferma lo screening». In rettifica (`amending`) la nota di ogni famiglia si vede sempre: il
 * suggerito della vista è quello della visita chiusa, e il server ricalcola dalle risposte nuove; se vuole una nota,
 * la nota si scrive qui.
 */
function Outcomes({
  screening,
  disabled,
  amending,
  op,
}: {
  screening: Screening;
  disabled: boolean;
  amending: boolean;
  op: VisitSectionProps["op"];
}) {
  const saved = screening.outcomes;
  const [state, setState] = useState<{ saved: Saved; draft: Draft }>({ saved, draft: NO_DRAFT });
  const [errors, setErrors] = useState<{ notes: Partial<Record<Family, string>>; general?: string }>({ notes: {} });
  const headingId = useId();
  const errorId = useId();

  // Esiti salvati diversi (una conferma, o una risposta che l'ha tolta): le scelte di qui ripartono da loro. Con gli
  // stessi esiti restano le scelte che dicono altro (una conferma uguale a quella salvata non lascia niente in sospeso).
  let draft = state.draft;
  if (state.saved !== saved) {
    if (!sameSaved(state.saved, saved)) draft = NO_DRAFT;
    else if (saved !== null) draft = withoutSaved(state.draft, saved);
    setState({ saved, draft });
  }

  // Scelte e note non ancora confermate: uscire dalla pagina chiede conferma, come per un testo non partito.
  const [owner] = useState(() => ({}));
  const dirty = Object.keys(draft.choices).length > 0 || Object.keys(draft.notes).length > 0;
  useEffect(() => markUnsaved(owner, dirty), [owner, dirty]);
  useEffect(() => () => markUnsaved(owner, false), [owner]);

  const outcomeIn = (d: Draft, f: Family): Outcome => d.choices[f] ?? saved?.[f].outcome ?? screening.suggestion[f].suggested;
  const noteIn = (d: Draft, f: Family): string | null => (f in d.notes ? (d.notes[f] ?? null) : (saved?.[f].overrideNote ?? null));
  const needsNote = (d: Draft, f: Family) => needsOverrideNote(screening.suggestion[f].suggested, outcomeIn(d, f));

  const onRefused = (failure: ActionFailure) => {
    const notes: Partial<Record<Family, string>> = {};
    FAMILIES.forEach((f, i) => {
      const message = failure.fieldErrors?.[`outcomes.${i}.overrideNote`];
      if (message !== undefined) notes[f] = message;
    });
    const first = FAMILIES.find((f) => notes[f] !== undefined);
    setErrors(first === undefined ? { notes: {}, general: refusalText(failure) } : { notes });
    refocusIfIdle(
      document.getElementById("sezione-b"),
      document.getElementById(first === undefined ? CONFIRM_ID : `nota-esito-${first}`),
    );
  };

  const confirm = (d: Draft) => {
    setErrors({ notes: {} });
    op(
      {
        op: "esiti",
        outcomes: FAMILIES.map((family) => ({ family, outcome: outcomeIn(d, family), overrideNote: noteIn(d, family) })),
      },
      { onRefused },
    );
  };

  /**
   * Un esito o una nota cambiati. Su uno screening confermato riconferma subito: una nota sempre (il server dice se
   * basta), un esito solo se ogni nota che serve è lunga abbastanza; altrimenti la scelta aspetta la nota.
   */
  const change = (d: Draft, isNote: boolean) => {
    setState({ saved, draft: d });
    if (saved === null) return;
    const ready = FAMILIES.every((f) => !needsNote(d, f) || (noteIn(d, f)?.length ?? 0) >= OVERRIDE_NOTE_MIN);
    if (isNote || ready) confirm(d);
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-sm font-medium">
        Esito per famiglia
      </h3>
      {FAMILIES.map((family) => {
        const required = needsNote(draft, family);
        const note = noteIn(draft, family);
        return (
          <div key={family} className="flex flex-col gap-2 rounded-lg border p-3">
            <ChoiceGroup
              id={`esito-${family}`}
              label={FAMILY_LABEL[family]}
              items={OUTCOMES}
              value={outcomeIn(draft, family)}
              disabled={disabled}
              hint={suggestionText(screening.suggestion[family])}
              onChange={(value) => change({ ...draft, choices: { ...draft.choices, [family]: value } }, false)}
            />
            {required || note !== null || amending ? (
              <VisitTextField
                id={`nota-esito-${family}`}
                label="Nota sull'esito"
                required={required}
                value={note}
                maxLength={OVERRIDE_NOTE_MAX}
                disabled={disabled}
                externalError={errors.notes[family]}
                onSave={(value) => {
                  setErrors((current) => ({ ...current, notes: { ...current.notes, [family]: undefined } }));
                  change({ ...draft, notes: { ...draft.notes, [family]: value } }, true);
                }}
              />
            ) : null}
          </div>
        );
      })}
      <div className="flex flex-col gap-1.5">
        <Button
          id={CONFIRM_ID}
          type="button"
          className="self-start"
          disabled={disabled}
          aria-describedby={errors.general === undefined ? undefined : errorId}
          onClick={() => confirm(draft)}
        >
          {CONFIRM}
        </Button>
        {errors.general === undefined ? null : (
          <p id={errorId} className="text-sm text-destructive">
            {errors.general}
          </p>
        )}
      </div>
    </section>
  );
}

/** La pressione facoltativa col gruppo cervicale: `bpSystolic` e `bpDiastolic` della visita. */
function Pressure({ editor, disabled, op }: { editor: VisitEditor; disabled: boolean; op: VisitSectionProps["op"] }) {
  const field = (key: "bpSystolic" | "bpDiastolic", id: string, label: string, min: number, max: number) => {
    const value = editor.visit.fields[key];
    return (
      <VisitTextField
        id={id}
        label={label}
        type="number"
        min={min}
        max={max}
        optional
        className="w-44"
        value={value === null ? null : String(value)}
        disabled={disabled}
        onSave={(next, options) => op({ op: "campi", values: { [key]: next === null ? null : Number(next) } }, options)}
      />
    );
  };
  return (
    <div className="flex flex-wrap gap-4 pt-3">
      {field("bpSystolic", "campo-pressione-massima", "Pressione massima", 50, 260)}
      {field("bpDiastolic", "campo-pressione-minima", "Pressione minima", 30, 160)}
    </div>
  );
}

export function SectionB({ editor, mode, op }: VisitSectionProps) {
  const { screening } = editor;
  const disabled = mode === "lettura";
  const [noChangeError, setNoChangeError] = useState<string | undefined>(undefined);
  const noChangeErrorId = useId();

  return (
    <div className="flex flex-col gap-6">
      {screening.outcomes === null ? null : <Pills outcomes={screening.outcomes} />}
      {screening.noChange === null || mode !== "bozza" ? null : (
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            size="lg"
            className="self-start"
            aria-describedby={noChangeError === undefined ? undefined : noChangeErrorId}
            onClick={() => {
              setNoChangeError(undefined);
              op({ op: "nessuna_variazione" }, { onRefused: (failure) => setNoChangeError(refusalText(failure)) });
            }}
          >
            {screening.noChange.label}
          </Button>
          {noChangeError === undefined ? null : (
            <p id={noChangeErrorId} className="text-sm text-destructive">
              {noChangeError}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {screening.groups.map((group) => (
          <ScreeningGroup key={group.code} group={group} disabled={disabled} op={op}>
            {group.code === PREGNANCY && screening.positionNote !== null ? (
              <p className="pt-3 text-sm">{screening.positionNote}</p>
            ) : null}
            {group.code === CERVICAL ? <Pressure editor={editor} disabled={disabled} op={op} /> : null}
          </ScreeningGroup>
        ))}
      </div>
      <Outcomes screening={screening} disabled={disabled} amending={mode === "rettifica"} op={op} />
    </div>
  );
}
