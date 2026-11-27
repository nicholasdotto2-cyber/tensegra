import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { xmlUnitPrice } from "@/lib/fiscal/model";
import { downloadXmlName } from "@/lib/fiscal/numbering";
import { RIVALSA_PDF } from "@/lib/fiscal/references";
import type { InvoiceSnapshot, SnapshotAddress, SnapshotLine } from "@/lib/fiscal/snapshot";
import { dayField, money } from "@/lib/format";

// La copia di cortesia della fattura: A4 con l'Helvetica
// integrata di react-pdf, come la lettera al medico. Tutto viene dalla fotografia congelata all'emissione:
// le righe stampano il netto di ogni riga (`netTotalCents`, mai ricalcolato) come l'XML. Nessun nome del
// prodotto e nessun dato clinico. Con `isDemo` una filigrana dice che la fattura non è trasmessa.
// La variante `oscurata` (export per l'elenco speciale) toglie ogni dato del destinatario, l'IBAN e le
// descrizioni scritte a mano.

export type InvoiceVariant = "copia" | "oscurata";

export const DEMO_WATERMARK = "DATI DI PROVA. Non trasmessa al Sistema di Interscambio";
export const REDACTED_RECIPIENT = "Dati dell'assistito oscurati";
export const REDACTED_DESCRIPTION = "Prestazione osteopatica";

const styles = StyleSheet.create({
  page: {
    paddingTop: 44,
    paddingBottom: 48,
    paddingHorizontal: 44,
    fontFamily: "Helvetica",
    fontSize: 9.5,
    lineHeight: 1.4,
    color: "#1f1f1f",
  },
  watermark: {
    position: "absolute",
    top: 400,
    left: 0,
    right: 0,
    textAlign: "center",
    fontFamily: "Helvetica-Bold",
    fontSize: 17,
    color: "#e2e2e2",
    transform: "rotate(-35deg)",
  },
  parties: { flexDirection: "row", justifyContent: "space-between", marginBottom: 22 },
  party: { width: "48%" },
  partyLabel: { fontSize: 8, color: "#6b6b6b", textTransform: "uppercase", marginBottom: 2 },
  partyName: { fontFamily: "Helvetica-Bold", fontSize: 11 },
  muted: { color: "#4a4a4a" },
  title: { fontFamily: "Helvetica-Bold", fontSize: 12, marginBottom: 12 },
  headRow: {
    flexDirection: "row",
    borderBottomWidth: 0.75,
    borderBottomColor: "#6b6b6b",
    paddingBottom: 3,
    fontFamily: "Helvetica-Bold",
    fontSize: 8.5,
  },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#d4d4d4", paddingVertical: 4 },
  colDescription: { flexGrow: 1, flexShrink: 1, paddingRight: 8 },
  colDate: { width: 54 },
  colQuantity: { width: 46, textAlign: "right" },
  colPrice: { width: 64, textAlign: "right" },
  colAmount: { width: 64, textAlign: "right" },
  colVat: { width: 72, paddingLeft: 8, textAlign: "right" },
  summary: { alignSelf: "flex-end", width: 270, marginTop: 14 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 1.5 },
  summaryTotal: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
    marginTop: 2,
    borderTopWidth: 0.75,
    borderTopColor: "#6b6b6b",
    fontFamily: "Helvetica-Bold",
  },
  sectionTitle: { fontFamily: "Helvetica-Bold", marginTop: 16, marginBottom: 2 },
  note: { marginTop: 3 },
  footer: { marginTop: 18, paddingTop: 6, borderTopWidth: 0.5, borderTopColor: "#9a9a9a", fontSize: 8.5, color: "#4a4a4a" },
});

const nbsp = (text: string) => text.replace(/ /g, " ");
const euro = (cents: number) => nbsp(money(cents));

/** "22%" in colonna: l'aliquota, oppure la natura in parole. */
function vatLabel(line: SnapshotLine): string {
  if (line.nature === "N2.2") return "Non soggetta";
  if (line.nature === "N4") return "Esente";
  return `${String(line.vatRateBp / 100).replace(".", ",")}%`;
}

/** Il prezzo unitario netto è quello dell'XML: `xmlUnitPrice`, scritto all'italiana. */
function unitPrice(line: SnapshotLine): string {
  const [whole = "0", fraction = "00"] = xmlUnitPrice(line.netTotalCents, line.quantity).split(".");
  if (fraction.length === 2) return euro(Number(whole) * 100 + Number(fraction));
  return `${Number(whole).toLocaleString("it-IT")},${fraction} €`;
}

function addressLines(address: SnapshotAddress): string[] {
  const place = [address.postalCode, address.city].filter(Boolean).join(" ");
  const province = address.province ? ` (${address.province})` : "";
  return [address.line, `${place}${province}`].filter((line) => line.trim() !== "");
}

