"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { previewMessageTemplateAction, restoreMessageTemplateAction, saveCommunicationSettingsAction, saveMessageTemplateAction, searchPreviewPatientsAction } from "@/app/(app)/impostazioni/actions";
import { described, Field, SaveBar } from "@/components/forms/form-parts";
import { UnsavedGuard } from "@/components/forms/unsaved-guard";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox";
import { Textarea } from "@/components/ui/textarea";
import { lastFirst } from "@/lib/format";
import { missingMessage } from "@/lib/messages/render";
import { DEFAULT_TEMPLATES, templateProblem, type TemplateKey, type Variant } from "@/lib/messages/templates";
import { MESSAGE_MAX, MESSAGE_TOO_LONG, messageLength } from "@/lib/messages/texts";
import type { ActionFailure } from "@/server/actions/result";
import type { MessageTemplateView } from "@/server/domain/messages/queries";
import type { PatientHit } from "@/server/domain/patients/queries";

const NAMES: Record<TemplateKey, string> = { conferma: "Conferma", promemoria: "Promemoria", spostamento: "Spostamento", richiamo: "Richiamo", consigli: "Consigli" };
const TONES: Record<Variant, string> = { tu: "Tu", lei: "Lei" };
// La pertinenza resta decisa dalla whitelist dei segnaposto, anche per i pulsanti dell'editor.
const PLACEHOLDERS = ["nome", "per_paziente", "di_paziente", "quando", "ora", "durata", "studio", "indirizzo", "telefono_studio", "osteopata", "settimane", "consigli"];
// Il paziente dell'anteprima si cerca come nell'agenda: da 3 caratteri, 250 ms dopo l'ultimo tasto.
const SEARCH_MIN_CHARS = 3;
const SEARCH_DEBOUNCE_MS = 250;
const SELECT_CLASS = "min-h-9 w-full rounded-lg border border-input bg-muted px-2.5 py-2 text-sm focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-ring aria-invalid:border-destructive";

export function MessagesSection({ initial, defaultAddressing, hasPatients }: { initial: MessageTemplateView[]; defaultAddressing: Variant; hasPatients: boolean }) {
  const [dirtyEditors, setDirtyEditors] = useState<Record<string, boolean>>({});
  const onDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyEditors((current) => current[id] === dirty ? current : { ...current, [id]: dirty });
  }, []);
  return (
    <div className="flex flex-col gap-8">
      <UnsavedGuard dirty={Object.values(dirtyEditors).some(Boolean)} />
      <p className="text-sm text-muted-foreground">Personalizza ciascun modello nei toni Tu e Lei. L&apos;anteprima usa i dati del paziente scelto e non registra eventi.</p>
      <DefaultTone initial={defaultAddressing} onDirty={onDirty} />
      {initial.map((template) => <TemplateEditor key={`${template.key}-${template.variant}`} initial={template} hasPatients={hasPatients} onDirty={onDirty} />)}
    </div>
  );
}

function DefaultTone({ initial, onDirty }: { initial: Variant; onDirty: (id: string, dirty: boolean) => void }) {
  const id = useId();
  const input = useRef<HTMLSelectElement>(null);
  const formError = useRef<HTMLParagraphElement>(null);
  const pending = useRef(false);
  // Scelta e revisione lette al clic su "Salva": se il clic arriva prima del nuovo render,
  // lo stato della closure è ancora quello vecchio e si salverebbe il tono precedente.
  const latest = useRef({ value: initial, revision: 0 });
  const [state, setState] = useState({ value: initial, saved: initial, revision: 0, saving: false, error: undefined as string | undefined, formError: null as string | null, status: "", errorsShown: 0 });
  useEffect(() => onDirty("tono", state.value !== state.saved), [onDirty, state.value, state.saved]);
  useEffect(() => {
    if (state.errorsShown) {
      if (state.error) input.current?.focus();
      else formError.current?.focus();
    }
  }, [state.errorsShown, state.error]);
  const save = async () => {
    if (pending.current) return;
    pending.current = true;
    const sent = { ...latest.current };
    setState((current) => ({ ...current, saving: true, status: "", error: undefined, formError: null }));
    try {
      const result = await saveCommunicationSettingsAction({ section: "messaggi", defaultAddressing: sent.value });
      if (result.ok) {
        setState((current) => ({ ...current, saved: sent.value, status: current.revision === sent.revision ? "Tono abituale salvato." : "Tono abituale salvato. Restano modifiche non salvate." }));
      } else {
        setState((current) => {
          const error = result.fieldErrors?.defaultAddressing;
          if (error && current.revision !== sent.revision) return current;
          return { ...current, error, formError: error ? null : result.message, errorsShown: current.errorsShown + 1 };
        });
      }
    } catch {
      setState((current) => ({ ...current, formError: "Non ho salvato le modifiche. Riprova.", errorsShown: current.errorsShown + 1 }));
    } finally {
      pending.current = false;
      setState((current) => ({ ...current, saving: false }));
    }
  };
  return (
    <form noValidate className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-busy={state.saving}>
      <Field id={id} label="Tono abituale per i nuovi pazienti" error={state.error} hint="I pazienti già presenti mantengono il loro tono. Puoi cambiarlo nella loro anagrafica.">
        <select ref={input} id={id} className={SELECT_CLASS} value={state.value} {...described(id, state.error, true)} onChange={(event) => {
          const value = event.target.value as Variant;
          latest.current = { value, revision: latest.current.revision + 1 };
          setState((current) => ({ ...current, value, revision: current.revision + 1, error: undefined, formError: null, status: "" }));
        }}>
          <option value="tu">Tu</option><option value="lei">Lei</option>
        </select>
      </Field>
      {state.formError ? <p ref={formError} role="alert" tabIndex={-1} className="text-sm text-destructive">{state.formError}</p> : null}
      <SaveBar saving={state.saving} formError={null} label="Salva tono abituale" />
      <p role="status" className="text-sm">{state.status}</p>
    </form>
  );
}

