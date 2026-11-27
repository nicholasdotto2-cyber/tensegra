"use client";

import { Ellipsis } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { archivePatientAction, deletePatientAction, restorePatientAction } from "@/app/(app)/pazienti/[id]/actions";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ActionResult } from "@/server/actions/result";

// Il menu della testata: "Archivia" c'è sempre per un paziente attivo
// ma si disattiva, con la frase sotto, quando ha appuntamenti futuri; "Ripristina" riporta un archiviato in
// lista senza conferma; "Elimina definitivamente" compare solo se nessun dato è collegato al paziente. Archivia
// ed Elimina chiedono conferma con il nome. Dopo un'eliminazione si torna alla lista.

type Confirm = "archive" | "delete";

export function PatientMenu({
  patientId,
  name,
  archived,
  archiveBlock,
  canDelete,
}: {
  patientId: string;
  /** "Nome Cognome", ripetuto nelle conferme. */
  name: string;
  archived: boolean;
  /** Perché non si archivia ("Prima annulla i 2 appuntamenti futuri."); null se si può. */
  archiveBlock: string | null;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [pending, startPending] = useTransition();
  // Il pulsante del menu: le conferme gli restituiscono il focus, perché la voce che le apre sparisce col menu.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const blockId = useId();
  // Dopo l'eliminazione la pagina passa alla lista: il pulsante non riparte nel frattempo.
  const [gone, setGone] = useState(false);

  const run = (action: () => Promise<ActionResult<void>>, after?: () => void) => {
    startPending(async () => {
      const result = await action();
      if (result.ok) {
        after?.();
        return;
      }
      toast.error(result.message);
      setConfirm(null);
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button ref={triggerRef} type="button" variant="outline" size="icon" aria-label="Altre azioni" />}
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {archived ? (
            <DropdownMenuItem disabled={pending} onClick={() => run(() => restorePatientAction(patientId))}>
              Ripristina
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem
                disabled={archiveBlock !== null}
                aria-describedby={archiveBlock === null ? undefined : blockId}
                onClick={() => setConfirm("archive")}
              >
                Archivia
              </DropdownMenuItem>
              {archiveBlock === null ? null : (
                <p id={blockId} className="px-1.5 pb-1 text-sm text-muted-foreground">
                  {archiveBlock}
                </p>
              )}
            </>
          )}
          {canDelete ? (
            <DropdownMenuItem variant="destructive" onClick={() => setConfirm("delete")}>
              Elimina definitivamente
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirm === "archive"} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent finalFocus={triggerRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Archiviare ${name}?`}</AlertDialogTitle>
            <AlertDialogDescription>Il paziente esce da liste e ricerche. Lo ritrovi in Archiviati.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Torna indietro</AlertDialogCancel>
            <Button
              type="button"
              disabled={pending}
              onClick={() => run(() => archivePatientAction(patientId), () => setConfirm(null))}
            >
              Archivia
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "delete"} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent finalFocus={triggerRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Eliminare definitivamente ${name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              Il paziente e i suoi genitori o tutori spariscono. Non si può annullare.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Torna indietro</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={pending || gone}
              onClick={() =>
                run(
                  () => deletePatientAction(patientId),
                  () => {
                    setGone(true);
                    router.push("/pazienti");
                  },
                )
              }
            >
              Elimina definitivamente
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
