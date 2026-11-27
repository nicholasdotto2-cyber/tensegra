import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DEFAULT_TEMPLATES, type TemplateKey, type Variant } from "@/lib/messages/templates";
import { DEMO_PRACTICE_ID as P, getActor } from "@/server/auth/actor";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import * as commands from "@/server/domain/consents/commands";
import { getConsentPreview } from "@/server/domain/consents/preview";
import { getChannelConsent, listMissingConsents } from "@/server/domain/consents/queries";
import { listReminders } from "@/server/domain/appointments/queries";
import { storageKey } from "@/server/files/keys";
import { telHref } from "@/lib/messages/links";
import { toE164 } from "@/lib/phone";
import { prepareMessage } from "@/server/domain/messages/queries";
import type { MessageSource } from "@/server/domain/messages/schemas";
import { saveDemoTestPhone } from "@/server/domain/settings/commands";
import { ensureConsentDocument } from "@/server/pdf/consent-file";
import { seedDemo } from "../../seed/demo";
import { PATIENTS } from "../../seed/people";
import { pdfText } from "../support/pdf-text";
import { asServiceFor, openTestDb } from "./helpers";
import { MemoryFileStore } from "./memory-store";

const clock = fixedClock("2026-11-04T07:00:00+01:00");
let db: Db;
let pg: PGlite;
const store = new MemoryFileStore();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const asDemo = <T>(fn: (tx: Tx) => Promise<T>) => db.asUser(getActor(), fn);

beforeAll(async () => {
  ({ db, pg } = await openTestDb());
  await seedDemo(db, clock, store);
});
afterAll(async () => { await pg?.close(); });

it("nessun_file_finto", async () => {
  const files = await asDemo(tx => tx.query<{ storage_key: string; size_bytes: number; sha256: string; mime_type: string }>(
    "select storage_key, size_bytes, sha256, mime_type from public.files where practice_id=$1 and kind in ('signature','consent_pdf','consent_upload')", [P]));
  // 24 firme su tela e i due moduli caricati di Lorenzo, un file per consenso, più la firma dell'osteopata.
  expect(files).toHaveLength(27);
  for (const file of files) {
    const bytes = await store.get(file.storage_key);
    expect(bytes, file.storage_key).not.toBeNull();
    expect(bytes!.length).toBe(file.size_bytes);
    expect(file.size_bytes).toBeGreaterThan(0);
    expect(hash(bytes!)).toBe(file.sha256);
    if (file.mime_type === "application/pdf") {
      expect(Buffer.from(bytes!).subarray(0, 5).toString()).toBe("%PDF-");
      expect(bytes!.length).toBeGreaterThan(1024);
    }
  }
  expect(await asDemo(tx => tx.query("select id from public.consent_records where practice_id=$1 and rendered_text ilike '%provvisorio%'", [P]))).toEqual([]);
});

it("seed_senza_render_pdf", async () => {
  const records = await asDemo(tx => tx.query<{ signature_file_id: string | null; document_file_id: string | null }>(
    "select signature_file_id, document_file_id from public.consent_records where practice_id=$1 and method='tela'", [P]));
  expect(records).toHaveLength(24);
  for (const row of records) {
    expect(row.signature_file_id).not.toBeNull();
    expect(row.document_file_id).toBeNull();
  }
  expect(await asDemo(tx => tx.query("select id from public.files where practice_id=$1 and kind='consent_pdf'", [P]))).toEqual([]);
  // Le 24 firme su tela e quella dell'osteopata in Impostazioni.
  expect(store.keys().filter(key => key.includes("/signature/"))).toHaveLength(25);
});