type Preview = { text: string; missing: string[]; revision: number; patientId: string };
type EditorState = {
  body: string; savedBody: string; isCustomized: boolean; revision: number; patientId: string;
  preview: Preview | null; busy: "save" | "restore" | "preview" | null;
  errors: Record<string, string>; formError: string | null; status: string; errorsShown: number; bodyReset: number;
};

function TemplateEditor({ initial, hasPatients, onDirty }: { initial: MessageTemplateView; hasPatients: boolean; onDirty: (id: string, dirty: boolean) => void }) {
  const id = useId();
  const editorId = `${initial.key}-${initial.variant}`;
  const original = DEFAULT_TEMPLATES[initial.key][initial.variant];
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const selection = useRef({ start: initial.body.length, end: initial.body.length });
  const pending = useRef(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [state, setState] = useState<EditorState>({ body: initial.body, savedBody: initial.body, isCustomized: initial.isCustomized, revision: 0, patientId: "", preview: null, busy: null, errors: {}, formError: null, status: "", errorsShown: 0, bodyReset: 0 });
  const dirty = state.body !== state.savedBody;
  useEffect(() => onDirty(editorId, dirty), [onDirty, editorId, dirty]);
  useEffect(() => {
    if (state.errorsShown) form.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  }, [state.errorsShown]);
  useEffect(() => {
    const field = textarea.current;
    // Una sostituzione esterna riparte dalla fine; un ritocco durante l'attesa resta intatto.
    if (field) {
      selection.current = { start: field.value.length, end: field.value.length };
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }, [state.bodyReset]);

  const edit = (body: string) => setState((current) => ({ ...current, body, revision: current.revision + 1, errors: Object.fromEntries(Object.entries(current.errors).filter(([field]) => field !== "body")), formError: null, status: "" }));
  const insert = (name: string) => {
    const { start, end } = selection.current;
    const placeholder = `{${name}}`;
    // L'inserimento usa la selezione prima del clic, anche con la tastiera.
    setState((current) => ({ ...current, body: current.body.slice(0, start) + placeholder + current.body.slice(end), revision: current.revision + 1, errors: Object.fromEntries(Object.entries(current.errors).filter(([field]) => field !== "body")), formError: null, status: "" }));
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(start + placeholder.length, start + placeholder.length);
    });
  };

  const run = async (operation: "save" | "restore" | "preview") => {
    if (pending.current) return;
    const errors: Record<string, string> = {};
    const problem = operation !== "restore" ? templateProblem(initial.key, state.body) : null;
    if (problem) errors.body = problem;
    if (operation === "preview" && !state.patientId) errors.patientId = "Scegli un paziente per l'anteprima.";
    if (Object.keys(errors).length) {
      setState((current) => ({ ...current, errors, formError: null, errorsShown: current.errorsShown + 1 }));
      return;
    }
    pending.current = true;
    const sent = { body: state.body, revision: state.revision, patientId: state.patientId };
    const identity = { key: initial.key, variant: initial.variant };
    setState((current) => ({ ...current, busy: operation, errors: {}, formError: null, status: "" }));
    const fail = (result: ActionFailure) => setState((current) => {
      const hasFields = result.fieldErrors && Object.keys(result.fieldErrors).length > 0;
      // Solo gli errori di campo diventano obsoleti; un rifiuto generale resta visibile.
      if (hasFields && (current.revision !== sent.revision || (operation === "preview" && current.patientId !== sent.patientId))) return current;
      return { ...current, errors: result.fieldErrors ?? {}, formError: hasFields ? null : result.message, errorsShown: current.errorsShown + 1 };
    });
    try {
      if (operation === "preview") {
        const result = await previewMessageTemplateAction({ ...identity, body: sent.body, patientId: sent.patientId });
        if (!result.ok) fail(result);
        else setState((current) => ({ ...current, preview: { ...result.data, revision: sent.revision, patientId: sent.patientId } }));
      } else {
        const result = operation === "save" ? await saveMessageTemplateAction({ ...identity, body: sent.body }) : await restoreMessageTemplateAction(identity);
        if (!result.ok) fail(result);
        else setState((current) => {
          const same = current.revision === sent.revision;
          const savedBody = operation === "restore" ? original : sent.body;
          const body = operation === "restore" && same ? original : current.body;
          const status = operation === "restore" ? "Testo originale ripristinato." : "Modello salvato.";
          return { ...current, body, savedBody, isCustomized: savedBody !== original, revision: operation === "restore" && same ? current.revision + 1 : current.revision, bodyReset: current.bodyReset + (body !== current.body ? 1 : 0), status: body === savedBody ? status : `${status} Restano modifiche non salvate.` };
        });
      }
    } catch {
      setState((current) => ({ ...current, formError: operation === "preview" ? "Non riesco a caricare l'anteprima. Riprova." : "Non ho salvato le modifiche. Riprova." }));
    } finally {
      pending.current = false;
      setState((current) => ({ ...current, busy: null }));
    }
  };
  const preview = state.preview;
  const stalePreview = preview !== null && (preview.revision !== state.revision || preview.patientId !== state.patientId);
  const count = messageLength(state.body);
  const bodyError = count > MESSAGE_MAX ? "Il modello supera i 700 caratteri." : state.errors.body;

  return (
    <form ref={form} noValidate className="flex flex-col gap-4 border-t pt-6" aria-busy={state.busy !== null} onSubmit={(event) => { event.preventDefault(); void run("save"); }}>
      <fieldset className="flex min-w-0 flex-col gap-4">
        <legend className="mb-3 text-base font-semibold">{NAMES[initial.key]} ({TONES[initial.variant]})</legend>
        <p className="text-sm text-muted-foreground">{state.isCustomized ? "Personalizzato" : "Testo originale"}{dirty ? ", modifiche non salvate" : ""}</p>
        <Field id={`${id}-body`} label="Testo del modello" required error={bodyError} hint={`${count} / ${MESSAGE_MAX} caratteri`}>
          <Textarea ref={textarea} id={`${id}-body`} rows={5} value={state.body} {...described(`${id}-body`, bodyError, true)} onChange={(event) => edit(event.target.value)} onSelect={(event) => {
            selection.current = { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd };
          }} />
        </Field>
        <div role="group" aria-label="Segnaposto inseribili" className="flex flex-wrap gap-2">
          {PLACEHOLDERS.filter((name) => templateProblem(initial.key, `{${name}}`) === null).map((name) => (
            <Button key={name} type="button" variant="outline" size="sm" aria-label={`Inserisci {${name}}`} onClick={() => insert(name)}>{`{${name}}`}</Button>
          ))}
        </div>
        <SaveBar saving={state.busy !== null} formError={state.formError} label="Salva modello" />
        <AlertDialog open={confirmRestore} onOpenChange={setConfirmRestore}>
          <AlertDialogTrigger render={<Button type="button" variant="outline" disabled={state.busy !== null || (state.body === original && !state.isCustomized)} />}>Ripristina il testo originale</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Ripristinare il testo originale?</AlertDialogTitle>
              <AlertDialogDescription>Il modello {NAMES[initial.key]} ({TONES[initial.variant]}) tornerà al testo originale. Le altre varianti non cambiano.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annulla</AlertDialogCancel>
              <Button type="button" onClick={() => { setConfirmRestore(false); void run("restore"); }}>Ripristina</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <p role="status" className="text-sm">{state.status}</p>
        <Field id={`${id}-patient`} label="Paziente per l'anteprima" error={state.errors.patientId} hint="Scrivi almeno 3 lettere del nome o del cognome.">
          <PreviewPatientPicker id={`${id}-patient`} {...described(`${id}-patient`, state.errors.patientId, true)} onChange={(patientId) => {
            setState((current) => ({ ...current, patientId, errors: Object.fromEntries(Object.entries(current.errors).filter(([field]) => field !== "patientId")), formError: null }));
          }} />
        </Field>
        {hasPatients ? null : <p className="text-sm text-muted-foreground">Aggiungi un paziente per vedere l&apos;anteprima.</p>}
        <Button type="button" variant="outline" className="self-start" disabled={state.busy !== null || !hasPatients} onClick={() => void run("preview")}>Mostra anteprima</Button>
        <div aria-live="polite" className="flex flex-col gap-3">
          {preview === null ? null : <>
            <Field id={`${id}-preview`} label="Anteprima del messaggio" error={undefined} hint={`${messageLength(preview.text)} / ${MESSAGE_MAX} caratteri nel testo finale`}>
              <Textarea id={`${id}-preview`} rows={5} readOnly value={preview.text} {...described(`${id}-preview`, undefined, true)} />
            </Field>
            {stalePreview ? <p className="text-sm text-muted-foreground">Il testo o il paziente sono cambiati: aggiorna l&apos;anteprima.</p> : null}
            {messageLength(preview.text) > MESSAGE_MAX ? <p className="text-sm text-destructive">{MESSAGE_TOO_LONG}</p> : null}
            {preview.missing.length ? <ul className="list-inside list-disc text-sm">
              {preview.missing.map((key) => {
                const missing = missingMessage(key, preview.patientId);
                return <li key={key}><Link className="underline" href={missing.href}>{missing.message}</Link></li>;
              })}
            </ul> : null}
          </>}
        </div>
      </fieldset>
    </form>
  );
}

