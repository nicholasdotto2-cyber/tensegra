// La sintesi generata della lettera al medico: motivo e data
// d'inizio, diagnosi medica di riferimento se c'è, red flag con le sottovoci, irradiazione ed esame
// neurologico se registrati, sedute del ciclo con regioni e tecniche, dolore 0-10, test variati. La
// formula è "Segnalo ... e chiedo una sua valutazione"; nessuna "diagnosi" dell'osteopata, nessuna
// "terapia" per il trattamento, niente punti esclamativi. Le frasi sono testi clinici proposti,
// da rileggere con un osteopata. Funzione pura: nessun database, nessun fuso. Sicura per il client.

import { dayField } from "@/lib/format";
import { painSeriesText } from "./compare";

export type ReferralReason =
  | "red_flag"
  | "sintomi_persistenti"
  | "peggioramento"
  | "fuori_competenza"
  | "richiesta_paziente"
  | "altro";

/** I fatti della sintesi, già in parole; i giorni sono "AAAA-MM-GG". */
export interface ReferralFacts {
  patientName: string;
  reason: ReferralReason;
  /** Il giorno d'apertura del ciclo ("che seguo dal"). */
  startDay: string;
  chiefComplaint: string | null;
  /** `sourceLabel` vuoto quando la fonte è "Assente". */
  diagnosis: { text: string; sourceLabel: string } | null;
  redFlags: { label: string; subItems: string[]; visitDay: string }[];
  /** `side` vuoto quando il lato non è scritto. */
  radiation: { sites: string[]; side: string } | null;
  neuro: string[] | null;
  /** Le sedute del ciclo in ordine, dalla più vecchia. */
  visits: { day: string; regions: string[]; techniques: string[] }[];
  /** Il dolore 0-10 a inizio seduta delle stesse sedute, null se non rilevato. */
  pain: (number | null)[];
  changedTests: { label: string; change: string }[];
}

/** Il limite di `referrals.summary_text`. */
export const SUMMARY_MAX = 3000;

export const DEFAULT_REQUEST_TEXT =
  "Le chiedo di valutare il paziente e, se lo ritiene, di indicarmi se proseguire il trattamento osteopatico.";

const REASON_PHRASE: Record<ReferralReason, string> = {
  red_flag: "la comparsa di segni che richiedono una valutazione medica",
  sintomi_persistenti: "sintomi che persistono oltre i tempi previsti",
  peggioramento: "un peggioramento dei sintomi",
  fuori_competenza: "un quadro che esce dalla mia competenza",
  richiesta_paziente: "la richiesta del paziente di un parere medico",
  altro: "un quadro che desidero condividere con lei",
};

/** Un testo scritto dall'osteopata dentro una frase: senza spazi e punteggiatura finali. */
function inSentence(text: string): string {
  return text.trim().replace(/[\s.,;:]+$/, "");
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

function opening(f: ReferralFacts): string {
  const complaint = f.chiefComplaint === null ? "" : inSentence(f.chiefComplaint);
  const why = complaint === "" ? "" : ` per ${complaint}`;
  return `Segnalo ${REASON_PHRASE[f.reason]} in ${f.patientName}, che seguo dal ${dayField(f.startDay)}${why}, e chiedo una sua valutazione.`;
}

function diagnosisLine(d: NonNullable<ReferralFacts["diagnosis"]>): string {
  const source = d.sourceLabel === "" ? "" : ` (${lowerFirst(d.sourceLabel)})`;
  return `Diagnosi medica di riferimento: ${inSentence(d.text)}${source}.`;
}

/** Una riga per visita, nell'ordine dei fatti: "Nella visita del 14/10/2026 ho rilevato: A; B (x, y).". */
function redFlagLines(flags: ReferralFacts["redFlags"]): string[] {
  const byDay = new Map<string, string[]>();
  for (const flag of flags) {
    const subs = flag.subItems.length === 0 ? "" : ` (${flag.subItems.map(lowerFirst).join(", ")})`;
    const list = byDay.get(flag.visitDay) ?? [];
    list.push(`${flag.label}${subs}`);
    byDay.set(flag.visitDay, list);
  }
  return [...byDay].map(([day, items]) => `Nella visita del ${dayField(day)} ho rilevato: ${items.join("; ")}.`);
}

function radiationLine(r: NonNullable<ReferralFacts["radiation"]>): string {
  const side = r.side === "" ? "" : r.side === "bilaterale" ? ", bilaterale" : `, lato ${r.side}`;
  return `Irradiazione: ${r.sites.join(", ")}${side}.`;
}

function visitLine(v: ReferralFacts["visits"][number]): string {
  if (v.regions.length === 0 && v.techniques.length === 0) return `${dayField(v.day)}: nessuna tecnica registrata.`;
  const parts: string[] = [];
  if (v.regions.length > 0) parts.push(`regioni ${v.regions.join(", ")}`);
  if (v.techniques.length > 0) parts.push(`tecniche ${v.techniques.join(", ")}`);
  return `${dayField(v.day)}: ${parts.join("; ")}.`;
}

/** Le righe delle sedute; con `shown` minore del totale restano le più recenti. */
function visitLines(visits: ReferralFacts["visits"], shown: number): string[] {
  if (shown === 0) return [];
  const header = shown === visits.length ? "Sedute del ciclo:" : `Ultime ${shown} sedute del ciclo:`;
  return [header, ...visits.slice(visits.length - shown).map(visitLine)];
}

function compose(f: ReferralFacts, shownVisits: number): string {
  const lines: string[] = [opening(f)];
  if (f.diagnosis && f.diagnosis.text.trim() !== "") lines.push(diagnosisLine(f.diagnosis));
  lines.push(...redFlagLines(f.redFlags));
  if (f.radiation && f.radiation.sites.length > 0) lines.push(radiationLine(f.radiation));
  if (f.neuro && f.neuro.length > 0) lines.push(`Esame neurologico: ${f.neuro.join("; ")}.`);
  lines.push(...visitLines(f.visits, shownVisits));
  if (f.pain.some((p) => p !== null)) lines.push(`Dolore 0-10 a inizio seduta: ${painSeriesText(f.pain)}.`);
  if (f.changedTests.length > 0) {
    lines.push(`Test variati: ${f.changedTests.map((t) => `${t.label} ${t.change}`).join("; ")}.`);
  }
  return lines.join("\n");
}

/**
 * La sintesi, una frase o un elenco per riga. Oltre `SUMMARY_MAX` caratteri toglie le sedute più vecchie,
 * una alla volta; se non basta ancora (testi dell'osteopata molto lunghi) tronca al limite e toglie gli
 * spazi finali.
 */
export function buildReferralSummary(f: ReferralFacts): string {
  for (let shown = f.visits.length; shown >= 0; shown -= 1) {
    const text = compose(f, shown);
    if (text.length <= SUMMARY_MAX) return text;
  }
  // Senza spazi né a capo finali: il testo salvato è quello che il modulo rimanda (lo schema li toglie).
  return compose(f, 0).slice(0, SUMMARY_MAX).trimEnd();
}
