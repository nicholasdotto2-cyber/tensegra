import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePatientListParams, type PatientFilter, type PatientListParams } from "@/lib/patients/params";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import {
  getPatientHeader,
  getRegistry,
  getSummaryTab,
  listPatientAppointments,
  listPatientConsents,
} from "@/server/domain/patients/card";
import { createPatient } from "@/server/domain/patients/commands";
import { listPatients, type PatientFacts, type PatientList, recallCell } from "@/server/domain/patients/list";
import { writeChoiceTemporary, writeConsentTemporary } from "../support/consent-rows";
import {
  GUARDIAN_A,
  invoiceDraft,
  issueInvoice,
  PATIENT_A1,
  PATIENT_A3,
  PATIENT_B1,
  PRACTICE_A,
  SERVICE_A,
} from "./fixtures";
import { asUserB, idOf, inUserA, insertRow, openTestDb } from "./helpers";

// Le letture della lista dei pazienti e della scheda.
// I dati nascono come uA nel test, accanto ai tre pazienti delle fixture di A (Ferrari Giulia col
// ciclo di trattamento aperto senza fatti e la sola informativa, Romano Luca e Greco Sofia senza
// niente); ogni test torna indietro. L'orologio è mercoledì 4/11/2026 alle 08:30 di Roma.

const clock = fixedClock("2026-11-04T08:30:00+01:00");

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const params = (p: Partial<PatientListParams> = {}): PatientListParams => ({ ...parsePatientListParams({}), ...p });

/** Un paziente dal mini modulo; un minore porta il genitore. */
async function patient(tx: Tx, firstName: string, lastName: string, birthDate = "1980-05-05", minor = false): Promise<string> {
  const guardian = minor ? { guardian: { firstName: "Elena", lastName } } : {};
  return (await createPatient(tx, PRACTICE_A, clock, { firstName, lastName, birthDate, ...guardian })).id;
}

interface CycleOpts {
  kind?: "trattamento" | "mantenimento";
  openedOn?: string;
  expected?: number | null;
  title?: string;
}

async function cycle(tx: Tx, patientId: string, o: CycleOpts = {}): Promise<string> {
  const kind = o.kind ?? "trattamento";
  const [row] = await tx.query<{ id: string }>(
    `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      PRACTICE_A,
      patientId,
      kind,
      o.openedOn ?? "2026-08-01",
      o.title ?? "Lombalgia, agosto 2026",
      o.expected === undefined ? (kind === "trattamento" ? 4 : null) : o.expected,
    ],
  );
  if (!row) throw new Error("ciclo non creato");
  return row.id;
}

async function closeCycle(tx: Tx, cycleId: string, closedOn: string): Promise<void> {
  await tx.query(
    `update public.treatment_cycles set status = 'closed', closed_on = $2, outcome = 'raggiunto'
      where practice_id = $1 and id = $3`,
    [PRACTICE_A, closedOn, cycleId],
  );
}

type Status = "prenotato" | "confermato" | "fatto" | "saltato" | "annullato";

async function appointment(tx: Tx, patientId: string, cycleId: string, startsAt: string, status: Status): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status, cancel_reason)
     values ($1, $2, $3, $4, $5, 45, 6000, $6, case when $6 = 'annullato' then 'paziente' end)
     returning id`,
    [PRACTICE_A, patientId, SERVICE_A, cycleId, startsAt, status],
  );
  if (!row) throw new Error("appuntamento non creato");
  return row.id;
}

async function informativa(tx: Tx, patientId: string, signedOn = "2026-10-15"): Promise<string> {
  return (
    await writeConsentTemporary(tx, PRACTICE_A, {
      patientId,
      moduleKey: "informativa",
      cycleId: null,
      signedOn,
      signerKind: "paziente",
      signerName: "Prova",
      guardianId: null,
      method: "tela",
    })
  ).id;
}

async function treatment(tx: Tx, patientId: string, cycleId: string, minor = false, signedOn = "2026-10-15"): Promise<string> {
  return (
    await writeConsentTemporary(tx, PRACTICE_A, {
      patientId,
      moduleKey: minor ? "trattamento_minore" : "trattamento",
      cycleId,
      signedOn,
      signerKind: minor ? "genitore" : "paziente",
      signerName: "Prova",
      guardianId: null,
      method: "pdf_caricato",
    })
  ).id;
}

async function revoke(tx: Tx, consentId: string, on: string): Promise<void> {
  await tx.query(
    `update public.consent_records set status = 'revocato', revoked_on = $3, revocation_mode = 'verbale'
      where practice_id = $1 and id = $2`,
    [PRACTICE_A, consentId, on],
  );
}

