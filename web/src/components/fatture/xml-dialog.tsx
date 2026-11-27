"use client";

import { useRef, useState, useTransition } from "react";
import { invoiceXmlAction } from "@/app/(app)/fatture/[id]/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// "Vedi XML": il testo dell'XML salvato all'emissione in un `<pre>`,
// senza il foglio di stile ufficiale. Si legge a ogni apertura e non scrive niente: il download resta "Scarica XML".

type XmlState = { kind: "loading" } | { kind: "ready"; xml: string } | { kind: "error"; message: string };

const READ_ERROR = "Non riesco a leggere l'XML. Riprova.";
const NO_XML = "Questa fattura non ha un XML.";

export function XmlDialog({ invoiceId, title }: { invoiceId: string; title: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<XmlState>({ kind: "loading" });
  const [, start] = useTransition();

  function show() {
    setState({ kind: "loading" });
    setOpen(true);
    start(async () => {
      try {
        const result = await invoiceXmlAction(invoiceId);
        if (!result.ok) setState({ kind: "error", message: result.message });
        else if (result.data === null) setState({ kind: "error", message: NO_XML });
        else setState({ kind: "ready", xml: result.data });
      } catch {
        setState({ kind: "error", message: READ_ERROR });
      }
    });
  }

  return <>
    <Button ref={trigger} variant="outline" onClick={show}>Vedi XML</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent finalFocus={trigger} className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Il file salvato all&apos;emissione, senza modifiche.</DialogDescription>
        </DialogHeader>
        {state.kind === "loading" && <p role="status" className="text-muted-foreground">Carico l&apos;XML.</p>}
        {state.kind === "error" && <p role="alert" className="text-destructive">{state.message}</p>}
        {state.kind === "ready" && (
          <pre tabIndex={0} aria-label="Testo dell'XML" className="min-h-0 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {state.xml}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  </>;
}
