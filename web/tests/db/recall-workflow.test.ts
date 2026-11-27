import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Clock, fixedClock, romeDateTime } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { createAppointment, markDone } from "@/server/domain/appointments/commands";
import { getOpenCycle } from "@/server/domain/cycles/queries";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { recordMessage, setMessageOutcome } from "@/server/domain/messages/commands";
import { prepareMessage } from "@/server/domain/messages/queries";
import { getSummaryTab } from "@/server/domain/patients/card";
import { createPatient, setRecall } from "@/server/domain/patients/commands";
import { listPatients } from "@/server/domain/patients/list";
import { listRecalls, listTodayRecalls, type RecallBlock, TODAY_RECALL_ROWS } from "@/server/domain/patients/queries";
import { recallWeeksOf, snoozeRecall } from "@/server/domain/patients/recall-commands";
import { closeVisit, editVisit, startVisit } from "@/server/domain/visits/commands";
import { writeChoiceTemporary, writeConsentTemporary } from "../support/consent-rows";
import { FILE_A, PRACTICE_A, SERVICE_A, sha256Hex } from "./fixtures";
import { asServiceFor, asUserA, asUserB, inUserA, openTestDb } from "./helpers";

// Il catalogo dei moduli con l'informativa «2025.1» non più valida: il test `canali_batch_versionati` la usa
// per provare che `listRecalls` legge i canali con la stessa regola di versione di `getChannelConsents`.
vi.mock("@/lib/consents/modules", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/consents/modules")>();
  return {
    ...original,
    isCurrentVersion: (key: Parameters<typeof original.isCurrentVersion>[0], version: string) =>
      !(key === "informativa" && version === "2025.1") && original.isCurrentVersion(key, version),
  };
});

// `prepareMessage` contato: la lista dei pazienti non prepara un messaggio per riga, Oggi al massimo 5.
vi.mock("@/server/domain/messages/queries", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/domain/messages/queries")>();
  return { ...original, prepareMessage: vi.fn(original.prepareMessage) };
});

// Richiami: data clinica calcolata, rinvio che nasconde la
// riga fino al suo giorno, sospensione che conserva la cadenza, attesa di 14 giorni dopo un richiamo dichiarato
// inviato e gruppo senza consenso con la sua ragione. I pazienti nascono come uA con i comandi dell'app e lo
// scrittore provvisorio dei consensi del seed; ogni test torna indietro, salvo quello di uB che scrive davvero.
// L'orologio è giovedì 22/10/2026 alle 08:30 di Roma, salvo dove scritto.

const D0 = fixedClock("2026-10-22T08:30:00+02:00");
const TODAY = "2026-10-22";
const at = (day: string, time = "08:30"): Clock => fixedClock(romeDateTime(day, time));

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

async function expectNotAllowed(p: Promise<unknown>): Promise<void> {
  const error = await p.then(
    () => expect.fail("atteso un rifiuto"),
    (e: unknown) => e,
  );
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(NOT_ALLOWED);
}

async function adult(tx: Tx, firstName: string, lastName: string): Promise<string> {
  return (await createPatient(tx, PRACTICE_A, D0, { firstName, lastName, birthDate: "1979-03-09" })).id;
}

/** Prenota nel ciclo aperto del paziente, o in uno nuovo; seduta da 45 minuti. */
async function book(
  tx: Tx,
  patientId: string,
  day: string,
  time: string,
  status: "prenotato" | "confermato" | "fatto" = "prenotato",
  clock: Clock = D0,
): Promise<string> {
  const open = await getOpenCycle(tx, PRACTICE_A, patientId);
  const created = await createAppointment(tx, PRACTICE_A, clock, {
    patient: { kind: "existing", patientId },
    serviceId: SERVICE_A,
    day,
    time,
    durationMin: 45,
    cycle: open ? { kind: "existing", cycleId: open.id } : { kind: "new" },
    priceCents: 6000,
    status,
  });
  const [first] = created.appointments;
  if (!first) throw new Error("nessun appuntamento creato");
  return first.id;
}

/**
 * L'informativa firmata sulla tela il 10/08 (del genitore di contatto per un minore). Con `version` è una riga
 * scritta a mano di quella versione: un consenso firmato non si modifica, neanche la versione.
 */
