// Etichette italiane dei codici clinici.
// Sicuro per il client: nessun import dal server. I codici sono quelli dei check di
// `..._clinical.sql` e `..._patients.sql`.

import type { Family, Outcome, RiskTag } from "./catalog";

export const FAMILY_LABEL: Record<Family, string> = {
  thrust: "Thrust",
  direct: "Dirette",
  indirect: "Indirette",
};

/** L'esito dello screening dentro una frase ("... è indicato"). */
export const OUTCOME_TEXT: Record<Outcome, string> = {
  indicated: "indicato",
  caution: "con cautela",
  contraindicated: "controindicato",
};

/** Severità per regione. */
export const SEVERITY_LABEL: Record<0 | 1 | 2 | 3, string> = {
  0: "Assente o di fondo",
  1: "Lieve",
  2: "Evidente",
  3: "Marcata (disfunzione primaria)",
};

/** TART: le quattro lettere con l'etichetta italiana. */
export const TART: readonly {
  key: "tissueTexture" | "asymmetry" | "restriction" | "tenderness";
  letter: "T" | "A" | "R";
  label: string;
}[] = [
  { key: "tissueTexture", letter: "T", label: "Tessitura dei tessuti" },
  { key: "asymmetry", letter: "A", label: "Asimmetria" },
  { key: "restriction", letter: "R", label: "Restrizione di movimento" },
  { key: "tenderness", letter: "T", label: "Dolorabilità" },
];

export const SIDE_LABEL = {
  dx: "dx",
  sx: "sx",
  bilaterale: "bilaterale",
  centrale: "centrale",
} as const;

export const RADIATION_LABEL = {
  gluteo: "gluteo",
  coscia: "coscia",
  sotto_ginocchio: "sotto il ginocchio",
  braccio: "braccio",
  mano: "mano",
} as const;

export const ADVERSE_LABEL = {
  nessuna: "Nessuna",
  lieve: "Lieve",
  moderata: "Moderata",
  grave: "Grave",
} as const;

export const TOLERANCE_LABEL = {
  buona: "Buona",
  fastidio: "Fastidio",
  interrotta: "Interrotta",
} as const;

export const RESPONSE_LABEL = {
  migliorato: "Migliorato",
  invariato: "Invariato",
  peggiorato: "Peggiorato",
} as const;

export const CHANNEL_LABEL = {
  a_voce: "A voce",
  foglio_stampato: "Foglio stampato",
  messaggio_copiato: "Messaggio copiato",
} as const;

export const VISIT_KIND_LABEL = {
  prima_visita: "Prima visita",
  seduta: "Seduta",
  controllo: "Controllo",
} as const;

/** Esiti del ciclo. */
export const CYCLE_OUTCOME_LABEL = {
  raggiunto: "Obiettivo raggiunto",
  parzialmente_raggiunto: "Raggiunto in parte",
  non_raggiunto: "Non raggiunto",
  interrotto_dal_paziente: "Interrotto dal paziente",
  rinviato_al_medico: "Rinviato al medico",
} as const;

/** Chiudere come «Rinviato al medico» vuole prima la lettera: la dice la finestra e la ripete il comando. */
export const REFERRAL_FIRST = "Per chiudere come rinviato al medico prepara prima la lettera.";
/** La lettera con il suo PDF (o già consegnata) non si modifica: lo dicono il comando e la pagina della lettera. */
export const REFERRAL_LOCKED = "La lettera è già salvata: non si modifica.";
/** La lettera è cambiata mentre si preparava il PDF: la route risponde 409 con questo testo e la pagina lo mostra. */
export const LETTER_CHANGED = "La lettera è cambiata mentre preparavo il PDF: riprova.";