/**
 * Il campo "Paziente per l'anteprima": una ricerca sul server al posto di un elenco con tutti i pazienti
 * attivi in ognuno dei 10 editor. Freccia giù e Invio scelgono, Esc chiude l'elenco;
 * riscrivere il nome toglie il paziente scelto, come nel dialogo dell'appuntamento.
 */
function PreviewPatientPicker({ id, onChange, ...aria }: {
  id: string;
  onChange: (patientId: string) => void;
  "aria-invalid": true | undefined;
  "aria-describedby": string | undefined;
}) {
  const [value, setValue] = useState<PatientHit | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<PatientHit[]>([]);
  const [answer, setAnswer] = useState<"none" | "ok" | "failed">("none");

  useEffect(() => {
    const text = search.trim();
    if (text.length < SEARCH_MIN_CHARS) return;
    let current = true;
    const timer = setTimeout(() => {
      void searchPreviewPatientsAction(text).then((result) => {
        if (!current) return;
        setAnswer(result.ok ? "ok" : "failed");
        // Le voci cambiano tutte insieme, a risposta arrivata: Freccia giù non prende una lista vecchia.
        setOptions(result.ok ? result.data : []);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [search]);

  const choose = (next: PatientHit | null) => {
    setValue(next);
    onChange(next?.id ?? "");
  };
  return (
    <Combobox<PatientHit>
      items={options}
      // Filtra il server: le voci arrivano già scelte.
      filter={null}
      value={value}
      onValueChange={(next, details) => {
        // Esc chiude l'elenco e non toglie il paziente scelto.
        if (details.reason === "escape-key") return;
        choose(next);
      }}
      inputValue={inputValue}
      onInputValueChange={(text, details) => {
        if (details.reason === "escape-key") return;
        setInputValue(text);
        if (details.reason !== "input-change") return;
        setSearch(text);
        if (text.trim().length < SEARCH_MIN_CHARS) {
          setOptions([]);
          setAnswer("none");
        }
        // Chi riscrive il nome sta cercando un altro paziente.
        if (value !== null) choose(null);
      }}
      itemToStringLabel={lastFirst}
      isItemEqualToValue={(a, b) => a.id === b.id}
    >
      <ComboboxInput id={id} className="w-full" showTrigger={false} autoComplete="off" {...aria} />
      {/* Sotto i 3 caratteri non c'è niente da mostrare: l'elenco vuoto non si vede. */}
      <ComboboxContent className={answer === "none" ? "data-empty:hidden" : undefined}>
        <ComboboxEmpty>{answer === "failed" ? "Non riesco a caricare questo elenco." : answer === "ok" ? "Nessun paziente trovato." : null}</ComboboxEmpty>
        <ComboboxList>
          {(patient: PatientHit) => <ComboboxItem key={patient.id} value={patient} className="py-1.5">{lastFirst(patient)}</ComboboxItem>}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
