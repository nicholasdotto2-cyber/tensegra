import { type DocumentProps, renderToBuffer } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import type { InvoiceSnapshot } from "@/lib/fiscal/snapshot";
import type { ReferralLetter } from "@/server/domain/referrals/queries";
import { ConsentDocument, type ConsentDocumentData } from "./consent";
import { InvoiceDocument } from "./invoice";
import { ReferralDocument } from "./referral";

// Il rendering dei PDF lato Node (`renderToBuffer`): una funzione pura sui dati, senza
// database né store. La chiamano `ensureReferralPdf` e `ensureConsentDocument` fuori da ogni transazione.

/** I byte della lettera al medico. */
export function renderReferralPdf(letter: ReferralLetter, practitionerSignaturePng?: Uint8Array | null): Promise<Buffer> {
  // `ReferralDocument` restituisce un `<Document>`: l'elemento è quello che `renderToBuffer` si aspetta.
  return renderToBuffer(createElement(ReferralDocument, { letter, practitionerSignaturePng }) as unknown as ReactElement<DocumentProps>);
}

/**
 * I byte del PDF di una fattura o nota di credito, dalla fotografia. La variante
 * `oscurata` toglie i dati del destinatario; `standardDescriptions` ha, riga per riga, la descrizione
 * standard della voce di listino (null per le righe libere).
 */
export function renderInvoicePdf(
  snapshot: InvoiceSnapshot,
  variant: "copia" | "oscurata" = "copia",
  standardDescriptions?: readonly (string | null)[],
): Promise<Buffer> {
  return renderToBuffer(
    createElement(InvoiceDocument, { snapshot, variant, standardDescriptions }) as unknown as ReactElement<DocumentProps>,
  );
}

/** I byte del PDF di un consenso, firmato o da stampare senza firma. */
export function renderConsentPdf(data: ConsentDocumentData): Promise<Buffer> {
  return renderToBuffer(createElement(ConsentDocument, { data }) as unknown as ReactElement<DocumentProps>);
}
