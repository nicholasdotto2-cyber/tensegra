import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { timeOf } from "@/lib/format";
import { type Clock, fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { switchToUser } from "@/server/db/service";
import { cancelAppointment, createAppointment, markSkipped } from "@/server/domain/appointments/commands";
import { listDayAppointments, listReminders } from "@/server/domain/appointments/queries";
import { getConsentStatus, listMissingConsents, loadValidConsents } from "@/server/domain/consents/queries";
import { getOpenCycle } from "@/server/domain/cycles/queries";
import { countToInvoice, listToInvoice } from "@/server/domain/invoices/queries";
import { createPatient } from "@/server/domain/patients/commands";
import { listRecalls } from "@/server/domain/patients/queries";
import { createService } from "@/server/domain/services/commands";
import { saveOpeningHours } from "@/server/domain/settings/commands";
import { writeChoiceTemporary, writeConsentTemporary } from "../support/consent-rows";
import { invoiceDraft, PRACTICE_A, PRACTICE_B, SERVICE_A, sha256Hex, USER_A, USER_B } from "./fixtures";
import { asUserB, idOf, inService, inUserA, insertRow, openTestDb } from "./helpers";

// Le letture dei cinque blocchi di Oggi: appuntamenti
// del giorno con posizione nel ciclo, segnali e azioni; consensi mancanti per età e ciclo; sedute da
// fatturare; promemoria del primo giorno aperto dopo oggi; richiami dall'ultima seduta fatta. I dati
// nascono come uA con i comandi dell'app e con lo scrittore provvisorio dei consensi del seed; ogni
// test torna indietro. L'orologio è giovedì 22/10/2026 alle 08:30 di Roma, salvo dove scritto.

const D0 = fixedClock("2026-10-22T08:30:00+02:00");
const TODAY = "2026-10-22";
const TOMORROW = "2026-10-23";

const at = (time: string, day = TODAY): Clock => fixedClock(`${day}T${time}:00+02:00`);

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

type DayBands = { opens: string; closes: string }[];

/** Una settimana con le fasce date per giorno ISO; i giorni assenti sono chiusi. */
function hours(bands: Partial<Record<number, DayBands>>) {
  return { days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, bands: bands[weekday] ?? [] })) };
}

const MORNING = { opens: "09:00", closes: "13:00" };
const AFTERNOON = { opens: "14:30", closes: "19:30" };
const FULL_DAY = [MORNING, AFTERNOON];

/** Gli orari del seed: lun-ven 09:00-13:00 e 14:30-19:30, sab 09:00-13:00, dom chiuso. */
const SEED_HOURS = hours({ 1: FULL_DAY, 2: FULL_DAY, 3: FULL_DAY, 4: FULL_DAY, 5: FULL_DAY, 6: [MORNING] });

interface Setup {
  firstVisitId: string;
  checkId: string;
}

/** Gli orari del seed, e accanto a SERVICE_A (seduta da 45, 60 euro) una prima visita da 60 e un controllo da 30. */
async function prepare(tx: Tx): Promise<Setup> {
  await saveOpeningHours(tx, PRACTICE_A, D0, SEED_HOURS);
  const firstVisit = await createService(tx, PRACTICE_A, D0, {
    kind: "prima_visita",
    name: "Prima visita osteopatica",
    invoiceDescription: "Prima visita osteopatica",
    durationMin: 60,
    priceCents: 8000,
    color: "ocra",
  });
  const check = await createService(tx, PRACTICE_A, D0, {
    kind: "controllo",
    name: "Controllo",
    invoiceDescription: "Controllo osteopatico",
    durationMin: 30,
    priceCents: 4500,
    color: "salvia",
  });
  return { firstVisitId: firstVisit.id, checkId: check.id };
}

/** Un adulto nuovo dal mini modulo: senza codice fiscale, indirizzo né consensi. */
async function adult(tx: Tx, firstName: string, lastName: string): Promise<string> {
  return (await createPatient(tx, PRACTICE_A, D0, { firstName, lastName, birthDate: "1979-03-09" })).id;
}

/** Sofia Rinaldi, nata il 12/06/2026 (4 mesi il 22/10), con la madre Elena come genitore (nasce `altro`). */
async function sofia(tx: Tx): Promise<string> {
  return (
    await createPatient(tx, PRACTICE_A, D0, {
      firstName: "Sofia",
      lastName: "Rinaldi",
      birthDate: "2026-06-12",
      guardian: { firstName: "Elena", lastName: "Rinaldi" },
    })
  ).id;
}

interface Booking {
  day: string;
  time: string;
  status?: "prenotato" | "confermato" | "fatto";
  serviceId?: string;
  durationMin?: number;
}

/** Prenota nel ciclo aperto del paziente, o in un ciclo nuovo; seduta da 45 minuti a 60 euro salvo `b`. */
async function book(tx: Tx, patientId: string, b: Booking, clock: Clock = D0): Promise<{ id: string; cycleId: string }> {
  const open = await getOpenCycle(tx, PRACTICE_A, patientId);
  const created = await createAppointment(tx, PRACTICE_A, clock, {
    patient: { kind: "existing", patientId },
    serviceId: b.serviceId ?? SERVICE_A,
    day: b.day,
    time: b.time,
    durationMin: b.durationMin ?? 45,
    cycle: open ? { kind: "existing", cycleId: open.id } : { kind: "new" },
    priceCents: 6000,
    status: b.status ?? "prenotato",
  });
  const [first] = created.appointments;
  if (!first) throw new Error("nessun appuntamento creato");
  return { id: first.id, cycleId: created.cycleId };
}

/** Codice fiscale e indirizzo completi; `except` lascia vuota una colonna. */
async function completeRecord(tx: Tx, patientId: string, except?: "tax_code" | "city"): Promise<void> {
  await tx.query(
    `update public.patients
        set tax_code = $2, address_line = 'Via Saragozza 10', postal_code = '40123', city = $3
      where id = $1`,
    [patientId, except === "tax_code" ? null : "BLLMRC79C09A944X", except === "city" ? null : "Bologna"],
  );
}

async function guardianOf(tx: Tx, patientId: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>("select id from public.patient_guardians where patient_id = $1", [patientId]);
  if (!row) throw new Error("il paziente non ha un genitore");
  return row.id;
}

/** L'informativa firmata sulla tela il 15/10; per un minore la firma il genitore. */
async function signInformativa(tx: Tx, patientId: string, minor = false): Promise<string> {
  const { id } = await writeConsentTemporary(tx, PRACTICE_A, {
    patientId,
    moduleKey: "informativa",
    cycleId: null,
    signedOn: "2026-10-15",
    signerKind: minor ? "genitore" : "paziente",
    signerName: minor ? "Elena Rinaldi" : "Marco Bellandi",
    guardianId: minor ? await guardianOf(tx, patientId) : null,
    method: "tela",
  });
  return id;
}

