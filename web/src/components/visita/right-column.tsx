"use client";

import { OctagonAlert, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { type MouseEvent, type ReactNode, useId, useState } from "react";

import { createReferralAction } from "@/app/(app)/pazienti/[id]/actions";
import { visitEditorAction } from "@/app/(app)/pazienti/[id]/visite/[visitId]/actions";
import { PainScale } from "@/components/cartella/pain-scale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ClosingItem } from "@/lib/clinical/visit-rules";
import { cn } from "@/lib/utils";
import type { VisitEditor } from "@/server/domain/visits/editor";

import { revealAnchor } from "./editor-section";
import type { VisitSectionProps } from "./visit-editor";

// La colonna destra fissa dell'editor della visita: il dolore
// 0-10 a inizio e a fine seduta (quello a fine seduta sta solo qui), gli avvisi (avviso clinico, badge del paziente
// e avvisi gialli che non bloccano la chiusura), il riquadro "Valuta il rinvio al medico" quando un promemoria
// scatta (in cima alla colonna con una red flag urgente o in emergenza) e "Per chiudere" con le voci che bloccano
// la chiusura. Ogni voce porta al suo campo; il dolore passa da `op`, come ogni altra modifica della visita, e il
// valore scelto si vede subito, finché non arriva la vista nuova (se il server lo rifiuta torna il suo valore).
// «Prepara rinvio» passa dalla stessa coda: parte dopo le modifiche in attesa, così la lettera le vede.

const PAIN_TITLE = "Dolore 0-10 (NRS)";
const PAIN_START = "Dolore 0-10 (NRS) a inizio seduta";
const PAIN_END = "Dolore 0-10 (NRS) a fine seduta";

function Box({ title, tone = "default", children }: { title: string; tone?: "default" | "urgent"; children: ReactNode }) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm text-card-foreground",
        tone === "urgent" && "border-destructive",
      )}
    >
      <h2 id={headingId} className="text-base font-medium">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Il link di una voce di "Per chiudere" o di un avviso: apre la sezione che contiene il campo e ci porta il focus. */
function AnchorLink({ item, className }: { item: ClosingItem; className?: string }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Senza il campo nella pagina resta il comportamento del link.
    if (revealAnchor(item.anchor)) event.preventDefault();
  };
  return (
    <a href={`#${item.anchor}`} onClick={onClick} className={cn("underline underline-offset-4", className)}>
      {item.text}
    </a>
  );
}

function Warnings({ editor, mode }: Pick<VisitSectionProps, "editor" | "mode">) {
  const { clinicalAlert, badges } = editor.patient;
  // Gli avvisi gialli parlano della chiusura: una visita chiusa non li mostra.
  const warnings = mode === "lettura" ? [] : editor.closing.warnings;
  if (clinicalAlert === null && badges.length === 0 && warnings.length === 0) return null;
  return (
    <Box title="Avvisi">
      {clinicalAlert === null ? null : (
        <p role="note" className="flex items-start gap-2 rounded-lg bg-warning px-2.5 py-2 text-warning-foreground">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {clinicalAlert}
        </p>
      )}
      {badges.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2" aria-label="Stato del paziente">
          {badges.map((badge) => (
            <li key={badge}>
              <Badge variant="secondary">{badge}</Badge>
            </li>
          ))}
        </ul>
      )}
      {warnings.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {warnings.map((item) => (
            <li
              key={`${item.code}-${item.anchor}`}
              className="flex items-start gap-2 rounded-lg bg-warning px-2.5 py-2 text-warning-foreground"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <AnchorLink item={item} />
            </li>
          ))}
        </ul>
      )}
    </Box>
  );
}

function ClosingList({ editor }: Pick<VisitSectionProps, "editor">) {
  const { blocking } = editor.closing;
  if (blocking.length === 0) return null;
  return (
    <Box title="Per chiudere">
      <ul className="flex flex-col gap-2">
        {blocking.map((item) => (
          <li key={`${item.code}-${item.anchor}`} className="flex items-start gap-2">
            <OctagonAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
            <AnchorLink item={item} />
          </li>
        ))}
      </ul>
    </Box>
  );
}

/**
 * «Prepara rinvio» (sezione E): crea il rinvio della visita dalla coda, dopo le modifiche in attesa, e
 * apre la lettera. `pending` tiene fermo il pulsante finché non arriva una risposta.
 */
