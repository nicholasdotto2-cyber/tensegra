"use client";

import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { recreateDemoDataAction } from "@/app/(app)/recreate-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

// Il layout conosce modalità e studio: anche il pulsante nelle impostazioni segue gli stessi permessi.
const RecreateDemoAllowed = createContext(false);

export function RecreateDemoProvider({ allowed, children }: { allowed: boolean; children: ReactNode }) {
  return <RecreateDemoAllowed.Provider value={allowed}>{children}</RecreateDemoAllowed.Provider>;
}

export function RecreateDemoButton({ label }: { label: "Ricrea per oggi" | "Ricrea i dati di prova per oggi" }) {
  const allowed = useContext(RecreateDemoAllowed);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  if (!allowed) return null;

  const recreate = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await recreateDemoDataAction();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      router.push("/oggi");
      router.refresh();
    } catch {
      setError("Non riesco a ricreare i dati. Riprova.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (inFlight.current) return;
      setError(null);
      setOpen(next);
    }}>
      <DialogTrigger disabled={pending} render={<Button type="button" variant="outline" size="sm" />}>{label}</DialogTrigger>
      <DialogContent showCloseButton={!pending}>
        <DialogTitle>Ricrea i dati di prova per oggi</DialogTitle>
        <DialogDescription>
          Tutto ciò che hai inserito o modificato verrà cancellato e sostituito con i dati di prova di oggi.
        </DialogDescription>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>Annulla</DialogClose>
          <Button type="button" disabled={pending} onClick={() => void recreate()}>
            {pending ? "Sto ricreando i dati..." : "Ricrea i dati"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
