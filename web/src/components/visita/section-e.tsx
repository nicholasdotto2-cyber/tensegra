"use client";

import { type ComponentProps, useId, useRef, useState } from "react";

import { cycleOpeningAction, visitEditorAction } from "@/app/(app)/pazienti/[id]/visite/[visitId]/actions";
import { NewAppointmentButton } from "@/components/agenda/appointment-dialog";
import { CycleCloseDialog } from "@/components/cartella/cycle-close-dialog";
import { MessageComposer } from "@/components/messaggi/message-composer";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Toggle } from "@/components/ui/toggle";
import { ADVICE_TEMPLATES, type AdviceTemplate } from "@/lib/clinical/catalog";
import { CHANNEL_LABEL } from "@/lib/clinical/labels";
import { ADVICE_MESSAGE_REASON } from "@/lib/messages/texts";
import type { RunOptions } from "@/lib/visits/save-queue";
import { refusalText } from "@/lib/visits/text-autosave";
import type { ActionFailure } from "@/server/actions/result";
import type { MessageSource } from "@/server/domain/messages/schemas";
import type { EditorAdvice } from "@/server/domain/visits/editor";

import { useChosen } from "./choice-group";
import { usePrepareReferral } from "./right-column";
import type { VisitSectionProps } from "./visit-editor";
import { VisitTextField } from "./visit-text-field";

// La sezione E dell'editor della visita, «Chiusura». I consigli proposti
// (`suggestedAdvice`: prima i modelli della visita copiata, poi quelli delle regioni con disfunzioni o trattate) con la
// spunta: spuntare scrive la riga di `visit_advice` (operazione `consiglio`) col testo del modello e il canale «A voce»
// già scelto; il testo si modifica e i canali sono «A voce», «Foglio stampato» e «Messaggio copiato» (almeno uno), scelti a
// mano in bozza e in rettifica. "Copia il messaggio" apre il compositore del modello `consigli`
// con i consigli da modello della visita, anche sulla visita chiusa in lettura: lì prima una conferma dice della rettifica
// che la copia scrive da sé; in rettifica non c'è, il canale si sceglie a mano. Alla prima visita del ciclo "Piano spiegato e accettato dal paziente" scrive `plan_agreed_on` =
// il giorno della visita (in bozza `cycleOpeningAction`, in rettifica l'operazione `apertura`). In fondo il prossimo
// passo: "Fissa il prossimo appuntamento", "Chiudi il ciclo" e "Prepara rinvio", che in rettifica non ci sono (la
// rettifica cambia solo la visita). Il dolore a fine seduta sta solo nella colonna destra.

const PLAN_AGREED = "Piano spiegato e accettato dal paziente";
/** I canali che l'editor sceglie; «Messaggio copiato» lo aggiunge anche la copia del messaggio. */
const CHANNELS = ["a_voce", "foglio_stampato", "messaggio_copiato"] as const;
type Channel = (typeof CHANNELS)[number];
const ADVICE_TEXT_MAX = 1000;

/** Le prestazioni e i default di "Nuovo appuntamento"; null se la pagina non li ha letti. */
export type VisitBooking = Pick<
  ComponentProps<typeof NewAppointmentButton>,
  "services" | "defaultIntervalWeeks" | "defaultExpectedSessions"
>;

/** I canali di una riga che l'operazione accetta, come testo («a_voce foglio_stampato»): un valore che si confronta. */
const channelsKey = (via: readonly string[]): string => CHANNELS.filter((c) => via.includes(c)).join(" ");
const channelsOf = (key: string): Channel[] => CHANNELS.filter((c) => key.split(" ").includes(c));

