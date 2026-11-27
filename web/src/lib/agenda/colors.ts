import type { ServiceColor } from "@/lib/agenda/defaults";

// I colori delle prestazioni: i token `chart-1` ... `chart-5` già in
// globals.css e, per `ardesia`, il grigio `muted-foreground`; nessun token nuovo. Il blocco ha il colore
// al 15% come sfondo e la barra sinistra di 4 px piena, con il testo in `foreground`: il contrasto non
// dipende dal colore. Le classi sono scritte per intero perché Tailwind le trovi nel sorgente.
// Sicuro per il client.

export const SERVICE_COLOR_CLASS: Record<ServiceColor, string> = {
  petrolio: "border-l-[4px] border-l-chart-1 bg-chart-1/15",
  salvia: "border-l-[4px] border-l-chart-2 bg-chart-2/15",
  oceano: "border-l-[4px] border-l-chart-3 bg-chart-3/15",
  ocra: "border-l-[4px] border-l-chart-4 bg-chart-4/15",
  corallo: "border-l-[4px] border-l-chart-5 bg-chart-5/15",
  ardesia: "border-l-[4px] border-l-muted-foreground bg-muted-foreground/15",
};

export const COLOR_LABEL: Record<ServiceColor, string> = {
  petrolio: "Petrolio",
  salvia: "Salvia",
  oceano: "Oceano",
  ocra: "Ocra",
  corallo: "Corallo",
  ardesia: "Ardesia",
};
