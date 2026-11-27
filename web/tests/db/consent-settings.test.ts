import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/clock";
import type { Db } from "@/server/db/db";
import { saveCommunicationSettings, setPractitionerSignature } from "@/server/domain/settings/commands";
import { getConsentSettings, getPracticeSettings } from "@/server/domain/settings/queries";
import { listActiveServices } from "@/server/domain/services/queries";
import { settingsConsentPreview, studioConsentValues } from "@/lib/consents/studio-values";
import { getConsentPreview } from "@/server/domain/consents/preview";
import { signConsent } from "@/server/domain/consents/commands";
import { NOT_ALLOWED } from "@/server/domain/errors";
import { storageKey } from "@/server/files/keys";
import { sha256Of } from "@/server/files/sniff";
import { CONSENT_MODULES } from "@/lib/consents/modules";
import { CYCLE_A, PATIENT_A1, PRACTICE_A, PRACTICE_B, USER_A, USER_B } from "./fixtures";
import { asServiceFor, asUserA, asUserB, inUserA, openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
let db: Db; let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

describe("Impostazioni Consensi", () => {
  it("settings_limiti: 1 e 30 accettati, 0 e 31 senza scrittura; Messaggi preservato", async () => inUserA(db, async (tx) => {
    await saveCommunicationSettings(tx, PRACTICE_A, clock, { section: "messaggi", defaultAddressing: "lei" });
    for (const retentionYears of [1, 30]) {
      await saveCommunicationSettings(tx, PRACTICE_A, clock, { section: "consensi", retentionYears });
      expect(await getConsentSettings(tx, PRACTICE_A)).toMatchObject({ retentionYears });
      expect(await tx.query("select default_addressing from public.practice_settings where practice_id=$1", [PRACTICE_A])).toEqual([{ default_addressing: "lei" }]);
    }
    for (const retentionYears of [0, 31]) {
      const before = await tx.query("select retention_years, default_addressing, updated_at from public.practice_settings where practice_id=$1", [PRACTICE_A]);
      await expect(saveCommunicationSettings(tx, PRACTICE_A, clock, { section: "consensi", retentionYears })).rejects.toThrow();
      expect(await tx.query("select retention_years, default_addressing, updated_at from public.practice_settings where practice_id=$1", [PRACTICE_A])).toEqual(before);
    }
    await expect(saveCommunicationSettings(tx, PRACTICE_A, clock, { section: "consensi", retentionYears: 10, defaultAddressing: "tu" })).rejects.toThrow();
  }));

  it("sezione_consensi: tre moduli readonly e versionati; uB non legge e non scrive A", async () => {
    expect(Object.keys(CONSENT_MODULES).sort()).toEqual(["informativa", "trattamento", "trattamento_minore"]);
    for (const consentModule of Object.values(CONSENT_MODULES)) {
      expect(consentModule.version).toBe("2026.1");
      expect(Object.isFrozen(consentModule)).toBe(true);
    }
    const before = await asServiceFor(db, tx => tx.query("select retention_years from public.practice_settings where practice_id=$1", [PRACTICE_A]));
    expect(await asUserB(db, tx => getConsentSettings(tx, PRACTICE_A))).toBeNull();
    await expect(asUserB(db, tx => saveCommunicationSettings(tx, PRACTICE_A, clock, { section: "consensi", retentionYears: 1 }))).rejects.toThrow(NOT_ALLOWED);
    expect(await asServiceFor(db, tx => tx.query("select retention_years from public.practice_settings where practice_id=$1", [PRACTICE_A]))).toEqual(before);
  });

  it("firma_osteopata: byte, peso e hash nella destinazione, isolamento, fotografia del consenso", async () => {
    const { storePractitionerSignature } = await import("@/server/files/practitioner-signature");
    const store = new MemoryFileStore();
    const ctx = { db, actor: { userId: USER_A }, practiceId: PRACTICE_A };
    await storePractitionerSignature(ctx, clock, store, PNG);
    const first = (await asUserA(db, tx => getConsentSettings(tx, PRACTICE_A)))!;
    const file = (await asServiceFor(db, tx => tx.query<{ id: string; storage_key: string; sha256: string; size_bytes: number; kind: string }>(
      "select id, storage_key, sha256, size_bytes, kind from public.files where id=$1", [first.practitionerSignatureFileId!])))[0]!;
    expect(file).toMatchObject({ kind: "signature", size_bytes: PNG.length, sha256: sha256Of(PNG) });
    expect(Buffer.from((await store.get(file.storage_key))!)).toEqual(PNG);
    expect(sha256Of((await store.get(file.storage_key))!)).toBe(file.sha256);
    expect(await asUserB(db, tx => tx.query("select id from public.files where id=$1", [file.id]))).toEqual([]);

    const consentId = randomUUID();
    await asUserA(db, async tx => {
      const target = { patientId: PATIENT_A1, moduleKey: "informativa", cycleId: null, appointmentId: null, guardianId: null } as const;
      const preview = (await getConsentPreview(tx, PRACTICE_A, clock, target))!;
      const signatureId = randomUUID();
      await signConsent(tx, PRACTICE_A, clock, {
        fields: { ...target, id: consentId, signerName: preview.signerName, previewHash: preview.hash, outcome: "accetta", refusesInformation: false,
          refusalNote: null, trusteeName: null, trusteeContact: null, minorOpinionNote: null, singleGuardianDeclaration: false, secondGuardianName: null, notes: null,
          choices: { whatsapp: true, richiami: false } },
        signature: { id: signatureId, storageKey: storageKey(PRACTICE_A, "signature", signatureId, "image/png"), mime: "image/png", size: PNG.length, sha256: sha256Of(PNG) }, secondSignature: null,
      });
    });
    await storePractitionerSignature(ctx, clock, store, PNG);
    expect((await asUserA(db, tx => getConsentSettings(tx, PRACTICE_A)))!.practitionerSignatureFileId).not.toBe(file.id);
    expect(await asServiceFor(db, tx => tx.query("select practitioner_signature_file_id from public.consent_records where id=$1", [consentId]))).toEqual([{ practitioner_signature_file_id: file.id }]);
    expect(await store.get(file.storage_key)).toEqual(new Uint8Array(PNG));

    const keys = store.keys();
    await expect(storePractitionerSignature({ ...ctx, actor: { userId: USER_B } }, clock, store, PNG)).rejects.toThrow(NOT_ALLOWED);
    expect(store.keys()).toEqual(keys);
    await expect(storePractitionerSignature(ctx, clock, store, new TextEncoder().encode("%PDF-1.4"))).rejects.toThrow();
    expect(store.keys()).toEqual(keys);
    const id = randomUUID();
    await expect(asUserB(db, tx => setPractitionerSignature(tx, PRACTICE_B, clock, { file: { id, storageKey: file.storage_key, mime: "image/png", size: PNG.length, sha256: file.sha256 } }))).rejects.toThrow(NOT_ALLOWED);
    expect(await asServiceFor(db, tx => tx.query("select id from public.files where id=$1", [id]))).toEqual([]);
  });

  it("anteprima_impostazioni: stesso testo dello studio della raccolta, per gli stessi dati", async () => inUserA(db, async (tx) => {
    await tx.query(`update public.practice_settings set address_line='Via di Prova 1', postal_code='40100', city='Bologna', province='BO', phone='+390510000000',
      email='studio@example.invalid', registration_kind='ese', registration_order='Ordine TSRM PSTRP di Bologna', registration_province='BO', registration_number='0000',
      insurance_company='Compagnia Esempio', insurance_policy_number='RC-0000-DEMO', insurance_limit_cents=200000000 where practice_id=$1`, [PRACTICE_A]);
    const settings = (await getPracticeSettings(tx, PRACTICE_A))!;
    const values = studioConsentValues(settings, await listActiveServices(tx, PRACTICE_A), clock.today());
    const retention = String((await getConsentSettings(tx, PRACTICE_A))!.retentionYears);
    const targets = [
      { patientId: PATIENT_A1, moduleKey: "informativa", cycleId: null, appointmentId: null, guardianId: null },
      { patientId: PATIENT_A1, moduleKey: "trattamento", cycleId: CYCLE_A, appointmentId: null, guardianId: null },
    ] as const;
    for (const target of targets) {
      const { moduleKey } = target;
      const preview = (await getConsentPreview(tx, PRACTICE_A, clock, target))!;
      const settingsText = settingsConsentPreview(moduleKey, values, retention);
      const templates = CONSENT_MODULES[moduleKey].body.split("\n\n");
      const shown = settingsText.split("\n\n");
      const signed = preview.rendered.text.split("\n\n").slice(-templates.length);
      expect(shown).toHaveLength(templates.length);
      // Paragrafo per paragrafo: fuori dai vuoti dei dati del paziente, il testo è quello che il paziente firma.
      shown.forEach((paragraph, i) => {
        const escaped = paragraph.split("________").map(piece => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        expect(signed[i], `${moduleKey} ${i + 1}`).toMatch(new RegExp(`^${escaped.join(".*?")}$`, "s"));
      });
      if (moduleKey === "informativa") expect(preview.rendered.text.endsWith(`\n\n${settingsText}`)).toBe(true);
    }
    const treatment = settingsConsentPreview("trattamento", values, retention);
    expect(treatment).toContain("Osteopata: Anna Rossi, iscrizione all'elenco speciale ad esaurimento degli osteopati presso l'Ordine TSRM PSTRP di Bologna, n. 0000. Studio: ");
    expect(treatment).toContain("Polizza di responsabilità civile professionale Compagnia Esempio, n. RC-0000-DEMO, massimale ");
  }));
});
