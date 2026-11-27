import type { Approach, RegionCode, TechniqueCode } from "@/lib/clinical/catalog";
import { RESPONSE_LABEL, TOLERANCE_LABEL } from "@/lib/clinical/labels";
import type { TreatmentCheck } from "@/lib/clinical/rules";
import type { EditorTreatment } from "@/server/domain/visits/editor";

// La riga di una tecnica come la modifica la sezione D dell'editor della visita,
// senza React: `RegionRow` e `TechniquePanel` la usano, i test unitari la provano da sola. Acceso =
// una riga di `visit_treatments`; approccio, tolleranza, risposta e nota stanno nel pannello della tecnica e ogni
// scrittura manda la riga intera.

export const APPROACH_LABEL: Record<Approach, string> = { direct: "Diretto", indirect: "Indiretto" };
export const APPROACHES: readonly Approach[] = ["direct", "indirect"];

/** Le voci delle scelte della tecnica: una sola copia per il pannello, il modulo di «Altra tecnica» e l'interruttore. */
export const APPROACH_ITEMS = APPROACHES.map((value) => ({ value, label: APPROACH_LABEL[value] }));
export const TOLERANCE_ITEMS = (Object.keys(TOLERANCE_LABEL) as (keyof typeof TOLERANCE_LABEL)[]).map((value) => ({
  value,
  label: TOLERANCE_LABEL[value],
}));
export const RESPONSE_ITEMS = (Object.keys(RESPONSE_LABEL) as (keyof typeof RESPONSE_LABEL)[]).map((value) => ({
  value,
  label: RESPONSE_LABEL[value],
}));

type ApproachChecks = Partial<Record<Approach, TreatmentCheck>> | undefined;

/**
 * Le voci dell'approccio con quelle bloccate dallo screening disattivate (`approachChecks`); `keep` è l'approccio
 * già salvato, che resta libero. Il motivo di ogni blocco sta in `blockedHint`.
 */
export function approachItems(checks: ApproachChecks, keep: Approach | null = null) {
  return APPROACH_ITEMS.map((item) => ({ ...item, disabled: checks?.[item.value]?.kind === "blocked" && item.value !== keep }));
}

/** Le frasi dei blocchi degli approcci, una dopo l'altra; undefined se nessuno è bloccato. */
export function blockedHint(checks: ApproachChecks, keep: Approach | null = null): string | undefined {
  const sentences = APPROACHES.flatMap((approach) => {
    const check = checks?.[approach];
    return check?.kind === "blocked" && approach !== keep ? [check.text] : [];
  });
  const distinct = [...new Set(sentences)];
  return distinct.length === 0 ? undefined : distinct.join(" ");
}
/**
 * Il nome dell'interruttore: l'etichetta del catalogo prima di " (" («HVLA», «TOG»). L'etichetta intera ne è la
 * descrizione quando dice di più.
 */
export const techniqueSwitchName = (label: string): string => label.split(" (")[0] ?? label;
export const techniqueSwitchDescription = (label: string): string | null =>
  techniqueSwitchName(label) === label ? null : label;

/** Una riga di tecnica in una regione: il codice, e per "Altra tecnica" il nome senza maiuscole. */
export const treatmentKey = (t: { techniqueCode: TechniqueCode; customTechnique: string | null }): string =>
  `${t.techniqueCode}:${(t.customTechnique ?? "").trim().toLowerCase()}`;

/**
 * L'approccio con cui parte una tecnica a scelta (craniale, viscerale): «Indiretto», o «Diretto» se solo quello
 * passa. Il blocco di ogni approccio lo dà `VisitEditor.approachChecks`.
 */
export function defaultApproach(checks: Partial<Record<Approach, TreatmentCheck>> | undefined): Approach {
  return checks?.indirect?.kind === "blocked" && checks.direct?.kind !== "blocked" ? "direct" : "indirect";
}

/** I campi del pannello della tecnica. */
export interface TreatmentFields {
  approach: Approach | null;
  tolerance: EditorTreatment["tolerance"];
  response: EditorTreatment["response"];
  note: string | null;
}

export const fieldsOf = (t: Pick<EditorTreatment, "approach" | "tolerance" | "response" | "note">): TreatmentFields => ({
  approach: t.approach,
  tolerance: t.tolerance,
  response: t.response,
  note: t.note,
});

/** Gli stessi campi come li riscrive il server (nota senza spazi ai lati, vuota = null). */
export function sameFields(a: TreatmentFields, b: TreatmentFields): boolean {
  return (
    a.approach === b.approach &&
    a.tolerance === b.tolerance &&
    a.response === b.response &&
    (a.note?.trim() || null) === (b.note?.trim() || null)
  );
}

/** L'operazione `tecnica` con la riga intera. */
export function techniqueOp(
  base: { region: RegionCode; techniqueCode: TechniqueCode; customTechnique: string | null },
  fields: TreatmentFields,
) {
  return {
    op: "tecnica" as const,
    region: base.region,
    techniqueCode: base.techniqueCode,
    customTechnique: base.customTechnique,
    approach: fields.approach,
    tolerance: fields.tolerance,
    response: fields.response,
    note: fields.note,
  };
}

/** Una tecnica appena accesa: tolleranza «Buona», nessuna risposta né nota. */
export const newFields = (approach: Approach | null): TreatmentFields => ({
  approach,
  tolerance: "buona",
  response: null,
  note: null,
});

/** Cosa resta fermo nella sezione D: niente si accende, una riga non si spegne, i campi o la nota non si cambiano. */
export interface TreatmentLocks {
  /** Niente si accende: la visita si legge, il consenso è revocato o lo screening non è confermato. */
  add: boolean;
  /** Approccio, tolleranza e risposta di una riga. */
  fields: boolean;
  /** Una riga accesa non si spegne; `copied`: la riga è copiata e non ancora confermata. */
  remove: (copied: boolean) => boolean;
  /** La nota di una riga. */
  note: (copied: boolean) => boolean;
}

/**
 * I blocchi della sezione D come le regole del server: senza
 * lo screening confermato una riga accesa si spegne e basta; con il consenso al trattamento revocato si annota la
 * riga salvata (`validateTechnique`, la sola nota) e si toglie una riga copiata mai confermata
 * (`requireConsentToRemoveTechnique`), nient'altro.
 */
export function treatmentLocks({
  readOnly,
  revoked,
  confirmed,
}: {
  readOnly: boolean;
  revoked: boolean;
  confirmed: boolean;
}): TreatmentLocks {
  const locked = readOnly || revoked || !confirmed;
  return {
    add: locked,
    fields: locked,
    remove: (copied) => readOnly || (revoked && !copied),
    note: (copied) => readOnly || !confirmed || (revoked && copied),
  };
}