async function setRecall(tx: Tx, patientId: string, weeks: number | null, paused = false): Promise<void> {
  await tx.query(
    "update public.patients set recall_interval_weeks = $3, recall_paused = $4 where practice_id = $1 and id = $2",
    [PRACTICE_A, patientId, weeks, paused],
  );
}

const names = (list: PatientList): string[] => list.rows.map((r) => r.name);
const rowOf = (list: PatientList, name: string) => {
  const row = list.rows.find((r) => r.name === name);
  if (!row) throw new Error(`${name} non è nella lista`);
  return row;
};

/**
 * Accanto alle fixture: Rossi Mario (trattamento aperto, 1 fatto su 4, un futuro, consensi validi),
 * Rossetti Lia (solo un mantenimento aperto, un futuro, nessun consenso), Bianchi Carla (ciclo chiuso il
 * 12/08, fatto 3 mesi fa, richiamo sospeso), Verdi Paola (ciclo chiuso, fatto 10 settimane fa, cadenza 8
 * settimane, consenso ai richiami) e Rossini Ugo archiviato.
 */
async function listData(tx: Tx) {
  const rossi = await patient(tx, "Mario", "Rossi");
  const rossiCycle = await cycle(tx, rossi, { openedOn: "2026-10-01" });
  await appointment(tx, rossi, rossiCycle, "2026-10-20T08:00:00Z", "fatto");
  await appointment(tx, rossi, rossiCycle, "2026-11-10T08:00:00Z", "prenotato");
  await informativa(tx, rossi);
  await treatment(tx, rossi, rossiCycle);

  const rossetti = await patient(tx, "Lia", "Rossetti");
  const rossettiCycle = await cycle(tx, rossetti, { kind: "mantenimento", openedOn: "2026-10-01" });
  await appointment(tx, rossetti, rossettiCycle, "2026-11-06T08:00:00Z", "confermato");

  const bianchi = await patient(tx, "Carla", "Bianchi");
  const bianchiCycle = await cycle(tx, bianchi, { openedOn: "2026-07-01" });
  await appointment(tx, bianchi, bianchiCycle, "2026-08-01T07:00:00Z", "fatto");
  await closeCycle(tx, bianchiCycle, "2026-08-12");
  await setRecall(tx, bianchi, 8, true);

  const verdi = await patient(tx, "Paola", "Verdi");
  const verdiCycle = await cycle(tx, verdi, { openedOn: "2026-08-01" });
  await appointment(tx, verdi, verdiCycle, "2026-08-26T07:00:00Z", "fatto");
  await closeCycle(tx, verdiCycle, "2026-08-26");
  await setRecall(tx, verdi, 8);
  const verdiInformativa = await informativa(tx, verdi, "2026-08-01");
  await writeChoiceTemporary(tx, PRACTICE_A, {
    patientId: verdi,
    consentRecordId: verdiInformativa,
    choice: "richiami",
    value: true,
    decidedOn: "2026-08-01",
    mode: "modulo",
  });

  const rossini = await patient(tx, "Ugo", "Rossini");
  await tx.query("update public.patients set archived_at = '2026-11-01T08:00:00Z' where practice_id = $1 and id = $2", [
    PRACTICE_A,
    rossini,
  ]);
  return { rossi, rossetti, bianchi, verdi, rossini };
}

const ALL_FILTERS: readonly PatientFilter[] = [
  "tutti",
  "in_ciclo",
  "da_richiamare",
  "consensi_mancanti",
  "senza_prossimo_passo",
  "archiviati",
];

