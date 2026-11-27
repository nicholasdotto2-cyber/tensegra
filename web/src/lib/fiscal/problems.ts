import { latin1Message, latin1Offender } from "./latin1";
import { toFatturaModel } from "./model";
import { numberLabel } from "./numbering";
import { sdiChecks } from "./sdi-checks";
import type { InvoiceSnapshot, SnapshotAddress } from "./snapshot";
import { fiscalCodeProblem, ibanProblem, isPostalCode, isProvince, vatNumberProblem } from "./validators";

export interface EmissionProblem { field: string; message: string; href: string | null }
export const XML_MISSING_TAX_CODE = "Non riesco a creare l'XML: manca il codice fiscale dell'intestatario.";
export const FOREIGN_PATIENT = "Paziente estero: non gestito in questa versione.";
const FISCAL_SETTINGS = "/impostazioni/fisco";

function completeAddress(address: SnapshotAddress): boolean {
  return Boolean(address.line.trim() && address.city.trim() && isPostalCode(address.postalCode)
    && address.province && isProvince(address.province) && address.country);
}

/**
 * `includePayment: false` toglie solo i controlli del pagamento: l'editor li legge così per non nascondere i
 * controlli SdI dietro un IBAN mancante quando il metodo scelto non è il bonifico. Il comando usa il default.
 */