function registrationLine(snapshot: InvoiceSnapshot): string | null {
  const { kind, order, province, number } = snapshot.supplier.registration;
  const orderText = order?.trim() || (province ? `Ordine TSRM PSTRP di ${province}` : "Ordine TSRM PSTRP");
  const numberText = number?.trim() ?? "";
  switch (kind) {
    case "ese":
      return `Iscritto all'elenco speciale degli osteopati, ${orderText}, n. ${numberText}`;
    case "albo":
      return `Iscritto all'albo: ${orderText}, n. ${numberText}`;
    case "in_attesa":
      return "Domanda di iscrizione all'elenco speciale presentata";
    default:
      return null;
  }
}

function titleOf(snapshot: InvoiceSnapshot): string {
  const day = dayField(snapshot.issueDate);
  if (snapshot.docType === "TD04") {
    const storno = snapshot.credited
      ? `, storno della fattura n. ${snapshot.credited.numberLabel} del ${dayField(snapshot.credited.issueDate)}`
      : "";
    return `Nota di credito n. ${snapshot.numberLabel} del ${day}${storno}`;
  }
  return `Fattura n. ${snapshot.numberLabel} del ${day}`;
}

function infoTitle(snapshot: InvoiceSnapshot): string {
  return `${snapshot.docType === "TD04" ? "Nota di credito" : "Fattura"} ${snapshot.numberLabel}`;
}

const METHOD_PAID: Record<InvoiceSnapshot["payment"]["method"], string> = {
  contanti: "in contanti",
  carta: "con carta",
  bonifico: "con bonifico",
};

/** Pagamento: nessuno per la nota di credito, che non ha un incasso. */
function paymentLine(snapshot: InvoiceSnapshot, redacted: boolean): string | null {
  if (snapshot.docType === "TD04") return null;
  const { method, paidOn, dueDate, iban, beneficiary } = snapshot.payment;
  if (paidOn) return `Pagata il ${dayField(paidOn)} ${METHOD_PAID[method]}`;
  if (method !== "bonifico") return `Da pagare ${METHOD_PAID[method]}`;
  const due = dueDate ? ` entro il ${dayField(dueDate)}` : "";
  const bank = !redacted && iban ? `, IBAN ${iban}${beneficiary ? `, intestato a ${beneficiary}` : ""}` : "";
  return `Da pagare con bonifico${due}${bank}`;
}

function Recipient({ snapshot, redacted }: { snapshot: InvoiceSnapshot; redacted: boolean }) {
  const r = snapshot.recipient;
  if (redacted) {
    return (
      <View>
        <Text style={styles.partyName}>{REDACTED_RECIPIENT}</Text>
        <Text style={styles.muted}>{r.kind === "committente" ? "Destinatario: soggetto IVA" : "Destinatario: persona fisica"}</Text>
      </View>
    );
  }
  const name = r.name ?? [r.firstName, r.lastName].filter(Boolean).join(" ");
  const code = r.recipientCode && r.recipientCode !== "0000000" ? `Codice destinatario: ${r.recipientCode}` : null;
  const pec = !code && r.pec ? `PEC: ${r.pec}` : null;
  return (
    <View>
      <Text style={styles.partyName}>{name}</Text>
      {r.kind === "tutore" && r.minorName ? <Text style={styles.muted}>{`per ${r.minorName}`}</Text> : null}
      {addressLines(r.address).map((line) => (
        <Text key={line}>{line}</Text>
      ))}
      {r.vatNumber ? <Text>{`Partita IVA: ${r.vatNumber}`}</Text> : null}
      {r.taxCode ? <Text>{`Codice fiscale: ${r.taxCode}`}</Text> : null}
      {code ? <Text>{code}</Text> : null}
      {pec ? <Text>{pec}</Text> : null}
    </View>
  );
}

/**
 * Le note: le diciture del regime e del bollo. La rivalsa sta già nel riepilogo con la sua
 * dicitura, e l'importo dell'imposta di bollo nel rimborso (riga e riepilogo): qui non si ripetono.
 */
function noteTexts(snapshot: InvoiceSnapshot): string[] {
  const c = snapshot.computation;
  return snapshot.texts.pdf.filter((text) => {
    if (text === RIVALSA_PDF) return c.surchargeCents === 0;
    if (/^Imposta di bollo \d/.test(text)) return c.stampChargedCents === 0;
    return true;
  });
}

