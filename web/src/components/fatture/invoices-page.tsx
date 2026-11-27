"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { CancelDialog } from "@/components/fatture/cancel-dialog";
import { ExportDialog } from "@/components/fatture/export-dialog";
import { InvoiceEditorSheet } from "@/components/fatture/invoice-editor";
import { type InvoiceIntent, InvoicesTable } from "@/components/fatture/invoices-table";
import { MonthTiles } from "@/components/fatture/month-tiles";
import { NoInvoiceDialog } from "@/components/fatture/no-invoice-dialog";
import { PaymentDialog } from "@/components/fatture/payment-dialog";
import { PageHeader } from "@/components/shell/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { patchInvoiceList } from "@/lib/fiscal/list-navigation";
import type { InvoiceListParams } from "@/lib/fiscal/list-params";
import { dayField, money, monthYear } from "@/lib/format";
import type { Settled } from "@/server/db/settle";
import type { EditorStart, InvoiceRow, MonthTiles as Tiles, ToInvoiceRow } from "@/server/domain/invoices/queries";

interface Props {
  params: InvoiceListParams;
  today: string;
  toInvoice: Settled<ToInvoiceRow[]>;
  drafts: Settled<InvoiceRow[]>;
  invoices: Settled<InvoiceRow[]>;
  tiles: Settled<Tiles>;
}
type DialogState = { kind: "payment" | "undo" | "cancel"; row: InvoiceRow; returnFocus: HTMLElement | null }
  | { kind: "skip"; row: ToInvoiceRow; returnFocus: HTMLElement | null }
  | { kind: "export"; returnFocus: HTMLElement | null };

function href(params: InvoiceListParams, patch: Partial<InvoiceListParams> = {}) {
  const next = { ...params, ...patch };
  return `/fatture?${new URLSearchParams({ tab: next.tab, anno: String(next.anno), mese: next.mese, stato: next.stato, q: next.q })}`;
}
/** Come il server rilegge l'URL: la ricerca arriva senza spazi ai lati. */
const listKey = (params: InvoiceListParams) => href({ ...params, q: params.q.trim() });

function BlockError() {
  const router = useRouter();
  return <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
    <p>Non riesco a caricare questo elenco.</p><Button variant="outline" onClick={() => router.refresh()}>Riprova</Button>
  </div>;
}

