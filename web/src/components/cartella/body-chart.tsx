"use client";

import {
  BODY_AREAS,
  BODY_SCALE,
  BODY_VIEWBOX,
  type BodyArea,
  type BodyFinding,
  type BodyView,
  COPIED_TEXT,
  findingFitsArea,
  LEFT_SIDE,
  PRIMARY_TEXT,
  type SeverityLevel,
  severityLevel,
  SILHOUETTE,
} from "@/lib/clinical/body-map";
import type { RegionCode } from "@/lib/clinical/catalog";
import { VIEW_LABEL } from "@/lib/clinical/labels";
import { cn } from "@/lib/utils";

// Il body chart della visita: due sagome affiancate, anteriore e
// posteriore, a scala 1,2 (viewBox 240 x 520, 288 x 624 px) con le aree delle 10 regioni. La severità è il
// colore `primary` a 4 livelli (0 nessuno, 1 al 25 %, 2 al 55 %, 3 pieno) più il numero scritto dentro; la
// primaria ha il bordo spesso e «Primaria» sotto il numero, la copiata il bordo tratteggiato e «da confermare»
// (10 unità, 12 px). La disfunzione di un arto si disegna sull'area del suo lato (`findingFitsArea`). Le
// sagome sono `aria-hidden`: la via da tastiera e lettore di schermo è `RegionList`, sempre accanto. Con
// "Confronta con" si aggiungono due sagome piccole, solo da guardare, con le disfunzioni dell'altra visita.
//
// Contrasto (calcolato dai token di globals.css con la formula WCAG, componendo l'alfa sullo sfondo, e misurato
// sui pixel): il testo è `foreground` sui livelli 0-2 (almeno 7,3:1 in chiaro e 4,65:1 in scuro) e
// `primary-foreground` sul livello 3 (5,08:1 in chiaro, 7,92:1 in scuro).

const TITLE = "Disfunzioni somatiche (TART)";
const VIEWS: readonly BodyView[] = ["anteriore", "posteriore"];
const SMALL_SCALE = 0.5;

const AREA_FILL: Record<SeverityLevel, string> = {
  0: "fill-transparent",
  1: "fill-primary/25",
  2: "fill-primary/55",
  3: "fill-primary",
};
const AREA_TEXT: Record<SeverityLevel, string> = {
  0: "fill-foreground",
  1: "fill-foreground",
  2: "fill-foreground",
  3: "fill-primary-foreground",
};

// Righe del testo dentro l'area: il numero, poi «Primaria» e «da confermare». In un'area stretta (gli arti)
// «da confermare» va su due righe.
const NUMBER_LINE = 20;
const NOTE_LINE = 12;
const NOTE_SIZE = 10;
const NARROW = 80;

function notesOf(finding: BodyFinding, width: number): string[] {
  const notes: string[] = [];
  if (finding.isPrimary) notes.push(PRIMARY_TEXT);
  if (finding.copied) notes.push(...(width < NARROW ? COPIED_TEXT.split(" ") : [COPIED_TEXT]));
  return notes;
}

