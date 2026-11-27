// Frasi dei consensi che servono anche al client: niente import del server, così un componente
// che le mostra non si porta dietro react-pdf.

/** La firma è salvata, il PDF no: si riprova con «Scarica PDF». */
export const PDF_NOT_CREATED = "Firma salvata, ma il PDF non è stato creato. Riprova a crearlo.";

/** Il consenso al trattamento vuole un ciclo aperto: senza, la raccolta del trattamento è spenta. */
export const NO_CYCLE = "Il consenso al trattamento si raccoglie per un ciclo: fissa prima un appuntamento.";

/** Un minore senza un genitore con responsabilità genitoriale o un tutore: nessuno può firmare per lui. */
export const NO_GUARDIAN =
  "Per un minore serve un genitore con responsabilità genitoriale o un tutore: aggiungilo nell'anagrafica.";

/** Un rifiuto del trattamento blocca come una revoca: la frase gemella di `TREATMENT_CONSENT_REVOKED`. */
export const TREATMENT_CONSENT_REFUSED = "Consenso al trattamento rifiutato: puoi solo annotare il colloquio.";
