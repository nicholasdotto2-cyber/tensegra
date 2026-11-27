import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { missingModules } from "@/lib/consents/required";
import { fixedClock, romeDateTime } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { getAppointmentDetail, listDayAppointments } from "@/server/domain/appointments/queries";
import * as queries from "@/server/domain/consents/queries";
import { getPatientHeader, getSummaryTab, listPatientConsents } from "@/server/domain/patients/card";
import { consentCell, loadPatientFacts } from "@/server/domain/patients/list";
import { requireTreatmentConsent, treatmentConsentRevoked, TREATMENT_CONSENT_REVOKED } from "@/server/domain/visits/ops/consent";
import type { VisitRow } from "@/server/domain/visits/ops/screening";
import { FILE_A, PRACTICE_A, PRACTICE_B, SERVICE_A, sha256Hex } from "./fixtures";
import { asUserB, inUserA, insertRow, openTestDb, type Values } from "./helpers";

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const HIGH = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const LOW = "00000000-0000-4000-8000-000000000001";
let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

async function setup(tx: Tx) {
  const p = await insertRow(tx, "patients", { practice_id: PRACTICE_A, first_name: "Ada", last_name: "Prova", birth_date: "2008-11-03", addressing: "lei" });
  const patientId = String(p.id);
  const c = await insertRow(tx, "treatment_cycles", { practice_id: PRACTICE_A, patient_id: patientId, kind: "trattamento", title: "Ciclo prova", opened_on: "2026-10-22", expected_sessions: 4 });
  const cycleId = String(c.id);
  const a = await insertRow(tx, "appointments", { practice_id: PRACTICE_A, patient_id: patientId, cycle_id: cycleId, service_id: SERVICE_A, starts_at: romeDateTime("2026-11-04", "09:00"), duration_min: 45, price_cents: 6000, status: "prenotato" });
  const visit: VisitRow = { id: LOW, patientId, cycleId, appointmentId: String(a.id), visitDate: "2026-11-04", status: "draft", kind: "prima_visita", copiedFromVisitId: null };
  return { patientId, cycleId, appointmentId: String(a.id), visit };
}

function record(tx: Tx, patientId: string, extra: Values = {}) {
  return insertRow(tx, "consent_records", {
    practice_id: PRACTICE_A, patient_id: patientId, module_key: "informativa", module_version: "2026.1",
    rendered_text: "Testo prova", rendered_hash: sha256Hex("Testo prova"), signer_kind: "genitore", signer_name: "Genitore Prova",
    method: "tela", signature_file_id: FILE_A, signed_on: clock.today(), created_at: clock.now(), ...extra,
  });
}

function choice(tx: Tx, patientId: string, value: boolean, extra: Values = {}) {
  return insertRow(tx, "consent_choices", { practice_id: PRACTICE_A, patient_id: patientId, choice: "whatsapp", value, decided_on: clock.today(), mode: "modulo", created_at: clock.now(), ...extra });
}