describe("listPatients", () => {
  it("in ordine di cognome, senza gli archiviati, con i conteggi dei sei filtri", async () => {
    const out = await inUserA(db, async (tx) => {
      await listData(tx);
      const byFilter = {} as Record<PatientFilter, string[]>;
      for (const filtro of ALL_FILTERS) byFilter[filtro] = names(await listPatients(tx, PRACTICE_A, clock, params({ filtro })));
      return { list: await listPatients(tx, PRACTICE_A, clock, params()), byFilter };
    });
    expect(names(out.list)).toEqual([
      "Bianchi Carla",
      "Ferrari Giulia",
      "Greco Sofia",
      "Romano Luca",
      "Rossetti Lia",
      "Rossi Mario",
      "Verdi Paola",
    ]);
    expect(out.list.counts).toEqual({
      tutti: 7,
      in_ciclo: 2,
      da_richiamare: 1,
      consensi_mancanti: 2,
      senza_prossimo_passo: 1,
      archiviati: 1,
    });
    // Il conteggio di ogni filtro è il numero delle sue righe.
    for (const filtro of ALL_FILTERS) expect(out.byFilter[filtro].length, filtro).toBe(out.list.counts[filtro]);
    // "In ciclo": il trattamento aperto sì, il solo mantenimento aperto no.
    expect(out.byFilter.in_ciclo).toEqual(["Ferrari Giulia", "Rossi Mario"]);
    expect(out.byFilter.da_richiamare).toEqual(["Verdi Paola"]);
    expect(out.byFilter.consensi_mancanti).toEqual(["Ferrari Giulia", "Rossetti Lia"]);
    expect(out.byFilter.senza_prossimo_passo).toEqual(["Bianchi Carla"]);
    expect(out.byFilter.archiviati).toEqual(["Rossini Ugo"]);
  });

  it("la ricerca dalla prima lettera filtra righe e conteggi; una lettera accentata non rompe", async () => {
    const out = await inUserA(db, async (tx) => {
      await listData(tx);
      return {
        ross: await listPatients(tx, PRACTICE_A, clock, params({ q: "ross" })),
        rossArchived: await listPatients(tx, PRACTICE_A, clock, params({ q: "ROSS", filtro: "archiviati" })),
        r: await listPatients(tx, PRACTICE_A, clock, params({ q: "v" })),
        accent: await listPatients(tx, PRACTICE_A, clock, params({ q: "ò" })),
        o: await listPatients(tx, PRACTICE_A, clock, params({ q: "o" })),
        percent: await listPatients(tx, PRACTICE_A, clock, params({ q: "%" })),
        full: await listPatients(tx, PRACTICE_A, clock, params({ q: "rossi mario" })),
        reversed: await listPatients(tx, PRACTICE_A, clock, params({ q: "mario rossi" })),
      };
    });
    expect(names(out.ross)).toEqual(["Rossetti Lia", "Rossi Mario"]);
    expect(out.ross.counts).toEqual({
      tutti: 2,
      in_ciclo: 1,
      da_richiamare: 0,
      consensi_mancanti: 1,
      senza_prossimo_passo: 0,
      archiviati: 1,
    });
    expect(names(out.rossArchived)).toEqual(["Rossini Ugo"]);
    expect(names(out.r)).toEqual(["Verdi Paola"]);
    expect(names(out.accent)).toEqual(names(out.o));
    expect(out.percent.rows).toEqual([]);
    expect(names(out.full)).toEqual(["Rossi Mario"]);
    expect(names(out.reversed)).toEqual(["Rossi Mario"]);
  });

  it("cerca il telefono per cifre dalla terza", async () => {
    const out = await inUserA(db, async (tx) => {
      const id = await patient(tx, "Nora", "Telefono");
      await tx.query("update public.patients set phone = '+393330000077' where practice_id = $1 and id = $2", [PRACTICE_A, id]);
      return {
        digits: names(await listPatients(tx, PRACTICE_A, clock, params({ q: "333 000" }))),
        two: names(await listPatients(tx, PRACTICE_A, clock, params({ q: "33" }))),
        row: rowOf(await listPatients(tx, PRACTICE_A, clock, params()), "Telefono Nora"),
      };
    });
    expect(out.digits).toEqual(["Telefono Nora"]);
    expect(out.two).toEqual([]);
    expect(out.row.phoneText).toBe("+39 333 000 0077");
  });

  it("ordina per prossimo appuntamento con i vuoti in fondo, e per cognome decrescente", async () => {
    const out = await inUserA(db, async (tx) => {
      await listData(tx);
      return {
        asc: await listPatients(tx, PRACTICE_A, clock, params({ ordina: "prossimo" })),
        desc: await listPatients(tx, PRACTICE_A, clock, params({ ordina: "prossimo", verso: "desc" })),
        byNameDesc: await listPatients(tx, PRACTICE_A, clock, params({ verso: "desc" })),
      };
    });
    expect(names(out.asc).slice(0, 2)).toEqual(["Rossetti Lia", "Rossi Mario"]);
    expect(out.asc.rows.slice(2).every((r) => r.nextAt === null)).toBe(true);
    expect(names(out.desc).slice(0, 2)).toEqual(["Rossi Mario", "Rossetti Lia"]);
    expect(out.desc.rows.slice(2).every((r) => r.nextAt === null)).toBe(true);
    expect(names(out.byNameDesc)[0]).toBe("Verdi Paola");
    const rossetti = rowOf(out.asc, "Rossetti Lia");
    expect(rossetti.nextAt).toBe("2026-11-06T09:00");
    expect(rossetti.nextText).toBe("ven 6 nov");
  });

  it("celle: ciclo, consensi, richiamo ed età", async () => {
    const list = await inUserA(db, async (tx) => {
      await listData(tx);
      return listPatients(tx, PRACTICE_A, clock, params());
    });
    expect(rowOf(list, "Rossi Mario")).toMatchObject({
      ageText: "46 anni",
      phoneText: null,
      cycleText: "In corso, seduta 1 di 4",
      consentText: "In regola",
      recallText: "Nessuno",
      nextText: "mar 10 nov",
    });
    expect(rowOf(list, "Ferrari Giulia")).toMatchObject({ cycleText: "In corso", consentText: "Manca 1" });
    expect(rowOf(list, "Rossetti Lia")).toMatchObject({ cycleText: "Mantenimento", consentText: "Manca 2" });
    expect(rowOf(list, "Bianchi Carla")).toMatchObject({ cycleText: "Chiuso il 12/08", recallText: "Sospeso" });
    expect(rowOf(list, "Verdi Paola")).toMatchObject({ recallText: "Scaduto da 14 giorni", consentText: "In regola" });
    expect(rowOf(list, "Romano Luca")).toMatchObject({ cycleText: "Nessuno", consentText: "Manca 1", nextAt: null });
    expect(rowOf(list, "Greco Sofia").ageText).toBe("10 anni");
  });

  it("un consenso al trattamento revocato senza un nuovo valido è Revocato e conta fra i mancanti", async () => {
    const out = await inUserA(db, async (tx) => {
      const id = await patient(tx, "Ada", "Revoca");
      const c = await cycle(tx, id, { openedOn: "2026-10-01" });
      await informativa(tx, id);
      await revoke(tx, await treatment(tx, id, c), "2026-11-01");
      const revoked = await listPatients(tx, PRACTICE_A, clock, params({ filtro: "consensi_mancanti" }));
      await treatment(tx, id, c, false, "2026-11-03");
      const signedAgain = await listPatients(tx, PRACTICE_A, clock, params({ filtro: "consensi_mancanti" }));
      return { revoked, signedAgain, all: await listPatients(tx, PRACTICE_A, clock, params()) };
    });
    expect(rowOf(out.revoked, "Revoca Ada").consentText).toBe("Revocato");
    expect(names(out.signedAgain)).not.toContain("Revoca Ada");
    expect(rowOf(out.all, "Revoca Ada").consentText).toBe("In regola");
  });

  it("richiamo con una cadenza attiva ma senza data: «Ogni N settimane», e nessuna scadenza nel Riepilogo", async () => {
    const out = await inUserA(db, async (tx) => {
      // Un fatto e un futuro: la regola del richiamo non dà una data finché c'è l'appuntamento.
      const booked = await patient(tx, "Bea", "Prenotata");
      const c = await cycle(tx, booked, { openedOn: "2026-08-01" });
      await appointment(tx, booked, c, "2026-08-26T07:00:00Z", "fatto");
      await appointment(tx, booked, c, "2026-11-10T08:00:00Z", "prenotato");
      await setRecall(tx, booked, 8);
      // Una cadenza senza nessun fatto.
      const never = await patient(tx, "Nico", "Maifatto");
      await setRecall(tx, never, 6);
      const list = await listPatients(tx, PRACTICE_A, clock, params());
      return {
        booked: rowOf(list, "Prenotata Bea").recallText,
        never: rowOf(list, "Maifatto Nico").recallText,
        bookedSummary: (await getSummaryTab(tx, PRACTICE_A, clock, booked))?.recall,
        neverSummary: (await getSummaryTab(tx, PRACTICE_A, clock, never))?.recall,
      };
    });
    expect(out.booked).toBe("Ogni 8 settimane");
    expect(out.never).toBe("Ogni 6 settimane");
    expect(out.bookedSummary).toEqual({ weeks: 8, paused: false, dueText: null });
    expect(out.neverSummary).toEqual({ weeks: 6, paused: false, dueText: null });
  });

  it("«Ogni 1 settimana» al singolare", () => {
    const facts: PatientFacts = {
      cycles: [],
      openCycle: null,
      nextAt: null,
      lastDoneAt: null,
      minorAtOpening: false,
      consents: [],
    };
    expect(recallCell({ recallWeeks: 1, recallPaused: false }, facts, "2026-11-04")).toBe("Ogni 1 settimana");
  });

  it("senza prossimo passo: un fatto di 13 mesi fa non basta", async () => {
    const out = await inUserA(db, async (tx) => {
      const id = await patient(tx, "Elio", "Vecchio");
      const c = await cycle(tx, id, { openedOn: "2025-09-01" });
      await appointment(tx, id, c, "2025-10-01T07:00:00Z", "fatto");
      await closeCycle(tx, c, "2025-10-01");
      await setRecall(tx, id, 8, true);
      return names(await listPatients(tx, PRACTICE_A, clock, params({ filtro: "senza_prossimo_passo" })));
    });
    expect(out).not.toContain("Vecchio Elio");
  });
});

