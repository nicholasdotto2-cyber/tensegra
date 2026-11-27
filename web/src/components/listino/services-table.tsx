"use client";

import { Archive, CircleCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  archiveServiceAction,
  createDefaultServicesAction,
  deleteServiceAction,
  restoreServiceAction,
} from "@/app/(app)/listino/actions";
import { ServiceSheet } from "@/components/listino/service-sheet";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { COLOR_LABEL, SERVICE_COLOR_CLASS } from "@/lib/agenda/colors";
import { KIND_LABEL } from "@/lib/agenda/defaults";
import { durationShort, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/server/actions/result";
import type { ServiceRow } from "@/server/domain/services/queries";

// La tabella del Listino: colore, nome, tipo, durata, prezzo, quante volte è usata e stato,
// con "Modifica" e, per una voce attiva, "Archivia" se è stata usata o "Elimina" se non lo è mai stata;
// "Ripristina" riattiva una archiviata, senza conferma. "Elimina" chiede conferma. Il
// pannello e la conferma stanno qui: la pagina passa solo le righe.

export function ServicesTable({ rows }: { rows: ServiceRow[] }) {
  const router = useRouter();
  const [pending, startPending] = useTransition();
  const [editing, setEditing] = useState<{ id: string | null; open: boolean }>({ id: null, open: false });
  const [deleting, setDeleting] = useState<{ id: string; name: string; open: boolean } | null>(null);

  // La riga si rilegge dalla pagina: dopo un salvataggio il pannello riaperto ha i valori nuovi.
  const editedRow = rows.find((row) => row.id === editing.id) ?? null;

  const run = (action: () => Promise<ActionResult<unknown>>, after?: () => void) => {
    startPending(async () => {
      const result = await action();
      after?.();
      if (!result.ok) {
        toast.error(result.message);
        if (result.conflict) router.refresh();
      }
    });
  };

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p>Il listino è vuoto.</p>
        <Button type="button" disabled={pending} onClick={() => run(() => createDefaultServicesAction())}>
          Crea le tre voci di partenza
        </Button>
      </div>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Colore</TableHead>
            <TableHead>Nome</TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead>Durata</TableHead>
            <TableHead className="text-right">Prezzo</TableHead>
            <TableHead className="text-right">Usata</TableHead>
            <TableHead>Stato</TableHead>
            <TableHead>
              <span className="sr-only">Azioni</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const archived = row.archivedAt !== null;
            return (
              <TableRow key={row.id} className={cn(archived && "text-muted-foreground")}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" className={cn("inline-block h-4 w-6 rounded-sm", SERVICE_COLOR_CLASS[row.color])} />
                    {COLOR_LABEL[row.color]}
                  </span>
                </TableCell>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell>{KIND_LABEL[row.kind]}</TableCell>
                <TableCell>{durationShort(row.durationMin)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(row.priceCents)}</TableCell>
                <TableCell className="text-right tabular-nums">{row.usedCount}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-1.5">
                    {archived ? <Archive aria-hidden="true" className="size-4" /> : <CircleCheck aria-hidden="true" className="size-4" />}
                    {archived ? "Archiviata" : "Attiva"}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Modifica ${row.name}`}
                      onClick={() => setEditing({ id: row.id, open: true })}
                    >
                      Modifica
                    </Button>
                    {archived ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        aria-label={`Ripristina ${row.name}`}
                        onClick={() => run(() => restoreServiceAction(row.id))}
                      >
                        Ripristina
                      </Button>
                    ) : null}
                    {!archived && !row.deletable ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        aria-label={`Archivia ${row.name}`}
                        onClick={() => run(() => archiveServiceAction(row.id))}
                      >
                        Archivia
                      </Button>
                    ) : null}
                    {row.deletable ? (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={pending}
                        aria-label={`Elimina ${row.name}`}
                        onClick={() => setDeleting({ id: row.id, name: row.name, open: true })}
                      >
                        Elimina
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <ServiceSheet
        open={editing.open}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
        service={editedRow}
      />

      <AlertDialog
        open={deleting?.open ?? false}
        onOpenChange={(open) => setDeleting((current) => (current === null ? null : { ...current, open }))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminare la prestazione {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>La voce sparisce dal listino.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Torna indietro</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (deleting === null) return;
                run(
                  () => deleteServiceAction(deleting.id),
                  () => setDeleting({ ...deleting, open: false }),
                );
              }}
            >
              Elimina
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
