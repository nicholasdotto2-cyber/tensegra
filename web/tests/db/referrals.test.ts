import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toActionFailure } from "@/server/actions/result";
import { buildReferralSummary, DEFAULT_REQUEST_TEXT } from "@/lib/clinical/referral-summary";
import { type Clock, fixedClock, romeDateTime } from "@/server/clock";
import type { Db, SqlParam, Tx } from "@/server/db/db";
import { updateCycleOpening } from "@/server/domain/cycles/commands";
import { isDomainError, NOT_ALLOWED } from "@/server/domain/errors";
import { createPatient } from "@/server/domain/patients/commands";
import { createPhysician } from "@/server/domain/physicians/commands";
import {
  createReferral,
  DELIVERY_BEFORE_LETTER,
  DELIVERY_IN_FUTURE,
  EDIT_LOCKED,
  markReferralDelivered,
  NEEDS_AGREEMENT,
  NEEDS_CYCLE,
  updateReferral,
} from "@/server/domain/referrals/commands";
import { getReferralLetter, referralFacts } from "@/server/domain/referrals/queries";
import { editVisit, startVisit } from "@/server/domain/visits/commands";
import { storageKey } from "@/server/files/keys";
import { sha256Of } from "@/server/files/sniff";
import type { StoreContext } from "@/server/files/upload";
import { ensureReferralPdf, LETTER_CHANGED } from "@/server/pdf/referral-file";
import { renderReferralPdf } from "@/server/pdf/render";
import { PATIENT_A1, PHYSICIAN_B, PRACTICE_A, PRACTICE_B, REFERRAL_B, SERVICE_A, USER_A } from "./fixtures";
import { asServiceFor, asUserA, asUserB, expectPgError, inRollback, inUserA, openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

// Il rendering vero, osservato: si vede da quale lettera nasce ogni PDF (il testo nei byte non si legge).
vi.mock("@/server/pdf/render", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/pdf/render")>();
  return { renderReferralPdf: vi.fn(real.renderReferralPdf) };
});
const renderSpy = vi.mocked(renderReferralPdf);
const SIGNATURE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

// Rinvii al medico e lettera. Tutto come uA;
// oggi è mercoledì 4/11/2026 alle 08:30 di Roma. `ensureReferralPdf` apre le sue transazioni e salva
// davvero: si chiama fuori da `inUserA`/`inRollback`, su rinvii scritti e salvati come uA, e le righe
// si rileggono come servizio.

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const clockOf = (day: string): Clock => fixedClock(`${day}T10:00:00+01:00`);
const PDF_MAGIC = "%PDF-";

let db: Db;
let pg: PGlite;
let store: MemoryFileStore;
let ctxA: StoreContext;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  ctxA = { db, actor: { userId: USER_A }, practiceId: PRACTICE_A };
});

beforeEach(() => {
  store = new MemoryFileStore();
});

afterAll(async () => {
  await pg?.close();
});

