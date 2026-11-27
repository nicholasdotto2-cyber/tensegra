"use client";

import { type ReactNode, type RefObject, useCallback, useId, useRef, useState } from "react";

import { updatePatientGroupAction } from "@/app/(app)/pazienti/[id]/actions";
import {
  ChoiceSelect,
  Field,
  SaveBar,
  described,
  useReportDirty,
  useSectionForm,
} from "@/components/forms/form-parts";
import { UnsavedGuard } from "@/components/forms/unsaved-guard";
import { AddressFields } from "@/components/pazienti/address-fields";
import { GuardianForm, newGuardianValues, type Relationship } from "@/components/pazienti/guardian-fields";
import { NewPhysicianDialog } from "@/components/pazienti/new-physician-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { checkTaxCode } from "@/lib/patients/tax-code";
import { phoneDisplay } from "@/lib/phone";
import type { RegistryView } from "@/server/domain/patients/card";
import type { SavedGroups } from "@/server/domain/patients/commands";
import type { PhysicianOption } from "@/server/domain/physicians/queries";

// La tab Anagrafica: sei gruppi, ognuno col suo "Salva" e il suo stato.
// Un solo `UnsavedGuard` copre tutti: basta un gruppo modificato perché uscire dalla sezione chieda conferma.
// Valori vuoti come "" nei campi, salvati come null dal comando; il telefono si legge "+39 051 000 0000" e si
// salva in E.164. Gli errori del comando stanno sotto il campo, con il focus sul primo. Dopo "Salva" il punto
// di partenza è ciò che il server ha risposto (spazi tolti, maiuscole, E.164), mai una copia fatta qui.

const MAX_GUARDIANS = 2;
const NO_PHYSICIAN = "nessuno";
const MISSING_PHYSICIAN = "Medico non più in rubrica";

/** Il salvataggio di un gruppo: l'azione, poi `done` coi valori che il server ha salvato. */
function saveGroup<G extends keyof SavedGroups, V>(
  form: {
    startSaving: (action: () => Promise<void>) => void;
    fail: (result: { message: string; fieldErrors?: Record<string, string> }) => void;
    done: (next: V) => void;
  },
  group: G,
  input: unknown,
  toValues: (saved: SavedGroups[G]) => V,
): void {
  form.startSaving(async () => {
    const result = await updatePatientGroupAction(input);
    if (!result.ok) {
      form.fail(result);
      return;
    }
    // Il comando risponde col gruppo che ha ricevuto.
    if (result.data.group !== group) throw new Error(`Risposta del gruppo ${result.data.group} per ${group}.`);
    form.done(toValues(result.data.values as SavedGroups[G]));
  });
}

function Group({
  title,
  headingRef,
  children,
}: {
  title: string;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={headingRef === undefined ? undefined : -1}
        className="mb-4 rounded-sm text-base font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

type Report = (key: string, dirty: boolean) => void;

// ---------------------------------------------------------------------------------------------------

type PersonalValues = RegistryView["personali"];

const SEX_ITEMS = [
  { value: "f", label: "Femmina" },
  { value: "m", label: "Maschio" },
  { value: "nd", label: "Non indicato" },
] as const;

function PersonalGroup({ registry, report }: { registry: RegistryView; report: Report }) {
  const [form, formRef] = useSectionForm<PersonalValues>(registry.personali);
  const { values, errors, idOf } = form;
  useReportDirty(report, "personali", form.dirty);

  const submit = () => {
    const problem = checkTaxCode(values.taxCode);
    if (problem !== null) {
      form.showErrors({ taxCode: problem });
      return;
    }
    saveGroup(form, "personali", { group: "personali", patientId: registry.patientId, ...values }, (saved) => saved);
  };

  return (
    <Group title="Dati personali">
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={idOf("firstName")} label="Nome" required error={errors.firstName}>
            <Input {...form.text("firstName")} maxLength={60} autoComplete="off" />
          </Field>
          <Field id={idOf("lastName")} label="Cognome" required error={errors.lastName}>
            <Input {...form.text("lastName")} maxLength={60} autoComplete="off" />
          </Field>
          <Field id={idOf("birthDate")} label="Data di nascita" required error={errors.birthDate}>
            <Input {...form.text("birthDate")} type="date" />
          </Field>
          <ChoiceSelect
            id={idOf("sex")}
            label="Sesso"
            required
            items={SEX_ITEMS}
            value={values.sex}
            onChange={(value) => form.set("sex", value)}
            error={errors.sex}
          />
          <Field id={idOf("birthPlace")} label="Luogo di nascita" error={errors.birthPlace}>
            <Input {...form.text("birthPlace")} autoComplete="off" />
          </Field>
          <Field id={idOf("taxCode")} label="Codice fiscale" error={errors.taxCode}>
            <Input {...form.text("taxCode")} autoComplete="off" />
          </Field>
        </div>
        <SaveBar saving={form.saving} formError={form.formError} />
      </form>
    </Group>
  );
}

// ---------------------------------------------------------------------------------------------------

type ContactValues = RegistryView["contatti"];

const CHANNEL_ITEMS = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "telefono", label: "Telefono" },
  { value: "nessuno", label: "Nessuno" },
] as const;

