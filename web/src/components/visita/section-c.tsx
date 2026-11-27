"use client";

import { useId, useState } from "react";

import { BodyChart } from "@/components/cartella/body-chart";
import { PhotoUploadDialog } from "@/components/cartella/photo-upload-dialog";
import { RegionList } from "@/components/cartella/region-list";
import { Button } from "@/components/ui/button";
import type { BodyFinding } from "@/lib/clinical/body-map";
import type { RegionCode } from "@/lib/clinical/catalog";

import { ChoiceGroup } from "./choice-group";
import { revealAnchor } from "./editor-section";
import { NeuroExam } from "./neuro-exam";
import { useOpenRegionRequests } from "./open-region";
import { RegionPanel } from "./region-panel";
import { TestsBlock } from "./tests-block";
import type { VisitSectionProps } from "./visit-editor";
import { VisitTextField } from "./visit-text-field";

// La sezione C dell'editor della visita, «Valutazione»: il body chart
// "Disfunzioni somatiche (TART)" con accanto l'elenco delle 10 regioni, la via da tastiera e da lettore di schermo
// (le aree della sagoma sono `aria-hidden`), e il pannello della regione scelta.
// Da lg la sagoma e l'elenco (240 px) sono affiancati senza andare a capo, la sagoma si stringe
// alla sua parte (`fit`), e il pannello si apre sotto, entra nella vista e prende il focus; sotto lg le parti vanno a
// capo a misura piena. Un arto toccato sulla sagoma propone il lato; il contorno della scelta segna solo l'area del
// lato salvato o proposto. "Confronta con" mostra la prima visita del ciclo o la precedente accanto alla
// sagoma e la variazione per regione nell'elenco. Sotto, i test (`TestsBlock`), l'esame neurologico compatto quando
// c'è un'irradiazione o il gruppo cervicale è aperto (`NeuroExam`), «Osservazione» e «Ipotesi di lavoro» e la «Foto
// del giorno» (il dialogo di "Carica foto", legato alla visita).

type CompareKey = "first" | "previous";
const COMPARE_KEYS: readonly CompareKey[] = ["first", "previous"];

/** L'id del pulsante di una regione nell'elenco: lì torna il focus quando il pannello si chiude. */
const regionButtonId = (region: RegionCode): string => `regione-${region}`;

const NOTE_MAX = 1000;

/** «Osservazione» e «Ipotesi di lavoro»: due testi della visita (`campi`), con il salvataggio dei testi dell'editor. */
function Notes({ editor, mode, op }: VisitSectionProps) {
  const { fields } = editor.visit;
  const disabled = mode === "lettura";
  return (
    <div className="flex flex-col gap-4">
      <VisitTextField
        id="campo-osservazione"
        label="Osservazione"
        optional
        multiline
        maxLength={NOTE_MAX}
        value={fields.observationNote}
        disabled={disabled}
        onSave={(value, options) => op({ op: "campi", values: { observationNote: value } }, options)}
      />
      <VisitTextField
        id="campo-ipotesi"
        label="Ipotesi di lavoro"
        optional
        multiline
        maxLength={NOTE_MAX}
        value={fields.workingHypothesis}
        disabled={disabled}
        onSave={(value, options) => op({ op: "campi", values: { workingHypothesis: value } }, options)}
      />
    </div>
  );
}

/** «Foto del giorno»: "Carica foto" apre il dialogo del paziente con la visita, la data della visita come data predefinita. */
function DayPhoto({ editor, mode }: Pick<VisitSectionProps, "editor" | "mode">) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-base font-medium">
        Foto del giorno
      </h3>
      <Button type="button" variant="outline" className="self-start" disabled={mode === "lettura"} onClick={() => setOpen(true)}>
        Carica foto
      </Button>
      <PhotoUploadDialog
        patientId={editor.visit.patientId}
        today={editor.visit.visitDate}
        visitId={editor.visit.id}
        open={open}
        onOpenChange={setOpen}
      />
    </section>
  );
}

export function SectionC(props: VisitSectionProps) {
  const { editor, mode, op } = props;
  // `opened` cambia a ogni scelta: il pannello rinasce e porta il focus sulla severità anche sulla stessa regione.
  const [open, setOpen] = useState<{ region: RegionCode; side: "dx" | "sx" | null; opened: number } | null>(null);
  const choose = (region: RegionCode, side: "dx" | "sx" | null) =>
    setOpen((current) => ({ region, side, opened: (current?.opened ?? 0) + 1 }));
  const [compareWith, setCompareWith] = useState<CompareKey | null>(null);
  // «Apri la regione» della sezione D: la sezione si apre e il pannello della regione prende il focus.
  useOpenRegionRequests((region) => {
    revealAnchor("sezione-c");
    choose(region, null);
  });

  const findings: BodyFinding[] = editor.findings.map((f) => ({
    region: f.region,
    severity: f.severity,
    side: f.side,
    isPrimary: f.isPrimary,
    copied: f.copied,
  }));
  const compareItems = COMPARE_KEYS.flatMap((key) => {
    const set = editor.compare[key];
    return set === null ? [] : [{ value: key, label: set.label }];
  });
  const compared = compareWith === null ? null : editor.compare[compareWith];
  const compareFindings: BodyFinding[] | null =
    compared === null ? null : compared.findings.map((f) => ({ ...f, copied: false }));

  // Il lato del contorno: quello salvato se è dx o sx, altrimenti quello toccato (regione senza riga o arto senza lato).
  const saved = open === null ? undefined : editor.findings.find((f) => f.region === open.region);
  const savedSide = saved?.side === "dx" || saved?.side === "sx" ? saved.side : null;
  const selectedSide = open === null ? null : saved === undefined || saved.side === null ? open.side : savedSide;

  const close = () => {
    if (open === null) return;
    const region = open.region;
    setOpen(null);
    // Il focus torna sul pulsante della regione nell'elenco, che c'è sempre (focus restituito).
    document.getElementById(regionButtonId(region))?.focus();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_240px]">
        <BodyChart
          fit
          findings={findings}
          selected={open?.region ?? null}
          selectedSide={selectedSide}
          onSelect={choose}
          compare={compared === null || compareFindings === null ? null : { label: compared.label, findings: compareFindings }}
        />
        <div className="flex min-w-60 flex-1 basis-60 flex-col gap-4 lg:min-w-0">
          <RegionList
            findings={findings}
            selected={open?.region ?? null}
            onSelect={(region) => choose(region, null)}
            compare={compareFindings}
            buttonId={regionButtonId}
          />
          {compareItems.length === 0 ? null : (
            <ChoiceGroup
              id="confronta-con"
              label="Confronta con"
              items={compareItems}
              value={compareWith}
              onChange={setCompareWith}
              onClear={() => setCompareWith(null)}
            />
          )}
        </div>
      </div>
      {open === null ? null : (
        <RegionPanel
          key={open.opened}
          region={open.region}
          side={open.side}
          editor={editor}
          op={op}
          readOnly={mode === "lettura"}
          onClose={close}
        />
      )}
      <TestsBlock {...props} />
      <NeuroExam {...props} />
      <Notes {...props} />
      <DayPhoto editor={editor} mode={mode} />
    </div>
  );
}
