import type { ReactNode } from "react";

import { SidebarTrigger } from "@/components/ui/sidebar";

// L'intestazione di ogni pagina: h1 a sinistra, azioni principali a destra. Sotto i
// 768 px la sidebar è un pannello e il pulsante a sinistra del titolo lo apre.
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 items-start gap-2">
        <SidebarTrigger className="md:hidden" />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
