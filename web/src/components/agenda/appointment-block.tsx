import { Ban, Check, CheckCheck, Clock, type LucideIcon, UserX } from "lucide-react";

import { SERVICE_COLOR_CLASS } from "@/lib/agenda/colors";
import type { AgendaBlock } from "@/lib/agenda/grid";
import { type AppointmentStatus, STATUS_LABEL } from "@/lib/agenda/status";
import { cn } from "@/lib/utils";

// Un appuntamento nella griglia: un pulsante col nome accessibile
// «09:00-09:45, Bellandi Marco, Seduta osteopatica, Confermato». Lo stato è sempre testo più icona;
// "Cognome Nome" è troncato coi puntini se non ci sta, anche a 15 minuti; la prestazione da 30 minuti
// in su. Il testo resta in `foreground` su ogni sfondo: il colore della prestazione sta in uno strato
// sotto, che per `fatto` si fa più tenue senza toccare il contrasto del testo.

export const STATUS_ICON: Record<AppointmentStatus, LucideIcon> = {
  prenotato: Clock,
  confermato: Check,
  fatto: CheckCheck,
  saltato: UserX,
  annullato: Ban,
};

// Le righe di testo per durata, a 16 px l'una: sotto i 30 minuti una sola, [nome | stato]; da 30
// minuti due, il nome su tutta la riga e [prestazione | stato]; da 45 minuti tre, nome, prestazione e stato.
// Quando una riga non basta cede per prima la prestazione, fino a sparire (resta nel nome accessibile);
// poi il nome, che tiene però le prime lettere coi puntini; per ultimo si accorcia coi puntini il testo
// dello stato, che non sparisce mai. Chi cede ha base 0 e prende solo lo spazio che lo stato lascia:
// con un restringimento in proporzione lo stato perderebbe qualche pixel, e i puntini, anche nei
// blocchi larghi. Sotto i 5rem (blocchi affiancati) margini e spazi si stringono per lasciare più testo.
// Un blocco da 15 minuti più stretto di 9rem non ha posto per nome e stato su una riga (affiancati in
// una colonna di 150 px, 73 px, restavano "B..." e "C..."): nei suoi 24 px vanno due righe da 12 px,
// ciascuna con tutta la larghezza.
const WITH_SERVICE_MIN = 30;
const STATUS_OWN_ROW_MIN = 45;

// Solo lo spazio fra le colonne: sulle due righe da 12 px non resta niente fra una riga e l'altra.
const SHORT_LAYOUT =
  "items-center gap-x-[6px] @max-[5rem]:gap-x-[3px] @max-[9rem]:flex-col @max-[9rem]:items-stretch @max-[9rem]:py-0 @max-[9rem]:leading-[12px]";

function layerClass(block: AgendaBlock): string {
  switch (block.status) {
    case "saltato":
      return "border border-dashed border-muted-foreground bg-muted";
    case "annullato":
      return "bg-muted";
    case "fatto":
      return cn(SERVICE_COLOR_CLASS[block.color], "opacity-50");
    default:
      return SERVICE_COLOR_CLASS[block.color];
  }
}

function StatusText({ status }: { status: AppointmentStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className="flex min-w-0 items-center gap-[4px] @max-[5rem]:gap-[2px]">
      <Icon aria-hidden="true" className="size-[12px] shrink-0" />
      <span data-slot="block-status" className="min-w-0 truncate">
        {STATUS_LABEL[status]}
      </span>
    </span>
  );
}

const ROW = "flex min-w-0 items-center gap-[6px] @max-[5rem]:gap-[3px]";

export function AppointmentBlock({
  block,
  top,
  height,
  column,
  columns,
  onClick,
}: {
  block: AgendaBlock;
  top: number;
  height: number;
  /** La colonna del blocco fra quelli che si sovrappongono, da 0, e quante sono. */
  column: number;
  columns: number;
  onClick?: (id: string) => void;
}) {
  const duration = block.endMin - block.startMin;
  const withService = duration >= WITH_SERVICE_MIN;
  const statusOwnRow = duration >= STATUS_OWN_ROW_MIN;
  const label = `${block.timeRange}, ${block.patientLabel}, ${block.serviceName}, ${STATUS_LABEL[block.status]}`;

  return (
    <button
      type="button"
      aria-label={label}
      data-color={block.color}
      data-status={block.status}
      // Un clic sul blocco non è un clic sulla cella vuota della colonna.
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(block.id);
      }}
      // Il margine di scorrimento tiene il blocco col focus fuori dall'intestazione dei giorni e dalla
      // colonna delle ore, che restano ferme sopra la griglia (WCAG 2.4.11).
      // Lo sfondo pieno sotto il colore al 15% copre le righe delle ore e le fasce chiuse.
      // Il focus è un contorno pieno `ring` dentro il bordo, sopra il colore della
      // prestazione, più l'alone: un bordo vero toglierebbe 2 px al testo, che si tronca al pixel.
      className="@container absolute z-10 scroll-mt-[56px] scroll-ml-[64px] overflow-hidden rounded-md bg-background text-left text-xs leading-[16px] text-foreground outline-none focus-visible:z-20 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      style={{
        top,
        height,
        left: `calc(${column} * 100% / ${columns})`,
        width: `calc(100% / ${columns} - 2px)`,
      }}
    >
      <span aria-hidden="true" className={cn("absolute inset-0 rounded-[inherit]", layerClass(block))} />
      <span
        className={cn(
          "relative flex h-full min-w-0 px-[6px] py-[4px] @max-[5rem]:px-[4px] @max-[3rem]:px-[2px]",
          withService ? "flex-col" : SHORT_LAYOUT,
          block.status === "annullato" && "line-through",
        )}
      >
        {withService ? (
          <>
            <span data-slot="block-patient" className="truncate font-medium">
              {block.patientLabel}
            </span>
            <span className={ROW}>
              <span data-slot="block-service" className="min-w-0 flex-1 truncate">
                {block.serviceName}
              </span>
              {statusOwnRow ? null : <StatusText status={block.status} />}
            </span>
            {statusOwnRow ? <StatusText status={block.status} /> : null}
          </>
        ) : (
          <>
            {/* Sulla riga condivisa le prime lettere del cognome restano anche se lo stato non ci sta intero.
                Sulle due righe da 12 px il taglio è solo in orizzontale, così le discendenti (g, p) non si tagliano. */}
            <span
              data-slot="block-patient"
              className="min-w-[2em] flex-1 truncate font-medium @max-[9rem]:min-w-0 @max-[9rem]:flex-none @max-[9rem]:overflow-x-clip @max-[9rem]:overflow-y-visible"
            >
              {block.patientLabel}
            </span>
            <StatusText status={block.status} />
          </>
        )}
      </span>
    </button>
  );
}