export function emissionProblems(s: InvoiceSnapshot, options: { includePayment?: boolean } = {}): EmissionProblem[] {
  const includePayment = options.includePayment ?? true;
  const bankTransfer = includePayment && s.payment.method === "bonifico" && s.docType !== "TD04";
  const problems: EmissionProblem[] = [];
  const add = (field: string, message: string, href: string | null = null) => problems.push({ field, message, href });
  const validate = (field: string, value: string | null, check: (v: string) => string | null, href: string | null = null) => {
    if (value?.trim()) {
      const message = check(value);
      if (message) add(field, message, href);
    }
  };
  const r = s.recipient;
  const person = r.kind !== "committente";
  const who = r.kind === "tutore" ? "genitore" : r.kind === "paziente" ? "paziente" : "committente";
  if (person && !r.taxCode?.trim()) add("recipient.taxCode", `Codice fiscale del ${who} mancante`);
  if (!person && !r.taxCode?.trim() && !r.vatNumber?.trim()) add("recipient.taxCode", "Partita IVA o codice fiscale del committente mancante");
  if (person && r.address.country !== "IT") add("recipient.address.country", FOREIGN_PATIENT);
  if (person) {
    if (!r.firstName?.trim()) add("recipient.firstName", `Nome del ${who} mancante`);
    if (!r.lastName?.trim()) add("recipient.lastName", `Cognome del ${who} mancante`);
  } else if (!r.name?.trim()) add("recipient.name", "Denominazione del committente mancante");
  if (!completeAddress(r.address)) add("recipient.address", `Indirizzo del ${who} incompleto: servono indirizzo, CAP di 5 cifre, città e provincia.`);
  if (!s.supplier.vatNumber.trim()) add("supplier.vatNumber", "Manca la partita IVA dello studio: completala in Impostazioni, Fisco.", FISCAL_SETTINGS);
  if (!s.supplier.taxCode.trim()) add("supplier.taxCode", "Manca il codice fiscale dello studio: completalo in Impostazioni, Fisco.", FISCAL_SETTINGS);
  if (!s.supplier.firstName.trim()) add("supplier.firstName", "Manca il nome del titolare: completalo in Impostazioni, Fisco.", FISCAL_SETTINGS);
  if (!s.supplier.lastName.trim()) add("supplier.lastName", "Manca il cognome del titolare: completalo in Impostazioni, Fisco.", FISCAL_SETTINGS);
  if (!completeAddress(s.supplier.address)) add("supplier.address", "Indirizzo dello studio incompleto: servono indirizzo, CAP di 5 cifre, città e provincia.", FISCAL_SETTINGS);
  validate("supplier.vatNumber", s.supplier.vatNumber, vatNumberProblem, FISCAL_SETTINGS);
  validate("supplier.taxCode", s.supplier.taxCode, fiscalCodeProblem, FISCAL_SETTINGS);
  validate("recipient.taxCode", r.taxCode, fiscalCodeProblem);
  if (!person) validate("recipient.vatNumber", r.vatNumber, vatNumberProblem);
  if (bankTransfer) {
    if (!s.payment.iban?.trim()) add("payment.iban", "Per il bonifico serve l'IBAN dello studio: completalo in Impostazioni, Fisco.", FISCAL_SETTINGS);
    validate("payment.iban", s.payment.iban, ibanProblem, FISCAL_SETTINGS);
  }
  if (s.electronic) {
    // I testi PDF non vanno nell'XML: possono contenere il simbolo dell'euro.
    const text = (field: string, value: string | null, subject: string, max: number,
      where: "anagrafica" | "fattura" | "impostazioni", href: string | null = null) => {
      if (!value) return;
      if (latin1Offender(value)) add(field, latin1Message(subject, where), href);
      if (value.length > max) add(field, `${subject} è troppo ${subject.startsWith("La ") ? "lunga" : "lungo"} per la fattura elettronica (massimo ${max} caratteri).`, href);
    };
    if (bankTransfer) {
      text("payment.beneficiary", s.payment.beneficiary, "L'intestatario del conto", 200, "impostazioni", FISCAL_SETTINGS);
    }
    text("supplier.firstName", s.supplier.firstName, "Il nome del titolare", 60, "impostazioni", FISCAL_SETTINGS);
    text("supplier.lastName", s.supplier.lastName, "Il cognome del titolare", 60, "impostazioni", FISCAL_SETTINGS);
    if (person) {
      text("recipient.firstName", r.firstName, `Il nome del ${who}`, 60, "anagrafica");
      text("recipient.lastName", r.lastName, `Il cognome del ${who}`, 60, "anagrafica");
    } else text("recipient.name", r.name, "La denominazione del committente", 80, "anagrafica");
    for (const [prefix, address, label, where, href] of [
      ["supplier", s.supplier.address, "dello studio", "impostazioni", FISCAL_SETTINGS],
      ["recipient", r.address, `del ${who}`, "anagrafica", null],
    ] as const) {
      text(`${prefix}.address.line`, address.line, `L'indirizzo ${label}`, 60, where, href);
      text(`${prefix}.address.city`, address.city, `Il comune ${label}`, 60, where, href);
    }
    const reg = s.supplier.registration;
    if (reg.kind === "albo") {
      if (!reg.order?.trim()) add("supplier.registration.order", "Manca l'albo professionale: completalo in Impostazioni, Fisco.", FISCAL_SETTINGS);
      if (!reg.number?.trim()) add("supplier.registration.number", "Manca il numero di iscrizione all'albo: completalo in Impostazioni, Fisco.", FISCAL_SETTINGS);
      if (reg.province && !isProvince(reg.province)) add("supplier.registration.province", "La provincia dell'albo deve avere due lettere maiuscole.", FISCAL_SETTINGS);
      text("supplier.registration.order", reg.order, "L'albo professionale", 60, "impostazioni", FISCAL_SETTINGS);
      if (reg.number && /[^\x20-\x7e]/.test(reg.number)) {
        add("supplier.registration.number", 'Scrivi il numero di iscrizione all\'albo senza simboli, per esempio "123", in Impostazioni, Fisco.', FISCAL_SETTINGS);
      }
      if (reg.number && reg.number.length > 60) {
        add("supplier.registration.number", "Il numero di iscrizione all'albo è troppo lungo per la fattura elettronica (massimo 60 caratteri).", FISCAL_SETTINGS);
      }
    }
    for (const [i, line] of s.lines.entries()) {
      if (!line.description.trim()) add(`lines.${i}.description`, "Descrizione della riga mancante");
      text(`lines.${i}.description`, line.description, "Il testo della riga", 1000, "fattura");
    }
    for (const [i, value] of s.texts.causali.entries()) text(`texts.causali.${i}`, value, "Il testo della causale", 200, "fattura");
    for (const [nature, value] of Object.entries(s.texts.references)) text(`texts.references.${nature}`, value, "Il riferimento normativo", 100, "fattura");
    for (const nature of new Set(s.lines.map((l) => l.nature))) {
      if (nature && !s.texts.references[nature]?.trim()) add(`texts.references.${nature}`, "Riferimento normativo mancante");
    }
    if (s.numberLabel && (s.numberLabel.length > 20 || /[^\x20-\x7e]/.test(s.numberLabel))) add("numberLabel", "Il numero della fattura deve avere al massimo 20 caratteri Basic Latin.");
    if (r.kind === "committente" && !/^[A-Z0-9]{7}$/.test(r.recipientCode)) add("recipient.recipientCode", "Il codice destinatario deve avere 7 lettere maiuscole o cifre.");
    if (r.pec && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.pec) || r.pec.length > 256)) add("recipient.pec", "La PEC del committente non è valida.");
    if (s.transmission && !/^[A-Z0-9]{1,10}$/.test(s.transmission.progressive)) add("transmission.progressive", "Il progressivo dell'invio deve avere da 1 a 10 lettere maiuscole o cifre.");
  }
  if (s.computation.totalCents === 0) add("computation.totalCents", "Il totale è zero: aggiungi una riga con un importo.");
  if (s.electronic && problems.length === 0) {
    const m = toFatturaModel(s, { number: s.numberLabel || numberLabel(s.docType, 1, Number(s.issueDate.slice(0, 4))), progressive: "00000" });
    for (const problem of sdiChecks(includePayment ? m : { ...m, payment: null })) add(`sdi.${problem.code}`, problem.message);
  }
  return problems;
}