async function informativa(tx: Tx, patientId: string, version?: string): Promise<string> {
  if (version !== undefined) {
    const text = "Informativa di prova di una versione passata.";
    const [row] = await tx.query<{ id: string }>(
      `insert into public.consent_records (practice_id, patient_id, module_key, module_version, rendered_text, rendered_hash,
                                           signer_kind, signer_name, method, signature_file_id, signed_on)
       values ($1, $2, 'informativa', $3, $4, $5, 'paziente', 'Paziente di prova', 'tela', $6, '2026-08-10') returning id`,
      [PRACTICE_A, patientId, version, text, sha256Hex(text), FILE_A],
    );
    if (!row) throw new Error("informativa non scritta");
    return row.id;
  }
  const [guardian] = await tx.query<{ id: string; name: string }>(
    "select id, first_name || ' ' || last_name as name from public.patient_guardians where patient_id = $1 and is_contact",
    [patientId],
  );
  const { id } = await writeConsentTemporary(tx, PRACTICE_A, {
    patientId,
    moduleKey: "informativa",
    cycleId: null,
    signedOn: "2026-08-10",
    signerKind: guardian ? "genitore" : "paziente",
    signerName: guardian?.name ?? "Paziente di prova",
    guardianId: guardian?.id ?? null,
    method: "tela",
  });
  return id;
}

/** Un paziente con un fatto il giorno dato alle 09:00, la cadenza e, se `consent`, il sì ai richiami dell'informativa. */
async function recallPatient(
  tx: Tx,
  name: [string, string],
  lastDone: string,
  opts: { weeks?: number; consent?: boolean } = {},
): Promise<string> {
  const id = await adult(tx, ...name);
  await book(tx, id, lastDone, "09:00", "fatto");
  await setRecall(tx, PRACTICE_A, D0, { patientId: id, weeks: opts.weeks ?? 8, paused: false });
  if (opts.consent ?? true) {
    const record = await informativa(tx, id);
    await writeChoiceTemporary(tx, PRACTICE_A, {
      patientId: id,
      consentRecordId: record,
      choice: "richiami",
      value: true,
      decidedOn: "2026-08-10",
      mode: "modulo",
    });
  }
  return id;
}

const snoozedUntil = async (tx: Tx, id: string): Promise<string | null> =>
  (await tx.query<{ d: string | null }>("select recall_snoozed_until as d from public.patients where id = $1", [id]))[0]?.d ?? null;

const names = (block: RecallBlock) => ({
  rows: block.rows.map((r) => r.name),
  withoutConsent: block.withoutConsent.map((r) => r.name),
});

const LIST = { q: "", filtro: "tutti", ordina: "paziente", verso: "asc" } as const;

async function recallTextOf(tx: Tx, clock: Clock, lastName: string): Promise<string | undefined> {
  const list = await listPatients(tx, PRACTICE_A, clock, { ...LIST, q: lastName });
  return list.rows[0]?.recallText;
}

