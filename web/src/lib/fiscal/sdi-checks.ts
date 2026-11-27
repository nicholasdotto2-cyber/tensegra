import { arr, rdiv } from "./amounts";
import type { FatturaModel } from "./model";

export type SdiCode = "00400" | "00401" | "00411" | "00413" | "00415" | "00417" | "00421" | "00422" | "00423" | "00424" | "00425" | "00427" | "00429" | "00430" | "00443" | "00444" | "00445" | "00471";
export interface SdiProblem { code: SdiCode; message: string }

function correctLineTotal(line: FatturaModel["lines"][number]): boolean {
  if (!Number.isInteger(line.quantity) || line.quantity < 1 || !/^\d+\.\d{2,8}$/.test(line.unitPrice)) return false;
  const [whole, fraction] = line.unitPrice.split(".");
  const price = BigInt(whole! + fraction!.padEnd(8, "0"));
  return rdiv(price * BigInt(line.quantity), BigInt(1000000)) === BigInt(line.totalCents);
}

export function sdiChecks(m: FatturaModel): SdiProblem[] {
  const problems: SdiProblem[] = [];
  const add = (code: SdiCode, text: string) => {
    if (!problems.some((p) => p.code === code)) problems.push({ code, message: `Controllo SdI ${code}: ${text}` });
  };
  const sameGroup = (a: { vatRateBp: number; nature: string | null }, b: { vatRateBp: number; nature: string | null }) =>
    a.vatRateBp === b.vatRateBp && a.nature === b.nature;
  const checkRate = (rate: number) => {
    if (rate >= 1 && rate <= 99) add("00424", "aliquota IVA espressa in modo non corretto");
  };
  const checkNature = (nature: string | null) => {
    if (nature === "N2" || nature === "N3" || nature === "N6") add("00445", "natura generica N2, N3 o N6 non ammessa");
  };
  for (const line of m.lines) {
    if (line.vatRateBp === 0 && !line.nature) add("00400", "riga con aliquota zero senza natura");
    if (line.vatRateBp !== 0 && line.nature) add("00401", "riga con natura e aliquota diversa da zero");
    if (line.withholding && !m.document.withholding) add("00411", "riga con ritenuta senza dati della ritenuta");
    if (!correctLineTotal(line)) add("00423", "prezzo totale della riga non corretto");
    if (!m.summary.some((group) => sameGroup(group, line))) add("00443", "aliquota o natura della riga assente dal riepilogo");
    checkRate(line.vatRateBp);
    checkNature(line.nature);
  }
  const pension = m.document.pension;
  if (pension) {
    if (pension.vatRateBp === 0 && !pension.nature) add("00413", "cassa con aliquota zero senza natura");
    if (pension.withholding && !m.document.withholding) add("00415", "cassa con ritenuta senza dati della ritenuta");
    checkRate(pension.vatRateBp);
    checkNature(pension.nature);
  }
  if (!m.customer.taxCode?.trim() && !m.customer.vatNumber?.trim()) add("00417", "destinatario senza codice fiscale né partita IVA");
  for (const group of m.summary) {
    if (Math.abs(group.vatCents - arr(group.taxableCents, group.vatRateBp)) > 1) add("00421", "imposta del riepilogo non corretta");
    const lines = m.lines.filter((line) => sameGroup(line, group));
    const taxable = lines.reduce((sum, line) => sum + line.totalCents, 0)
      + (pension && sameGroup(pension, group) ? pension.amountCents : 0);
    if (group.taxableCents !== taxable) add("00422", "imponibile del riepilogo diverso dalla somma delle righe e della cassa");
    if (group.vatRateBp === 0 && !group.nature) add("00429", "riepilogo con aliquota zero senza natura");
    if (group.vatRateBp !== 0 && group.nature) add("00430", "riepilogo con natura e aliquota diversa da zero");
    if (!lines.length) add("00444", "riepilogo senza righe con la sua aliquota e natura");
    checkRate(group.vatRateBp);
    checkNature(group.nature);
  }
  if (!/\d/.test(m.document.number)) add("00425", "numero del documento senza cifre");
  if (m.recipientCode.length === 6) add("00427", "codice destinatario di 6 caratteri con FPR12");
  if (m.supplier.vatNumber && m.customer.vatNumber === m.supplier.vatNumber) add("00471", "cedente e cessionario con la stessa partita IVA");
  return problems;
}