const ADDRESSING_ITEMS = [
  { value: "tu", label: "Tu" },
  { value: "lei", label: "Lei" },
] as const;

/** Il telefono salvato è in E.164: nel campo si legge a gruppi. */
const withPhoneShown = (contatti: ContactValues): ContactValues => ({
  ...contatti,
  phone: contatti.phone === "" ? "" : phoneDisplay(contatti.phone),
});

function ContactGroup({ registry, report }: { registry: RegistryView; report: Report }) {
  const [form, formRef] = useSectionForm<ContactValues>(withPhoneShown(registry.contatti));
  const { values, errors, idOf } = form;
  useReportDirty(report, "contatti", form.dirty);

  const submit = () =>
    saveGroup(form, "contatti", { group: "contatti", patientId: registry.patientId, ...values }, withPhoneShown);

  return (
    <Group title="Contatti e preferenze">
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={idOf("phone")} label="Telefono" error={errors.phone}>
            <Input {...form.text("phone")} type="tel" autoComplete="off" />
          </Field>
          <Field id={idOf("email")} label="Email" error={errors.email}>
            <Input {...form.text("email")} type="email" autoComplete="off" />
          </Field>
          <ChoiceSelect
            id={idOf("preferredChannel")}
            label="Canale preferito"
            required
            items={CHANNEL_ITEMS}
            value={values.preferredChannel}
            onChange={(value) => form.set("preferredChannel", value)}
            error={errors.preferredChannel}
          />
          <ChoiceSelect
            id={idOf("addressing")}
            label="Tono"
            required
            items={ADDRESSING_ITEMS}
            value={values.addressing}
            onChange={(value) => form.set("addressing", value)}
            error={errors.addressing}
          />
        </div>
        <SaveBar saving={form.saving} formError={form.formError} />
      </form>
    </Group>
  );
}

// ---------------------------------------------------------------------------------------------------

function AddressGroup({ registry, report }: { registry: RegistryView; report: Report }) {
  const [form, formRef] = useSectionForm<RegistryView["indirizzo"]>(registry.indirizzo);
  const { values, errors, idOf } = form;
  useReportDirty(report, "indirizzo", form.dirty);

  const submit = () =>
    saveGroup(form, "indirizzo", { group: "indirizzo", patientId: registry.patientId, ...values }, (saved) => saved);

  return (
    <Group title="Indirizzo (per la fattura)">
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <AddressFields values={values} errors={errors} idOf={idOf} onChange={(field, value) => form.set(field, value)} />
        <SaveBar saving={form.saving} formError={form.formError} />
      </form>
    </Group>
  );
}

// ---------------------------------------------------------------------------------------------------

type PhysiciansValues = RegistryView["medici"];

function PhysiciansGroup({
  registry,
  physicians,
  report,
}: {
  registry: RegistryView;
  physicians: PhysicianOption[];
  report: Report;
}) {
  const [form, formRef] = useSectionForm<PhysiciansValues>(registry.medici);
  const { values, errors, idOf } = form;
  useReportDirty(report, "medici", form.dirty);
  const [dialogOpen, setDialogOpen] = useState(false);
  // I medici appena creati: la scheda li ha subito, prima che la pagina si rilegga.
  const [created, setCreated] = useState<PhysicianOption[]>([]);

  const options = [...physicians, ...created.filter((c) => !physicians.some((p) => p.id === c.id))].sort((a, b) =>
    a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase(), "it"),
  );
  // Un medico scelto che non è più in rubrica si vede com'è: salvando, quell'id resterebbe.
  const missing = [values.gpPhysicianId, values.defaultReferringPhysicianId].filter(
    (id, index, all) => id !== "" && all.indexOf(id) === index && !options.some((p) => p.id === id),
  );
  const items = [
    { value: NO_PHYSICIAN, label: "Nessuno" },
    ...options.map((p) => ({ value: p.id, label: p.fullName })),
    ...missing.map((id) => ({ value: id, label: MISSING_PHYSICIAN })),
  ];

  // Il comando vuole un id o null: nessun medico scelto è null, non "".
  const submit = () =>
    saveGroup(
      form,
      "medici",
      {
        group: "medici",
        patientId: registry.patientId,
        gpPhysicianId: values.gpPhysicianId === "" ? null : values.gpPhysicianId,
        defaultReferringPhysicianId: values.defaultReferringPhysicianId === "" ? null : values.defaultReferringPhysicianId,
      },
      (saved) => saved,
    );

  const choice = (field: keyof PhysiciansValues, label: string) => (
    <ChoiceSelect
      id={idOf(field)}
      label={label}
      items={items}
      value={values[field] === "" ? NO_PHYSICIAN : values[field]}
      onChange={(value) => form.set(field, value === NO_PHYSICIAN ? "" : value)}
      error={errors[field]}
    />
  );

  return (
    <Group title="Medici">
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {choice("gpPhysicianId", "Medico curante o pediatra")}
          {choice("defaultReferringPhysicianId", "Medico inviante abituale")}
        </div>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
            Nuovo medico
          </Button>
        </div>
        <SaveBar saving={form.saving} formError={form.formError} />
      </form>
      {/* Fuori dal modulo: il dialogo ha il suo, e un invio al suo interno non deve arrivare a questo. */}
      <NewPhysicianDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(physician) => {
          setCreated((current) => [...current, physician]);
          // Medico di base e pediatra sono il curante; uno specialista è più spesso chi invia.
          const field =
            physician.role === "mmg" || physician.role === "pediatra" ? "gpPhysicianId" : "defaultReferringPhysicianId";
          form.set(field, physician.id);
        }}
      />
    </Group>
  );
}

