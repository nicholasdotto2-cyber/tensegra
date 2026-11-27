"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { described, Field } from "@/components/forms/form-parts";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { EditorLine } from "@/lib/fiscal/editor-state";
import { dayShort, money } from "@/lib/format";
import { centsToInput } from "@/lib/money";
import type { InvoiceEditorView } from "@/server/domain/invoices/queries";

// Le righe dell'editor: "Aggiungi dal listino", "Aggiungi sedute da fatturare" (le sedute
// fatte e non fatturate del paziente scelto, tutte per un committente) e "Riga libera"; per riga descrizione,
// data della prestazione, quantità e prezzo, con "Togli riga". Gli importi si scrivono come nel Listino.

type Session = InvoiceEditorView["toInvoice"][number];
type Service = InvoiceEditorView["services"][number];

const NO_SESSIONS = "Nessuna seduta da fatturare.";

let lastKey = 0;
/** Una chiave per la riga, stabile finché la riga esiste. */
export function newLineKey(): string {
  lastKey += 1;
  return `riga-${lastKey}`;
}

export function EditorLines({
  lines,
  onChange,
  errors,
  idOf,
  services,
  sessions,
  patientId,
  showPatient,
  today,
}: {
  lines: EditorLine[];
  onChange: (lines: EditorLine[]) => void;
  errors: Readonly<Record<string, string>>;
  /** L'id del campo per il percorso dell'errore, `lines.0.price`. */
  idOf: (field: string) => string;
  services: readonly Service[];
  sessions: readonly Session[];
  /** Il paziente scelto: le sedute sono le sue. Null per un committente o senza destinatario. */
  patientId: string | null;
  showPatient: boolean;
  today: string;
}) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [showSessions, setShowSessions] = useState(false);
  // La riga appena aggiunta prende il focus sulla descrizione; tolta una riga, il focus va al titolo.
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    if (target === "heading") headingRef.current?.focus();
    else document.getElementById(target)?.focus();
  }, [lines]);

  const add = (line: Omit<EditorLine, "key">) => {
    focusNext.current = idOf(`lines.${lines.length}.description`);
    onChange([...lines, { key: newLineKey(), ...line }]);
  };
  const update = (index: number, part: Partial<EditorLine>) =>
    onChange(lines.map((line, i) => (i === index ? { ...line, ...part } : line)));
  const remove = (index: number) => {
    focusNext.current = "heading";
    onChange(lines.filter((_, i) => i !== index));
  };

  const taken = new Set(lines.map((line) => line.appointmentId).filter((id) => id !== null));
  const available = sessions.filter(
    (session) => !taken.has(session.appointmentId) && (patientId === null || session.patientId === patientId),
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className="font-medium outline-none">
        Righe
      </h3>
      {errors.lines === undefined ? null : (
        <p id={idOf("lines")} className="text-sm text-destructive">
          {errors.lines}
        </p>
      )}
      {lines.length === 0 ? null : (
        <ol className="flex flex-col gap-4">
          {lines.map((line, index) => {
            const field = (name: string) => idOf(`lines.${index}.${name}`);
            const error = (name: string) => errors[`lines.${index}.${name}`];
            return (
              <li key={line.key}>
                <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
                  <legend className="px-1 text-sm font-medium">{`Riga ${index + 1}`}</legend>
                  <Field id={field("description")} label="Descrizione" error={error("description")}>
                    <Input
                      id={field("description")}
                      value={line.description}
                      maxLength={1000}
                      autoComplete="off"
                      onChange={(event) => update(index, { description: event.target.value })}
                      {...described(field("description"), error("description"))}
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-[1fr_6rem_8rem]">
                    <Field id={field("serviceDate")} label="Data della prestazione" error={error("serviceDate")}>
                      <Input
                        id={field("serviceDate")}
                        type="date"
                        value={line.serviceDate ?? ""}
                        onChange={(event) => update(index, { serviceDate: event.target.value === "" ? null : event.target.value })}
                        {...described(field("serviceDate"), error("serviceDate"))}
                      />
                    </Field>
                    <Field id={field("quantity")} label="Quantità" error={error("quantity")}>
                      <Input
                        id={field("quantity")}
                        inputMode="numeric"
                        autoComplete="off"
                        value={line.quantity}
                        onChange={(event) => update(index, { quantity: event.target.value })}
                        {...described(field("quantity"), error("quantity"))}
                      />
                    </Field>
                    <Field id={field("price")} label="Prezzo" error={error("price")}>
                      <Input
                        id={field("price")}
                        inputMode="decimal"
                        autoComplete="off"
                        value={line.price}
                        onChange={(event) => update(index, { price: event.target.value })}
                        {...described(field("price"), error("price"))}
                      />
                    </Field>
                  </div>
                  <div>
                    <Button type="button" variant="ghost" size="sm" onClick={() => remove(index)}>
                      Togli riga<span className="sr-only">{` ${index + 1}`}</span>
                    </Button>
                  </div>
                </fieldset>
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex flex-wrap gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant="outline" disabled={services.length === 0} />}>
            Aggiungi dal listino
            <ChevronDown aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            {services.map((service) => (
              <DropdownMenuItem
                key={service.id}
                onClick={() =>
                  add({
                    serviceId: service.id, appointmentId: null, description: service.description,
                    serviceDate: today, quantity: "1", price: centsToInput(service.priceCents),
                  })
                }
              >
                <span className="flex-1">{service.name}</span>
                <span className="text-muted-foreground tabular-nums">{money(service.priceCents)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          variant="outline"
          aria-expanded={showSessions}
          onClick={() => setShowSessions((shown) => !shown)}
        >
          Aggiungi sedute da fatturare
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            add({ serviceId: null, appointmentId: null, description: "", serviceDate: today, quantity: "1", price: "" })
          }
        >
          Riga libera
        </Button>
      </div>

      {showSessions ? (
        available.length === 0 ? (
          <p className="text-sm text-muted-foreground">{NO_SESSIONS}</p>
        ) : (
          <ul aria-label="Sedute da fatturare" className="flex flex-col divide-y rounded-lg border">
            {available.map((session) => {
              const text = [dayShort(session.day), showPatient ? session.patientName : null, session.serviceName]
                .filter(Boolean)
                .join(", ");
              return (
                <li key={session.appointmentId} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-sm">
                    {text}
                    <span className="ml-2 text-muted-foreground tabular-nums">{money(session.priceCents)}</span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      add({
                        serviceId: session.serviceId, appointmentId: session.appointmentId,
                        description: session.description, serviceDate: session.day, quantity: "1",
                        price: centsToInput(session.priceCents),
                      })
                    }
                  >
                    Aggiungi<span className="sr-only">{` la seduta del ${dayShort(session.day)}`}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </section>
  );
}
