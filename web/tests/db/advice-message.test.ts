import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { updateCycleOpening } from "@/server/domain/cycles/commands";
import { NOT_ALLOWED } from "@/server/domain/errors";
import type { MessageSource } from "@/server/domain/messages/schemas";
import { amendVisit, closeVisit, editVisit } from "@/server/domain/visits/commands";
import { getVisitEditor } from "@/server/domain/visits/editor";
import { EditVisitInput } from "@/server/domain/visits/schemas";
import { CYCLE_A, PATIENT_A1, PRACTICE_A, VISIT_A } from "./fixtures";
import { asUserA, expectPgError, inUserA, openTestDb } from "./helpers";

// I consigli copiati come messaggio. Il registro e
// l'aggiunta di `messaggio_copiato` stanno nella stessa transazione: in bozza con `editVisit`, sulla visita chiusa
// con `amendVisit` e il motivo fisso, mai con un UPDATE diretto sulle figlie (42501). La fixture: VISIT_A di Giulia
// Ferrari (A1, informativa valida e WhatsApp accettato), in bozza il 5/10, con un consiglio scritto senza modello
// (`template_code` null, ADVICE_A) e una rettifica di fixture.
const clock = fixedClock("2026-10-22T08:30:00+02:00");
const later = fixedClock("2026-10-22T18:03:00+02:00");
const REASON = "Registrata la preparazione del messaggio con i consigli.";
const NO_WHATSAPP = "Manca il consenso WhatsApp";
const ADVICE_A = "a0000000-0000-4000-8000-000000000608";
const ALWAYS = ["ci_sistemica", "ci_locale", "rf_rachide"] as const;
const api = () => import("@/server/domain/messages/commands");
const advice = () => import("@/server/domain/messages/advice");

let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

const run = (tx: Tx, op: Record<string, unknown>) => editVisit(tx, PRACTICE_A, clock, { visitId: VISIT_A, op });

/** Tre consigli da modello su VISIT_A: camminata col testo del modello, pause attive ritoccate su due canali, idratazione. */
async function threeAdvice(tx: Tx): Promise<{ walk: string; breaks: string; water: string }> {
  await run(tx, { op: "consiglio", templateCode: "camminata", text: null, communicatedVia: ["a_voce"] });
  await run(tx, { op: "consiglio", templateCode: "pause_attive", text: "Alzati ogni 45 minuti.", communicatedVia: ["a_voce", "foglio_stampato"] });
  await run(tx, { op: "consiglio", templateCode: "idratazione_riposo", text: null, communicatedVia: ["a_voce"] });
  const rows = await tx.query<{ id: string; templateCode: string }>(
    `select id, template_code as "templateCode" from public.visit_advice where visit_id = $1 and template_code is not null`,
    [VISIT_A],
  );
  const id = (code: string) => rows.find((r) => r.templateCode === code)?.id ?? "";
  return { walk: id("camminata"), breaks: id("pause_attive"), water: id("idratazione_riposo") };
}

/** VISIT_A chiusa: apertura del ciclo, screening confermato, poi «Chiudi la visita». */
async function closeVisitA(tx: Tx): Promise<void> {
  await updateCycleOpening(tx, PRACTICE_A, clock, {
    cycleId: CYCLE_A,
    chiefComplaint: "Dolore lombare da due settimane",
    mainRegion: "lumbar",
    goal: "Stare seduta un'ora senza dolore",
    expectedSessions: 4,
  });
  for (const group of ALWAYS) await run(tx, { op: "nessun_altra_voce", group });
  await run(tx, {
    op: "esiti",
    outcomes: ["thrust", "direct", "indirect"].map((family) => ({ family, outcome: "indicated", overrideNote: null })),
  });
  await closeVisit(tx, PRACTICE_A, clock, { visitId: VISIT_A, confirmCopied: false, alsoMarkDone: false });
}

const source = (adviceIds: string[]): MessageSource => ({ kind: "visit", visitId: VISIT_A, adviceIds, templateKey: "consigli" });

async function copy(tx: Tx, adviceIds: string[], input: Record<string, unknown> = {}, at = clock) {
  return (await api()).recordMessage(tx, PRACTICE_A, at, {
    id: randomUUID(), source: source(adviceIds), body: "Ciao Giulia, i consigli di oggi.", action: "copiato", ...input,
  });
}

