import { romeTime } from "@/server/clock";
import type { LockInfo } from "@/server/db/lock";

// Stati tecnici del layout, pensati per chi gestisce l'installazione: dicono quale comando
// eseguire, senza pulsanti e senza path della cartella dati.

export type SystemStateKind = "locked" | "migration" | "no-data";

export interface SystemStateProps {
  kind: SystemStateKind;
  /** Il lock trovato, per `locked`. */
  info?: LockInfo;
  /** Il file della migrazione, per `migration`. */
  fileName?: string;
}

const LOCKED_HELP =
  "Chiudi quel processo. Se sei sicuro che non esiste più, esegui pnpm db:unlock (o pnpm db:unlock --force). Dopo lo sblocco ricarica la pagina.";

// Testi interi in template string: in JSX `a {b} c` diventa tre nodi di testo.
function content({ kind, info, fileName }: SystemStateProps): { title: string; lines: string[] } {
  switch (kind) {
    case "locked": {
      const owner = info
        ? [`PID ${info.pid}, avviato alle ${romeTime(new Date(info.startedAt))}.`]
        : [];
      return { title: "I dati sono aperti da un altro programma", lines: [...owner, LOCKED_HELP] };
    }
    case "migration": {
      const migration = fileName ? `La migrazione ${fileName}` : "La migrazione";
      return { title: `${migration} non è andata a buon fine. Esegui pnpm db:reset.`, lines: [] };
    }
    case "no-data":
      return { title: "Nessun dato demo", lines: ["Esegui pnpm db:seed."] };
  }
}

export function SystemState(props: SystemStateProps) {
  const { title, lines } = content(props);
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3 px-8 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {lines.map((line) => (
        <p key={line} className="text-muted-foreground">
          {line}
        </p>
      ))}
    </main>
  );
}
