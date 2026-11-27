import { taxCode } from "./codes";
import { birthDate, type Offset } from "./dates";
import type { SeedAddress } from "./temporary";

// I dati inventati della demo: lo studio e i 15 pazienti con genitori, cicli,
// appuntamenti e consensi. Le date sono relative a D0 (`seed/dates.ts`): qui ci sono età, scarti e
// posizioni, mai un giorno fisso, salvo la nascita dell'osteopata, che non dipende dalla demo. Email
// `nome.cognome@example.com` (RFC 2606), cellulari "+39 3xx 000 00NN" mai usati nei link, codici fiscali
// col codice comune X999, indirizzi a Bologna e comuni di nascita inventati. Le ore degli appuntamenti sono fissate
// qui.

/** Il codice comune dei codici fiscali del seed: nessun comune né stato estero. */
export const SEED_COMUNE = "X999";

/** Una persona con la sua data di nascita relativa a D0 e, se c'è, il suo codice fiscale. */
export interface SeedPerson {
  firstName: string;
  lastName: string;
  sex: "f" | "m";
  age: { years: number } | { months: number };
  /** Lo scarto fisso della nascita, fra 10 e 300 giorni. */
  birthOffsetDays: number;
  /** Elisa Fontana no: anagrafica senza codice fiscale e indirizzo. */
  withTaxCode: boolean;
}

/** Il genitore di contatto di un minore: intestatario, con codice fiscale e indirizzo. */
export interface SeedContactGuardian extends SeedPerson {
  relationship: "madre" | "padre";
  phone: string;
  email: string;
  address: SeedAddress;
}

/** Il secondo genitore: senza contatto né intestazione. */
export interface SeedSecondGuardian {
  firstName: string;
  lastName: string;
  relationship: "madre" | "padre";
  phone: string | null;
}

export type SeedServiceKind = "prima_visita" | "seduta" | "controllo";

export interface SeedAppointment {
  offset: Offset;
  kind: SeedServiceKind;
  /** Lo stato finale: `saltato` e `annullato` nascono prenotati e poi cambiano stato. */
  status: "prenotato" | "confermato" | "fatto" | "saltato" | "annullato";
  /** L'ora della tabella; `placeOnDay` la sposta nei giorni con la sola mattina o in caso di conflitto. */
  time: string;
  /** I due fatti "NON fatturata" (Matteo P(2), Valentina P(1)) restano in "Fatture da emettere". */
  toInvoice?: false;
}

export interface SeedCycle {
  kind: "trattamento" | "mantenimento";
  /** Il motivo del titolo «{motivo}, {mese anno}»; null per i cicli aperti alla prenotazione ("Nuovo ciclo, ..."). */
  reason: string | null;
  /** Il titolo scritto per intero, al posto di «{motivo}, {mese anno}»: quello della demo. */
  title?: string;
  /** Le sedute previste del trattamento; null per il mantenimento e per i cicli aperti alla prenotazione (il default dello studio). */
  expectedSessions: number | null;
  /** Il ciclo chiuso al giorno dell'ultimo appuntamento, con il suo esito. */
  outcome?: "raggiunto" | "parzialmente_raggiunto" | "rinviato_al_medico";
}

/** Informativa e consenso al trattamento del ciclo (del genitore per un minore) con le due scelte dell'informativa. */
export interface SeedConsents {
  method: "tela" | "pdf_caricato";
  whatsapp: boolean;
  recalls: boolean;
  /** Il consenso ai richiami revocato dal genitore con un messaggio, tanti giorni prima di D0. */
  recallsRevokedDaysBeforeD0?: number;
  /** La persona indicata nel consenso al trattamento per ricevere le informazioni (L. 219/2017 art. 1 c. 3). */
  trusteeName?: string;
}

/** La rubrica dei medici della demo: nomi inventati. */
export const PHYSICIANS = {
  ferri: { fullName: "Dott. Luca Ferri", role: "mmg" },
  moretti: { fullName: "Dott.ssa Carla Moretti", role: "pediatra" },
} as const;
export type SeedPhysicianKey = keyof typeof PHYSICIANS;