it("firma_osteopata_congelata", async () => {
  // Il seed salva la firma inventata dell'osteopata prima delle raccolte (comando di Impostazioni),
  // così ogni consenso su tela la congela e il PDF non stampa una «Firma dell'osteopata» vuota.
  // Un PNG suo, con un tratto diverso: nel PDF non è la copia della firma del paziente.
  const png = new Uint8Array(await readFile(new URL("../../seed/assets/demo-signature-osteopata.png", import.meta.url)));
  const patientPng = new Uint8Array(await readFile(new URL("../../seed/assets/demo-signature.png", import.meta.url)));
  expect(hash(png)).not.toBe(hash(patientPng));
  const rows = await asDemo(tx => tx.query<{ practitioner: string | null; signer: string; kind: string | null; mime: string | null; sha256: string | null; storage_key: string | null; current: string | null; signer_sha256: string }>(
    `select r.practitioner_signature_file_id as practitioner, r.signature_file_id as signer, f.kind, f.mime_type as mime,
            f.sha256, f.storage_key, s.practitioner_signature_file_id as current, sf.sha256 as signer_sha256
     from public.consent_records r
     join public.practice_settings s on s.practice_id=r.practice_id
     join public.files sf on sf.practice_id=r.practice_id and sf.id=r.signature_file_id
     left join public.files f on f.practice_id=r.practice_id and f.id=r.practitioner_signature_file_id
     where r.practice_id=$1 and r.method='tela'`, [P]));
  expect(rows).toHaveLength(24);
  for (const row of rows) {
    expect(row.practitioner).not.toBeNull();
    expect(row.practitioner).toBe(row.current);
    expect(row.practitioner).not.toBe(row.signer);
    expect(row).toMatchObject({ kind: "signature", mime: "image/png", sha256: hash(png), signer_sha256: hash(patientPng) });
    expect(row.sha256).not.toBe(row.signer_sha256);
    expect(await store.get(row.storage_key!)).toEqual(png);
  }
});

it("lorenzo_upload", async () => {
  const records = await asDemo(tx => tx.query<{ module_key: string; method: string; signer_name: string; storage_key: string }>(
    `select r.module_key, r.method, r.signer_name, f.storage_key from public.consent_records r
     join public.patients p on p.id=r.patient_id and p.practice_id=r.practice_id
     join public.files f on f.id=r.document_file_id and f.practice_id=r.practice_id
     where r.practice_id=$1 and p.first_name='Lorenzo' order by r.module_key`, [P]));
  expect(records.map(r => [r.module_key, r.method, r.signer_name])).toEqual([
    ["informativa", "pdf_caricato", "Paolo Gatti"], ["trattamento_minore", "pdf_caricato", "Paolo Gatti"],
  ]);
  const asset = new Uint8Array(await readFile(new URL("../../seed/assets/modulo-firmato-demo.pdf", import.meta.url)));
  for (const row of records) expect(await store.get(row.storage_key)).toEqual(asset);
  const text = (await pdfText(asset)).text;
  expect(text).toContain("DATI DI PROVA");
  expect(text).not.toMatch(/Lorenzo|Gatti|Paolo/);
});

it("giorgio_fiduciaria", async () => {
  const rows = await asDemo(tx => tx.query<{ trustee_name: string; rendered_text: string }>(
    `select r.trustee_name, r.rendered_text from public.consent_records r join public.patients p on p.id=r.patient_id
     where r.practice_id=$1 and p.first_name='Giorgio' and r.module_key='trattamento'`, [P]));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.trustee_name).toBe("Marta Sala");
  expect(rows[0]?.rendered_text).toContain("Marta Sala");
});

it("martina_revoca", async () => {
  await asDemo(async tx => {
    const [patient] = await tx.query<{ id: string }>("select id from public.patients where practice_id=$1 and first_name='Martina'", [P]);
    const rows = await tx.query<{ value: boolean; decided_on: string; mode: string; created_at: Date }>(
      "select value, decided_on, mode, created_at from public.consent_choices where practice_id=$1 and patient_id=$2 and choice='richiami' order by decided_on", [P, patient!.id]);
    expect(rows.map(r => r.value)).toEqual([true, false]);
    expect(rows[1]).toMatchObject({ decided_on: "2026-11-01", mode: "messaggio" });
    expect(rows[1]?.created_at.toISOString()).toBe("2026-11-01T17:00:00.000Z");
    expect(await getChannelConsent(tx, P, patient!.id, "richiami")).toBe(false);
  });
});