/** L'errore con cui la promessa fallisce; se riesce, il test fallisce. */
function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (value: unknown) => expect.fail(`atteso un errore, invece ha restituito ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );
}

async function expectDomainError(p: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(p);
  expect(isDomainError(error), String(error)).toBe(true);
  expect((error as Error).message).toBe(message);
}

/** Lo schema rifiuta l'input prima del database: il testo che arriva al modulo. */
async function expectInvalid(p: Promise<unknown>, message: string): Promise<void> {
  const error = await rejectionOf(p);
  expect((error as { name?: unknown }).name, String(error)).toBe("ZodError");
  expect(toActionFailure(error, "test").message).toBe(message);
}

/** Uno store in cui ogni `put` aspetta il secondo: due richieste scrivono il PDF prima di salvare la riga. */
class RaceStore extends MemoryFileStore {
  readonly removed: string[] = [];
  private waiting: (() => void) | null = null;

  override async put(key: string, bytes: Uint8Array): Promise<void> {
    await super.put(key, bytes);
    if (this.waiting) {
      this.waiting();
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting = resolve;
    });
  }

  override async remove(key: string): Promise<void> {
    this.removed.push(key);
    await super.remove(key);
  }
}

/** Uno store che dopo ogni `put` esegue `onPut`: una scrittura salvata fra il rendering e il salvataggio. */
class HookStore extends MemoryFileStore {
  readonly removed: string[] = [];
  private puts = 0;

  constructor(private readonly onPut: (count: number) => Promise<void>) {
    super();
  }

  override async put(key: string, bytes: Uint8Array): Promise<void> {
    await super.put(key, bytes);
    this.puts += 1;
    await this.onPut(this.puts);
  }

  override async remove(key: string): Promise<void> {
    this.removed.push(key);
    await super.remove(key);
  }
}

/**
 * La transazione `tx` in cui, subito prima del primo update di `referrals` del comando, gira `sql`: come
 * un'altra transazione salvata fra la lettura del comando e la sua scrittura (su Supabase, read committed).
 */
function interleaved(tx: Tx, sql: string, params: readonly SqlParam[]): Tx {
  let done = false;
  return {
    async query<T = Record<string, unknown>>(text: string, p?: readonly SqlParam[]): Promise<T[]> {
      if (!done && text.trimStart().startsWith("update public.referrals")) {
        done = true;
        await tx.query(sql, params);
      }
      return tx.query<T>(text, p);
    },
  };
}

// Preparazione, tutta come uA ------------------------------------------------------------------------

interface Case {
  patientId: string;
  cycleId: string;
  visitId: string;
  gpId: string;
}

let caseCount = 0;

/**
 * Un paziente con il medico curante in rubrica, un ciclo aperto il 14/10 con il motivo, una visita di
 * oggi con dolore 6 e le risposte date (di base `rf_weight` e `rf_nonmech` "si", R1 programmato).
 */
async function roberto(tx: Tx, answers: readonly string[] = ["rf_weight", "rf_nonmech"]): Promise<Case> {
  caseCount += 1;
  const { id: patientId } = await createPatient(tx, PRACTICE_A, clockOf("2026-10-01"), {
    firstName: "Roberto",
    lastName: `Esposito${caseCount}`,
    birthDate: "1971-03-12",
  });
  const { id: gpId } = await createPhysician(tx, PRACTICE_A, clock, { fullName: "Dott. Luca Ferri", role: "mmg" });
  await tx.query("update public.patients set gp_physician_id = $3 where practice_id = $1 and id = $2", [
    PRACTICE_A,
    patientId,
    gpId,
  ]);
  const [cycle] = await tx.query<{ id: string }>(
    `insert into public.treatment_cycles (practice_id, patient_id, kind, opened_on, title, expected_sessions)
     values ($1, $2, 'trattamento', '2026-10-14', 'Dolore dorsale e lombare, ottobre 2026', 4) returning id`,
    [PRACTICE_A, patientId],
  );
  if (!cycle) throw new Error("ciclo non creato");
  const [appointment] = await tx.query<{ id: string }>(
    `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status)
     values ($1, $2, $3, $4, $5, 45, 6000, 'fatto') returning id`,
    [PRACTICE_A, patientId, SERVICE_A, cycle.id, romeDateTime("2026-11-04", "08:00")],
  );
  if (!appointment) throw new Error("appuntamento non creato");
  const { visitId } = await startVisit(tx, PRACTICE_A, clock, { appointmentId: appointment.id });
  await updateCycleOpening(tx, PRACTICE_A, clock, {
    cycleId: cycle.id,
    chiefComplaint: "Dolore dorsale e lombare",
    mainRegion: "lumbar",
  });
  await editVisit(tx, PRACTICE_A, clock, { visitId, op: { op: "campi", values: { nprsPre: 6 } } });
  for (const itemCode of answers) {
    await editVisit(tx, PRACTICE_A, clock, { visitId, op: { op: "risposta", itemCode, answer: "si" } });
  }
  return { patientId, cycleId: cycle.id, visitId, gpId };
}

interface ReferralRow {
  id: string;
  patient_id: string;
  cycle_id: string;
  visit_id: string | null;
  created_on: string;
  recipient_kind: string;
  physician_id: string | null;
  recipient_free: string | null;
  reason: string;
  urgency: string;
  summary_text: string;
  request_text: string;
  patient_agreed_to_share: boolean;
  status: string;
  delivered_on: string | null;
  letter_file_id: string | null;
  created_by: string | null;
}

const REFERRAL_COLUMNS = `id, patient_id, cycle_id, visit_id, created_on, recipient_kind, physician_id, recipient_free, reason,
  urgency, summary_text, request_text, patient_agreed_to_share, status, delivered_on, letter_file_id, created_by`;

async function referralRow(tx: Tx, id: string): Promise<ReferralRow | undefined> {
  const [row] = await tx.query<ReferralRow>(`select ${REFERRAL_COLUMNS} from public.referrals where id = $1`, [id]);
  return row;
}

/** Come servizio: il rinvio salvato, anche fuori da una transazione dell'utente. */
function savedReferral(id: string): Promise<ReferralRow | undefined> {
  return asServiceFor(db, (tx) => referralRow(tx, id));
}

function filesOf(practiceId: string, kind: string) {
  return asServiceFor(db, (tx) =>
    tx.query<{ id: string; storage_key: string; mime_type: string; size_bytes: number; sha256: string; kind: string }>(
      `select id, storage_key, mime_type, size_bytes, sha256, kind from public.files
        where practice_id = $1 and kind = $2 order by created_at, id`,
      [practiceId, kind],
    ),
  );
}

const update = (referralId: string, extra: Record<string, unknown> = {}) => ({
  referralId,
  recipientKind: "specialista",
  physicianId: null,
  recipientFree: "Dott.ssa Elena Bassi, ortopedica",
  reason: "peggioramento",
  urgency: "urgente",
  summaryText: "Segnalo un peggioramento dei sintomi e chiedo una sua valutazione.",
  requestText: "Le chiedo una visita ortopedica.",
  patientAgreedToShare: false,
  ...extra,
});

/** Un rinvio scritto e salvato come uA (per `ensureReferralPdf`, che apre le sue transazioni). */
async function savedCase(): Promise<Case & { referralId: string }> {
  return asUserA(db, async (tx) => {
    const c = await roberto(tx);
    const { id } = await createReferral(tx, PRACTICE_A, clock, { patientId: c.patientId, visitId: c.visitId });
    return { ...c, referralId: id };
  });
}

// createReferral --------------------------------------------------------------------------------------

describe("createReferral", () => {
  it("dal R1: red flag con l'urgenza della voce, medico curante, sintesi generata, richiesta predefinita, bozza di oggi", async () => {
    await inUserA(db, async (tx) => {
      const c = await roberto(tx);
      const created = await createReferral(tx, PRACTICE_A, clock, { patientId: c.patientId, visitId: c.visitId });
      expect(created.patientId).toBe(c.patientId);
      const row = await referralRow(tx, created.id);
      const facts = await referralFacts(tx, PRACTICE_A, c.cycleId, c.visitId);
      expect(row).toMatchObject({
        patient_id: c.patientId,
        cycle_id: c.cycleId,
        visit_id: c.visitId,
        created_on: "2026-11-04",
        recipient_kind: "medico_curante",
        physician_id: c.gpId,
        recipient_free: null,
        reason: "red_flag",
        urgency: "programmato",
        summary_text: buildReferralSummary(facts),
        request_text: DEFAULT_REQUEST_TEXT,
        patient_agreed_to_share: false,
        status: "bozza",
        delivered_on: null,
        letter_file_id: null,
        created_by: USER_A,
      });
      expect(facts.reason).toBe("red_flag");
      expect(row?.summary_text.split("\n")[0]).toBe(
        `Segnalo la comparsa di segni che richiedono una valutazione medica in Roberto Esposito${caseCount}, che seguo dal 14/10/2026 per Dolore dorsale e lombare, e chiedo una sua valutazione.`,
      );
      expect(row?.summary_text).toContain(
        "Nella visita del 04/11/2026 ho rilevato: Calo di peso non spiegato; Dolore costante e progressivo che non cambia con posizione e movimento.",
      );
      expect(row?.summary_text).toContain("Dolore 0-10 a inizio seduta: 6.");
      expect(row?.summary_text).not.toContain("Diagnosi medica di riferimento");
    });
  });

  it("l'urgenza è quella della voce più grave fra i red flag segnati", async () => {
    await inUserA(db, async (tx) => {
      const c = await roberto(tx, ["rf_weight", "rf_bilat_sciatica"]);
      const { id } = await createReferral(tx, PRACTICE_A, clock, { patientId: c.patientId, visitId: c.visitId });
      expect(await referralRow(tx, id)).toMatchObject({ reason: "red_flag", urgency: "urgente" });
    });
  });

  it("motivo e urgenza scelti dal chiamante; senza visita prende il ciclo aperto e la sua ultima visita", async () => {
    await inUserA(db, async (tx) => {
      const c = await roberto(tx);
      const chosen = await createReferral(tx, PRACTICE_A, clock, {
        patientId: c.patientId,
        visitId: c.visitId,
        reason: "fuori_competenza",
        urgency: "emergenza",
      });
      expect(await referralRow(tx, chosen.id)).toMatchObject({ reason: "fuori_competenza", urgency: "emergenza" });
      expect((await referralRow(tx, chosen.id))?.summary_text).toMatch(/^Segnalo un quadro che esce dalla mia competenza in /);

      const fromCartella = await createReferral(tx, PRACTICE_A, clock, { patientId: c.patientId });
      expect(await referralRow(tx, fromCartella.id)).toMatchObject({
        cycle_id: c.cycleId,
        visit_id: null,
        reason: "red_flag",
        urgency: "programmato",
      });
    });
  });

  it("senza red flag e senza R2 o R3 il motivo è altro e l'urgenza programmato; senza medico curante nessun medico", async () => {
    await inUserA(db, async (tx) => {
      const c = await roberto(tx, []);
      await tx.query("update public.patients set gp_physician_id = null where practice_id = $1 and id = $2", [
        PRACTICE_A,
        c.patientId,
      ]);
      const { id } = await createReferral(tx, PRACTICE_A, clock, { patientId: c.patientId, cycleId: c.cycleId });
      expect(await referralRow(tx, id)).toMatchObject({
        reason: "altro",
        urgency: "programmato",
        recipient_kind: "medico_curante",
        physician_id: null,
      });
    });
  });

  it("senza cicli: «Per un rinvio serve un ciclo.»", async () => {
    await inUserA(db, async (tx) => {
      const { id: patientId } = await createPatient(tx, PRACTICE_A, clock, {
        firstName: "Lia",
        lastName: "Senzaciclo",
        birthDate: "1990-01-01",
      });
      await expectDomainError(createReferral(tx, PRACTICE_A, clock, { patientId }), NEEDS_CYCLE);
      expect(NEEDS_CYCLE).toBe("Per un rinvio serve un ciclo.");
      expect(await tx.query("select 1 from public.referrals where patient_id = $1", [patientId])).toHaveLength(0);
    });
  });

  it("una visita o un ciclo di un altro paziente: Operazione non permessa", async () => {
    await inUserA(db, async (tx) => {
      const c = await roberto(tx);
      await expectDomainError(
        createReferral(tx, PRACTICE_A, clock, { patientId: PATIENT_A1, visitId: c.visitId }),
        NOT_ALLOWED,
      );
      await expectDomainError(
        createReferral(tx, PRACTICE_A, clock, { patientId: PATIENT_A1, cycleId: c.cycleId }),
        NOT_ALLOWED,
      );
      await expectInvalid(
        createReferral(tx, PRACTICE_A, clock, { patientId: c.patientId, studio: PRACTICE_A }),
        "Valore non valido",
      );
    });
  });

  it("come uB sul paziente di A: Operazione non permessa e nessuna riga", async () => {
    const c = await asUserA(db, (tx) => roberto(tx));
    await expectDomainError(
      asUserB(db, (tx) => createReferral(tx, PRACTICE_B, clock, { patientId: c.patientId, visitId: c.visitId })),
      NOT_ALLOWED,
    );
    const rows = await asServiceFor(db, (tx) => tx.query("select 1 from public.referrals where patient_id = $1", [c.patientId]));
    expect(rows).toHaveLength(0);
  });
});

// updateReferral e markReferralDelivered --------------------------------------------------------------

describe("updateReferral e markReferralDelivered", () => {
  it("in bozza si modifica e si rilegge; consegnata non si modifica più", async () => {
    await inUserA(db, async (tx) => {
      const c = await roberto(tx);
      const { id } = await createReferral(tx, PRACTICE_A, clock, { patientId: c.patientId, visitId: c.visitId });
      await updateReferral(tx, PRACTICE_A, clock, update(id));
      expect(await referralRow(tx, id)).toMatchObject({
        recipient_kind: "specialista",
        physician_id: null,
        recipient_free: "Dott.ssa Elena Bassi, ortopedica",
        reason: "peggioramento",
        urgency: "urgente",
        summary_text: "Segnalo un peggioramento dei sintomi e chiedo una sua valutazione.",
        request_text: "Le chiedo una visita ortopedica.",
        patient_agreed_to_share: false,
        status: "bozza",
        created_on: "2026-11-04",
      });

      await expectDomainError(
        markReferralDelivered(tx, PRACTICE_A, clock, { referralId: id, deliveredOn: "2026-11-04" }),
        NEEDS_AGREEMENT,
      );
      expect(NEEDS_AGREEMENT).toBe("Serve l'assenso del paziente a condividere queste informazioni.");
      expect(await referralRow(tx, id)).toMatchObject({ status: "bozza", delivered_on: null });

      await updateReferral(tx, PRACTICE_A, clock, update(id, { physicianId: c.gpId, patientAgreedToShare: true }));
      await markReferralDelivered(tx, PRACTICE_A, clock, { referralId: id, deliveredOn: "2026-11-04" });
      expect(await referralRow(tx, id)).toMatchObject({
        status: "consegnata_al_paziente",
        delivered_on: "2026-11-04",
        patient_agreed_to_share: true,
        physician_id: c.gpId,
      });

      await expectDomainError(
        updateReferral(tx, PRACTICE_A, clock, update(id, { physicianId: c.gpId, patientAgreedToShare: true, urgency: "programmato" })),
        EDIT_LOCKED,
      );
      expect(EDIT_LOCKED).toBe("La lettera è già salvata: non si modifica.");
      await expectDomainError(
        markReferralDelivered(tx, PRACTICE_A, clock, { referralId: id, deliveredOn: "2026-11-04" }),
        NOT_ALLOWED,
      );
      expect(await referralRow(tx, id)).toMatchObject({ urgency: "urgente", delivered_on: "2026-11-04" });
    });
  });

  it("le regole dei campi: testi obbligatori, limiti, un medico di un altro studio", async () => {
    await inUserA(db, async (tx) => {
      const c = await roberto(tx);
      const { id } = await createReferral(tx, PRACTICE_A, clock, { patientId: c.patientId, visitId: c.visitId });
      await expectInvalid(updateReferral(tx, PRACTICE_A, clock, update(id, { summaryText: "  " })), "Campo obbligatorio.");
      await expectInvalid(
        updateReferral(tx, PRACTICE_A, clock, update(id, { summaryText: "a".repeat(3001) })),
        "Massimo 3000 caratteri.",
      );
      await expectInvalid(
        updateReferral(tx, PRACTICE_A, clock, update(id, { requestText: "a".repeat(1001) })),
        "Massimo 1000 caratteri.",
      );
      await expectDomainError(
        updateReferral(tx, PRACTICE_A, clock, update(id, { physicianId: PHYSICIAN_B })),
        NOT_ALLOWED,
      );
      await expectInvalid(updateReferral(tx, PRACTICE_A, clock, update(id, { status: "inviata" })), "Valore non valido");
      expect(await referralRow(tx, id)).toMatchObject({ reason: "red_flag", physician_id: c.gpId });
    });
  });

  it("come uB sul rinvio di A: Operazione non permessa e niente cambia", async () => {
    const { referralId } = await savedCase();
    const before = await savedReferral(referralId);
    await expectDomainError(asUserB(db, (tx) => updateReferral(tx, PRACTICE_B, clock, update(referralId))), NOT_ALLOWED);
    await expectDomainError(
      asUserB(db, (tx) => markReferralDelivered(tx, PRACTICE_B, clock, { referralId, deliveredOn: "2026-11-04" })),
      NOT_ALLOWED,
    );
    expect(await savedReferral(referralId)).toEqual(before);
  });
});

// getReferralLetter -----------------------------------------------------------------------------------

describe("getReferralLetter", () => {
  it("intestazione, destinatario, città e data, paziente, firma, nome del file; la riga dell'iscrizione solo se c'è", async () => {
    await inUserA(db, async (tx) => {
      const c = await roberto(tx);
      const { id } = await createReferral(tx, PRACTICE_A, clock, { patientId: c.patientId, visitId: c.visitId });
      await tx.query(
        `update public.practice_settings
            set address_line = 'Via dei Mille 12', postal_code = '40121', city = 'Bologna', province = 'BO',
                registration_number = null, is_demo = true
          where practice_id = $1`,
        [PRACTICE_A],
      );
      const letter = await getReferralLetter(tx, PRACTICE_A, id);
      expect(letter).toMatchObject({
        id,
        patientId: c.patientId,
        status: "bozza",
        statusLabel: "Bozza",
        editable: true,
        agreed: false,
        letterFileId: null,
        fileName: "lettera-medico-2026-11-04.pdf",
        studio: { lines: ["Via dei Mille 12, 40121 Bologna (BO)"] },
        recipient: { kind: "medico_curante", physicianId: c.gpId, free: null, text: "Dott. Luca Ferri" },
        reason: "red_flag",
        urgency: "programmato",
        dayText: "Bologna, 04/11/2026",
        patient: { name: `Roberto Esposito${caseCount}`, birthDateText: "nato il 12/03/1971" },
        requestText: DEFAULT_REQUEST_TEXT,
        signature: "Anna Rossi, Osteopata",
        demo: true,
        deliveredOn: null,
      });
      expect(letter?.summaryText).toMatch(/^Segnalo la comparsa di segni/);

      await tx.query(
        `update public.practice_settings set registration_number = '1234', registration_order = 'Ordine TSRM PSTRP di Bologna'
          where practice_id = $1`,
        [PRACTICE_A],
      );
      await tx.query("update public.patients set sex = 'f' where practice_id = $1 and id = $2", [PRACTICE_A, c.patientId]);
      await updateReferral(tx, PRACTICE_A, clock, update(id));
      const after = await getReferralLetter(tx, PRACTICE_A, id);
      expect(after?.studio.lines).toEqual([
        "Via dei Mille 12, 40121 Bologna (BO)",
        "Iscrizione n. 1234, Ordine TSRM PSTRP di Bologna",
      ]);
      expect(after?.patient.birthDateText).toBe("nata il 12/03/1971");
      expect(after?.recipient).toEqual({
        kind: "specialista",
        physicianId: null,
        free: "Dott.ssa Elena Bassi, ortopedica",
        text: "Dott.ssa Elena Bassi, ortopedica",
      });
    });
  });

  it("senza città la data è sola; un rinvio di un altro studio è null", async () => {
    await inUserA(db, async (tx) => {
      const c = await roberto(tx);
      const { id } = await createReferral(tx, PRACTICE_A, clock, { patientId: c.patientId, visitId: c.visitId });
      expect((await getReferralLetter(tx, PRACTICE_A, id))?.dayText).toBe("04/11/2026");
      expect(await getReferralLetter(tx, PRACTICE_A, REFERRAL_B)).toBeNull();
    });
  });
});

// ensureReferralPdf -----------------------------------------------------------------------------------

describe("ensureReferralPdf", () => {
  it("lettera_firma: nuova lettera legge il PNG; firma cambiata non invalida i byte congelati", async () => {
    const { referralId } = await savedCase();
    const id = randomUUID();
    const key = storageKey(PRACTICE_A, "signature", id, "image/png");
    await store.put(key, SIGNATURE);
    try {
      await asUserA(db, async tx => {
        await tx.query("insert into public.files (id,practice_id,kind,storage_key,mime_type,size_bytes,sha256) values ($1,$2,'signature',$3,'image/png',$4,$5)", [id, PRACTICE_A, key, SIGNATURE.length, sha256Of(SIGNATURE)]);
        await tx.query("update public.practice_settings set practitioner_signature_file_id=$2 where practice_id=$1", [PRACTICE_A, id]);
      });
      renderSpy.mockClear();
      const first = (await ensureReferralPdf(ctxA, clock, store, referralId))!;
      expect(renderSpy.mock.calls[0]?.[1]).toEqual(new Uint8Array(SIGNATURE));
      expect(Buffer.from(first.bytes).toString("latin1")).toMatch(/\/Subtype\s*\/Image/);
      await asUserA(db, tx => tx.query("update public.practice_settings set practitioner_signature_file_id=null where practice_id=$1", [PRACTICE_A]));
      const second = await ensureReferralPdf(ctxA, clock, store, referralId);
      expect(second?.bytes).toEqual(first.bytes);
      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(await store.get(key)).toEqual(new Uint8Array(SIGNATURE));
    } finally {
      await asUserA(db, tx => tx.query("update public.practice_settings set practitioner_signature_file_id=null where practice_id=$1", [PRACTICE_A]));
    }
  });

  it.each([false, true])("lettera_firma concorrenza: firma cambia durante render, due cambi=%s", async (twice) => {
    const { referralId } = await savedCase();
    const before = await filesOf(PRACTICE_A, "referral_pdf");
    let changed = 0;
    const images: Uint8Array[] = [];
    const hook = new HookStore(async () => {});
    const realRender = (await vi.importActual<typeof import("@/server/pdf/render")>("@/server/pdf/render")).renderReferralPdf;
    renderSpy.mockClear();
    renderSpy.mockImplementation(async (letter, signature) => {
      const bytes = await realRender(letter, signature);
      if (changed === 0 || twice) {
        changed += 1;
        const png = new Uint8Array(Buffer.concat([SIGNATURE, Buffer.from(`\n${changed}`)]));
        images.push(png);
        const id = randomUUID(); const key = storageKey(PRACTICE_A, "signature", id, "image/png");
        await hook.put(key, png);
        await asUserA(db, async tx => {
          await tx.query("insert into public.files (id,practice_id,kind,storage_key,mime_type,size_bytes,sha256) values ($1,$2,'signature',$3,'image/png',$4,$5)", [id, PRACTICE_A, key, png.length, sha256Of(png)]);
          await tx.query("update public.practice_settings set practitioner_signature_file_id=$2 where practice_id=$1", [PRACTICE_A, id]);
        });
      }
      return bytes;
    });
    try {
      if (twice) {
        await expectDomainError(ensureReferralPdf(ctxA, clock, hook, referralId), LETTER_CHANGED);
        expect((await savedReferral(referralId))?.letter_file_id).toBeNull();
        expect(await filesOf(PRACTICE_A, "referral_pdf")).toHaveLength(before.length);
        expect(hook.keys().filter(key => key.includes("/referral_pdf/"))).toEqual([]);
      } else {
        const pdf = await ensureReferralPdf(ctxA, clock, hook, referralId);
        expect(Buffer.from(pdf!.bytes).toString("latin1")).toMatch(/\/Subtype\s*\/Image/);
        expect(await filesOf(PRACTICE_A, "referral_pdf")).toHaveLength(before.length + 1);
        expect(hook.keys().filter(key => key.includes("/referral_pdf/"))).toHaveLength(1);
      }
      expect(renderSpy).toHaveBeenCalledTimes(2);
      expect(renderSpy.mock.calls[1]?.[1]).toEqual(images[0]);
      expect(hook.removed).toHaveLength(twice ? 2 : 1);
    } finally {
      renderSpy.mockImplementation(realRender);
      await asUserA(db, tx => tx.query("update public.practice_settings set practitioner_signature_file_id=null where practice_id=$1", [PRACTICE_A]));
    }
  });
  it("genera il PDF una volta, lo salva e lo congela; la seconda richiesta dà gli stessi byte", async () => {
    const { referralId } = await savedCase();
    const filesBefore = await filesOf(PRACTICE_A, "referral_pdf");

    const first = await ensureReferralPdf(ctxA, clock, store, referralId);
    expect(first?.fileName).toBe("lettera-medico-2026-11-04.pdf");
    expect(Buffer.from(first!.bytes.subarray(0, PDF_MAGIC.length)).toString("latin1")).toBe(PDF_MAGIC);

    const saved = await savedReferral(referralId);
    expect(saved?.letter_file_id).not.toBeNull();
    const files = await filesOf(PRACTICE_A, "referral_pdf");
    expect(files).toHaveLength(filesBefore.length + 1);
    const file = files.find((f) => f.id === saved?.letter_file_id);
    const key = storageKey(PRACTICE_A, "referral_pdf", saved!.letter_file_id!, "application/pdf");
    expect(file).toMatchObject({ kind: "referral_pdf", mime_type: "application/pdf", storage_key: key, size_bytes: first!.bytes.length });
    expect(store.keys()).toEqual([key]);
    expect(await store.get(key)).toEqual(first!.bytes);

    const second = await ensureReferralPdf(ctxA, clock, store, referralId);
    expect(second?.bytes).toEqual(first!.bytes);
    expect(second?.fileName).toBe("lettera-medico-2026-11-04.pdf");
    expect(await filesOf(PRACTICE_A, "referral_pdf")).toHaveLength(filesBefore.length + 1);
    expect(store.keys()).toEqual([key]);
    expect((await savedReferral(referralId))?.letter_file_id).toBe(saved?.letter_file_id);
  });

  it("dopo il PDF il contenuto non si modifica; l'assenso sì, e la lettera si consegna", async () => {
    const { referralId, gpId } = await savedCase();
    await ensureReferralPdf(ctxA, clock, store, referralId);
    const before = await savedReferral(referralId);
    await expectDomainError(asUserA(db, (tx) => updateReferral(tx, PRACTICE_A, clock, update(referralId))), EDIT_LOCKED);
    expect(await savedReferral(referralId)).toEqual(before);

    const same = {
      referralId,
      recipientKind: before!.recipient_kind,
      physicianId: gpId,
      recipientFree: before!.recipient_free,
      reason: before!.reason,
      urgency: before!.urgency,
      summaryText: before!.summary_text,
      requestText: before!.request_text,
    };
    await asUserA(db, (tx) => updateReferral(tx, PRACTICE_A, clock, { ...same, patientAgreedToShare: true }));
    await asUserA(db, (tx) => markReferralDelivered(tx, PRACTICE_A, clock, { referralId, deliveredOn: "2026-11-04" }));
    expect(await savedReferral(referralId)).toMatchObject({
      patient_agreed_to_share: true,
      status: "consegnata_al_paziente",
      delivered_on: "2026-11-04",
      summary_text: before!.summary_text,
      letter_file_id: before!.letter_file_id,
    });
    await expectDomainError(
      asUserA(db, (tx) => updateReferral(tx, PRACTICE_A, clock, { ...same, patientAgreedToShare: false })),
      EDIT_LOCKED,
    );
  });

  it("il rinvio di un altro studio come uA è null e lo store resta vuoto", async () => {
    const filesBefore = await filesOf(PRACTICE_A, "referral_pdf");
    expect(await ensureReferralPdf(ctxA, clock, store, REFERRAL_B)).toBeNull();
    expect(store.keys()).toEqual([]);
    expect(await filesOf(PRACTICE_A, "referral_pdf")).toHaveLength(filesBefore.length);
    expect((await asServiceFor(db, (tx) => referralRow(tx, REFERRAL_B)))?.letter_file_id).toBeNull();
  });

  it("lo store che fallisce non lascia righe; la richiesta dopo salva", async () => {
    const { referralId } = await savedCase();
    const filesBefore = await filesOf(PRACTICE_A, "referral_pdf");
    store.failNextPut();
    await expect(ensureReferralPdf(ctxA, clock, store, referralId)).rejects.toThrow();
    expect(store.keys()).toEqual([]);
    expect(await filesOf(PRACTICE_A, "referral_pdf")).toHaveLength(filesBefore.length);
    expect((await savedReferral(referralId))?.letter_file_id).toBeNull();

    const pdf = await ensureReferralPdf(ctxA, clock, store, referralId);
    expect(pdf?.bytes.length).toBeGreaterThan(1024);
    expect(store.keys()).toHaveLength(1);
  });

  it("due richieste insieme: la seconda toglie il suo file e serve quello salvato dalla prima", async () => {
    const { referralId } = await savedCase();
    const filesBefore = await filesOf(PRACTICE_A, "referral_pdf");
    // Le due richieste leggono la lettera senza file e scrivono il loro PDF prima che una delle due salvi.
    const race = new RaceStore();
    const [a, b] = await Promise.all([
      ensureReferralPdf(ctxA, clock, race, referralId),
      ensureReferralPdf(ctxA, clock, race, referralId),
    ]);
    expect(race.removed).toHaveLength(1);
    expect(a?.bytes).toEqual(b?.bytes);
    const saved = await savedReferral(referralId);
    const key = storageKey(PRACTICE_A, "referral_pdf", saved!.letter_file_id!, "application/pdf");
    expect(race.keys()).toEqual([key]);
    expect(race.removed[0]).not.toBe(key);
    expect(await race.get(key)).toEqual(a?.bytes);
    expect(await filesOf(PRACTICE_A, "referral_pdf")).toHaveLength(filesBefore.length + 1);
  });

  it("la lettera salvata non torna a null: 42501", async () => {
    const { referralId } = await savedCase();
    await ensureReferralPdf(ctxA, clock, store, referralId);
    await inRollback(db, "A", async (tx) => {
      await expectPgError(
        tx.query("update public.referrals set letter_file_id = null where practice_id = $1 and id = $2", [
          PRACTICE_A,
          referralId,
        ]),
        "42501",
      );
      return null;
    });
  });
});

// Lettera modificata durante il rendering e scritture concorrenti -----------------------------------------

describe("ensureReferralPdf con la lettera modificata durante il rendering", () => {
  const NEW_SUMMARY = "Segnalo un peggioramento dei sintomi, testo salvato durante il rendering, e chiedo una sua valutazione.";

  it("un Salva arrivato fra il rendering e il salvataggio: il PDF congelato nasce dal testo nuovo, un solo file", async () => {
    const { referralId } = await savedCase();
    const filesBefore = await filesOf(PRACTICE_A, "referral_pdf");
    const before = await savedReferral(referralId);
    const hook = new HookStore(async (count) => {
      if (count === 1) {
        await asUserA(db, (tx) => updateReferral(tx, PRACTICE_A, clock, update(referralId, { summaryText: NEW_SUMMARY })));
      }
    });
    renderSpy.mockClear();

    const pdf = await ensureReferralPdf(ctxA, clock, hook, referralId);

    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(renderSpy.mock.calls[0]?.[0].summaryText).toBe(before!.summary_text);
    expect(renderSpy.mock.calls[1]?.[0].summaryText).toBe(NEW_SUMMARY);
    const saved = await savedReferral(referralId);
    expect(saved?.summary_text).toBe(NEW_SUMMARY);
    const key = storageKey(PRACTICE_A, "referral_pdf", saved!.letter_file_id!, "application/pdf");
    expect(hook.keys()).toEqual([key]);
    expect(hook.removed).toHaveLength(1);
    expect(hook.removed[0]).not.toBe(key);
    expect(await hook.get(key)).toEqual(pdf?.bytes);
    expect(await filesOf(PRACTICE_A, "referral_pdf")).toHaveLength(filesBefore.length + 1);
    // Il PDF salvato è quello del testo nuovo: la lettera da qui non si modifica.
    await expectDomainError(asUserA(db, (tx) => updateReferral(tx, PRACTICE_A, clock, update(referralId))), EDIT_LOCKED);
  });

  it("la lettera cambia anche alla seconda volta: nessun file, nessuna riga, «La lettera è cambiata mentre preparavo il PDF: riprova.»", async () => {
    const { referralId } = await savedCase();
    const filesBefore = await filesOf(PRACTICE_A, "referral_pdf");
    const hook = new HookStore(async (count) => {
      await asUserA(db, (tx) =>
        updateReferral(tx, PRACTICE_A, clock, update(referralId, { summaryText: `${NEW_SUMMARY} Versione ${count}.` })),
      );
    });
    renderSpy.mockClear();

    await expectDomainError(ensureReferralPdf(ctxA, clock, hook, referralId), LETTER_CHANGED);
    expect(LETTER_CHANGED).toBe("La lettera è cambiata mentre preparavo il PDF: riprova.");
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(hook.keys()).toEqual([]);
    expect(hook.removed).toHaveLength(2);
    expect((await savedReferral(referralId))?.letter_file_id).toBeNull();
    expect(await filesOf(PRACTICE_A, "referral_pdf")).toHaveLength(filesBefore.length);

    // La richiesta dopo, senza modifiche nel mezzo, salva il PDF del testo salvato per ultimo.
    const pdf = await ensureReferralPdf(ctxA, clock, store, referralId);
    expect(pdf?.bytes.length).toBeGreaterThan(1024);
    expect(renderSpy.mock.calls[2]?.[0].summaryText).toBe(`${NEW_SUMMARY} Versione 2.`);
    expect(store.keys()).toHaveLength(1);
  });
});

describe("updateReferral: le scritture ripetono le condizioni lette (read committed)", () => {
  it("una consegna salvata fra la lettura e l'update del contenuto: «La lettera è già salvata: non si modifica.»", async () => {
    await inUserA(db, async (tx) => {
      const c = await roberto(tx);
      const { id } = await createReferral(tx, PRACTICE_A, clock, { patientId: c.patientId, visitId: c.visitId });
      await updateReferral(tx, PRACTICE_A, clock, update(id, { patientAgreedToShare: true }));
      const racing = interleaved(
        tx,
        "update public.referrals set status = 'consegnata_al_paziente', delivered_on = '2026-11-04' where id = $1",
        [id],
      );
      await expectDomainError(
        updateReferral(racing, PRACTICE_A, clock, update(id, { patientAgreedToShare: true, urgency: "programmato" })),
        EDIT_LOCKED,
      );
      expect(await referralRow(tx, id)).toMatchObject({ status: "consegnata_al_paziente", urgency: "urgente" });
    });
  });

  it("una consegna salvata fra la lettura e l'update del solo assenso: «La lettera è già salvata: non si modifica.»", async () => {
    const { referralId, gpId } = await savedCase();
    await ensureReferralPdf(ctxA, clock, store, referralId);
    const before = await savedReferral(referralId);
    await inUserA(db, async (tx) => {
      const racing = interleaved(
        tx,
        `update public.referrals set patient_agreed_to_share = true, status = 'consegnata_al_paziente',
                delivered_on = '2026-11-04' where id = $1`,
        [referralId],
      );
      await expectDomainError(
        updateReferral(racing, PRACTICE_A, clock, {
          referralId,
          recipientKind: before!.recipient_kind,
          physicianId: gpId,
          recipientFree: before!.recipient_free,
          reason: before!.reason,
          urgency: before!.urgency,
          summaryText: before!.summary_text,
          requestText: before!.request_text,
          patientAgreedToShare: false,
        }),
        EDIT_LOCKED,
      );
      expect(await referralRow(tx, referralId)).toMatchObject({
        status: "consegnata_al_paziente",
        patient_agreed_to_share: true,
      });
      return null;
    });
  });
});

describe("markReferralDelivered: il giorno della consegna", () => {
  it("mai nel futuro né prima della lettera, sul campo deliveredOn; oggi passa", async () => {
    await inUserA(db, async (tx) => {
      const c = await roberto(tx);
      const { id } = await createReferral(tx, PRACTICE_A, clock, { patientId: c.patientId, visitId: c.visitId });
      await updateReferral(tx, PRACTICE_A, clock, update(id, { patientAgreedToShare: true }));

      const future = await rejectionOf(
        markReferralDelivered(tx, PRACTICE_A, clock, { referralId: id, deliveredOn: "2026-11-05" }),
      );
      expect(isDomainError(future)).toBe(true);
      expect((future as Error).message).toBe(DELIVERY_IN_FUTURE);
      expect((future as { field?: string }).field).toBe("deliveredOn");
      expect(DELIVERY_IN_FUTURE).toBe("La consegna non può essere nel futuro.");

      const early = await rejectionOf(
        markReferralDelivered(tx, PRACTICE_A, clock, { referralId: id, deliveredOn: "2026-11-03" }),
      );
      expect(isDomainError(early)).toBe(true);
      expect((early as Error).message).toBe(DELIVERY_BEFORE_LETTER);
      expect((early as { field?: string }).field).toBe("deliveredOn");
      expect(DELIVERY_BEFORE_LETTER).toBe("La consegna non può precedere la lettera.");
      expect(await referralRow(tx, id)).toMatchObject({ status: "bozza", delivered_on: null });

      await markReferralDelivered(tx, PRACTICE_A, clock, { referralId: id, deliveredOn: "2026-11-04" });
      expect(await referralRow(tx, id)).toMatchObject({ status: "consegnata_al_paziente", delivered_on: "2026-11-04" });
    });
  });
});
