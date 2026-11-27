// Pezzi comuni del body chart, dell'elenco delle regioni e delle due scale: il numero
// della severità nel colore del suo livello, i tasti di un gruppo di radio con tabindex mobile e lo stile di
// una voce. Nessuno stato: si usa da client component.

import { type SeverityLevel, severityLevel } from "@/lib/clinical/body-map";
import { cn } from "@/lib/utils";

// Contrasto del numero, misurato in chiaro e in scuro: `foreground` sui livelli 0-2, `primary-foreground` sul 3.
const BADGE_TONE: Record<SeverityLevel, string> = {
  0: "bg-transparent text-foreground",
  1: "bg-primary/25 text-foreground",
  2: "bg-primary/55 text-foreground",
  3: "bg-primary text-primary-foreground",
};

/** Il numero della severità nel colore del suo livello, come nella sagoma; vuoto se la regione non ha disfunzioni. */
export function SeverityBadge({ severity }: { severity: number | null }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-primary text-sm font-semibold tabular-nums",
        severity === null ? "border-dashed" : BADGE_TONE[severityLevel(severity)],
      )}
    >
      {severity === null ? null : severity}
    </span>
  );
}

/**
 * L'indice dove porta un tasto in un gruppo di `count` voci, o null se il tasto non muove. Le frecce si fermano
 * agli estremi: in una scala clinica dal 10 non si salta allo 0 con un tasto di troppo.
 */
export function radioKeyTarget(key: string, index: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return Math.min(index + 1, count - 1);
    case "ArrowLeft":
    case "ArrowUp":
      return Math.max(index - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Il bersaglio di una voce di un gruppo: anello di focus come i pulsanti di `ui/`, che vince sullo stile della scelta. */
export const RADIO_ITEM =
  "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";
