"use client";

import { useEffect, useId, useRef } from "react";

import { DayColumn } from "@/components/agenda/day-column";
import { type AgendaBlock, blockHeight, blockTop } from "@/lib/agenda/grid";
import type { Band } from "@/lib/agenda/slots";
import { minutesLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

// La griglia del giorno o della settimana: le ore a sinistra, un'intestazione
// "gio 22 · 5" per giorno e una colonna per giorno. La griglia scorre da sola, con intestazione e ore
// ferme; all'apertura porta l'ora corrente al centro. Le callback arrivano da `AgendaView`:
// la pagina server non passa funzioni.

const HOUR = 60;
/** Altezza dell'intestazione dei giorni e larghezza della colonna delle ore, in px. */
const HEADER_PX = 48;
const GUTTER_PX = 56;

export function WeekGrid({
  days,
  window,
  nowMin,
  todayDay,
  onCellClick,
  onBlockClick,
}: {
  days: { day: string; header: string; bands: readonly Band[]; blocks: AgendaBlock[] }[];
  window: { startMin: number; endMin: number };
  nowMin: number | null;
  todayDay: string;
  onCellClick?: (day: string, startMin: number) => void;
  onBlockClick?: (id: string) => void;
}) {
  const idPrefix = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledToNow = useRef(false);

  const nowInWindow = nowMin !== null && nowMin >= window.startMin && nowMin <= window.endMin;
  const showsToday = days.some((d) => d.day === todayDay);
  const nowTop = nowInWindow && showsToday ? blockTop(nowMin, window.startMin) : null;

  // Una volta sola, alla prima apertura con oggi a schermo: dopo, chi scorre resta dove ha scelto.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scrolledToNow.current || !scroller || nowTop === null) return;
    scrolledToNow.current = true;
    scroller.scrollTop = Math.max(0, HEADER_PX + nowTop - scroller.clientHeight / 2);
  }, [nowTop]);

  const hours: number[] = [];
  for (let min = Math.ceil(window.startMin / HOUR) * HOUR; min < window.endMin; min += HOUR) hours.push(min);
  const height = blockHeight(window.startMin, window.endMin);
  const week = days.length > 1;

  return (
    <div ref={scrollRef} className="relative min-h-[20rem] flex-1 overflow-auto rounded-lg border bg-background">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `${GUTTER_PX}px repeat(${days.length}, ${week ? "minmax(7rem, 1fr)" : "minmax(0, 1fr)"})`,
        }}
      >
        <div className="sticky top-0 left-0 z-20 border-b bg-background" style={{ height: HEADER_PX }} />
        {days.map(({ day, header }) => {
          const today = day === todayDay;
          return (
            <div
              key={day}
              id={`${idPrefix}-${day}`}
              aria-current={today ? "date" : undefined}
              className={cn(
                "sticky top-0 z-10 flex items-center justify-center border-b border-l bg-background px-[6px] text-sm font-medium tabular-nums",
                today && "text-primary",
              )}
              style={{ height: HEADER_PX }}
            >
              <time dateTime={day}>{header}</time>
            </div>
          );
        })}

        <div aria-hidden="true" className="sticky left-0 z-10 bg-background" style={{ height }}>
          {hours.map((min) => (
            <span
              key={min}
              className="absolute right-[8px] text-xs leading-[16px] text-muted-foreground tabular-nums"
              style={{ top: blockTop(min, window.startMin) + 2 }}
            >
              {minutesLabel(min)}
            </span>
          ))}
        </div>
        {days.map(({ day, bands, blocks }) => (
          <DayColumn
            key={day}
            day={day}
            labelledBy={`${idPrefix}-${day}`}
            bands={bands}
            blocks={blocks}
            window={window}
            nowMin={day === todayDay && nowInWindow ? nowMin : null}
            onCellClick={onCellClick}
            onBlockClick={onBlockClick}
          />
        ))}
      </div>
    </div>
  );
}
