import { Info } from "lucide-react";
import Link from "next/link";

// Il riquadro del regime in cima al Listino: un testo per ogni regime
// e il link a Impostazioni, Fisco, ora che la sezione esiste.

const REGIME_NOTES = {
  forfettario:
    "Regime forfettario: le fatture non hanno IVA e riportano il bollo da 2 € sopra 77,47 €. Si cambia in",
  ordinario:
    "Regime ordinario: i prezzi del listino comprendono l'IVA, e la fattura al paziente la scorpora (22%). Si cambia in",
  esente_sanitario:
    "Regime esente: le fatture non hanno IVA e riportano il bollo da 2 € sopra 77,47 €; al paziente la fattura è cartacea o PDF. Si cambia in",
};

export function RegimeNote({ regime }: { regime: "ordinario" | "forfettario" | "esente_sanitario" }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted px-3 py-2 text-sm">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>
        {REGIME_NOTES[regime]}{" "}
        <Link href="/impostazioni/fisco" prefetch={false} className="underline underline-offset-4">
          Impostazioni, Fisco
        </Link>
        .
      </p>
    </div>
  );
}