function AdviceItem({
  template,
  row,
  disabled,
  op,
}: {
  template: AdviceTemplate;
  row: EditorAdvice | undefined;
  disabled: boolean;
  op: VisitSectionProps["op"];
}) {
  const id = `consiglio-${template.code}`;
  const checked = useChosen<boolean>(row !== undefined);
  const channels = useChosen<string>(channelsKey(row?.communicatedVia ?? []));
  const shownChannels = channelsOf(channels.shown);
  // Il testo mandato e non ancora nella vista: un clic su un canale subito dopo lo rimanda uguale, non quello di prima
  // (l'operazione riscrive testo e canali insieme).
  const text = useChosen<string | null>(row?.text ?? null);
  const [error, setError] = useState<string | undefined>(undefined);
  const errorId = `${id}-errore`;

  const refused = (reset: () => void) => (failure: ActionFailure) => {
    reset();
    setError(refusalText(failure));
  };

  const toggle = (next: boolean) => {
    setError(undefined);
    if (next) {
      checked.choose(true);
      op(
        { op: "consiglio", templateCode: template.code, text: null, communicatedVia: ["a_voce"] },
        { onRefused: refused(checked.reset) },
      );
      return;
    }
    if (row === undefined) return;
    checked.choose(false);
    op({ op: "togli_consiglio", adviceId: row.id }, { onRefused: refused(checked.reset) });
  };

  const saveRow = (values: { text: string | null; communicatedVia: readonly Channel[] }, options: RunOptions) => {
    if (row === undefined) return;
    op({ op: "consiglio", adviceId: row.id, templateCode: template.code, ...values }, options);
  };

  const toggleChannel = (channel: Channel, on: boolean) => {
    if (row === undefined) return;
    setError(undefined);
    const next = CHANNELS.filter((c) => (c === channel ? on : shownChannels.includes(c)));
    channels.choose(next.join(" "));
    saveRow({ text: text.shown, communicatedVia: next }, { onRefused: refused(channels.reset) });
  };

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked.shown}
          disabled={disabled}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : errorId}
          onCheckedChange={toggle}
        />
        <Label htmlFor={id}>{template.title}</Label>
      </div>
      {row !== undefined && checked.shown ? (
        <>
          <VisitTextField
            id={`${id}-testo`}
            label={`Testo: ${template.title}`}
            multiline
            value={row.text}
            maxLength={ADVICE_TEXT_MAX}
            disabled={disabled}
            onSave={(value, options) => {
              text.choose(value);
              saveRow(
                { text: value, communicatedVia: shownChannels },
                {
                  onRefused: (failure) => {
                    text.reset();
                    options.onRefused?.(failure);
                  },
                },
              );
            }}
          />
          <div role="group" aria-label={`Canale: ${template.title}`} className="flex flex-wrap items-center gap-2">
            <span aria-hidden="true" className="text-sm font-medium">
              Canale
            </span>
            {CHANNELS.map((channel) => (
              <Toggle
                key={channel}
                variant="outline"
                pressed={shownChannels.includes(channel)}
                disabled={disabled}
                onPressedChange={(on) => toggleChannel(channel, on)}
                className="aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground"
              >
                {CHANNEL_LABEL[channel]}
              </Toggle>
            ))}
          </div>
        </>
      ) : null}
      {error === undefined ? null : (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

/** I consigli proposti, più quelli già dati da un modello che oggi non si propone più. */
function Advice({ editor, disabled, op }: { editor: VisitSectionProps["editor"]; disabled: boolean; op: VisitSectionProps["op"] }) {
  const headingId = useId();
  const suggested = editor.suggestedAdvice;
  const codes = new Set(suggested.map((t) => t.code));
  const given = editor.advice.flatMap((a) =>
    a.templateCode === null || codes.has(a.templateCode) ? [] : [a.templateCode],
  );
  // Un modello già dato e non più proposto (per esempio una regione tolta) resta in elenco, per toglierlo o cambiarlo.
  const others = [...new Set(given)].flatMap((code) => {
    const template = ADVICE_TEMPLATES.find((t) => t.code === code);
    return template === undefined ? [] : [template];
  });
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-medium">
        Consigli
      </h3>
      <ul className="flex flex-col gap-2">
        {[...suggested, ...others].map((template) => (
          <AdviceItem
            key={template.code}
            template={template}
            row={editor.advice.find((a) => a.templateCode === template.code)}
            disabled={disabled}
            op={op}
          />
        ))}
      </ul>
    </section>
  );
}

const COPY_ADVICE = "Copia il messaggio";
const CLOSED_TITLE = "La visita è chiusa";
const CLOSED_TEXT =
  `Copiando il messaggio o aprendo WhatsApp registro una rettifica della visita: ai consigli si aggiunge «Messaggio copiato», con il motivo «${ADVICE_MESSAGE_REASON}»`;

/**
 * «Copia il messaggio» dei consigli: il compositore con i consigli da modello della visita, «Copia» come azione
 * predefinita. Sulla visita chiusa prima la conferma della rettifica. Chiuso il compositore dopo una riga registrata,
 * l'editor rilegge la visita: canali e rettifica.
 */
function AdviceMessage({ editor, mode, run, busy, onBusyChange }: Pick<VisitSectionProps, "editor" | "mode" | "run"> & {
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const reasonId = useId();
  const [confirming, setConfirming] = useState(false);
  const [source, setSource] = useState<MessageSource | null>(null);
  const recorded = useRef(false);
  const visitId = editor.visit.id;
  const reason = editor.adviceCopyReason;

  const compose = () => {
    recorded.current = false;
    onBusyChange(true);
    // Il blur ha già accodato il testo, con i canali di allora. Prima di poter copiare aspettiamo
    // quelle scritture e rileggiamo gli id; i consigli restano bloccati fino alla rilettura finale.
    run(async () => {
      const result = await visitEditorAction(visitId);
      if (result.ok) {
        const adviceIds = result.data.advice.flatMap((a) => (a.templateCode === null ? [] : [a.id]));
        setSource({ kind: "visit", visitId, adviceIds, templateKey: "consigli" });
      }
      return result;
    }, { onRefused: () => onBusyChange(false) });
  };

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={busy || !editor.canCopyAdvice}
        aria-describedby={reason === null ? undefined : reasonId}
        onClick={() => (mode === "lettura" ? setConfirming(true) : compose())}
      >
        {COPY_ADVICE}
      </Button>
      {reason === null ? null : (
        <p id={reasonId} className="text-sm text-muted-foreground">
          {reason}
        </p>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{CLOSED_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>{CLOSED_TEXT}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Torna indietro</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                compose();
              }}
            >
              Prepara il messaggio
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <MessageComposer
        source={source}
        onRecorded={() => {
          recorded.current = true;
        }}
        onClose={() => {
          setSource(null);
          // Non riabilitare i consigli con i vecchi canali mentre la rilettura è ancora in coda.
          if (recorded.current) run(async () => {
            const result = await visitEditorAction(visitId);
            if (result.ok) onBusyChange(false);
            return result;
          });
          else onBusyChange(false);
        }}
      />
    </div>
  );
}

/** "Piano spiegato e accettato dal paziente": alla prima visita del ciclo, con il giorno della visita. */
function PlanAgreed({ editor, mode, op, run }: VisitSectionProps) {
  const id = "campo-piano-accettato";
  const { shown, choose, reset } = useChosen<boolean>(editor.cycle.opening.planAgreedOn !== null);
  const [error, setError] = useState<string | undefined>(undefined);
  const visitId = editor.visit.id;

  const change = (next: boolean) => {
    setError(undefined);
    choose(next);
    const planAgreedOn = next ? editor.visit.visitDate : null;
    const options: RunOptions = {
      onRefused: (failure) => {
        reset();
        setError(refusalText(failure));
      },
    };
    if (mode === "rettifica") op({ op: "apertura", planAgreedOn }, options);
    else if (mode === "bozza") run(() => cycleOpeningAction(visitId, { planAgreedOn }), options);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={shown}
          disabled={mode === "lettura"}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : `${id}-errore`}
          onCheckedChange={change}
        />
        <Label htmlFor={id}>{PLAN_AGREED}</Label>
      </div>
      {error === undefined ? null : (
        <p id={`${id}-errore`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Il prossimo passo: l'appuntamento, la chiusura del ciclo, il rinvio al medico. */
function NextStep({ editor, run, booking }: Pick<VisitSectionProps, "editor" | "run"> & { booking: VisitBooking | null }) {
  const headingId = useId();
  const [closing, setClosing] = useState(false);
  const { prepare, pending } = usePrepareReferral({ editor, run });
  const { visit, cycle } = editor;
  const open = cycle.status === "open";
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-medium">
        Prossimo passo
      </h3>
      <div className="flex flex-wrap gap-2">
        {booking === null ? null : (
          <NewAppointmentButton
            {...booking}
            variant="outline"
            label="Fissa il prossimo appuntamento"
            prefill={{ patientId: visit.patientId, cycleId: open ? cycle.id : undefined }}
          />
        )}
        {open ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setClosing(true)}>
            Chiudi il ciclo
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={prepare}>
          Prepara rinvio
        </Button>
      </div>
      <CycleCloseDialog
        cycleId={closing ? cycle.id : null}
        onClose={() => setClosing(false)}
        // Il ciclo chiuso cambia la barra e la sezione A: l'editor rilegge la visita.
        onClosed={() => run(() => visitEditorAction(visit.id))}
      />
    </section>
  );
}

export function SectionE(props: VisitSectionProps & { booking: VisitBooking | null }) {
  const { editor, mode, op, run, booking } = props;
  const [adviceBusy, setAdviceBusy] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <Advice editor={editor} disabled={mode === "lettura" || adviceBusy} op={op} />
      {mode === "rettifica" ? null : (
        <AdviceMessage editor={editor} mode={mode} run={run} busy={adviceBusy} onBusyChange={setAdviceBusy} />
      )}
      {editor.cycle.showsOpening ? (
        // Con l'apertura in sola lettura (`openingLock`) anche il piano accettato resta com'è.
        <PlanAgreed editor={editor} mode={editor.cycle.openingLock === null ? mode : "lettura"} op={op} run={run} />
      ) : null}
      {mode === "rettifica" ? null : <NextStep editor={editor} run={run} booking={booking} />}
    </div>
  );
}