describe("rinvia: «Rimanda di 2 settimane»", () => {
  it("scrive oggi + 14, non si accumula, nasconde la riga fino al 4/11 e la data clinica non cambia", async () => {
    const out = await inUserA(db, async (tx) => {
      const marco = await recallPatient(tx, ["Marco", "Bellandi"], "2026-08-17");
      const before = await listRecalls(tx, PRACTICE_A, D0, 7);
      await snoozeRecall(tx, PRACTICE_A, D0, { patientId: marco });
      const first = await snoozedUntil(tx, marco);
      // Due clic lo stesso giorno, anche la sera: sempre il 5/11.
      await snoozeRecall(tx, PRACTICE_A, D0, { patientId: marco });
      await snoozeRecall(tx, PRACTICE_A, at(TODAY, "18:30"), { patientId: marco });
      return {
        marco,
        before,
        first,
        second: await snoozedUntil(tx, marco),
        today: await listRecalls(tx, PRACTICE_A, D0, 30),
        lastHidden: await listRecalls(tx, PRACTICE_A, at("2026-11-04"), 7),
        back: await listRecalls(tx, PRACTICE_A, at("2026-11-05"), 7),
        cellHidden: await recallTextOf(tx, at("2026-11-04"), "Bellandi"),
        cellBack: await recallTextOf(tx, at("2026-11-05"), "Bellandi"),
        summaryHidden: (await getSummaryTab(tx, PRACTICE_A, at("2026-11-04"), marco))?.recall,
        summaryBack: (await getSummaryTab(tx, PRACTICE_A, at("2026-11-05"), marco))?.recall,
        listHidden: (await listPatients(tx, PRACTICE_A, at("2026-11-04"), { ...LIST, filtro: "da_richiamare" })).counts.da_richiamare,
        listBack: (await listPatients(tx, PRACTICE_A, at("2026-11-05"), { ...LIST, filtro: "da_richiamare" })).counts.da_richiamare,
      };
    });
    expect(out.before.rows.map((r) => [r.name, r.dueDay, r.dueText])).toEqual([["Marco Bellandi", "2026-10-12", "Scaduto da 10 giorni"]]);
    expect(out.first).toBe("2026-11-05");
    expect(out.second).toBe("2026-11-05");
    expect(names(out.today)).toEqual({ rows: [], withoutConsent: [] });
    expect(names(out.lastHidden)).toEqual({ rows: [], withoutConsent: [] });
    // Torna con il ritardo vero, non «Fra 14 giorni».
    expect(out.back.rows.map((r) => [r.patientId, r.dueDay, r.dueText])).toEqual([[out.marco, "2026-10-12", "Scaduto da 24 giorni"]]);
    expect(out.cellHidden).toBe("Ogni 8 settimane");
    expect(out.cellBack).toBe("Scaduto da 24 giorni");
    expect(out.summaryHidden).toEqual({ weeks: 8, paused: false, dueText: null });
    expect(out.summaryBack).toEqual({ weeks: 8, paused: false, dueText: "Scaduto da 24 giorni" });
    expect(out.listHidden).toBe(0);
    expect(out.listBack).toBe(1);
  });

  it("un nuovo fatto e una cadenza diversa azzerano il rinvio; la stessa cadenza e la pausa no", async () => {
    const out = await inUserA(db, async (tx) => {
      const marco = await recallPatient(tx, ["Marco", "Bellandi"], "2026-08-17");
      const snooze = () => snoozeRecall(tx, PRACTICE_A, D0, { patientId: marco });

      await snooze();
      await setRecall(tx, PRACTICE_A, D0, { patientId: marco, weeks: 8, paused: false });
      const sameWeeks = await snoozedUntil(tx, marco);
      await setRecall(tx, PRACTICE_A, D0, { patientId: marco, weeks: 8, paused: true });
      const paused = await snoozedUntil(tx, marco);
      await setRecall(tx, PRACTICE_A, D0, { patientId: marco, weeks: 6, paused: false });
      const otherWeeks = await snoozedUntil(tx, marco);

      // «Segna come fatta» su un appuntamento di stamattina.
      await snooze();
      const morning = await book(tx, marco, TODAY, "08:00");
      await markDone(tx, PRACTICE_A, D0, { id: morning });
      const markedDone = await snoozedUntil(tx, marco);

      // Un appuntamento che nasce fatto.
      await snooze();
      await book(tx, marco, "2026-10-21", "09:00", "fatto");
      const bornDone = await snoozedUntil(tx, marco);
      return { sameWeeks, paused, otherWeeks, markedDone, bornDone };
    });
    expect(out).toEqual({
      sameWeeks: "2026-11-05",
      paused: "2026-11-05",
      otherWeeks: null,
      markedDone: null,
      bornDone: null,
    });
  });

  it("la chiusura della visita con alsoMarkDone azzera il rinvio", async () => {
    const out = await inUserA(db, async (tx) => {
      const giorgio = await recallPatient(tx, ["Giorgio", "Sala"], "2026-08-17");
      // Il ciclo di trattamento del primo fatto è chiuso; il controllo di oggi è in un mantenimento.
      await tx.query("update public.treatment_cycles set status = 'closed', closed_on = '2026-08-17', outcome = 'raggiunto' where patient_id = $1", [giorgio]);
      const [cycle] = await tx.query<{ id: string }>(
        `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title)
         values ($1, $2, 'mantenimento', '2026-10-22', 'Mantenimento') returning id`,
        [PRACTICE_A, giorgio],
      );
      if (!cycle) throw new Error("ciclo non creato");
      const [appointment] = await tx.query<{ id: string }>(
        `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status)
         values ($1, $2, $3, $4, $5, 45, 6000, 'confermato') returning id`,
        [PRACTICE_A, giorgio, SERVICE_A, cycle.id, romeDateTime(TODAY, "08:00")],
      );
      if (!appointment) throw new Error("appuntamento non creato");
      const { visitId } = await startVisit(tx, PRACTICE_A, D0, { appointmentId: appointment.id });
      for (const group of ["ci_sistemica", "ci_locale", "rf_rachide"]) {
        await editVisit(tx, PRACTICE_A, D0, { visitId, op: { op: "nessun_altra_voce", group } });
      }
      await editVisit(tx, PRACTICE_A, D0, {
        visitId,
        op: {
          op: "esiti",
          outcomes: ["thrust", "direct", "indirect"].map((family) => ({ family, outcome: "indicated", overrideNote: null })),
        },
      });
      await snoozeRecall(tx, PRACTICE_A, D0, { patientId: giorgio });
      const before = await snoozedUntil(tx, giorgio);
      await closeVisit(tx, PRACTICE_A, D0, { visitId, confirmCopied: false, alsoMarkDone: true });
      return { before, after: await snoozedUntil(tx, giorgio) };
    });
    expect(out).toEqual({ before: "2026-11-05", after: null });
  });
});