it("dieci_modelli", async () => {
  await asDemo(async tx => {
    const rows = await tx.query<{ key: TemplateKey; variant: Variant; body: string; is_customized: boolean }>(
      "select key, variant, body, is_customized from public.message_templates where practice_id=$1", [P]);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.body).toBe(DEFAULT_TEMPLATES[row.key][row.variant]);
      expect(row.is_customized).toBe(false);
    }
    const reminders = await listReminders(tx, P, clock);
    expect(reminders.rows.map(r => [r.recipientText, r.statusText, r.lastMessage])).toEqual([
      ["Chiara Valli", "Da inviare", null],
      ["Elisa Fontana", "Manca il consenso WhatsApp: telefona o usa Copia per un SMS", null],
      ["Paolo Neri", "Da inviare", null],
    ]);
    expect(reminders.rows[1]?.prepared.recipient.whatsappConsent).toBe(false);
    expect(await tx.query("select id from public.message_log where practice_id=$1", [P])).toEqual([]);
  });
});

it("sofia_preview", async () => {
  await asDemo(async tx => {
    const missing = (await listMissingConsents(tx, P, clock)).find(p => p.firstName === "Sofia");
    expect(missing?.missingText).toBe("Informativa e consenso del genitore");
    const preview = await getConsentPreview(tx, P, clock, missing!.target);
    expect(preview?.rendered.missingFields).toEqual([]);
    expect(preview?.rendered.text).not.toContain("________");
  });
});

it("dati_mancanti_solo_medico", async () => {
  // I maggiorenni del seed hanno un luogo di nascita inventato: alla firma manca al più il medico curante,
  // che la demo lascia vuoto (un medico assente resta segnalato). Roberto ha il curante: nessun vuoto.
  const rows = await asDemo(tx => tx.query<{ name: string; module_key: string; missing_fields: string[] }>(
    `select p.first_name || ' ' || p.last_name as name, r.module_key, r.missing_fields from public.consent_records r
     join public.patients p on p.id=r.patient_id and p.practice_id=r.practice_id
     where r.practice_id=$1 and cardinality(r.missing_fields) > 0 order by name, r.module_key`, [P]));
  expect(rows.map(r => [r.name, r.module_key, r.missing_fields])).toEqual([
    "Anna Morelli", "Chiara Valli", "Davide Conti", "Francesca Longo", "Giorgio Sala",
    "Giulia Ferrante", "Marco Bellandi", "Matteo Ricci", "Paolo Neri", "Valentina Greco",
  ].map(name => [name, "trattamento", ["paziente.medico_curante"]]));
});

it("link_senza_telefoni_seed", async () => {
  // Nessun telefono di pazienti e genitori del seed in un link wa.me o tel:, con o senza
  // il numero di prova della demo (che invece può comparire).
  const seedPhones = PATIENTS.flatMap(p => [p.phone, p.contactGuardian?.phone, p.secondGuardian?.phone])
    .filter((phone): phone is string => !!phone).map(phone => toE164(phone)!.slice(1));
  expect(seedPhones.length).toBeGreaterThan(10);
  const testPhone = "+393990000000";
  expect(seedPhones).not.toContain(testPhone.slice(1));
  const links = async (tx: Tx) => {
    const appointments = await tx.query<{ id: string }>("select id from public.appointments where practice_id=$1", [P]);
    const patients = await tx.query<{ id: string }>("select id from public.patients where practice_id=$1", [P]);
    const visits = await tx.query<{ visit_id: string; ids: string[] }>(
      "select visit_id, array_agg(id) as ids from public.visit_advice where practice_id=$1 and btrim(text) <> '' group by visit_id", [P]);
    const sources: MessageSource[] = [
      ...appointments.flatMap(a => (["conferma", "promemoria", "spostamento"] as const).map(templateKey => ({ kind: "appointment" as const, appointmentId: a.id, templateKey }))),
      ...patients.map(p => ({ kind: "recall" as const, patientId: p.id, templateKey: "richiamo" as const })),
      ...visits.map(v => ({ kind: "visit" as const, visitId: v.visit_id, adviceIds: v.ids, templateKey: "consigli" as const })),
    ];
    const hrefs: string[] = [];
    for (const source of sources) {
      const prepared = await prepareMessage(tx, P, clock, source);
      expect(prepared, JSON.stringify(source)).not.toBeNull();
      if (prepared!.whatsappHref) hrefs.push(prepared!.whatsappHref);
      const tel = telHref(prepared!.recipient);
      if (tel) hrefs.push(tel);
    }
    return hrefs;
  };
  const check = (hrefs: string[], routed: string | null) => {
    expect(hrefs.filter(h => h.startsWith("https://wa.me/")).length).toBeGreaterThan(10);
    for (const href of hrefs) {
      // Senza spazi e "+": un numero scritto come "+39 347 000 0017" nel testo resta riconoscibile.
      const digits = decodeURIComponent(href).replace(/[\s+]/g, "");
      for (const phone of seedPhones) {
        // Con e senza il prefisso 39: il numero non deve esserci né nel percorso né nel testo.
        expect(digits, href).not.toContain(phone);
        expect(digits, href).not.toContain(phone.slice(2));
      }
      if (routed === null) expect(href.startsWith("https://wa.me/?text=") || href.startsWith("tel:"), href).toBe(true);
      else expect(href.startsWith(`https://wa.me/${routed.slice(1)}?text=`) || href === `tel:${routed}`, href).toBe(true);
    }
  };
  check(await asDemo(links), null);
  try {
    await asDemo(tx => saveDemoTestPhone(tx, P, clock, { demoTestPhone: testPhone }));
    check(await asDemo(links), testPhone);
  } finally {
    await asDemo(tx => saveDemoTestPhone(tx, P, clock, { demoTestPhone: "" }));
  }
});