describe("getPatientHeader", () => {
  it("etichette: Minore, Lattante, Anagrafica da completare; un paziente di B è null", async () => {
    const out = await inUserA(db, async (tx) => {
      const child = await patient(tx, "Leo", "Bimbo", "2016-05-05", true);
      const infant = await patient(tx, "Ida", "Neonata", "2026-05-05", true);
      const complete = await patient(tx, "Pia", "Completa");
      await tx.query(
        `update public.patients set tax_code = 'CMPPIA80E45A944X', address_line = 'Via degli Esempi 1', postal_code = '40100', city = 'Bologna'
          where practice_id = $1 and id = $2`,
        [PRACTICE_A, complete],
      );
      return {
        child: await getPatientHeader(tx, PRACTICE_A, clock, child),
        infant: await getPatientHeader(tx, PRACTICE_A, clock, infant),
        complete: await getPatientHeader(tx, PRACTICE_A, clock, complete),
        other: await getPatientHeader(tx, PRACTICE_A, clock, PATIENT_B1),
      };
    });
    expect(out.child?.labels).toEqual(["Nessuno", "Manca 1", "Minore", "Anagrafica da completare"]);
    expect(out.child?.ageText).toBe("10 anni");
    expect(out.infant?.labels).toContain("Lattante");
    expect(out.infant?.labels).not.toContain("Minore");
    expect(out.infant?.ageText).toBe("5 mesi");
    expect(out.complete?.labels).toEqual(["Nessuno", "Manca 1"]);
    expect(out.complete).toMatchObject({
      name: "Pia Completa",
      archived: false,
      canDelete: true,
      archiveBlock: null,
      openCycleId: null,
      hasAnyCycle: false,
      badges: [],
      referralText: null,
      screeningText: null,
      screeningSeverity: null,
      clinicalAlert: null,
    });
    expect(out.other).toBeNull();
  });

  it("badge TAO e gravidanza, rinvio consegnato, avviso clinico, due futuri che bloccano l'archivio", async () => {
    const out = await inUserA(db, async (tx) => {
      const id = await patient(tx, "Rita", "Rischio");
      await tx.query(
        "update public.patients set clinical_alert = 'Terapia anticoagulante (warfarin)', phone = '+393200000004' where practice_id = $1 and id = $2",
        [PRACTICE_A, id],
      );
      await tx.query(
        `insert into public.patient_history_items (practice_id, patient_id, kind, label, risk_tags)
         values ($1, $2, 'farmaco', 'Warfarin 5 mg', '{anticoagulante_tao}')`,
        [PRACTICE_A, id],
      );
      await tx.query(
        `insert into public.patient_lifestyle (practice_id, patient_id, pregnancy_status, pregnancy_weeks)
         values ($1, $2, 'in_corso', 12)`,
        [PRACTICE_A, id],
      );
      const c = await cycle(tx, id, { openedOn: "2026-09-01" });
      await appointment(tx, id, c, "2026-11-10T08:00:00Z", "prenotato");
      await appointment(tx, id, c, "2026-11-04T07:00:00Z", "confermato"); // oggi alle 08:00, già passato
      const referral = (on: string, status: string, delivered: string | null) =>
        tx.query(
          `insert into public.referrals (practice_id, patient_id, cycle_id, created_on, recipient_kind, reason, urgency,
                                         summary_text, request_text, patient_agreed_to_share, status, delivered_on)
           values ($1, $2, $3, $4, 'medico_curante', 'sintomi_persistenti', 'programmato', 'Sintesi', 'Richiesta', true, $5, $6)`,
          [PRACTICE_A, id, c, on, status, delivered],
        );
      await referral("2026-09-20", "consegnata_al_paziente", "2026-10-01");
      await referral("2026-10-20", "bozza", null); // una bozza non conta
      return getPatientHeader(tx, PRACTICE_A, clock, id);
    });
    expect(out).toMatchObject({
      phone: "+393200000004",
      phoneText: "+39 320 000 0004",
      clinicalAlert: "Terapia anticoagulante (warfarin)",
      badges: ["TAO", "Gravidanza in corso"],
      referralText: "Rinviato al medico il 01/10",
      archiveBlock: "Prima annulla i 2 appuntamenti futuri.",
      canDelete: false,
      hasAnyCycle: true,
    });
    expect(out?.openCycleId).toEqual(expect.any(String));
  });

  it("riassunto dello screening dalla visita più recente con esiti salvati", async () => {
    const out = await inUserA(db, async (tx) => {
      const id = await patient(tx, "Sara", "Screening");
      const c = await cycle(tx, id, { openedOn: "2026-10-01" });
      const none = await getPatientHeader(tx, PRACTICE_A, clock, id);

      const visit = async (startsAt: string, day: string): Promise<string> => {
        const appointmentId = await appointment(tx, id, c, startsAt, "fatto");
        const [row] = await tx.query<{ id: string }>(
          `insert into public.visits (practice_id, patient_id, cycle_id, appointment_id, visit_date, kind, screening_catalog_version)
           values ($1, $2, $3, $4, $5, 'seduta', 1) returning id`,
          [PRACTICE_A, id, c, appointmentId, day],
        );
        if (!row) throw new Error("visita non creata");
        return row.id;
      };
      const outcomes = (visitId: string, thrust: string, direct: string, indirect: string) =>
        tx.query(
          `insert into public.visit_screening_outcomes (practice_id, visit_id, family, suggested, outcome)
           values ($1, $2, 'thrust', $3, $3), ($1, $2, 'direct', $4, $4), ($1, $2, 'indirect', $5, $5)`,
          [PRACTICE_A, visitId, thrust, direct, indirect],
        );

      const older = await visit("2026-10-10T07:00:00Z", "2026-10-10");
      await tx.query(
        `insert into public.visit_screening_answers (practice_id, visit_id, item_code, answer) values ($1, $2, 'ci_avk', 'si')`,
        [PRACTICE_A, older],
      );
      await outcomes(older, "contraindicated", "caution", "indicated");
      // Una visita più recente senza esiti salvati non conta.
      await visit("2026-10-20T07:00:00Z", "2026-10-20");
      const avk = await getPatientHeader(tx, PRACTICE_A, clock, id);

      const latest = await visit("2026-10-27T07:00:00Z", "2026-10-27");
      await outcomes(latest, "indicated", "indicated", "indicated");
      const indicated = await getPatientHeader(tx, PRACTICE_A, clock, id);

      // Cautela scelta senza una voce che la porti: il motivo è l'esito stesso.
      const draft = await visit("2026-11-03T07:00:00Z", "2026-11-03");
      await outcomes(draft, "indicated", "caution", "indicated");
      const caution = await getPatientHeader(tx, PRACTICE_A, clock, id);
      return { none, avk, indicated, caution };
    });
    expect(out.none?.screeningText).toBeNull();
    expect(out.avk?.screeningText).toBe("Controindicato: terapia anticoagulante");
    expect(out.indicated?.screeningText).toBeNull();
    expect(out.caution?.screeningText).toBe("Con cautela: esito dello screening");
    expect(out.none?.screeningSeverity).toBeNull();
    expect(out.avk?.screeningSeverity).toBe("contraindicated");
    expect(out.indicated?.screeningSeverity).toBeNull();
    expect(out.caution?.screeningSeverity).toBe("caution");
  });

  it("«Maggiorenne dal 03/11/2026» con il ciclo aperto da minore; il consenso del genitore vale per quel ciclo", async () => {
    const out = await inUserA(db, async (tx) => {
      const id = await patient(tx, "Nina", "Diciotto", "2008-11-03");
      const c = await cycle(tx, id, { openedOn: "2026-10-20" });
      await appointment(tx, id, c, "2026-11-10T08:00:00Z", "prenotato");
      await informativa(tx, id);
      await treatment(tx, id, c, true);
      const minorCycle = {
        header: await getPatientHeader(tx, PRACTICE_A, clock, id),
        missing: names(await listPatients(tx, PRACTICE_A, clock, params({ filtro: "consensi_mancanti" }))),
        row: rowOf(await listPatients(tx, PRACTICE_A, clock, params()), "Diciotto Nina"),
      };
      await tx.query("update public.treatment_cycles set opened_on = '2026-11-04' where practice_id = $1 and id = $2", [
        PRACTICE_A,
        c,
      ]);
      return { minorCycle, adultCycle: await getPatientHeader(tx, PRACTICE_A, clock, id) };
    });
    expect(out.minorCycle.header?.labels).toContain("Maggiorenne dal 03/11/2026");
    expect(out.minorCycle.header?.labels).not.toContain("Minore");
    expect(out.minorCycle.row.consentText).toBe("In regola");
    expect(out.minorCycle.missing).not.toContain("Diciotto Nina");
    expect(out.adultCycle?.labels.some((l) => l.startsWith("Maggiorenne"))).toBe(false);
    // Aperto da adulta, il ciclo vuole il consenso al trattamento della paziente.
    expect(out.adultCycle?.labels).toContain("Manca 1");
  });
});

