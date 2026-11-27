// `PdfImage`: l'immagine di react-pdf non ha `alt` (la regola jsx-a11y pensa a `next/image`).
import { Document, Image as PdfImage, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { dayField, timeOf } from "@/lib/format";

// Il PDF di un consenso: A4 con l'Helvetica integrata, come la lettera
// al medico. Stampa il testo congelato, la versione del modulo, i dati mancanti e, firmato sulla tela, luogo,
// giorno e ora della fotografia con le firme di chi firma, dell'eventuale secondo genitore e dell'osteopata
// (se c'era alla firma: altrimenti resta la riga vuota). La stampa senza firma (`blank`) ha le stesse righe
// vuote e non dichiara nessuna firma. In demo "DATI DI PROVA" su ogni pagina; nessun marchio del prodotto.

export type ConsentDocumentData = {
  mode: "blank" | "signed";
  text: string;
  signerName: string;
  secondGuardianName: string | null;
  signedOn: string;
  signedAt: string | null;
  place: string;
  signaturePng: Uint8Array | null;
  secondSignaturePng: Uint8Array | null;
  practitionerSignaturePng: Uint8Array | null;
  demo: boolean;
  /** La versione del modulo, "2026.1". */
  version: string;
  /** Le etichette dei dati vuoti alla firma o all'anteprima ("numero di polizza"). */
  missingLabels: readonly string[];
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 56,
    paddingBottom: 56,
    paddingHorizontal: 60,
    fontFamily: "Helvetica",
    fontSize: 10.5,
    lineHeight: 1.45,
    color: "#1f1f1f",
  },
  watermark: {
    position: "absolute",
    top: 380,
    left: 0,
    right: 0,
    textAlign: "center",
    fontFamily: "Helvetica-Bold",
    fontSize: 64,
    color: "#e2e2e2",
    transform: "rotate(-35deg)",
  },
  title: { fontFamily: "Helvetica-Bold", fontSize: 13, marginBottom: 14 },
  paragraph: { marginBottom: 10 },
  footer: { marginTop: 18 },
  meta: { fontSize: 9.5, color: "#4a4a4a" },
  signatures: { flexDirection: "row", flexWrap: "wrap", marginTop: 18 },
  box: { width: "50%", paddingRight: 18, marginBottom: 14 },
  image: { height: 48, objectFit: "contain", objectPosition: "left" },
  empty: { height: 48 },
  signLine: {
    paddingTop: 3,
    borderTopWidth: 0.75,
    borderTopColor: "#6b6b6b",
    fontSize: 9,
    color: "#4a4a4a",
  },
});

function Signature({ png, label }: { png: Uint8Array | null; label: string }) {
  return (
    <View style={styles.box} wrap={false}>
      {png ? <PdfImage style={styles.image} src={{ data: Buffer.from(png), format: "png" }} /> : <View style={styles.empty} />}
      <Text style={styles.signLine}>{label}</Text>
    </View>
  );
}

export function ConsentDocument({ data }: { data: ConsentDocumentData }) {
  const signed = data.mode === "signed";
  const [title, ...paragraphs] = data.text.split(/\n{2,}/);
  const missing = data.missingLabels.join(", ");
  const at = data.signedAt === null ? "" : ` alle ${timeOf(new Date(data.signedAt))}`;
  return (
    <Document title="Modulo di consenso" language="it">
      <Page size="A4" style={styles.page}>
        {data.demo ? (
          <Text fixed style={styles.watermark}>
            DATI DI PROVA
          </Text>
        ) : null}
        <Text style={styles.title}>{title}</Text>
        {paragraphs.map((paragraph, index) => (
          <Text key={index} style={styles.paragraph}>
            {paragraph}
          </Text>
        ))}
        <View style={styles.footer} wrap={false}>
          <Text style={styles.meta}>{`Versione del modulo ${data.version}`}</Text>
          {missing ? (
            <Text style={styles.meta}>{signed ? `Firmato con dati mancanti: ${missing}.` : `Dati da completare: ${missing}.`}</Text>
          ) : null}
          {signed ? <Text>{`Firmato a ${data.place} il ${dayField(data.signedOn)}${at}.`}</Text> : null}
          <View style={styles.signatures}>
            <Signature png={signed ? data.signaturePng : null} label={`Firma di ${data.signerName}`} />
            {data.secondGuardianName ? (
              <Signature png={signed ? data.secondSignaturePng : null} label={`Firma del secondo genitore, ${data.secondGuardianName}`} />
            ) : null}
            <Signature png={signed ? data.practitionerSignaturePng : null} label="Firma dell'osteopata" />
          </View>
        </View>
      </Page>
    </Document>
  );
}
