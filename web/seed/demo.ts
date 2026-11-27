import { monthYear } from "@/lib/format";
import { DEMO_PRACTICE_ID, DEMO_USER_EMAIL, DEMO_USER_ID, getActor } from "@/server/auth/actor";
import { addDaysRome, type Clock, fixedClock, romeDateTime } from "@/server/clock";
import type { FileStore } from "@/server/files/store";
import type { Db, Tx } from "@/server/db/db";
import { asService, switchToUser } from "@/server/db/service";
import { cancelAppointment, createAppointment, markSkipped } from "@/server/domain/appointments/commands";
import { closeCycle, openCycle } from "@/server/domain/cycles/commands";
import { createPatient, saveGuardian, setClinicalAlert, setRecall, updatePatientGroup } from "@/server/domain/patients/commands";
import { createPhysician } from "@/server/domain/physicians/commands";
import { createDefaultServices } from "@/server/domain/services/commands";
import { listActiveServices, type ServiceRow } from "@/server/domain/services/queries";
import { closeVisit } from "@/server/domain/visits/commands";
import { saveClinicalSettings, saveFiscalSettings, saveOpeningHours, saveRegistration, saveStudio } from "@/server/domain/settings/commands";
import { getOpeningHours } from "@/server/domain/settings/queries";
import { endOf, placeOnDay, resolveDay, seedHours } from "./dates";
import { seedClinical } from "./clinical";
import { seedCounters, seedInvoices } from "./invoices";
import {
  birthDateOf,
  PATIENTS,
  PHYSICIANS,
  type SeedAppointment,
  type SeedPatient,
  type SeedPhysicianKey,
  type SeedServiceKind,
  STUDIO,
  taxCodeOf,
} from "./people";
import {
  prepareSeedConsentAssets,
  removeSeedConsentAssets,
  type SeedConsentAssets,
  seedConsentRecords,
} from "./consents";
import { seedMessageTemplates } from "./messages";
import { prepareSeedPhotoAssets, removeSeedPhotoAssets, type SeedPhotoAsset, seedPhotos } from "./photos";
import type { SeedAddress } from "./temporary";

// Il seed della demo. Gira in una sola transazione, e non è
// idempotente da solo: chi lo chiama guarda prima `demoExists` (pnpm db:seed). Come servizio scrive solo
// utente, studio e membership; poi `switchToUser` e ogni dato di dominio passa dai comandi dell'app con la
// RLS attiva, così una policy, un vincolo o un calcolo sbagliato rompono il seed subito. Ogni comando
// riceve l'orologio del suo evento: un fatto la fine dell'appuntamento, una prenotazione futura
// l'ora del seed. Le visite, il rinvio e i test della cartella stanno in `seed/clinical.ts`; consensi e scelte
// in `seed/consents.ts`, i modelli dei messaggi in `seed/messages.ts`.

export const DEMO_PRACTICE_NAME = STUDIO.practiceName;

const P = DEMO_PRACTICE_ID;
const SEED_VERSION = 1;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** La disdetta di Giorgio arriva la sera prima, all'ora dei promemoria. */
const CANCELLED_AT = "18:00";

/** Lo studio demo c'è già? Legge come servizio: non dipende da chi è l'utente. */
export async function demoExists(db: Db): Promise<boolean> {
  const rows = await asService(db, (tx) =>
    tx.query("select 1 from public.practices where id = $1", [DEMO_PRACTICE_ID]),
  );
  return rows.length > 0;
}

