import {
  CalendarRange,
  ContactRound,
  FileText,
  type LucideIcon,
  SlidersHorizontal,
  Sun,
  Tags,
} from "lucide-react";

// Le sei voci della sidebar, in quest'ordine.
// `match` è il percorso sotto cui la voce risulta attiva: Impostazioni apre la prima sezione, ma
// resta accesa su ognuna.

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  match: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Oggi", href: "/oggi", icon: Sun, match: "/oggi" },
  { label: "Agenda", href: "/agenda", icon: CalendarRange, match: "/agenda" },
  { label: "Pazienti", href: "/pazienti", icon: ContactRound, match: "/pazienti" },
  { label: "Fatture", href: "/fatture", icon: FileText, match: "/fatture" },
  { label: "Listino", href: "/listino", icon: Tags, match: "/listino" },
  { label: "Impostazioni", href: "/impostazioni/studio", icon: SlidersHorizontal, match: "/impostazioni" },
];

/** La voce è attiva sulla sua rotta e sotto di essa: "/pazienti/9f3c" accende Pazienti, "/oggi-x" no. */
export function isNavActive(pathname: string, match: string): boolean {
  return pathname === match || pathname.startsWith(`${match}/`);
}
