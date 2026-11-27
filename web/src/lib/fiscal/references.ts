export type LegalKey =
  | "forfettario_xml"
  | "forfettario_dicitura"
  | "forfettario_no_ritenuta"
  | "esente_xml"
  | "bollo_virtuale_pdf"
  | "bollo_contrassegno_pdf"
  | "bollo_virtuale_autorizzato_pdf"
  | "copia_cortesia_pdf";

export const LEGAL_KEYS: readonly LegalKey[] = [
  "forfettario_xml",
  "forfettario_dicitura",
  "forfettario_no_ritenuta",
  "esente_xml",
  "bollo_virtuale_pdf",
  "bollo_contrassegno_pdf",
  "bollo_virtuale_autorizzato_pdf",
  "copia_cortesia_pdf",
];

export const RIVALSA_PDF = "Rivalsa INPS 4% (art. 1 c. 212 L. 662/1996)";
export const REFERENCES_2027_NOTE = "Riferimenti 2027 da confermare";
export const REFERENCES_CHANGE_NOTE = "Dal 1/01/2027 cambiano i riferimenti: il gestionale li aggiorna da solo per le fatture datate 2027";

const TEXTS_2026: Record<LegalKey, string> = {
  forfettario_xml: "Operazione in franchigia da IVA, art. 1 c. 54-89 L. 190/2014",
  forfettario_dicitura: "Operazione effettuata ai sensi dell'art. 1, commi da 54 a 89, L. 190/2014, regime forfettario.",
  forfettario_no_ritenuta: "Compenso non soggetto a ritenuta d'acconto ai sensi dell'art. 1, c. 67, L. 190/2014.",
  esente_xml: "Esente IVA art. 10 c. 1 n. 18 DPR 633/1972",
  bollo_virtuale_pdf: "Imposta di bollo assolta in modo virtuale ai sensi dell'art. 6 del DM 17 giugno 2014.",
  bollo_contrassegno_pdf: "Imposta di bollo assolta sull'originale, contrassegno n. {stamp_mark_code}.",
  bollo_virtuale_autorizzato_pdf: "Imposta di bollo assolta in modo virtuale, autorizzazione {paper_stamp_authorization} (art. 15 DPR 642/1972).",
  copia_cortesia_pdf: "Copia di cortesia. L'originale della fattura elettronica è a disposizione nella sua area riservata del sito web dell'Agenzia delle Entrate.",
};

interface LegalVersion {
  from: string;
  texts: Record<LegalKey, string>;
  confirmed: boolean;
}

const BASE_VERSION: LegalVersion = { from: "0001-01-01", texts: TEXTS_2026, confirmed: true };

// Anche i testi invariati restano da confermare dal 2027.
const VERSIONS: readonly LegalVersion[] = [
  BASE_VERSION,
  {
    from: "2027-01-01",
    confirmed: false,
    texts: {
      ...TEXTS_2026,
      forfettario_xml: "Operazione in franchigia da IVA, Capo XXI D.Lgs. 117/2026",
      forfettario_dicitura: "Operazione effettuata ai sensi del Capo XXI del D.Lgs. 117/2026, regime forfettario.",
      forfettario_no_ritenuta: "Compenso non soggetto a ritenuta d'acconto ai sensi del Capo XXI del D.Lgs. 117/2026.",
      esente_xml: "Esente IVA art. 37 D.Lgs. 10/2026",
    },
  },
];

/** La data di calendario della fattura sceglie i testi, senza leggere l'orologio. */
export function legalText(key: LegalKey, invoiceDate: string): { text: string; confirmed: boolean } {
  let selected = BASE_VERSION;
  for (const version of VERSIONS) {
    if (invoiceDate >= version.from) selected = version;
  }
  return { text: selected.texts[key], confirmed: selected.confirmed };
}

/** I segnaposto senza un valore restano visibili; i valori sono inseriti letteralmente. */
export function fillLegal(text: string, values: Record<string, string>): string {
  return text.replace(/\{([^{}]+)\}/g, (placeholder: string, name: string) =>
    Object.hasOwn(values, name) ? values[name]! : placeholder,
  );
}