/** Studio, iscrizione e polizza, orari, cartella, fisco e listino, con i segni della demo. */
async function seedStudio(tx: Tx, clock: Clock): Promise<void> {
  const d0 = clock.today();
  await saveStudio(tx, P, clock, {
    practiceName: STUDIO.practiceName,
    practitionerFirstName: STUDIO.practitionerFirstName,
    practitionerLastName: STUDIO.practitionerLastName,
    practitionerTitle: STUDIO.practitionerTitle,
    addressLine: STUDIO.address.line,
    postalCode: STUDIO.address.postalCode,
    city: STUDIO.address.city,
    province: STUDIO.address.province,
    phone: STUDIO.phone,
    email: STUDIO.email,
    pec: null,
  });
  await saveRegistration(tx, P, clock, {
    registrationKind: STUDIO.registration.kind,
    registrationOrder: STUDIO.registration.order,
    registrationProvince: STUDIO.registration.province,
    registrationNumber: STUDIO.registration.number,
    registrationDate: null,
    insuranceCompany: STUDIO.insurance.company,
    insurancePolicyNumber: STUDIO.insurance.policyNumber,
    insuranceLimitEuros: STUDIO.insurance.limitEuros,
    insuranceExpiresOn: addDaysRome(d0, STUDIO.insurance.expiresAfterDays),
  });
  await saveOpeningHours(tx, P, clock, seedHours(d0));
  await saveClinicalSettings(tx, P, clock, STUDIO.clinical);
  await saveFiscalSettings(tx, P, clock, {
    regime: "forfettario",
    vatNumber: STUDIO.vatNumber,
    taxCode: STUDIO.practitionerTaxCode,
    iban: STUDIO.iban,
    ibanHolder: STUDIO.ibanHolder,
    atecoCode: null,
    fiscalAddressLine: STUDIO.address.line,
    fiscalPostalCode: STUDIO.address.postalCode,
    fiscalCity: STUDIO.address.city,
    fiscalProvince: STUDIO.address.province,
    fiscalCountry: "IT",
    inpsSurchargeEnabled: false,
    stampChargedToClient: true,
    paperStampAuthorization: null,
    defaultPaymentMethod: "carta",
    bankTransferDueDays: 15,
  });
  // Il banner "Dati di prova" e la sezione "Dati di prova": li scrive solo il seed.
  await tx.query(
    `update public.practice_settings
        set is_demo = true, demo_seeded_at = $2, demo_seed_version = $3
      where practice_id = $1`,
    [P, clock.now(), SEED_VERSION],
  );
  await createDefaultServices(tx, P, clock);
}

/** Un appuntamento della demo al suo giorno e alla sua ora. */
interface Placed {
  seed: SeedAppointment;
  day: string;
  time: string;
  startsAt: Date;
  service: ServiceRow;
}

function serviceOf(services: readonly ServiceRow[], kind: SeedServiceKind): ServiceRow {
  const service = services.find((s) => s.kind === kind);
  if (!service) throw new Error(`Nel listino del seed manca una voce di tipo ${kind}.`);
  return service;
}

/**
 * Il giorno e l'ora di ogni appuntamento: i giorni dagli orari salvati, poi le ore giorno per giorno
 * con tutti gli appuntamenti di quel giorno insieme, così due pazienti dello stesso giorno non si
 * sovrappongono. Per ogni paziente gli appuntamenti in ordine di orario.
 */
async function placeAppointments(tx: Tx, d0: string, services: readonly ServiceRow[]): Promise<Placed[][]> {
  const week = await getOpeningHours(tx, P);
  const entries = PATIENTS.flatMap((patient, p) =>
    patient.appointments.map((seed, i) => ({
      key: `${p}.${i}`,
      patient: p,
      seed,
      day: resolveDay(week, d0, seed.offset),
      service: serviceOf(services, seed.kind),
    })),
  );

  const byDay = new Map<string, typeof entries>();
  for (const entry of entries) byDay.set(entry.day, [...(byDay.get(entry.day) ?? []), entry]);
  const times = new Map<string, string>();
  for (const [day, list] of byDay) {
    const slots = list.map((e) => ({ key: e.key, time: e.seed.time, durationMin: e.service.durationMin }));
    for (const [key, time] of placeOnDay(week, day, slots)) times.set(key, time);
  }

  return PATIENTS.map((_, p) =>
    entries
      .filter((e) => e.patient === p)
      .map((e) => {
        const time = times.get(e.key);
        if (time === undefined) throw new Error(`Nessuna ora per l'appuntamento ${e.key}.`);
        return { seed: e.seed, day: e.day, time, startsAt: romeDateTime(e.day, time), service: e.service };
      })
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
  );
}

