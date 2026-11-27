import Link from "next/link";

import { type PatientTab, patientHref } from "@/lib/patients/params";
import { cn } from "@/lib/utils";

// Le sezioni della scheda come link: la sezione sta nell'URL, e il link della sezione in uso
// porta `aria-current="page"`. Non sono tab ARIA: cambiano pagina, non pannello.
// Messaggi segue Fatture.

const TABS: readonly { code: PatientTab; label: string }[] = [
  { code: "riepilogo", label: "Riepilogo" },
  { code: "cartella", label: "Cartella" },
  { code: "appuntamenti", label: "Appuntamenti" },
  { code: "consensi", label: "Consensi" },
  { code: "fatture", label: "Fatture" },
  { code: "messaggi", label: "Messaggi" },
  { code: "anagrafica", label: "Anagrafica" },
];

export function PatientTabs({ patientId, current }: { patientId: string; current: PatientTab }) {
  return (
    <nav aria-label="Sezioni della scheda" className="border-b">
      <ul className="-mb-px flex flex-wrap gap-x-1">
        {TABS.map((tab) => {
          const active = tab.code === current;
          return (
            <li key={tab.code}>
              <Link
                href={patientHref(patientId, { tab: tab.code })}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-9 items-center rounded-t-md border-b-2 px-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
                  active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