/** Le righe del riepilogo: solo quelle diverse da zero. */
function summaryRows(snapshot: InvoiceSnapshot): { label: string; cents: number; strong?: boolean }[] {
  const c = snapshot.computation;
  const vatRate = String(c.lineVatRateBp / 100).replace(".", ",");
  const rows = [
    { label: "Compensi", cents: c.feesCents },
    { label: RIVALSA_PDF, cents: c.surchargeCents },
    { label: "Imponibile", cents: c.taxableCents },
    { label: `IVA ${vatRate}%`, cents: c.vatCents },
    { label: "Rimborso imposta di bollo", cents: c.stampChargedCents },
    { label: "Totale", cents: c.totalCents, strong: true },
    { label: "Ritenuta d'acconto", cents: -c.withholdingCents },
    { label: "Netto a pagare", cents: c.withholdingCents === 0 ? 0 : c.netCents, strong: true },
  ];
  return rows.filter((row) => row.cents !== 0);
}

export function InvoiceDocument({
  snapshot,
  variant,
  standardDescriptions,
}: {
  snapshot: InvoiceSnapshot;
  variant: InvoiceVariant;
  standardDescriptions?: readonly (string | null)[];
}) {
  const redacted = variant === "oscurata";
  const supplier = snapshot.supplier;
  const holder = `${supplier.firstName} ${supplier.lastName}`.trim();
  const registration = registrationLine(snapshot);
  const payment = paymentLine(snapshot, redacted);
  const notes = noteTexts(snapshot);
  const xmlName =
    snapshot.electronic && snapshot.transmission ? downloadXmlName(snapshot.transmission.fileName, snapshot.isDemo) : null;
  const descriptionOf = (line: SnapshotLine, index: number): string => {
    if (!redacted || line.kind === "rimborso_bollo") return line.description;
    return standardDescriptions?.[index] ?? REDACTED_DESCRIPTION;
  };

  return (
    <Document title={infoTitle(snapshot)} author={holder} language="it">
      <Page size="A4" style={styles.page}>
        {snapshot.isDemo ? (
          <Text fixed style={styles.watermark}>
            {DEMO_WATERMARK}
          </Text>
        ) : null}

        <View style={styles.parties}>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>Cedente</Text>
            <Text style={styles.partyName}>{holder}</Text>
            <Text>{supplier.practiceName}</Text>
            {addressLines(supplier.address).map((line) => (
              <Text key={line}>{line}</Text>
            ))}
            <Text>{`Partita IVA: ${supplier.vatNumber}`}</Text>
            <Text>{`Codice fiscale: ${supplier.taxCode}`}</Text>
            {registration ? <Text style={styles.muted}>{registration}</Text> : null}
          </View>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>Destinatario</Text>
            <Recipient snapshot={snapshot} redacted={redacted} />
          </View>
        </View>

        <Text style={styles.title}>{titleOf(snapshot)}</Text>

        <View style={styles.headRow} wrap={false}>
          <Text style={styles.colDescription}>Descrizione</Text>
          <Text style={styles.colDate}>Data</Text>
          <Text style={styles.colQuantity}>Quantità</Text>
          <Text style={styles.colPrice}>Prezzo</Text>
          <Text style={styles.colAmount}>Importo</Text>
          <Text style={styles.colVat}>IVA</Text>
        </View>
        {snapshot.lines.map((line, index) => (
          <View key={line.lineNumber} style={styles.row} wrap={false}>
            <Text style={styles.colDescription}>{descriptionOf(line, index)}</Text>
            <Text style={styles.colDate}>{line.serviceDate ? dayField(line.serviceDate) : ""}</Text>
            <Text style={styles.colQuantity}>{String(line.quantity)}</Text>
            <Text style={styles.colPrice}>{unitPrice(line)}</Text>
            <Text style={styles.colAmount}>{euro(line.netTotalCents)}</Text>
            <Text style={styles.colVat}>{vatLabel(line)}</Text>
          </View>
        ))}

        <View style={styles.summary} wrap={false}>
          {summaryRows(snapshot).map((row) => (
            <View key={row.label} style={row.strong ? styles.summaryTotal : styles.summaryRow}>
              <Text>{row.label}</Text>
              <Text>{euro(row.cents)}</Text>
            </View>
          ))}
        </View>

        {payment ? (
          <View wrap={false}>
            <Text style={styles.sectionTitle}>Pagamento</Text>
            <Text>{payment}</Text>
          </View>
        ) : null}

        {notes.length > 0 ? (
          <View>
            <Text style={styles.sectionTitle}>Note</Text>
            {notes.map((text) => (
              <Text key={text} style={styles.note}>
                {text}
              </Text>
            ))}
          </View>
        ) : null}

        <View style={styles.footer} wrap={false}>
          <Text>{snapshot.texts.footer}</Text>
          {xmlName ? <Text>{`File XML: ${xmlName}`}</Text> : null}
        </View>
      </Page>
    </Document>
  );
}
