import Link from "next/link";

import type { BUILT_SECTIONS } from "@/lib/settings/sections";
import { cn } from "@/lib/utils";

// Il sottomenu di Impostazioni: a sinistra da 1024 px, in alto sotto. Elenca solo le sezioni
// costruite che arrivano in `sections`; la sezione aperta ha `aria-current` e lo sfondo. Pagine dinamiche:
// niente prefetch, come nella sidebar.
export function SettingsNav({ sections, current }: { sections: typeof BUILT_SECTIONS; current: string }) {
  return (
    <nav aria-label="Sezioni di Impostazioni" className="lg:w-52 lg:shrink-0">
      <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
        {sections.map((section) => {
          const active = section.slug === current;
          return (
            <li key={section.slug} className="shrink-0">
              <Link
                href={`/impostazioni/${section.slug}`}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  // Il focus come negli altri controlli: bordo `ring` pieno più l'alone.
                  "flex h-8 items-center rounded-lg border border-transparent px-2.5 text-sm whitespace-nowrap outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                  active && "bg-secondary font-medium text-secondary-foreground",
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
