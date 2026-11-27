import { z } from "zod";
import { toLatin1 } from "@/lib/fiscal/latin1";

// Gli input dei comandi del Listino. Ogni schema è
// `.strict()`: una chiave in più (`practiceId`, `archivedAt`, `sortOrder`) è rifiutata, così il modulo
// non arriva mai alle colonne che scrivono solo i comandi. I vincoli sono quelli dei check di
// `services`, controllati prima con il testo del campo. Nome e descrizione in fattura si convertono
// al salvataggio; caratteri fuori dal Latin-1 e dati clinici si controllano all'emissione.

const REQUIRED = "Campo obbligatorio.";
const maxChars = (n: number): string => `Massimo ${n} caratteri.`;
// Un valore che il modulo non produce (scelta fuori elenco, importo fuori dai limiti, chiave in
// più): lo stesso testo del 23514.
const INVALID = "Valore non valido";

// Gli stessi limiti dei check di `services`.
const NAME_MAX = 60;
const DESCRIPTION_MAX = 200;
const DURATIONS = [15, 30, 45, 60, 75, 90, 105, 120] as const;
const PRICE_MAX_CENTS = 999_999;

function requiredText(max: number) {
  return z
    .string({ error: REQUIRED })
    .trim()
    .transform(toLatin1)
    .pipe(z.string().min(1, { error: REQUIRED }).max(max, { error: maxChars(max) }));
}

const priceCents = z.int({ error: INVALID }).min(0, { error: INVALID }).max(PRICE_MAX_CENTS, { error: INVALID });
const serviceId = z.uuid({ error: INVALID });

// I sei campi del modulo di una voce; il prezzo è in centesimi, la conversione dagli euro è del modulo.
const serviceFields = {
  kind: z.enum(["prima_visita", "seduta", "controllo", "altro"], { error: INVALID }),
  name: requiredText(NAME_MAX),
  invoiceDescription: requiredText(DESCRIPTION_MAX),
  durationMin: z.literal(DURATIONS, { error: INVALID }),
  priceCents,
  color: z.enum(["petrolio", "salvia", "oceano", "ocra", "corallo", "ardesia"], { error: INVALID }),
};

export const ServiceInput = z.object(serviceFields, { error: INVALID }).strict();
export type ServiceInput = z.input<typeof ServiceInput>;

export const ServiceUpdateInput = z.object({ id: serviceId, ...serviceFields }, { error: INVALID }).strict();
export type ServiceUpdateInput = z.input<typeof ServiceUpdateInput>;

/** Archivia, ripristina, elimina: bastano l'id. */
export const ServiceIdInput = z.object({ id: serviceId }, { error: INVALID }).strict();
export type ServiceIdInput = z.input<typeof ServiceIdInput>;

/** Il prezzo che la voce aveva prima della modifica: solo gli appuntamenti ancora a quel prezzo cambiano. */
export const ApplyPriceInput = z.object({ serviceId, oldPriceCents: priceCents }, { error: INVALID }).strict();
export type ApplyPriceInput = z.input<typeof ApplyPriceInput>;
