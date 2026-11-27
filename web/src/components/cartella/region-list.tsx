"use client";

import { ArrowDown, ArrowUp } from "lucide-react";

import { SeverityBadge } from "@/components/cartella/scale-parts";
import { type BodyFinding, COPIED_TEXT, PRIMARY_TEXT, regionFindingName, regionLabelWithSide } from "@/lib/clinical/body-map";
import { REGION_CODES, type RegionCode } from "@/lib/clinical/catalog";
import { severityChange, type Trend } from "@/lib/clinical/compare";
import { cn } from "@/lib/utils";

// L'elenco delle 10 regioni accanto al body chart: la via da tastiera
// e da lettore di schermo, perché le aree della sagoma sono `aria-hidden`. Un pulsante per regione, col nome di
// `regionFindingName` («Cervicale, severità 3, Primaria», «Arto inferiore dx, severità 2, Primaria»,
// «Cervicale, nessuna disfunzione»). Con "Confronta con", accanto al pulsante, la variazione di
// `severityChange` con la freccia e il giudizio in una parola nascosta.

const LIST_LABEL = "Regioni";

const TREND_TEXT: Record<Trend, string> = {
  improved: "migliorato",
  worsened: "peggiorato",
  unchanged: "invariato",
};

function SeverityChange({ before, after }: { before: number | null; after: number | null }) {
  const change = severityChange(before, after);
  const Arrow = change.trend === "worsened" ? ArrowUp : change.trend === "improved" ? ArrowDown : null;
  return (
    <span className="inline-flex w-20 shrink-0 items-center gap-1 text-sm">
      {Arrow === null ? null : <Arrow aria-hidden="true" className="size-4 shrink-0" />}
      <span className="tabular-nums">{change.text}</span>
      {change.trend === null ? null : <span className="sr-only">{`(${TREND_TEXT[change.trend]})`}</span>}
    </span>
  );
}

export function RegionList({
  findings,
  selected,
  onSelect,
  compare = null,
  buttonId,
}: {
  findings: readonly BodyFinding[];
  selected: RegionCode | null;
  onSelect: (region: RegionCode) => void;
  compare?: readonly BodyFinding[] | null;
  /** L'id del pulsante di una regione, per chi deve riportarci il focus (il pannello della regione che si chiude). */
  buttonId?: (region: RegionCode) => string;
}) {
  const today = new Map(findings.map((f) => [f.region, f]));
  const other = compare ? new Map(compare.map((f) => [f.region, f])) : null;

  return (
    <ul aria-label={LIST_LABEL} className="flex min-w-0 flex-col gap-1">
      {REGION_CODES.map((region) => {
        const finding = today.get(region);
        const before = other?.get(region);
        const showChange = other !== null && (finding !== undefined || before !== undefined);
        const isSelected = selected === region;
        return (
          <li key={region} className="flex items-center gap-2">
            <button
              id={buttonId?.(region)}
              type="button"
              aria-label={regionFindingName(region, finding)}
              aria-pressed={isSelected}
              onClick={() => onSelect(region)}
              className={cn(
                "flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 text-left text-sm outline-none hover:bg-muted",
                isSelected ? "border-primary bg-muted ring-1 ring-primary" : "border-border bg-background",
                "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              )}
            >
              <SeverityBadge severity={finding ? finding.severity : null} />
              <span className="min-w-0 flex-1 truncate">{regionLabelWithSide(region, finding)}</span>
              {finding?.isPrimary ? <span className="text-xs font-semibold">{PRIMARY_TEXT}</span> : null}
              {finding?.copied ? <span className="text-xs text-muted-foreground">{COPIED_TEXT}</span> : null}
            </button>
            {other === null ? null : showChange ? (
              <SeverityChange before={before?.severity ?? null} after={finding?.severity ?? null} />
            ) : (
              <span className="w-20 shrink-0" />
            )}
          </li>
        );
      })}
    </ul>
  );
}
