import { ReminderRow } from "@/components/messaggi/reminder-row";
import { BlockCard } from "@/components/oggi/block-card";
import { BlockError } from "@/components/oggi/block-error";
import { datetimeAttr, timeOf } from "@/lib/format";
import type { Settled } from "@/server/db/settle";
import type { ReminderBlock } from "@/server/domain/appointments/queries";

// Blocco 4 di Oggi: gli appuntamenti del primo giorno aperto dopo oggi, con
// ora, destinatario e, sotto, stato e azioni del promemoria.

// Senza il giorno (blocco non caricato) il titolo non può dire la data.
const FALLBACK_TITLE = "Promemoria per domani";

export function RemindersBlock({ state }: { state: Settled<ReminderBlock> }) {
  if (!state.ok) {
    return (
      <BlockCard title={FALLBACK_TITLE} count={null}>
        <BlockError />
      </BlockCard>
    );
  }

  const { title, rows } = state.value;
  return (
    <BlockCard title={title} count={rows.length}>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">Nessun appuntamento domani.</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li
              key={row.appointmentId}
              className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0"
            >
              <time dateTime={datetimeAttr(row.startsAt)} className="text-sm font-medium tabular-nums">
                {timeOf(row.startsAt)}
              </time>
              <span>{row.recipientText}</span>
              <div className="col-start-2 min-w-0">
                <ReminderRow value={row} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </BlockCard>
  );
}