export interface SeedPatient extends SeedPerson {
  /** Il luogo di nascita dei maggiorenni con i consensi: un comune inventato, perché il modulo non resti con un vuoto. */
  birthPlace?: string;
  addressing: "tu" | "lei";
  /** Null per i minori: il contatto è il genitore. */
  phone: string | null;
  email: string;
  address: SeedAddress | null;
  recallWeeks: number | null;
  recallPaused: boolean;
  clinicalAlert: string | null;
  contactGuardian?: SeedContactGuardian;
  secondGuardian?: SeedSecondGuardian;
  /** Il medico curante e l'inviante abituale, dalla rubrica (gruppo «Medici» dell'anagrafica). */
  physicians?: { gp?: SeedPhysicianKey; referring?: SeedPhysicianKey };
  cycle: SeedCycle;
  /** In ordine di data. */
  appointments: readonly SeedAppointment[];
  consents: SeedConsents | null;
}

const bologna = (line: string, postalCode: string): SeedAddress => ({ line, postalCode, city: "Bologna", province: "BO" });

/** Committente inventato della demo: ufficio IVA 000, nessuna PEC. */
export const POLISPORTIVA = {
  name: "Polisportiva Esempio SSD a r.l.",
  vatNumber: "09876540007",
  taxCode: "09876540007",
  address: bologna("Via dello Sport 1", "40139"),
  recipientCode: "ABC1234",
  pec: null,
  isWithholdingAgent: true,
} as const;

const D0: Offset = { at: "D0" };
const days = (n: number): Offset => ({ at: "D", days: -n });
const before = (n: number): Offset => ({ at: "P", n });
const after = (n: number): Offset => ({ at: "A", n });

const RINALDI_HOME = bologna("Via dei Campioni 3", "40123");
const DE_LUCA_HOME = bologna("Via del Modello 7", "40133");
const GATTI_HOME = bologna("Via della Bozza 25", "40134");

const signed = (whatsapp: boolean, recalls: boolean): SeedConsents => ({ method: "tela", whatsapp, recalls });

// I valori di quasi tutti: nessun richiamo, nessun avviso clinico, il codice fiscale.
const common = { recallWeeks: null, recallPaused: false, clinicalAlert: null, withTaxCode: true } as const;