/** Il consenso al trattamento del ciclo (del genitore per un minore), caricato in PDF il 15/10. */
async function signTreatment(tx: Tx, patientId: string, cycleId: string, minor = false): Promise<string> {
  const { id } = await writeConsentTemporary(tx, PRACTICE_A, {
    patientId,
    moduleKey: minor ? "trattamento_minore" : "trattamento",
    cycleId,
    signedOn: "2026-10-15",
    signerKind: minor ? "genitore" : "paziente",
    signerName: minor ? "Elena Rinaldi" : "Marco Bellandi",
    guardianId: minor ? await guardianOf(tx, patientId) : null,
    method: "pdf_caricato",
  });
  return id;
}

async function signAll(tx: Tx, patientId: string, cycleId: string, minor = false): Promise<void> {
  await signInformativa(tx, patientId, minor);
  await signTreatment(tx, patientId, cycleId, minor);
}

/** Una visita dell'appuntamento, in bozza o chiusa. */
async function insertVisit(tx: Tx, patientId: string, a: { id: string; cycleId: string }, closed: boolean): Promise<void> {
  await insertRow(tx, "visits", {
    practice_id: PRACTICE_A,
    patient_id: patientId,
    cycle_id: a.cycleId,
    appointment_id: a.id,
    visit_date: TODAY,
    kind: "seduta",
    screening_catalog_version: 1,
    ...(closed ? { status: "closed", closed_at: "2026-10-22T08:00:00Z" } : {}),
  });
}

type Outcomes = Record<"thrust" | "direct" | "indirect", "indicated" | "caution" | "contraindicated">;

/** Una visita (chiusa o in bozza) di quel giorno con un esito di screening per ognuna delle tre famiglie. */
async function insertScreenedVisit(
  tx: Tx,
  patientId: string,
  a: { id: string; cycleId: string },
  day: string,
  outcomes: Outcomes | null,
  closed = true,
  /** `id` e `created_at` espliciti, per i casi in cui l'ordine decide fra due visite dello stesso giorno. */
  extra: { id?: string; created_at?: string } = {},
): Promise<void> {
  const visit = await insertRow(tx, "visits", {
    ...extra,
    practice_id: PRACTICE_A,
    patient_id: patientId,
    cycle_id: a.cycleId,
    appointment_id: a.id,
    visit_date: day,
    kind: "seduta",
    screening_catalog_version: 1,
  });
  for (const [family, outcome] of Object.entries(outcomes ?? {})) {
    await insertRow(tx, "visit_screening_outcomes", {
      practice_id: PRACTICE_A,
      visit_id: idOf(visit),
      family,
      suggested: outcome,
      outcome,
    });
  }
  // Una visita chiusa non accetta più figli: si chiude dopo.
  if (closed) {
    await tx.query("update public.visits set status = 'closed', closed_at = $2 where id = $1", [idOf(visit), `${day}T08:00:00Z`]);
  }
}

/** Una bozza di fattura del paziente con la riga dell'appuntamento; `linkActive` falso è la riga di una fattura annullata. */
async function draftLine(tx: Tx, patientId: string, appointmentId: string, linkActive = true): Promise<void> {
  const totals = { fees_cents: 6000, taxable_cents: 6000, total_cents: 6000, net_cents: 6000 };
  const invoiceId = idOf(await insertRow(tx, "invoices", invoiceDraft({ patient_id: patientId, ...totals })));
  await insertRow(tx, "invoice_lines", {
    practice_id: PRACTICE_A,
    invoice_id: invoiceId,
    line_number: 1,
    line_kind: "prestazione",
    service_id: SERVICE_A,
    appointment_id: appointmentId,
    description: "Seduta di osteopatia",
    service_date: "2026-10-21",
    quantity: 1,
    unit_price_cents: 6000,
    line_total_cents: 6000,
    vat_rate_bp: 0,
    nature: "N2.2",
    link_active: linkActive,
  });
}

const QUESTION_09 = "Inizia alle 09:00. Segnarlo comunque come fatto?";
const QUESTION_10 = "Inizia alle 10:00. Segnarlo comunque come fatto?";