describe("pausa: «Sospendi i richiami»", () => {
  it("conserva le settimane e toglie il paziente da tutte e due le liste", async () => {
    const out = await inUserA(db, async (tx) => {
      const marco = await recallPatient(tx, ["Marco", "Bellandi"], "2026-08-17");
      const luca = await recallPatient(tx, ["Luca", "Costa"], "2026-08-24", { consent: false });
      const before = await listRecalls(tx, PRACTICE_A, D0, 7);
      // Come `pauseRecallAction`: le settimane attuali lette nella transazione, poi `setRecall`.
      for (const id of [marco, luca]) {
        const current = await recallWeeksOf(tx, PRACTICE_A, id);
        if (current === null) throw new Error("paziente non trovato");
        await setRecall(tx, PRACTICE_A, D0, { patientId: id, weeks: current.weeks, paused: true });
      }
      const [row] = await tx.query<{ weeks: number; paused: boolean }>(
        "select recall_interval_weeks as weeks, recall_paused as paused from public.patients where id = $1",
        [marco],
      );
      return { before, after: await listRecalls(tx, PRACTICE_A, D0, 30), row };
    });
    expect(names(out.before)).toEqual({ rows: ["Marco Bellandi"], withoutConsent: ["Luca Costa"] });
    expect(names(out.after)).toEqual({ rows: [], withoutConsent: [] });
    expect(out.row).toEqual({ weeks: 8, paused: true });
  });

  it("2 e 52 settimane ammesse, 1 e 53 rifiutate", async () => {
    await inUserA(db, async (tx) => {
      const marco = await adult(tx, "Marco", "Bellandi");
      for (const weeks of [2, 52]) await setRecall(tx, PRACTICE_A, D0, { patientId: marco, weeks, paused: true });
      for (const weeks of [1, 53]) {
        await expect(setRecall(tx, PRACTICE_A, D0, { patientId: marco, weeks, paused: true })).rejects.toThrow();
      }
    });
  });
});

/** Un richiamo copiato con l'orologio dato, poi l'esito dichiarato con un altro. */
async function sendRecall(tx: Tx, patientId: string, copiedAt: Clock, outcome: "inviato" | "non_inviato" | null, declaredAt: Clock = copiedAt) {
  const id = randomUUID();
  await recordMessage(tx, PRACTICE_A, copiedAt, {
    id,
    source: { kind: "recall", patientId, templateKey: "richiamo" },
    body: "Ciao, è passato un po' dall'ultima seduta: vuoi fissare un controllo?",
    action: "copiato",
  });
  if (outcome !== null) await setMessageOutcome(tx, PRACTICE_A, declaredAt, { id, outcome });
  return id;
}

const waitOf = (block: RecallBlock) =>
  block.rows.map((r) => [r.name, r.dueText, r.lastSentOn, r.waitingUntil, r.waitingText]);