export function usePrepareReferral({ editor, run }: Pick<VisitSectionProps, "editor" | "run">) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const prepare = () => {
    setPending(true);
    const { patientId, id: visitId } = editor.visit;
    // Il rinvio nasce una volta sola: se dopo la creazione la rilettura non arriva, «Riprova» rilegge e basta.
    let created: { id: string; patientId: string } | null = null;
    run(
      async () => {
        if (created === null) {
          // Motivo e urgenza li prende il comando dal promemoria più grave della visita.
          const result = await createReferralAction({ patientId, visitId });
          if (!result.ok) return result;
          created = result.data;
          router.push(`/pazienti/${created.patientId}/rinvii/${created.id}`);
        }
        return visitEditorAction(visitId);
      },
      // Il messaggio del rifiuto lo mostra lo stato del salvataggio; il pulsante torna attivo.
      { onRefused: () => setPending(false) },
    );
  };
  return { prepare, pending };
}

/** "Valuta il rinvio al medico": non si chiude e si ricalcola a ogni salvataggio. */
function ReferralPrompts({ editor, run, urgent }: Pick<VisitSectionProps, "editor" | "run"> & { urgent: boolean }) {
  const { prepare, pending } = usePrepareReferral({ editor, run });
  return (
    <Box title="Valuta il rinvio al medico" tone={urgent ? "urgent" : "default"}>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {editor.prompts.map((prompt, index) => (
          <li key={`${prompt.code}-${index}`}>{prompt.text}</li>
        ))}
      </ul>
      <div>
        <Button type="button" variant={urgent ? "destructive" : "outline"} size="sm" disabled={pending} onClick={prepare}>
          Prepara rinvio
        </Button>
      </div>
    </Box>
  );
}

type PainField = "nprsPre" | "nprsPost";

/** Un valore scelto e non ancora nella vista: vale solo finché la vista è quella del momento della scelta. */
interface PainDraft {
  value: number | null;
  since: VisitEditor;
}

export function RightColumn({ editor, mode, op, run }: VisitSectionProps) {
  const readOnly = mode === "lettura";
  const { fields } = editor.visit;
  const painId = useId();
  const [drafts, setDrafts] = useState<Partial<Record<PainField, PainDraft>>>({});
  const urgent = editor.prompts.some((p) => p.urgency === "urgente" || p.urgency === "emergenza");
  const referral = editor.prompts.length === 0 ? null : <ReferralPrompts editor={editor} run={run} urgent={urgent} />;

  // Una vista nuova (la risposta, o la rilettura dopo un rifiuto) rende vecchia la scelta: vale il server.
  const painValue = (field: PainField): number | null => {
    const draft = drafts[field];
    return draft !== undefined && draft.since === editor ? draft.value : fields[field];
  };
  const choosePain = (field: PainField, value: number | null) => {
    const draft: PainDraft = { value, since: editor };
    setDrafts((current) => ({ ...current, [field]: draft }));
    op(
      { op: "campi", values: { [field]: value } },
      {
        onRefused: () =>
          setDrafts((current) => (current[field] === draft ? { ...current, [field]: undefined } : current)),
      },
    );
  };

  return (
    <aside className="flex min-w-0 flex-col gap-4 self-start lg:sticky lg:top-4 lg:max-h-[calc(100svh-2rem)] lg:overflow-y-auto">
      {urgent ? referral : null}
      <section aria-labelledby={painId} className="flex flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground">
        <h2 id={painId} className="text-base font-medium">
          {PAIN_TITLE}
        </h2>
        <PainScale
          id="campo-dolore-inizio"
          label={PAIN_START}
          value={painValue("nprsPre")}
          disabled={readOnly}
          onChange={(value) => choosePain("nprsPre", value)}
        />
        <PainScale
          id="campo-dolore-fine"
          label={PAIN_END}
          value={painValue("nprsPost")}
          disabled={readOnly}
          onChange={(value) => choosePain("nprsPost", value)}
        />
      </section>
      <Warnings editor={editor} mode={mode} />
      {urgent ? null : referral}
      {readOnly ? null : <ClosingList editor={editor} />}
    </aside>
  );
}
