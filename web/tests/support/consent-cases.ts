import type { ConsentValues } from "@/lib/consents/render";

// Dati interamente inventati. Date di calendario ISO e importi in centesimi interi,
// serializzati come stringhe perché ConsentValues è anche il confine dell'anteprima.
export const SOFIA_VALUES: ConsentValues = {
  "studio.nome": "Studio Esempio",
  "studio.indirizzo": "Via della Prova 12, Verona",
  "studio.telefono": "+390450000000",
  "studio.email": "studio@example.test",
  "studio.pec": "studio@pec.example.test",
  "osteopata.nome_completo": "Chiara Esempio",
  "osteopata.iscrizione": "iscritta all'elenco speciale ad esaurimento degli osteopati presso l'Ordine TSRM PSTRP di Verona, n. 0000",
  "polizza.compagnia": "Assicurazioni Esempio",
  "polizza.numero": "RC-0000-DEMO",
  "polizza.massimale": "100000000",
  "paziente.nome_completo": "Sofia Rinaldi",
  "paziente.data_nascita": "2020-05-12",
  "paziente.luogo_nascita": "Verona",
  "paziente.codice_fiscale": "RNLSFO20E52X999A",
  "paziente.indirizzo": "Via della Prova 3, Verona",
  "paziente.medico_curante": "Dott.ssa Ada Esempio",
  "paziente.medico_inviante": "Dott. Bruno Prova",
  "genitore.nome_completo": "Elena Rinaldi",
  "genitore.codice_fiscale": "RNLLNE85A41X999B",
  "listino.prima_visita": "8000",
  "listino.seduta": "5500",
  "listino.controllo": "4500",
  "conservazione.anni": "10",
  "documento.data": "2026-11-04",
  "documento.luogo": "Verona",
};

export const ADULT_VALUES: ConsentValues = {
  ...SOFIA_VALUES,
  "paziente.nome_completo": "Marco Prova",
  "paziente.data_nascita": "1990-01-01",
  "paziente.codice_fiscale": "PRVMRC90A01X999S",
};
