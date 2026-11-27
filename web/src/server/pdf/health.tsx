import { Document, Page, Text, renderToBuffer } from "@react-pdf/renderer";

export function renderHealthPdf(): Promise<Buffer> {
  return renderToBuffer(
    <Document>
      <Page size="A4">
        <Text>Prova PDF</Text>
      </Page>
    </Document>,
  );
}
