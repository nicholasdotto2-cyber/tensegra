import type { MouseEvent } from "react";

import { AppointmentBlock } from "@/components/agenda/appointment-block";
import { ClosedBand } from "@/components/agenda/closed-band";
import { NowLine } from "@/components/agenda/now-line";
import { type AgendaBlock, blockHeight, blockTop, closedBands, layoutColumns, PX_PER_HOUR, quarterAt } from "@/lib/agenda/grid";
import type { Band } from "@/lib/agenda/slots";
import { minutesLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

// La colonna di un giorno: righe delle ore, fasce chiuse, la linea dell'ora per
// oggi e i blocchi in ordine di orario, così il Tab li raggiunge in quell'ordine. Le celle vuote non
// sono nella tabulazione: un solo clic sulla colonna diventa il quarto d'ora sotto il puntatore (da
// tastiera si crea con "Nuovo appuntamento" della barra).

const HOUR = 60;

export function DayColumn({
  day,
  labelledBy,
  bands,
  blocks,
  window,
  nowMin,
  onCellClick,
  onBlockClick,
}: {
  day: string;
  /** L'id dell'intestazione del giorno, che dà il nome al gruppo dei suoi blocchi. */
  labelledBy: string;
  bands: readonly Band[];
  blocks: readonly AgendaBlock[];
  window: { startMin: number; endMin: number };
  /** I minuti di adesso se questa è la colonna di oggi e l'ora è nella finestra, altrimenti null. */
  nowMin: number | null;
  onCellClick?: (day: string, startMin: number) => void;
  onBlockClick?: (id: string) => void;
}) {
  const ordered = [...blocks].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin || (a.id < b.id ? -1 : 1));
  const columns = layoutColumns(ordered);
  // La prima riga d'ora intera dentro la finestra; poi una ogni 96 px.
  const firstHourOffset = blockTop(Math.ceil(window.startMin / HOUR) * HOUR, window.startMin);

  const handleClick = onCellClick
    ? (event: MouseEvent<HTMLDivElement>) => {
        const offset = event.clientY - event.currentTarget.getBoundingClientRect().top;
        onCellClick(day, quarterAt(offset, window.startMin));
      }
    : undefined;

  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      data-day={day}
      onClick={handleClick}
      className={cn("relative isolate border-l", onCellClick && "cursor-pointer")}
      style={{
        height: blockHeight(window.startMin, window.endMin),
        backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0 1px, transparent 1px ${PX_PER_HOUR}px)`,
        backgroundPositionY: firstHourOffset,
      }}
    >
      {closedBands(bands, window).map((band) => (
        <ClosedBand
          key={band.startMin}
          top={blockTop(band.startMin, window.startMin)}
          height={blockHeight(band.startMin, band.endMin)}
        />
      ))}
      {nowMin === null ? null : <NowLine top={blockTop(nowMin, window.startMin)} label={minutesLabel(nowMin)} />}
      {ordered.map((block) => {
        const place = columns.get(block.id) ?? { column: 0, columns: 1 };
        return (
          <AppointmentBlock
            key={block.id}
            block={block}
            top={blockTop(block.startMin, window.startMin)}
            height={blockHeight(block.startMin, block.endMin)}
            column={place.column}
            columns={place.columns}
            onClick={onBlockClick}
          />
        );
      })}
    </div>
  );
}
