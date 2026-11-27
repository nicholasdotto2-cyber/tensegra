import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { timeOf } from "@/lib/format";
import { type Clock, fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { cancelAppointment, createAppointment } from "@/server/domain/appointments/commands";
import { getOpenCycle } from "@/server/domain/cycles/queries";
import { createPatient } from "@/server/domain/patients/commands";
import { saveOpeningHours } from "@/server/domain/settings/commands";
import { APPOINTMENT_A, FILE_A, PRACTICE_A, PRACTICE_B, SERVICE_A, sha256Hex } from "./fixtures";
import { asUserB, inUserA, openTestDb } from "./helpers";

// Stati e azioni dei promemoria: l'ultima riga `promemoria`
// dell'appuntamento decide lo stato, dopo numero, canale e consenso WhatsApp, in quest'ordine. Il blocco è
// quello del primo giorno aperto dopo oggi (A1). L'orologio è giovedì 22/10/2026 alle 08:30 di Roma, salvo
// dove scritto; i dati nascono come uA con i comandi dell'app e ogni test torna indietro.
const D0 = fixedClock("2026-10-22T08:30:00+02:00");
const TOMORROW = "2026-10-23";
const at = (day: string, time: string, offset = "+02:00"): Clock => fixedClock(`${day}T${time}:00${offset}`);
const NO_CONSENT = "Manca il consenso WhatsApp: telefona o usa Copia per un SMS";

const api = async () => ({
  ...(await import("@/server/domain/appointments/queries")),
  ...(await import("@/server/domain/messages/commands")),
});

let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

const MORNING = { opens: "09:00", closes: "13:00" };
const AFTERNOON = { opens: "14:30", closes: "19:30" };
/** Gli orari del seed: lun-ven 09:00-13:00 e 14:30-19:30, sab 09:00-13:00, dom chiuso. */
const SEED_HOURS = {
  days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    bands: weekday <= 5 ? [MORNING, AFTERNOON] : weekday === 6 ? [MORNING] : [],
  })),
};

interface Person { phone?: string | null; channel?: "whatsapp" | "telefono" | "nessuno"; consent?: boolean }

/** Un adulto con il tu (il modello conferma/Lei della fixture non si compila), cellulare, canale WhatsApp e, se
 * `consent`, informativa valida e sì a WhatsApp. */
async function adult(tx: Tx, firstName: string, lastName: string, p: Person = {}): Promise<string> {
  const { id } = await createPatient(tx, PRACTICE_A, D0, { firstName, lastName, birthDate: "1979-03-09" });
  await tx.query("update public.patients set phone = $2, preferred_channel = $3, addressing = 'tu' where id = $1", [
    id, p.phone === undefined ? "+393330000077" : p.phone, p.channel ?? "whatsapp",
  ]);
  if (p.consent ?? true) await whatsappConsent(tx, id);
  return id;
}

/** Sofia Rinaldi, 4 mesi, con la madre Elena come contatto (cellulare); nessun consenso. */
async function sofia(tx: Tx): Promise<string> {
  const { id } = await createPatient(tx, PRACTICE_A, D0, {
    firstName: "Sofia", lastName: "Rinaldi", birthDate: "2026-06-12", guardian: { firstName: "Elena", lastName: "Rinaldi" },
  });
  await tx.query("update public.patient_guardians set relationship = 'madre', phone = '+393330000088' where patient_id = $1", [id]);
  return id;
}

async function whatsappConsent(tx: Tx, patientId: string, value = true): Promise<void> {
  const text = "Informativa di prova per i promemoria.";
  await tx.query(
    `insert into public.consent_records (practice_id, patient_id, module_key, module_version, rendered_text, rendered_hash,
                                         signer_kind, signer_name, method, signature_file_id, signed_on)
     values ($1, $2, 'informativa', '2026.1', $3, $4, 'paziente', 'Marco Bellandi', 'tela', $5, '2026-10-15')`,
    [PRACTICE_A, patientId, text, sha256Hex(text), FILE_A],
  );
  await tx.query(
    "insert into public.consent_choices (practice_id, patient_id, choice, value, decided_on, mode) values ($1, $2, 'whatsapp', $3, '2026-10-15', 'verbale')",
    [PRACTICE_A, patientId, value],
  );
}