/** Un paziente con il suo ciclo e i suoi appuntamenti, come li ha scritti il seed. */
export interface Seeded {
  patient: SeedPatient;
  patientId: string;
  cycleId: string;
  appointments: (Placed & { id: string })[];
}

/** Gli id della rubrica dei medici, per chiave. */
type PhysicianIds = Record<SeedPhysicianKey, string>;

/** La rubrica della demo con "Nuovo medico", prima dei pazienti che la usano. */
async function seedPhysicians(tx: Tx, clock: Clock): Promise<PhysicianIds> {
  const ids: Partial<PhysicianIds> = {};
  for (const key of Object.keys(PHYSICIANS) as SeedPhysicianKey[]) {
    ids[key] = (await createPhysician(tx, P, clock, PHYSICIANS[key])).id;
  }
  return ids as PhysicianIds;
}

/** I campi del gruppo «Indirizzo» (e dell'indirizzo del genitore) da un indirizzo del seed, in Italia. */
function addressOf(address: SeedAddress) {
  return {
    addressLine: address.line,
    postalCode: address.postalCode,
    city: address.city,
    province: address.province,
    country: "IT",
  };
}

/**
 * Paziente, anagrafica e genitori: il mini modulo "Nuovo paziente", poi i gruppi dell'anagrafica, il
 * richiamo, l'avviso clinico e i genitori con i comandi della scheda.
 */
async function seedPatient(tx: Tx, clock: Clock, patient: SeedPatient, physicians: PhysicianIds): Promise<string> {
  const d0 = clock.today();
  const guardian = patient.contactGuardian;
  const birthDate = birthDateOf(patient, d0);
  const { id } = await createPatient(tx, P, clock, {
    firstName: patient.firstName,
    lastName: patient.lastName,
    birthDate,
    phone: patient.phone,
    ...(guardian ? { guardian: { firstName: guardian.firstName, lastName: guardian.lastName, phone: guardian.phone } } : {}),
  });

  await updatePatientGroup(tx, P, clock, {
    group: "personali",
    patientId: id,
    firstName: patient.firstName,
    lastName: patient.lastName,
    birthDate,
    sex: patient.sex,
    birthPlace: patient.birthPlace ?? null,
    taxCode: taxCodeOf(patient, d0),
  });
  await updatePatientGroup(tx, P, clock, {
    group: "contatti",
    patientId: id,
    phone: patient.phone,
    email: patient.email,
    preferredChannel: "whatsapp",
    addressing: patient.addressing,
  });
  if (patient.address) {
    await updatePatientGroup(tx, P, clock, { group: "indirizzo", patientId: id, ...addressOf(patient.address) });
  }
  if (patient.physicians) {
    const { gp, referring } = patient.physicians;
    await updatePatientGroup(tx, P, clock, {
      group: "medici",
      patientId: id,
      gpPhysicianId: gp === undefined ? null : physicians[gp],
      defaultReferringPhysicianId: referring === undefined ? null : physicians[referring],
    });
  }
  if (patient.recallWeeks !== null || patient.recallPaused) {
    await setRecall(tx, P, clock, { patientId: id, weeks: patient.recallWeeks, paused: patient.recallPaused });
  }
  if (patient.clinicalAlert !== null) {
    await setClinicalAlert(tx, P, clock, { patientId: id, clinicalAlert: patient.clinicalAlert });
  }

  // Il genitore nato dal mini modulo (relazione `altro`) prende relazione, email, codice fiscale e
  // indirizzo, e resta contatto e intestatario; il secondo genitore non è né contatto né intestatario.
  if (guardian) {
    await saveGuardian(tx, P, clock, {
      patientId: id,
      guardianId: await contactGuardianId(tx, id),
      relationship: guardian.relationship,
      firstName: guardian.firstName,
      lastName: guardian.lastName,
      taxCode: taxCodeOf(guardian, d0),
      phone: guardian.phone,
      email: guardian.email,
      ...addressOf(guardian.address),
      hasParentalAuthority: true,
      isContact: true,
      isPayer: true,
    });
  }
  const second = patient.secondGuardian;
  if (second) {
    await saveGuardian(tx, P, clock, {
      patientId: id,
      relationship: second.relationship,
      firstName: second.firstName,
      lastName: second.lastName,
      taxCode: null,
      phone: second.phone,
      email: null,
      addressLine: null,
      postalCode: null,
      city: null,
      province: null,
      country: "IT",
      hasParentalAuthority: true,
      isContact: false,
      isPayer: false,
    });
  }
  return id;
}

