import type { DocType } from "./types";

export function numberLabel(docType: DocType, n: number, year: number): string {
  return `${docType === "TD04" ? "NC-" : ""}${n}/${year}`;
}

export function progressive(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 60466175) {
    throw new RangeError("Il progressivo deve essere un intero tra 0 e 60466175.");
  }
  return n.toString(36).toUpperCase().padStart(5, "0");
}

export function xmlFileName(taxCode: string, progressive: string): string {
  return `IT${taxCode}_${progressive}.xml`;
}

export function downloadXmlName(fileName: string, isDemo: boolean): string {
  return `${isDemo ? "PROVA_" : ""}${fileName}`;
}

export function pdfFileName(docType: DocType, label: string): string {
  return `${docType === "TD04" ? "NotaCredito" : "Fattura"}_${label.replaceAll("/", "-")}.pdf`;
}
