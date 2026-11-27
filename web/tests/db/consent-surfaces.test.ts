import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Clock, fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import type { StoredFileInput } from "@/server/domain/attachments/commands";
import { createAppointment, markDone } from "@/server/domain/appointments/commands";
import { getAppointmentDetail, getSedutaFatta, listDayAppointments } from "@/server/domain/appointments/queries";
import { revokeConsent, signConsent, uploadConsent } from "@/server/domain/consents/commands";
import { getConsentPreview } from "@/server/domain/consents/preview";
import { TREATMENT_CONSENT_REVOKED } from "@/lib/clinical/labels";
import { NO_CYCLE, NO_GUARDIAN } from "@/lib/consents/messages";
import { listMissingConsents, loadConsentGuardians } from "@/server/domain/consents/queries";
import type { ConsentFields, ConsentTarget } from "@/server/domain/consents/schemas";
import { getOpenCycle } from "@/server/domain/cycles/queries";
import { getCollectTargets, getSummaryTab, listPatientChoices, listPatientConsents } from "@/server/domain/patients/card";
import { createPatient } from "@/server/domain/patients/commands";
import { saveOpeningHours } from "@/server/domain/settings/commands";
import { storageKey } from "@/server/files/keys";
import { writeConsentTemporary } from "../support/consent-rows";
import { GUARDIAN_A, PATIENT_A1, PATIENT_A3, PRACTICE_A, PRACTICE_B, SERVICE_A } from "./fixtures";
import { inRollback, inUserA, insertRow, openTestDb } from "./helpers";

// I consensi dove si raccolgono: il bersaglio di
// «Consensi mancanti», lo storico della tab Consensi, il pannello "Seduta fatta" e la revoca sugli appuntamenti
// futuri del ciclo. I dati nascono come uA con i comandi dell'app; ogni test torna indietro. L'orologio è
// giovedì 22/10/2026 alle 08:30 di Roma.

const D0 = fixedClock("2026-10-22T08:30:00+02:00");
const TODAY = "2026-10-22";

let db: Db;
let pg: PGlite;

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
});

afterAll(async () => {
  await pg?.close();
});

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n%%EOF");

const MORNING = { opens: "09:00", closes: "13:00" };
const AFTERNOON = { opens: "14:30", closes: "19:30" };
const FULL_DAY = [MORNING, AFTERNOON];

/** Gli orari del seed: lun-ven 09:00-13:00 e 14:30-19:30, sab 09:00-13:00, dom chiuso. */
async function seedHours(tx: Tx): Promise<void> {
  const bands: Record<number, typeof FULL_DAY> = { 1: FULL_DAY, 2: FULL_DAY, 3: FULL_DAY, 4: FULL_DAY, 5: FULL_DAY, 6: [MORNING] };
  await saveOpeningHours(tx, PRACTICE_A, D0, {
    days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, bands: bands[weekday] ?? [] })),
  });
}

/** Un file già scritto sul disco dall'orchestratore: il comando registra solo i metadati. */
function storedFile(kind: "signature" | "consent_upload"): StoredFileInput {
  const id = randomUUID();
  const mime = kind === "signature" ? "image/png" : "application/pdf";
  const bytes = kind === "signature" ? PNG : PDF;
  return { id, storageKey: storageKey(PRACTICE_A, kind, id, mime), mime, size: bytes.length, sha256: sha(bytes) };
}

