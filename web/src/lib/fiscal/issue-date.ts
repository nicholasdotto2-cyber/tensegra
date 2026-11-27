import { addDays, daysBetween } from "./calendar";

export const PAID_IN_FUTURE = "La data dell'incasso non può essere nel futuro.";
export const LATE_ISSUE = "Fattura emessa oltre 12 giorni dopo l'incasso";

export function documentDate(input: {
  paidOn: string | null;
  today: string;
  electronic: boolean;
}): string {
  const { paidOn, today, electronic } = input;
  if (paidOn !== null && paidOn > today) throw new RangeError(PAID_IN_FUTURE);
  return electronic && paidOn !== null ? paidOn : today;
}

export function lateIssueWarning(paidOn: string | null, today: string): string | null {
  return paidOn !== null && daysBetween(paidOn, today) > 12 ? LATE_ISSUE : null;
}

export function dueDate(issueDate: string, days: number): string {
  return addDays(issueDate, days);
}
