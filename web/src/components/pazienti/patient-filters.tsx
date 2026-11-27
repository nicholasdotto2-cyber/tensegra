"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PATIENT_FILTERS, type PatientFilter, type PatientListParams } from "@/lib/patients/params";
import { cn } from "@/lib/utils";

// La barra della lista dei pazienti: il campo "Cerca paziente" e i
// sei filtri con il loro conteggio. Lo stato sta nell'URL: la ricerca vi arriva 250 ms dopo l'ultimo
// tasto, i filtri sono link veri. I conteggi li calcola il server sulla stessa ricerca.

const SEARCH_DEBOUNCE_MS = 250;
const LIST_PATH = "/pazienti";

/** L'indirizzo della lista per questi parametri; i valori predefiniti non si scrivono. */
export function listHref(params: PatientListParams): string {
  const query = new URLSearchParams();
  // Il testo cercato resta com'è scritto, spazi compresi: il campo lo confronta con l'URL.
  if (params.q !== "") query.set("q", params.q);
  if (params.filtro !== "tutti") query.set("filtro", params.filtro);
  if (params.ordina !== "paziente") query.set("ordina", params.ordina);
  if (params.verso !== "asc") query.set("verso", params.verso);
  const search = query.toString();
  return search === "" ? LIST_PATH : `${LIST_PATH}?${search}`;
}

export function PatientFilters({
  params,
  counts,
}: {
  params: PatientListParams;
  counts: Record<PatientFilter, number>;
}) {
  const router = useRouter();
  const inputId = useId();
  const [value, setValue] = useState(params.q);
  const [, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // I testi chiesti all'URL e non ancora tornati: un `q` che non ne fa parte viene da fuori (il link
  // "Pazienti" della sidebar, il tasto indietro) e il campo lo segue.
  const asked = useRef<string[]>([]);
  const shownQ = useRef(params.q);
  // I parametri di adesso: la ricerca parte dopo 250 ms e deve trovare il filtro e l'ordine di quel
  // momento, non quelli di quando si è cominciato a scrivere.
  const current = useRef(params);

  useEffect(() => {
    current.current = params;
  }, [params]);

  useEffect(() => {
    shownQ.current = params.q;
    const index = asked.current.indexOf(params.q);
    if (index >= 0) {
      asked.current = asked.current.slice(index + 1);
      return;
    }
    asked.current = [];
    clearTimeout(timer.current);
    setValue(params.q);
  }, [params.q]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onSearch = (next: string) => {
    setValue(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (next === shownQ.current) return;
      asked.current.push(next);
      startTransition(() => router.replace(listHref({ ...current.current, q: next }), { scroll: false }));
    }, SEARCH_DEBOUNCE_MS);
  };

  // Un filtro scelto mentre il testo aspetta porta il testo con sé: la ricerca in attesa non serve più.
  const onFilter = () => {
    clearTimeout(timer.current);
    if (value !== shownQ.current) asked.current.push(value);
  };

  return (
    <div className="flex flex-col gap-3">
      <div role="search" className="flex max-w-sm flex-col gap-1.5">
        <Label htmlFor={inputId}>Cerca paziente</Label>
        <Input
          id={inputId}
          type="search"
          value={value}
          placeholder="Nome, cognome o telefono"
          autoComplete="off"
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>
      <nav aria-label="Filtri" className="flex flex-wrap gap-2">
        {PATIENT_FILTERS.map(({ code, label }) => {
          const selected = params.filtro === code;
          return (
            <Link
              key={code}
              href={listHref({ ...params, q: value, filtro: code })}
              onClick={onFilter}
              prefetch={false}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                selected ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
              )}
            >
              {`${label} (${counts[code]})`}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