describe("listPatientAppointments", () => {
  it("futuri crescenti, passati decrescenti, saltati attenuati, link alla visita e contatori", async () => {
    const out = await inUserA(db, async (tx) => {
      const id = await patient(tx, "Gino", "Agenda");
      const c = await cycle(tx, id, { openedOn: "2026-10-01" });
      await appointment(tx, id, c, "2026-11-10T08:00:00Z", "confermato");
      await appointment(tx, id, c, "2026-11-06T08:00:00Z", "prenotato");
      const done = await appointment(tx, id, c, "2026-10-20T08:00:00Z", "fatto");
      await appointment(tx, id, c, "2026-10-27T08:00:00Z", "fatto");
      await appointment(tx, id, c, "2026-10-13T07:00:00Z", "saltato");
      const [visit] = await tx.query<{ id: string }>(
        `insert into public.visits (practice_id, patient_id, cycle_id, appointment_id, visit_date, kind, screening_catalog_version)
         values ($1, $2, $3, $4, '2026-10-20', 'seduta', 1) returning id`,
        [PRACTICE_A, id, c, done],
      );
      return { tab: await listPatientAppointments(tx, PRACTICE_A, clock, id), visitId: visit?.id };
    });
    expect(out.tab.future.map((a) => a.dayText)).toEqual(["ven 6 nov", "mar 10 nov"]);
    expect(out.tab.past.map((a) => a.dayText)).toEqual(["mar 27 ott", "mar 20 ott", "mar 13 ott"]);
    expect(out.tab.countsText).toBe("2 fatti, 1 saltato, 0 annullati");
    expect(out.tab.future[0]).toMatchObject({
      at: "2026-11-06T09:00",
      timeText: "09:00",
      serviceName: "Seduta osteopatica",
      status: "prenotato",
      statusLabel: "Prenotato",
      muted: false,
      visit: null,
    });
    expect(out.tab.past[1]).toMatchObject({ status: "fatto", statusLabel: "Fatto", visit: { id: out.visitId, status: "draft" } });
    expect(out.tab.past[2]).toMatchObject({ status: "saltato", statusLabel: "Saltato", muted: true });
  });

  it("il link alla fattura: solo sulla riga fatturata, mai per una bozza", async () => {
    const out = await inUserA(db, async (tx) => {
      const id = await patient(tx, "Ivo", "Fattura");
      const c = await cycle(tx, id, { openedOn: "2026-10-01" });
      const invoiced = await appointment(tx, id, c, "2026-10-20T08:00:00Z", "fatto");
      const drafted = await appointment(tx, id, c, "2026-10-27T08:00:00Z", "fatto");
      const line = (invoiceId: string, appointmentId: string) =>
        insertRow(tx, "invoice_lines", {
          practice_id: PRACTICE_A,
          invoice_id: invoiceId,
          line_number: 1,
          line_kind: "prestazione",
          appointment_id: appointmentId,
          description: "Seduta di osteopatia",
          quantity: 1,
          unit_price_cents: 6000,
          line_total_cents: 6000,
          vat_rate_bp: 0,
          nature: "N2.2",
        });
      const invoiceId = idOf(await insertRow(tx, "invoices", invoiceDraft({ patient_id: id })));
      await line(invoiceId, invoiced);
      const number = await issueInvoice(tx, { invoiceId, issueDate: "2026-10-20" });
      const draftId = idOf(await insertRow(tx, "invoices", invoiceDraft({ patient_id: id })));
      await line(draftId, drafted);
      return { tab: await listPatientAppointments(tx, PRACTICE_A, clock, id), invoiceId, number };
    });
    // Passati dal più recente: la seduta in bozza, poi quella fatturata.
    expect(out.tab.past.map((a) => a.invoice)).toEqual([null, { id: out.invoiceId, numberLabel: `${out.number}/2026` }]);
  });
});