describe("attesa14: 14 giorni in attesa dopo un richiamo inviato", () => {
  it("in attesa in fondo fino al 4/11, il 5/11 torna al suo posto con «Richiamato il 22/10, nessuna risposta»", async () => {
    const out = await inUserA(db, async (tx) => {
      const marco = await recallPatient(tx, ["Marco", "Bellandi"], "2026-08-17");
      await recallPatient(tx, ["Anna", "Morelli"], "2026-08-30");
      // Aprire o copiare senza dichiarare l'invio non avvia l'attesa.
      await sendRecall(tx, marco, D0, null);
      const copied = await listRecalls(tx, PRACTICE_A, D0, 7);
      const sent = await sendRecall(tx, marco, D0, "inviato");
      // Un richiamo copiato dopo, senza esito, non sposta l'attesa del richiamo inviato.
      await sendRecall(tx, marco, at(TODAY, "18:00"), null);
      return {
        sent,
        copied,
        waiting: await listRecalls(tx, PRACTICE_A, D0, 7),
        lastDay: await listRecalls(tx, PRACTICE_A, at("2026-11-04", "23:30"), 7),
        after: await listRecalls(tx, PRACTICE_A, at("2026-11-05"), 7),
        counted: (await listPatients(tx, PRACTICE_A, D0, { ...LIST, filtro: "da_richiamare" })).counts.da_richiamare,
      };
    });
    expect(waitOf(out.copied)).toEqual([
      ["Marco Bellandi", "Scaduto da 10 giorni", null, null, null],
      ["Anna Morelli", "Fra 3 giorni", null, null, null],
    ]);
    // L'attesa conta ancora, ma va in fondo.
    expect(waitOf(out.waiting)).toEqual([
      ["Anna Morelli", "Fra 3 giorni", null, null, null],
      ["Marco Bellandi", "Scaduto da 10 giorni", "2026-10-22", "2026-11-04", "In attesa di risposta"],
    ]);
    expect(out.counted).toBe(2);
    expect(waitOf(out.lastDay)).toEqual([
      ["Anna Morelli", "Scaduto da 10 giorni", null, null, null],
      ["Marco Bellandi", "Scaduto da 23 giorni", "2026-10-22", "2026-11-04", "In attesa di risposta"],
    ]);
    expect(waitOf(out.after)).toEqual([
      ["Marco Bellandi", "Scaduto da 24 giorni", "2026-10-22", null, "Richiamato il 22/10, nessuna risposta"],
      ["Anna Morelli", "Scaduto da 11 giorni", null, null, null],
    ]);
  });

  it("correggere l'esito a non inviato toglie l'attesa", async () => {
    const out = await inUserA(db, async (tx) => {
      const marco = await recallPatient(tx, ["Marco", "Bellandi"], "2026-08-17");
      const id = await sendRecall(tx, marco, D0, "inviato");
      const waiting = await listRecalls(tx, PRACTICE_A, D0, 7);
      await setMessageOutcome(tx, PRACTICE_A, at(TODAY, "18:00"), { id, outcome: "non_inviato" });
      return { waiting, corrected: await listRecalls(tx, PRACTICE_A, D0, 7) };
    });
    expect(out.waiting.rows[0]?.waitingText).toBe("In attesa di risposta");
    expect(waitOf(out.corrected)).toEqual([["Marco Bellandi", "Scaduto da 10 giorni", null, null, null]]);
  });

  it("attesa_cambio_ora: inviato il 20/10 alle 18:00, in attesa fino al 2/11 compreso; outcome_at non conta", async () => {
    const out = await inUserA(db, async (tx) => {
      const marco = await recallPatient(tx, ["Marco", "Bellandi"], "2026-08-17");
      // Copiato il 20/10 alle 18:00 di Roma, dichiarato inviato il 22/10: conta il 20/10.
      await sendRecall(tx, marco, at("2026-10-20", "18:00"), "inviato", D0);
      return {
        lastDay: await listRecalls(tx, PRACTICE_A, at("2026-11-02", "23:30"), 7),
        after: await listRecalls(tx, PRACTICE_A, at("2026-11-03", "00:10"), 7),
      };
    });
    expect(out.lastDay.rows.map((r) => [r.lastSentOn, r.waitingUntil, r.waitingText])).toEqual([
      ["2026-10-20", "2026-11-02", "In attesa di risposta"],
    ]);
    expect(out.after.rows.map((r) => [r.lastSentOn, r.waitingUntil, r.waitingText])).toEqual([
      ["2026-10-20", null, "Richiamato il 20/10, nessuna risposta"],
    ]);
  });
});

