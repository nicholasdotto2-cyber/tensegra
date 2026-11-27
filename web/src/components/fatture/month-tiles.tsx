import { dayField, money } from "@/lib/format";
import type { MonthTiles as Tiles } from "@/server/domain/invoices/queries";

export function MonthTiles({ tiles }: { tiles: Tiles }) {
  return <div className="space-y-2">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {([["Emesso", tiles.issuedCents], ["Incassato", tiles.collectedCents], ["Da incassare", tiles.toCollectCents]] as const).map(([label, cents]) => (
        <section key={label} aria-label={label} className="rounded-xl border bg-card p-4">
          <h2 className="text-sm text-muted-foreground">{label}</h2>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{money(cents)}</p>
        </section>
      ))}
      <section aria-label="Bolli del trimestre" className="rounded-xl border bg-card p-4">
        <h2 className="text-sm text-muted-foreground">Bolli del trimestre</h2>
        <p className="mt-2 text-2xl font-semibold tabular-nums">{money(tiles.stamps.cents)}</p>
        <p className="text-sm">{tiles.stamps.count} bolli, trimestre {tiles.stamps.quarter}/{tiles.stamps.year}</p>
        <p className="mt-1 text-sm">Prossima scadenza: {dayField(tiles.stamps.deadline)}</p>
      </section>
    </div>
    <p className="text-sm text-muted-foreground">{"Trimestre stimato con la data della fattura; per l'Agenzia conta la data di consegna."}</p>
  </div>;
}
