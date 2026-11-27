"use client";

import { TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Field } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  APPROACH_DECLARED,
  type Approach,
  REGION_CODES,
  REGION_LABEL,
  type RegionCode,
  TECHNIQUES,
  type Technique,
} from "@/lib/clinical/catalog";
import { APPROACH_REQUIRED, TREATMENT_CONSENT_REVOKED } from "@/lib/clinical/labels";
import { SCREENING_FIRST, type TreatmentCheck } from "@/lib/clinical/rules";
import { refusalText } from "@/lib/visits/text-autosave";
import {
  approachItems,
  blockedHint,
  defaultApproach,
  newFields,
  RESPONSE_ITEMS,
  techniqueOp,
  techniqueSwitchDescription,
  techniqueSwitchName,
  treatmentKey,
  treatmentLocks,
  type TreatmentLocks,
} from "@/lib/visits/treatment-row";
import type { ActionFailure } from "@/server/actions/result";
import type { EditorTreatment, VisitEditor } from "@/server/domain/visits/editor";

import { ChoiceField, ChoiceGroup, useChosen } from "./choice-group";
import { revealAnchor } from "./editor-section";
import { requestOpenRegion } from "./open-region";
import { OtherTechniqueForm } from "./other-technique-form";
import { TechniquePanel } from "./technique-panel";
import type { VisitSectionProps } from "./visit-editor";

// La sezione D dell'editor della visita, «Trattamento»: una riga per
// regione (quelle con tecniche salvate, più quelle aggiunte con «Aggiungi una regione» o con «Aggiungi le regioni con
// disfunzioni», che scrivono niente), e per ogni riga le tecniche come interruttori: acceso = una riga di
// `visit_treatments`, col nome prima di " (" e l'etichetta intera come descrizione. Lo stato viene dallo screening
// confermato (`techniqueChecks`, `approachChecks`): una tecnica controindicata non si accende e porta la frase del blocco
// sotto la riga, con cautela porta l'etichetta «Con cautela». Fasciale e Still vogliono l'approccio prima della riga
// («Scegli l'approccio.», con gli approcci bloccati disattivati), craniale e viscerale partono da «Indiretto». Un rifiuto
// sta sotto l'interruttore, collegato con `aria-describedby` e `aria-invalid`. «Altra tecnica» apre il nome e
// l'approccio. Con lo screening non confermato o il consenso al trattamento revocato la sezione si legge e basta; una
// tecnica già accesa si può comunque spegnere con lo screening non confermato (non scrive trattamento, e la riga che ha
// aperto il gruppo cervicale non resterebbe senza via d'uscita). Con il consenso revocato restano, come sul server, la
// nota di una riga salvata e il togli di una riga copiata mai confermata (`treatmentLocks`). In fondo, il campo unico
// «Risposta al trattamento».

const TART_WARNING = "Regione trattata senza disfunzioni somatiche (TART)";
const ADD_FINDING_REGIONS = "Aggiungi le regioni con disfunzioni";
const NOTHING_TO_ADD = "Nessuna regione con severità 2 o più da aggiungere.";
const MIN_SEVERITY = 2;
const OTHER_CODE = "altra";
const RADIO_TAB_STOP = '[role="radio"][tabindex="0"]';

/** Un avviso giallo: sfondo `warning` col suo `-foreground` e l'icona. */
function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="flex flex-wrap items-center gap-2 rounded-lg bg-warning px-2.5 py-2 text-sm text-warning-foreground">
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
      {children}
    </p>
  );
}

// Un interruttore -----------------------------------------------------------------------------------------------

interface ItemProps {
  region: RegionCode;
  editor: VisitEditor;
  op: VisitSectionProps["op"];
  /** Cosa resta fermo: la visita si legge, il consenso è revocato o lo screening non è confermato. */
  locks: TreatmentLocks;
  tech: Technique;
  /** La riga salvata della tecnica in questa regione; per «Altra tecnica», quella del suo nome. */
  treatment: EditorTreatment | undefined;
  expanded: boolean;
  detailsRef: (key: string, element: HTMLButtonElement | null) => void;
  /** La riga appena accesa apre i suoi dettagli senza prendere il focus; il pulsante «Dettagli» li apre o li chiude. */
  onDetails: (key: string, focus: boolean, open: boolean) => void;
}