async function adviceRows(tx: Tx) {
  return tx.query<{ id: string; templateCode: string | null; text: string; communicatedVia: string[]; copied: boolean }>(
    `select id, template_code as "templateCode", text, communicated_via as "communicatedVia", copied
       from public.visit_advice where visit_id = $1 order by id`,
    [VISIT_A],
  );
}
const channelsOf = async (tx: Tx, id: string) => (await adviceRows(tx)).find((r) => r.id === id)?.communicatedVia;
const amendments = (tx: Tx) =>
  tx.query<{ reason: string; amendedAt: Date }>(
    `select reason, amended_at as "amendedAt" from public.visit_amendments where visit_id = $1 order by amended_at, id`,
    [VISIT_A],
  );
const logCount = async (tx: Tx) => (await tx.query<{ n: number }>("select count(*)::int as n from public.message_log"))[0]?.n ?? 0;
const status = async (tx: Tx) => (await tx.query<{ status: string }>("select status from public.visits where id = $1", [VISIT_A]))[0]?.status;
const editorOf = async (tx: Tx) => (await getVisitEditor(tx, PRACTICE_A, clock, PATIENT_A1, VISIT_A))!;
const revokeWhatsapp = (tx: Tx) =>
  tx.query(
    "insert into public.consent_choices (practice_id, patient_id, choice, value, decided_on, mode) values ($1, $2, 'whatsapp', false, '2026-10-22', 'verbale')",
    [PRACTICE_A, PATIENT_A1],
  );

/** Tutto ciò che una copia cambierebbe: righe dei consigli, rettifiche, registro e stato della visita. */
const snapshot = async (tx: Tx) => ({ advice: await adviceRows(tx), amendments: await amendments(tx), logs: await logCount(tx), status: await status(tx) });