describe("oggi_passato: un appuntamento futuro toglie il richiamo", () => {
  it("il controllo di oggi alle 10:00 conta anche alle 18:30; un appuntamento nuovo toglie chi è in attesa", async () => {
    const out = await inUserA(db, async (tx) => {
      const anna = await recallPatient(tx, ["Anna", "Morelli"], "2026-08-27");
      await book(tx, anna, TODAY, "10:00");
      const davide = await recallPatient(tx, ["Davide", "Conti"], "2026-08-15");
      await sendRecall(tx, davide, D0, "inviato");
      const before = await listRecalls(tx, PRACTICE_A, at(TODAY, "18:30"), 7);
      await book(tx, davide, "2026-11-10", "18:00");
      return { before, after: await listRecalls(tx, PRACTICE_A, at(TODAY, "18:30"), 7) };
    });
    expect(names(out.before)).toEqual({ rows: ["Davide Conti"], withoutConsent: [] });
    expect(names(out.after)).toEqual({ rows: [], withoutConsent: [] });
  });
});

describe("le righe in regola hanno il messaggio preparato, il gruppo senza consenso no", () => {
  it("contact è il richiamo del paziente; nel gruppo senza consenso è null con la sua ragione", async () => {
    const out = await inUserA(db, async (tx) => {
      const marco = await recallPatient(tx, ["Marco", "Bellandi"], "2026-08-17");
      await recallPatient(tx, ["Luca", "Costa"], "2026-08-24", { consent: false });
      return { marco, block: await listRecalls(tx, PRACTICE_A, D0, 7) };
    });
    const [row] = out.block.rows;
    expect(row?.contact?.source).toEqual({ kind: "recall", patientId: out.marco, templateKey: "richiamo" });
    expect(row?.contact?.copyAllowed).toBe(true);
    expect(row?.withoutConsentReason).toBeNull();
    expect(out.block.withoutConsent.map((r) => [r.name, r.contact, r.withoutConsentReason])).toEqual([
      ["Luca Costa", null, "Manca il consenso ai richiami"],
    ]);
  });
});

