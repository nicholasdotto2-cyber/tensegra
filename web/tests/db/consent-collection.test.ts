import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fixedClock } from "@/server/clock";
import type { Db } from "@/server/db/db";
import { getConsentCollection } from "@/server/domain/consents/collection";
import { uploadConsent } from "@/server/domain/consents/commands";
import { consentTarget, getConsentStatus } from "@/server/domain/consents/queries";
import { NO_GUARDIAN } from "@/lib/consents/messages";
import { storageKey } from "@/server/files/keys";
import { PRACTICE_A, CYCLE_B, GUARDIAN_B, PATIENT_B1 } from "./fixtures";
import { inUserA, insertRow, openTestDb } from "./helpers";

const clock = fixedClock("2026-11-04T08:30:00+01:00");
let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

it.each(["trattamento", "informativa"] as const)("raccolta %s alla data della carta, upload accettato e valido dopo i 18 anni", async kind => {
  await inUserA(db, async tx => {
    const patient = await insertRow(tx, "patients", { practice_id: PRACTICE_A, first_name: "Ada", last_name: "Prova", birth_date: "2008-11-03", addressing: "tu" });
    const patientId = String(patient.id);
    const guardian = await insertRow(tx, "patient_guardians", { practice_id: PRACTICE_A, patient_id: patientId, first_name: "Elena", last_name: "Prova", relationship: "madre", has_parental_authority: true, is_contact: true });
    const other = await insertRow(tx, "patient_guardians", { practice_id: PRACTICE_A, patient_id: patientId, first_name: "Paolo", last_name: "Prova", relationship: "tutore", has_parental_authority: false, is_contact: false });
    const cycle = await insertRow(tx, "treatment_cycles", { practice_id: PRACTICE_A, patient_id: patientId, kind: "trattamento", opened_on: "2026-10-22", title: "Prova", expected_sessions: 4 });
    const cycleId = String(cycle.id);
    const today = consentTarget({ id: patientId, birthDate: "2008-11-03" }, clock.today(), String(guardian.id), kind === "informativa" ? { kind } : { kind, cycleId });
    expect(today.guardianId).toBeNull();
    // La stessa funzione chiamata dalla Server Action del dialogo, senza costruire il target storico.
    const collected = await getConsentCollection(tx, PRACTICE_A, clock, today, "2026-11-02");
    expect(collected?.target).toMatchObject({ patientId, moduleKey: kind === "informativa" ? kind : "trattamento_minore", guardianId: guardian.id, cycleId: kind === "informativa" ? null : cycleId });
    expect(collected?.guardians.map(g => g.id)).toEqual([guardian.id, other.id]);
    const selected = await getConsentCollection(tx, PRACTICE_A, clock, today, "2026-11-02", String(other.id));
    expect(selected?.preview?.signerName).toBe("Paolo Prova");
    expect((await getConsentCollection(tx, PRACTICE_A, clock, today))?.target.guardianId).toBeNull();
    const preview = collected!.preview!;
    const fileId = randomUUID();
    const id = randomUUID();
    await expect(uploadConsent(tx, PRACTICE_A, clock, {
      fields: { ...collected!.target, id, signerName: preview.signerName, previewHash: preview.hash, outcome: "accetta", refusesInformation: false, refusalNote: null, trusteeName: null, trusteeContact: null, minorOpinionNote: null, singleGuardianDeclaration: kind !== "informativa", secondGuardianName: null, notes: null, choices: kind === "informativa" ? { whatsapp: true, richiami: true } : null },
      signedOn: "2026-11-02",
      document: { id: fileId, storageKey: storageKey(PRACTICE_A, "consent_upload", fileId, "application/pdf"), mime: "application/pdf", size: 20, sha256: "a".repeat(64) },
    })).resolves.toEqual({ id });
    const valid = await getConsentStatus(tx, PRACTICE_A, patientId);
    if (kind === "informativa") expect(valid.informativa).toBe(true);
    else expect(valid.treatment.get(cycleId)?.has("trattamento_minore")).toBe(true);

    await expect(getConsentCollection(tx, PRACTICE_A, clock, today, "2026-11-02", GUARDIAN_B)).resolves.toBeNull();
    await expect(getConsentCollection(tx, PRACTICE_A, clock, { ...today, patientId: PATIENT_B1 }, "2026-11-02")).resolves.toBeNull();
    if (today.moduleKey !== "informativa") await expect(getConsentCollection(tx, PRACTICE_A, clock, { ...today, cycleId: CYCLE_B }, "2026-11-02")).resolves.toBeNull();
  });
});

it("senza genitore autorizzato restituisce la frase esistente e nessuna anteprima", async () => inUserA(db, async tx => {
  const patient = await insertRow(tx, "patients", { practice_id: PRACTICE_A, first_name: "Ada", last_name: "Prova", birth_date: "2008-11-03", addressing: "tu" });
  await insertRow(tx, "patient_guardians", { practice_id: PRACTICE_A, patient_id: String(patient.id), first_name: "Nina", last_name: "Prova", relationship: "madre", has_parental_authority: false, is_contact: true });
  const today = consentTarget({ id: String(patient.id), birthDate: "2008-11-03" }, clock.today(), null, { kind: "informativa" });
  expect(await getConsentCollection(tx, PRACTICE_A, clock, today, "2026-11-02")).toMatchObject({ problem: NO_GUARDIAN, preview: null, guardians: [] });
}));
