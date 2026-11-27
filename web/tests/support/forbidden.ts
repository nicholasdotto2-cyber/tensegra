import * as seedPeople from "../../seed/people";

// Le stringhe che non devono comparire in un export oscurato e la ricerca che le cerca nel testo
// estratto dai PDF. La ricerca è per parola intera, senza maiuscole né accenti: "Neri" non è in "generico".

export interface Person {
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  taxCode?: string | null;
  vatNumber?: string | null;
  addressLine?: string | null;
  postalCode?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
}

const FIELDS = [
  "firstName", "lastName", "name", "taxCode", "vatNumber", "addressLine", "postalCode", "city", "phone", "email",
] as const;

function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const valuesOf = (person: Person): string[] =>
  FIELDS.flatMap((field) => {
    const value = person[field]?.trim();
    return value ? [value] : [];
  });

/** I valori delle persone, tolti quelli uguali a un valore del titolare, più `extra` (come l'IBAN). */
export function forbiddenStrings(people: readonly Person[], holder: Person, extra: readonly string[]): string[] {
  const own = new Set(valuesOf(holder).map(normalize));
  const found = new Set<string>();
  for (const value of [...people.flatMap(valuesOf), ...extra]) {
    if (!own.has(normalize(value))) found.add(value);
  }
  return [...found];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Gli `needles` presenti in `text`: prima e dopo nessuna lettera né cifra, senza maiuscole né accenti. */
export function findForbidden(text: string, needles: readonly string[]): string[] {
  const haystack = normalize(text);
  return needles.filter((needle) => {
    const wanted = normalize(needle).trim();
    if (wanted === "") return false;
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(wanted)}(?![\\p{L}\\p{N}])`, "u").test(haystack);
  });
}

interface SeedLike {
  firstName: string;
  lastName: string;
  taxCode?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: { line: string; postalCode: string; city: string } | null;
}

const personOf = (seed: SeedLike): Person => ({
  firstName: seed.firstName,
  lastName: seed.lastName,
  taxCode: seed.taxCode ?? null,
  phone: seed.phone ?? null,
  email: seed.email ?? null,
  addressLine: seed.address?.line ?? null,
  postalCode: seed.address?.postalCode ?? null,
  city: seed.address?.city ?? null,
});

/** Pazienti, genitori e committente del seed che un export oscurato non deve rivelare; il titolare (`STUDIO`) resta fuori. */
export function seedForbidden(d0: string): string[] {
  const { PATIENTS, STUDIO, POLISPORTIVA, taxCodeOf } = seedPeople;
  const people: Person[] = [];
  for (const patient of PATIENTS) {
    people.push(personOf({ ...patient, taxCode: taxCodeOf(patient, d0) }));
    const guardian = patient.contactGuardian;
    if (guardian) people.push(personOf({ ...guardian, taxCode: taxCodeOf(guardian, d0) }));
    if (patient.secondGuardian) people.push(personOf(patient.secondGuardian));
  }
  const extra: string[] = [STUDIO.iban];
  people.push({
    name: POLISPORTIVA.name,
    taxCode: POLISPORTIVA.taxCode,
    vatNumber: POLISPORTIVA.vatNumber,
    addressLine: POLISPORTIVA.address.line,
    postalCode: POLISPORTIVA.address.postalCode,
    city: POLISPORTIVA.address.city,
  });
  extra.push(POLISPORTIVA.recipientCode);
  const holder: Person = {
    firstName: STUDIO.practitionerFirstName,
    lastName: STUDIO.practitionerLastName,
    name: STUDIO.practiceName,
    taxCode: STUDIO.practitionerTaxCode,
    vatNumber: STUDIO.vatNumber,
    addressLine: STUDIO.address.line,
    postalCode: STUDIO.address.postalCode,
    city: STUDIO.address.city,
    phone: STUDIO.phone,
    email: STUDIO.email,
  };
  return forbiddenStrings(people, holder, extra);
}