const changesLater = (a: Placed): boolean => a.seed.status === "saltato" || a.seed.status === "annullato";

/**
 * L'orologio della creazione: un fatto alla sua fine; il saltato e l'annullato, che nascono prenotati,
 * alla fine dell'appuntamento prima (la prossima seduta si fissa al banco); una prenotazione futura all'ora
 * del seed.
 */
function creationClock(seedClock: Clock, a: Placed, previous: Placed | undefined): Clock {
  if (a.seed.status === "fatto") return fixedClock(endOf(a));
  if (changesLater(a)) {
    if (!previous) throw new Error("Un saltato o un annullato del seed nasce alla fine dell'appuntamento prima.");
    return fixedClock(endOf(previous));
  }
  return seedClock;
}

/**
 * Gli appuntamenti di un paziente in ordine di data, ciascuno con l'orologio del suo evento
 * (`creationClock`); poi il saltato passa un'ora dopo l'inizio e l'annullato la sera prima.
 */
async function seedAppointments(
  tx: Tx,
  clock: Clock,
  patientId: string,
  cycleId: string,
  placed: readonly Placed[],
): Promise<Seeded["appointments"]> {
  const created: Seeded["appointments"] = [];
  let previous: Placed | undefined;
  for (const a of placed) {
    const status = changesLater(a) ? "prenotato" : a.seed.status;
    const { appointments } = await createAppointment(tx, P, creationClock(clock, a, previous), {
      patient: { kind: "existing", patientId },
      serviceId: a.service.id,
      day: a.day,
      time: a.time,
      durationMin: a.service.durationMin,
      cycle: { kind: "existing", cycleId },
      priceCents: a.service.priceCents,
      status,
    });
    const [row] = appointments;
    if (!row) throw new Error("Appuntamento del seed non creato.");

    if (a.seed.status === "saltato") {
      await markSkipped(tx, P, fixedClock(new Date(a.startsAt.getTime() + HOUR_MS)), { id: row.id });
    }
    if (a.seed.status === "annullato") {
      const eveningBefore = fixedClock(romeDateTime(addDaysRome(a.day, -1), CANCELLED_AT));
      await cancelAppointment(tx, P, eveningBefore, { id: row.id, reason: "paziente", alsoFollowing: false });
    }
    created.push({ ...a, id: row.id });
    previous = a;
  }
  return created;
}

/** I 15 pazienti della demo, uno alla volta: anagrafica, ciclo dal primo appuntamento, appuntamenti. */
async function seedPatients(tx: Tx, clock: Clock, physicians: PhysicianIds): Promise<Seeded[]> {
  const d0 = clock.today();
  const placed = await placeAppointments(tx, d0, await listActiveServices(tx, P));
  const seeded: Seeded[] = [];
  for (const [index, patient] of PATIENTS.entries()) {
    const appointments = placed[index] ?? [];
    const [first] = appointments;
    if (!first) throw new Error(`${patient.firstName} ${patient.lastName} non ha appuntamenti nel seed.`);
    const patientId = await seedPatient(tx, clock, patient, physicians);

    // Il titolo scritto nei dati della demo (Marco), altrimenti «{motivo}, {mese anno di opened_on}»; `openCycle`
    // apre al minore fra oggi e il primo appuntamento. Senza motivo è il ciclo aperto alla prenotazione:
    // "Nuovo ciclo, ...".
    const { reason, title, expectedSessions, kind } = patient.cycle;
    const openedOn = first.day < d0 ? first.day : d0;
    const cycleTitle = title ?? (reason === null ? null : `${reason}, ${monthYear(openedOn)}`);
    const { id: cycleId } = await openCycle(tx, P, clock, {
      patientId,
      kind,
      firstAppointmentDay: first.day,
      ...(expectedSessions === null ? {} : { expectedSessions }),
      ...(cycleTitle === null ? {} : { title: cycleTitle }),
    });

    seeded.push({
      patient,
      patientId,
      cycleId,
      appointments: await seedAppointments(tx, clock, patientId, cycleId, appointments),
    });
  }
  return seeded;
}