describe("stato unico dei consensi", () => {
  it("pazienti_oggi_concordano e maggiorenne_stesso_ciclo", async () => {
    await inUserA(db, async (tx) => {
      const { patientId, cycleId, appointmentId, visit } = await setup(tx);
      const check = async (cell: string, missing: string[], revoked: boolean) => {
        const facts = (await loadPatientFacts(tx, PRACTICE_A, clock, [{ id: patientId, birthDate: "2008-11-03" }])).get(patientId)!;
        expect(consentCell(facts.consents)).toBe(cell);
        expect((await getPatientHeader(tx, PRACTICE_A, clock, patientId))?.labels).toContain(cell);
        const status = await queries.getConsentStatus(tx, PRACTICE_A, patientId);
        expect(missingModules(status, cycleId, false, true)).toEqual(missing);
        expect((await queries.listMissingConsents(tx, PRACTICE_A, clock)).find((r) => r.patientId === patientId)?.missingText)
          .toBe(missing.length === 2 ? "Informativa e consenso al trattamento" : "Informativa");
        // Una revoca ha il suo segnale con la data, al posto di «Consenso mancante».
        const row = (await listDayAppointments(tx, PRACTICE_A, clock, clock.today())).find((r) => r.id === appointmentId);
        if (revoked) expect(row?.consentRevocationText).toBe("Consenso revocato il 04/11");
        else expect(row?.signals).toContain("consenso_mancante");
        expect(await treatmentConsentRevoked(tx, PRACTICE_A, visit)).toBe(revoked);
      };
      await check("Manca 2", ["informativa", "trattamento"], false);
      const signed = await record(tx, patientId, { module_key: "trattamento_minore", cycle_id: cycleId, signed_on: "2026-11-02" });
      await check("Manca 1", ["informativa"], false);
      expect((await getSummaryTab(tx, PRACTICE_A, clock, patientId))?.consents[1]?.state).toBe("Firmato il 02/11/2026");
      expect((await getAppointmentDetail(tx, PRACTICE_A, clock, appointmentId))?.consentMissing).toBe(false);
      await tx.query("update public.consent_records set status = 'revocato', revoked_on = $2, revocation_mode = 'verbale' where id = $1", [String(signed.id), clock.today()]);
      await check("Revocato", ["informativa", "trattamento"], true);
      await expect(requireTreatmentConsent(tx, PRACTICE_A, visit)).rejects.toThrow(TREATMENT_CONSENT_REVOKED);
      await record(tx, patientId);
      await record(tx, patientId, { module_key: "trattamento_minore", cycle_id: cycleId, signed_on: "2026-11-02" });
      expect((await listDayAppointments(tx, PRACTICE_A, clock, clock.today())).find((r) => r.id === appointmentId)?.signals).not.toContain("consenso_mancante");
      expect((await queries.listMissingConsents(tx, PRACTICE_A, clock)).find((r) => r.patientId === patientId)).toBeUndefined();
      expect((await loadPatientFacts(tx, PRACTICE_A, clock, [{ id: patientId, birthDate: "2008-11-03" }])).get(patientId)?.consents.every((m) => m.state === "valid")).toBe(true);
    });
  });

  it("rifiuto_dopo_accettazione_blocca", async () => {
    await inUserA(db, async (tx) => {
      const { patientId, cycleId, visit } = await setup(tx);
      const first = await record(tx, patientId, { id: HIGH, module_key: "trattamento_minore", cycle_id: cycleId, signed_on: "2026-11-02" });
      // La sostituzione atomica della raccolta non è di questo test: qui si scrive a mano.
      await tx.query("update public.consent_records set status = 'sostituito' where id = $1", [HIGH]);
      await record(tx, patientId, { id: LOW, module_key: "trattamento_minore", cycle_id: cycleId, outcome: "rifiuta", signed_on: "2026-11-02" });
      await expect(requireTreatmentConsent(tx, PRACTICE_A, visit)).rejects.toThrow(TREATMENT_CONSENT_REVOKED);
      const [last] = await tx.query<{ status: string; outcome: string; record_order: bigint }>("select status, outcome, record_order from public.consent_records where patient_id = $1 order by signed_on desc, record_order desc limit 1", [patientId]);
      expect(last).toMatchObject({ status: "valido", outcome: "rifiuta" });
      expect(BigInt(last!.record_order)).toBeGreaterThan(BigInt(String(first.record_order)));
      await tx.query("update public.consent_records set status = 'sostituito' where id = $1", [LOW]);
      await record(tx, patientId, { module_key: "trattamento_minore", cycle_id: cycleId, outcome: "rifiuta", signed_on: "2026-11-01" });
      await expect(requireTreatmentConsent(tx, PRACTICE_A, visit)).rejects.toThrow(TREATMENT_CONSENT_REVOKED);
      const facts = (await loadPatientFacts(tx, PRACTICE_A, clock, [{ id: patientId, birthDate: "2008-11-03" }])).get(patientId)!;
      expect(consentCell(facts.consents)).toBe("Rifiutato");
    });
  });

  it.each(["rifiuta", "revocato"] as const)("decisione_2_ultimo_trattamento_del_ciclo_blocca: %s", async (decision) => {
    await inUserA(db, async (tx) => {
      const { patientId, cycleId, appointmentId, visit } = await setup(tx);
      await record(tx, patientId);
      await record(tx, patientId, { module_key: "trattamento_minore", cycle_id: cycleId, signed_on: "2026-11-02" });
      const adult = await record(tx, patientId, {
        module_key: "trattamento", cycle_id: cycleId, signer_kind: "paziente", signer_name: "Ada Prova",
        outcome: decision === "rifiuta" ? "rifiuta" : "accetta",
      });
      if (decision === "revocato") {
        await tx.query("update public.consent_records set status = 'revocato', revoked_on = $2, revocation_mode = 'verbale' where id = $1", [String(adult.id), clock.today()]);
      }

      const status = await queries.getConsentStatus(tx, PRACTICE_A, patientId);
      expect.soft(missingModules(status, cycleId, false, true)).toEqual(["trattamento"]);
      const facts = (await loadPatientFacts(tx, PRACTICE_A, clock, [{ id: patientId, birthDate: "2008-11-03" }])).get(patientId)!;
      expect.soft(consentCell(facts.consents)).toBe(decision === "rifiuta" ? "Rifiutato" : "Revocato");
      expect.soft((await getPatientHeader(tx, PRACTICE_A, clock, patientId))?.labels).toContain(decision === "rifiuta" ? "Rifiutato" : "Revocato");
      expect.soft((await getSummaryTab(tx, PRACTICE_A, clock, patientId))?.consents[1]?.state)
        .toBe(decision === "rifiuta" ? "Rifiutato" : "Revocato il 04/11/2026");
      expect.soft((await queries.listMissingConsents(tx, PRACTICE_A, clock)).find((r) => r.patientId === patientId)?.missingText)
        .toBe("Consenso al trattamento");
      // Rifiuto e revoca bloccano il trattamento: la riga lo dice al posto di «Consenso mancante».
      const row = (await listDayAppointments(tx, PRACTICE_A, clock, clock.today())).find((r) => r.id === appointmentId);
      expect.soft(row?.signals).not.toContain("consenso_mancante");
      expect.soft(decision === "rifiuta" ? row?.consentRefused : row?.consentRevocationText).toBe(
        decision === "rifiuta" ? true : "Consenso revocato il 04/11",
      );
      expect.soft((await getAppointmentDetail(tx, PRACTICE_A, clock, appointmentId))?.consentMissing).toBe(true);
      expect.soft(await treatmentConsentRevoked(tx, PRACTICE_A, visit)).toBe(true);
      await expect.soft(requireTreatmentConsent(tx, PRACTICE_A, visit)).rejects.toThrow(TREATMENT_CONSENT_REVOKED);
    });
  });

  it("oggi_blocco_trattamento_non_nasconde_informativa_ne_altro_ciclo", async () => {
    await inUserA(db, async (tx) => {
      const { patientId, cycleId, appointmentId } = await setup(tx);
      await record(tx, patientId, { module_key: "trattamento_minore", cycle_id: cycleId, outcome: "rifiuta", signed_on: "2026-11-02" });
      await tx.query("update public.treatment_cycles set status = 'closed', closed_on = $2, outcome = 'interrotto_dal_paziente' where id = $1", [cycleId, clock.today()]);
      const nextCycle = await insertRow(tx, "treatment_cycles", {
        practice_id: PRACTICE_A, patient_id: patientId, kind: "trattamento", title: "Nuovo ciclo", opened_on: clock.today(), expected_sessions: 4,
      });
      const later = await insertRow(tx, "appointments", {
        practice_id: PRACTICE_A, patient_id: patientId, cycle_id: String(nextCycle.id), service_id: SERVICE_A,
        starts_at: romeDateTime(clock.today(), "11:00"), duration_min: 45, price_cents: 6000, status: "prenotato",
      });
      const rows = await listDayAppointments(tx, PRACTICE_A, clock, clock.today());
      expect.soft(rows.find((r) => r.id === appointmentId)).toMatchObject({
        consentRefused: true, signals: expect.arrayContaining(["consenso_mancante"]),
      });
      expect.soft(rows.find((r) => r.id === String(later.id))?.signals).toContain("consenso_mancante");
    });
  });

  it("oggi_informativa_per_paziente_trattamento_per_ciclo", async () => {
    for (const { firstMissing, nextMissing, signals } of [
      { firstMissing: false, nextMissing: false, signals: [true, false, false] },
      { firstMissing: true, nextMissing: false, signals: [true, false, false] },
      { firstMissing: false, nextMissing: true, signals: [true, true, false] },
      { firstMissing: true, nextMissing: true, signals: [true, true, false] },
    ]) {
      await inUserA(db, async (tx) => {
        const { patientId, cycleId, appointmentId } = await setup(tx);
        if (!firstMissing) await record(tx, patientId, { module_key: "trattamento_minore", cycle_id: cycleId, signed_on: "2026-11-02" });
        await tx.query("update public.treatment_cycles set status = 'closed', closed_on = $2, outcome = 'interrotto_dal_paziente' where id = $1", [cycleId, clock.today()]);
        const nextCycle = await insertRow(tx, "treatment_cycles", {
          practice_id: PRACTICE_A, patient_id: patientId, kind: "trattamento", title: "Nuovo ciclo", opened_on: clock.today(), expected_sessions: 4,
        });
        if (!nextMissing) await record(tx, patientId, { module_key: "trattamento", cycle_id: String(nextCycle.id), signer_kind: "paziente", signer_name: "Ada Prova" });
        const ids = [appointmentId];
        for (const time of ["11:00", "15:00"]) {
          const appointment = await insertRow(tx, "appointments", {
            practice_id: PRACTICE_A, patient_id: patientId, cycle_id: String(nextCycle.id), service_id: SERVICE_A,
            starts_at: romeDateTime(clock.today(), time), duration_min: 45, price_cents: 6000, status: "prenotato",
          });
          ids.push(String(appointment.id));
        }
        const rows = await listDayAppointments(tx, PRACTICE_A, clock, clock.today());
        expect.soft(ids.map((id) => rows.find((row) => row.id === id)?.signals.includes("consenso_mancante")), `${firstMissing}/${nextMissing}`).toEqual(signals);
      });
    }
  });

  it.each(["trattamento", "trattamento_minore"] as const)("rifiuto_trattamento_prevale_su_revoca_informativa: %s", async (moduleKey) => {
    await inUserA(db, async (tx) => {
      const { patientId, cycleId } = await setup(tx);
      const informativa = await record(tx, patientId);
      await tx.query("update public.consent_records set status = 'revocato', revoked_on = $2, revocation_mode = 'verbale' where id = $1", [String(informativa.id), clock.today()]);
      await record(tx, patientId, {
        module_key: moduleKey, cycle_id: cycleId, outcome: "rifiuta",
        signed_on: moduleKey === "trattamento_minore" ? "2026-11-02" : clock.today(),
      });
      const facts = (await loadPatientFacts(tx, PRACTICE_A, clock, [{ id: patientId, birthDate: "2008-11-03" }])).get(patientId)!;
      expect.soft(consentCell(facts.consents)).toBe("Rifiutato");
      expect.soft((await getPatientHeader(tx, PRACTICE_A, clock, patientId))?.labels).toContain("Rifiutato");
    });
  });

  it("decisione_2_accettazione_adulta_dopo_rifiuto_minore_valida", async () => {
    await inUserA(db, async (tx) => {
      const { patientId, cycleId, appointmentId, visit } = await setup(tx);
      await record(tx, patientId);
      // A parità di data della firma e timestamp, prevale l'inserimento adulto successivo.
      await record(tx, patientId, { id: HIGH, module_key: "trattamento_minore", cycle_id: cycleId, outcome: "rifiuta" });
      await record(tx, patientId, { id: LOW, module_key: "trattamento", cycle_id: cycleId, signer_kind: "paziente", signer_name: "Ada Prova" });

      const status = await queries.getConsentStatus(tx, PRACTICE_A, patientId);
      expect(missingModules(status, cycleId, false, true)).toEqual([]);
      const facts = (await loadPatientFacts(tx, PRACTICE_A, clock, [{ id: patientId, birthDate: "2008-11-03" }])).get(patientId)!;
      expect(consentCell(facts.consents)).toBe("In regola");
      expect((await getPatientHeader(tx, PRACTICE_A, clock, patientId))?.labels).toContain("In regola");
      expect((await getSummaryTab(tx, PRACTICE_A, clock, patientId))?.consents[1]?.state).toBe("Firmato il 04/11/2026");
      expect((await queries.listMissingConsents(tx, PRACTICE_A, clock)).find((r) => r.patientId === patientId)).toBeUndefined();
      expect((await listDayAppointments(tx, PRACTICE_A, clock, clock.today())).find((r) => r.id === appointmentId)?.signals).not.toContain("consenso_mancante");
      expect((await getAppointmentDetail(tx, PRACTICE_A, clock, appointmentId))?.consentMissing).toBe(false);
      expect(await treatmentConsentRevoked(tx, PRACTICE_A, visit)).toBe(false);
      await expect(requireTreatmentConsent(tx, PRACTICE_A, visit)).resolves.toBeUndefined();
    });
  });

  it("ciclo_adulto_ignora_modulo_minore_successivo", async () => {
    await inUserA(db, async (tx) => {
      const { patientId, cycleId, appointmentId, visit } = await setup(tx);
      await tx.query("update public.treatment_cycles set opened_on = '2026-11-03' where id = $1", [cycleId]);
      await record(tx, patientId);
      await record(tx, patientId, { module_key: "trattamento", cycle_id: cycleId, signed_on: "2026-11-03", signer_kind: "paziente", signer_name: "Ada Prova" });
      // Il modulo successivo ha la chiave sbagliata per l'età alla firma e non decide il gruppo.
      const wrong = await record(tx, patientId, { module_key: "trattamento_minore", cycle_id: cycleId });

      const status = await queries.getConsentStatus(tx, PRACTICE_A, patientId);
      expect.soft(missingModules(status, cycleId, false, false)).toEqual([]);
      const facts = (await loadPatientFacts(tx, PRACTICE_A, clock, [{ id: patientId, birthDate: "2008-11-03" }])).get(patientId)!;
      expect.soft(consentCell(facts.consents)).toBe("In regola");
      expect.soft(facts.consents[1]).toMatchObject({ key: "trattamento", state: "valid", signedOn: "2026-11-03" });
      expect.soft((await getPatientHeader(tx, PRACTICE_A, clock, patientId))?.labels).toContain("In regola");
      expect.soft((await getSummaryTab(tx, PRACTICE_A, clock, patientId))?.consents[1]?.state).toBe("Firmato il 03/11/2026");
      expect.soft((await queries.listMissingConsents(tx, PRACTICE_A, clock)).find((r) => r.patientId === patientId)).toBeUndefined();
      expect.soft((await listDayAppointments(tx, PRACTICE_A, clock, clock.today())).find((r) => r.id === appointmentId)?.signals).not.toContain("consenso_mancante");
      expect.soft((await getAppointmentDetail(tx, PRACTICE_A, clock, appointmentId))?.consentMissing).toBe(false);
      expect.soft(await treatmentConsentRevoked(tx, PRACTICE_A, visit)).toBe(false);
      await expect.soft(requireTreatmentConsent(tx, PRACTICE_A, visit)).resolves.toBeUndefined();
      // La lettura della validità non altera né elimina il documento dalla cartella.
      expect(await tx.query("select module_key, status from public.consent_records where id = $1", [String(wrong.id)]))
        .toEqual([{ module_key: "trattamento_minore", status: "valido" }]);
      expect(await listPatientConsents(tx, PRACTICE_A, patientId)).toContainEqual(expect.objectContaining({
        moduleLabel: "Consenso del genitore", cycleTitle: "Ciclo prova", signedOnText: "04/11/2026", statusLabel: "Valido",
      }));
    });
  });

  it.each(["whatsapp", "richiami"] as const)("canale_richiede_informativa_valida: %s", async (channel) => {
    await inUserA(db, async (tx) => {
      const { patientId } = await setup(tx);
      await choice(tx, patientId, true, { choice: channel });
      expect(await queries.getChannelConsent(tx, PRACTICE_A, patientId, channel)).toBe(false);
      await record(tx, patientId, { outcome: "rifiuta" });
      expect(await queries.getChannelConsent(tx, PRACTICE_A, patientId, channel)).toBe(false);
      await tx.query("update public.consent_records set status = 'sostituito' where patient_id = $1", [patientId]);
      const signed = await record(tx, patientId);
      expect(await queries.getChannelConsent(tx, PRACTICE_A, patientId, channel)).toBe(true);
      expect(await queries.getChannelConsents(tx, PRACTICE_A, [patientId, patientId], channel)).toEqual(new Map([[patientId, true]]));
      await choice(tx, patientId, false, { choice: channel });
      expect(await queries.getChannelConsent(tx, PRACTICE_A, patientId, channel)).toBe(false);
      await choice(tx, patientId, true, { choice: channel });
      await tx.query("update public.consent_records set status = 'revocato', revoked_on = $2, revocation_mode = 'verbale' where id = $1", [String(signed.id), clock.today()]);
      expect(await queries.getChannelConsent(tx, PRACTICE_A, patientId, channel)).toBe(false);
      const next = await record(tx, patientId);
      await tx.query("update public.consent_records set status = 'sostituito' where id = $1", [String(next.id)]);
      expect(await queries.getChannelConsent(tx, PRACTICE_A, patientId, channel)).toBe(false);
      // Un documento caricato può essere stato firmato ieri: i documenti già sostituiti
      // non devono nascondere quello attualmente valido, anche se datato prima.
      await record(tx, patientId, { signed_on: "2026-11-03" });
      expect(await queries.getChannelConsent(tx, PRACTICE_A, patientId, channel)).toBe(true);
      expect(await queries.getChannelConsents(tx, PRACTICE_A, [], channel)).toEqual(new Map());
    });
    expect(await asUserB(db, (tx) => queries.getChannelConsent(tx, PRACTICE_A, "a0000000-0000-4000-8000-000000000202", channel))).toBe(false);
    expect(await asUserB(db, (tx) => queries.getChannelConsents(tx, PRACTICE_A, [], channel))).toEqual(new Map());
  });

  it("pari_date_ordine_inserimento", async () => {
    await inUserA(db, async (tx) => {
      const { patientId } = await setup(tx);
      await record(tx, patientId);
      const first = await choice(tx, patientId, true, { id: HIGH });
      const second = await choice(tx, patientId, false, { id: LOW });
      expect(await queries.getChannelConsent(tx, PRACTICE_A, patientId, "whatsapp")).toBe(false);
      expect(BigInt(String(second.record_order))).toBeGreaterThan(BigInt(String(first.record_order)));
      const message = { practice_id: PRACTICE_A, patient_id: patientId, template_key: "richiamo", recipient_kind: "paziente", recipient_name: "Ada Prova", action: "copiato", created_at: clock.now() };
      const m1 = await insertRow(tx, "message_log", { ...message, id: HIGH, body: "Primo" });
      const m2 = await insertRow(tx, "message_log", { ...message, id: LOW, body: "Secondo" });
      expect(BigInt(String(m2.record_order))).toBeGreaterThan(BigInt(String(m1.record_order)));
      const rows = await tx.query<{ body: string }>("select body from public.message_log where practice_id = $1 and patient_id = $2 order by created_at desc, record_order desc limit 1", [PRACTICE_A, patientId]);
      expect(rows).toEqual([{ body: "Secondo" }]);
    });
  });

  it("nessuna_validita_di_un_altro_studio", async () => {
    expect((await asUserB(db, (tx) => queries.loadValidConsents(tx, PRACTICE_A, ["a0000000-0000-4000-8000-000000000202"]))).values().next().value?.informativa).toBe(false);
    expect(await asUserB(db, (tx) => queries.getChannelConsents(tx, PRACTICE_B, ["a0000000-0000-4000-8000-000000000202"], "whatsapp"))).toEqual(new Map([["a0000000-0000-4000-8000-000000000202", false]]));
  });
});
