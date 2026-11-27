import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSENT_MODULES } from "@/lib/consents/modules";
import { settingsConsentPreview } from "@/lib/consents/studio-values";
import { type Clock, fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import type { StoredFileInput } from "@/server/domain/attachments/commands";
import type { ConsentFields, ConsentTarget } from "@/server/domain/consents/schemas";
import { getChannelConsent, getConsentStatus } from "@/server/domain/consents/queries";
import { NOT_ALLOWED } from "@/server/domain/errors";
import { storageKey } from "@/server/files/keys";
import { APPOINTMENT_A, CONSENT_A, CYCLE_A, GUARDIAN_A, PATIENT_A1, PATIENT_A2, PATIENT_A3, PRACTICE_A, PRACTICE_B } from "./fixtures";
import { asServiceFor, asUserA, asUserB, inUserA, insertRow, openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

const clock = fixedClock("2026-11-04T08:30:00+01:00");
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const api = async () => ({ ...await import("@/server/domain/consents/commands"), ...await import("@/server/domain/consents/preview") });
let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

const target = (extra: Partial<ConsentTarget> = {}): ConsentTarget => ({ patientId: PATIENT_A1, moduleKey: "informativa", cycleId: null, appointmentId: null, guardianId: null, ...extra } as ConsentTarget);
const treatment = (): ConsentTarget => target({ moduleKey: "trattamento", cycleId: CYCLE_A });
async function fields(tx: Tx, t = target(), at: { clock?: Clock; signedOn?: string } = {}): Promise<ConsentFields> {
  const p = await (await api()).getConsentPreview(tx, PRACTICE_A, at.clock ?? clock, t, at.signedOn);
  expect(p).not.toBeNull();
  return { ...t, id: randomUUID(), signerName: p!.signerName, previewHash: p!.hash, outcome: "accetta", refusesInformation: false, refusalNote: null, trusteeName: null, trusteeContact: null, minorOpinionNote: p!.minorOpinionDefault, singleGuardianDeclaration: p!.signerKind !== "paziente", secondGuardianName: null, notes: null, choices: t.moduleKey === "informativa" ? { whatsapp: true, richiami: false } : null };
}
async function stored(mime: "image/png" | "application/pdf" = "image/png") {
  const bytes = mime === "image/png" ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") : Buffer.from("%PDF-1.4\n%%EOF");
  const store = new MemoryFileStore();
  const id = randomUUID();
  const key = storageKey(PRACTICE_A, mime === "image/png" ? "signature" : "consent_upload", id, mime);
  await store.put(key, bytes);
  const file: StoredFileInput = { id, storageKey: key, mime, size: bytes.length, sha256: sha(bytes) };
  return { file, store, bytes };
}
async function sign(tx: Tx, f: ConsentFields) {
  return (await api()).signConsent(tx, PRACTICE_A, clock, { fields: f, signature: (await stored()).file, secondSignature: null });
}
const noNewRows = async (tx: Tx, id: string, fileId: string) => {
  expect(await tx.query("select id from public.consent_records where id=$1", [id])).toEqual([]);
  expect(await tx.query("select id from public.files where id=$1", [fileId])).toEqual([]);
};

describe("comandi consensi", () => {
  it("firma_atomica", async () => inUserA(db, async (tx) => {
    const a = await api(); const f = await fields(tx); const { file, store, bytes } = await stored();
    const preview = (await a.getConsentPreview(tx, PRACTICE_A, clock, target()))!;
    expect(preview.missingLinks).toContainEqual({ key: "osteopata.firma", label: "firma dell'osteopata", href: "/impostazioni/consensi" });
    expect(await a.signConsent(tx, PRACTICE_A, clock, { fields: f, signature: file, secondSignature: null })).toEqual({ id: f.id });
    const [row] = await tx.query("select * from public.consent_records where id=$1", [f.id]);
    const [saved] = await tx.query("select * from public.files where id=$1", [file.id]);
    expect(await store.get(String(saved!.storage_key))).toEqual(new Uint8Array(bytes));
    expect(saved).toMatchObject({ mime_type: "image/png", size_bytes: bytes.length, sha256: sha(bytes) });
    expect(row).toMatchObject({ rendered_text: a.freezeConsent(preview, f, clock.today(), clock.now().toISOString()).text, signed_on: "2026-11-04", signed_at: clock.now(), signature_file_id: file.id, module_version: "2026.1", document_file_id: null });
    expect(row!.rendered_hash).toBe(sha(String(row!.rendered_text)));
    expect(row!.missing_fields).toEqual(preview.rendered.missingFields);
    expect(row!.created_at).toEqual(clock.now());
    expect(await tx.query("select choice, value, mode, created_at from public.consent_choices where consent_record_id=$1 order by choice", [f.id])).toEqual([
      { choice: "richiami", value: false, mode: "modulo", created_at: clock.now() }, { choice: "whatsapp", value: true, mode: "modulo", created_at: clock.now() },
    ]);
    const practitioner = (await stored()).file;
    await insertRow(tx, "files", { id: practitioner.id, practice_id: PRACTICE_A, kind: "signature", storage_key: practitioner.storageKey, mime_type: practitioner.mime, size_bytes: practitioner.size, sha256: practitioner.sha256 });
    await tx.query("update public.practice_settings set practitioner_signature_file_id=$2 where practice_id=$1", [PRACTICE_A, practitioner.id]);
    const treatmentFields = await fields(tx, treatment());
    await sign(tx, treatmentFields);
    const savedSnapshot = await tx.query("select practitioner_signature_file_id, rendered_text, rendered_hash, missing_fields from public.consent_records where id=$1", [treatmentFields.id]);
    expect(savedSnapshot[0]!.practitioner_signature_file_id).toBe(practitioner.id);
    await tx.query("update public.practice_settings set practitioner_signature_file_id=null, insurance_policy_number='POLIZZA SUCCESSIVA' where practice_id=$1", [PRACTICE_A]);
    expect(await tx.query("select practitioner_signature_file_id, rendered_text, rendered_hash, missing_fields from public.consent_records where id=$1", [treatmentFields.id])).toEqual(savedSnapshot);
  }));

  it("rifiuto_non_valido", async () => inUserA(db, async (tx) => {
    const accepted = await fields(tx, treatment()); await sign(tx, accepted);
    const f = await fields(tx, treatment()); f.outcome = "rifiuta";
    await sign(tx, f);
    expect((await getConsentStatus(tx, PRACTICE_A, PATIENT_A1)).treatment.has(CYCLE_A)).toBe(false);
    const [r] = await tx.query("select outcome, rendered_text, signature_file_id from public.consent_records where id=$1", [f.id]);
    expect(r!.outcome).toBe("rifiuta"); expect(r!.signature_file_id).toBeTruthy();
    expect(r!.rendered_text).toContain("Esito: rifiuta il trattamento.");
    expect((await tx.query("select status, signature_file_id from public.consent_records where id=$1", [accepted.id]))[0]).toMatchObject({ status: "sostituito", signature_file_id: expect.any(String) });
  }));

  it("sostituzione_rollback", async () => {
    const f = await inUserA(db, tx => fields(tx)); const { file } = await stored();
    await expect(asUserA(db, async tx => {
      const wrapper: Tx = { query: (sql, params) => { if (/insert into public\.consent_choices/i.test(sql)) throw new Error("scelta fallita dopo sostituzione"); return tx.query(sql, params); } };
      await (await api()).signConsent(wrapper, PRACTICE_A, clock, { fields: f, signature: file, secondSignature: null });
    })).rejects.toThrow("scelta fallita dopo sostituzione");
    await asServiceFor(db, async tx => {
      await noNewRows(tx, f.id, file.id);
      expect(await tx.query("select id from public.consent_choices where consent_record_id=$1", [f.id])).toEqual([]);
      expect((await tx.query("select status from public.consent_records where id=$1", [CONSENT_A]))[0]!.status).toBe("valido");
    });
  });

  it("id_ripetuto", async () => inUserA(db, async tx => {
    const a = await api(); const f = await fields(tx); const { file } = await stored(); const input = { fields: f, signature: file, secondSignature: null };
    await a.signConsent(tx, PRACTICE_A, clock, input);
    await expect(a.signConsent(tx, PRACTICE_A, fixedClock("2026-11-04T09:00:00+01:00"), input)).resolves.toEqual({ id: f.id });
    const retryFile = (await stored()).file;
    await expect(a.signConsent(tx, PRACTICE_A, clock, { ...input, signature: retryFile })).resolves.toEqual({ id: f.id });
    expect(await tx.query("select id from public.files where id=$1", [retryFile.id])).toEqual([]);
    expect(await tx.query("select id from public.consent_choices where consent_record_id=$1", [f.id])).toHaveLength(2);
    await expect(a.signConsent(tx, PRACTICE_A, clock, { ...input, fields: { ...f, notes: "cambiata" } })).rejects.toThrow(NOT_ALLOWED);
    await expect(a.signConsent(tx, PRACTICE_A, clock, { ...input, signature: { ...file, sha256: "0".repeat(64) } })).rejects.toThrow(NOT_ALLOWED);
  }));

  it("firma_anteprima_cambiata", async () => inUserA(db, async tx => {
    const a = await api(); const f = await fields(tx, treatment()); const { file } = await stored();
    await tx.query("update public.practice_settings set insurance_policy_number='POLIZZA NUOVA' where practice_id=$1", [PRACTICE_A]);
    await expect(a.signConsent(tx, PRACTICE_A, clock, { fields: f, signature: file, secondSignature: null })).rejects.toThrow("Il modulo è cambiato: rileggilo prima di firmare.");
    await noNewRows(tx, f.id, file.id);
  }));

  it("upload_date", async () => inUserA(db, async tx => {
    const a = await api(); const f = await fields(tx); const { file } = await stored("application/pdf");
    await expect(a.uploadConsent(tx, PRACTICE_A, clock, { fields: f, signedOn: "2026-11-05", document: file })).rejects.toThrow("La data della firma non può essere nel futuro.");
    await noNewRows(tx, f.id, file.id);
    await a.uploadConsent(tx, PRACTICE_A, clock, { fields: f, signedOn: clock.today(), document: file });
    expect((await tx.query("select signed_on, signed_at, document_file_id, method from public.consent_records where id=$1", [f.id]))[0]).toEqual({ signed_on: "2026-11-04", signed_at: null, document_file_id: file.id, method: "pdf_caricato" });
    const historical = await fields(tx, treatment()); historical.notes = "Originale di carta";
    await a.uploadConsent(tx, PRACTICE_A, clock, { fields: historical, signedOn: "2026-11-03", document: (await stored("application/pdf")).file });
    const [old] = await tx.query("select rendered_text from public.consent_records where id=$1", [historical.id]);
    expect(old!.rendered_text).toContain("Note: Originale di carta\n03/11/2026, ");
    expect(old!.rendered_text).not.toContain("04/11/2026, ");
    const historicalFile = (await stored("application/pdf")).file;
    await expect(a.uploadConsent(tx, PRACTICE_A, fixedClock("2026-11-05T08:30:00+01:00"), { fields: historical, signedOn: "2026-11-03", document: historicalFile })).resolves.toEqual({ id: historical.id });
    expect(await tx.query("select id from public.files where id=$1", [historicalFile.id])).toEqual([]);
  }));

  it("revoca_date", async () => inUserA(db, async tx => {
    await tx.query("update public.appointments set starts_at='2026-11-05T08:00:00Z' where id=$1", [APPOINTMENT_A]);
    const a = await api(); const f = await fields(tx, treatment()); await sign(tx, f);
    const input = { id: f.id, revokedOn: "2026-11-03", mode: "verbale", note: "Su richiesta" };
    await expect(a.revokeConsent(tx, PRACTICE_A, clock, input)).rejects.toThrow();
    await expect(a.revokeConsent(tx, PRACTICE_A, clock, { ...input, revokedOn: "2026-11-05" })).rejects.toThrow();
    await a.revokeConsent(tx, PRACTICE_A, clock, { ...input, revokedOn: clock.today() });
    const before = await tx.query("select status, revoked_on, revocation_mode, revocation_note, updated_at from public.consent_records where id=$1", [f.id]);
    const guard: Tx = { query: (sql, params) => { if (/update public.consent_records/i.test(sql)) throw new Error("retry riscrive"); return tx.query(sql, params); } };
    await a.revokeConsent(guard, PRACTICE_A, clock, { ...input, revokedOn: clock.today() });
    expect(await tx.query("select status, revoked_on, revocation_mode, revocation_note, updated_at from public.consent_records where id=$1", [f.id])).toEqual(before);
    expect(before[0]).toMatchObject({ status: "revocato", revoked_on: "2026-11-04", revocation_mode: "verbale", revocation_note: "Su richiesta" });
    expect((await tx.query("select status from public.appointments where id=$1", [APPOINTMENT_A]))[0]!.status).toBe("prenotato");
  }));

  it("scelte_revoca", async () => inUserA(db, async tx => {
    const a = await api(); const f = await fields(tx); f.choices = { whatsapp: true, richiami: true }; await sign(tx, f);
    const input = { patientId: PATIENT_A1, choice: "whatsapp", value: false, decidedOn: clock.today(), mode: "messaggio", note: null };
    const original = await tx.query("select * from public.consent_choices where consent_record_id=$1", [f.id]);
    await expect(a.recordChoice(tx, PRACTICE_A, clock, { ...input, value: true })).rejects.toThrow();
    await expect(a.recordChoice(tx, PRACTICE_A, clock, { ...input, decidedOn: "2026-11-05" })).rejects.toThrow();
    await expect(a.recordChoice(tx, PRACTICE_A, clock, { ...input, consentRecordId: f.id })).rejects.toThrow();
    await a.recordChoice(tx, PRACTICE_A, clock, input);
    expect(await tx.query("select * from public.consent_choices where consent_record_id=$1", [f.id])).toEqual(original);
    expect(await getChannelConsent(tx, PRACTICE_A, PATIENT_A1, "whatsapp")).toBe(false);
    expect((await tx.query("select consent_record_id, value, created_at from public.consent_choices where patient_id=$1 order by record_order desc limit 1", [PATIENT_A1]))[0]).toEqual({ consent_record_id: null, value: false, created_at: clock.now() });
    expect(await getChannelConsent(tx, PRACTICE_A, PATIENT_A1, "richiami")).toBe(true);
    await a.revokeConsent(tx, PRACTICE_A, clock, { id: f.id, revokedOn: clock.today(), mode: "verbale", note: null });
    expect(await getChannelConsent(tx, PRACTICE_A, PATIENT_A1, "richiami")).toBe(false);
  }));

  it("revoca_retrodatata_rifiutata", async () => inUserA(db, async tx => {
    const a = await api(); const f = await fields(tx); await sign(tx, f);
    const input = { patientId: PATIENT_A1, choice: "whatsapp", value: false, decidedOn: "2026-11-03", mode: "verbale", note: null };
    const before = await tx.query("select id from public.consent_choices where patient_id=$1", [PATIENT_A1]);
    await expect(a.recordChoice(tx, PRACTICE_A, clock, input)).rejects.toThrow("La revoca non può avere una data precedente al consenso del 04/11/2026.");
    expect(await tx.query("select id from public.consent_choices where patient_id=$1", [PATIENT_A1])).toEqual(before);
    await a.recordChoice(tx, PRACTICE_A, clock, { ...input, decidedOn: clock.today() });
    expect(await getChannelConsent(tx, PRACTICE_A, PATIENT_A1, "whatsapp")).toBe(false);
  }));

  it("stesso_studio_altro_paziente", async () => {
    const a = await api();
    const originalA = await asServiceFor(db, tx => tx.query("select * from public.consent_records where id=$1", [CONSENT_A]));
    await inUserA(db, async tx => {
      const f = await fields(tx); const { file } = await stored();
      for (const change of [{ patientId: PATIENT_A2, moduleKey: "trattamento", cycleId: CYCLE_A }, { patientId: PATIENT_A2, appointmentId: APPOINTMENT_A }, { guardianId: GUARDIAN_A }]) {
        await expect(a.signConsent(tx, PRACTICE_A, clock, { fields: { ...f, ...change }, signature: file, secondSignature: null })).rejects.toThrow(NOT_ALLOWED);
      }
      await sign(tx, f);
      const [other] = await tx.query("select signature_file_id from public.consent_records where id=$1", [f.id]);
      const [foreignFile] = await tx.query("select id, storage_key as \"storageKey\", mime_type as mime, size_bytes as size, sha256 from public.files where id=$1", [String(other!.signature_file_id)]);
      await expect(a.signConsent(tx, PRACTICE_A, clock, { fields: await fields(tx, target({ patientId: PATIENT_A2 })), signature: foreignFile, secondSignature: null })).rejects.toThrow(NOT_ALLOWED);
    });
    const f = await inUserA(db, tx => fields(tx)); const file = (await stored()).file;
    for (const practice of [PRACTICE_A, PRACTICE_B]) {
      for (const cmd of [() => asUserB(db, tx => a.signConsent(tx, practice, clock, { fields: { ...f, id: CONSENT_A }, signature: file, secondSignature: null })), () => asUserB(db, tx => a.uploadConsent(tx, practice, clock, { fields: f, signedOn: clock.today(), document: file })), () => asUserB(db, tx => a.revokeConsent(tx, practice, clock, { id: CONSENT_A, revokedOn: clock.today(), mode: "verbale", note: null })), () => asUserB(db, tx => a.recordChoice(tx, practice, clock, { patientId: PATIENT_A1, choice: "whatsapp", value: false, decidedOn: clock.today(), mode: "verbale", note: null }))]) await expect(cmd()).rejects.toThrow(NOT_ALLOWED);
    }
    // A valid B target with A's occupied ID exercises the global PK collision behind RLS.
    await asUserB(db, async tx => {
      const [patient] = await tx.query<{ id: string }>("select id from public.patients where practice_id=$1 and birth_date<'2000-01-01' limit 1", [PRACTICE_B]);
      const t: ConsentTarget = { ...target(), patientId: patient!.id };
      const p = (await a.getConsentPreview(tx, PRACTICE_B, clock, t))!;
      const id = randomUUID(); const bFile = { ...file, id, storageKey: storageKey(PRACTICE_B, "signature", id, "image/png") };
      await expect(a.signConsent(tx, PRACTICE_B, clock, { fields: { ...f, ...t, id: CONSENT_A, signerName: p.signerName, previewHash: p.hash }, signature: bFile, secondSignature: null })).rejects.toThrow(NOT_ALLOWED);
      expect(await tx.query("select id from public.files where id=$1", [id])).toEqual([]);
    });
    await asServiceFor(db, async tx => { expect(await tx.query("select * from public.consent_records where id=$1", [CONSENT_A])).toEqual(originalA); await noNewRows(tx, f.id, file.id); });
  });

  it("trattamento_ciclo_chiuso_rifiutato", async () => inUserA(db, async tx => {
    const a = await api(); const f = await fields(tx, treatment()); const file = (await stored()).file;
    await tx.query("update public.treatment_cycles set status='closed', closed_on='2026-11-04', outcome='raggiunto' where id=$1", [CYCLE_A]);
    await expect(a.signConsent(tx, PRACTICE_A, clock, { fields: f, signature: file, secondSignature: null })).rejects.toThrow(NOT_ALLOWED);
    await expect(a.uploadConsent(tx, PRACTICE_A, clock, { fields: f, signedOn: clock.today(), document: file })).rejects.toThrow(NOT_ALLOWED);
    await noNewRows(tx, f.id, file.id);
  }));

  async function minor(tx: Tx) {
    const c = await insertRow(tx, "treatment_cycles", { practice_id: PRACTICE_A, patient_id: PATIENT_A3, kind: "trattamento", title: "Ciclo minore prova", opened_on: clock.today(), expected_sessions: 3 });
    await tx.query("update public.patients set birth_date='2023-01-01' where id=$1", [PATIENT_A3]);
    return fields(tx, target({ patientId: PATIENT_A3, moduleKey: "trattamento_minore", cycleId: String(c.id), guardianId: GUARDIAN_A }));
  }
  it("secondo_genitore_coerente", async () => inUserA(db, async tx => {
    const a = await api(); const f = await minor(tx); const signature = (await stored()).file; const second = (await stored()).file;
    await expect(a.signConsent(tx, PRACTICE_A, clock, { fields: { ...f, secondGuardianName: "Altro Prova" }, signature, secondSignature: null })).rejects.toThrow();
    await expect(a.signConsent(tx, PRACTICE_A, clock, { fields: f, signature, secondSignature: second })).rejects.toThrow();
    await a.signConsent(tx, PRACTICE_A, clock, { fields: { ...f, secondGuardianName: "Altro Prova", singleGuardianDeclaration: false }, signature, secondSignature: second });
    const [row] = await tx.query("select rendered_text, second_signature_file_id from public.consent_records where id=$1", [f.id]);
    expect(row!.second_signature_file_id).toBe(second.id); expect(row!.rendered_text).not.toContain("Io sottoscritto/a dichiaro che l'altro genitore");
    await sign(tx, { ...f, id: randomUUID() });
  }));

  it("freeze_ordine_letterale", async () => inUserA(db, async tx => {
    const a = await api(); const f = await minor(tx); const p = (await a.getConsentPreview(tx, PRACTICE_A, clock, f))!;
    const full: ConsentFields = { ...f, outcome: "rifiuta", refusesInformation: true, refusalNote: "Dettagli", trusteeName: "Ada Prova", trusteeContact: "051000000", choices: { whatsapp: false, richiami: true }, minorOpinionNote: "Ascoltato", singleGuardianDeclaration: true, secondGuardianName: null, notes: "Nota prova" };
    const frozen = a.freezeConsent(p, full, "2026-11-04", null).text;
    expect(frozen.split("\n\n").at(-1)).toBe([
      "Esito: rifiuta il trattamento.", "Non desidera ricevere alcune informazioni: Dettagli", "Persona indicata per ricevere le informazioni: Ada Prova, 051000000", "Promemoria e comunicazioni su WhatsApp: No", "Ricontatto per i controlli periodici: Sì", "Voce del minore: Ascoltato", "Io sottoscritto/a dichiaro che l'altro genitore è informato e d'accordo, oppure che esercito da solo/a la responsabilità genitoriale.", "Note: Nota prova", `04/11/2026, ${p.place}`,
    ].join("\n"));
    for (const hint of ["Campo note.", "modificabile", "Secondo genitore (facoltativo)", "se firma uno solo", "eventuale secondo genitore", 'con "Sì" e "No"']) expect(frozen).not.toContain(hint);
    expect(frozen.match(/Io sottoscritto\/a dichiaro che l'altro genitore/g)).toHaveLength(1);
    // Il punto 8 del modulo va nel blocco firmato: la dichiarazione e firme diventa il punto 8.
    const closing = '8. Dichiarazione e firme. "Io sottoscritto/a, in qualità di genitore o tutore, dichiaro di aver letto queste informazioni, di aver potuto fare domande e di aver ricevuto risposte chiare, e acconsento al trattamento osteopatico del minore descritto." Firma del genitore o tutore, firma dell\'osteopata.';
    expect(frozen.split("\n\n").find(part => part.startsWith("8. Dichiarazione"))).toBe(closing);
    expect(frozen).toContain("L'osteopata ha spiegato al minore");
    const empty = a.freezeConsent(p, { ...f, minorOpinionNote: null, singleGuardianDeclaration: false, secondGuardianName: "Altro Prova" }, "2026-11-04", null).text;
    expect(empty.split("\n\n").at(-1)).toBe(`Secondo genitore: Altro Prova\n04/11/2026, ${p.place}`);
    const info = await fields(tx); const infoP = (await a.getConsentPreview(tx, PRACTICE_A, clock, info))!;
    const infoText = a.freezeConsent(infoP, info, clock.today(), null).text;
    expect(infoText).not.toContain("Poi due scelte"); expect(infoText).not.toContain('con "Sì" e "No"');
    expect(infoText).toContain('"Acconsento a ricevere promemoria e comunicazioni organizzative su WhatsApp."');
    const secondText = a.freezeConsent(p, { ...full, secondGuardianName: "Altro Prova", singleGuardianDeclaration: false }, clock.today(), null).text;
    expect(secondText.split("\n\n").find(part => part.startsWith("8. Dichiarazione"))).toBe(closing.replace("tutore, firma", "tutore, firma del secondo genitore, firma"));
    expect(secondText.split("\n\n").at(-1)).toBe(frozen.split("\n\n").at(-1)!.replace("Io sottoscritto/a dichiaro che l'altro genitore è informato e d'accordo, oppure che esercito da solo/a la responsabilità genitoriale.", "Secondo genitore: Altro Prova"));
  }));

  it("campi_firma_obbligatori", async () => inUserA(db, async tx => {
    const f = await fields(tx, treatment());
    await expect(sign(tx, { ...f, refusesInformation: true })).rejects.toMatchObject({ field: "refusalNote" });
    const child = await minor(tx);
    expect(child.minorOpinionNote).toBe("Non applicabile per l'età");
    await expect(sign(tx, { ...child, singleGuardianDeclaration: false })).rejects.toMatchObject({ field: "singleGuardianDeclaration" });
    await sign(tx, { ...child, minorOpinionNote: "Ha espresso il suo parere" });
    expect((await tx.query("select minor_opinion_note from public.consent_records where id=$1", [child.id]))[0]!.minor_opinion_note).toBe("Ha espresso il suo parere");
    const info = await fields(tx);
    await expect(sign(tx, { ...info, choices: { whatsapp: false } } as ConsentFields)).rejects.toThrow();
    const p = (await (await api()).getConsentPreview(tx, PRACTICE_A, clock, treatment()))!;
    for (const link of p.missingLinks.filter(l => l.key.startsWith("paziente."))) expect(link.href).toBe(`/pazienti/${PATIENT_A1}?tab=anagrafica`);
    await expect(sign(tx, { ...f, signerName: "Un altro firmatario" })).rejects.toThrow(NOT_ALLOWED);
    await tx.query("update public.patient_guardians set relationship='altro' where id=$1", [GUARDIAN_A]);
    await expect(sign(tx, { ...child, id: randomUUID() })).rejects.toThrow(NOT_ALLOWED);
    const tutor = await insertRow(tx, "patient_guardians", { practice_id: PRACTICE_A, patient_id: PATIENT_A1, first_name: "Tutore", last_name: "Prova", relationship: "tutore" });
    const representedAdult = await fields(tx, target({ ...treatment(), guardianId: String(tutor.id) }));
    await expect(sign(tx, { ...representedAdult, singleGuardianDeclaration: false })).resolves.toEqual({ id: representedAdult.id });
    await tx.query("update public.practice_settings set city=null where practice_id=$1", [PRACTICE_A]);
    expect((await (await api()).getConsentPreview(tx, PRACTICE_A, clock, target()))!.rendered.missingFields).toContain("documento.luogo");
  }));

  /** PATIENT_A3 con la data di nascita data e un ciclo aperto il 30/09. */
  async function patientBorn(tx: Tx, birthDate: string): Promise<string> {
    await tx.query("update public.patients set birth_date=$2 where id=$1", [PATIENT_A3, birthDate]);
    const c = await insertRow(tx, "treatment_cycles", { practice_id: PRACTICE_A, patient_id: PATIENT_A3, kind: "trattamento", title: "Ciclo diciottesimo prova", opened_on: "2026-09-30", expected_sessions: 3 });
    return String(c.id);
  }
  const ofA3 = (moduleKey: "trattamento" | "trattamento_minore", cycleId: string) =>
    target({ patientId: PATIENT_A3, moduleKey, cycleId, guardianId: moduleKey === "trattamento_minore" ? GUARDIAN_A : null });

  it("chiave_per_eta_alla_firma", async () => inUserA(db, async tx => {
    const cycleId = await patientBorn(tx, "2008-11-10");
    const f = { ...await fields(tx, ofA3("trattamento_minore", cycleId)), moduleKey: "trattamento" } as ConsentFields;
    const file = (await stored()).file;
    await expect((await api()).signConsent(tx, PRACTICE_A, clock, { fields: f, signature: file, secondSignature: null })).rejects.toThrow("Il paziente era minorenne il 04/11/2026: serve il modulo per il minore.");
    await noNewRows(tx, f.id, file.id);
    const adult = { ...await fields(tx, treatment()), moduleKey: "trattamento_minore" } as ConsentFields;
    await expect(sign(tx, adult)).rejects.toThrow("Il paziente era maggiorenne il 04/11/2026: serve il modulo per l'adulto.");
  }));

  it("minore_alla_firma_caricato_da_adulto", async () => inUserA(db, async tx => {
    const cycleId = await patientBorn(tx, "2008-10-20");
    const f = await fields(tx, ofA3("trattamento_minore", cycleId), { signedOn: "2026-10-01" });
    await (await api()).uploadConsent(tx, PRACTICE_A, clock, { fields: f, signedOn: "2026-10-01", document: (await stored("application/pdf")).file });
    expect((await tx.query("select signer_kind, signed_on from public.consent_records where id=$1", [f.id]))[0]).toEqual({ signer_kind: "genitore", signed_on: "2026-10-01" });
    expect((await getConsentStatus(tx, PRACTICE_A, PATIENT_A3)).treatment.get(cycleId)).toEqual(new Set(["trattamento_minore"]));
  }));

  it("caricamento_retrodatato_rifiutato", async () => inUserA(db, async tx => {
    const a = await api(); const late = "C'è già un consenso firmato dopo questa data: carica un documento con una data uguale o successiva.";
    const refusal = await fields(tx, treatment()); refusal.outcome = "rifiuta"; await sign(tx, refusal);
    const paper = await fields(tx, treatment(), { signedOn: "2026-10-01" }); const document = (await stored("application/pdf")).file;
    await expect(a.uploadConsent(tx, PRACTICE_A, clock, { fields: paper, signedOn: "2026-10-01", document })).rejects.toThrow(late);
    await noNewRows(tx, paper.id, document.id);
    expect((await tx.query("select status from public.consent_records where id=$1", [refusal.id]))[0]!.status).toBe("valido");
    expect((await getConsentStatus(tx, PRACTICE_A, PATIENT_A1)).treatment.has(CYCLE_A)).toBe(false);
    // L'informativa CONSENT_A è del 05/10.
    const info = await fields(tx, target(), { signedOn: "2026-10-01" });
    await expect(a.uploadConsent(tx, PRACTICE_A, clock, { fields: info, signedOn: "2026-10-01", document: (await stored("application/pdf")).file })).rejects.toThrow(late);
    expect((await tx.query("select status from public.consent_records where id=$1", [CONSENT_A]))[0]!.status).toBe("valido");
  }));

  it("caricamento_prima_della_revoca_rifiutato", async () => inUserA(db, async tx => {
    // Firmato il 01/10, revocato il 04/11: un foglio del 02/10 non riapre il trattamento.
    const a = await api(); const late = "C'è già un consenso firmato dopo questa data: carica un documento con una data uguale o successiva.";
    const first = await fields(tx, treatment(), { signedOn: "2026-10-01" });
    await a.uploadConsent(tx, PRACTICE_A, clock, { fields: first, signedOn: "2026-10-01", document: (await stored("application/pdf")).file });
    await a.revokeConsent(tx, PRACTICE_A, clock, { id: first.id, revokedOn: clock.today(), mode: "verbale", note: "Su richiesta" });
    const paper = await fields(tx, treatment(), { signedOn: "2026-10-02" }); const document = (await stored("application/pdf")).file;
    await expect(a.uploadConsent(tx, PRACTICE_A, clock, { fields: paper, signedOn: "2026-10-02", document })).rejects.toThrow(late);
    await noNewRows(tx, paper.id, document.id);
    expect((await tx.query("select status from public.consent_records where id=$1", [first.id]))[0]!.status).toBe("revocato");
  }));

  it("trattamento_nuovo_sostituisce_minore", async () => inUserA(db, async tx => {
    const a = await api(); const october = fixedClock("2026-10-01T08:30:00+02:00");
    const cycleId = await patientBorn(tx, "2008-10-20");
    const minorFields = await fields(tx, ofA3("trattamento_minore", cycleId), { clock: october });
    await a.signConsent(tx, PRACTICE_A, october, { fields: minorFields, signature: (await stored()).file, secondSignature: null });
    await sign(tx, await fields(tx, ofA3("trattamento", cycleId)));
    expect((await tx.query("select status from public.consent_records where id=$1", [minorFields.id]))[0]!.status).toBe("sostituito");
  }));

  it("indicazioni_interfaccia_nel_catalogo", async () => {
    const a = await api();
    expect(() => a.assertHintsInCatalog(CONSENT_MODULES)).not.toThrow();
    const minor = CONSENT_MODULES.trattamento_minore;
    const drifted = { ...CONSENT_MODULES, trattamento_minore: { ...minor, body: minor.body.replace("eventuale secondo genitore", "secondo genitore se presente") } };
    expect(() => a.assertHintsInCatalog(drifted)).toThrow("eventuale secondo genitore");
  });

  // Il caso da evitare: chi firma leggeva i punti 1-9 del modulo per il minore e il PDF firmato 1-8. L'anteprima
  // della raccolta (e quella di Impostazioni) e il testo congelato hanno gli stessi numeri, in ogni modulo.
  it("anteprima_e_testo_firmato_stessa_numerazione", async () => inUserA(db, async tx => {
    const points = (text: string): number[] => text.split("\n\n").flatMap(part => /^(\d+)\. /.exec(part)?.[1] ?? []).map(Number);
    const a = await api(); const shown: string[] = [];
    for (const f of [await fields(tx), await fields(tx, treatment()), await minor(tx)]) {
      const preview = (await a.getConsentPreview(tx, PRACTICE_A, clock, f))!;
      shown.push(preview.rendered.text);
      await sign(tx, f);
      const [row] = await tx.query<{ text: string }>("select rendered_text as text from public.consent_records where id=$1", [f.id]);
      const signed = points(row!.text);
      expect(signed, f.moduleKey).toEqual(Array.from({ length: signed.length }, (_, i) => i + 1));
      expect(points(preview.rendered.text), f.moduleKey).toEqual(signed);
      expect(points(settingsConsentPreview(f.moduleKey, {}, "10")), f.moduleKey).toEqual(signed);
    }
    // La dichiarazione sull'altro genitore resta nel testo che si legge prima di firmare.
    const declaration = `Dichiarazione sull'altro genitore (se firma uno solo). "Io sottoscritto/a dichiaro che l'altro genitore è informato e d'accordo, oppure che esercito da solo/a la responsabilità genitoriale."`;
    expect(shown.at(-1)).toContain(declaration);
    expect(settingsConsentPreview("trattamento_minore", {}, "10")).toContain(declaration);
  }));
});
