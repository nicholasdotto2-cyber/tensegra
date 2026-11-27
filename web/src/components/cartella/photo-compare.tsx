"use client";

import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VIEW_LABEL } from "@/lib/clinical/labels";
import { photoAltTexts, VIEW_CODES } from "@/lib/files/photo-views";
import { cn } from "@/lib/utils";
import type { PhotoRow } from "@/server/domain/attachments/queries";

// Il confronto di due foto della stessa vista: coppia predefinita la prima e
// l'ultima della vista, affiancate o sovrapposte con il cursore «Opacità», e «Linea a piombo» e «Griglia»
// (terzi) che si accendono sopra le foto. Con una sola foto della vista dice cosa manca.

const NEED_SECOND = "Serve una seconda foto della stessa vista.";
const DEFAULT_RATIO = "2 / 3";

type Layout = "affiancate" | "sovrapposte";

const LAYOUTS: readonly { code: Layout; label: string }[] = [
  { code: "affiancate", label: "Affiancate" },
  { code: "sovrapposte", label: "Sovrapposte" },
];

const photoText = (photo: PhotoRow): string =>
  photo.caption === null ? photo.dateText : `${photo.dateText}, ${photo.caption}`;

/** La prima vista con almeno due foto; altrimenti quella della foto più recente. */
function defaultView(photos: PhotoRow[], views: string[]): string {
  const withPair = views.find((view) => photos.filter((p) => p.view === view).length >= 2);
  return withPair ?? photos[0]?.view ?? "";
}

/** Linea a piombo (verticale al centro) e griglia dei terzi, sopra la foto; solo un aiuto per l'occhio. */
function Guides({ plumb, grid }: { plumb: boolean; grid: boolean }) {
  const line = "absolute bg-primary shadow-[0_0_0_1px_rgb(255_255_255/0.7)]";
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      {plumb ? <div data-guide="plumb" className={cn(line, "inset-y-0 left-1/2 w-0.5 -translate-x-1/2")} /> : null}
      {grid ? (
        <div data-guide="grid" className="absolute inset-0">
          <div className={cn(line, "inset-y-0 left-1/3 w-px")} />
          <div className={cn(line, "inset-y-0 left-2/3 w-px")} />
          <div className={cn(line, "inset-x-0 top-1/3 h-px")} />
          <div className={cn(line, "inset-x-0 top-2/3 h-px")} />
        </div>
      ) : null}
    </div>
  );
}

function Img({ alt, photo, opacity }: { alt: string; photo: PhotoRow; opacity?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- file privato servito con il cookie di sessione: next/image non lo carica
    <img
      src={`/api/files/${photo.fileId}`}
      alt={alt}
      width={photo.widthPx ?? undefined}
      height={photo.heightPx ?? undefined}
      style={opacity === undefined ? undefined : { opacity }}
      className="absolute inset-0 size-full object-contain"
    />
  );
}

const ratioOf = (photo: PhotoRow): string =>
  photo.widthPx !== null && photo.heightPx !== null ? `${photo.widthPx} / ${photo.heightPx}` : DEFAULT_RATIO;