describe("consigli copiati come messaggio", () => {
  it("consigli_chiusa", async () => inUserA(db, async (tx) => {
    const { walk, breaks, water } = await threeAdvice(tx);
    await closeVisitA(tx);
    const before = await adviceRows(tx);
    const amendedBefore = (await amendments(tx)).length;
    const logsBefore = await logCount(tx);
    expect(await editorOf(tx)).toMatchObject({ canCopyAdvice: true, adviceCopyReason: null });

    const { id } = await copy(tx, [walk, breaks], {}, later);

    const after = await adviceRows(tx);
    // Il canale si aggiunge alle sole righe scelte; a voce, foglio, testo, modello e copied restano.
    expect(after.find((r) => r.id === walk)).toEqual({ ...before.find((r) => r.id === walk), communicatedVia: ["a_voce", "messaggio_copiato"] });
    expect(after.find((r) => r.id === breaks)).toEqual({
      ...before.find((r) => r.id === breaks), text: "Alzati ogni 45 minuti.", communicatedVia: ["a_voce", "foglio_stampato", "messaggio_copiato"],
    });
    expect(after.find((r) => r.id === water)).toEqual(before.find((r) => r.id === water));
    expect(after.find((r) => r.id === ADVICE_A)).toEqual(before.find((r) => r.id === ADVICE_A));
    // Una rettifica con il motivo fisso e l'istante del clock, e una riga del registro con la visita.
    const amended = await amendments(tx);
    expect(amended).toHaveLength(amendedBefore + 1);
    expect(amended.at(-1)).toEqual({ reason: REASON, amendedAt: later.now() });
    const [audit] = await tx.query<{ changes: unknown[] }>(
      "select changes from public.visit_amendments where visit_id = $1 and reason = $2 and amended_at = $3",
      [VISIT_A, REASON, later.now()],
    );
    expect(audit?.changes).toHaveLength(2);
    expect(audit?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        op: "consiglio",
        before: expect.objectContaining({ templateCode: "camminata", communicatedVia: ["a_voce"] }),
        after: expect.objectContaining({ adviceId: walk, templateCode: "camminata", communicatedVia: ["a_voce", "messaggio_copiato"] }),
      }),
      {
        op: "consiglio",
        before: { templateCode: "pause_attive", text: "Alzati ogni 45 minuti.", communicatedVia: ["a_voce", "foglio_stampato"] },
        after: { adviceId: breaks, templateCode: "pause_attive", text: "Alzati ogni 45 minuti.", communicatedVia: ["a_voce", "foglio_stampato", "messaggio_copiato"] },
      },
    ]));
    expect(await logCount(tx)).toBe(logsBefore + 1);
    const [log] = await tx.query<Record<string, unknown>>(
      "select patient_id, appointment_id, visit_id, template_key, action, outcome from public.message_log where id = $1",
      [id],
    );
    expect(log).toEqual({ patient_id: PATIENT_A1, appointment_id: null, visit_id: VISIT_A, template_key: "consigli", action: "copiato", outcome: "da_confermare" });
    expect(await status(tx)).toBe("closed");
    // Anche «Apri WhatsApp» è un uso: aggiunge il canale alla riga che ancora non l'ha.
    await tx.query("update public.patients set phone = '+393330000077', preferred_channel = 'whatsapp' where id = $1", [PATIENT_A1]);
    await copy(tx, [water], { action: "whatsapp_aperto" });
    expect(await channelsOf(tx, water)).toEqual(["a_voce", "messaggio_copiato"]);
    expect(await amendments(tx)).toHaveLength(amendedBefore + 2);
  }));

  it("consigli_bozza: copia solo le righe scelte senza rettifica e conserva gli altri campi", async () => inUserA(db, async (tx) => {
    const { walk, breaks, water } = await threeAdvice(tx);
    const before = await adviceRows(tx);
    const amendedBefore = await amendments(tx);
    const logsBefore = await logCount(tx);
    const { id } = await copy(tx, [walk, breaks], {}, later);

    expect(await status(tx)).toBe("draft");
    expect(await amendments(tx)).toEqual(amendedBefore);
    const after = await adviceRows(tx);
    expect(after.find((r) => r.id === walk)).toEqual({ ...before.find((r) => r.id === walk), communicatedVia: ["a_voce", "messaggio_copiato"] });
    expect(after.find((r) => r.id === breaks)).toEqual({ ...before.find((r) => r.id === breaks), communicatedVia: ["a_voce", "foglio_stampato", "messaggio_copiato"] });
    expect(after.find((r) => r.id === water)).toEqual(before.find((r) => r.id === water));
    expect(after.find((r) => r.id === ADVICE_A)).toEqual(before.find((r) => r.id === ADVICE_A));
    expect(await logCount(tx)).toBe(logsBefore + 1);
    const [log] = await tx.query<Record<string, unknown>>(
      "select visit_id, patient_id, template_key, action, outcome from public.message_log where id = $1", [id],
    );
    expect(log).toEqual({ visit_id: VISIT_A, patient_id: PATIENT_A1, template_key: "consigli", action: "copiato", outcome: "da_confermare" });
  }));

  it("consiglio_senza_modello_rifiutato", async () => inUserA(db, async (tx) => {
    const { walk } = await threeAdvice(tx);
    await closeVisitA(tx);
    const before = await snapshot(tx);
    // ADVICE_A è un consiglio scritto senza modello: la riga scelta rifiuta tutto, prima di registro e visita.
    await expect(copy(tx, [walk, ADVICE_A])).rejects.toThrow(NOT_ALLOWED);
    expect(await snapshot(tx)).toEqual(before);
    await expect((await advice()).markAdviceMessagePrepared(tx, PRACTICE_A, clock, { visitId: VISIT_A, adviceIds: [ADVICE_A] })).rejects.toThrow(NOT_ALLOWED);
    expect(await snapshot(tx)).toEqual(before);
  }));

  it("rollback_log", async () => {
    // Una transazione che si salva davvero, su un database solo suo: dopo l'errore si rilegge ciò che è rimasto.
    const own = await openTestDb();
    try {
      const ids = await asUserA(own.db, async (tx) => {
        const rows = await threeAdvice(tx);
        await closeVisitA(tx);
        return rows;
      });
      const before = await inUserA(own.db, snapshot);
      const failing = (target: Tx): Tx => ({
        query: (text, params) => (text.includes("insert into public.message_log")
          ? Promise.reject(new Error("registro non scritto"))
          : target.query(text, params)),
      });
      await expect(asUserA(own.db, (tx) => copy(failing(tx), [ids.walk, ids.breaks]))).rejects.toThrow("registro non scritto");
      expect(await inUserA(own.db, snapshot)).toEqual(before);
      expect(before.status).toBe("closed");
    } finally {
      await own.pg.close();
    }
  });

  it("retry_stesso_id", async () => inUserA(db, async (tx) => {
    const { walk, breaks } = await threeAdvice(tx);
    await closeVisitA(tx);
    const amendedBefore = (await amendments(tx)).length;
    const logsBefore = await logCount(tx);
    const id = randomUUID();
    expect(await copy(tx, [walk, breaks], { id })).toEqual({ id });
    expect(await copy(tx, [walk, breaks], { id }, later)).toEqual({ id });
    expect(await amendments(tx)).toHaveLength(amendedBefore + 1);
    expect(await logCount(tx)).toBe(logsBefore + 1);
    // Una copia nuova è una riga nuova del registro; il canale c'è già e resta uno, senza un'altra rettifica.
    await copy(tx, [walk, breaks]);
    expect(await logCount(tx)).toBe(logsBefore + 2);
    expect(await channelsOf(tx, walk)).toEqual(["a_voce", "messaggio_copiato"]);
    expect(await channelsOf(tx, breaks)).toEqual(["a_voce", "foglio_stampato", "messaggio_copiato"]);
    expect(await amendments(tx)).toHaveLength(amendedBefore + 1);
  }));

  it.each(["revoca", "senza_informativa"] as const)("revoca_canale: %s", async (kind) => inUserA(db, async (tx) => {
    const { walk } = await threeAdvice(tx);
    if (kind === "revoca") await revokeWhatsapp(tx);
    else {
      await tx.query(
        "update public.consent_records set status = 'revocato', revoked_on = '2026-10-22', revocation_mode = 'verbale' where patient_id = $1 and module_key = 'informativa'",
        [PATIENT_A1],
      );
    }
    expect(await editorOf(tx)).toMatchObject({ canCopyAdvice: false, adviceCopyReason: NO_WHATSAPP });
    const draft = await snapshot(tx);
    await expect(copy(tx, [walk])).rejects.toThrow(NO_WHATSAPP);
    await expect(copy(tx, [walk], { action: "whatsapp_aperto" })).rejects.toThrow(NO_WHATSAPP);
    expect(await snapshot(tx)).toEqual(draft);
    await closeVisitA(tx);
    const closed = await snapshot(tx);
    await expect(copy(tx, [walk])).rejects.toThrow(NO_WHATSAPP);
    expect(await snapshot(tx)).toEqual(closed);
  }));

  it("manuale_messaggio_copiato", async () => {
    const input = (communicatedVia: string[]) => ({ visitId: VISIT_A, op: { op: "consiglio", templateCode: "camminata", text: null, communicatedVia } });
    expect(EditVisitInput.safeParse(input(["a_voce", "messaggio_copiato"])).success).toBe(true);
    expect(EditVisitInput.safeParse(input(["messaggio_copiato"])).success).toBe(true);
    expect(EditVisitInput.safeParse(input([])).success).toBe(false);

    const walkId = await inUserA(db, async (tx) => {
      const { walk } = await threeAdvice(tx);
      const logsBefore = await logCount(tx);
      // In bozza la scelta a mano passa da editVisit: cambia il canale e non inventa una copia nel registro.
      await run(tx, { op: "consiglio", adviceId: walk, templateCode: "camminata", text: null, communicatedVia: ["messaggio_copiato"] });
      expect(await channelsOf(tx, walk)).toEqual(["messaggio_copiato"]);
      await closeVisitA(tx);
      // Sulla visita chiusa la passa amendVisit, con il motivo di chi rettifica.
      const amendedBefore = (await amendments(tx)).length;
      await amendVisit(tx, PRACTICE_A, clock, {
        visitId: VISIT_A,
        reason: "Il messaggio l'ho mandato dal telefono",
        ops: [{ op: "consiglio", adviceId: walk, templateCode: "camminata", text: null, communicatedVia: ["a_voce", "messaggio_copiato"] }],
      });
      expect(await channelsOf(tx, walk)).toEqual(["a_voce", "messaggio_copiato"]);
      expect(await amendments(tx)).toHaveLength(amendedBefore + 1);
      expect(await logCount(tx)).toBe(logsBefore);
      return walk;
    });
    expect(walkId).toBeTruthy();
    // Un UPDATE diretto su un consiglio di una visita chiusa resta rifiutato dal trigger.
    await expectPgError(
      inUserA(db, async (tx) => {
        const { walk } = await threeAdvice(tx);
        await closeVisitA(tx);
        await tx.query("update public.visit_advice set communicated_via = '{a_voce,messaggio_copiato}' where id = $1", [walk]);
      }),
      "42501",
    );
  });
});