export function InvoicesPage({ params, today, toInvoice, drafts, invoices, tiles }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editor, setEditor] = useState<EditorStart | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [search, setSearch] = useState(params.q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // L'ultimo elenco chiesto, aggiornato prima del router: il cambio successivo parte da qui, non dalle props.
  const current = useRef(params);
  const requested = useRef<string[]>([]);
  const asked = useRef<string[]>([]);
  const shownQ = useRef(params.q);
  const newButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    // La risposta di una navigazione già superata da un cambio successivo non riporta indietro l'elenco chiesto;
    // ogni altra (l'ultima chiesta, Indietro/Avanti, un link) rilegge l'URL.
    // lastIndexOf: con A, B, A arriva solo l'ultima A, che non è superata.
    const index = requested.current.lastIndexOf(listKey(params));
    if (index >= 0 && index < requested.current.length - 1) { requested.current = requested.current.slice(index + 1); return; }
    requested.current = [];
    current.current = params;
  }, [params]);
  useEffect(() => {
    shownQ.current = params.q;
    const index = asked.current.indexOf(params.q);
    if (index >= 0) { asked.current = asked.current.slice(index + 1); return; }
    asked.current = [];
    if (timer.current) clearTimeout(timer.current);
    setSearch(params.q);
  }, [params.q]);
  /** `push` per le tab, che come link aggiungono una voce alla cronologia; i filtri la sostituiscono. */
  function change(patch: Partial<InvoiceListParams>, history: "replace" | "push" = "replace") {
    if (timer.current) clearTimeout(timer.current);
    // Il server restituisce q senza spazi ai bordi: si confronta con la stessa forma.
    if (patch.q !== undefined && patch.q !== shownQ.current) asked.current.push(patch.q.trim());
    const next = patchInvoiceList(current.current, patch);
    current.current = next;
    requested.current.push(listKey(next));
    start(() => history === "push" ? router.push(href(next)) : router.replace(href(next), { scroll: false }));
  }
  function rowAction(row: InvoiceRow, action: InvoiceIntent, returnFocus: HTMLElement | null) {
    if (action === "modifica") setEditor({ kind: "draft", invoiceId: row.id });
    else setDialog({ kind: action === "registra_incasso" ? "payment" : action === "annulla_incasso" ? "undo" : "cancel", row, returnFocus });
  }
  const tabNames: { tab: InvoiceListParams["tab"]; label: string }[] = [
    { tab: "da_emettere", label: `Da emettere (${toInvoice.ok ? toInvoice.value.length : "?"})` },
    { tab: "emesse", label: "Emesse" },
    ...(!drafts.ok || drafts.value.length > 0 ? [{ tab: "bozze" as const, label: `Bozze (${drafts.ok ? drafts.value.length : "?"})` }] : []),
  ];
  const year = Number(today.slice(0, 4));
  const years = Array.from(new Set([params.anno, ...Array.from({ length: 11 }, (_, i) => year + 1 - i)])).sort((a, b) => b - a);
  const monthName = monthYear(`${params.mese}-01`).split(" ")[0];
  const close = () => {
    const target = dialog?.returnFocus;
    setDialog(null);
    requestAnimationFrame(() => (target?.isConnected ? target : newButton.current)?.focus());
  };
  return <div className="space-y-6">
    <PageHeader title="Fatture" actions={<>
      <div className="flex items-center gap-2"><Label htmlFor="fatture-anno">Anno</Label>
        <select id="fatture-anno" value={params.anno} className="h-9 rounded-md border bg-background px-2 text-sm" onChange={(e) => {
          change({ anno: Number(e.target.value), q: search });
        }}>{years.map((anno) => <option key={anno} value={anno}>{anno}</option>)}</select>
      </div>
      <Button variant="outline" onClick={(e) => setDialog({ kind: "export", returnFocus: e.currentTarget })}>{"Esporta per l'elenco speciale"}</Button>
      <Button ref={newButton} onClick={() => setEditor({ kind: "new" })}>Nuova fattura</Button>
    </>} />
    <p className="rounded-xl border bg-muted/40 p-4 text-sm">Questa versione crea PDF e XML ma non li invia allo SdI.</p>
    <nav aria-label="Elenchi delle fatture" className="flex flex-wrap gap-2 border-b pb-3">
      {tabNames.map(({ tab, label }) => <Link key={tab} href={href(params, { tab, q: search })} prefetch={false}
        onClick={(e) => {
          // Un clic con un tasto modificatore (nuova scheda o finestra) resta al browser.
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          // L'href viene dalle props: un filtro ancora in attesa del router non c'è. Si parte dall'ultimo elenco chiesto.
          e.preventDefault();
          change({ tab, q: search }, "push");
        }} aria-current={params.tab === tab ? "page" : undefined}
        className={buttonVariants({ variant: params.tab === tab ? "secondary" : "ghost" })}>{label}</Link>)}
    </nav>
    <div aria-busy={pending} className="space-y-5">
      {params.tab === "da_emettere" && (!toInvoice.ok ? <BlockError /> : toInvoice.value.length === 0
        ? <p className="rounded-xl border p-6 text-muted-foreground">Nessuna fattura da emettere.</p>
        : <ul aria-label="Sedute da fatturare" className="divide-y rounded-xl border">{toInvoice.value.map((row) => <li key={row.appointmentId} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div><Link className="inline-flex min-h-6 items-center font-medium underline underline-offset-4" href={`/pazienti/${row.patientId}`}>{row.patientName}</Link>
            <p className="text-sm text-muted-foreground">{dayField(row.day)}, {row.serviceName}</p><p className="text-sm tabular-nums">{money(row.priceCents)}</p>
          </div>
          <div className="flex flex-wrap gap-2"><Button onClick={() => setEditor({ kind: "appointment", appointmentId: row.appointmentId })}>Emetti</Button>
            <Button variant="outline" onClick={(e) => setDialog({ kind: "skip", row, returnFocus: e.currentTarget })}>Non fatturare</Button></div>
        </li>)}</ul>)}
      {params.tab === "emesse" && <>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label htmlFor="fatture-mese">Mese</Label>
            <Input className="w-auto" id="fatture-mese" type="month" value={params.mese} onChange={(e) => {
              if (/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(e.target.value)) change({ mese: e.target.value, q: search });
            }} /></div>
        </div>
        {tiles.ok ? <MonthTiles tiles={tiles.value} /> : <BlockError />}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label htmlFor="fatture-stato">Stato</Label>
            <select id="fatture-stato" value={params.stato} className="h-9 rounded-md border bg-background px-2 text-sm" onChange={(e) => change({ stato: e.target.value as InvoiceListParams["stato"], q: search })}>
              <option value="tutte">Tutte</option><option value="da_incassare">Da incassare</option><option value="pagate">Pagate</option><option value="annullate">Annullate</option>
            </select></div>
          <div className="min-w-52 flex-1 space-y-1"><Label htmlFor="fatture-ricerca">Cerca per numero o nome</Label>
            <Input id="fatture-ricerca" value={search} placeholder="Numero o nome" onChange={(e) => {
              const q = e.target.value;
              setSearch(q);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => change({ q }), 250);
            }} /></div>
        </div>
        {invoices.ok ? <InvoicesTable rows={invoices.value} empty={`Nessuna fattura emessa a ${monthName}.`} onAction={rowAction} /> : <BlockError />}
      </>}
      {params.tab === "bozze" && (drafts.ok ? <InvoicesTable rows={drafts.value} empty="Nessuna bozza di fattura." onAction={rowAction} /> : <BlockError />)}
    </div>
    <InvoiceEditorSheet start={editor} onClose={() => setEditor(null)} />
    {dialog?.kind === "export" && <ExportDialog month={params.mese} today={today} onClose={close} returnFocus={dialog.returnFocus} />}
    {dialog?.kind === "skip" && <NoInvoiceDialog row={dialog.row} onClose={close} returnFocus={dialog.returnFocus} />}
    {dialog?.kind === "cancel" && <CancelDialog row={dialog.row} onClose={close} returnFocus={dialog.returnFocus} />}
    {(dialog?.kind === "payment" || dialog?.kind === "undo") && <PaymentDialog row={dialog.row} undo={dialog.kind === "undo"} today={today} onClose={close} returnFocus={dialog.returnFocus} />}
  </div>;
}
