"use client";

import { useId, useState } from "react";

import { ConsentCollectDialog } from "@/components/consensi/collect-dialog";
import { BlockCard } from "@/components/oggi/block-card";
import { BlockError } from "@/components/oggi/block-error";
import { Button } from "@/components/ui/button";
import { firstLast } from "@/lib/format";
import type { Settled } from "@/server/db/settle";
import type { MissingConsentRow } from "@/server/domain/consents/queries";
import type { ConsentTarget } from "@/server/domain/consents/schemas";

// Blocco 2 di Oggi: chi ha un appuntamento nei prossimi 7 giorni, o una
// seduta fatta, senza il consenso che serve. «Raccogli» apre il dialogo di raccolta sul
// bersaglio che la riga porta dal server: prima il consenso al trattamento dell'appuntamento, poi, riletta la
// riga dopo la firma, l'informativa. Un modulo alla volta: mai due documenti firmati con una firma sola.

const TITLE = "Consensi mancanti";

function MissingRow({ row, onCollect }: { row: MissingConsentRow; onCollect: (target: ConsentTarget) => void }) {
  const id = useId();
  const name = row.ageText === null ? firstLast(row) : `${firstLast(row)}, ${row.ageText}`;
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span id={`${id}-nome`} className="font-medium">
          {name}
        </span>
        <span id={`${id}-manca`} className="text-sm text-muted-foreground">
          {row.missingText}
        </span>
        <span className="text-sm text-muted-foreground">{row.whenText}</span>
        {row.targetProblem === null ? null : (
          <span id={`${id}-motivo`} className="text-sm text-muted-foreground">
            {row.targetProblem}
          </span>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={row.targetProblem !== null}
        aria-describedby={[`${id}-nome`, `${id}-manca`, row.targetProblem === null ? null : `${id}-motivo`]
          .filter(Boolean)
          .join(" ")}
        onClick={() => onCollect(row.target)}
      >
        Raccogli
      </Button>
    </li>
  );
}

export function ConsentsBlock({ state }: { state: Settled<MissingConsentRow[]> }) {
  const [target, setTarget] = useState<ConsentTarget | null>(null);

  if (!state.ok) {
    return (
      <BlockCard title={TITLE} count={null}>
        <BlockError />
      </BlockCard>
    );
  }

  const rows = state.value;
  return (
    <BlockCard title={TITLE} count={rows.length}>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">Nessun consenso da raccogliere nei prossimi 7 giorni.</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <MissingRow key={row.patientId} row={row} onCollect={setTarget} />
          ))}
        </ul>
      )}
      {/* Salvato il consenso, la pagina si rilegge (revalidazione dell'azione) e la riga dice cosa manca ancora. */}
      <ConsentCollectDialog target={target} onClose={() => setTarget(null)} />
    </BlockCard>
  );
}
