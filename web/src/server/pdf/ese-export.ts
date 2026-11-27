import { strToU8, zipSync, type Zippable } from "fflate";
import { pdfFileName } from "@/lib/fiscal/numbering";
import type { EseDocument } from "@/lib/fiscal/redact";
import type { InvoiceSnapshot } from "@/lib/fiscal/snapshot";
import { dayField, monthYear, romeDay, timeOf } from "@/lib/format";
import { centsToInput } from "@/lib/money";
import { sha256Of } from "@/server/files/sniff";
import { renderInvoicePdf } from "./render";

export type { EseDocument } from "@/lib/fiscal/redact";

// Export oscurato per l'elenco speciale: ogni fattura e nota del periodo si
// rigenera dalla fotografia con i dati del destinatario sostituiti (mai rettangoli sopra il PDF originale,
// Garante 9954241/2023). Lo ZIP si costruisce in memoria; nomi dei file, indice e LEGGIMI non portano dati
// dell'assistito.

export const ESE_INDEX_HEADER = "mese;tipo;numero;data;totale;stato;data_incasso";

/** Le righe del LEGGIMI.txt: la regola di oscuramento è la stessa per ogni export. */
const RULES = [
  "Regola di oscuramento:",
  '1. Nome, cognome e denominazione del destinatario sostituiti da "Dati dell\'assistito oscurati".',
  "2. Codice fiscale, partita IVA, indirizzo, codice destinatario, PEC e contatti del destinatario rimossi.",
  "3. Nome del minore rimosso; descrizioni delle righe sostituite con quella standard del listino.",
  "4. Causali libere, note e IBAN rimossi; restano le diciture del regime.",
  "5. Restano titolare, numero, data, importi, regime, data della prestazione, metodo e data del pagamento.",
];

function readme(from: string, to: string, count: number, generatedAt: Date): string {
  return [
    "Fatture e note di credito con i dati degli assistiti oscurati.",
    `Periodo: da ${monthYear(`${from}-01`)} a ${monthYear(`${to}-01`)}.`,
    `Documenti: ${count}. Generato il ${dayField(romeDay(generatedAt))} alle ${timeOf(generatedAt)}.`,
    ...RULES,
  ].join("\n") + "\n";
}

function indexRow(doc: EseDocument): string {
  const { snapshot } = doc;
  return [
    snapshot.issueDate.slice(0, 7),
    snapshot.docType === "TD04" ? "Nota di credito" : "Fattura",
    snapshot.numberLabel,
    dayField(snapshot.issueDate),
    centsToInput(snapshot.computation.totalCents),
    doc.status,
    doc.paidOn ? dayField(doc.paidOn) : "",
  ].join(";");
}

/** `AAAA-MM/AAAA-MM-GG_Fattura_262-2026.pdf`: nessun dato dell'assistito. */
function pdfPath(snapshot: InvoiceSnapshot): string {
  const name = pdfFileName(snapshot.docType, snapshot.numberLabel).replace(/\.pdf$/, "");
  return `${snapshot.issueDate.slice(0, 7)}/${snapshot.issueDate}_${name}.pdf`;
}

/** Lo ZIP dell'export: `LEGGIMI.txt`, `indice.csv` e un PDF oscurato per documento, nell'ordine ricevuto. */
export async function buildEseZip(input: {
  from: string;
  to: string;
  generatedAt: Date;
  documents: readonly EseDocument[];
}): Promise<{ fileName: string; bytes: Uint8Array; sha256: string; count: number }> {
  const { from, to, generatedAt, documents } = input;
  const files: Zippable = {
    "LEGGIMI.txt": strToU8(readme(from, to, documents.length, generatedAt)),
    "indice.csv": strToU8(`${[ESE_INDEX_HEADER, ...documents.map(indexRow)].join("\n")}\n`),
  };
  for (const doc of documents) {
    const pdf = await renderInvoicePdf(doc.snapshot, "oscurata", doc.standardDescriptions);
    // I PDF sono già compressi.
    files[pdfPath(doc.snapshot)] = [new Uint8Array(pdf), { level: 0 }];
  }
  const bytes = zipSync(files, { mtime: generatedAt });
  return { fileName: `fatture-oscurate_${from}_${to}.zip`, bytes, sha256: sha256Of(bytes), count: documents.length };
}