/** Prenota nel ciclo aperto del paziente, o in un ciclo nuovo; seduta da 45 minuti. */
async function book(tx: Tx, patientId: string, day: string, time: string): Promise<string> {
  const open = await getOpenCycle(tx, PRACTICE_A, patientId);
  const created = await createAppointment(tx, PRACTICE_A, D0, {
    patient: { kind: "existing", patientId },
    serviceId: SERVICE_A,
    day,
    time,
    durationMin: 45,
    cycle: open ? { kind: "existing", cycleId: open.id } : { kind: "new" },
    priceCents: 6000,
    status: "prenotato",
  });
  const [first] = created.appointments;
  if (!first) throw new Error("nessun appuntamento creato");
  return first.id;
}

async function record(
  tx: Tx,
  clock: Clock,
  appointmentId: string,
  action: "copiato" | "whatsapp_aperto",
  templateKey: "conferma" | "promemoria" | "spostamento" = "promemoria",
): Promise<string> {
  const { id } = await (await api()).recordMessage(tx, PRACTICE_A, clock, {
    id: randomUUID(),
    source: { kind: "appointment", appointmentId, templateKey },
    body: "Ciao Marco, ci vediamo domani.",
    action,
  });
  return id;
}

async function rowOf(tx: Tx, appointmentId: string, clock: Clock = D0) {
  const block = await (await api()).listReminders(tx, PRACTICE_A, clock);
  const row = block.rows.find((r) => r.appointmentId === appointmentId);
  if (!row) throw new Error("appuntamento assente dal blocco");
  return row;
}

const logCount = async (tx: Tx) =>
  (await tx.query<{ n: number }>("select count(*)::int as n from public.message_log"))[0]?.n ?? 0;