it("download_pdf_pigro", async () => {
  const [row] = await asDemo(tx => tx.query<{ id: string }>(
    "select id from public.consent_records where practice_id=$1 and method='tela' order by record_order limit 1", [P]));
  const ctx = { db, practiceId: P, actor: getActor() };
  const before = store.keys();
  const first = await ensureConsentDocument(ctx, clock, store, row!.id);
  expect(first).not.toBeNull();
  expect(Buffer.from(first!.bytes).subarray(0, 5).toString()).toBe("%PDF-");
  expect(first!.bytes.length).toBeGreaterThan(1024);
  expect((await pdfText(first!.bytes)).text).toContain("DATI DI PROVA");
  const [file] = await asDemo(tx => tx.query<{ storage_key: string; sha256: string; size_bytes: number }>(
    "select storage_key, sha256, size_bytes from public.files where practice_id=$1 and kind='consent_pdf'", [P]));
  expect(await store.get(file!.storage_key)).toEqual(first!.bytes);
  expect(hash(first!.bytes)).toBe(file!.sha256);
  expect(first!.bytes.length).toBe(file!.size_bytes);
  const after = store.keys();
  expect(after.length).toBe(before.length + 1);
  expect((await ensureConsentDocument(ctx, clock, store, row!.id))?.bytes).toEqual(first?.bytes);
  expect(store.keys()).toEqual(after);
  expect(await asDemo(tx => tx.query("select id from public.consent_records where practice_id=$1", [P]))).toHaveLength(26);
});

it("seed_rollback", async () => {
  const fresh = await openTestDb();
  const rollbackStore = new MemoryFileStore();
  const key = storageKey(P, "signature", randomUUID(), "image/png");
  const bytes = Uint8Array.of(1, 2, 3);
  await rollbackStore.put(key, bytes);
  const real = commands.signConsent;
  const spy = vi.spyOn(commands, "signConsent").mockImplementationOnce(real).mockRejectedValueOnce(new Error("Comando seed fallito"));
  try {
    await expect(seedDemo(fresh.db, clock, rollbackStore)).rejects.toThrow("Comando seed fallito");
    expect(await asServiceFor(fresh.db, tx => tx.query("select id from public.practices where id=$1", [P]))).toEqual([]);
    expect(await asServiceFor(fresh.db, tx => tx.query("select id from public.files where practice_id=$1", [P]))).toEqual([]);
    expect(rollbackStore.keys()).toEqual([key]);
    expect(await rollbackStore.get(key)).toEqual(bytes);
  } finally {
    spy.mockRestore();
    await fresh.pg.close();
  }
});