function TechniqueItem({ region, editor, op, locks, tech, treatment, expanded, detailsRef, onDetails }: ItemProps) {
  const baseId = useId();
  const switchRef = useRef<HTMLSpanElement>(null);
  const on = treatment !== undefined;
  const { shown, choose, reset } = useChosen<boolean>(on);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const approachChecks = editor.approachChecks[region]?.[tech.code];
  // Lo stato della riga salvata, altrimenti quello della tecnica nella regione (per le tecniche a scelta, l'approccio
  // meno restrittivo): un approccio scelto si guarda con `approachChecks`.
  const check: TreatmentCheck = treatment?.check ?? editor.techniqueChecks[region][tech.code];
  const sentence = check.kind === "blocked" && check.text !== SCREENING_FIRST ? check.text : null;
  const name = treatment?.customTechnique ?? techniqueSwitchName(tech.label);
  const description = treatment?.customTechnique ? null : techniqueSwitchDescription(tech.label);
  const key = treatmentKey({ techniqueCode: tech.code, customTechnique: treatment?.customTechnique ?? null });
  const approachId = `${baseId}-approccio`;
  const ids = { switch: `${baseId}-interruttore`, description: `${baseId}-descrizione`, sentence: `${baseId}-frase`, caution: `${baseId}-cautela`, message: `${baseId}-rifiuto` };
  // La frase del rifiuto sta sotto la scelta dell'approccio quando è lei il problema, altrimenti sotto l'interruttore.
  const messageId = picking && !on ? `${approachId}-errore` : ids.message;
  const describedBy = [
    description === null ? null : ids.description,
    check.kind === "caution" ? ids.caution : null,
    sentence === null ? null : ids.sentence,
    message === undefined ? null : messageId,
  ]
    .filter(Boolean)
    .join(" ");

  // La scelta dell'approccio compare con la frase e prende il focus: chi usa il lettore di schermo la sente.
  useEffect(() => {
    if (picking) document.getElementById(approachId)?.querySelector<HTMLElement>(RADIO_TAB_STOP)?.focus();
  }, [picking, approachId]);

  const refused = (failure: ActionFailure) => {
    reset();
    setMessage(refusalText(failure));
    // Un rifiuto arriva dopo il clic: il focus torna sull'interruttore se non l'ha preso un altro campo.
    const active = document.activeElement;
    if (active === null || active === document.body) switchRef.current?.focus();
  };

  /** Accende la tecnica con l'approccio dato (null se non ne ha). */
  const turnOn = (approach: Approach | null) => {
    setMessage(undefined);
    setPicking(false);
    choose(true);
    op(techniqueOp({ region, techniqueCode: tech.code, customTechnique: null }, newFields(approach)), {
      onRefused: (failure) => {
        refused(failure);
        setPicking(APPROACH_DECLARED.includes(tech.code));
      },
    });
    onDetails(key, false, true);
  };

  const toggle = (next: boolean) => {
    if (next) {
      // Fasciale e Still vogliono l'approccio prima della riga: la scelta compare con la frase, e la riga non nasce.
      if (APPROACH_DECLARED.includes(tech.code)) {
        setMessage(APPROACH_REQUIRED);
        setPicking(true);
        return;
      }
      turnOn(tech.variableApproach ? defaultApproach(approachChecks) : null);
      return;
    }
    if (treatment === undefined) return;
    setMessage(undefined);
    choose(false);
    op({ op: "togli_tecnica", treatmentId: treatment.id }, { onRefused: refused });
  };

  const pick = (approach: Approach) => {
    const chosen = approachChecks?.[approach];
    if (chosen?.kind === "blocked") {
      setMessage(chosen.text);
      return;
    }
    turnOn(approach);
  };

  return (
    <li className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Switch
          id={ids.switch}
          ref={switchRef}
          checked={shown}
          disabled={treatment === undefined ? locks.add || check.kind === "blocked" : locks.remove(treatment.copied)}
          aria-invalid={message === undefined ? undefined : true}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          onCheckedChange={toggle}
        />
        <Label htmlFor={ids.switch} title={description ?? undefined} className="font-normal">
          {name}
        </Label>
        {check.kind === "caution" ? (
          <span id={ids.caution} className="rounded-full bg-warning px-2 py-0.5 text-xs font-medium text-warning-foreground">
            {check.text}
          </span>
        ) : null}
        {treatment?.copied ? <span className="rounded-full border px-2 py-0.5 text-xs">Da confermare</span> : null}
        {treatment === undefined ? null : (
          <Button
            ref={(element) => detailsRef(key, element)}
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Dettagli: ${name}`}
            aria-expanded={expanded}
            onClick={() => onDetails(key, true, !expanded)}
          >
            Dettagli
          </Button>
        )}
      </div>
      {description === null ? null : (
        <span id={ids.description} className="sr-only">
          {description}
        </span>
      )}
      {sentence === null ? null : (
        <p id={ids.sentence} className="text-sm">
          {sentence}
        </p>
      )}
      {picking && !on ? (
        <ChoiceGroup
          id={approachId}
          label={`Approccio di ${name}`}
          items={approachItems(approachChecks)}
          value={null}
          disabled={locks.add}
          error={message}
          hint={blockedHint(approachChecks)}
          onChange={pick}
        />
      ) : message === undefined ? null : (
        <p id={ids.message} className="text-sm text-destructive">
          {message}
        </p>
      )}
    </li>
  );
}

// La riga di una regione ---------------------------------------------------------------------------------------

function RegionRow({
  region,
  editor,
  op,
  locks,
}: {
  region: RegionCode;
  editor: VisitEditor;
  op: VisitSectionProps["op"];
  locks: TreatmentLocks;
}) {
  const headingId = useId();
  const treatments = editor.treatments.filter((t) => t.region === region);
  const hasFinding = editor.findings.some((f) => f.region === region);
  // Un solo pannello aperto per riga; `focus` dice se l'ha aperto un gesto sul pulsante «Dettagli».
  const [panel, setPanel] = useState<{ key: string; focus: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  // «Altra tecnica» inviata: il modulo resta aperto finché la tecnica non compare nella riga (o il comando rifiuta).
  const [sentKey, setSentKey] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const detailButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const otherSwitch = useRef<HTMLSpanElement>(null);
  const others = treatments.filter((t) => t.techniqueCode === OTHER_CODE);
  const otherKeys = new Set(others.map((t) => treatmentKey(t)));
  if (adding && sentKey !== null && otherKeys.has(sentKey)) {
    setAdding(false);
    setSentKey(null);
    setFocusTick((tick) => tick + 1);
  }
  // Il modulo chiuso dalla tecnica nata riporta il focus sull'interruttore «Altra tecnica».
  useEffect(() => {
    if (focusTick > 0) otherSwitch.current?.focus();
  }, [focusTick]);
  const opened = panel === null ? undefined : treatments.find((t) => treatmentKey(t) === panel.key);

  const common = {
    region,
    editor,
    op,
    locks,
    detailsRef: (key: string, element: HTMLButtonElement | null) => detailButtons.current.set(key, element),
    onDetails: (key: string, focus: boolean, open: boolean) => setPanel(open ? { key, focus } : null),
  };
  const catalog = TECHNIQUES.filter((t) => t.code !== OTHER_CODE);
  const other = TECHNIQUES.find((t) => t.code === OTHER_CODE);

  return (
    <section
      id={`riga-tecnica-${region}`}
      aria-labelledby={headingId}
      className="@container flex scroll-mt-4 flex-col gap-3 rounded-xl border p-4"
    >
      <h3 id={headingId} className="text-base font-medium">
        {REGION_LABEL[region]}
      </h3>
      {treatments.length === 0 || hasFinding ? null : (
        <Notice>
          {TART_WARNING}
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Apri la regione ${REGION_LABEL[region]}`}
            onClick={() => requestOpenRegion(region)}
          >
            Apri la regione
          </Button>
        </Notice>
      )}
      <ul className="grid gap-x-6 gap-y-3 @md:grid-cols-2 @3xl:grid-cols-3">
        {catalog.map((tech) => {
          const treatment = treatments.find((t) => t.techniqueCode === tech.code);
          return (
            <TechniqueItem
              key={tech.code}
              {...common}
              tech={tech}
              treatment={treatment}
              expanded={treatment !== undefined && panel?.key === treatmentKey(treatment)}
            />
          );
        })}
        {other === undefined
          ? null
          : others.map((treatment) => (
              <TechniqueItem
                key={treatmentKey(treatment)}
                {...common}
                tech={other}
                treatment={treatment}
                expanded={panel?.key === treatmentKey(treatment)}
              />
            ))}
        {other === undefined ? null : (
          <li className={adding ? "flex flex-col gap-2 @md:col-span-full" : "flex flex-col gap-2"}>
            <div className="flex items-center gap-2">
              <Switch
                id={`${headingId}-altra`}
                ref={otherSwitch}
                checked={adding}
                disabled={locks.add}
                onCheckedChange={(next) => {
                  setSentKey(null);
                  setAdding(next);
                }}
              />
              <Label htmlFor={`${headingId}-altra`} className="font-normal">
                {techniqueSwitchName(other.label)}
              </Label>
            </div>
            {adding ? (
              <OtherTechniqueForm
                region={region}
                op={op}
                approachChecks={editor.approachChecks[region]?.[OTHER_CODE]}
                existing={otherKeys}
                onSent={setSentKey}
                onClose={() => {
                  setAdding(false);
                  setSentKey(null);
                  otherSwitch.current?.focus();
                }}
              />
            ) : null}
          </li>
        )}
      </ul>
      {opened === undefined || panel === null ? null : (
        <TechniquePanel
          key={panel.key}
          treatment={opened}
          op={op}
          readOnly={locks.fields}
          noteReadOnly={locks.note(opened.copied)}
          approachChecks={editor.approachChecks[region]?.[opened.techniqueCode]}
          autoFocus={panel.focus}
          onClose={() => {
            setPanel(null);
            detailButtons.current.get(panel.key)?.focus();
          }}
        />
      )}
    </section>
  );
}

