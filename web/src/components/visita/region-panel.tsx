"use client";

import { X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { RADIO_ITEM } from "@/components/cartella/scale-parts";
import { SeverityScale } from "@/components/cartella/severity-scale";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PRIMARY_TEXT, type SeverityLevel, severityLevel } from "@/lib/clinical/body-map";
import { REGION_LABEL, type RegionCode, SIDED_REGIONS } from "@/lib/clinical/catalog";
import { SIDE_LABEL, TART } from "@/lib/clinical/labels";
import { cn } from "@/lib/utils";
import {
  type FindingRow,
  findingRowOf,
  normalizedFindingRow,
  sameFindingRow,
  validNewFinding,
} from "@/lib/visits/finding-row";
import type { RunOptions } from "@/lib/visits/save-queue";
import { refusalText } from "@/lib/visits/text-autosave";
import type { ActionFailure } from "@/server/actions/result";
import type { VisitEditor } from "@/server/domain/visits/editor";

import { ChoiceGroup, useRowDraft } from "./choice-group";
import { refocusIfIdle } from "./refocus";
import type { VisitSectionProps } from "./visit-editor";
import { VisitTextField } from "./visit-text-field";

// Il pannello della regione accanto al body chart: la severità a 4 voci
// (`SeverityScale`), i quattro interruttori TART con la lettera e l'etichetta nel tooltip e nel nome accessibile, il
// lato solo per gli arti, il segmento e "Primaria"; «Togli la regione» toglie la disfunzione. Ogni modifica manda la
// riga intera (`disfunzione`), costruita dalla riga mostrata (`useRowDraft`) e normalizzata come la salva il server
// (src/lib/visits/finding-row.ts), così due modifiche di fila non si cancellano e la vista che torna combacia. Una
// regione senza riga si salva al primo gesto che la rende valida (una severità da 1, o una lettera TART): prima, lato e
// segmento restano qui. Il lato toccato sulla sagoma (`side`) si propone per una regione nuova e per un arto salvato
// senza lato. All'apertura il pannello entra nella vista col focus sulla severità; Esc chiude e la sezione riporta il
// focus sull'elenco.

const SIDES = (["dx", "sx", "bilaterale"] as const).map((value) => ({ value, label: SIDE_LABEL[value] }));
const TART_TITLE = "TART";
const SEGMENT_MAX = 200;
/** La voce della severità che tiene il punto d'ingresso: la prima scala del pannello. */
const SEVERITY_TAB_STOP = '[role="radio"][tabindex="0"]';

type TartKey = (typeof TART)[number]["key"];

type ErrorField = "severity" | "tart" | "side" | "primary" | "remove";

/** La chiave di `fieldErrors` del rifiuto che va sotto quel controllo. */
const FIELD_OF: Record<string, ErrorField> = { severity: "severity", side: "side", isPrimary: "primary" };

export interface RegionPanelProps {
  region: RegionCode;
  /** Il lato dell'arto toccato sulla sagoma: la proposta per una regione nuova o per un arto salvato senza lato. */
  side: "dx" | "sx" | null;
  editor: VisitEditor;
  op: VisitSectionProps["op"];
  readOnly: boolean;
  onClose: () => void;
}