export const PATIENTS: readonly SeedPatient[] = [
  {
    ...common,
    firstName: "Marco",
    lastName: "Bellandi",
    birthPlace: "Borgo Esempio",
    sex: "m",
    age: { years: 47 },
    birthOffsetDays: 240,
    addressing: "tu",
    phone: "+393330000001",
    email: "marco.bellandi@example.com",
    address: bologna("Via dell'Esempio 12", "40122"),
    cycle: { kind: "trattamento", reason: "Dolore cervicale", title: "Cervicalgia con cefalea", expectedSessions: 4 },
    appointments: [
      { offset: before(10), kind: "prima_visita", status: "fatto", time: "09:00" },
      { offset: D0, kind: "seduta", status: "confermato", time: "09:00" },
      { offset: after(10), kind: "seduta", status: "prenotato", time: "09:00" },
    ],
    consents: signed(true, true),
  },
  {
    ...common,
    firstName: "Sofia",
    lastName: "Rinaldi",
    sex: "f",
    age: { months: 4 },
    birthOffsetDays: 10,
    addressing: "tu",
    phone: null,
    email: "sofia.rinaldi@example.com",
    address: RINALDI_HOME,
    contactGuardian: {
      firstName: "Elena",
      lastName: "Rinaldi",
      sex: "f",
      age: { years: 34 },
      birthOffsetDays: 130,
      withTaxCode: true,
      relationship: "madre",
      phone: "+393470000016",
      email: "elena.rinaldi@example.com",
      address: RINALDI_HOME,
    },
    secondGuardian: { firstName: "Andrea", lastName: "Rinaldi", relationship: "padre", phone: "+393470000017" },
    // L'asimmetria del capo segnalata dalla pediatra: l'inviante abituale.
    physicians: { referring: "moretti" },
    cycle: { kind: "trattamento", reason: null, expectedSessions: null },
    appointments: [{ offset: D0, kind: "prima_visita", status: "confermato", time: "11:00" }],
    consents: null,
  },
  {
    ...common,
    firstName: "Giulia",
    lastName: "Ferrante",
    birthPlace: "Castel di Prova",
    sex: "f",
    age: { years: 34 },
    birthOffsetDays: 75,
    addressing: "tu",
    phone: "+393400000003",
    email: "giulia.ferrante@example.com",
    address: bologna("Via del Modello 21", "40124"),
    cycle: { kind: "trattamento", reason: "Lombalgia", expectedSessions: 4 },
    appointments: [
      { offset: days(35), kind: "prima_visita", status: "fatto", time: "15:00" },
      { offset: days(21), kind: "seduta", status: "fatto", time: "15:00" },
      { offset: days(10), kind: "seduta", status: "fatto", time: "15:00" },
      { offset: D0, kind: "seduta", status: "confermato", time: "15:00" },
    ],
    consents: signed(true, true),
  },
  {
    ...common,
    firstName: "Anna",
    lastName: "Morelli",
    birthPlace: "San Modello",
    sex: "f",
    age: { years: 72 },
    birthOffsetDays: 200,
    addressing: "lei",
    phone: "+393200000004",
    email: "anna.morelli@example.com",
    address: bologna("Via della Bozza 8", "40125"),
    recallWeeks: 6,
    clinicalAlert: "Terapia anticoagulante (warfarin)",
    cycle: { kind: "mantenimento", reason: "Lombalgia ricorrente", expectedSessions: null },
    appointments: [
      { offset: days(84), kind: "controllo", status: "fatto", time: "10:00" },
      { offset: days(42), kind: "controllo", status: "fatto", time: "10:00" },
      { offset: D0, kind: "controllo", status: "confermato", time: "10:00" },
    ],
    consents: signed(false, true),
  },
  {
    ...common,
    firstName: "Francesca",
    lastName: "Longo",
    birthPlace: "Pieve Campione",
    sex: "f",
    age: { years: 41 },
    birthOffsetDays: 160,
    addressing: "tu",
    phone: "+393280000005",
    email: "francesca.longo@example.com",
    address: bologna("Via del Prototipo 5", "40126"),
    cycle: { kind: "trattamento", reason: "Cefalea tensiva", expectedSessions: 4 },
    appointments: [
      { offset: days(14), kind: "prima_visita", status: "fatto", time: "16:00" },
      { offset: D0, kind: "seduta", status: "prenotato", time: "16:00" },
      { offset: after(10), kind: "seduta", status: "prenotato", time: "16:00" },
    ],
    consents: signed(true, false),
  },
  {
    ...common,
    firstName: "Matteo",
    lastName: "Ricci",
    birthPlace: "Villa Bozza",
    sex: "m",
    age: { years: 24 },
    birthOffsetDays: 55,
    addressing: "tu",
    phone: "+393390000006",
    email: "matteo.ricci@example.com",
    address: bologna("Via dei Test 14", "40127"),
    cycle: { kind: "trattamento", reason: "Dolore al ginocchio destro", expectedSessions: 4 },
    appointments: [{ offset: before(2), kind: "prima_visita", status: "fatto", time: "18:00", toInvoice: false }],
    consents: signed(true, true),
  },
  {
    ...common,
    firstName: "Davide",
    lastName: "Conti",
    birthPlace: "Rocca Esempio",
    sex: "m",
    age: { years: 29 },
    birthOffsetDays: 290,
    addressing: "tu",
    phone: "+393450000007",
    email: "davide.conti@example.com",
    address: bologna("Via della Simulazione 30", "40128"),
    recallWeeks: 8,
    cycle: { kind: "trattamento", reason: "Dolore al polpaccio", expectedSessions: 4, outcome: "raggiunto" },
    appointments: [
      { offset: days(90), kind: "prima_visita", status: "fatto", time: "18:00" },
      { offset: days(78), kind: "seduta", status: "fatto", time: "18:00" },
      { offset: days(66), kind: "seduta", status: "fatto", time: "18:00" },
    ],
    consents: signed(true, true),
  },
  {
    ...common,
    firstName: "Roberto",
    lastName: "Esposito",
    birthPlace: "Ponte di Prova",
    sex: "m",
    age: { years: 55 },
    birthOffsetDays: 120,
    addressing: "lei",
    phone: "+393480000008",
    email: "roberto.esposito@example.com",
    address: bologna("Via del Facsimile 2", "40129"),
    recallWeeks: 6,
    recallPaused: true,
    // Il rinvio programmato al Dott. Luca Ferri: il suo medico curante.
    physicians: { gp: "ferri" },
    cycle: {
      kind: "trattamento",
      reason: "Dolore dorsale e lombare",
      expectedSessions: 4,
      outcome: "rinviato_al_medico",
    },
    appointments: [{ offset: days(21), kind: "prima_visita", status: "fatto", time: "10:00" }],
    consents: signed(false, false),
  },
  {
    ...common,
    firstName: "Chiara",
    lastName: "Valli",
    birthPlace: "Casale Modello",
    sex: "f",
    age: { years: 38 },
    birthOffsetDays: 95,
    addressing: "tu",
    phone: "+393490000009",
    email: "chiara.valli@example.com",
    address: bologna("Via dell'Esempio 40", "40131"),
    cycle: { kind: "trattamento", reason: "Lombalgia in gravidanza", expectedSessions: 3 },
    appointments: [
      { offset: days(24), kind: "prima_visita", status: "fatto", time: "09:30" },
      { offset: days(12), kind: "seduta", status: "fatto", time: "09:30" },
      { offset: after(1), kind: "seduta", status: "confermato", time: "09:30" },
    ],
    consents: signed(true, true),
  },
  {
    ...common,
    firstName: "Elisa",
    lastName: "Fontana",
    sex: "f",
    age: { years: 62 },
    birthOffsetDays: 210,
    withTaxCode: false,
    addressing: "lei",
    phone: "+393660000010",
    email: "elisa.fontana@example.com",
    address: null,
    cycle: { kind: "trattamento", reason: null, expectedSessions: null },
    appointments: [{ offset: after(1), kind: "prima_visita", status: "prenotato", time: "11:00" }],
    consents: null,
  },
  {
    ...common,
    firstName: "Giorgio",
    lastName: "Sala",
    birthPlace: "Valle Campione",
    sex: "m",
    age: { years: 81 },
    birthOffsetDays: 45,
    addressing: "lei",
    phone: "+393800000011",
    email: "giorgio.sala@example.com",
    address: bologna("Via dei Campioni 18", "40132"),
    recallWeeks: 4,
    cycle: { kind: "mantenimento", reason: "Rigidità diffusa", expectedSessions: null },
    appointments: [
      { offset: days(54), kind: "controllo", status: "fatto", time: "11:00" },
      { offset: days(26), kind: "controllo", status: "fatto", time: "11:00" },
      { offset: before(2), kind: "controllo", status: "annullato", time: "10:00" },
    ],
    // La fiduciaria è la figlia.
    consents: { ...signed(false, true), trusteeName: "Marta Sala" },
  },
  {
    ...common,
    firstName: "Martina",
    lastName: "De Luca",
    sex: "f",
    age: { years: 9 },
    birthOffsetDays: 180,
    addressing: "tu",
    phone: null,
    email: "martina.deluca@example.com",
    address: DE_LUCA_HOME,
    recallWeeks: 10,
    contactGuardian: {
      firstName: "Simona",
      lastName: "De Luca",
      sex: "f",
      age: { years: 41 },
      birthOffsetDays: 60,
      withTaxCode: true,
      relationship: "madre",
      phone: "+393880000018",
      email: "simona.deluca@example.com",
      address: DE_LUCA_HOME,
    },
    cycle: { kind: "trattamento", reason: "Mal di schiena", expectedSessions: 4, outcome: "parzialmente_raggiunto" },
    appointments: [
      { offset: days(89), kind: "prima_visita", status: "fatto", time: "17:00" },
      { offset: days(77), kind: "seduta", status: "fatto", time: "17:00" },
      { offset: days(65), kind: "seduta", status: "fatto", time: "17:00" },
    ],
    consents: { ...signed(true, true), recallsRevokedDaysBeforeD0: 3 },
  },
  {
    ...common,
    firstName: "Lorenzo",
    lastName: "Gatti",
    sex: "m",
    age: { years: 16 },
    birthOffsetDays: 250,
    addressing: "tu",
    phone: null,
    email: "lorenzo.gatti@example.com",
    address: GATTI_HOME,
    contactGuardian: {
      firstName: "Paolo",
      lastName: "Gatti",
      sex: "m",
      age: { years: 48 },
      birthOffsetDays: 110,
      withTaxCode: true,
      relationship: "padre",
      phone: "+393920000019",
      email: "paolo.gatti@example.com",
      address: GATTI_HOME,
    },
    cycle: { kind: "trattamento", reason: "Dolore all'inguine", expectedSessions: 3 },
    appointments: [
      { offset: days(10), kind: "prima_visita", status: "fatto", time: "17:00" },
      { offset: after(3), kind: "seduta", status: "prenotato", time: "17:00" },
    ],
    consents: { method: "pdf_caricato", whatsapp: true, recalls: false },
  },
  {
    ...common,
    firstName: "Paolo",
    lastName: "Neri",
    birthPlace: "Poggio Bozza",
    sex: "m",
    age: { years: 50 },
    birthOffsetDays: 30,
    addressing: "lei",
    phone: "+393290000014",
    email: "paolo.neri@example.com",
    address: bologna("Via del Prototipo 11", "40135"),
    cycle: { kind: "trattamento", reason: "Dolore cervicale", expectedSessions: 4 },
    appointments: [
      { offset: days(20), kind: "prima_visita", status: "fatto", time: "17:00" },
      { offset: before(1), kind: "seduta", status: "saltato", time: "18:00" },
      { offset: after(1), kind: "seduta", status: "prenotato", time: "17:00" },
    ],
    consents: signed(true, true),
  },
  {
    ...common,
    firstName: "Valentina",
    lastName: "Greco",
    birthPlace: "Colle Esempio",
    sex: "f",
    age: { years: 33 },
    birthOffsetDays: 140,
    addressing: "tu",
    phone: "+393350000015",
    email: "valentina.greco@example.com",
    address: bologna("Via dei Test 3", "40136"),
    cycle: { kind: "trattamento", reason: "Lombalgia dopo il parto", expectedSessions: 4 },
    appointments: [
      { offset: days(17), kind: "prima_visita", status: "fatto", time: "15:00" },
      { offset: before(1), kind: "seduta", status: "fatto", time: "15:00", toInvoice: false },
      { offset: after(10), kind: "seduta", status: "prenotato", time: "15:00" },
    ],
    consents: signed(true, true),
  },
];