describe("revoca_martina: il gruppo chiuso dice chi ha revocato", () => {
  /** Martina, 9 anni, con la madre Simona di contatto: sì ai richiami nel modulo, poi la revoca via messaggio il 15/09. */
  async function martina(tx: Tx, relationship: "madre" | "padre" | "tutore" | "altro"): Promise<string> {
    const { id } = await createPatient(tx, PRACTICE_A, D0, {
      firstName: "Martina",
      lastName: "De Luca",
      birthDate: "2017-04-26",
      guardian: { firstName: "Simona", lastName: "De Luca" },
    });
    await tx.query("update public.patient_guardians set relationship = $2, is_contact = true where patient_id = $1", [id, relationship]);
    await book(tx, id, "2026-08-07", "17:00", "fatto");
    await setRecall(tx, PRACTICE_A, D0, { patientId: id, weeks: 10, paused: false });
    const record = await informativa(tx, id);
    await writeChoiceTemporary(tx, PRACTICE_A, {
      patientId: id,
      consentRecordId: record,
      choice: "richiami",
      value: true,
      decidedOn: "2026-08-10",
      mode: "modulo",
    });
    await writeChoiceTemporary(tx, PRACTICE_A, {
      patientId: id,
      consentRecordId: null,
      choice: "richiami",
      value: false,
      decidedOn: "2026-09-15",
      mode: "messaggio",
    });
    return id;
  }

  it.each<["madre" | "padre" | "tutore" | "altro", string]>([
    ["madre", "Consenso ai richiami revocato dalla madre il 15/09"],
    ["padre", "Consenso ai richiami revocato dal padre il 15/09"],
    ["tutore", "Consenso ai richiami revocato dal tutore il 15/09"],
    ["altro", "Consenso ai richiami revocato dal genitore il 15/09"],
  ])("contatto %s: %s, senza messaggio e con la scelta di prima intatta", async (relationship, reason) => {
    const out = await inUserA(db, async (tx) => {
      const id = await martina(tx, relationship);
      const choices = await tx.query<{ value: boolean; decidedOn: string; mode: string }>(
        `select value, decided_on as "decidedOn", mode from public.consent_choices
          where patient_id = $1 and choice = 'richiami' order by decided_on`,
        [id],
      );
      return { block: await listRecalls(tx, PRACTICE_A, D0, 7), choices };
    });
    expect(out.block.rows).toEqual([]);
    expect(out.block.withoutConsent.map((r) => [r.name, r.dueText, r.contact, r.withoutConsentReason])).toEqual([
      ["Martina De Luca", "Scaduto da 6 giorni", null, reason],
    ]);
    expect(out.choices).toEqual([
      { value: true, decidedOn: "2026-08-10", mode: "modulo" },
      { value: false, decidedOn: "2026-09-15", mode: "messaggio" },
    ]);
  });

  it("un adulto: «Consenso ai richiami revocato il GG/MM»; revocare oggi toglie subito dalle righe", async () => {
    const out = await inUserA(db, async (tx) => {
      const marco = await recallPatient(tx, ["Marco", "Bellandi"], "2026-08-17");
      const before = await listRecalls(tx, PRACTICE_A, D0, 7);
      await writeChoiceTemporary(tx, PRACTICE_A, {
        patientId: marco,
        consentRecordId: null,
        choice: "richiami",
        value: false,
        decidedOn: TODAY,
        mode: "messaggio",
      });
      return { before, after: await listRecalls(tx, PRACTICE_A, D0, 7) };
    });
    expect(names(out.before)).toEqual({ rows: ["Marco Bellandi"], withoutConsent: [] });
    expect(out.after.rows).toEqual([]);
    expect(out.after.withoutConsent.map((r) => [r.name, r.withoutConsentReason])).toEqual([
      ["Marco Bellandi", "Consenso ai richiami revocato il 22/10"],
    ]);
  });

  it("uB su rinvio, sospensione e cadenza di un paziente di A: rifiuto e nessun effetto", async () => {
    const marco = await asUserA(db, async (tx) => recallPatient(tx, ["Marco", "Straniero"], "2026-08-17"));
    await asUserB(db, async (tx) => {
      await expectNotAllowed(snoozeRecall(tx, PRACTICE_A, D0, { patientId: marco }));
      expect(await recallWeeksOf(tx, PRACTICE_A, marco)).toBeNull();
      await expectNotAllowed(setRecall(tx, PRACTICE_A, D0, { patientId: marco, weeks: 8, paused: true }));
      await expectNotAllowed(setRecall(tx, PRACTICE_A, D0, { patientId: marco, weeks: 4, paused: false }));
    });
    const [row] = await asServiceFor(db, async (tx) => {
      const rows = await tx.query<{ weeks: number; paused: boolean; snoozed: string | null }>(
        `select recall_interval_weeks as weeks, recall_paused as paused, recall_snoozed_until as snoozed
           from public.patients where id = $1`,
        [marco],
      );
      // Il paziente scritto davvero esce dalle liste dei test che seguono.
      await tx.query("update public.patients set archived_at = now() where id = $1", [marco]);
      return rows;
    });
    expect(row).toEqual({ weeks: 8, paused: false, snoozed: null });
  });
});

describe("canali_batch_versionati: i canali con la regola di getChannelConsents", () => {
  it("a pari decided_on e created_at vince la revoca inserita dopo il sì", async () => {
    const out = await inUserA(db, async (tx) => {
      const marco = await recallPatient(tx, ["Marco", "Bellandi"], "2026-08-17", { consent: false });
      const record = await informativa(tx, marco);
      const instant = "2026-10-15T08:00:00Z";
      for (const value of [true, false]) {
        await tx.query(
          `insert into public.consent_choices (practice_id, patient_id, consent_record_id, choice, value, decided_on, mode, created_at)
           values ($1, $2, $3, 'richiami', $4, '2026-10-15', 'modulo', $5)`,
          [PRACTICE_A, marco, value ? record : null, value, instant],
        );
      }
      return listRecalls(tx, PRACTICE_A, D0, 7);
    });
    expect(out.rows).toEqual([]);
    expect(out.withoutConsent.map((r) => [r.name, r.contact, r.withoutConsentReason])).toEqual([
      ["Marco Bellandi", null, "Consenso ai richiami revocato il 15/10"],
    ]);
  });

  it("un sì ai richiami con un'informativa di una versione non più valida non basta", async () => {
    const out = await inUserA(db, async (tx) => {
      const marco = await recallPatient(tx, ["Marco", "Bellandi"], "2026-08-17", { consent: false });
      const record = await informativa(tx, marco, "2025.1");
      await writeChoiceTemporary(tx, PRACTICE_A, {
        patientId: marco,
        consentRecordId: record,
        choice: "richiami",
        value: true,
        decidedOn: "2026-08-10",
        mode: "modulo",
      });
      return listRecalls(tx, PRACTICE_A, D0, 7);
    });
    expect(out.rows).toEqual([]);
    expect(out.withoutConsent.map((r) => [r.name, r.contact, r.withoutConsentReason])).toEqual([
      ["Marco Bellandi", null, "Manca il consenso ai richiami"],
    ]);
  });
});

