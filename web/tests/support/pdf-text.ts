import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const infoKeys = new Set(["Title", "Author", "Subject", "Creator", "Producer"]);

/** Legge tutte le pagine e i campi testuali del dizionario Info di un PDF. */
export async function pdfText(bytes: Uint8Array): Promise<{ text: string; info: Record<string, string> }> {
  // Una copia evita il trasferimento del Buffer del chiamante; in Node PDF.js usa il worker interno.
  const task = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false });

  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }

    const metadata = await document.getMetadata();
    const info: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata.info)) {
      if (infoKeys.has(key) && typeof value === "string") info[key] = value;
    }

    return { text: pages.join("\n"), info };
  } finally {
    await task.destroy();
  }
}
