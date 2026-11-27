import type { CSSProperties, ReactNode } from "react";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { DemoBanner } from "@/components/shell/demo-banner";
import { RecreateDemoProvider } from "@/components/shell/recreate-demo-button";
import { SkipLink } from "@/components/shell/skip-link";
import { SystemState } from "@/components/shell/system-state";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { bannerState } from "@/lib/demo-banner";
import { DEMO_PRACTICE_ID } from "@/server/auth/actor";
import { loadConfig } from "@/server/config";
import { fixedClock, systemClock } from "@/server/clock";
import { getRequestContext, type RequestContext } from "@/server/db/next";
import { getShellStatus } from "@/server/domain/shell/queries";
import { systemStateFor } from "./system-state-for";

// Pagine con i dati dello studio: mai prerenderizzate.
export const dynamic = "force-dynamic";

// Altezza del banner "Dati di prova". La sidebar e l'area del contenuto la tolgono
// dall'altezza della finestra, così la pagina non scorre sotto il banner e il banner non copre mai
// l'elemento col focus (WCAG 2.4.11): lo scorrimento sta nel contenuto, non nel documento.
const BANNER_HEIGHT = "36px";

// In produzione Next nasconde il messaggio degli errori lanciati dai Server Component, e
// error.tsx non copre il layout del suo stesso segmento: gli errori noti dell'apertura
// diventano qui uno stato leggibile, ogni altro errore si rilancia.
export default async function AppLayout({ children }: { children: ReactNode }) {
  let ctx: RequestContext;
  try {
    ctx = await getRequestContext();
  } catch (error) {
    return <SystemState {...systemStateFor(error)} />;
  }

  // La shell ha la sua transazione, piccola; la pagina apre la sua.
  const clock = fixedClock(systemClock.now());
  const status = await ctx.db.asUser(ctx.actor, (tx) => getShellStatus(tx, ctx.practiceId, clock));
  const banner = bannerState(status.demoSeededAt, clock.today());
  const canRecreate = status.isDemo && ctx.practiceId === DEMO_PRACTICE_ID && loadConfig().demoMode;

  return (
    <RecreateDemoProvider allowed={canRecreate}>
    <div style={{ "--banner-height": status.isDemo ? BANNER_HEIGHT : "0px" } as CSSProperties}>
      <SkipLink />
      {status.isDemo ? <DemoBanner createdText={banner.text} canRecreate={banner.canRecreate && canRecreate} /> : null}
      <SidebarProvider className="min-h-0">
        <AppSidebar
          practiceName={status.practiceName}
          toInvoiceCount={status.toInvoiceCount}
          settingsWarning={status.settingsWarning}
        />
        <SidebarInset
          id="contenuto"
          tabIndex={-1}
          className="h-[calc(100svh-var(--banner-height))] min-w-0 gap-6 overflow-y-auto p-6 outline-none"
        >
          {children}
        </SidebarInset>
      </SidebarProvider>
    </div>
    </RecreateDemoProvider>
  );
}
