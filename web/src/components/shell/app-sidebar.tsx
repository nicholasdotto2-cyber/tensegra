"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { isNavActive, NAV_ITEMS } from "@/components/shell/nav-items";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { APP_NAME } from "@/lib/config/app";

// La sidebar: marchio e studio in testa, le sei voci, il tema in fondo. Aperta da 1280 px, a
// icone fra 768 e 1279 px, pannello sotto 768 px. Parte sotto il banner: la sua
// altezza segue `--banner-height`, che il layout fissa a 36 px col banner e a 0 senza.

const WIDE_QUERY = "(min-width: 1280px)";

function subscribeWide(onChange: () => void) {
  const mql = window.matchMedia(WIDE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

// Il server non conosce la finestra e disegna la sidebar aperta; il browser la chiude se è stretta.
function useOpenFollowsWidth() {
  const { setOpen } = useSidebar();
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
  const follow = useEffectEvent((isWide: boolean) => setOpen(isWide));
  // Solo quando la finestra cambia fascia: Ctrl+B apre e chiude finché la fascia resta quella.
  useEffect(() => {
    follow(wide);
  }, [wide]);
}

function ToInvoiceBadge({ count }: { count: number }) {
  return (
    <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-primary px-1 text-xs font-medium text-primary-foreground tabular-nums group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:top-0 group-data-[collapsible=icon]:right-0 group-data-[collapsible=icon]:h-4 group-data-[collapsible=icon]:min-w-4 group-data-[collapsible=icon]:px-0.5 group-data-[collapsible=icon]:text-[0.625rem]">
      {count}
      <span className="sr-only"> da emettere</span>
    </span>
  );
}

// Warning solo come sfondo: il bordo scuro tiene il punto a 3:1 sul fondo chiaro della sidebar.
function MissingDataDot() {
  return (
    <>
      <span
        aria-hidden="true"
        className="ml-auto size-2.5 rounded-full border border-warning-foreground bg-warning group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:top-0 group-data-[collapsible=icon]:right-0"
      />
      <span className="sr-only">mancano dati per fatture o consensi</span>
    </>
  );
}

export function AppSidebar({
  practiceName,
  toInvoiceCount,
  settingsWarning,
}: {
  practiceName: string;
  toInvoiceCount: number;
  settingsWarning: boolean;
}) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  useOpenFollowsWidth();

  return (
    <Sidebar
      variant="sidebar"
      collapsible="icon"
      className="top-(--banner-height) h-[calc(100svh-var(--banner-height))]"
    >
      <SidebarHeader className="gap-0.5 px-4 pt-4 group-data-[collapsible=icon]:hidden">
        <p className="text-base leading-5 font-semibold">{APP_NAME}</p>
        <p className="text-xs break-words text-muted-foreground">{practiceName}</p>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Menu">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {NAV_ITEMS.map((item) => {
                  const active = isNavActive(pathname, item.match);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        isActive={active}
                        tooltip={item.label}
                        render={
                          <Link
                            href={item.href}
                            // Pagine dinamiche con i dati dello studio: non c'è un guscio statico da anticipare,
                            // e una voce la cui pagina non c'è ancora darebbe un 404 a ogni apertura.
                            prefetch={false}
                            aria-current={active ? "page" : undefined}
                            onClick={() => setOpenMobile(false)}
                          />
                        }
                      >
                        <item.icon />
                        <span>{item.label}</span>
                        {item.match === "/fatture" && toInvoiceCount > 0 ? <ToInvoiceBadge count={toInvoiceCount} /> : null}
                        {item.match === "/impostazioni" && settingsWarning ? <MissingDataDot /> : null}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter className="p-3">
        <ThemeToggle className="group-data-[collapsible=icon]:flex-col" />
      </SidebarFooter>
    </Sidebar>
  );
}