describe("nessuna preparazione per riga fuori dalle righe mostrate", () => {
  /** Sette pazienti in regola, scaduti fra il 13/10 e il 19/10 (fatti dal 18/08 al 24/08, cadenza 8). */
  async function seven(tx: Tx): Promise<void> {
    const names = ["Alba", "Bice", "Ciro", "Dino", "Elio", "Fede", "Gino"];
    for (const [i, first] of names.entries()) {
      await recallPatient(tx, [first, "Sette"], `2026-08-${String(18 + i).padStart(2, "0")}`);
    }
  }

  it("Pazienti su un altro filtro non prepara messaggi; «Da richiamare» li prepara per le sue righe; Oggi al massimo 5", async () => {
    const spy = vi.mocked(prepareMessage);
    const out = await inUserA(db, async (tx) => {
      await seven(tx);
      spy.mockClear();
      const all = await listPatients(tx, PRACTICE_A, D0, LIST);
      const inCycle = await listPatients(tx, PRACTICE_A, D0, { ...LIST, filtro: "in_ciclo" });
      const otherFilters = spy.mock.calls.length;
      spy.mockClear();
      const recall = await listPatients(tx, PRACTICE_A, D0, { ...LIST, filtro: "da_richiamare" });
      const recallCalls = spy.mock.calls.length;
      spy.mockClear();
      const today = await listTodayRecalls(tx, PRACTICE_A, D0);
      return { all, inCycle, otherFilters, recall, recallCalls, today, todayCalls: spy.mock.calls.length };
    });
    expect(out.otherFilters).toBe(0);
    expect(out.all.counts.da_richiamare).toBe(7);
    expect(out.all.rows.every((r) => r.recall === null)).toBe(true);
    expect(out.recallCalls).toBe(7);
    expect(out.recall.rows.map((r) => r.recall?.contact?.templateKey)).toEqual(Array(7).fill("richiamo"));
    expect(TODAY_RECALL_ROWS).toBe(5);
    expect(out.todayCalls).toBe(5);
    expect(out.today.rows).toHaveLength(7);
    expect(out.today.rows.map((r) => r.contact !== null)).toEqual([true, true, true, true, true, false, false]);
  });
});

describe("in «Da richiamare» l'ordine dei richiami vince sull'ordinamento della tabella", () => {
  it("scaduti dal più vecchio, l'attesa in fondo, con qualunque colonna e verso", async () => {
    const out = await inUserA(db, async (tx) => {
      // Aldo Bassi è il più vecchio ma in attesa; Bruno Zanetti scade il 5/10, Carlo Amato il 19/10.
      const aldo = await recallPatient(tx, ["Aldo", "Bassi"], "2026-08-03");
      await recallPatient(tx, ["Bruno", "Zanetti"], "2026-08-10");
      await recallPatient(tx, ["Carlo", "Amato"], "2026-08-24");
      await sendRecall(tx, aldo, D0, "inviato");
      const read = (ordina: "paziente" | "prossimo", verso: "asc" | "desc") =>
        listPatients(tx, PRACTICE_A, D0, { ...LIST, filtro: "da_richiamare", ordina, verso });
      return {
        nameAsc: (await read("paziente", "asc")).rows.map((r) => r.name),
        nameDesc: (await read("paziente", "desc")).rows.map((r) => r.name),
        nextDesc: (await read("prossimo", "desc")).rows.map((r) => r.name),
      };
    });
    const order = ["Zanetti Bruno", "Amato Carlo", "Bassi Aldo"];
    expect(out).toEqual({ nameAsc: order, nameDesc: order, nextDesc: order });
  });
});
