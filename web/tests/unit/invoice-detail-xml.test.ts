import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InvoiceDetailView } from "@/components/fatture/invoice-detail";
import type { InvoiceDetail } from "@/server/domain/invoices/queries";

// Il dettaglio della fattura senza XML: per l'esente verso persona fisica "Scarica XML" è sostituito
// da una frase fissa, carattere per carattere. I dialoghi e la testata della pagina non servono qui.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/fatture/xml-dialog", () => ({ XmlDialog: () => null }));
vi.mock("@/components/fatture/cancel-dialog", () => ({ CancelDialog: () => null }));
vi.mock("@/components/fatture/payment-dialog", () => ({ PaymentDialog: () => null }));
vi.mock("@/components/shell/page-header", () => ({ PageHeader: () => null }));

const SPEC_TEXT = "In regime esente la fattura al paziente è cartacea o PDF e i dati vanno al Sistema TS (modulo non attivo)";

const base: InvoiceDetail = {
  id: "0b8f6d5e-5a0f-4c4e-9a52-2f1d6a1d9c11", docType: "TD01", status: "pagata", numberLabel: "3/2026",
  issueDate: "2026-11-02", xmlFileName: null, hasXml: false, totalCents: 7000, netCents: 7000,
  paymentMethod: "carta", paidOn: "2026-11-02", events: [], linked: null, actions: [],
};

function render(detail: InvoiceDetail): string {
  return renderToStaticMarkup(createElement(InvoiceDetailView, { detail, today: "2026-11-04" }));
}

describe("InvoiceDetailView senza XML", () => {
  it("al posto di «Scarica XML» dice la frase fissa, senza la riga del file XML", () => {
    const html = render(base);
    expect(html).toContain(SPEC_TEXT);
    expect(html).not.toContain("Scarica XML");
    expect(html).not.toContain("File XML");
    expect(html).not.toContain("solo su carta");
    expect(html).toContain("Scarica PDF");
  });

  it("con l'XML mostra il nome del file e «Scarica XML», senza la frase", () => {
    const html = render({ ...base, hasXml: true, xmlFileName: "IT00000000000_00003.xml" });
    expect(html).toContain("Scarica XML");
    expect(html).toContain("IT00000000000_00003.xml");
    expect(html).not.toContain(SPEC_TEXT);
  });
});
