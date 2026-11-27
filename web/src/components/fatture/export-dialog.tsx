"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { eseCountAction } from "@/app/(app)/fatture/actions";
import { DOWNLOAD_ERROR, downloadFile } from "@/components/fatture/invoices-table";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { esePeriod } from "@/lib/fiscal/redact";

export function ExportDialog({ month, today, onClose, returnFocus }: {
  month: string; today: string; onClose: () => void; returnFocus: HTMLElement | null;
}) {
  const id = useId();
  const [from, setFrom] = useState(month);
  const [to, setTo] = useState(month);
  const [result, setResult] = useState<{ key: string; count?: number; error?: string }>();
  const [pending, start] = useTransition();
  const [downloading, setDownloading] = useState(false);
  const key = `${from}/${to}`;
  const valid = esePeriod(from, to) !== null;
  useEffect(() => {
    if (!valid) return;
    let active = true;
    start(async () => {
      try {
        const response = await eseCountAction({ da: from, a: to });
        if (active) setResult(response.ok ? { key, count: response.data } : { key, error: response.message });
      } catch { if (active) setResult({ key, error: "Non riesco a caricare questo elenco." }); }
    });
    return () => { active = false; };
  }, [from, to, key, valid]);
  const ready = valid && !pending && result?.key === key && result.count !== undefined;
  const count = ready ? result.count! : 0;
  const query = new URLSearchParams({ da: from, a: to }).toString();
  return <Dialog open onOpenChange={(open) => { if (!open && !downloading) onClose(); }}>
    <DialogContent className="sm:max-w-3xl" finalFocus={() => returnFocus}>
      <DialogHeader><DialogTitle>{"Esporta per l'elenco speciale"}</DialogTitle>
        <DialogDescription>{"Per la domanda all'Ordine servono le fatture con i dati dei pazienti oscurati."}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1"><Label htmlFor={`${id}-da`}>Da</Label><Input id={`${id}-da`} type="month" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor={`${id}-a`}>A</Label><Input id={`${id}-a`} type="month" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <Button variant="outline" onClick={() => { setFrom(today.slice(0, 7)); setTo(today.slice(0, 7)); }}>Solo questo mese</Button>
      </div>
      {!valid ? <p role="alert" className="text-sm text-destructive">Periodo non valido. Scegli da 1 a 12 mesi.</p>
        : result?.key === key && result.error ? <p role="alert" className="text-sm text-destructive">{result.error}</p>
          : <p role="status">{ready ? `Documenti: ${count}` : "Conteggio dei documenti in corso…"}</p>}
      {ready && count === 0 && <p>Nessuna fattura nel periodo scelto.</p>}
      {ready && count > 0 && <iframe key={query} title="Anteprima della fattura oscurata" src={`/api/fatture/export/anteprima?${query}`}
        className="h-[min(50vh,28rem)] w-full rounded-lg border" onError={() => toast.error(DOWNLOAD_ERROR)} />}
      <DialogFooter>
        <Button variant="outline" disabled={downloading} onClick={onClose}>Torna indietro</Button>
        <Button disabled={!ready || count === 0 || downloading} onClick={() => {
          setDownloading(true);
          void downloadFile(`/api/fatture/export?${query}`, "elenco-speciale.zip")
            .catch(() => toast.error(DOWNLOAD_ERROR)).finally(() => setDownloading(false));
        }}>Scarica ZIP</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
