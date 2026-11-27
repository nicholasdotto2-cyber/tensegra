import type { InvoiceSnapshot } from "./snapshot";

/** Il pagamento com'è oggi sulla riga della fattura. */
export interface LivePayment {
  method: InvoiceSnapshot["payment"]["method"];
  paidOn: string | null;
  dueDate: string | null;
}

/**
 * La fotografia con il pagamento della riga. L'IBAN e l'intestatario restano quelli congelati (la riga non li
 * ha): servono solo al bonifico ancora da pagare. La nota di credito non ha incasso.
 */
export function withLivePayment(snapshot: InvoiceSnapshot, live: LivePayment): InvoiceSnapshot {
  if (snapshot.docType === "TD04") return snapshot;
  return {
    ...snapshot,
    payment: {
      ...snapshot.payment, method: live.method, paidOn: live.paidOn, dueDate: live.method === "bonifico" ? live.dueDate : null,
    },
  };
}
