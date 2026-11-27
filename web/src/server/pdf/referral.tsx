import { Document, Image as PdfImage, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReferralLetter } from "@/server/domain/referrals/queries";

// La lettera al medico in PDF: A4 con l'Helvetica integrata
// di react-pdf (WinAnsi copre il Latin-1), nessun font nel repo. Intestazione dello studio, destinatario,
// città e data della lettera, paziente, sintesi, richiesta, nome e firma dell'osteopata, oppure una riga
// "Firma" se assente. In demo "DATI DI PROVA" chiaro e ruotato su ogni pagina.

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
  header: { marginBottom: 28 },
  studioName: { fontFamily: "Helvetica-Bold", fontSize: 13 },
  studioLine: { fontSize: 9.5, color: "#4a4a4a" },
  recipient: { marginLeft: "50%", marginBottom: 22 },
  day: { textAlign: "right", marginBottom: 20 },
  patient: { fontFamily: "Helvetica-Bold", marginBottom: 14 },
  paragraph: { marginBottom: 12 },
  signature: { marginTop: 24, marginLeft: "50%" },
  signLine: {
    marginTop: 36,
    paddingTop: 3,
    borderTopWidth: 0.75,
    borderTopColor: "#6b6b6b",
    fontSize: 9,
    color: "#4a4a4a",
  },
});

export function ReferralDocument({ letter, practitionerSignaturePng }: { letter: ReferralLetter; practitionerSignaturePng?: Uint8Array | null }): React.JSX.Element {
  return (
    <Document title="Lettera al medico" language="it">
      <Page size="A4" style={styles.page}>
        {letter.demo ? (
          <Text fixed style={styles.watermark}>
            DATI DI PROVA
          </Text>
        ) : null}
        <View style={styles.header}>
          <Text style={styles.studioName}>{letter.studio.name}</Text>
          {letter.studio.lines.map((line) => (
            <Text key={line} style={styles.studioLine}>
              {line}
            </Text>
          ))}
        </View>
        <Text style={styles.recipient}>{letter.recipient.text}</Text>
        <Text style={styles.day}>{letter.dayText}</Text>
        <Text style={styles.patient}>{`Paziente: ${letter.patient.name}, ${letter.patient.birthDateText}`}</Text>
        <Text style={styles.paragraph}>{letter.summaryText}</Text>
        <Text style={styles.paragraph}>{letter.requestText}</Text>
        <View style={styles.signature} wrap={false}>
          <Text>{letter.signature}</Text>
          {practitionerSignaturePng ? (
            <PdfImage src={{ data: Buffer.from(practitionerSignaturePng), format: "png" }} style={{ width: 180, height: 64, objectFit: "contain", marginTop: 12 }} />
          ) : <Text style={styles.signLine}>Firma</Text>}
        </View>
      </Page>
    </Document>
  );
}
