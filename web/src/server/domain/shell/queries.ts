import type { Clock } from "@/server/clock";
import type { Tx } from "@/server/db/db";
import { countToInvoice } from "@/server/domain/invoices/queries";
import { getFiscalSettings, getPracticeSettings } from "@/server/domain/settings/queries";

// Ciò che la shell mostra su ogni pagina: il nome dello studio, il banner dei
// dati di prova, il numero accanto a "Fatture" e il punto di avviso di "Impostazioni". Il layout la
// legge in una sua piccola `asUser`, separata da quella della pagina. Ogni lettura filtra lo studio
// anche oltre la RLS.

export interface ShellStatus {
  practiceName: string;
  isDemo: boolean;
  demoSeededAt: Date | null;
  /** Le sedute da fatturare: il numero accanto a "Fatture". */
  toInvoiceCount: number;
  /** Mancano dati che bloccano fatture o consensi: il punto accanto a "Impostazioni". */
  settingsWarning: boolean;
}

const missing = (value: string | null): boolean => value === null || value.trim() === "";

/** Dati mancanti o cifre di controllo errate. */
async function hasMissingSettings(
  tx: Tx,
  practiceId: string,
  studio: { addressLine: string | null; postalCode: string | null; city: string | null; province: string | null },
): Promise<boolean> {
  if ([studio.addressLine, studio.postalCode, studio.city, studio.province].some(missing)) return true;
  const fiscal = await getFiscalSettings(tx, practiceId);
  return [fiscal.vatNumber, fiscal.taxCode, fiscal.fiscalAddressLine, fiscal.fiscalPostalCode,
    fiscal.fiscalCity, fiscal.fiscalProvince].some(missing)
    || Object.values(fiscal.warnings).some((warning) => warning !== null);
}

/** Lo stato della shell. Senza le impostazioni dello studio (o con uno studio non suo) lancia. */
export async function getShellStatus(tx: Tx, practiceId: string, clock: Clock): Promise<ShellStatus> {
  const settings = await getPracticeSettings(tx, practiceId);
  if (!settings) throw new Error("Le impostazioni dello studio non esistono.");
  return {
    practiceName: settings.practiceName,
    isDemo: settings.isDemo,
    demoSeededAt: settings.demoSeededAt,
    toInvoiceCount: await countToInvoice(tx, practiceId, clock),
    settingsWarning: await hasMissingSettings(tx, practiceId, settings),
  };
}