export function RegionPanel({ region, side, editor, op, readOnly, onClose }: RegionPanelProps) {
  const sided = SIDED_REGIONS.includes(region);
  const finding = editor.findings.find((f) => f.region === region);
  // Il lato toccato si propone anche su un arto salvato senza lato: si vede scelto e parte col gesto dopo.
  const { row, send, edit, reset } = useRowDraft(
    finding,
    (f) => findingRowOf(f, side),
    sameFindingRow,
    (shown) => (sided && shown.side === null && side !== null ? { ...shown, side } : shown),
  );
  const [error, setError] = useState<{ field: ErrorField; message: string } | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const baseId = useId();
  const ids = {
    heading: `${baseId}-titolo`,
    severity: `${baseId}-severita`,
    tart: `${baseId}-tart`,
    side: `${baseId}-lato`,
    segment: `pannello-${region}-segmento`,
    primary: `${baseId}-primaria`,
    remove: `${baseId}-togli`,
    error: `${baseId}-errore`,
  };

  const focusSeverity = () => panelRef.current?.querySelector<HTMLElement>(SEVERITY_TAB_STOP)?.focus();
  // All'apertura (il pannello nasce per regione) il pannello entra nella vista e il focus va sulla severità.
  useEffect(() => {
    const panel = panelRef.current;
    panel?.scrollIntoView({ block: "nearest" });
    panel?.querySelector<HTMLElement>(SEVERITY_TAB_STOP)?.focus({ preventScroll: true });
  }, []);

  const refused = (field: ErrorField) => (failure: ActionFailure) => {
    reset();
    const key = Object.keys(failure.fieldErrors ?? {}).find((k) => FIELD_OF[k] !== undefined);
    const target = key === undefined ? field : (FIELD_OF[key] ?? field);
    setError({ field: target, message: refusalText(failure) });
    const scope = panelRef.current;
    const focus =
      target === "severity" || target === "side"
        ? document.getElementById(ids[target])?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')
        : document.getElementById(ids[target]);
    refocusIfIdle(scope, focus ?? null);
  };

  /**
   * Una modifica della riga: la manda intera, normalizzata come la salva il server, se la regione c'è già o se ora è
   * valida; altrimenti la tiene qui. `onRefused` mette la frase sotto il controllo che l'ha mandata.
   */
  const commit = (next: FindingRow, onRefused: (failure: ActionFailure) => void) => {
    setError(null);
    if (finding === undefined && !validNewFinding(next)) {
      edit(next);
      return;
    }
    const sent = normalizedFindingRow(next, sided);
    send(sent);
    op(
      {
        op: "disfunzione",
        region,
        severity: sent.severity ?? 0,
        tissueTexture: sent.tissueTexture,
        asymmetry: sent.asymmetry,
        restriction: sent.restriction,
        tenderness: sent.tenderness,
        side: sent.side,
        segmentNote: sent.segmentNote,
        isPrimary: sent.isPrimary,
      },
      { onRefused },
    );
  };

  /** Il segmento: il rifiuto va sotto il campo (`options` del testo) e la riga torna quella della vista. */
  const saveSegment = (value: string | null, options: RunOptions) =>
    commit({ ...row, segmentNote: value }, (failure) => {
      reset();
      options.onRefused?.(failure);
    });

  const remove = () => {
    setError(null);
    send(findingRowOf(undefined, side));
    op({ op: "togli_disfunzione", region }, { onRefused: refused("remove") });
    focusSeverity();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };

  const errorFor = (field: ErrorField) => (error?.field === field ? error.message : undefined);
  const errorLine = (field: ErrorField) =>
    error?.field === field ? (
      <p id={ids.error} className="text-sm text-destructive">
        {error.message}
      </p>
    ) : null;
  const describedBy = (field: ErrorField) => (error?.field === field ? ids.error : undefined);

  return (
    <section
      ref={panelRef}
      aria-labelledby={ids.heading}
      onKeyDown={onKeyDown}
      className="@container flex flex-col gap-4 rounded-xl border bg-background p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={ids.heading} className="text-base font-medium">
          {REGION_LABEL[region]}
        </h3>
        <Button type="button" variant="ghost" size="icon" aria-label="Chiudi il pannello della regione" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="grid gap-6 @lg:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <SeverityScale
            id={ids.severity}
            value={row.severity === null ? null : (severityLevel(row.severity) as SeverityLevel)}
            disabled={readOnly}
            describedBy={describedBy("severity")}
            invalid={error?.field === "severity"}
            onChange={(level) => commit({ ...row, severity: level }, refused("severity"))}
          />
          {errorLine("severity")}
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span id={ids.tart} className="text-sm font-medium">
              {TART_TITLE}
            </span>
            <div role="group" aria-labelledby={ids.tart} aria-describedby={describedBy("tart")} className="flex gap-2">
              {TART.map(({ key, letter, label }) => (
                <TartToggle
                  key={key}
                  letter={letter}
                  label={label}
                  pressed={row[key]}
                  disabled={readOnly}
                  onToggle={() => commit({ ...row, [key as TartKey]: !row[key] }, refused("tart"))}
                />
              ))}
            </div>
            {errorLine("tart")}
          </div>
          {sided ? (
            <ChoiceGroup
              id={ids.side}
              label="Lato"
              items={SIDES}
              value={row.side === "centrale" ? null : row.side}
              disabled={readOnly}
              error={errorFor("side")}
              onChange={(value) => commit({ ...row, side: value }, refused("side"))}
              onClear={() => commit({ ...row, side: null }, refused("side"))}
            />
          ) : null}
          <VisitTextField
            id={ids.segment}
            label="Segmento"
            optional
            value={row.segmentNote}
            maxLength={SEGMENT_MAX}
            disabled={readOnly}
            onSave={saveSegment}
          />
          <div className="flex flex-col gap-1.5">
            <button
              id={ids.primary}
              type="button"
              aria-pressed={row.isPrimary}
              aria-describedby={describedBy("primary")}
              disabled={readOnly}
              onClick={() => commit({ ...row, isPrimary: !row.isPrimary }, refused("primary"))}
              className={cn(
                "inline-flex min-h-9 items-center self-start rounded-lg border px-3 text-sm",
                row.isPrimary ? "border-primary bg-primary font-semibold text-primary-foreground" : "border-border bg-background hover:bg-muted",
                RADIO_ITEM,
              )}
            >
              {PRIMARY_TEXT}
            </button>
            {errorLine("primary")}
          </div>
          {finding === undefined || readOnly ? null : (
            <div className="flex flex-col gap-1.5">
              <Button
                id={ids.remove}
                type="button"
                variant="outline"
                className="self-start"
                aria-describedby={describedBy("remove")}
                onClick={remove}
              >
                Togli la regione
              </Button>
              {errorLine("remove")}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Un interruttore TART: la lettera scritta, l'etichetta nel tooltip e nel nome accessibile. */
function TartToggle({
  letter,
  label,
  pressed,
  disabled,
  onToggle,
}: {
  letter: string;
  label: string;
  pressed: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onToggle}
            className={cn(
              "inline-flex size-11 items-center justify-center rounded-lg border text-base font-semibold",
              pressed ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted",
              RADIO_ITEM,
            )}
          />
        }
      >
        {letter}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