// Le frasi del trattamento che l'editor dice come il comando: una sola copia, importata
// dal client e dal server.
export const APPROACH_REQUIRED = "Scegli l'approccio.";
export const TECHNIQUE_NAME_REQUIRED = "Scrivi il nome della tecnica.";
export const TREATMENT_CONSENT_REVOKED = "Consenso al trattamento revocato: puoi solo annotare il colloquio.";
/** "Copia dalla visita precedente" aspetta lo screening di oggi: la barra lo dice accanto al pulsante. */
export const COPY_NEEDS_SCREENING = "Prima conferma lo screening di oggi.";
/** Il motivo di una rettifica: da 10 a 500 caratteri, come il check di `visit_amendments`. */
export const AMEND_REASON_MIN = 10;
export const AMEND_REASON_MAX = 500;
export const AMEND_REASON_SHORT = "Scrivi almeno 10 caratteri.";
/** Una rettifica scrive ogni voce una volta sola: lo dicono il comando e la lista nel client. */
export const AMEND_TARGET_TWICE = "In una rettifica ogni voce si cambia una volta sola.";

export const REFERRAL_REASON_LABEL = {
  red_flag: "Red flag",
  sintomi_persistenti: "Sintomi persistenti",
  peggioramento: "Peggioramento",
  fuori_competenza: "Fuori dalla mia competenza",
  richiesta_paziente: "Richiesta del paziente",
  altro: "Altro",
} as const;

export const URGENCY_LABEL = {
  emergenza: "Emergenza",
  urgente: "Urgente",
  programmato: "Programmato",
} as const;

export const RECIPIENT_KIND_LABEL = {
  medico_curante: "Medico curante",
  medico_inviante: "Medico inviante",
  specialista: "Specialista",
  pronto_soccorso: "Pronto soccorso",
  altro: "Altro",
} as const;

export const REFERRAL_STATUS_LABEL = {
  bozza: "Bozza",
  stampata: "Stampata",
  consegnata_al_paziente: "Consegnata al paziente",
  inviata: "Inviata",
} as const;

export const HISTORY_KIND_LABEL = {
  patologia: "Patologia",
  farmaco: "Farmaco",
  intervento: "Intervento",
  trauma: "Trauma",
  allergia: "Allergia",
  esame: "Esame",
} as const;

/** Etichette di rischio mostrate come badge nella testata. */
export const RISK_BADGE: Partial<Record<RiskTag, string>> = {
  anticoagulante_tao: "TAO",
  anticoagulante_nao: "NAO",
  storia_di_tumore: "Storia di tumore",
  osteoporosi: "Osteoporosi",
};

/**
 * Le etichette di rischio di una voce dell'anamnesi, come le legge chi le accende o le toglie a mano: le quattro
 * dei badge tengono la sigla («TAO», «NAO»), le altre il loro nome. Testi da rileggere.
 */
export const RISK_TAG_LABEL: Record<RiskTag, string> = {
  anticoagulante_tao: "TAO, anticoagulante orale",
  anticoagulante_nao: "NAO, nuovo anticoagulante orale",
  disturbo_coagulazione: "Disturbo della coagulazione",
  corticosteroide_lungo_termine: "Corticosteroidi a lungo termine",
  osteoporosi: "Osteoporosi",
  malattia_tessuto_connettivo: "Malattia del tessuto connettivo",
  storia_di_tumore: "Storia di tumore",
  mezzi_di_sintesi: "Mezzi di sintesi (viti, placche)",
  colpo_di_frusta: "Colpo di frusta",
  trauma_cranico: "Trauma cranico",
  gravidanza: "Gravidanza",
  ipertensione: "Ipertensione",
  fumo: "Fumo",
  emicrania: "Emicrania",
  contraccettivo_orale: "Contraccettivo orale",
  cicatrice: "Cicatrice",
};

/** Vista della foto posturale. */
export const VIEW_LABEL = {
  anteriore: "Anteriore",
  posteriore: "Posteriore",
  laterale_dx: "Laterale destra",
  laterale_sx: "Laterale sinistra",
  altro: "Altro",
} as const;

/** Risposta a una voce dello screening. */
export const ANSWER_LABEL = {
  no: "No",
  si: "Sì",
  non_so: "Non so",
} as const;

/** Il testo senza maiuscole né accenti, per i confronti ("Rotazione Ànca" = "rotazione anca"). */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export const PSFS_TITLE = "Attività importanti per il paziente (PSFS)";
export const PSFS_SCALE_HINT = "0 = non riesco a farla, 10 = la faccio come prima del problema";
export const PAIN_LABEL = "Dolore 0-10 (NRS)";
