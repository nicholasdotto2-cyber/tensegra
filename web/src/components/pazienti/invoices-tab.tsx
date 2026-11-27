import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dayField, money } from "@/lib/format";
import type { InvoiceRow } from "@/server/domain/invoices/queries";

// La tab Fatture della scheda: le fatture e le note di credito del paziente o
// intestate a un suo genitore, fuori dalla bozza, con le colonne della tabella delle Emesse e i
// link PDF e XML, senza il menu delle azioni: incasso e annullamento si fanno dalla pagina Fatture. Il numero
// porta al dettaglio della fattura.

const EMPTY = "Nessuna fattura per questo paziente.";

function StatusBadge({ row }: { row: InvoiceRow }) {
  if (row.docType === "TD04") return <Badge variant="outline">Nota di credito</Badge>;
  switch (row.status) {
    case "emessa":
      return <Badge className="bg-warning text-warning-foreground">Da incassare</Badge>;
    case "pagata":
      return <Badge className="bg-success text-success-foreground">Pagata</Badge>;
    case "annullata":
      return (
        <span className="flex flex-wrap items-center gap-x-2">
          <Badge variant="outline">Annullata</Badge>
          {row.creditNote === null ? null : (
            <Link href={`/fatture/${row.creditNote.id}`} prefetch={false} className="underline underline-offset-4">
              {row.creditNote.numberLabel}
            </Link>
          )}
        </span>
      );
    case "bozza":
      return <Badge variant="outline">Bozza</Badge>;
  }
}

export function InvoicesTabView({ rows }: { rows: InvoiceRow[] }) {
  if (rows.length === 0) return <p>{EMPTY}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Numero</TableHead>
          <TableHead>Data</TableHead>
          <TableHead>Intestatario</TableHead>
          <TableHead>Prestazione</TableHead>
          <TableHead className="text-right">Totale</TableHead>
          <TableHead>Bollo</TableHead>
          <TableHead>Stato</TableHead>
          <TableHead>
            <span className="sr-only">Documenti</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const document = row.docType === "TD04" ? "della nota di credito" : "della fattura";
          return (
            <TableRow key={row.id}>
              <TableCell className="font-medium tabular-nums">
                <Link href={`/fatture/${row.id}`} prefetch={false} className="underline underline-offset-4">
                  {row.numberLabel}
                </Link>
              </TableCell>
              <TableCell className="tabular-nums">
                {row.issueDate === null ? null : <time dateTime={row.issueDate}>{dayField(row.issueDate)}</time>}
              </TableCell>
              <TableCell>
                <span className="flex flex-col">
                  <span>{row.recipientText}</span>
                  {row.minorText === null ? null : <span className="text-muted-foreground">{row.minorText}</span>}
                </span>
              </TableCell>
              <TableCell className="whitespace-normal">{row.serviceText}</TableCell>
              <TableCell className="text-right tabular-nums">{money(row.totalCents)}</TableCell>
              <TableCell>{row.stampDue ? "Sì" : "No"}</TableCell>
              <TableCell>
                <StatusBadge row={row} />
              </TableCell>
              <TableCell>
                <span className="flex gap-1">
                  <a
                    href={`/api/fatture/${row.id}/pdf?download=1`}
                    download
                    aria-label={`PDF ${document} ${row.numberLabel ?? ""}`.trim()}
                    className={buttonVariants({ variant: "link", size: "sm" })}
                  >
                    PDF
                  </a>
                  {row.hasXml ? (
                    <a
                      href={`/api/fatture/${row.id}/xml`}
                      download
                      aria-label={`XML ${document} ${row.numberLabel ?? ""}`.trim()}
                      className={buttonVariants({ variant: "link", size: "sm" })}
                    >
                      XML
                    </a>
                  ) : null}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
