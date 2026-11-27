"use client";

import Link from "next/link";
import { useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { dayField, money } from "@/lib/format";
import type { InvoiceRow } from "@/server/domain/invoices/queries";

export type InvoiceIntent = InvoiceRow["actions"][number] | "modifica";
type OnAction = (row: InvoiceRow, action: InvoiceIntent, returnFocus: HTMLElement | null) => void;
const ACTIONS = { registra_incasso: "Registra incasso", annulla_incasso: "Annulla incasso", annulla: "Annulla con nota di credito" };
export const DOWNLOAD_ERROR = "Download non riuscito. Riprova.";

/** Verifica la risposta prima di avviare il download: anche un link deve mostrare l'errore della route. */
export async function downloadFile(href: string, fallback: string) {
  const response = await fetch(href);
  if (!response.ok) throw new Error(DOWNLOAD_ERROR);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? fallback;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Status({ row }: { row: InvoiceRow }) {
  const text = row.docType === "TD04" ? "Nota di credito"
    : { bozza: "Bozza", emessa: "Da incassare", pagata: "Pagata", annullata: "Annullata" }[row.status];
  const color = row.docType === "TD04" ? "bg-muted text-muted-foreground"
    : row.status === "emessa" ? "bg-warning text-warning-foreground"
      : row.status === "pagata" ? "bg-success text-success-foreground" : "bg-muted text-muted-foreground";
  return <div className="flex flex-wrap items-center gap-2">
    <span className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${color}`}>{text}</span>
    {row.creditNote && <Link className="min-h-6 underline underline-offset-4" href={`/fatture/${row.creditNote.id}`} prefetch={false}>{row.creditNote.numberLabel}</Link>}
  </div>;
}

function RowActions({ row, onAction }: { row: InvoiceRow; onAction: OnAction }) {
  const trigger = useRef<HTMLButtonElement>(null);
  if (row.status === "bozza") return <Button variant="outline" onClick={(e) => onAction(row, "modifica", e.currentTarget)}>Modifica</Button>;
  return <div className="flex flex-wrap items-center gap-3">
    {(["pdf", ...(row.hasXml ? ["xml"] : [])] as const).map((kind) => (
      <a key={kind} className="inline-flex min-h-8 items-center underline underline-offset-4" href={`/api/fatture/${row.id}/${kind}?download=1`}
        onClick={(e) => { e.preventDefault(); void downloadFile(`/api/fatture/${row.id}/${kind}?download=1`, `fattura.${kind}`).catch(() => toast.error(DOWNLOAD_ERROR)); }}>
        {kind.toUpperCase()}
      </a>
    ))}
    {row.actions.length > 0 && <DropdownMenu>
      <DropdownMenuTrigger ref={trigger} render={<Button variant="outline" size="sm" />} aria-label="Altre azioni">Altre azioni</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {row.actions.map((action) => <DropdownMenuItem key={action} onClick={() => onAction(row, action, trigger.current)}>{ACTIONS[action]}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>}
  </div>;
}

function NumberLink({ row }: { row: InvoiceRow }) {
  return row.numberLabel ? <Link className="inline-flex min-h-6 items-center font-medium underline underline-offset-4" href={`/fatture/${row.id}`} prefetch={false}>{row.numberLabel}</Link> : <span>Bozza</span>;
}

export function InvoicesTable({ rows, empty, onAction }: { rows: InvoiceRow[]; empty: string; onAction: OnAction }) {
  if (rows.length === 0) return <p className="rounded-xl border p-6 text-muted-foreground">{empty}</p>;
  return <>
    <div className="hidden overflow-x-auto rounded-xl border lg:block">
      <table className="w-full text-left text-sm" aria-label="Fatture">
        <thead className="border-b bg-muted/40"><tr>
          {["Numero", "Data", "Intestatario", "Prestazione", "Totale", "Bollo", "Stato", "Azioni"].map((label) => <th key={label} scope="col" className="px-4 py-3 font-medium">{label}</th>)}
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id} className="border-b last:border-b-0">
          <td className="px-4 py-3"><NumberLink row={row} /></td>
          <td className="whitespace-nowrap px-4 py-3">{row.issueDate ? dayField(row.issueDate) : "Da assegnare"}</td>
          <td className="px-4 py-3">{row.recipientText}{row.minorText && <p className="text-xs text-muted-foreground">{row.minorText}</p>}</td>
          <td className="px-4 py-3">{row.serviceText}</td>
          <td className="whitespace-nowrap px-4 py-3 tabular-nums">{money(row.totalCents)}</td>
          <td className="px-4 py-3">{row.stampDue ? "Sì" : "No"}</td>
          <td className="px-4 py-3"><Status row={row} /></td>
          <td className="px-4 py-3"><RowActions row={row} onAction={onAction} /></td>
        </tr>)}</tbody>
      </table>
    </div>
    <ul aria-label="Fatture" className="space-y-3 lg:hidden">{rows.map((row) => <li key={row.id} className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2"><NumberLink row={row} /><Status row={row} /></div>
      <p className="font-medium">{row.recipientText}{row.minorText && <span className="block text-sm font-normal text-muted-foreground">{row.minorText}</span>}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>Data</dt><dd>{row.issueDate ? dayField(row.issueDate) : "Da assegnare"}</dd>
        <dt>Prestazione</dt><dd>{row.serviceText}</dd>
        <dt>Totale</dt><dd className="tabular-nums">{money(row.totalCents)}</dd>
        <dt>Bollo</dt><dd>{row.stampDue ? "Sì" : "No"}</dd>
      </dl>
      <RowActions row={row} onAction={onAction} />
    </li>)}</ul>
  </>;
}