// La sezione ---------------------------------------------------------------------------------------------------

export function SectionD({ editor, mode, op }: VisitSectionProps) {
  const addId = useId();
  const [added, setAdded] = useState<readonly RegionCode[]>([]);
  const readOnly = mode === "lettura";
  const revoked = editor.consentRevoked;
  const confirmed = editor.visit.screeningConfirmed;
  // Senza lo screening confermato o col consenso revocato la sezione si legge e basta.
  const locks = treatmentLocks({ readOnly, revoked, confirmed });
  const locked = locks.add;

  const treated = new Set(editor.treatments.map((t) => t.region));
  const rows = REGION_CODES.filter((region) => treated.has(region) || added.includes(region));
  const withFindings = REGION_CODES.filter(
    (region) => !rows.includes(region) && editor.findings.some((f) => f.region === region && f.severity >= MIN_SEVERITY),
  );
  const remaining = REGION_CODES.filter((region) => !rows.includes(region)).map((value) => ({ value, label: REGION_LABEL[value] }));

  return (
    <div className="flex flex-col gap-4">
      {revoked ? (
        <Notice>{TREATMENT_CONSENT_REVOKED}</Notice>
      ) : confirmed || readOnly ? null : (
        <Notice>
          <a
            href="#sezione-b"
            className="underline underline-offset-4"
            onClick={(event) => {
              if (revealAnchor("sezione-b")) event.preventDefault();
            }}
          >
            {SCREENING_FIRST}
          </a>
        </Notice>
      )}

      {readOnly ? null : (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="flex flex-col gap-1.5">
            <Button
              type="button"
              variant="outline"
              disabled={locked || withFindings.length === 0}
              aria-describedby={withFindings.length === 0 ? `${addId}-niente` : undefined}
              onClick={() => setAdded((current) => [...current, ...withFindings])}
            >
              {ADD_FINDING_REGIONS}
            </Button>
            {withFindings.length === 0 ? (
              <p id={`${addId}-niente`} className="text-sm text-muted-foreground">
                {NOTHING_TO_ADD}
              </p>
            ) : null}
          </div>
          {remaining.length === 0 ? null : (
            <Field id={`${addId}-regione`} label="Aggiungi una regione" error={undefined} className="w-56">
              <Select
                items={remaining}
                value={null}
                disabled={locked}
                onValueChange={(next) => {
                  if (next !== null) setAdded((current) => [...current, next]);
                }}
              >
                <SelectTrigger id={`${addId}-regione`} className="w-full">
                  <SelectValue placeholder="Scegli la regione" />
                </SelectTrigger>
                <SelectContent>
                  {remaining.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </div>
      )}

      {rows.map((region) => (
        <RegionRow key={region} region={region} editor={editor} op={op} locks={locks} />
      ))}

      <ChoiceField
        id="campo-risposta-trattamento"
        label="Risposta al trattamento"
        clearable
        items={RESPONSE_ITEMS}
        value={editor.visit.fields.treatmentResponse}
        disabled={locked}
        onSave={(value, options) => op({ op: "campi", values: { treatmentResponse: value } }, options)}
      />
    </div>
  );
}