/**
 * I punteggi PSFS finali dei cicli chiusi, nell'ordine delle attività (Davide; Martina, che la tabella non
 * dà, proposti da rileggere con l'osteopata).
 */
const FINAL_PSFS: Readonly<Record<string, readonly number[]>> = {
  "Davide Conti": [8, 9, 7],
  "Martina De Luca": [6, 8],
};

/** Le attività PSFS del ciclo in ordine di posizione. */
function psfsItemsOf(tx: Tx, cycleId: string): Promise<{ id: string }[]> {
  return tx.query<{ id: string }>("select id from public.psfs_items where practice_id = $1 and cycle_id = $2 order by position", [
    P,
    cycleId,
  ]);
}

/** La visita in bozza del ciclo: l'ultima seduta che il seed clinico lascia aperta per i punteggi finali. */
async function draftVisitOf(tx: Tx, cycleId: string): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    "select id from public.visits where practice_id = $1 and cycle_id = $2 and status = 'draft'",
    [P, cycleId],
  );
  const [row] = rows;
  if (!row || rows.length !== 1) throw new Error("Un ciclo chiuso con i punteggi finali vuole la sua ultima seduta in bozza.");
  return row.id;
}

/**
 * I tre cicli chiusi della demo con "Chiudi ciclo", al giorno e alla fine del loro ultimo appuntamento, con la
 * cadenza del paziente («Nessun richiamo» per Roberto). Davide e Martina chiudono con i punteggi PSFS finali
 * sull'ultima seduta, ancora in bozza, che poi si chiude con lo stesso orologio come
 * nell'app; Roberto non ha attività e chiude senza punteggi.
 */
async function closeCycles(tx: Tx, seeded: readonly Seeded[]): Promise<void> {
  for (const s of seeded) {
    const { outcome } = s.patient.cycle;
    const last = s.appointments.at(-1);
    if (outcome === undefined || !last) continue;
    const { recallWeeks, recallPaused } = s.patient;
    if (!recallPaused && recallWeeks === null) throw new Error("Un ciclo chiuso del seed vuole la cadenza del paziente.");
    const clock = fixedClock(endOf(last));
    const finals = FINAL_PSFS[`${s.patient.firstName} ${s.patient.lastName}`];
    const items = finals ? await psfsItemsOf(tx, s.cycleId) : [];
    if (finals && items.length !== finals.length) throw new Error("I punteggi finali del seed vogliono un'attività ciascuno.");
    const visitId = finals ? await draftVisitOf(tx, s.cycleId) : null;
    await closeCycle(tx, P, clock, {
      cycleId: s.cycleId,
      outcome,
      closedOn: last.day,
      finalScores: finals ? items.map((item, i) => ({ itemId: item.id, score: finals[i] })) : "non_tornato",
      recall: recallPaused || recallWeeks === null ? "nessuno" : { weeks: recallWeeks },
    });
    if (visitId !== null) await closeVisit(tx, P, clock, { visitId, confirmCopied: false, alsoMarkDone: false });
  }
}

async function contactGuardianId(tx: Tx, patientId: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    "select id from public.patient_guardians where practice_id = $1 and patient_id = $2 and is_contact",
    [P, patientId],
  );
  if (!row) throw new Error("Il minore del seed non ha un genitore di contatto.");
  return row.id;
}

/**
 * Come servizio, le tre righe che "Ricrea" conserva: l'utente demo, lo studio e la
 * membership owner, datati `createdAt`.
 */