function OptionSelect({
  id,
  label,
  items,
  value,
  onChange,
}: {
  id: string;
  label: string;
  items: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger id={id} className="min-w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Pair({
  first,
  second,
  alts,
  layout,
  opacity,
  plumb,
  grid,
}: {
  first: PhotoRow;
  second: PhotoRow;
  alts: Map<string, string>;
  layout: Layout;
  opacity: number;
  plumb: boolean;
  grid: boolean;
}) {
  if (layout === "sovrapposte") {
    return (
      <figure className="flex max-w-md flex-col gap-1">
        <div className="relative w-full overflow-hidden rounded-lg bg-muted" style={{ aspectRatio: ratioOf(first) }}>
          <Img photo={first} alt={alts.get(first.id) ?? ""} />
          <Img photo={second} alt={alts.get(second.id) ?? ""} opacity={opacity / 100} />
          <Guides plumb={plumb} grid={grid} />
        </div>
        <figcaption className="text-sm text-muted-foreground">
          {`${photoText(first)} sotto, ${photoText(second)} sopra`}
        </figcaption>
      </figure>
    );
  }
  return (
    <div className="grid max-w-3xl grid-cols-2 gap-4">
      {[first, second].map((photo, index) => (
        <figure key={`${index}-${photo.id}`} className="flex flex-col gap-1">
          <div className="relative w-full overflow-hidden rounded-lg bg-muted" style={{ aspectRatio: ratioOf(first) }}>
            <Img photo={photo} alt={alts.get(photo.id) ?? ""} />
            <Guides plumb={plumb} grid={grid} />
          </div>
          <figcaption className="text-sm text-muted-foreground">{photoText(photo)}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export function PhotoCompare({ photos }: { photos: PhotoRow[] }) {
  const baseId = useId();
  const [chosenView, setChosenView] = useState<string | null>(null);
  const [firstId, setFirstId] = useState<string | null>(null);
  const [secondId, setSecondId] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>("affiancate");
  const [opacity, setOpacity] = useState(50);
  const [plumb, setPlumb] = useState(false);
  const [grid, setGrid] = useState(false);

  const views = VIEW_CODES.filter((view) => photos.some((p) => p.view === view));
  const view = chosenView !== null && (views as string[]).includes(chosenView) ? chosenView : defaultView(photos, views);
  // Dalla più vecchia alla più recente: le foto arrivano dalla più recente.
  const ofView = photos.filter((photo) => photo.view === view).reverse();
  const oldest = ofView[0];
  const newest = ofView.at(-1);
  // Una foto tolta nel frattempo non è più nell'elenco: la scelta torna alla coppia predefinita.
  const first = ofView.find((p) => p.id === firstId) ?? oldest;
  const second = ofView.find((p) => p.id === secondId) ?? newest;
  const pair = ofView.length >= 2 && first !== undefined && second !== undefined ? { first, second } : null;

  const viewItems = views.map((code) => ({ value: code, label: VIEW_LABEL[code] }));
  const photoItems = ofView.map((photo) => ({ value: photo.id, label: photoText(photo) }));
  const headingId = `${baseId}-titolo`;
  const alts = photoAltTexts(photos);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 rounded-xl border p-4">
      <h3 id={headingId} className="text-sm font-medium">
        Confronto
      </h3>

      <div className="flex flex-wrap gap-4">
        <OptionSelect
          id={`${baseId}-vista`}
          label="Vista"
          items={viewItems}
          value={view}
          onChange={(next) => {
            setChosenView(next);
            setFirstId(null);
            setSecondId(null);
          }}
        />
        {pair === null ? null : (
          <>
            <OptionSelect
              id={`${baseId}-prima`}
              label="Prima foto"
              items={photoItems}
              value={pair.first.id}
              onChange={setFirstId}
            />
            <OptionSelect
              id={`${baseId}-seconda`}
              label="Seconda foto"
              items={photoItems}
              value={pair.second.id}
              onChange={setSecondId}
            />
          </>
        )}
      </div>

      {pair === null ? (
        <p className="text-muted-foreground">{NEED_SECOND}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div role="group" aria-label="Disposizione" className="flex gap-2">
              {LAYOUTS.map((item) => (
                <Button
                  key={item.code}
                  type="button"
                  size="sm"
                  variant={layout === item.code ? "default" : "outline"}
                  aria-pressed={layout === item.code}
                  onClick={() => setLayout(item.code)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            {layout === "sovrapposte" ? (
              <div className="flex items-center gap-2">
                <Label htmlFor={`${baseId}-opacita`}>Opacità</Label>
                <input
                  id={`${baseId}-opacita`}
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={opacity}
                  onChange={(event) => setOpacity(Number(event.target.value))}
                  aria-valuetext={`${opacity} per cento`}
                  className="h-6 w-40 accent-primary"
                />
                <span className="w-12 text-sm text-muted-foreground tabular-nums">{`${opacity} %`}</span>
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={plumb ? "default" : "outline"}
                aria-pressed={plumb}
                onClick={() => setPlumb((on) => !on)}
              >
                Linea a piombo
              </Button>
              <Button
                type="button"
                size="sm"
                variant={grid ? "default" : "outline"}
                aria-pressed={grid}
                onClick={() => setGrid((on) => !on)}
              >
                Griglia
              </Button>
            </div>
          </div>
          <Pair first={pair.first} second={pair.second} alts={alts} layout={layout} opacity={opacity} plumb={plumb} grid={grid} />
        </>
      )}
    </section>
  );
}
