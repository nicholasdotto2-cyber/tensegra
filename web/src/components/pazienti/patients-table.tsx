"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { listHref } from "@/components/pazienti/patient-filters";
import { RecallActions, type RecallBooking } from "@/components/pazienti/recall-actions";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type PatientListParams, patientHref } from "@/lib/patients/params";
import type { PatientList } from "@/server/domain/patients/list";

// La tabella della lista dei pazienti: "Cognome Nome" con l'età
// sotto, telefono, ciclo, prossimo appuntamento, richiamo e consensi. Si ordinano solo "Paziente" e
// "Prossimo appuntamento", con un pulsante nell'intestazione e `aria-sort`; l'ordine sta nell'URL. Il
// nome è il link vero alla scheda. I vuoti stanno nella pagina, che ha il pulsante per creare. Nel filtro
// «Da richiamare» ogni riga ha le azioni del richiamo di Oggi in una colonna in più.

type Column = PatientListParams["ordina"];

const NONE = "Nessuno";
const NO_PHONE = "Non indicato";

function SortHead({ column, label, params }: { column: Column; label: string; params: PatientListParams }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const active = params.ordina === column;
  const ascending = params.verso === "asc";
  const Icon = !active ? ArrowUpDown : ascending ? ArrowUp : ArrowDown;
  // Un clic sulla colonna in uso inverte il verso; un'altra colonna parte dal crescente.
  const next = { ...params, ordina: column, verso: active && ascending ? ("desc" as const) : ("asc" as const) };

  return (
    <TableHead aria-sort={!active ? "none" : ascending ? "ascending" : "descending"}>
      <button
        type="button"
        aria-busy={pending}
        onClick={() => startTransition(() => router.push(listHref(next), { scroll: false }))}
        className="-mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {label}
        <Icon aria-hidden="true" className="size-3.5" />
      </button>
    </TableHead>
  );
}

export function PatientsTable({
  list,
  params,
  booking,
}: {
  list: PatientList;
  params: PatientListParams;
  booking: RecallBooking;
}) {
  const recallActions = params.filtro === "da_richiamare";
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {/* In «Da richiamare» l'ordine è quello dei richiami: niente ordinamento per colonna. */}
          {recallActions ? <TableHead>Paziente</TableHead> : <SortHead column="paziente" label="Paziente" params={params} />}
          <TableHead>Telefono</TableHead>
          <TableHead>Ciclo</TableHead>
          {recallActions ? (
            <TableHead>Prossimo appuntamento</TableHead>
          ) : (
            <SortHead column="prossimo" label="Prossimo appuntamento" params={params} />
          )}
          <TableHead>Richiamo</TableHead>
          <TableHead>Consensi</TableHead>
          {recallActions ? <TableHead>Azioni del richiamo</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <div className="flex flex-col">
                <Link
                  href={patientHref(row.id)}
                  prefetch={false}
                  className="w-fit rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {row.name}
                </Link>
                <span className="text-sm text-muted-foreground">{row.ageText}</span>
              </div>
            </TableCell>
            <TableCell className="whitespace-nowrap">{row.phoneText ?? NO_PHONE}</TableCell>
            <TableCell>{row.cycleText}</TableCell>
            <TableCell className="whitespace-nowrap">
              {row.nextAt === null ? NONE : <time dateTime={row.nextAt}>{row.nextText}</time>}
            </TableCell>
            <TableCell>
              <div className={row.recall?.waitingUntil ? "flex flex-col text-muted-foreground" : "flex flex-col"}>
                <span>{row.recallText}</span>
                {row.recall?.waitingText ? <span className="text-sm text-muted-foreground">{row.recall.waitingText}</span> : null}
              </div>
            </TableCell>
            <TableCell>{row.consentText}</TableCell>
            {recallActions ? (
              <TableCell className="align-top">{row.recall ? <RecallActions row={row.recall} booking={booking} /> : null}</TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
