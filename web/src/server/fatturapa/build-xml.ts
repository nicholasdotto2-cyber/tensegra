import { createHash } from "node:crypto";
import { create } from "xmlbuilder2";
import { type FatturaModel, type XmlAddress, xmlAmount, xmlPercent, xmlQuantity } from "@/lib/fiscal/model";

type XmlNode = ReturnType<typeof create>;

// Codici fiscali fissi del modello FPR12; TC22 resta una scelta provvisoria.
const INPS_PENSION_FUND = "TC22";
const PERSONAL_WITHHOLDING_TYPE = "RT01";
const FULL_PAYMENT_CONDITION = "TP02";
const PROFESSIONAL_PAYMENT_REASON = "A";

function text(parent: XmlNode, name: string, value: string | number | null): void {
  if (value !== null) parent.ele(name).txt(String(value));
}

function fiscalId(parent: XmlNode, name: string, country: string, code: string): void {
  const id = parent.ele(name);
  text(id, "IdPaese", country);
  text(id, "IdCodice", code);
}

function address(parent: XmlNode, value: XmlAddress): void {
  const sede = parent.ele("Sede");
  text(sede, "Indirizzo", value.line);
  text(sede, "CAP", value.postalCode);
  text(sede, "Comune", value.city);
  text(sede, "Provincia", value.province);
  text(sede, "Nazione", value.country);
}

/** Serializza il modello congelato nell'ordine dell'XSD FPR12, senza ricalcolarlo. */
export function buildXml(m: FatturaModel): string {
  const root = create({ version: "1.0", encoding: "UTF-8" })
    .ele("http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2", "p:FatturaElettronica")
    .att("versione", "FPR12");
  const header = root.ele("FatturaElettronicaHeader");
  const transmission = header.ele("DatiTrasmissione");
  fiscalId(transmission, "IdTrasmittente", m.transmitter.country, m.transmitter.code);
  text(transmission, "ProgressivoInvio", m.progressive);
  text(transmission, "FormatoTrasmissione", "FPR12");
  text(transmission, "CodiceDestinatario", m.recipientCode);
  text(transmission, "PECDestinatario", m.recipientPec);

  const supplier = header.ele("CedentePrestatore");
  const supplierData = supplier.ele("DatiAnagrafici");
  fiscalId(supplierData, "IdFiscaleIVA", "IT", m.supplier.vatNumber);
  text(supplierData, "CodiceFiscale", m.supplier.taxCode);
  const supplierName = supplierData.ele("Anagrafica");
  text(supplierName, "Nome", m.supplier.firstName);
  text(supplierName, "Cognome", m.supplier.lastName);
  if (m.supplier.albo) {
    text(supplierData, "AlboProfessionale", m.supplier.albo.order);
    text(supplierData, "ProvinciaAlbo", m.supplier.albo.province);
    text(supplierData, "NumeroIscrizioneAlbo", m.supplier.albo.number);
    text(supplierData, "DataIscrizioneAlbo", m.supplier.albo.date);
  }
  text(supplierData, "RegimeFiscale", m.supplier.regimeCode);
  address(supplier, m.supplier.address);

  const customer = header.ele("CessionarioCommittente");
  const customerData = customer.ele("DatiAnagrafici");
  if (m.customer.vatNumber !== null) fiscalId(customerData, "IdFiscaleIVA", "IT", m.customer.vatNumber);
  text(customerData, "CodiceFiscale", m.customer.taxCode);
  const customerName = customerData.ele("Anagrafica");
  if (m.customer.name !== null) {
    text(customerName, "Denominazione", m.customer.name);
  } else {
    text(customerName, "Nome", m.customer.firstName);
    text(customerName, "Cognome", m.customer.lastName);
  }
  address(customer, m.customer.address);

  const body = root.ele("FatturaElettronicaBody");
  const general = body.ele("DatiGenerali");
  const document = general.ele("DatiGeneraliDocumento");
  text(document, "TipoDocumento", m.document.type);
  text(document, "Divisa", "EUR");
  text(document, "Data", m.document.date);
  text(document, "Numero", m.document.number);
  if (m.document.withholding) {
    const withholding = document.ele("DatiRitenuta");
    text(withholding, "TipoRitenuta", PERSONAL_WITHHOLDING_TYPE);
    text(withholding, "ImportoRitenuta", xmlAmount(m.document.withholding.amountCents));
    text(withholding, "AliquotaRitenuta", xmlPercent(m.document.withholding.rateBp));
    text(withholding, "CausalePagamento", PROFESSIONAL_PAYMENT_REASON);
  }
  if (m.document.stampCents !== null) {
    const stamp = document.ele("DatiBollo");
    text(stamp, "BolloVirtuale", "SI");
    text(stamp, "ImportoBollo", xmlAmount(m.document.stampCents));
  }
  if (m.document.pension) {
    const pension = document.ele("DatiCassaPrevidenziale");
    const p = m.document.pension;
    text(pension, "TipoCassa", INPS_PENSION_FUND);
    text(pension, "AlCassa", xmlPercent(p.rateBp));
    text(pension, "ImportoContributoCassa", xmlAmount(p.amountCents));
    text(pension, "ImponibileCassa", xmlAmount(p.baseCents));
    text(pension, "AliquotaIVA", xmlPercent(p.vatRateBp));
    if (p.withholding) text(pension, "Ritenuta", "SI");
    text(pension, "Natura", p.nature);
  }
  text(document, "ImportoTotaleDocumento", xmlAmount(m.document.totalCents));
  for (const causale of m.document.causali) text(document, "Causale", causale);
  if (m.document.linked) {
    const linked = general.ele("DatiFattureCollegate");
    text(linked, "IdDocumento", m.document.linked.number);
    text(linked, "Data", m.document.linked.date);
  }

  const services = body.ele("DatiBeniServizi");
  for (const line of m.lines) {
    const detail = services.ele("DettaglioLinee");
    text(detail, "NumeroLinea", line.number);
    text(detail, "Descrizione", line.description);
    text(detail, "Quantita", xmlQuantity(line.quantity));
    text(detail, "PrezzoUnitario", line.unitPrice);
    text(detail, "PrezzoTotale", xmlAmount(line.totalCents));
    text(detail, "AliquotaIVA", xmlPercent(line.vatRateBp));
    if (line.withholding) text(detail, "Ritenuta", "SI");
    text(detail, "Natura", line.nature);
  }
  for (const row of m.summary) {
    const summary = services.ele("DatiRiepilogo");
    text(summary, "AliquotaIVA", xmlPercent(row.vatRateBp));
    text(summary, "Natura", row.nature);
    text(summary, "ImponibileImporto", xmlAmount(row.taxableCents));
    text(summary, "Imposta", xmlAmount(row.vatCents));
    text(summary, "EsigibilitaIVA", row.esigibilita);
    text(summary, "RiferimentoNormativo", row.reference);
  }

  if (m.payment) {
    const payment = body.ele("DatiPagamento");
    text(payment, "CondizioniPagamento", FULL_PAYMENT_CONDITION);
    const detail = payment.ele("DettaglioPagamento");
    text(detail, "Beneficiario", m.payment.beneficiary);
    text(detail, "ModalitaPagamento", m.payment.method);
    text(detail, "DataScadenzaPagamento", m.payment.dueDate);
    text(detail, "ImportoPagamento", xmlAmount(m.payment.amountCents));
    text(detail, "IBAN", m.payment.iban);
  }
  return root.end({ prettyPrint: true });
}

export function xmlSha256(xml: string): string {
  return createHash("sha256").update(xml, "utf8").digest("hex");
}