describe("stati del promemoria", () => {
  it("stati_10_10", async () => inUserA(db, async (tx) => {
    const a = await api();
    await saveOpeningHours(tx, PRACTICE_A, D0, SEED_HOURS);
    const marco = await adult(tx, "Marco", "Bellandi");
    const appointment = await book(tx, marco, TOMORROW, "09:00");

    const empty = await rowOf(tx, appointment);
    expect(empty).toMatchObject({ statusText: "Da inviare", lastMessage: null });
    expect(empty.prepared).toMatchObject({ templateKey: "promemoria", patientId: marco, copyAllowed: true });
    expect(empty.prepared.whatsappHref).toMatch(/^https:\/\/wa\.me\/393330000077\?text=/);

    // Da confermare: il testo dice l'azione vera, aperto o copiato, con l'ora della riga.
    const evening = at("2026-10-22", "18:02");
    const opened = await record(tx, evening, appointment, "whatsapp_aperto");
    const afterOpen = await rowOf(tx, appointment);
    expect(afterOpen.statusText).toBe("Aperto alle 18:02, inviato?");
    expect(afterOpen.lastMessage).toMatchObject({ id: opened, action: "whatsapp_aperto", outcome: "da_confermare" });
    // Stesso istante: vince l'ultima riga inserita.
    const copied = await record(tx, evening, appointment, "copiato");
    expect((await rowOf(tx, appointment)).statusText).toBe("Copiato alle 18:02, inviato?");
    expect((await rowOf(tx, appointment)).lastMessage?.id).toBe(copied);

    // Sì alle 18:03 cambia l'esito di quella riga, senza un secondo evento; No riapre le azioni.
    const rows = await logCount(tx);
    await a.setMessageOutcome(tx, PRACTICE_A, at("2026-10-22", "18:03"), { id: copied, outcome: "inviato" });
    const sent = await rowOf(tx, appointment);
    expect(sent.statusText).toBe("Inviato alle 18:03");
    expect(sent.lastMessage).toMatchObject({ id: copied, outcome: "inviato" });
    await a.setMessageOutcome(tx, PRACTICE_A, at("2026-10-22", "18:04"), { id: copied, outcome: "non_inviato" });
    expect((await rowOf(tx, appointment)).statusText).toBe("Non inviato");
    // Dalla cronologia si corregge anche una riga più vecchia: lo stato segue sempre l'ultima.
    await a.setMessageOutcome(tx, PRACTICE_A, at("2026-10-22", "18:05"), { id: opened, outcome: "inviato" });
    expect((await rowOf(tx, appointment)).statusText).toBe("Non inviato");
    expect(await logCount(tx)).toBe(rows);

    // Conferma e spostamento più recenti dello stesso appuntamento non toccano il promemoria.
    await record(tx, at("2026-10-22", "18:10"), appointment, "copiato", "conferma");
    await record(tx, at("2026-10-22", "18:11"), appointment, "whatsapp_aperto", "spostamento");
    const unchanged = await rowOf(tx, appointment);
    expect(unchanged.statusText).toBe("Non inviato");
    expect(unchanged.lastMessage).toMatchObject({ id: copied, templateKey: "promemoria", outcome: "non_inviato" });

    // Il dettaglio legge la stessa riga; fuori da A1 o annullato non c'è promemoria.
    expect(await a.getAppointmentReminder(tx, PRACTICE_A, D0, appointment)).toEqual(unchanged);
    const later = await book(tx, marco, "2026-10-26", "09:00");
    expect(await a.getAppointmentReminder(tx, PRACTICE_A, D0, later)).toBeNull();
    const other = await book(tx, marco, TOMORROW, "11:00");
    expect(await a.getAppointmentReminder(tx, PRACTICE_A, D0, other)).toMatchObject({ statusText: "Da inviare" });
    await cancelAppointment(tx, PRACTICE_A, D0, { id: other, reason: "paziente", alsoFollowing: false });
    expect(await a.getAppointmentReminder(tx, PRACTICE_A, D0, other)).toBeNull();
  }));

  it("isolamento: uB non legge il promemoria di un appuntamento di A", async () => {
    const a = await api();
    const out = await asUserB(db, async (tx) => ({
      own: await a.getAppointmentReminder(tx, PRACTICE_B, D0, APPOINTMENT_A),
      other: await a.getAppointmentReminder(tx, PRACTICE_A, D0, APPOINTMENT_A),
    }));
    expect(out).toEqual({ own: null, other: null });
  });

  it("elisa", async () => inUserA(db, async (tx) => {
    await saveOpeningHours(tx, PRACTICE_A, D0, SEED_HOURS);
    const elisa = await adult(tx, "Elisa", "Fontana", { consent: false });
    const appointment = await book(tx, elisa, TOMORROW, "10:00");

    // Senza consenso WhatsApp: niente link, la copia resta per un SMS.
    const denied = await rowOf(tx, appointment);
    expect(denied.statusText).toBe(NO_CONSENT);
    expect(denied.prepared).toMatchObject({ copyAllowed: true, whatsappHref: null });

    // Una copia per l'SMS: lo storico viene dopo il consenso.
    await record(tx, D0, appointment, "copiato");
    expect((await rowOf(tx, appointment)).statusText).toBe(NO_CONSENT);
    expect((await rowOf(tx, appointment)).lastMessage).toMatchObject({ action: "copiato", outcome: "da_confermare" });

    // Canale non previsto prima del consenso, numero prima del canale.
    const set = (phone: string | null, channel: NonNullable<Person["channel"]>) =>
      tx.query("update public.patients set phone = $2, preferred_channel = $3 where id = $1", [elisa, phone, channel]);
    await set("+393330000077", "telefono");
    expect((await rowOf(tx, appointment)).statusText).toBe("Preferisce una telefonata");
    await set("+393330000077", "nessuno");
    expect((await rowOf(tx, appointment)).statusText).toBe("Nessun promemoria");
    await set(null, "telefono");
    expect((await rowOf(tx, appointment)).statusText).toBe("Numero mancante");
    await set("+390510000000", "nessuno");
    expect((await rowOf(tx, appointment)).statusText).toBe("Numero fisso: WhatsApp non disponibile");
    for (const blocked of [null, "+390510000000"]) {
      await set(blocked, "whatsapp");
      const row = await rowOf(tx, appointment);
      expect(row.prepared).toMatchObject({ copyAllowed: true, whatsappHref: null });
    }
    await set("+393330000077", "telefono");
    expect((await rowOf(tx, appointment)).prepared).toMatchObject({ copyAllowed: true, whatsappHref: null });

    // Con consenso e canale WhatsApp torna lo storico.
    await set("+393330000077", "whatsapp");
    await whatsappConsent(tx, elisa);
    const allowed = await rowOf(tx, appointment);
    expect(allowed.statusText).toBe("Copiato alle 08:30, inviato?");
    expect(allowed.prepared.whatsappHref).toMatch(/^https:\/\/wa\.me\/393330000077\?text=/);
  }));

  it("a1", async () => inUserA(db, async (tx) => {
    await saveOpeningHours(tx, PRACTICE_A, D0, SEED_HOURS);
    const marco = await adult(tx, "Marco", "Bellandi");
    const minor = await sofia(tx);
    await book(tx, marco, "2026-10-24", "09:00");
    await book(tx, minor, "2026-10-24", "10:00");
    await book(tx, marco, "2026-10-26", "09:30");
    await book(tx, minor, "2026-10-26", "11:00");

    const read = async (clock: Clock) => {
      const block = await (await api()).listReminders(tx, PRACTICE_A, clock);
      return {
        day: block.day,
        title: block.title,
        rows: block.rows.map((r) => ({
          time: timeOf(r.startsAt), recipientText: r.recipientText, statusText: r.statusText,
          to: r.prepared.recipient.name, body: r.prepared.body,
        })),
      };
    };
    // Venerdì (anche la sera), sabato e domenica (dal 25/10 l'ora solare): stessi nomi e orari per ora del giorno.
    const friday = [await read(at("2026-10-23", "08:30")), await read(at("2026-10-23", "19:00"))];
    const saturday = [await read(at("2026-10-24", "08:30")), await read(at("2026-10-24", "12:00"))];
    const sunday = [await read(at("2026-10-25", "08:30", "+01:00")), await read(at("2026-10-25", "21:00", "+01:00"))];
    expect(friday[1]).toEqual(friday[0]);
    expect(saturday[1]).toEqual(saturday[0]);
    expect(sunday[1]).toEqual(sunday[0]);

    expect(friday[0]).toMatchObject({ day: "2026-10-24", title: "Promemoria per domani, sabato 24" });
    expect(friday[0]?.rows).toMatchObject([
      { time: "09:00", recipientText: "Marco Bellandi", statusText: "Da inviare", to: "Marco Bellandi" },
      { time: "10:00", recipientText: "Sofia Rinaldi, a Elena (madre)", statusText: NO_CONSENT, to: "Elena Rinaldi" },
    ]);
    expect(friday[0]?.rows[0]?.body).toContain("di domani, sabato 24 ottobre, alle 09:00");
    expect(friday[0]?.rows[1]?.body).toMatch(/^Buongiorno Elena, le ricordo l'appuntamento per Sofia di domani, sabato 24 ottobre, alle 10:00/);

    // Sabato: A1 è lunedì, due giorni dopo, senza «domani».
    expect(saturday[0]).toMatchObject({ day: "2026-10-26", title: "Promemoria per lunedì 26" });
    expect(saturday[0]?.rows.map((r) => [r.time, r.recipientText])).toEqual([
      ["09:30", "Marco Bellandi"],
      ["11:00", "Sofia Rinaldi, a Elena (madre)"],
    ]);
    expect(saturday[0]?.rows[0]?.body).toContain("di lunedì 26 ottobre alle 09:30");

    expect(sunday[0]).toMatchObject({ day: "2026-10-26", title: "Promemoria per domani, lunedì 26" });
    expect(sunday[0]?.rows.map((r) => [r.time, r.recipientText])).toEqual(saturday[0]?.rows.map((r) => [r.time, r.recipientText]));
    expect(sunday[0]?.rows[0]?.body).toContain("di domani, lunedì 26 ottobre, alle 09:30");
  }));
});