/** I campi del dialogo per un bersaglio, dall'anteprima come li manda il client. */
async function fieldsFor(
  tx: Tx,
  target: ConsentTarget,
  at: { outcome?: "accetta" | "rifiuta"; signedOn?: string } = {},
): Promise<ConsentFields> {
  const preview = await getConsentPreview(tx, PRACTICE_A, D0, target, at.signedOn);
  if (preview === null) throw new Error(`Anteprima assente per ${target.moduleKey}`);
  return {
    ...target,
    id: randomUUID(),
    signerName: preview.signerName,
    previewHash: preview.hash,
    outcome: at.outcome ?? "accetta",
    refusesInformation: false,
    refusalNote: null,
    trusteeName: null,
    trusteeContact: null,
    minorOpinionNote: preview.minorOpinionDefault,
    singleGuardianDeclaration: preview.signerKind !== "paziente",
    secondGuardianName: null,
    notes: null,
    choices: target.moduleKey === "informativa" ? { whatsapp: true, richiami: true } : null,
  } as ConsentFields;
}

async function signOnCanvas(tx: Tx, target: ConsentTarget, outcome: "accetta" | "rifiuta" = "accetta"): Promise<string> {
  const fields = await fieldsFor(tx, target, { outcome });
  return (await signConsent(tx, PRACTICE_A, D0, { fields, signature: storedFile("signature"), secondSignature: null })).id;
}

async function uploadOn(tx: Tx, target: ConsentTarget, signedOn: string): Promise<{ id: string; fileId: string }> {
  const fields = await fieldsFor(tx, target, { signedOn });
  const document = storedFile("consent_upload");
  const { id } = await uploadConsent(tx, PRACTICE_A, D0, { fields, signedOn, document });
  return { id, fileId: document.id };
}

/** Un adulto nuovo dal mini modulo: senza codice fiscale, indirizzo né consensi. */
async function adult(tx: Tx, firstName: string, lastName: string): Promise<string> {
  return (await createPatient(tx, PRACTICE_A, D0, { firstName, lastName, birthDate: "1979-03-09" })).id;
}

/**
 * Sofia Rinaldi, nata il 12/06/2026, con la madre Elena di contatto e con responsabilità genitoriale; il padre,
 * registrato prima di lei e anche lui con la responsabilità, non è il contatto.
 */
async function sofia(tx: Tx): Promise<{ id: string; elena: string; father: string }> {
  const { id } = await createPatient(tx, PRACTICE_A, D0, {
    firstName: "Sofia",
    lastName: "Rinaldi",
    birthDate: "2026-06-12",
    guardian: { firstName: "Elena", lastName: "Rinaldi" },
  });
  const [elena] = await tx.query<{ id: string }>(
    `update public.patient_guardians set relationship = 'madre', has_parental_authority = true
      where practice_id = $1 and patient_id = $2 returning id`,
    [PRACTICE_A, id],
  );
  if (!elena) throw new Error("Sofia non ha la madre");
  const father = await insertRow(tx, "patient_guardians", {
    practice_id: PRACTICE_A,
    patient_id: id,
    relationship: "padre",
    first_name: "Paolo",
    last_name: "Rinaldi",
    has_parental_authority: true,
    is_contact: false,
    is_payer: false,
    created_at: "2026-01-01T09:00:00Z",
  });
  return { id, elena: elena.id, father: String(father.id) };
}

/** Prenota nel ciclo aperto del paziente, o in un ciclo nuovo: seduta da 45 minuti a 60 euro. */
async function book(
  tx: Tx,
  patientId: string,
  b: { day: string; time: string; status?: "prenotato" | "fatto" },
  clock: Clock = D0,
): Promise<{ id: string; cycleId: string }> {
  const open = await getOpenCycle(tx, PRACTICE_A, patientId);
  const created = await createAppointment(tx, PRACTICE_A, clock, {
    patient: { kind: "existing", patientId },
    serviceId: SERVICE_A,
    day: b.day,
    time: b.time,
    durationMin: 45,
    cycle: open ? { kind: "existing", cycleId: open.id } : { kind: "new" },
    priceCents: 6000,
    status: b.status ?? "prenotato",
  });
  const [first] = created.appointments;
  if (!first) throw new Error("nessun appuntamento creato");
  return { id: first.id, cycleId: created.cycleId };
}

