// La linea dell'ora corrente nel colore primario, con l'etichetta per i lettori di
// schermo («Ora attuale: 09:30»). Sopra i blocchi, ma non intercetta i clic.
export function NowLine({ top, label }: { top: number; label: string }) {
  return (
    <div data-slot="now-line" className="pointer-events-none absolute inset-x-0 z-[15] h-[2px] bg-primary" style={{ top }}>
      <span aria-hidden="true" className="absolute top-[-3px] left-[-4px] size-[8px] rounded-full bg-primary" />
      <span className="sr-only">{`Ora attuale: ${label}`}</span>
    </div>
  );
}
