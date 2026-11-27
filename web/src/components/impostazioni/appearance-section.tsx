import { ThemeToggle } from "@/components/shell/theme-toggle";

// Aspetto: tema chiaro, scuro o quello del sistema. Il tema vive nel browser di chi usa il
// programma, non nei dati dello studio: per questo non c'è un "Salva" e il cambio vale subito.
export function AppearanceSection() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Scegli il tema chiaro, quello scuro o quello del tuo computer. Il cambio vale subito, solo su questo browser.
      </p>
      <ThemeToggle className="self-start" />
    </div>
  );
}