/** Informativa e consenso al trattamento del ciclo, caricati il 15/10 (lo scrittore del seed). */
async function signedBefore(tx: Tx, patientId: string, cycleId: string): Promise<string> {
  await writeConsentTemporary(tx, PRACTICE_A, {
    patientId,
    moduleKey: "informativa",
    cycleId: null,
    signedOn: "2026-10-15",
    signerKind: "paziente",
    signerName: "Marco Bellandi",
    guardianId: null,
    method: "tela",
  });
  const { id } = await writeConsentTemporary(tx, PRACTICE_A, {
    patientId,
    moduleKey: "trattamento",
    cycleId,
    signedOn: "2026-10-15",
    signerKind: "paziente",
    signerName: "Marco Bellandi",
    guardianId: null,
    method: "pdf_caricato",
  });
  return id;
}

describe("consensi da Oggi, scheda e Seduta fatta", () => {
  it("target_sofia: il consenso del genitore, con Elena di contatto, per il ciclo dell'appuntamento", async () => {
    const out = await inUserA(db, async (tx) => {
      await seedHours(tx);
      const s = await sofia(tx);
      const a = await book(tx, s.id, { day: TODAY, time: "11:00" });
      const cycles = await tx.query("select id from public.treatment_cycles where patient_id = $1", [s.id]);
      return { s, a, cycles, rows: await listMissingConsents(tx, PRACTICE_A, D0) };
    });
    const row = out.rows.find((r) => r.patientId === out.s.id);
    expect(row?.missingText).toBe("Informativa e consenso del genitore");
    // Prima il trattamento dell'appuntamento, con la madre di contatto e non il padre.
    expect(row?.target).toEqual({
      patientId: out.s.id,
      moduleKey: "trattamento_minore",
      cycleId: out.a.cycleId,
      appointmentId: out.a.id,
      guardianId: out.s.elena,
    });
    // Il ciclo è quello dell'appuntamento: nessun ciclo nuovo.
    expect(out.cycles).toEqual([{ id: out.a.cycleId }]);
  });

  it("raccogli_solo_trattamento: firmato il trattamento, Sofia resta con «Informativa»; l'informativa la toglie", async () => {
    const out = await inUserA(db, async (tx) => {
      await seedHours(tx);
      const s = await sofia(tx);
      const a = await book(tx, s.id, { day: TODAY, time: "11:00" });
      const first = (await listMissingConsents(tx, PRACTICE_A, D0)).find((r) => r.patientId === s.id);
      if (!first) throw new Error("Sofia non è fra i mancanti");
      await signOnCanvas(tx, first.target);
      const second = (await listMissingConsents(tx, PRACTICE_A, D0)).find((r) => r.patientId === s.id);
      if (second) await signOnCanvas(tx, second.target);
      const third = (await listMissingConsents(tx, PRACTICE_A, D0)).find((r) => r.patientId === s.id);
      const records = await tx.query<{ moduleKey: string }>(
        `select module_key as "moduleKey" from public.consent_records where patient_id = $1 order by record_order`,
        [s.id],
      );
      return { s, a, first, second, third, records };
    });
    expect(out.first.target.moduleKey).toBe("trattamento_minore");
    // Il trattamento firmato non porta con sé l'informativa: la riga resta e propone il secondo modulo.
    expect(out.second).toMatchObject({ missingText: "Informativa", whenText: "oggi alle 11:00" });
    expect(out.second?.target).toEqual({
      patientId: out.s.id,
      moduleKey: "informativa",
      cycleId: null,
      appointmentId: out.a.id,
      guardianId: out.s.elena,
    });
    expect(out.third).toBeUndefined();
    expect(out.records.map((r) => r.moduleKey)).toEqual(["trattamento_minore", "informativa"]);
  });

  it("storico_versioni: valido, sostituito, rifiutato e revocato restano con id, metodo, versione e documento", async () => {
    const out = await inUserA(db, async (tx) => {
      await seedHours(tx);
      const marco = await adult(tx, "Marco", "Bellandi");
      const a = await book(tx, marco, { day: TODAY, time: "09:00" });
      const informativa: ConsentTarget = { patientId: marco, moduleKey: "informativa", cycleId: null, appointmentId: null, guardianId: null };
      const treatment: ConsentTarget = { patientId: marco, moduleKey: "trattamento", cycleId: a.cycleId, appointmentId: null, guardianId: null };
      const uploaded = await uploadOn(tx, informativa, "2026-10-15");
      const signed = await signOnCanvas(tx, informativa);
      const revoked = await signOnCanvas(tx, treatment);
      await revokeConsent(tx, PRACTICE_A, D0, { id: revoked, revokedOn: TODAY, mode: "scritta", note: null });
      const refused = await signOnCanvas(tx, treatment, "rifiuta");
      const stored = await tx.query<{ id: string; missingFields: string[] }>(
        `select id, missing_fields as "missingFields" from public.consent_records where patient_id = $1`,
        [marco],
      );
      return { marco, a, uploaded, signed, revoked, refused, stored, lines: await listPatientConsents(tx, PRACTICE_A, marco) };
    });
    const informativa = { patientId: out.marco, moduleKey: "informativa", cycleId: null, appointmentId: null, guardianId: null };
    const treatment = { patientId: out.marco, moduleKey: "trattamento", cycleId: out.a.cycleId, appointmentId: null, guardianId: null };
    expect(out.lines).toMatchObject([
      {
        id: out.signed,
        moduleKey: "informativa",
        moduleVersion: "2026.1",
        method: "tela",
        documentFileId: null,
        statusLabel: "Valido",
        signedOnText: "22/10/2026",
        canRevoke: true,
        target: informativa,
      },
      {
        id: out.uploaded.id,
        moduleKey: "informativa",
        moduleVersion: "2026.1",
        method: "pdf_caricato",
        documentFileId: out.uploaded.fileId,
        statusLabel: "Sostituito",
        signedOnText: "15/10/2026",
        canRevoke: false,
        target: informativa,
      },
      {
        id: out.refused,
        moduleKey: "trattamento",
        moduleVersion: "2026.1",
        method: "tela",
        statusLabel: "Rifiutato",
        cycleTitle: expect.any(String),
        canRevoke: false,
        target: treatment,
      },
      {
        id: out.revoked,
        moduleKey: "trattamento",
        moduleVersion: "2026.1",
        method: "tela",
        statusLabel: "Revocato il 22/10/2026",
        canRevoke: false,
        target: treatment,
      },
    ]);
    expect(out.lines).toHaveLength(4);
    // Lo studio della fixture non ha indirizzo: i dati mancanti alla firma restano sulla riga («Firmato con dati mancanti»).
    for (const line of out.lines) {
      expect(line.missingFields).toEqual(out.stored.find((r) => r.id === line.id)?.missingFields);
      expect(line.missingFields).toContain("studio.indirizzo");
    }
  });

  it("mancante_non_blocca_fatto: si segna fatto, il pannello offre la raccolta; con la revoca la data, senza annullare", async () => {
    const out = await inUserA(db, async (tx) => {
      await seedHours(tx);
      const marco = await adult(tx, "Marco", "Bellandi");
      const a = await book(tx, marco, { day: TODAY, time: "09:00" });
      await markDone(tx, PRACTICE_A, D0, { id: a.id });
      const missing = await getSedutaFatta(tx, PRACTICE_A, D0, a.id);
      const treatmentId = await signedBefore(tx, marco, a.cycleId);
      const signed = await getSedutaFatta(tx, PRACTICE_A, D0, a.id);
      await revokeConsent(tx, PRACTICE_A, D0, { id: treatmentId, revokedOn: "2026-10-20", mode: "verbale", note: null });
      const revoked = await getSedutaFatta(tx, PRACTICE_A, D0, a.id);
      const [status] = await tx.query<{ status: string }>("select status from public.appointments where id = $1", [a.id]);
      return { marco, a, missing, signed, revoked, status };
    });
    const target = { patientId: out.marco, moduleKey: "trattamento", cycleId: out.a.cycleId, appointmentId: out.a.id, guardianId: null };
    expect(out.missing).toMatchObject({ consentMissing: true, consentTarget: target, consentRevocationText: null, consentBlockText: null });
    expect(out.signed).toMatchObject({ consentMissing: false, consentTarget: null, consentRevocationText: null, consentBlockText: null });
    expect(out.revoked).toMatchObject({
      consentMissing: true,
      consentTarget: target,
      consentRevocationText: "Consenso revocato il 20/10",
      consentBlockText: TREATMENT_CONSENT_REVOKED,
    });
    expect(out.status?.status).toBe("fatto");
  });

  it("revoca_appuntamento_futuro: dettaglio, Seduta fatta e riga di Oggi dicono «Consenso revocato il 20/10»", async () => {
    const out = await inUserA(db, async (tx) => {
      await seedHours(tx);
      const marco = await adult(tx, "Marco", "Bellandi");
      const today = await book(tx, marco, { day: TODAY, time: "15:00" });
      const later = await book(tx, marco, { day: "2026-10-29", time: "15:00" });
      const treatmentId = await signedBefore(tx, marco, today.cycleId);
      const anna = await adult(tx, "Anna", "Morelli");
      const other = await book(tx, anna, { day: TODAY, time: "10:00" });
      await signedBefore(tx, anna, other.cycleId);
      const before = await getAppointmentDetail(tx, PRACTICE_A, D0, today.id);
      await revokeConsent(tx, PRACTICE_A, D0, { id: treatmentId, revokedOn: "2026-10-20", mode: "scritta", note: null });
      const detail = await getAppointmentDetail(tx, PRACTICE_A, D0, today.id);
      const laterDetail = await getAppointmentDetail(tx, PRACTICE_A, D0, later.id);
      const day = await listDayAppointments(tx, PRACTICE_A, D0, TODAY);
      const statuses = await tx.query<{ status: string }>(
        "select status from public.appointments where patient_id = $1 order by starts_at",
        [marco],
      );
      await markDone(tx, PRACTICE_A, D0, { id: today.id });
      const panel = await getSedutaFatta(tx, PRACTICE_A, D0, today.id);
      return { today, other, before, detail, laterDetail, day, statuses, panel };
    });
    expect(out.before).toMatchObject({ consentMissing: false, consentRevocationText: null, consentTarget: null });
    expect(out.detail).toMatchObject({ status: "prenotato", consentMissing: true, consentRevocationText: "Consenso revocato il 20/10" });
    expect(out.detail?.consentTarget).toMatchObject({ moduleKey: "trattamento", cycleId: out.today.cycleId, appointmentId: out.today.id });
    expect(out.laterDetail).toMatchObject({ status: "prenotato", consentRevocationText: "Consenso revocato il 20/10" });
    expect(out.day.map((r) => [r.id, r.consentRevocationText])).toEqual([
      [out.other.id, null],
      [out.today.id, "Consenso revocato il 20/10"],
    ]);
    // La riga revocata mostra la revoca, non anche «Consenso mancante».
    expect(out.day.find((r) => r.id === out.today.id)?.signals).not.toContain("consenso_mancante");
    expect(out.detail?.consentBlockText).toBe(TREATMENT_CONSENT_REVOKED);
    // Nessun appuntamento si annulla da solo.
    expect(out.statuses.map((s) => s.status)).toEqual(["prenotato", "prenotato"]);
    expect(out.panel).toMatchObject({
      consentMissing: true,
      consentRevocationText: "Consenso revocato il 20/10",
      consentBlockText: TREATMENT_CONSENT_REVOKED,
    });
  });

  it("rifiuto_blocca: un rifiuto blocca il trattamento come la revoca, senza data; Riepilogo dice «Rifiutato»", async () => {
    const out = await inUserA(db, async (tx) => {
      await seedHours(tx);
      const marco = await adult(tx, "Marco", "Bellandi");
      const a = await book(tx, marco, { day: TODAY, time: "15:00" });
      const informativa: ConsentTarget = { patientId: marco, moduleKey: "informativa", cycleId: null, appointmentId: null, guardianId: null };
      await signOnCanvas(tx, informativa);
      await signOnCanvas(tx, { patientId: marco, moduleKey: "trattamento", cycleId: a.cycleId, appointmentId: null, guardianId: null }, "rifiuta");
      const detail = await getAppointmentDetail(tx, PRACTICE_A, D0, a.id);
      const row = (await listDayAppointments(tx, PRACTICE_A, D0, TODAY)).find((r) => r.id === a.id);
      const summary = await getSummaryTab(tx, PRACTICE_A, D0, marco);
      return { a, detail, row, summary };
    });
    expect(out.detail).toMatchObject({
      consentMissing: true,
      consentRevocationText: null,
      consentBlockText: "Consenso al trattamento rifiutato: puoi solo annotare il colloquio.",
    });
    expect(out.detail?.consentTarget).toMatchObject({ moduleKey: "trattamento", cycleId: out.a.cycleId });
    expect(out.row).toMatchObject({ consentRevocationText: null, consentRefused: true });
    expect(out.row?.signals).not.toContain("consenso_mancante");
    expect(out.summary?.consents.map((c) => c.state)).toEqual(["Firmato il 22/10/2026", "Rifiutato"]);
  });

  it("raccogli_di_nuovo_bersaglio_attuale: chi ha compiuto 18 anni firma da sé; il genitore senza responsabilità non firma", async () => {
    const later = fixedClock("2026-11-04T08:30:00+01:00");
    const out = await inUserA(db, async (tx) => {
      await seedHours(tx);
      // Maggiorenne dal 25/10/2026: il 22/10 firma la madre, il 4/11 il paziente.
      const { id: teen } = await createPatient(tx, PRACTICE_A, D0, {
        firstName: "Luca",
        lastName: "Neri",
        birthDate: "2008-10-25",
        guardian: { firstName: "Carla", lastName: "Neri" },
      });
      await tx.query("update public.patient_guardians set relationship = 'madre' where patient_id = $1", [teen]);
      await book(tx, teen, { day: "2026-10-23", time: "11:00" });
      for (const row of [0, 1]) {
        const missing = (await listMissingConsents(tx, PRACTICE_A, D0)).find((r) => r.patientId === teen);
        if (!missing) throw new Error(`Luca non è fra i mancanti (${row})`);
        await signOnCanvas(tx, missing.target);
      }
      const teenCollect = await getCollectTargets(tx, PRACTICE_A, later, teen);
      const teenLines = await listPatientConsents(tx, PRACTICE_A, teen, teenCollect ?? undefined);
      const teenPreviews = await Promise.all(
        teenLines.map(async (l) => (await getConsentPreview(tx, PRACTICE_A, later, l.target)) !== null),
      );

      // Sofia: firma la madre; poi la madre perde la responsabilità e firma il padre; poi nessuno.
      const s = await sofia(tx);
      await signOnCanvas(tx, { patientId: s.id, moduleKey: "informativa", cycleId: null, appointmentId: null, guardianId: s.elena });
      await tx.query("update public.patient_guardians set has_parental_authority = false where id = $1", [s.elena]);
      const fatherLines = await listPatientConsents(tx, PRACTICE_A, s.id, (await getCollectTargets(tx, PRACTICE_A, D0, s.id)) ?? undefined);
      const fatherPreview = await getConsentPreview(tx, PRACTICE_A, D0, fatherLines[0]!.target);
      await tx.query("delete from public.patient_guardians where id = $1", [s.father]);
      const noneLines = await listPatientConsents(tx, PRACTICE_A, s.id, (await getCollectTargets(tx, PRACTICE_A, D0, s.id)) ?? undefined);
      return { teen, teenLines, teenPreviews, s, fatherLines, fatherPreview, noneLines };
    });
    // L'ordine della tab: informativa, poi il consenso del genitore del ciclo.
    expect(out.teenLines.map((l) => [l.moduleKey, l.current])).toEqual([
      ["informativa", true],
      ["trattamento_minore", true],
    ]);
    expect(out.teenLines.map((l) => [l.target.moduleKey, l.target.guardianId, l.targetProblem])).toEqual([
      ["informativa", null, null],
      ["trattamento", null, null],
    ]);
    expect(out.teenPreviews).toEqual([true, true]);
    expect(out.fatherLines[0]?.target).toMatchObject({ moduleKey: "informativa", guardianId: out.s.father });
    expect(out.fatherPreview).not.toBeNull();
    expect(out.noneLines[0]?.targetProblem).toBe(NO_GUARDIAN);
  });

  it("ciclo_chiuso_in_oggi: un fatto di un ciclo chiuso senza trattamento ha «Raccogli» spento col motivo", async () => {
    const out = await inUserA(db, async (tx) => {
      await seedHours(tx);
      const marco = await adult(tx, "Marco", "Bellandi");
      const a = await book(tx, marco, { day: "2026-10-20", time: "09:00", status: "fatto" });
      await signOnCanvas(tx, { patientId: marco, moduleKey: "informativa", cycleId: null, appointmentId: null, guardianId: null });
      await tx.query(
        "update public.treatment_cycles set status = 'closed', closed_on = '2026-10-21', outcome = 'raggiunto' where id = $1",
        [a.cycleId],
      );
      return { marco, a, row: (await listMissingConsents(tx, PRACTICE_A, D0)).find((r) => r.patientId === marco) };
    });
    expect(out.row).toMatchObject({ missingText: "Consenso al trattamento", whenText: "seduta del 20/10", targetProblem: NO_CYCLE });
    expect(out.row?.target).toMatchObject({ moduleKey: "trattamento", cycleId: out.a.cycleId });
  });

  it("isolamento: uB non legge bersagli, scelte e genitori dei pazienti di A", async () => {
    const a = await inUserA(db, async (tx) => ({
      collect: await getCollectTargets(tx, PRACTICE_A, D0, PATIENT_A3),
      choices: await listPatientChoices(tx, PRACTICE_A, PATIENT_A1),
      guardians: await loadConsentGuardians(tx, PRACTICE_A, [PATIENT_A3]),
    }));
    // Il controllo che il test vede qualcosa: per A ci sono.
    expect(a.collect?.informativa).toMatchObject({ patientId: PATIENT_A3, guardianId: GUARDIAN_A });
    expect(a.choices.find((c) => c.choice === "whatsapp")).toMatchObject({ value: true, stateText: "Sì, dal 05/10/2026" });
    expect(a.guardians.get(PATIENT_A3)).toBe(GUARDIAN_A);
    for (const practiceId of [PRACTICE_A, PRACTICE_B]) {
      const b = await inRollback(db, "B", async (tx) => ({
        collect: await getCollectTargets(tx, practiceId, D0, PATIENT_A3),
        choices: await listPatientChoices(tx, practiceId, PATIENT_A1),
        guardians: await loadConsentGuardians(tx, practiceId, [PATIENT_A3]),
      }));
      expect(b.collect).toBeNull();
      expect(b.choices.map((c) => [c.value, c.stateText])).toEqual([
        [false, "No"],
        [false, "No"],
      ]);
      expect(b.guardians.get(PATIENT_A3)).toBeNull();
    }
  });
});