export async function seedIdentity(tx: Tx, createdAt: Date): Promise<void> {
  await tx.query("insert into auth.users (id, email, created_at) values ($1, $2, $3)", [
    DEMO_USER_ID,
    DEMO_USER_EMAIL,
    createdAt,
  ]);
  await tx.query("insert into public.practices (id, name, created_at, updated_at) values ($1, $2, $3, $3)", [
    DEMO_PRACTICE_ID,
    DEMO_PRACTICE_NAME,
    createdAt,
  ]);
  await tx.query("insert into public.memberships (practice_id, user_id, role, created_at) values ($1, $2, 'owner', $3)", [
    DEMO_PRACTICE_ID,
    DEMO_USER_ID,
    createdAt,
  ]);
}

/**
 * Dentro una transazione aperta come servizio, con l'identità già presente e lo studio senza righe: i
 * contatori come servizio, poi `switchToUser` e tutto il resto come l'utente demo. `clock` è già congelato da
 * chi chiama; `assets` sono i file dei consensi e le sagome di Giulia già nello store (`prepareSeedAssets`). Lo
 * usano `seedDemo` e "Ricrea" (`src/server/demo/recreate.ts`).
 */
export async function seedPracticeData(tx: Tx, clock: Clock, assets: SeedAssets): Promise<void> {
  // Solo il servizio inizializza i numeri esterni; le emissioni li avanzano tramite app.next_number.
  for (const counter of seedCounters(clock.today())) {
    await tx.query(
      "insert into public.number_series (practice_id, series, year, last_number) values ($1, $2, $3, $4)",
      [P, counter.series, counter.year, counter.lastNumber],
    );
  }
  // Da qui al commit come l'utente demo.
  await switchToUser(tx, getActor());
  await seedStudio(tx, clock);
  const physicians = await seedPhysicians(tx, clock);
  const seeded = await seedPatients(tx, clock, physicians);
  // I consensi prima della cartella: i comandi clinici trovano lo stato che avrebbero nell'app,
  // e Roberto chiude il ciclo dopo il suo rinvio.
  await seedConsentRecords(tx, clock, seeded, assets.consents);
  await seedMessageTemplates(tx, P, clock);
  await seedClinical(tx, clock, seeded);
  // Le foto di Giulia dopo la cartella: ognuna è legata alla sua visita.
  await seedPhotos(tx, seeded, assets.photos);
  await closeCycles(tx, seeded);
  await seedInvoices(tx, clock, seeded);
}

/** I file del seed già nello store prima della transazione: i consensi e le sagome di Giulia. */
export type SeedAssets = { consents: SeedConsentAssets; photos: SeedPhotoAsset[] };

/**
 * Prima della transazione: i file dei consensi, poi le sagome di Giulia. Se le sagome
 * falliscono si tolgono anche i consensi già scritti.
 */
export async function prepareSeedAssets(d0: string, store: FileStore): Promise<SeedAssets> {
  const consents = await prepareSeedConsentAssets(d0, store);
  try {
    return { consents, photos: await prepareSeedPhotoAssets(store) };
  } catch (error) {
    await removeSeedConsentAssets(store, consents).catch(() => {});
    throw error;
  }
}

/** Toglie i file preparati da un tentativo di seed o di "Ricrea": quelli che c'erano prima restano. */
export async function removeSeedAssets(store: FileStore, assets: SeedAssets): Promise<void> {
  await removeSeedConsentAssets(store, assets.consents);
  await removeSeedPhotoAssets(store, assets.photos);
}

// L'orologio è l'istante del seed, D0 il suo giorno di Roma: con APP_FIXED_NOW la demo è quella di quel giorno.
// La prima lettura si congela per tutto il seed: un seed partito alle 23:59:59 non mescola due giorni.
// I file dei consensi e le sagome vanno nello store prima della transazione: se la transazione
// fallisce si tolgono solo quelli scritti da questo tentativo, e i file che lo store aveva già restano.
export async function seedDemo(db: Db, seedClock: Clock, store: FileStore): Promise<void> {
  const clock = fixedClock(seedClock.now());
  const assets = await prepareSeedAssets(clock.today(), store);
  try {
    await asService(db, async (tx) => {
      await seedIdentity(tx, clock.now());
      await seedPracticeData(tx, clock, assets);
    });
  } catch (error) {
    // Un errore della pulizia non nasconde quello del seed: al più resta un file orfano.
    await removeSeedAssets(store, assets).catch(() => {});
    throw error;
  }
}
