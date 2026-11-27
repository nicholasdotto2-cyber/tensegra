"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AGENDA_FIRST_DAY, AGENDA_LAST_DAY } from "@/lib/agenda/grid";
import { cn } from "@/lib/utils";

// La barra dell'agenda: "Oggi", indietro, avanti, la data come pulsante che
// apre il calendario, l'interruttore Giorno/Settimana e, solo per la settimana, "Mostra annullati". Lo
// stato sta nell'URL (`/agenda?vista=settimana&data=2026-10-22`): ogni controllo porta a un indirizzo,
// così il tasto Indietro del browser torna alla settimana di prima. Le frecce sinistra e destra sul
// gruppo di navigazione cambiano giorno o settimana.

type View = "giorno" | "settimana";

const isView = (value: string | undefined): value is View => value === "giorno" || value === "settimana";

/** "Mostra annullati" resta nell'indirizzo anche nella vista Giorno, così torna acceso nella settimana. */
function agendaHref(view: View, day: string, showCancelled: boolean): string {
  return `/agenda?vista=${view}&data=${day}${showCancelled ? "&annullati=1" : ""}`;
}

// Si va alla data scritta solo con un gesto esplicito (WCAG 3.2.2): Invio, oppure chiudendo il
// calendario con un clic fuori o con Tab. Esc lo chiude e lascia la data com'era. Il campo si apre col
// giorno della pagina, quindi ogni segmento cambiato dà già una data valida (il giorno "10" su 04/11/2026
// fa 10/11/2026): andarci da soli, anche dopo una pausa, porterebbe a una data non ancora finita di
// scrivere e chiuderebbe il calendario sotto le dita.
function DateButton({ day, label, onPick }: { day: string; label: string; onPick: (day: string) => void }) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(day);

  // Una data vuota, a metà o fuori dagli anni dell'agenda (min e max del campo) non porta da nessuna parte.
  const valid = () => value !== "" && input.current?.validity.valid === true;

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (next) setValue(day);
        else if (details.reason !== "escape-key" && valid() && value !== day) onPick(value);
        setOpen(next);
      }}
    >
      <PopoverTrigger className={cn(buttonVariants({ variant: "ghost" }), "text-base font-semibold")}>{label}</PopoverTrigger>
      <PopoverContent align="start" className="w-auto">
        <div className="flex flex-col gap-2">
          <Label htmlFor={inputId}>Data</Label>
          <Input
            ref={input}
            id={inputId}
            type="date"
            value={value}
            min={AGENDA_FIRST_DAY}
            max={AGENDA_LAST_DAY}
            onChange={(event) => setValue(event.target.value)}
            // Invio qui, non con l'invio implicito di un form: Chromium non lo fa partire da un campo data.
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (!valid()) return;
              setOpen(false);
              if (value !== day) onPick(value);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function AgendaToolbar({
  view,
  day,
  label,
  prevDay,
  nextDay,
  today,
  showCancelled,
  actions,
}: {
  view: View;
  day: string;
  label: string;
  prevDay: string;
  nextDay: string;
  today: string;
  showCancelled: boolean;
  actions?: ReactNode;
}) {
  const router = useRouter();
  const switchId = useId();
  const switchLabelId = useId();
  const week = view === "settimana";
  const prevHref = agendaHref(view, prevDay, showCancelled);
  const nextHref = agendaHref(view, nextDay, showCancelled);

  const onNavigationKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    // Il calendario della data sta in un portale: i suoi tasti arrivano qui da React ma non dal gruppo,
    // e le frecce lì spostano il cursore fra giorno, mese e anno.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      router.push(prevHref);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      router.push(nextHref);
    }
  };

  // Le pagine dell'agenda hanno i dati dello studio, come le voci della sidebar: niente prefetch.
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div role="group" className="flex flex-wrap items-center gap-1" onKeyDown={onNavigationKeyDown}>
        <Link href={agendaHref(view, today, showCancelled)} prefetch={false} className={cn(buttonVariants({ variant: "outline" }))}>
          Oggi
        </Link>
        <Link
          href={prevHref}
          prefetch={false}
          aria-label={week ? "Settimana precedente" : "Giorno precedente"}
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
        >
          <ChevronLeft aria-hidden="true" />
        </Link>
        <Link
          href={nextHref}
          prefetch={false}
          aria-label={week ? "Settimana successiva" : "Giorno successivo"}
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }))}
        >
          <ChevronRight aria-hidden="true" />
        </Link>
        <DateButton day={day} label={label} onPick={(picked) => router.push(agendaHref(view, picked, showCancelled))} />
      </div>

      <ToggleGroup
        variant="outline"
        spacing={0}
        value={[view]}
        onValueChange={(value) => {
          const next = value[0];
          // Premere la vista già scelta non la toglie: resta quella.
          if (isView(next) && next !== view) router.push(agendaHref(next, day, showCancelled));
        }}
      >
        <ToggleGroupItem value="giorno">Giorno</ToggleGroupItem>
        <ToggleGroupItem value="settimana">Settimana</ToggleGroupItem>
      </ToggleGroup>

      {week ? (
        <div className="flex items-center gap-2">
          <Switch
            id={switchId}
            aria-labelledby={switchLabelId}
            checked={showCancelled}
            onCheckedChange={(checked) => router.push(agendaHref(view, day, checked))}
          />
          <Label id={switchLabelId} htmlFor={switchId}>
            Mostra annullati
          </Label>
        </div>
      ) : null}

      {actions ? <div className="flex items-center gap-2 sm:ml-auto">{actions}</div> : null}
    </div>
  );
}
