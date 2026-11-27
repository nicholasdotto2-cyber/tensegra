"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useState } from "react";
import { toast } from "sonner";

import { cycleClosingAction } from "@/app/(app)/pazienti/[id]/actions";
import { CloseForm } from "@/components/cartella/cycle-close-form";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { CycleClosingView } from "@/server/domain/cycles/queries";

// Legge la finestra "Chiudi ciclo" di un ciclo (`cycleClosingAction`, sola lettura) e mostra lo scheletro, l'errore
// o il modulo. Vive dentro il contenuto del dialogo, quindi nasce a ogni apertura e rilegge ogni volta.

const ALREADY_CLOSED = "Il ciclo è già chiuso.";

type Loaded = { cycleId: string; view: CycleClosingView } | { cycleId: string; error: string };

export function CloseLoader({
  cycleId,
  onClose,
  onClosed,
}: {
  cycleId: string;
  onClose: () => void;
  onClosed?: () => void;
}) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Un ciclo già chiuso (da un'altra finestra) non ha la finestra: si dice e la pagina si rilegge.
  const closeStale = useEffectEvent(() => {
    toast.error(ALREADY_CLOSED);
    router.refresh();
    onClose();
  });

  useEffect(() => {
    let current = true;
    void cycleClosingAction(cycleId).then((result) => {
      if (!current) return;
      if (!result.ok) setLoaded({ cycleId, error: result.message });
      else if (result.data === null) closeStale();
      else setLoaded({ cycleId, view: result.data });
    });
    return () => {
      current = false;
    };
  }, [cycleId]);

  const shown = loaded !== null && loaded.cycleId === cycleId ? loaded : null;
  if (shown === null) {
    return (
      <div className="flex flex-col gap-3" aria-hidden="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if ("error" in shown) {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert">{shown.error}</p>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Torna indietro</DialogClose>
        </DialogFooter>
      </div>
    );
  }
  return (
    <>
      <DialogDescription>{shown.view.title}</DialogDescription>
      <CloseForm view={shown.view} onClose={onClose} onClosed={onClosed} />
    </>
  );
}
