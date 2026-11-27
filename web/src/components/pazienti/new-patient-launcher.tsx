"use client";

import { createContext, type ReactNode, useContext, useState } from "react";

import { NewPatientDialog, type NewPatientDialogProps } from "@/components/pazienti/new-patient-dialog";
import { Button } from "@/components/ui/button";

// Il dialogo "Nuovo paziente" della lista, montato una volta sola per la pagina: il pulsante
// dell'intestazione e quello del vuoto della ricerca lo aprono entrambi. Se il dialogo stesse dentro il
// vuoto, la lista che cambia sotto la ricerca lo smonterebbe insieme al dialogo dell'appuntamento che
// "Salva e fissa un appuntamento" apre.

const DEFAULT_LABEL = "Nuovo paziente";

const LauncherContext = createContext<((lastName: string) => void) | null>(null);

export function NewPatientLauncher({
  children,
  ...creation
}: Omit<NewPatientDialogProps, "open" | "onOpenChange" | "initialLastName"> & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [lastName, setLastName] = useState("");
  return (
    <LauncherContext value={(initialLastName) => {
      setLastName(initialLastName);
      setOpen(true);
    }}>
      {children}
      <NewPatientDialog open={open} onOpenChange={setOpen} initialLastName={lastName} {...creation} />
    </LauncherContext>
  );
}

/** Un pulsante che apre il dialogo del lanciatore, col cognome già scritto se c'è. */
export function NewPatientTrigger({
  label = DEFAULT_LABEL,
  lastName = "",
  variant = "default",
}: {
  label?: string;
  lastName?: string;
  variant?: "default" | "outline";
}) {
  const launch = useContext(LauncherContext);
  if (launch === null) throw new Error("NewPatientTrigger va dentro NewPatientLauncher.");
  return (
    <Button type="button" variant={variant} onClick={() => launch(lastName)}>
      {label}
    </Button>
  );
}
