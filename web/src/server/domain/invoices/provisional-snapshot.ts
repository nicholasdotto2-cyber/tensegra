import { computeInvoice } from "@/lib/fiscal/calc";
import { documentDate, dueDate } from "@/lib/fiscal/issue-date";
import { isElectronic, type SnapshotInput } from "@/lib/fiscal/snapshot";
import { fiscalRatesOf, type FiscalSettingsView, type PracticeSettingsView } from "@/server/domain/settings/queries";
import type { RecipientView } from "./queries";

interface ProvisionalSnapshotOptions {
  practice: PracticeSettingsView;
  fiscal: FiscalSettingsView;
  recipient: RecipientView | null;
  lines: SnapshotInput["lines"];
  payment: Pick<SnapshotInput["payment"], "method" | "paidOn">;
  today: string;
  docType: SnapshotInput["docType"];
  credited: SnapshotInput["credited"];
  stampMarkCode: string | null;
}

/** Un solo input per i controlli dell'editor e dell'emissione, prima di assegnare il numero. */
export function provisionalSnapshotInput({
  practice, fiscal, recipient, lines, payment, today, docType, credited, stampMarkCode,
}: ProvisionalSnapshotOptions): SnapshotInput {
  const recipientKind = recipient?.kind ?? "paziente";
  const computation = computeInvoice({ regime: fiscal.regime, rates: fiscalRatesOf(fiscal),
    recipientKind, withholdingAgent: recipient?.withholdingAgent ?? false, lines });
  const issueDate = documentDate({ paidOn: payment.paidOn, today,
    electronic: isElectronic(fiscal.regime, recipientKind) });
  return {
    isDemo: practice.isDemo, docType, numberLabel: "", issueDate, regime: fiscal.regime,
    supplier: { firstName: practice.practitionerFirstName, lastName: practice.practitionerLastName,
      practiceName: practice.practiceName, taxCode: fiscal.taxCode ?? "", vatNumber: fiscal.vatNumber ?? "",
      address: { line: fiscal.fiscalAddressLine ?? "", postalCode: fiscal.fiscalPostalCode ?? "",
        city: fiscal.fiscalCity ?? "", province: fiscal.fiscalProvince, country: fiscal.fiscalCountry },
      registration: { kind: practice.registrationKind, order: practice.registrationOrder,
        province: practice.registrationProvince, number: practice.registrationNumber, date: practice.registrationDate } },
    recipient: { kind: recipientKind,
      firstName: recipient ? recipient.firstName : "", lastName: recipient ? recipient.lastName : "",
      name: recipient?.name ?? null, taxCode: recipient?.taxCode ?? null, vatNumber: recipient?.vatNumber ?? null,
      recipientCode: recipient?.recipientCode ?? "0000000", pec: recipient?.pec ?? null,
      address: { line: recipient?.addressLine ?? "", postalCode: recipient?.postalCode ?? "",
        city: recipient?.city ?? "", province: recipient?.province ?? null, country: recipient?.country ?? "IT" },
      minorName: null },
    computation, lines,
    payment: { ...payment,
      dueDate: payment.method === "bonifico" ? dueDate(issueDate, fiscal.bankTransferDueDays) : null,
      iban: fiscal.iban, beneficiary: fiscal.ibanHolder },
    credited, transmission: null, stampMarkCode, paperStampAuthorization: fiscal.paperStampAuthorization,
  };
}
