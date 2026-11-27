// Il primo elemento della pagina: visibile solo quando prende il focus, porta a
// `main#contenuto`. Sta sopra il banner (z-50) così il focus non è mai coperto (WCAG 2.4.11).
export function SkipLink() {
  return (
    <a
      href="#contenuto"
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:ring-3 focus:ring-ring/50 focus:outline-none"
    >
      Vai al contenuto
    </a>
  );
}
