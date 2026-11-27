import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toActionFailure } from "@/server/actions/result";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { BLOCKED_DELETE, isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import {
  archiveBlockText,
  archivePatient,
  createPatient,
  deleteBlockers,
  deletePatient,
  futureCount,
  restorePatient,
  setClinicalAlert,
  setRecall,
} from "@/server/domain/patients/commands";
import { searchPatients } from "@/server/domain/patients/queries";
import {
  CYCLE_A,
  FILE_A,
  GUARDIAN_A,
  PATIENT_A1,
  PATIENT_A2,
  PATIENT_A3,
  PRACTICE_A,
  PRACTICE_B,
  SERVICE_A,
  sha256Hex,
} from "./fixtures";
import { asUserA, asUserB, expectBlockedDelete, inRollback, inUserA, openTestDb } from "./helpers";

// Archiviare, ripristinare ed eliminare un paziente, la cadenza del richiamo e l'avviso clinico.
// Come uA, mercoledì 4/11/2026 alle 08:30 di Roma.

const clock = fixedClock("2026-11-04T08:30:00+01:00");

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const nameOf = (err: unknown): unknown => (err as { name?: unknown } | null)?.name;

function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (value: unknown) => expect.fail(`atteso un errore, invece il comando ha restituito ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );
}

/** Il comando risponde con un DomainError di testo `message`: la transazione resta valida. */
async function expectDomainError(p: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
}

/** Il comando fallisce nello schema: la risposta che arriva al modulo. */
async function formFailure(p: Promise<unknown>) {
  const error = await rejectionOf(p);
  expect(nameOf(error), String(error)).toBe("ZodError");
  return toActionFailure(error, "test");
}

async function patientRow(tx: Tx, id: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await tx.query("select * from public.patients where practice_id = $1 and id = $2", [PRACTICE_A, id]);
  return row;
}

const countOf = async (tx: Tx, table: string, patientId: string): Promise<number> => {
  const rows = await tx.query(`select 1 from public.${table} where practice_id = $1 and patient_id = $2`, [
    PRACTICE_A,
    patientId,
  ]);
  return rows.length;
};

/** Un adulto nuovo, senza nessun altro dato. */
async function newAdult(tx: Tx): Promise<string> {
  const { id } = await createPatient(tx, PRACTICE_A, clock, {
    firstName: "Anna",
    lastName: "Prova",
    birthDate: "1990-01-01",
  });
  return id;
}

/** Un appuntamento del paziente sul suo ciclo (che si apre qui), a `startsAt`, nello `status` dato. */
async function addAppointment(tx: Tx, patientId: string, startsAt: string, status = "prenotato"): Promise<string> {
  const [cycle] = await tx.query<{ id: string }>(
    `select id from public.treatment_cycles where practice_id = $1 and patient_id = $2 limit 1`,
    [PRACTICE_A, patientId],
  );
  const cycleId =
    cycle?.id ??
    (
      await tx.query<{ id: string }>(
        `insert into public.treatment_cycles (practice_id, patient_id, opened_on, title, expected_sessions)
         values ($1, $2, '2026-10-01', 'Lombalgia, ottobre 2026', 4) returning id`,
        [PRACTICE_A, patientId],
      )
    )[0]?.id;
  if (!cycleId) throw new Error("ciclo non creato");
  const [row] = await tx.query<{ id: string }>(
    `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status, cancel_reason)
     values ($1, $2, $3, $4, $5, 45, 6000, $6, case when $6 = 'annullato' then 'paziente' end)
     returning id`,
    [PRACTICE_A, patientId, SERVICE_A, cycleId, startsAt, status],
  );
  if (!row) throw new Error("appuntamento non creato");
  return row.id;
}

const ARCHIVE_TWO = "Prima annulla i 2 appuntamenti futuri.";
const ARCHIVE_ONE = "Prima annulla l'appuntamento futuro.";

describe("archivePatient", () => {
  it("con 2 futuri (prenotato e confermato, uno di oggi alle 08:00 già passato) risponde con il conto e non archivia", async () => {
    await inUserA(db, async (tx) => {
      const id = await newAdult(tx);
      await addAppointment(tx, id, "2026-11-04T07:00:00Z", "prenotato"); // oggi 08:00 di Roma, già passato
      await addAppointment(tx, id, "2026-11-10T08:00:00Z", "confermato");
      // Non contano: annullato futuro, fatto di ieri, saltato di ieri.
      await addAppointment(tx, id, "2026-11-12T08:00:00Z", "annullato");
      await addAppointment(tx, id, "2026-11-03T08:00:00Z", "fatto");
      await addAppointment(tx, id, "2026-11-03T09:00:00Z", "saltato");
      expect(await futureCount(tx, PRACTICE_A, clock, id)).toBe(2);
      expect(archiveBlockText(2)).toBe(ARCHIVE_TWO);

      await expectDomainError(archivePatient(tx, PRACTICE_A, clock, { patientId: id }), ARCHIVE_TWO);
      expect((await patientRow(tx, id))?.archived_at).toBeNull();
    });
  });

  it("con 1 futuro dice «l'appuntamento futuro»", async () => {
    await inUserA(db, async (tx) => {
      const id = await newAdult(tx);
      await addAppointment(tx, id, "2026-11-20T08:00:00Z", "confermato");
      expect(archiveBlockText(1)).toBe(ARCHIVE_ONE);
      await expectDomainError(archivePatient(tx, PRACTICE_A, clock, { patientId: id }), ARCHIVE_ONE);
      expect((await patientRow(tx, id))?.archived_at).toBeNull();
    });
  });

  it("l'appuntamento di ieri non ancora segnato non blocca, e il testo senza futuri è null", async () => {
    await inUserA(db, async (tx) => {
      const id = await newAdult(tx);
      await addAppointment(tx, id, "2026-11-03T08:00:00Z", "prenotato");
      expect(await futureCount(tx, PRACTICE_A, clock, id)).toBe(0);
      expect(archiveBlockText(0)).toBeNull();
    });
  });

  it("senza futuri archivia all'istante del clock, e la ricerca lo dà archiviato", async () => {
    const result = await inUserA(db, async (tx) => {
      await archivePatient(tx, PRACTICE_A, clock, { patientId: PATIENT_A3 });
      const row = await patientRow(tx, PATIENT_A3);
      const hits = await searchPatients(tx, PRACTICE_A, "Greco");
      return { archivedAt: row?.archived_at, hit: hits.find((h) => h.id === PATIENT_A3) };
    });
    expect(result.archivedAt).toEqual(clock.now());
    expect(result.hit?.archived).toBe(true);
  });

  it("archiviare un paziente già archiviato non sposta l'istante", async () => {
    const archivedAt = await inUserA(db, async (tx) => {
      await archivePatient(tx, PRACTICE_A, clock, { patientId: PATIENT_A3 });
      await archivePatient(tx, PRACTICE_A, fixedClock("2026-11-06T09:00:00+01:00"), { patientId: PATIENT_A3 });
      return (await patientRow(tx, PATIENT_A3))?.archived_at;
    });
    expect(archivedAt).toEqual(clock.now());
  });
});

describe("restorePatient", () => {
  it("toglie l'archiviazione", async () => {
    const archivedAt = await inUserA(db, async (tx) => {
      await archivePatient(tx, PRACTICE_A, clock, { patientId: PATIENT_A3 });
      await restorePatient(tx, PRACTICE_A, clock, { patientId: PATIENT_A3 });
      return (await patientRow(tx, PATIENT_A3))?.archived_at;
    });
    expect(archivedAt).toBeNull();
  });
});

describe("deletePatient", () => {
  it("un paziente con solo un genitore sparisce insieme al genitore", async () => {
    await inUserA(db, async (tx) => {
      expect(await deleteBlockers(tx, PRACTICE_A, PATIENT_A3)).toBe(false);
      await deletePatient(tx, PRACTICE_A, clock, { patientId: PATIENT_A3 });
      expect(await patientRow(tx, PATIENT_A3)).toBeUndefined();
      expect(await countOf(tx, "patient_guardians", PATIENT_A3)).toBe(0);
    });
  });

  it("un adulto appena creato, senza altro, sparisce", async () => {
    await inUserA(db, async (tx) => {
      const id = await newAdult(tx);
      expect(await deleteBlockers(tx, PRACTICE_A, id)).toBe(false);
      await deletePatient(tx, PRACTICE_A, clock, { patientId: id });
      expect(await patientRow(tx, id)).toBeUndefined();
    });
  });

  it("con un appuntamento: testo del blocco, senza toccare il database", async () => {
    await inUserA(db, async (tx) => {
      const id = await newAdult(tx);
      await addAppointment(tx, id, "2026-11-20T08:00:00Z");
      expect(await deleteBlockers(tx, PRACTICE_A, id)).toBe(true);
      await expectDomainError(deletePatient(tx, PRACTICE_A, clock, { patientId: id }), BLOCKED_DELETE);
      // La transazione è ancora valida e la riga c'è: il comando si è fermato prima della delete.
      expect(await patientRow(tx, id)).toBeDefined();
      expect(await countOf(tx, "appointments", id)).toBe(1);
    });
  });

  it("con una voce di anamnesi (inserita come uA): stesso testo", async () => {
    await inUserA(db, async (tx) => {
      const id = await newAdult(tx);
      await tx.query(
        `insert into public.patient_history_items (practice_id, patient_id, kind, label)
         values ($1, $2, 'farmaco', 'Warfarin 5 mg')`,
        [PRACTICE_A, id],
      );
      expect(await deleteBlockers(tx, PRACTICE_A, id)).toBe(true);
      await expectDomainError(deletePatient(tx, PRACTICE_A, clock, { patientId: id }), BLOCKED_DELETE);
      expect(await patientRow(tx, id)).toBeDefined();
    });
  });

  it("con una sola riga di consent_choices (inserita come uA): stesso testo", async () => {
    await inUserA(db, async (tx) => {
      const id = await newAdult(tx);
      await tx.query(
        `insert into public.consent_choices (practice_id, patient_id, choice, value, decided_on, mode)
         values ($1, $2, 'richiami', true, '2026-11-04', 'verbale')`,
        [PRACTICE_A, id],
      );
      expect(await deleteBlockers(tx, PRACTICE_A, id)).toBe(true);
      await expectDomainError(deletePatient(tx, PRACTICE_A, clock, { patientId: id }), BLOCKED_DELETE);
      expect(await patientRow(tx, id)).toBeDefined();
    });
  });

  it("un paziente con tutta la cartella della fixture è bloccato", async () => {
    await inUserA(db, async (tx) => {
      expect(await deleteBlockers(tx, PRACTICE_A, PATIENT_A1)).toBe(true);
      await expectDomainError(deletePatient(tx, PRACTICE_A, clock, { patientId: PATIENT_A1 }), BLOCKED_DELETE);
      expect(await patientRow(tx, PATIENT_A1)).toBeDefined();
    });
  });

  it("un paziente con un consenso firmato dal genitore è bloccato, e il genitore resta", async () => {
    await inUserA(db, async (tx) => {
      expect(await deleteBlockers(tx, PRACTICE_A, PATIENT_A3)).toBe(false);
      const text = "Informativa sul trattamento dei dati personali. Io sottoscritta Laura Greco, genitore di Sofia Greco.";
      await tx.query(
        `insert into public.consent_records (practice_id, patient_id, module_key, module_version, rendered_text, rendered_hash,
                                             signer_kind, signer_name, guardian_id, method, signature_file_id, signed_on)
         values ($1, $2, 'informativa', '2026.1', $3, $4, 'genitore', 'Laura Greco', $5, 'tela', $6, '2026-10-06')`,
        [PRACTICE_A, PATIENT_A3, text, sha256Hex(text), GUARDIAN_A, FILE_A],
      );
      expect(await deleteBlockers(tx, PRACTICE_A, PATIENT_A3)).toBe(true);
      await expectDomainError(deletePatient(tx, PRACTICE_A, clock, { patientId: PATIENT_A3 }), BLOCKED_DELETE);
      expect(await countOf(tx, "patient_guardians", PATIENT_A3)).toBe(1);
    });
  });

  it("la delete diretta di un paziente con un appuntamento la ferma la chiave esterna", async () => {
    await inRollback(db, "A", async (tx) => {
      const id = await newAdult(tx);
      await addAppointment(tx, id, "2026-11-20T08:00:00Z");
      await expectBlockedDelete(tx.query("delete from public.patients where practice_id = $1 and id = $2", [PRACTICE_A, id]));
    });
  });
});

describe("setRecall", () => {
  it("8 settimane: cadenza 8 e richiami non sospesi", async () => {
    const row = await inUserA(db, async (tx) => {
      await setRecall(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, weeks: 8, paused: false });
      return patientRow(tx, PATIENT_A2);
    });
    expect(row).toMatchObject({ recall_interval_weeks: 8, recall_paused: false });
  });

  it("con la pausa salva recall_paused", async () => {
    const row = await inUserA(db, async (tx) => {
      await setRecall(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, weeks: 8, paused: true });
      return patientRow(tx, PATIENT_A2);
    });
    expect(row).toMatchObject({ recall_interval_weeks: 8, recall_paused: true });
  });

  it("senza cadenza (weeks null) la toglie", async () => {
    const row = await inUserA(db, async (tx) => {
      await setRecall(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, weeks: 8, paused: false });
      await setRecall(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, weeks: null, paused: false });
      return patientRow(tx, PATIENT_A2);
    });
    expect(row).toMatchObject({ recall_interval_weeks: null, recall_paused: false });
  });

  it("53 settimane, 1, 2.5 o una pausa non booleana sono valori non validi", async () => {
    await inUserA(db, async (tx) => {
      for (const weeks of [53, 1, 2.5, "8"]) {
        const failure = await formFailure(setRecall(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, weeks, paused: false }));
        expect(failure.message, String(weeks)).toBe("Valore non valido");
      }
      const failure = await formFailure(setRecall(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, weeks: 8, paused: "no" }));
      expect(failure.message).toBe("Valore non valido");
      await formFailure(setRecall(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, weeks: 8, paused: false, extra: 1 }));
      expect((await patientRow(tx, PATIENT_A2))?.recall_interval_weeks).toBeNull();
    });
  });
});

describe("setClinicalAlert", () => {
  it("salva il testo senza spazi ai lati", async () => {
    const row = await inUserA(db, async (tx) => {
      await setClinicalAlert(tx, PRACTICE_A, clock, {
        patientId: PATIENT_A2,
        clinicalAlert: " Terapia anticoagulante (warfarin) ",
      });
      return patientRow(tx, PATIENT_A2);
    });
    expect(row?.clinical_alert).toBe("Terapia anticoagulante (warfarin)");
  });

  it("la stringa vuota (o solo spazi) o null lo toglie", async () => {
    const rows = await inUserA(db, async (tx) => {
      const alert = "Terapia anticoagulante (warfarin)";
      await setClinicalAlert(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, clinicalAlert: alert });
      await setClinicalAlert(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, clinicalAlert: "" });
      const afterEmpty = (await patientRow(tx, PATIENT_A2))?.clinical_alert;
      await setClinicalAlert(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, clinicalAlert: alert });
      await setClinicalAlert(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, clinicalAlert: "   " });
      const afterBlank = (await patientRow(tx, PATIENT_A2))?.clinical_alert;
      await setClinicalAlert(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, clinicalAlert: alert });
      await setClinicalAlert(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, clinicalAlert: null });
      return { afterEmpty, afterBlank, afterNull: (await patientRow(tx, PATIENT_A2))?.clinical_alert };
    });
    expect(rows).toEqual({ afterEmpty: null, afterBlank: null, afterNull: null });
  });

  it("200 caratteri passano, 201 no: «Massimo 200 caratteri.»", async () => {
    await inUserA(db, async (tx) => {
      await setClinicalAlert(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, clinicalAlert: "a".repeat(200) });
      expect((await patientRow(tx, PATIENT_A2))?.clinical_alert).toBe("a".repeat(200));
      const failure = await formFailure(
        setClinicalAlert(tx, PRACTICE_A, clock, { patientId: PATIENT_A2, clinicalAlert: "a".repeat(201) }),
      );
      expect(failure.message).toBe("Massimo 200 caratteri.");
      expect((await patientRow(tx, PATIENT_A2))?.clinical_alert).toBe("a".repeat(200));
    });
  });
});

// Studio B sugli id di A: un database tutto suo, perché qui le transazioni di uB arrivano al commit
// (un DomainError lascia la transazione valida) e si rilegge A dopo.
describe("studio B sugli id di A", () => {
  let isolated: Db;
  let isolatedPg: PGlite;

  beforeAll(async () => {
    ({ db: isolated, pg: isolatedPg } = await openTestDb());
  });

  afterAll(async () => {
    await isolatedPg?.close();
  });

  const snapshotOfA = () =>
    asUserA(isolated, async (tx) => ({
      patients: await tx.query("select * from public.patients where practice_id = $1 order by id", [PRACTICE_A]),
      guardians: await tx.query("select * from public.patient_guardians where practice_id = $1 order by id", [PRACTICE_A]),
    }));

  it("archivia, ripristina, elimina, richiamo e avviso: Operazione non permessa e A non cambia", async () => {
    const before = await snapshotOfA();
    await asUserB(isolated, async (tx) => {
      for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
        for (const patientId of [PATIENT_A1, PATIENT_A3]) {
          await expectDomainError(archivePatient(tx, practiceId, clock, { patientId }), NOT_ALLOWED);
          await expectDomainError(restorePatient(tx, practiceId, clock, { patientId }), NOT_ALLOWED);
          await expectDomainError(deletePatient(tx, practiceId, clock, { patientId }), NOT_ALLOWED);
          await expectDomainError(setRecall(tx, practiceId, clock, { patientId, weeks: 8, paused: true }), NOT_ALLOWED);
          await expectDomainError(
            setClinicalAlert(tx, practiceId, clock, { patientId, clinicalAlert: "Inventato" }),
            NOT_ALLOWED,
          );
        }
      }
    });
    expect(await snapshotOfA()).toEqual(before);
  });

  it("un id di CYCLE_A non è un paziente: Operazione non permessa", async () => {
    await asUserB(isolated, async (tx) => {
      await expectDomainError(archivePatient(tx, PRACTICE_B, clock, { patientId: CYCLE_A }), NOT_ALLOWED);
    });
  });
});
