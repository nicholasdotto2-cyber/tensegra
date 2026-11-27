import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { NOT_ALLOWED } from "@/server/domain/errors";
import { createPatient } from "@/server/domain/patients/commands";
import { searchPatients } from "@/server/domain/patients/queries";
import { getPracticeSettings, hasMessagePreviewPatients } from "@/server/domain/settings/queries";
import { APPOINTMENT_A, CYCLE_A, PATIENT_A1, PATIENT_A2, PRACTICE_A, PRACTICE_B, SERVICE_A, VISIT_A } from "./fixtures";
import { asServiceFor, asUserB, inUserA, openTestDb } from "./helpers";

const clock = fixedClock("2026-10-22T08:30:00+02:00");
const api = async () => ({
  ...(await import("@/server/domain/messages/commands")),
  ...(await import("@/server/domain/messages/queries")),
  ...(await import("@/server/domain/settings/commands")),
});
let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

const templates = (tx: Tx) => tx.query(
  "select key, variant, body, is_customized, created_at, created_by from public.message_templates where practice_id = $1 order by key, variant", [PRACTICE_A],
);
const logs = (tx: Tx) => tx.query(
  `select id, practice_id, patient_id, appointment_id, visit_id, template_key, recipient_kind, recipient_name,
          recipient_phone, body, action, outcome, outcome_at, created_at, updated_at, created_by
     from public.message_log order by id`,
);
const previewInput = { key: "conferma", variant: "lei", body: "Buongiorno {nome}, {quando} alle {ora} ({durata}).", patientId: PATIENT_A1 };
async function appointment(tx: Tx, startsAt: string, status: string) {
  const id = randomUUID();
  await tx.query(
    `insert into public.appointments (id, practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents, status, cancel_reason)
     values ($1, $2, $3, $4, $5, $6, 45, 6000, $7, case when $7 = 'annullato' then 'paziente' else null end)`,
    [id, PRACTICE_A, PATIENT_A1, SERVICE_A, CYCLE_A, startsAt, status],
  );
  return id;
}
async function visit(tx: Tx, day: string, advice?: string) {
  const appointmentId = await appointment(tx, `${day}T08:00:00Z`, "fatto");
  const id = randomUUID();
  await tx.query(
    `insert into public.visits (id, practice_id, patient_id, cycle_id, appointment_id, visit_date, kind, screening_catalog_version)
     values ($1, $2, $3, $4, $5, $6, 'seduta', 1)`, [id, PRACTICE_A, PATIENT_A1, CYCLE_A, appointmentId, day],
  );
  if (advice) await tx.query("insert into public.visit_advice (practice_id, visit_id, text) values ($1, $2, $3)", [PRACTICE_A, id, advice]);
  return id;
}

