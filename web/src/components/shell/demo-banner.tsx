// Il banner "Dati di prova": alto 36 px, sempre in cima, non chiudibile. È una regione
// con etichetta, mai `role="alert"`: non deve interrompere chi legge la pagina. A sinistra l'avviso,
// a destra quando sono stati creati i dati (`createdText`, vuoto se il seed non ha lasciato l'istante).
import { RecreateDemoButton } from "@/components/shell/recreate-demo-button";

export function DemoBanner({ createdText, canRecreate = false }: { createdText: string; canRecreate?: boolean }) {
  return (
    <section
      aria-label="Avviso dati di prova"
      className="flex h-[36px] shrink-0 items-center justify-between gap-4 overflow-hidden bg-info px-4 text-xs leading-4 text-info-foreground md:text-sm"
    >
      <p>Dati di prova: studio, pazienti e fatture sono inventati. Non inserire dati di persone reali.</p>
      <div className="flex shrink-0 items-center gap-2">
        {createdText ? <p className="font-medium max-sm:hidden">{createdText}</p> : null}
        {canRecreate ? <RecreateDemoButton label="Ricrea per oggi" /> : null}
      </div>
    </section>
  );
}