// ---------------------------------------------------------------------------------------------------

function GuardiansGroup({
  registry,
  minor,
  report,
  onEmptied,
}: {
  registry: RegistryView;
  minor: boolean;
  report: Report;
  /** L'ultimo genitore di un adulto è stato tolto: il gruppo sparisce e il focus deve andare altrove. */
  onEmptied: () => void;
}) {
  const { guardians, patientId } = registry;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [adding, setAdding] = useState(false);
  // Il genitore appena salvato: il suo titolo prende il focus quando compare.
  const [justSaved, setJustSaved] = useState<string | null>(null);

  const canAdd = minor && !adding && guardians.length < MAX_GUARDIANS;
  const relationship: Relationship = guardians.some((g) => g.relationship === "madre") ? "padre" : "madre";
  const contactTaken = guardians.some((g) => g.isContact);

  // Dopo "Togli" o "Annulla" il focus resta nel gruppo, sul suo titolo; se il gruppo sparisce, passa al seguente.
  const gone = () => {
    setAdding(false);
    if (!minor && guardians.length === 1) onEmptied();
    else headingRef.current?.focus();
  };

  return (
    <Group title="Genitori o tutori" headingRef={headingRef}>
      <div className="flex flex-col gap-4">
        {guardians.length === 0 && !adding ? <p>Nessun genitore o tutore registrato.</p> : null}
        {guardians.map((guardian) => (
          <GuardianForm
            key={guardian.id}
            patientId={patientId}
            guardian={guardian}
            report={report}
            onGone={gone}
            focus={justSaved === guardian.id ? "heading" : null}
          />
        ))}
        {adding ? (
          <GuardianForm
            patientId={patientId}
            guardian={null}
            start={newGuardianValues(relationship, !contactTaken)}
            report={report}
            onSaved={(id) => {
              setJustSaved(id);
              setAdding(false);
            }}
            onGone={gone}
            focus="first"
          />
        ) : null}
        {canAdd ? (
          <div>
            <Button type="button" variant="outline" onClick={() => setAdding(true)}>
              Aggiungi genitore o tutore
            </Button>
          </div>
        ) : null}
      </div>
    </Group>
  );
}

// ---------------------------------------------------------------------------------------------------

function NotesGroup({
  registry,
  report,
  headingRef,
}: {
  registry: RegistryView;
  report: Report;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [form, formRef] = useSectionForm<RegistryView["note"]>(registry.note);
  const { values, errors, idOf } = form;
  useReportDirty(report, "note", form.dirty);

  const submit = () =>
    saveGroup(form, "note", { group: "note", patientId: registry.patientId, ...values }, (saved) => saved);

  return (
    <Group title="Note amministrative" headingRef={headingRef}>
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          id={idOf("adminNotes")}
          label="Note amministrative"
          hint="Solo dati amministrativi: niente dati clinici."
          error={errors.adminNotes}
        >
          <Textarea
            id={idOf("adminNotes")}
            value={values.adminNotes}
            onChange={(event) => form.set("adminNotes", event.target.value)}
            {...described(idOf("adminNotes"), errors.adminNotes, true)}
          />
        </Field>
        <SaveBar saving={form.saving} formError={form.formError} />
      </form>
    </Group>
  );
}

// ---------------------------------------------------------------------------------------------------

export function RegistryTab({
  registry,
  physicians,
  minor,
}: {
  registry: RegistryView;
  physicians: PhysicianOption[];
  minor: boolean;
}) {
  // I gruppi modificati: un solo avviso di uscita per tutta la sezione.
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(new Set());
  const report = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((current) => {
      if (current.has(key) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const notesHeadingRef = useRef<HTMLHeadingElement>(null);

  const showGuardians = minor || registry.guardians.length > 0;
  return (
    <div className="flex flex-col gap-4">
      <UnsavedGuard dirty={dirtyKeys.size > 0} />
      <PersonalGroup registry={registry} report={report} />
      <ContactGroup registry={registry} report={report} />
      <AddressGroup registry={registry} report={report} />
      <PhysiciansGroup registry={registry} physicians={physicians} report={report} />
      {showGuardians ? (
        <GuardiansGroup
          registry={registry}
          minor={minor}
          report={report}
          onEmptied={() => notesHeadingRef.current?.focus()}
        />
      ) : null}
      <NotesGroup registry={registry} report={report} headingRef={notesHeadingRef} />
    </div>
  );
}