function Area({
  area,
  finding,
  selected,
  small,
  onSelect,
}: {
  area: BodyArea;
  finding: BodyFinding | undefined;
  selected: boolean;
  small: boolean;
  onSelect?: (region: RegionCode, side: "dx" | "sx" | null) => void;
}) {
  const level = finding ? severityLevel(finding.severity) : 0;
  const cx = area.x + area.width / 2;
  const cy = area.y + area.height / 2;
  const notes = finding && !small ? notesOf(finding, area.width) : [];
  const numberLine = small ? NUMBER_LINE * 1.4 : NUMBER_LINE;
  const top = cy - (numberLine + notes.length * NOTE_LINE) / 2;
  const strokeWidth = finding?.isPrimary ? 3.5 : finding?.copied ? 2 : 1.5;

  return (
    <g
      data-region={area.region}
      data-side={area.side ?? undefined}
      className={onSelect ? "cursor-pointer" : undefined}
      onClick={onSelect ? () => onSelect(area.region, area.side) : undefined}
    >
      {selected ? (
        <rect
          x={area.x - 3}
          y={area.y - 3}
          width={area.width + 6}
          height={area.height + 6}
          rx={11}
          className="fill-none stroke-ring"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <rect
        x={area.x}
        y={area.y}
        width={area.width}
        height={area.height}
        rx={8}
        className={cn(AREA_FILL[level], finding?.isPrimary || finding?.copied ? "stroke-foreground" : "stroke-primary")}
        strokeWidth={strokeWidth}
        strokeDasharray={finding?.copied ? "6 4" : undefined}
        vectorEffect="non-scaling-stroke"
      />
      {finding ? (
        <text textAnchor="middle" className={cn("pointer-events-none select-none", AREA_TEXT[level])}>
          <tspan x={cx} y={top + numberLine / 2} dominantBaseline="central" fontSize={small ? 28 : 18} fontWeight={700}>
            {finding.severity}
          </tspan>
          {notes.map((note, i) => (
            <tspan
              key={`${note}-${i}`}
              x={cx}
              y={top + numberLine + NOTE_LINE * i + NOTE_LINE / 2}
              dominantBaseline="central"
              fontSize={NOTE_SIZE}
              fontWeight={600}
            >
              {note}
            </tspan>
          ))}
        </text>
      ) : null}
    </g>
  );
}

function Figure({
  view,
  findings,
  selected,
  selectedSide = null,
  small,
  fit = false,
  onSelect,
}: {
  view: BodyView;
  findings: ReadonlyMap<RegionCode, BodyFinding>;
  selected: RegionCode | null;
  selectedSide?: "dx" | "sx" | null;
  small: boolean;
  /** Da lg la sagoma prende la larghezza che le resta (fino a 288 px), con le proporzioni del viewBox. */
  fit?: boolean;
  onSelect?: (region: RegionCode, side: "dx" | "sx" | null) => void;
}) {
  const scale = small ? SMALL_SCALE : BODY_SCALE;
  const left = LEFT_SIDE[view];
  const right = left === "dx" ? "sx" : "dx";
  const sideSize = small ? 24 : 12;
  return (
    <div className={cn("flex flex-col items-center gap-1", fit && "lg:min-w-0 lg:flex-1")} data-view={view}>
      <svg
        viewBox={`0 0 ${BODY_VIEWBOX.width} ${BODY_VIEWBOX.height}`}
        width={BODY_VIEWBOX.width * scale}
        height={BODY_VIEWBOX.height * scale}
        className={cn("shrink-0", fit && "lg:h-auto lg:w-full lg:max-w-[288px]")}
      >
        <path d={SILHOUETTE[view]} className="fill-muted stroke-border" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <text x={small ? 22 : 16} y={small ? 28 : 20} textAnchor="middle" fontSize={sideSize} className="fill-muted-foreground">
          {left}
        </text>
        <text
          x={BODY_VIEWBOX.width - (small ? 22 : 16)}
          y={small ? 28 : 20}
          textAnchor="middle"
          fontSize={sideSize}
          className="fill-muted-foreground"
        >
          {right}
        </text>
        {BODY_AREAS.filter((a) => a.view === view).map((area) => {
          const finding = findings.get(area.region);
          return (
            <Area
              key={`${area.region}-${area.side ?? "unico"}`}
              area={area}
              finding={finding && findingFitsArea(finding, area) ? finding : undefined}
              selected={selected === area.region && (area.side === null || selectedSide === null || area.side === selectedSide)}
              small={small}
              onSelect={onSelect}
            />
          );
        })}
      </svg>
      <span className="text-xs text-muted-foreground">{VIEW_LABEL[view]}</span>
    </div>
  );
}

export function BodyChart({
  findings,
  selected,
  selectedSide = null,
  onSelect,
  compare = null,
  fit = false,
}: {
  findings: readonly BodyFinding[];
  selected: RegionCode | null;
  /** Il lato della regione scelta, per un arto: il contorno va solo sulla sua area; null le segna tutte e due. */
  selectedSide?: "dx" | "sx" | null;
  onSelect: (region: RegionCode, side: "dx" | "sx" | null) => void;
  compare?: { label: string; findings: readonly BodyFinding[] } | null;
  /**
   * Da lg le due sagome grandi stanno nella colonna che hanno, senza andare a capo (l'editor della visita le mette
   * accanto all'elenco): sotto i 288 px il testo nelle aree scende sotto i 12 px, e l'elenco ripete tutto a misura piena.
   */
  fit?: boolean;
}) {
  const today = new Map(findings.map((f) => [f.region, f]));
  const other = compare ? new Map(compare.findings.map((f) => [f.region, f])) : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h3 className="text-sm font-medium">
        {TITLE}
      </h3>
      <div aria-hidden="true" className="flex flex-wrap items-start gap-6">
        <div className={cn("flex flex-wrap gap-2", fit && "lg:w-full lg:flex-nowrap")}>
          {VIEWS.map((view) => (
            <Figure
              key={view}
              view={view}
              findings={today}
              selected={selected}
              selectedSide={selectedSide}
              small={false}
              fit={fit}
              onSelect={onSelect}
            />
          ))}
        </div>
        {compare && other ? (
          <div className="flex flex-col gap-2" data-compare="">
            <span className="text-sm text-muted-foreground">{`Confronto con ${compare.label}`}</span>
            <div className="flex gap-2">
              {VIEWS.map((view) => (
                <Figure key={view} view={view} findings={other} selected={null} small />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