describe("Impostazioni Messaggi", () => {
  it("selettore anteprima: si cerca qualunque paziente attivo, anche senza appuntamenti, isolato per studio", async () => inUserA(db, async (tx) => {
    // 22 pazienti con un appuntamento futuro e un ventitreesimo senza: è il caso dell'anteprima senza contesto.
    const created: string[] = [];
    for (let n = 1; n <= 23; n++) {
      const { id } = await createPatient(tx, PRACTICE_A, clock, { firstName: "Prova", lastName: `Paziente ${String(n).padStart(2, "0")}`, birthDate: "1990-01-01" });
      if (n <= 22) {
        const cycleId = randomUUID();
        await tx.query("insert into public.treatment_cycles (id, practice_id, patient_id, opened_on, title, expected_sessions) values ($1, $2, $3, '2026-10-22', 'Ciclo di prova', 4)", [cycleId, PRACTICE_A, id]);
        await tx.query(
          `insert into public.appointments (practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents)
           values ($1, $2, $3, $4, $5, 45, 6000)`, [PRACTICE_A, id, SERVICE_A, cycleId, `2026-11-${String(n).padStart(2, "0")}T08:00:00Z`],
        );
      }
      created.push(id);
    }
    const archived = created.splice(4, 1)[0]!;
    await tx.query("update public.patients set archived_at = $2 where id = $1", [archived, clock.now()]);
    // Nessun elenco intero, si cerca con la ricerca dell'agenda; l'azione toglie gli archiviati.
    const find = async (text: string) => (await searchPatients(tx, PRACTICE_A, text)).filter((p) => !p.archived).map((p) => p.id);
    expect(await find("paziente 23")).toEqual([created.at(-1)]);
    expect(await find("Paziente 01")).toEqual([created[0]]);
    expect(await find("Paziente 05")).toEqual([]);
    expect(await find("Pa")).toEqual([]);
    expect(await find("Paziente _1")).toEqual([]);
    expect(await find("Paziente 1")).toHaveLength(8);
    expect(await hasMessagePreviewPatients(tx, PRACTICE_A)).toBe(true);
    expect(await searchPatients(tx, PRACTICE_B, "Paziente")).toEqual([]);
    expect(await hasMessagePreviewPatients(tx, PRACTICE_B)).toBe(false);
  }));

  it("consigli preview: visita reale, registro e canali invariati", async () => inUserA(db, async (tx) => {
    const a = await api();
    const visitId = await visit(tx, "2026-10-21", "Cammina per dieci minuti.");
    await tx.query("update public.visit_advice set communicated_via = array['a_voce', 'foglio_stampato'] where visit_id = $1", [visitId]);
    const advice = () => tx.query("select id, visit_id, communicated_via from public.visit_advice order by id");
    const beforeLogs = await logs(tx);
    const beforeAdvice = await advice();
    expect(await a.previewMessageTemplate(tx, PRACTICE_A, clock, { ...previewInput, key: "consigli", body: "{consigli}" })).toEqual({ text: "Cammina per dieci minuti.", missing: [] });
    expect(await logs(tx)).toEqual(beforeLogs);
    expect(await advice()).toEqual(beforeAdvice);
  }));

  it("template_salva_ripristina", async () => inUserA(db, async (tx) => {
    const a = await api();
    expect(a.saveMessageTemplate).toBeTypeOf("function");
    const originalLei = "Buongiorno {nome}, le confermo l'appuntamento{per_paziente} di {quando} alle {ora}, in {indirizzo}. Per qualsiasi imprevisto può scrivermi a questo numero. {osteopata}, {studio}";
    await a.saveMessageTemplate(tx, PRACTICE_A, clock, { key: "conferma", variant: "tu", body: "Ciao {nome}, testo Tu conservato." });
    await a.saveMessageTemplate(tx, PRACTICE_A, clock, { key: "conferma", variant: "lei", body: "Buongiorno {nome}, testo personalizzato." });
    const customized = await a.listMessageTemplates(tx, PRACTICE_A);
    expect(customized).toHaveLength(10);
    expect(customized.find((t) => t.key === "conferma" && t.variant === "lei")).toEqual({ key: "conferma", variant: "lei", body: "Buongiorno {nome}, testo personalizzato.", isCustomized: true });
    expect(await tx.query("select is_customized from public.message_templates where practice_id = $1 and key = 'conferma' and variant = 'lei'", [PRACTICE_A])).toEqual([{ is_customized: true }]);
    await a.restoreMessageTemplate(tx, PRACTICE_A, clock, { key: "conferma", variant: "lei" });
    expect((await a.listMessageTemplates(tx, PRACTICE_A)).filter((t) => t.key === "conferma")).toEqual([
      { key: "conferma", variant: "tu", body: "Ciao {nome}, testo Tu conservato.", isCustomized: true },
      { key: "conferma", variant: "lei", body: originalLei, isCustomized: false },
    ]);
    expect(await tx.query("select body, is_customized from public.message_templates where practice_id = $1 and key = 'conferma' and variant = 'lei'", [PRACTICE_A])).toEqual([{ body: originalLei, is_customized: false }]);
  }));

  it.each([
    ["Ciao {nme}", "Segnaposto non riconosciuto: {nme}."],
    ["{consigli}", "Segnaposto non riconosciuto: {consigli}."],
    ["a".repeat(701), "Il modello supera i 700 caratteri."],
    ["\u{1D11E}".repeat(701), "Il modello supera i 700 caratteri."],
  ])("template_salva_ripristina: rifiuta senza scrivere (%#)", async (body, error) => inUserA(db, async (tx) => {
    const a = await api();
    expect(a.saveMessageTemplate).toBeTypeOf("function");
    const before = await templates(tx);
    await expect(a.saveMessageTemplate(tx, PRACTICE_A, clock, { key: "conferma", variant: "lei", body })).rejects.toThrow(error);
    expect(await templates(tx)).toEqual(before);
  }));

  it.each(["a".repeat(700), "\u{1D11E}".repeat(700)])("template_salva_ripristina: 700 code points accettati (%#)", async (body) => inUserA(db, async (tx) => {
    const a = await api();
    expect(a.saveMessageTemplate).toBeTypeOf("function");
    await a.saveMessageTemplate(tx, PRACTICE_A, clock, { key: "conferma", variant: "lei", body });
    expect((await a.listMessageTemplates(tx, PRACTICE_A)).find((t) => t.key === "conferma" && t.variant === "lei")).toMatchObject({ body, isCustomized: true });
  }));

  it("preview_variante: Lei su Chiara Tu, prossimo appuntamento e nessun log", async () => inUserA(db, async (tx) => {
    const a = await api();
    expect(a.previewMessageTemplate).toBeTypeOf("function");
    await tx.query("update public.patients set first_name = 'Chiara', addressing = 'tu' where id = $1", [PATIENT_A1]);
    await tx.query("update public.appointments set starts_at = '2026-10-23T08:00:00Z', status = 'confermato' where id = $1", [APPOINTMENT_A]);
    await appointment(tx, "2026-10-20T08:00:00Z", "prenotato");
    await appointment(tx, "2026-10-22T08:00:00Z", "annullato");
    await appointment(tx, "2026-10-26T08:00:00Z", "prenotato");
    const before = await logs(tx);
    for (const key of ["conferma", "promemoria", "spostamento"]) {
      expect(await a.previewMessageTemplate(tx, PRACTICE_A, clock, { ...previewInput, key })).toEqual({ text: "Buongiorno Chiara, domani, venerdì 23 ottobre, alle 10:00 (45 minuti).", missing: [] });
    }
    expect(await logs(tx)).toEqual(before);
  }));

  it("preview_variante: contesti assenti vuoti e mancanti, nessuna data inventata", async () => inUserA(db, async (tx) => {
    const a = await api();
    expect(a.previewMessageTemplate).toBeTypeOf("function");
    const before = await logs(tx);
    expect(await a.previewMessageTemplate(tx, PRACTICE_A, clock, { ...previewInput, patientId: PATIENT_A2, body: "{quando}|{ora}|{durata}" })).toEqual({ text: "||", missing: ["quando", "ora", "durata"] });
    expect(await a.previewMessageTemplate(tx, PRACTICE_A, clock, { ...previewInput, key: "richiamo", patientId: PATIENT_A2, body: "{settimane}" })).toEqual({ text: "", missing: ["settimane"] });
    expect(await a.previewMessageTemplate(tx, PRACTICE_A, clock, { ...previewInput, key: "consigli", patientId: PATIENT_A2, body: "{consigli}" })).toEqual({ text: "", missing: ["consigli"] });
    expect(await logs(tx)).toEqual(before);
  }));

  it("preview_variante: ultimo fatto e ultima visita con consigli, input strict", async () => inUserA(db, async (tx) => {
    const a = await api();
    expect(a.previewMessageTemplate).toBeTypeOf("function");
    await tx.query("update public.appointments set status = 'fatto' where id = $1", [APPOINTMENT_A]);
    expect(await a.previewMessageTemplate(tx, PRACTICE_A, clock, { ...previewInput, key: "richiamo", body: "{settimane}" })).toEqual({ text: "2", missing: [] });
    await tx.query("update public.visit_advice set text = 'Cammina per dieci minuti.' where visit_id = $1", [VISIT_A]);
    expect(await a.previewMessageTemplate(tx, PRACTICE_A, clock, { ...previewInput, key: "consigli", body: "{consigli}" })).toEqual({ text: "Cammina per dieci minuti.", missing: [] });
    await visit(tx, "2026-10-10", "Consiglio più vecchio.");
    const latestAdviceVisit = await visit(tx, "2026-10-15", "Continua a camminare.");
    await visit(tx, "2026-10-20"); // Visita più recente senza consigli: non è la sorgente dei consigli.
    await appointment(tx, "2026-10-29T08:00:00Z", "confermato");
    expect(await a.previewMessageTemplate(tx, PRACTICE_A, clock, { ...previewInput, key: "richiamo", body: "{settimane}" })).toEqual({ text: "0", missing: [] });
    expect(await a.previewMessageTemplate(tx, PRACTICE_A, clock, { ...previewInput, key: "consigli", body: "{consigli}" })).toEqual({ text: "Continua a camminare.", missing: [] });
    const longAdvice = "\u{1D11E}".repeat(701);
    await tx.query("update public.visit_advice set text = $2 where visit_id = $1", [latestAdviceVisit, longAdvice]);
    expect(await a.previewMessageTemplate(tx, PRACTICE_A, clock, { ...previewInput, key: "consigli", body: "{consigli}" })).toEqual({ text: longAdvice, missing: [] });
    await expect(a.previewMessageTemplate(tx, PRACTICE_A, clock, { ...previewInput, appointmentId: APPOINTMENT_A })).rejects.toThrow();
  }));

  it("preview_variante: uB sul paziente A non ottiene dati e non scrive", async () => {
    const a = await api();
    expect(a.previewMessageTemplate).toBeTypeOf("function");
    const before = await asServiceFor(db, logs);
    const beforeTemplates = await asServiceFor(db, templates);
    await expect(asUserB(db, (tx) => a.previewMessageTemplate(tx, PRACTICE_A, clock, previewInput))).rejects.toThrow(NOT_ALLOWED);
    await expect(asUserB(db, (tx) => a.previewMessageTemplate(tx, PRACTICE_B, clock, previewInput))).rejects.toThrow(NOT_ALLOWED);
    await expect(asUserB(db, (tx) => a.saveMessageTemplate(tx, PRACTICE_A, clock, { key: "conferma", variant: "lei", body: "Estraneo" }))).rejects.toThrow(NOT_ALLOWED);
    await expect(asUserB(db, (tx) => a.restoreMessageTemplate(tx, PRACTICE_A, clock, { key: "conferma", variant: "lei" }))).rejects.toThrow(NOT_ALLOWED);
    await expect(asUserB(db, (tx) => a.saveCommunicationSettings(tx, PRACTICE_A, clock, { section: "messaggi", defaultAddressing: "tu" }))).rejects.toThrow(NOT_ALLOWED);
    expect(await asUserB(db, (tx) => a.listMessageTemplates(tx, PRACTICE_A))).toEqual([]);
    expect(await asServiceFor(db, templates)).toEqual(beforeTemplates);
    expect(await asServiceFor(db, logs)).toEqual(before);
  });

  it("tono_default: tu/lei per i nuovi pazienti, esistenti invariati", async () => inUserA(db, async (tx) => {
    const a = await api();
    expect(a.saveCommunicationSettings).toBeTypeOf("function");
    const existing = () => tx.query("select id, addressing from public.patients where practice_id = $1 and id = any($2::uuid[]) order by id", [PRACTICE_A, [PATIENT_A1, PATIENT_A2]]);
    const before = await existing();
    for (const defaultAddressing of ["tu", "lei"] as const) {
      await a.saveCommunicationSettings(tx, PRACTICE_A, clock, { section: "messaggi", defaultAddressing });
      expect((await getPracticeSettings(tx, PRACTICE_A))?.defaultAddressing).toBe(defaultAddressing);
      expect(await existing()).toEqual(before);
      const created = await createPatient(tx, PRACTICE_A, clock, { firstName: "Paziente", lastName: "Prova", birthDate: "1990-01-01" });
      expect(await tx.query("select addressing from public.patients where id = $1", [created.id])).toEqual([{ addressing: defaultAddressing }]);
    }
    await expect(a.saveCommunicationSettings(tx, PRACTICE_A, clock, { section: "messaggi", defaultAddressing: "tu", practiceId: PRACTICE_A })).rejects.toThrow();
    await expect(a.saveCommunicationSettings(tx, PRACTICE_A, clock, { section: "consensi", defaultAddressing: "tu" })).rejects.toThrow();
  }));
});