export function birthDateOf(p: SeedPerson, d0: string): string {
  return birthDate(d0, p.age, p.birthOffsetDays);
}

/** Il codice fiscale della persona con la nascita relativa a D0 e il comune X999; null senza codice. */
export function taxCodeOf(p: SeedPerson, d0: string): string | null {
  if (!p.withTaxCode) return null;
  return taxCode({ ...p, birthDate: birthDateOf(p, d0), comune: SEED_COMUNE });
}

const STUDIO_ADDRESS = bologna("Via delle Prove 7", "40121");

/** Lo studio della demo. Il domicilio fiscale è la sede. */
export const STUDIO = {
  practiceName: "Studio Osteopatico Borgo Tiglio",
  practitionerFirstName: "Laura",
  practitionerLastName: "Benedetti",
  practitionerTitle: "Osteopata",
  practitionerTaxCode: taxCode({
    lastName: "Benedetti",
    firstName: "Laura",
    birthDate: "1985-05-20",
    sex: "f",
    comune: SEED_COMUNE,
  }),
  address: STUDIO_ADDRESS,
  phone: "+39 051 000 0000",
  email: "studio@example.com",
  registration: { kind: "ese", order: "Ordine TSRM PSTRP di Bologna", province: "BO", number: "0000" },
  insurance: {
    company: "Compagnia Esempio Assicurazioni",
    policyNumber: "RC-0000-DEMO",
    limitEuros: 2_000_000,
    /** La polizza scade D0 + 200 giorni. */
    expiresAfterDays: 200,
  },
  /** Cadenza 6 settimane, 4 sedute previste, 2 settimane fra le sedute, R1-R3 accesi. */
  clinical: {
    defaultRecallWeeks: 6,
    defaultExpectedSessions: 4,
    defaultSessionIntervalWeeks: 2,
    referralPrompts: ["R1", "R2", "R3"],
  },
  /** Ufficio 000 e cifra di controllo 0: palesemente finta. */
  vatNumber: "00000000000",
  /** ABI 00000, CIN e mod 97 calcolati. */
  iban: "IT80N0000001000000000123456",
  ibanHolder: "Laura Benedetti",
} as const;