describe("getSummaryTab, listPatientConsents e getRegistry", () => {
  it("prossimo appuntamento, ciclo aperto con dolore, richiamo e consensi", async () => {
    const out = await inUserA(db, async (tx) => {
      const id = await patient(tx, "Ugo", "Sommario");
      const empty = await getSummaryTab(tx, PRACTICE_A, clock, id);
      const c = await cycle(tx, id, { openedOn: "2026-10-01", title: "Lombalgia, ottobre 2026" });
      await tx.query("update public.treatment_cycles set goal = 'Tornare a correre' where practice_id = $1 and id = $2", [
        PRACTICE_A,
        c,
      ]);
      const done = await appointment(tx, id, c, "2026-10-20T08:00:00Z", "fatto");
      await appointment(tx, id, c, "2026-11-10T08:00:00Z", "prenotato");
      await tx.query(
        `insert into public.visits (practice_id, patient_id, cycle_id, appointment_id, visit_date, kind, screening_catalog_version, nprs_pre)
         values ($1, $2, $3, $4, '2026-10-20', 'prima_visita', 1, 6)`,
        [PRACTICE_A, id, c, done],
      );
      await setRecall(tx, id, 6);
      await informativa(tx, id, "2026-10-20");
      await revoke(tx, await treatment(tx, id, c, false, "2026-10-20"), "2026-11-01");
      return {
        empty,
        tab: await getSummaryTab(tx, PRACTICE_A, clock, id),
        consents: await listPatientConsents(tx, PRACTICE_A, id),
      };
    });
    expect(out.empty).toMatchObject({
      next: null,
      cycle: null,
      recall: { weeks: null, paused: false, dueText: null },
      consents: [{ label: "Informativa", state: "Manca" }],
    });
    expect(out.tab).toMatchObject({
      next: { at: "2026-11-10T09:00", text: "mar 10 nov alle 09:00" },
      cycle: { title: "Lombalgia, ottobre 2026", goal: "Tornare a correre", doneText: "1 di 4 sedute fatte", pain: [6] },
      // Con un futuro il richiamo non ha data.
      recall: { weeks: 6, paused: false, dueText: null },
      consents: [
        { label: "Informativa", state: "Firmato il 20/10/2026" },
        { label: "Consenso al trattamento", state: "Revocato il 01/11/2026" },
      ],
      gp: null,
      referring: null,
    });
    // Le righe hanno anche id, metodo, documento e azioni (consent-surfaces.test.ts).
    expect(out.consents).toMatchObject([
      { moduleLabel: "Informativa", cycleTitle: null, signedOnText: "20/10/2026", statusLabel: "Valido" },
      {
        moduleLabel: "Consenso al trattamento",
        cycleTitle: "Lombalgia, ottobre 2026",
        signedOnText: "20/10/2026",
        statusLabel: "Revocato il 01/11/2026",
      },
    ]);
    expect(out.consents).toHaveLength(2);
  });

  it("l'anagrafica con i vuoti come testo vuoto e i genitori", async () => {
    const out = await inUserA(db, async (tx) => ({
      greco: await getRegistry(tx, PRACTICE_A, PATIENT_A3),
      ferrari: await getRegistry(tx, PRACTICE_A, PATIENT_A1),
      other: await getRegistry(tx, PRACTICE_A, PATIENT_B1),
    }));
    expect(out.greco).toMatchObject({
      patientId: PATIENT_A3,
      personali: { firstName: "Sofia", lastName: "Greco", birthDate: "2016-02-14", sex: "nd", birthPlace: "", taxCode: "" },
      contatti: { phone: "", email: "", preferredChannel: "whatsapp", addressing: "tu" },
      indirizzo: { addressLine: "", postalCode: "", city: "", province: "", country: "IT" },
      medici: { gpPhysicianId: "", defaultReferringPhysicianId: "" },
      note: { adminNotes: "" },
    });
    expect(out.greco?.guardians).toEqual([
      expect.objectContaining({
        id: GUARDIAN_A,
        relationship: "madre",
        firstName: "Laura",
        lastName: "Greco",
        taxCode: "",
        isContact: true,
        isPayer: true,
        hasParentalAuthority: true,
      }),
    ]);
    expect(out.ferrari?.medici.gpPhysicianId).not.toBe("");
    expect(out.ferrari?.guardians).toEqual([]);
    expect(out.other).toBeNull();
  });
});

describe("come uB sui dati di A", () => {
  it("liste vuote e null", async () => {
    const out = await asUserB(db, async (tx) => ({
      list: await listPatients(tx, PRACTICE_A, clock, params()),
      header: await getPatientHeader(tx, PRACTICE_A, clock, PATIENT_A1),
      summary: await getSummaryTab(tx, PRACTICE_A, clock, PATIENT_A1),
      appointments: await listPatientAppointments(tx, PRACTICE_A, clock, PATIENT_A1),
      consents: await listPatientConsents(tx, PRACTICE_A, PATIENT_A1),
      registry: await getRegistry(tx, PRACTICE_A, PATIENT_A1),
    }));
    expect(out.list.rows).toEqual([]);
    expect(Object.values(out.list.counts)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(out.header).toBeNull();
    expect(out.summary).toBeNull();
    expect(out.appointments).toEqual({ future: [], past: [], countsText: "0 fatti, 0 saltati, 0 annullati" });
    expect(out.consents).toEqual([]);
    expect(out.registry).toBeNull();
  });
});
