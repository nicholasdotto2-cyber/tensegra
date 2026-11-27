// Una fascia chiusa dello studio nella colonna di un giorno: sfondo tratteggiato tenue e
// la scritta "Chiuso". Non intercetta i clic: anche una fascia chiusa si può scegliere per un
// appuntamento, con l'avviso non bloccante del dialogo.

// Righe sottili del grigio del testo secondario al 12%: tenui nei due temi, e la scritta in
// `muted-foreground` resta sopra 4,5:1 anche sulle righe.
const HATCH =
  "repeating-linear-gradient(135deg, color-mix(in oklch, var(--muted-foreground) 12%, transparent) 0 2px, transparent 2px 8px)";

export function ClosedBand({ top, height }: { top: number; height: number }) {
  return (
    <div
      data-slot="closed-band"
      className="pointer-events-none absolute inset-x-0 overflow-hidden bg-muted/40 px-[6px] py-[4px] text-xs leading-[16px] text-muted-foreground"
      style={{ top, height, backgroundImage: HATCH }}
    >
      Chiuso
    </div>
  );
}