describe("lo scrittore provvisorio dei consensi del seed", () => {
  const TEXT = "Testo provvisorio del seed: il modulo vero arriva dopo.";

  it("firma sulla tela: il PNG della firma senza file su disco, il testo con il suo sha256", async () => {
    const out = await inUserA(db, async (tx) => {
      const patientId = await adult(tx, "Marco", "Bellandi");
      const id = await signInformativa(tx, patientId);
      const [consent] = await tx.query<Record<string, unknown>>("select * from public.consent_records where id = $1", [id]);
      const [file] = await tx.query<Record<string, unknown>>("select * from public.files where id = $1", [
        String(consent?.signature_file_id),
      ]);
      return { patientId, consent, file };
    });
    expect(out.consent).toMatchObject({
      patient_id: out.patientId,
      cycle_id: null,
      module_key: "informativa",
      module_version: "2026.1",
      rendered_text: TEXT,
      rendered_hash: sha256Hex(TEXT),
      signer_kind: "paziente",
      signer_name: "Marco Bellandi",
      guardian_id: null,
      method: "tela",
      document_file_id: null,
      signed_on: "2026-10-15",
      outcome: "accetta",
      status: "valido",
      created_by: USER_A,
    });
    expect(out.file).toMatchObject({
      practice_id: PRACTICE_A,
      kind: "signature",
      mime_type: "image/png",
      storage_key: `${PRACTICE_A}/signature/${String(out.file?.id)}.png`,
      size_bytes: 1,
    });
    expect(out.file?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("PDF caricato: il file del modulo, nessuna firma; per un minore il genitore", async () => {
    const out = await inUserA(db, async (tx) => {
      const patientId = await sofia(tx);
      const { cycleId } = await book(tx, patientId, { day: TODAY, time: "11:00" });
      const id = await signTreatment(tx, patientId, cycleId, true);
      const [consent] = await tx.query<Record<string, unknown>>("select * from public.consent_records where id = $1", [id]);
      const [file] = await tx.query<Record<string, unknown>>("select * from public.files where id = $1", [
        String(consent?.document_file_id),
      ]);
      return { cycleId, guardianId: await guardianOf(tx, patientId), consent, file };
    });
    expect(out.consent).toMatchObject({
      cycle_id: out.cycleId,
      module_key: "trattamento_minore",
      signer_kind: "genitore",
      signer_name: "Elena Rinaldi",
      guardian_id: out.guardianId,
      method: "pdf_caricato",
      signature_file_id: null,
    });
    expect(out.file).toMatchObject({
      kind: "consent_upload",
      mime_type: "application/pdf",
      storage_key: `${PRACTICE_A}/consent_upload/${String(out.file?.id)}.pdf`,
      size_bytes: 1,
    });
  });

  it("una scelta sul canale: la riga così com'è", async () => {
    const out = await inUserA(db, async (tx) => {
      const patientId = await adult(tx, "Marco", "Bellandi");
      const informativa = await signInformativa(tx, patientId);
      await writeChoiceTemporary(tx, PRACTICE_A, {
        patientId,
        consentRecordId: informativa,
        choice: "richiami",
        value: true,
        decidedOn: "2026-10-15",
        mode: "modulo",
      });
      const rows = await tx.query<Record<string, unknown>>("select * from public.consent_choices where patient_id = $1", [
        patientId,
      ]);
      return { informativa, rows };
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      consent_record_id: out.informativa,
      choice: "richiami",
      value: true,
      decided_on: "2026-10-15",
      mode: "modulo",
    });
  });
});

describe("loadValidConsents e getConsentStatus", () => {
  it("l'informativa per paziente, il trattamento per ciclo; un revocato non vale; ogni paziente chiesto ha la sua voce", async () => {
    const out = await inUserA(db, async (tx) => {
      const marco = await adult(tx, "Marco", "Bellandi");
      const anna = await adult(tx, "Anna", "Morelli");
      const { cycleId } = await book(tx, marco, { day: TODAY, time: "09:00" });
      await signAll(tx, marco, cycleId);
      const signed = await getConsentStatus(tx, PRACTICE_A, marco);
      const both = await loadValidConsents(tx, PRACTICE_A, [marco, anna]);
      await tx.query(
        `update public.consent_records set status = 'revocato', revoked_on = '2026-10-20', revocation_mode = 'verbale'
          where patient_id = $1 and module_key = 'trattamento'`,
        [marco],
      );
      return { cycleId, signed, both, anna, marco, revoked: await getConsentStatus(tx, PRACTICE_A, marco) };
    });
    expect(out.signed.informativa).toBe(true);
    expect([...out.signed.treatment.entries()].map(([k, v]) => [k, [...v]])).toEqual([[out.cycleId, ["trattamento"]]]);
    expect(out.both.get(out.anna)).toEqual({ informativa: false, treatment: new Map() });
    expect(out.both.get(out.marco)?.informativa).toBe(true);
    expect(out.revoked).toEqual({ informativa: true, treatment: new Map() });
  });

  it("come uB i consensi di A non ci sono; nessun paziente, nessuna voce", async () => {
    const out = await inService(db, async (tx) => {
      await switchToUser(tx, { userId: USER_A });
      const marco = await adult(tx, "Marco", "Bellandi");
      await signInformativa(tx, marco);
      const asA = await getConsentStatus(tx, PRACTICE_A, marco);
      await switchToUser(tx, { userId: USER_B });
      return { asA, asB: await getConsentStatus(tx, PRACTICE_A, marco), none: await loadValidConsents(tx, PRACTICE_A, []) };
    });
    expect(out.asA.informativa).toBe(true);
    expect(out.asB).toEqual({ informativa: false, treatment: new Map() });
    expect(out.none.size).toBe(0);
  });
});

describe("Blocco 1: listDayAppointments", () => {
  it("per orario con l'annullato in fondo; azioni della tabella degli stati; domanda prima dell'inizio", async () => {
    const out = await inUserA(db, async (tx) => {
      await prepare(tx);
      const marco = await adult(tx, "Marco", "Bellandi");
      const anna = await adult(tx, "Anna", "Morelli");
      const luca = await adult(tx, "Luca", "Costa");
      const pietro = await adult(tx, "Pietro", "Gallo");
      await book(tx, marco, { day: TODAY, time: "09:00", status: "confermato" });
      await book(tx, marco, { day: TOMORROW, time: "09:00" });
      await book(tx, anna, { day: TODAY, time: "10:00" });
      const cancelled = await book(tx, luca, { day: TODAY, time: "11:00" });
      await cancelAppointment(tx, PRACTICE_A, D0, { id: cancelled.id, reason: "paziente", alsoFollowing: false });
      const skipped = await book(tx, pietro, { day: TODAY, time: "08:00" });
      await markSkipped(tx, PRACTICE_A, D0, { id: skipped.id });
      return {
        early: await listDayAppointments(tx, PRACTICE_A, D0, TODAY),
        late: await listDayAppointments(tx, PRACTICE_A, at("10:30"), TODAY),
        empty: await listDayAppointments(tx, PRACTICE_A, D0, "2026-10-21"),
        tomorrow: await listDayAppointments(tx, PRACTICE_A, D0, TOMORROW),
      };
    });

    expect(out.early.map((r) => [timeOf(r.startsAt), r.status, r.patientLabel])).toEqual([
      ["08:00", "saltato", "Gallo Pietro"],
      ["09:00", "confermato", "Bellandi Marco"],
      ["10:00", "prenotato", "Morelli Anna"],
      ["11:00", "annullato", "Costa Luca"],
    ]);
    expect(out.early.map((r) => r.actions)).toEqual([
      ["annulla_saltato"],
      ["segna_fatta", "annulla", "elimina", "modifica"],
      ["segna_confermato", "segna_fatta", "annulla", "elimina", "modifica"],
      ["ripristina"],
    ]);
    expect(out.early.map((r) => r.doneQuestion)).toEqual([null, QUESTION_09, QUESTION_10, null]);
    // "Apri la visita": prenotato, confermato e fatto di un giorno fino a oggi; mai saltato, annullato o domani.
    expect(out.early.map((r) => r.canOpenVisit)).toEqual([false, true, true, false]);
    expect(out.tomorrow.map((r) => [r.patientLabel, r.canOpenVisit])).toEqual([["Bellandi Marco", false]]);
    // Segnali solo sugli appuntamenti attivi: né il saltato né l'annullato.
    expect(out.early.map((r) => r.signals)).toEqual([
      [],
      ["consenso_mancante", "anagrafica_da_completare"],
      ["consenso_mancante", "anagrafica_da_completare"],
      [],
    ]);
    expect(out.early[1]).toMatchObject({
      endsAt: new Date("2026-10-22T07:45:00Z"),
      serviceName: "Seduta osteopatica",
      serviceKind: "seduta",
      sessionLabel: "Seduta 1 di 4",
      seriesId: null,
    });

    const anna = out.late.find((r) => r.patientLabel === "Morelli Anna");
    expect(anna?.doneQuestion).toBeNull();
    expect(anna?.actions).toEqual(["segna_confermato", "segna_fatta", "saltato", "annulla", "elimina", "modifica"]);
    expect(out.empty).toEqual([]);
  });

  it('"Seduta 2 di 4": prima visita fatta il 15/10, seduta saltata il 20/10, seduta oggi', async () => {
    const out = await inUserA(db, async (tx) => {
      const { firstVisitId, checkId } = await prepare(tx);
      const carla = await adult(tx, "Carla", "Esposito");
      await book(tx, carla, { day: "2026-10-15", time: "09:00", status: "fatto", serviceId: firstVisitId, durationMin: 60 });
      const skipped = await book(tx, carla, { day: "2026-10-20", time: "09:00" });
      await markSkipped(tx, PRACTICE_A, D0, { id: skipped.id });
      await book(tx, carla, { day: TODAY, time: "09:00" });
      // Un controllo apre un mantenimento, senza sedute previste.
      const paolo = await adult(tx, "Paolo", "Ferri");
      await book(tx, paolo, { day: TODAY, time: "15:00", serviceId: checkId, durationMin: 30 });
      const label = async (day: string) => (await listDayAppointments(tx, PRACTICE_A, D0, day)).map((r) => r.sessionLabel);
      return { first: await label("2026-10-15"), skipped: await label("2026-10-20"), today: await label(TODAY) };
    });
    expect(out.first).toEqual(["Seduta 1 di 4"]);
    expect(out.skipped).toEqual([null]);
    expect(out.today).toEqual(["Seduta 2 di 4", "Seduta 1"]);
  });

  it('"Da chiudere": fine passata da oltre 30 minuti, ancora prenotato o confermato', async () => {
    const out = await inUserA(db, async (tx) => {
      await prepare(tx);
      const marco = await adult(tx, "Marco", "Bellandi");
      await completeRecord(tx, marco);
      const a = await book(tx, marco, { day: TODAY, time: "09:00", status: "confermato" });
      await signAll(tx, marco, a.cycleId);
      const signals = async (clock: Clock) => (await listDayAppointments(tx, PRACTICE_A, clock, TODAY))[0]?.signals;
      return { at1015: await signals(at("10:15")), at1016: await signals(at("10:16")) };
    });
    expect(out.at1015).toEqual([]);
    expect(out.at1016).toEqual(["da_chiudere"]);
  });

  it('"Consenso mancante" una volta per paziente, sul primo appuntamento del giorno', async () => {
    const rows = await inUserA(db, async (tx) => {
      await prepare(tx);
      const anna = await adult(tx, "Anna", "Morelli");
      await completeRecord(tx, anna);
      await book(tx, anna, { day: TODAY, time: "09:00" });
      await book(tx, anna, { day: TODAY, time: "15:00" });
      return listDayAppointments(tx, PRACTICE_A, D0, TODAY);
    });
    expect(rows.map((r) => r.signals)).toEqual([["consenso_mancante"], []]);
  });

  it('"Anagrafica da completare" senza codice fiscale o con l\'indirizzo a metà; "Avviso clinico" con clinical_alert', async () => {
    const rows = await inUserA(db, async (tx) => {
      await prepare(tx);
      const people: [string, string, (id: string) => Promise<void>][] = [
        ["Marco", "Bellandi", (id) => completeRecord(tx, id, "tax_code")],
        ["Anna", "Morelli", (id) => completeRecord(tx, id, "city")],
        ["Luca", "Costa", (id) => completeRecord(tx, id)],
        [
          "Pietro",
          "Gallo",
          async (id) => {
            await completeRecord(tx, id);
            await tx.query("update public.patients set clinical_alert = 'Anticoagulanti' where id = $1", [id]);
          },
        ],
      ];
      let hour = 9;
      for (const [firstName, lastName, setUp] of people) {
        const id = await adult(tx, firstName, lastName);
        await setUp(id);
        const a = await book(tx, id, { day: TODAY, time: `${String(hour).padStart(2, "0")}:00` });
        await signAll(tx, id, a.cycleId);
        hour += 1;
      }
      return listDayAppointments(tx, PRACTICE_A, D0, TODAY);
    });
    expect(rows.map((r) => [r.patientLabel, r.signals])).toEqual([
      ["Bellandi Marco", ["anagrafica_da_completare"]],
      ["Morelli Anna", ["anagrafica_da_completare"]],
      ["Costa Luca", []],
      ["Gallo Pietro", ["avviso_clinico"]],
    ]);
  });

  it('"Avviso clinico" anche per un esito dello screening non "indicato" nella visita più recente, bozza compresa', async () => {
    const ALL_OK: Outcomes = { thrust: "indicated", direct: "indicated", indirect: "indicated" };
    const CAUTION: Outcomes = { thrust: "caution", direct: "indicated", indirect: "indicated" };
    const BLOCKED: Outcomes = { thrust: "indicated", direct: "contraindicated", indirect: "indicated" };
    const rows = await inUserA(db, async (tx) => {
      await prepare(tx);
      // Per ognuno gli esiti della visita del 10/10, di quella del 20/10 e se la seconda è una bozza.
      const people: [string, Outcomes | null, Outcomes | null, boolean][] = [
        ["Aldi", null, null, false],
        ["Bassi", ALL_OK, ALL_OK, false],
        ["Conti", CAUTION, ALL_OK, false],
        ["Dori", ALL_OK, CAUTION, false],
        ["Enea", BLOCKED, null, false],
        ["Fabbri", ALL_OK, CAUTION, true],
      ];
      let hour = 9;
      for (const [lastName, earlier, later, draft] of people) {
        const id = await adult(tx, "Paolo", lastName);
        await completeRecord(tx, id);
        if (earlier) {
          const first = await book(tx, id, { day: "2026-10-10", time: "09:00", status: "fatto" });
          await insertScreenedVisit(tx, id, first, "2026-10-10", earlier);
        }
        if (later) {
          const second = await book(tx, id, { day: "2026-10-20", time: "09:00", status: "fatto" });
          await insertScreenedVisit(tx, id, second, "2026-10-20", later, !draft);
        }
        const today = await book(tx, id, { day: TODAY, time: `${String(hour).padStart(2, "0")}:00` });
        await signAll(tx, id, today.cycleId);
        hour += 1;
      }
      return listDayAppointments(tx, PRACTICE_A, D0, TODAY);
    });
    expect(rows.map((r) => [r.patientLabel, r.signals.includes("avviso_clinico")])).toEqual([
      ["Aldi Paolo", false],
      ["Bassi Paolo", false],
      ["Conti Paolo", false],
      ["Dori Paolo", true],
      ["Enea Paolo", true],
      ["Fabbri Paolo", true],
    ]);
  });

  it('"Avviso clinico": una bozza appena aperta, ancora senza esiti, non nasconde la cautela della visita chiusa precedente', async () => {
    const CAUTION: Outcomes = { thrust: "caution", direct: "indicated", indirect: "indicated" };
    const rows = await inUserA(db, async (tx) => {
      await prepare(tx);
      const id = await adult(tx, "Paolo", "Giusti");
      await completeRecord(tx, id);
      const earlier = await book(tx, id, { day: "2026-10-20", time: "09:00", status: "fatto" });
      await insertScreenedVisit(tx, id, earlier, "2026-10-20", CAUTION);
      const today = await book(tx, id, { day: TODAY, time: "09:00" });
      await signAll(tx, id, today.cycleId);
      const before = await listDayAppointments(tx, PRACTICE_A, D0, TODAY);
      // "Apri la visita" di oggi: una bozza senza risposte né esiti.
      await insertScreenedVisit(tx, id, today, TODAY, null, false);
      return { before, after: await listDayAppointments(tx, PRACTICE_A, D0, TODAY) };
    });
    expect(rows.before.map((r) => r.signals.includes("avviso_clinico"))).toEqual([true]);
    expect(rows.after.map((r) => r.signals.includes("avviso_clinico"))).toEqual([true]);
  });

  it('"Avviso clinico": a parità di visit_date decide created_at, e a parità anche di quello l\'id più alto', async () => {
    const ALL_OK: Outcomes = { thrust: "indicated", direct: "indicated", indirect: "indicated" };
    const CAUTION: Outcomes = { thrust: "caution", direct: "indicated", indirect: "indicated" };
    const SAME = "2026-10-20T07:00:00Z";
    // [cognome, esiti della prima visita (id basso), esiti della seconda (id alto), created_at della prima, della seconda].
    const cases: [string, Outcomes, Outcomes, string, string][] = [
      ["Alfa", ALL_OK, CAUTION, "2026-10-20T07:00:00Z", "2026-10-20T08:00:00Z"],
      ["Beta", CAUTION, ALL_OK, "2026-10-20T08:00:00Z", "2026-10-20T07:00:00Z"],
      ["Gamma", ALL_OK, CAUTION, SAME, SAME],
      ["Delta", CAUTION, ALL_OK, SAME, SAME],
    ];
    const rows = await inUserA(db, async (tx) => {
      await prepare(tx);
      let n = 1;
      let hour = 9;
      for (const [lastName, firstOutcomes, secondOutcomes, firstAt, secondAt] of cases) {
        const id = await adult(tx, "Paolo", lastName);
        await completeRecord(tx, id);
        const first = await book(tx, id, { day: "2026-10-20", time: "09:00", status: "fatto" });
        const second = await book(tx, id, { day: "2026-10-20", time: "15:00", status: "fatto" });
        // L'id con la cifra più alta è della seconda visita.
        const visitId = (k: number) => `b0000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
        await insertScreenedVisit(tx, id, first, "2026-10-20", firstOutcomes, true, { id: visitId(n), created_at: firstAt });
        await insertScreenedVisit(tx, id, second, "2026-10-20", secondOutcomes, true, { id: visitId(n + 1), created_at: secondAt });
        n += 2;
        const today = await book(tx, id, { day: TODAY, time: `${String(hour).padStart(2, "0")}:00` });
        await signAll(tx, id, today.cycleId);
        hour += 1;
      }
      return listDayAppointments(tx, PRACTICE_A, D0, TODAY);
    });
    // Alfa e Beta: created_at contro l'id (in Beta la visita più recente per created_at ha l'id più basso). Gamma e Delta: solo l'id.
    expect(rows.map((r) => [r.patientLabel, r.signals.includes("avviso_clinico")])).toEqual([
      ["Alfa Paolo", true],
      ["Beta Paolo", true],
      ["Gamma Paolo", true],
      ["Delta Paolo", false],
    ]);
  });

  it('"Visita da compilare": fatto senza visita chiusa, anche con una bozza', async () => {
    const rows = await inUserA(db, async (tx) => {
      await prepare(tx);
      const visits: [string, string, "none" | "draft" | "closed"][] = [
        ["Marco", "Bellandi", "none"],
        ["Anna", "Morelli", "draft"],
        ["Luca", "Costa", "closed"],
      ];
      let minute = 0;
      for (const [firstName, lastName, visit] of visits) {
        const id = await adult(tx, firstName, lastName);
        await completeRecord(tx, id);
        const a = await book(tx, id, { day: TODAY, time: `08:${String(minute).padStart(2, "0")}`, status: "fatto" });
        await signAll(tx, id, a.cycleId);
        if (visit !== "none") await insertVisit(tx, id, a, visit === "closed");
        minute += 15;
      }
      return listDayAppointments(tx, PRACTICE_A, D0, TODAY);
    });
    expect(rows.map((r) => [r.patientLabel, r.status, r.signals])).toEqual([
      ["Bellandi Marco", "fatto", ["visita_da_compilare"]],
      ["Morelli Anna", "fatto", ["visita_da_compilare"]],
      ["Costa Luca", "fatto", []],
    ]);
  });

  it('un minore porta l\'età: "Rinaldi Sofia, 4 mesi"', async () => {
    const rows = await inUserA(db, async (tx) => {
      await prepare(tx);
      const id = await sofia(tx);
      await book(tx, id, { day: TODAY, time: "11:00" });
      return listDayAppointments(tx, PRACTICE_A, D0, TODAY);
    });
    expect(rows.map((r) => r.patientLabel)).toEqual(["Rinaldi Sofia, 4 mesi"]);
  });
});

describe("Blocco 2: listMissingConsents", () => {
  it("chi manca, cosa manca e quando, nell'ordine del primo appuntamento futuro e poi dei soli fatti", async () => {
    const { minor, rows } = await inUserA(db, async (tx) => {
      await prepare(tx);
      const marco = await adult(tx, "Marco", "Bellandi");
      await book(tx, marco, { day: TOMORROW, time: "11:00" });
      const sofiaId = await sofia(tx);
      await book(tx, sofiaId, { day: TODAY, time: "11:00" });
      const anna = await adult(tx, "Anna", "Morelli");
      const signed = await book(tx, anna, { day: "2026-10-24", time: "11:00" });
      await signAll(tx, anna, signed.cycleId);
      const luca = await adult(tx, "Luca", "Costa");
      await book(tx, luca, { day: "2026-10-29", time: "11:00" });
      const pietro = await adult(tx, "Pietro", "Gallo");
      await book(tx, pietro, { day: "2026-10-30", time: "11:00" });
      const carla = await adult(tx, "Carla", "Esposito");
      await book(tx, carla, { day: "2026-10-20", time: "09:00", status: "fatto" });
      const paolo = await adult(tx, "Paolo", "Ferri");
      await book(tx, paolo, { day: "2026-10-16", time: "09:00", status: "fatto" });
      return { minor: sofiaId, rows: await listMissingConsents(tx, PRACTICE_A, D0) };
    });
    expect(rows[0]?.patientId).toBe(minor);
    expect(rows).toMatchObject([
      {
        firstName: "Sofia",
        lastName: "Rinaldi",
        ageText: "4 mesi",
        missingText: "Informativa e consenso del genitore",
        whenText: "oggi alle 11:00",
      },
      {
        firstName: "Marco",
        lastName: "Bellandi",
        ageText: null,
        missingText: "Informativa e consenso al trattamento",
        whenText: "domani alle 11:00",
      },
      {
        firstName: "Luca",
        lastName: "Costa",
        ageText: null,
        missingText: "Informativa e consenso al trattamento",
        whenText: "gio 29 ott alle 11:00",
      },
      {
        firstName: "Paolo",
        lastName: "Ferri",
        ageText: null,
        missingText: "Informativa e consenso al trattamento",
        whenText: "seduta del 16/10",
      },
      {
        firstName: "Carla",
        lastName: "Esposito",
        ageText: null,
        missingText: "Informativa e consenso al trattamento",
        whenText: "seduta del 20/10",
      },
    ]);
  });

  it("cosa manca con un solo modulo; un trattamento revocato torna a mancare; il trattamento di un altro ciclo non vale", async () => {
    const out = await inUserA(db, async (tx) => {
      await prepare(tx);
      const marco = await adult(tx, "Marco", "Bellandi");
      await signInformativa(tx, marco);
      const m = await book(tx, marco, { day: TODAY, time: "09:00" });
      const anna = await adult(tx, "Anna", "Morelli");
      const a = await book(tx, anna, { day: TODAY, time: "10:00" });
      await signTreatment(tx, anna, a.cycleId);
      const minor = await sofia(tx);
      const s = await book(tx, minor, { day: TODAY, time: "11:00" });
      await signInformativa(tx, minor, true);
      // Il consenso di un adulto non vale per un minore: serve quello del genitore.
      await signTreatment(tx, minor, s.cycleId, false);
      const before = await listMissingConsents(tx, PRACTICE_A, D0);
      await signTreatment(tx, marco, m.cycleId);
      const signed = await listMissingConsents(tx, PRACTICE_A, D0);
      await tx.query(
        `update public.consent_records set status = 'revocato', revoked_on = '2026-10-21', revocation_mode = 'scritta'
          where patient_id = $1 and module_key = 'trattamento'`,
        [marco],
      );
      return { before, signed, revoked: await listMissingConsents(tx, PRACTICE_A, D0) };
    });
    const texts = (rows: typeof out.before) => rows.map((r) => [r.firstName, r.missingText]);
    expect(texts(out.before)).toEqual([
      ["Marco", "Consenso al trattamento"],
      ["Anna", "Informativa"],
      ["Sofia", "Consenso del genitore"],
    ]);
    expect(texts(out.signed)).toEqual([
      ["Anna", "Informativa"],
      ["Sofia", "Consenso del genitore"],
    ]);
    expect(texts(out.revoked)).toEqual(texts(out.before));
  });

  it("un paziente archiviato esce; annullati e saltati non contano; zero righe senza appuntamenti", async () => {
    const out = await inUserA(db, async (tx) => {
      await prepare(tx);
      const empty = await listMissingConsents(tx, PRACTICE_A, D0);
      const marco = await adult(tx, "Marco", "Bellandi");
      const cancelled = await book(tx, marco, { day: TODAY, time: "11:00" });
      await cancelAppointment(tx, PRACTICE_A, D0, { id: cancelled.id, reason: "studio", alsoFollowing: false });
      const pietro = await adult(tx, "Pietro", "Gallo");
      const skipped = await book(tx, pietro, { day: TODAY, time: "08:00" });
      await markSkipped(tx, PRACTICE_A, D0, { id: skipped.id });
      const anna = await adult(tx, "Anna", "Morelli");
      await book(tx, anna, { day: TOMORROW, time: "09:00" });
      const withAnna = await listMissingConsents(tx, PRACTICE_A, D0);
      await tx.query("update public.patients set archived_at = '2026-10-22T06:00:00Z' where id = $1", [anna]);
      return { empty, withAnna, archived: await listMissingConsents(tx, PRACTICE_A, D0) };
    });
    expect(out.empty).toEqual([]);
    expect(out.withAnna.map((r) => r.firstName)).toEqual(["Anna"]);
    expect(out.archived).toEqual([]);
  });
});

describe("Blocco 3: listToInvoice e countToInvoice", () => {
  it("i fatti fino a oggi senza riga attiva e senza motivo, dal più vecchio", async () => {
    const out = await inUserA(db, async (tx) => {
      const { checkId } = await prepare(tx);
      const empty = { list: await listToInvoice(tx, PRACTICE_A, D0), count: await countToInvoice(tx, PRACTICE_A, D0) };
      const marco = await adult(tx, "Marco", "Bellandi");
      const yesterday = await book(tx, marco, { day: "2026-10-21", time: "09:00", status: "fatto" });
      const anna = await adult(tx, "Anna", "Morelli");
      await book(tx, anna, { day: "2026-10-15", time: "10:00", status: "fatto", serviceId: checkId, durationMin: 30 });
      const luca = await adult(tx, "Luca", "Costa");
      await book(tx, luca, { day: TODAY, time: "08:00", status: "fatto" });
      // Una fattura annullata lascia la riga senza `link_active`: la seduta torna da fatturare.
      const cancelledInvoice = await adult(tx, "Paolo", "Ferri");
      const p = await book(tx, cancelledInvoice, { day: "2026-10-19", time: "09:00", status: "fatto" });
      await draftLine(tx, cancelledInvoice, p.id, false);
      // Fuori: un motivo per non fatturare, una riga attiva in bozza, un prenotato passato.
      const free = await adult(tx, "Pietro", "Gallo");
      const f = await book(tx, free, { day: "2026-10-20", time: "09:00", status: "fatto" });
      await tx.query("update public.appointments set no_invoice_reason = 'gratuita' where id = $1", [f.id]);
      const drafted = await adult(tx, "Carla", "Esposito");
      const d = await book(tx, drafted, { day: "2026-10-20", time: "10:00", status: "fatto" });
      await draftLine(tx, drafted, d.id);
      const booked = await adult(tx, "Elisa", "Fontana");
      await book(tx, booked, { day: "2026-10-20", time: "11:00" });
      return {
        yesterday: yesterday.id,
        empty,
        list: await listToInvoice(tx, PRACTICE_A, D0),
        count: await countToInvoice(tx, PRACTICE_A, D0),
      };
    });
    expect(out.empty).toEqual({ list: [], count: 0 });
    expect(out.list).toMatchObject([
      { day: "2026-10-15", patientName: "Anna Morelli", serviceName: "Controllo", priceCents: 6000 },
      { day: "2026-10-19", patientName: "Paolo Ferri", serviceName: "Seduta osteopatica", priceCents: 6000 },
      { day: "2026-10-21", patientName: "Marco Bellandi", serviceName: "Seduta osteopatica", priceCents: 6000 },
      { day: "2026-10-22", patientName: "Luca Costa", serviceName: "Seduta osteopatica", priceCents: 6000 },
    ]);
    expect(out.list[2]?.appointmentId).toBe(out.yesterday);
    expect(out.count).toBe(out.list.length);
  });

  it("l'importo è il prezzo dell'appuntamento, non del listino", async () => {
    const rows = await inUserA(db, async (tx) => {
      await prepare(tx);
      const marco = await adult(tx, "Marco", "Bellandi");
      const a = await book(tx, marco, { day: "2026-10-21", time: "09:00", status: "fatto" });
      await tx.query("update public.appointments set price_cents = 5000 where id = $1", [a.id]);
      return listToInvoice(tx, PRACTICE_A, D0);
    });
    expect(rows.map((r) => r.priceCents)).toEqual([5000]);
  });
});

describe("Blocco 4: listReminders", () => {
  it('giovedì 22/10: "Promemoria per domani, venerdì 23", solo prenotati e confermati, il genitore per un minore', async () => {
    const out = await inUserA(db, async (tx) => {
      await prepare(tx);
      const empty = await listReminders(tx, PRACTICE_A, D0);
      const marco = await adult(tx, "Marco", "Bellandi");
      await book(tx, marco, { day: TOMORROW, time: "09:00" });
      const anna = await adult(tx, "Anna", "Morelli");
      await book(tx, anna, { day: TOMORROW, time: "10:00", status: "confermato" });
      const luca = await adult(tx, "Luca", "Costa");
      const cancelled = await book(tx, luca, { day: TOMORROW, time: "11:00" });
      await cancelAppointment(tx, PRACTICE_A, D0, { id: cancelled.id, reason: "paziente", alsoFollowing: false });
      const minor = await sofia(tx);
      await book(tx, minor, { day: TOMORROW, time: "15:00" });
      const other = await listReminders(tx, PRACTICE_A, D0);
      await tx.query("update public.patient_guardians set relationship = 'madre' where patient_id = $1", [minor]);
      return { empty, other, mother: await listReminders(tx, PRACTICE_A, D0) };
    });
    expect(out.empty).toEqual({ day: TOMORROW, title: "Promemoria per domani, venerdì 23", rows: [] });
    expect(out.mother.title).toBe("Promemoria per domani, venerdì 23");
    expect(out.mother.rows.map((r) => [timeOf(r.startsAt), r.recipientText])).toEqual([
      ["09:00", "Marco Bellandi"],
      ["10:00", "Anna Morelli"],
      ["15:00", "Sofia Rinaldi, a Elena (madre)"],
    ]);
    // Relazione `altro`: senza parentesi.
    expect(out.other.rows.map((r) => r.recipientText)[2]).toBe("Sofia Rinaldi, a Elena");
  });

  it('sabato 24/10: "Promemoria per lunedì 26"; senza orari, il giorno dopo', async () => {
    const saturday = at("08:30", "2026-10-24");
    const out = await inUserA(db, async (tx) => {
      await prepare(tx);
      const marco = await adult(tx, "Marco", "Bellandi");
      await book(tx, marco, { day: "2026-10-26", time: "09:00" });
      const open = await listReminders(tx, PRACTICE_A, saturday);
      await saveOpeningHours(tx, PRACTICE_A, saturday, hours({}));
      return { open, closed: await listReminders(tx, PRACTICE_A, saturday) };
    });
    expect(out.open.day).toBe("2026-10-26");
    expect(out.open.title).toBe("Promemoria per lunedì 26");
    expect(out.open.rows.map((r) => r.recipientText)).toEqual(["Marco Bellandi"]);
    expect(out.closed).toEqual({ day: "2026-10-25", title: "Promemoria per domani, domenica 25", rows: [] });
  });
});

describe("Blocco 5: listRecalls", () => {
  /** Un paziente con un fatto il giorno dato, la cadenza e, se `consent`, l'informativa con il sì ai richiami. */
  async function recallPatient(
    tx: Tx,
    name: [string, string],
    lastDone: string,
    opts: { weeks?: number; consent?: boolean } = {},
  ): Promise<string> {
    const id = await adult(tx, ...name);
    await book(tx, id, { day: lastDone, time: "09:00", status: "fatto" });
    await tx.query("update public.patients set recall_interval_weeks = $2 where id = $1", [id, opts.weeks ?? 8]);
    if (opts.consent ?? true) {
      const informativa = await signInformativa(tx, id);
      await writeChoiceTemporary(tx, PRACTICE_A, {
        patientId: id,
        consentRecordId: informativa,
        choice: "richiami",
        value: true,
        decidedOn: lastDone,
        mode: "modulo",
      });
    }
    return id;
  }

  it("scaduti dal più vecchio, poi in scadenza, entro 7 giorni; senza consenso nel gruppo a parte", async () => {
    const out = await inUserA(db, async (tx) => {
      await prepare(tx);
      const empty = await listRecalls(tx, PRACTICE_A, D0, 7);
      // 25/10 = 30/08 + 8 settimane; 12/10 = 17/08 + 8 settimane.
      await recallPatient(tx, ["Anna", "Morelli"], "2026-08-30");
      const marco = await recallPatient(tx, ["Marco", "Bellandi"], "2026-08-17");
      // 30/10 = 02/10 + 4 settimane: fuori dai 7 giorni, dentro i 30.
      await recallPatient(tx, ["Paolo", "Ferri"], "2026-10-02", { weeks: 4 });
      const paused = await recallPatient(tx, ["Pietro", "Gallo"], "2026-08-17");
      await tx.query("update public.patients set recall_paused = true where id = $1", [paused]);
      const archived = await recallPatient(tx, ["Elisa", "Fontana"], "2026-08-17");
      await tx.query("update public.patients set archived_at = '2026-10-21T08:00:00Z' where id = $1", [archived]);
      // Ultima scelta `richiami` a false: dopo il sì del modulo, la revoca via messaggio.
      const carla = await recallPatient(tx, ["Carla", "Esposito"], "2026-08-24");
      await writeChoiceTemporary(tx, PRACTICE_A, {
        patientId: carla,
        consentRecordId: null,
        choice: "richiami",
        value: false,
        decidedOn: "2026-09-10",
        mode: "messaggio",
      });
      // Nessuna scelta sui richiami.
      await recallPatient(tx, ["Luca", "Costa"], "2026-08-31", { consent: false });
      // Una cadenza senza nessun fatto: niente data, niente richiamo.
      const never = await adult(tx, "Nadia", "Neri");
      await tx.query("update public.patients set recall_interval_weeks = 6 where id = $1", [never]);
      return {
        marco,
        empty,
        week: await listRecalls(tx, PRACTICE_A, D0, 7),
        month: await listRecalls(tx, PRACTICE_A, D0, 30),
      };
    });
    expect(out.empty).toEqual({ rows: [], withoutConsent: [] });
    expect(out.week.rows).toMatchObject([
      {
        name: "Marco Bellandi",
        dueDay: "2026-10-12",
        dueText: "Scaduto da 10 giorni",
        lastDoneDay: "2026-08-17",
        cadenceWeeks: 8,
      },
      { name: "Anna Morelli", dueDay: "2026-10-25", dueText: "Fra 3 giorni", lastDoneDay: "2026-08-30", cadenceWeeks: 8 },
    ]);
    expect(out.week.rows[0]?.patientId).toBe(out.marco);
    expect(out.week.withoutConsent.map((r) => [r.name, r.dueText])).toEqual([
      ["Carla Esposito", "Scaduto da 3 giorni"],
      ["Luca Costa", "Fra 4 giorni"],
    ]);
    expect(out.month.rows.map((r) => [r.name, r.dueText])).toEqual([
      ["Marco Bellandi", "Scaduto da 10 giorni"],
      ["Anna Morelli", "Fra 3 giorni"],
      ["Paolo Ferri", "Fra 8 giorni"],
    ]);
  });

  it("un appuntamento futuro toglie il richiamo: il controllo di oggi alle 10:00 conta anche alle 18:30", async () => {
    const evening = at("18:30");
    const out = await inUserA(db, async (tx) => {
      const { checkId } = await prepare(tx);
      const anna = await recallPatient(tx, ["Anna", "Morelli"], "2026-08-27");
      const check = await book(tx, anna, { day: TODAY, time: "10:00", serviceId: checkId, durationMin: 30 });
      const booked = await listRecalls(tx, PRACTICE_A, evening, 7);
      await cancelAppointment(tx, PRACTICE_A, D0, { id: check.id, reason: "paziente", alsoFollowing: false });
      return { booked, cancelled: await listRecalls(tx, PRACTICE_A, evening, 7) };
    });
    expect(out.booked).toEqual({ rows: [], withoutConsent: [] });
    expect(out.cancelled.rows.map((r) => [r.name, r.dueText])).toEqual([["Anna Morelli", "Scade oggi"]]);
  });

  it("l'ultima seduta fatta decide la data; senza informativa valida il sì ai richiami non basta", async () => {
    const out = await inUserA(db, async (tx) => {
      await prepare(tx);
      const marco = await recallPatient(tx, ["Marco", "Bellandi"], "2026-08-17");
      await book(tx, marco, { day: "2026-08-24", time: "09:00", status: "fatto" });
      const later = await listRecalls(tx, PRACTICE_A, D0, 7);
      await tx.query(
        `update public.consent_records set status = 'revocato', revoked_on = '2026-10-01', revocation_mode = 'verbale'
          where patient_id = $1 and module_key = 'informativa'`,
        [marco],
      );
      return { later, revoked: await listRecalls(tx, PRACTICE_A, D0, 7) };
    });
    expect(out.later.rows.map((r) => [r.lastDoneDay, r.dueDay, r.dueText])).toEqual([
      ["2026-08-24", "2026-10-19", "Scaduto da 3 giorni"],
    ]);
    expect(out.revoked.rows).toEqual([]);
    expect(out.revoked.withoutConsent.map((r) => r.name)).toEqual(["Marco Bellandi"]);
  });
});

describe("isolamento: le letture di uB sui dati di A", () => {
  it("uA vede i suoi cinque blocchi, uB con lo studio di A non vede niente", async () => {
    const read = async (tx: Tx, practiceId: string) => ({
      day: (await listDayAppointments(tx, practiceId, D0, TODAY)).length,
      consents: (await listMissingConsents(tx, practiceId, D0)).length,
      invoices: (await listToInvoice(tx, practiceId, D0)).length,
      invoiceCount: await countToInvoice(tx, practiceId, D0),
      reminders: (await listReminders(tx, practiceId, D0)).rows.length,
      recalls: (await listRecalls(tx, practiceId, D0, 7)).rows.length,
    });
    const out = await inService(db, async (tx) => {
      await switchToUser(tx, { userId: USER_A });
      await prepare(tx);
      const marco = await adult(tx, "Marco", "Bellandi");
      await book(tx, marco, { day: "2026-08-17", time: "09:00", status: "fatto" });
      await tx.query("update public.patients set recall_interval_weeks = 8 where id = $1", [marco]);
      const informativa = await signInformativa(tx, marco);
      await writeChoiceTemporary(tx, PRACTICE_A, {
        patientId: marco,
        consentRecordId: informativa,
        choice: "richiami",
        value: true,
        decidedOn: "2026-08-17",
        mode: "modulo",
      });
      const anna = await adult(tx, "Anna", "Morelli");
      await book(tx, anna, { day: TODAY, time: "09:00", status: "fatto" });
      await book(tx, anna, { day: TOMORROW, time: "09:00" });
      const asA = await read(tx, PRACTICE_A);
      await switchToUser(tx, { userId: USER_B });
      return { asA, asB: await read(tx, PRACTICE_A), ownB: await read(tx, PRACTICE_B) };
    });
    expect(out.asA).toEqual({ day: 1, consents: 2, invoices: 2, invoiceCount: 2, reminders: 1, recalls: 1 });
    const nothing = { day: 0, consents: 0, invoices: 0, invoiceCount: 0, reminders: 0, recalls: 0 };
    expect(out.asB).toEqual(nothing);
    expect(out.ownB).toEqual(nothing);
  });

  it("uB nel suo studio vede il suo appuntamento delle fixture, non quello di A", async () => {
    const rows = await asUserB(db, (tx) => listDayAppointments(tx, PRACTICE_B, D0, "2026-10-05"));
    expect(rows.map((r) => r.patientLabel)).toEqual(["Conti Elena"]);
  });
});
