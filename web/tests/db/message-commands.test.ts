import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { whatsappHref } from "@/lib/messages/links";
import { fixedClock } from "@/server/clock";
import type { Db, Tx } from "@/server/db/db";
import { NOT_ALLOWED } from "@/server/domain/errors";
import type { MessageSource } from "@/server/domain/messages/schemas";
import {
  APPOINTMENT_A,
  APPOINTMENT_B,
  CYCLE_A,
  FILE_A,
  GUARDIAN_A,
  MESSAGE_LOG_A,
  MESSAGE_LOG_B,
  PATIENT_A1,
  PATIENT_A2,
  PATIENT_A3,
  PATIENT_B1,
  PRACTICE_A,
  PRACTICE_B,
  SERVICE_A,
  VISIT_A,
  sha256Hex,
} from "./fixtures";
import { asServiceFor, expectPgError, inRollback, inUserA, openTestDb } from "./helpers";

// Registro dei messaggi e anteprima autorizzata. Le
// fixture: A1 Giulia Ferrari (Lei) con informativa valida e WhatsApp accettato nel modulo, senza
// consenso ai richiami; l'appuntamento del 5/10 e la visita in bozza con un consiglio; il modello
// conferma/Lei salvato con il segnaposto sconosciuto {giorno}.
const clock = fixedClock("2026-10-22T08:30:00+02:00");
const later = fixedClock("2026-10-22T18:03:00+02:00");
const api = async () => ({
  ...(await import("@/server/domain/messages/commands")),
  ...(await import("@/server/domain/messages/queries")),
});
let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

// Il consiglio della fixture sulla visita di B: uA non lo vede, uB non lo può legare a una visita di A.
const ADVICE_A = "a0000000-0000-4000-8000-000000000608";
const promemoria: MessageSource = { kind: "appointment", appointmentId: APPOINTMENT_A, templateKey: "promemoria" };
const recall = (patientId: string): MessageSource => ({ kind: "recall", patientId, templateKey: "richiamo" });
const TOO_LONG = "Il messaggio supera i 700 caratteri: accorcialo prima di copiare.";

async function record(tx: Tx, input: Record<string, unknown>, at = clock) {
  return (await api()).recordMessage(tx, PRACTICE_A, at, { id: randomUUID(), source: promemoria, body: "Ciao", action: "copiato", ...input });
}
async function logRow(tx: Tx, id: string) {
  const [row] = await tx.query<Record<string, unknown>>(
    `select patient_id, appointment_id, visit_id, template_key, recipient_kind, recipient_name, recipient_phone,
            body, action, outcome, outcome_at, created_at
       from public.message_log where id = $1`,
    [id],
  );
  return row;
}
const count = async (tx: Tx) => (await tx.query<{ n: number }>("select count(*)::int as n from public.message_log"))[0]?.n;
const withPhone = (tx: Tx, patientId = PATIENT_A1) =>
  tx.query("update public.patients set phone = '+393330000077', preferred_channel = 'whatsapp' where id = $1", [patientId]);
const choice = (tx: Tx, patientId: string, kind: "whatsapp" | "richiami", value: boolean) =>
  tx.query(
    "insert into public.consent_choices (practice_id, patient_id, choice, value, decided_on, mode) values ($1, $2, $3, $4, '2026-10-22', 'verbale')",
    [PRACTICE_A, patientId, kind, value],
  );
async function informativa(tx: Tx, patientId: string) {
  const text = "Informativa di prova per i richiami.";
  await tx.query(
    `insert into public.consent_records (practice_id, patient_id, module_key, module_version, rendered_text, rendered_hash,
                                         signer_kind, signer_name, method, signature_file_id, signed_on)
     values ($1, $2, 'informativa', '2026.1', $3, $4, 'paziente', 'Luca Romano', 'tela', $5, '2026-10-06')`,
    [PRACTICE_A, patientId, text, sha256Hex(text), FILE_A],
  );
}
const studioCompleto = (tx: Tx) =>
  tx.query(
    "update public.practice_settings set address_line = 'Via delle Prove 7', city = 'Bologna', phone = '+390510000000' where practice_id = $1",
    [PRACTICE_A],
  );

describe("registro dei messaggi", () => {
  it.each(["inviato", "non_inviato", "da_confermare"] as const)("esito identico %s: nessun update o nuovo evento", async (outcome) => inUserA(db, async (tx) => {
    const a = await api();
    const { id } = await record(tx, { body: "Ciao Giulia" });
    await a.setMessageOutcome(tx, PRACTICE_A, clock, { id, outcome });
    const rows = () => tx.query("select id, ctid::text, body, action, outcome, outcome_at, updated_at from public.message_log order by id");
    const before = await rows();
    await a.setMessageOutcome(tx, PRACTICE_A, later, { id, outcome });
    expect(await rows()).toEqual(before);
  }));

  it("log_testo_effettivo", async () => inUserA(db, async (tx) => {
    const a = await api();
    const prepared = await a.prepareMessage(tx, PRACTICE_A, clock, promemoria);
    expect(prepared).toMatchObject({ patientId: PATIENT_A1, templateKey: "promemoria", copyAllowed: true, copyDisabledReason: null, copyDisabledCode: null });
    expect(prepared?.body).toMatch(/^Buongiorno Giulia, le ricordo l'appuntamento di lunedì 5 ottobre alle 09:00, in \. /);
    const id = randomUUID();
    expect(await a.recordMessage(tx, PRACTICE_A, clock, { id, source: promemoria, body: "Ciao Chiara, ci vediamo giovedì.", action: "copiato" })).toEqual({ id });
    expect(await logRow(tx, id)).toEqual({
      patient_id: PATIENT_A1, appointment_id: APPOINTMENT_A, visit_id: null, template_key: "promemoria",
      recipient_kind: "paziente", recipient_name: "Giulia Ferrari", recipient_phone: null,
      body: "Ciao Chiara, ci vediamo giovedì.", action: "copiato", outcome: "da_confermare", outcome_at: null,
      created_at: clock.now(),
    });
  }));

  it("demo_numero_effettivo", async () => inUserA(db, async (tx) => {
    await withPhone(tx);
    const copied = await record(tx, { action: "copiato" });
    const opened = await record(tx, { action: "whatsapp_aperto" });
    expect((await logRow(tx, copied.id))?.recipient_phone).toBe("+393330000077");
    expect((await logRow(tx, opened.id))?.recipient_phone).toBe("+393330000077");
    await tx.query("update public.practice_settings set is_demo = true, demo_test_phone = null where practice_id = $1", [PRACTICE_A]);
    const a = await api();
    expect((await a.prepareMessage(tx, PRACTICE_A, clock, promemoria))?.whatsappHref).toMatch(/^https:\/\/wa\.me\/\?text=/);
    const demoOpened = await record(tx, { action: "whatsapp_aperto" });
    const demoCopied = await record(tx, { action: "copiato" });
    expect((await logRow(tx, demoOpened.id))?.recipient_phone).toBeNull();
    expect((await logRow(tx, demoCopied.id))?.recipient_phone).toBe("+393330000077");
    await tx.query("update public.practice_settings set demo_test_phone = '+393330000099' where practice_id = $1", [PRACTICE_A]);
    expect((await a.prepareMessage(tx, PRACTICE_A, clock, promemoria))?.whatsappHref).toMatch(/^https:\/\/wa\.me\/393330000099\?text=/);
    const testOpened = await record(tx, { action: "whatsapp_aperto" });
    expect((await logRow(tx, testOpened.id))?.recipient_phone).toBe("+393330000099");
  }));

  it("retry_id", async () => inUserA(db, async (tx) => {
    const id = randomUUID();
    const before = await count(tx);
    expect(await record(tx, { id, body: "Ciao Giulia" })).toEqual({ id });
    expect(await record(tx, { id, body: "Ciao Giulia" }, later)).toEqual({ id });
    expect(await count(tx)).toBe((before ?? 0) + 1);
    await expect(record(tx, { id, body: "Ciao Giulia, a domani" })).rejects.toThrow(NOT_ALLOWED);
    await expect(record(tx, { id, body: "Ciao Giulia", action: "whatsapp_aperto" })).rejects.toThrow(NOT_ALLOWED);
    expect(await count(tx)).toBe((before ?? 0) + 1);
    expect((await logRow(tx, id))?.body).toBe("Ciao Giulia");
  }));

  it("esito_correggibile", async () => {
    await inUserA(db, async (tx) => {
      const a = await api();
      const { id } = await record(tx, { body: "Ciao Giulia" });
      await a.setMessageOutcome(tx, PRACTICE_A, clock, { id, outcome: "inviato" });
      expect(await logRow(tx, id)).toMatchObject({ outcome: "inviato", outcome_at: clock.now(), body: "Ciao Giulia", action: "copiato" });
      await a.setMessageOutcome(tx, PRACTICE_A, later, { id, outcome: "non_inviato" });
      expect(await logRow(tx, id)).toMatchObject({ outcome: "non_inviato", outcome_at: later.now(), body: "Ciao Giulia", action: "copiato" });
      await expect(a.setMessageOutcome(tx, PRACTICE_A, clock, { id: randomUUID(), outcome: "inviato" })).rejects.toThrow(NOT_ALLOWED);
    });
    await expectPgError(
      inUserA(db, (tx) => tx.query("update public.message_log set body = 'Un altro testo' where id = $1", [MESSAGE_LOG_A])),
      "42501",
    );
  });

  it("canali_server", async () => inUserA(db, async (tx) => {
    const a = await api();
    await withPhone(tx);
    await choice(tx, PATIENT_A1, "whatsapp", false);
    // Organizzativo senza consenso WhatsApp: copia sì, apertura no.
    expect(await a.prepareMessage(tx, PRACTICE_A, clock, promemoria)).toMatchObject({ copyAllowed: true, whatsappHref: null });
    expect((await record(tx, { action: "copiato" })).id).toBeTruthy();
    await expect(record(tx, { action: "whatsapp_aperto" })).rejects.toThrow("Manca il consenso WhatsApp");
    // Richiamo senza consenso ai richiami: niente, nemmeno la copia.
    expect(await a.prepareMessage(tx, PRACTICE_A, clock, recall(PATIENT_A1))).toMatchObject({
      copyAllowed: false, copyDisabledReason: "Manca il consenso ai richiami", copyDisabledCode: "non_ammesso", whatsappHref: null,
    });
    await expect(record(tx, { source: recall(PATIENT_A1) })).rejects.toThrow("Manca il consenso ai richiami");
    // Consigli senza consenso WhatsApp: niente copia.
    const advice: MessageSource = { kind: "visit", visitId: VISIT_A, adviceIds: [ADVICE_A], templateKey: "consigli" };
    expect(await a.prepareMessage(tx, PRACTICE_A, clock, advice)).toMatchObject({
      copyAllowed: false, copyDisabledReason: "Manca il consenso WhatsApp", copyDisabledCode: "non_ammesso", whatsappHref: null,
    });
    await choice(tx, PATIENT_A1, "whatsapp", true);
    expect((await a.prepareMessage(tx, PRACTICE_A, clock, advice))?.body).toContain("le riporto i consigli di oggi: Cammina venti minuti al giorno Se nei");
    // Il consiglio della fixture è scritto senza modello: la copia lo rifiuta senza scrivere.
    const before = await count(tx);
    await expect(record(tx, { source: advice, action: "copiato" })).rejects.toThrow(NOT_ALLOWED);
    expect(await count(tx)).toBe(before);
  }));

  it.each([
    ["Manca il consenso WhatsApp", "whatsapp"],
    ["Preferisce una telefonata", "telefono"],
    ["Nessun promemoria", "nessuno"],
  ] as const)("nessun_link_whatsapp: %s", async (reason, channel) => inUserA(db, async (tx) => {
    const a = await api();
    await withPhone(tx);
    expect((await a.prepareMessage(tx, PRACTICE_A, clock, promemoria))?.whatsappHref).toBe(
      "https://wa.me/393330000077?text=Buongiorno%20Giulia%2C%20le%20ricordo%20l'appuntamento%20di%20luned%C3%AC%205%20ottobre%20alle%2009%3A00%2C%20in%20.%20Se%20non%20potesse%20venire%2C%20mi%20avvisi%20qui%3A%20potr%C3%B2%20offrire%20l'orario%20a%20un'altra%20persona.%20Cordiali%20saluti.%20Anna%20Rossi%2C%20Studio%20A",
    );
    if (channel === "whatsapp") await choice(tx, PATIENT_A1, "whatsapp", false);
    else await tx.query("update public.patients set preferred_channel = $2 where id = $1", [PATIENT_A1, channel]);
    const prepared = await a.prepareMessage(tx, PRACTICE_A, clock, promemoria);
    expect(prepared).toMatchObject({ whatsappHref: null, copyAllowed: true, recipient: { whatsappDisabledReason: reason } });
    await expect(record(tx, { action: "whatsapp_aperto" })).rejects.toThrow(reason);
  }));

  it("modello_salvato_non_valido", async () => inUserA(db, async (tx) => {
    const a = await api();
    const message = "Il modello Conferma (Lei) non si può usare. Segnaposto non riconosciuto: {giorno}.";
    const source: MessageSource = { kind: "appointment", appointmentId: APPOINTMENT_A, templateKey: "conferma" };
    // Ciò che la UI riceve: il perché una volta sola, il link a parte con il suo testo.
    const { body, copyAllowed, copyDisabledReason, whatsappHref, missing } = (await a.prepareMessage(tx, PRACTICE_A, clock, source))!;
    expect({ body, copyAllowed, copyDisabledReason, whatsappHref, missing }).toEqual({
      body: "", copyAllowed: false, copyDisabledReason: message, whatsappHref: null,
      missing: [{ key: "modello", message: "Correggi il modello in Impostazioni, Messaggi", href: "/impostazioni/messaggi" }],
    });
    await expect(record(tx, { source })).rejects.toThrow(message);
  }));

  it("link_dal_testo_finale", async () => inUserA(db, async (tx) => {
    const a = await api();
    await withPhone(tx);
    await studioCompleto(tx);
    // 684 + "Via delle Prove 7, Bologna" = 710 code points compilati, ritoccati a 300.
    await tx.query(
      "insert into public.message_templates (practice_id, key, variant, body) values ($1, 'promemoria', 'lei', $2)",
      [PRACTICE_A, `${"a".repeat(684)}{indirizzo}`],
    );
    const prepared = (await a.prepareMessage(tx, PRACTICE_A, clock, promemoria))!;
    expect(Array.from(prepared.body)).toHaveLength(710);
    expect(prepared).toMatchObject({ copyAllowed: false, copyDisabledReason: TOO_LONG, copyDisabledCode: "troppo_lungo", whatsappHref: null });
    const edited = "b".repeat(300);
    const { id } = await record(tx, { body: edited, action: "whatsapp_aperto" });
    expect(await logRow(tx, id)).toMatchObject({ body: edited, action: "whatsapp_aperto", recipient_phone: "+393330000077" });
    expect(whatsappHref(prepared.recipient, edited)).toBe(`https://wa.me/393330000077?text=${"b".repeat(300)}`);
  }));

  it("doppio_clic_stesso_id", async () => inUserA(db, async (tx) => {
    // Il secondo clic ha letto il registro prima che il primo scrivesse: la sua select non vede la riga.
    const racing = (target: Tx): Tx => {
      let hidden = true;
      return {
        query: (text, params) => {
          if (hidden && text.includes("from public.message_log where practice_id = $1 and id = $2")) {
            hidden = false;
            return Promise.resolve([]);
          }
          return target.query(text, params);
        },
      };
    };
    const id = randomUUID();
    await record(tx, { id, body: "Ciao Giulia" });
    const before = await count(tx);
    expect(await record(racing(tx), { id, body: "Ciao Giulia" })).toEqual({ id });
    expect(await count(tx)).toBe(before);
    await expect(record(racing(tx), { id, body: "Ciao Giulia, a domani" })).rejects.toThrow(NOT_ALLOWED);
    expect((await logRow(tx, id))?.body).toBe("Ciao Giulia");
    // Lo stesso id di una riga di un altro studio resta un rifiuto generico.
    const foreign = await (await api()).recordMessage(racing(tx), PRACTICE_A, clock, { id: MESSAGE_LOG_B, source: promemoria, body: "Ciao", action: "copiato" }).catch((e: unknown) => e);
    expect(foreign).toMatchObject({ name: "DomainError", message: NOT_ALLOWED });
  }));

  it("sorgente_estranea", async () => {
    await inRollback(db, "B", async (tx) => {
      const a = await api();
      expect(await a.prepareMessage(tx, PRACTICE_B, clock, promemoria)).toBeNull();
      expect(await a.prepareMessage(tx, PRACTICE_A, clock, promemoria)).toBeNull();
      await expect(a.recordMessage(tx, PRACTICE_B, clock, { id: randomUUID(), source: promemoria, body: "Ciao", action: "copiato" })).rejects.toThrow(NOT_ALLOWED);
      expect(await a.prepareMessage(tx, PRACTICE_B, clock, { kind: "visit", visitId: VISIT_A, adviceIds: [ADVICE_A], templateKey: "consigli" })).toBeNull();
      // Un id del registro di A con una sorgente valida di B: rifiuto generico, nessun 23505.
      const own: MessageSource = { kind: "appointment", appointmentId: APPOINTMENT_B, templateKey: "promemoria" };
      expect(await a.prepareMessage(tx, PRACTICE_B, clock, own)).toMatchObject({ patientId: PATIENT_B1, copyAllowed: true });
      const error = await a.recordMessage(tx, PRACTICE_B, clock, { id: MESSAGE_LOG_A, source: own, body: "Ciao", action: "copiato" }).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: "DomainError", message: NOT_ALLOWED });
      expect((error as { code?: string }).code).toBeUndefined();
      // La transazione resta usabile: il savepoint ha assorbito l'errore.
      expect(await a.recordMessage(tx, PRACTICE_B, clock, { id: randomUUID(), source: own, body: "Ciao", action: "copiato" })).toBeTruthy();
      return true;
    });
    const [rowA] = await asServiceFor(db, (tx) =>
      tx.query<{ practice_id: string; body: string }>("select practice_id, body from public.message_log where id = $1", [MESSAGE_LOG_A]),
    );
    expect(rowA).toEqual({ practice_id: PRACTICE_A, body: "Buongiorno Giulia, le confermo la seduta di lunedì alle 9." });
    await inUserA(db, async (tx) => {
      const a = await api();
      expect(await a.prepareMessage(tx, PRACTICE_A, clock, recall(PATIENT_B1))).toBeNull();
      // Un consiglio di un'altra visita dello stesso studio non entra nel messaggio di VISIT_A.
      const appointment = randomUUID();
      await tx.query(
        `insert into public.appointments (id, practice_id, patient_id, service_id, cycle_id, starts_at, duration_min, price_cents)
         values ($1, $2, $3, $4, $5, '2026-10-12T07:00:00Z', 45, 6000)`,
        [appointment, PRACTICE_A, PATIENT_A1, SERVICE_A, CYCLE_A],
      );
      const [visit] = await tx.query<{ id: string }>(
        `insert into public.visits (practice_id, patient_id, cycle_id, appointment_id, visit_date, kind, screening_catalog_version)
         values ($1, $2, $3, $4, '2026-10-12', 'seduta', 1) returning id`,
        [PRACTICE_A, PATIENT_A1, CYCLE_A, appointment],
      );
      const [other] = await tx.query<{ id: string }>(
        "insert into public.visit_advice (practice_id, visit_id, text) values ($1, $2, 'Altro consiglio') returning id",
        [PRACTICE_A, visit!.id],
      );
      const mixed: MessageSource = { kind: "visit", visitId: VISIT_A, adviceIds: [ADVICE_A, other!.id], templateKey: "consigli" };
      expect(await a.prepareMessage(tx, PRACTICE_A, clock, mixed)).toBeNull();
      const before = await count(tx);
      await expect(record(tx, { source: mixed })).rejects.toThrow(NOT_ALLOWED);
      expect(await count(tx)).toBe(before);
    });
  });

  it("history_limit", async () => inUserA(db, async (tx) => {
    const a = await api();
    // A2 non ha righe di fixture: i richiami con lo stesso istante e UUID decrescenti.
    await informativa(tx, PATIENT_A2);
    await choice(tx, PATIENT_A2, "richiami", true);
    const ids = ["a0000000-0000-4000-8000-0000000009f4", "a0000000-0000-4000-8000-0000000009f3", "a0000000-0000-4000-8000-0000000009f2", "a0000000-0000-4000-8000-0000000009f1"];
    for (const id of ids) await a.recordMessage(tx, PRACTICE_A, clock, { id, source: recall(PATIENT_A2), body: `Richiamo ${id.slice(-1)}`, action: "copiato" });
    const last = await a.listPatientMessages(tx, PRACTICE_A, PATIENT_A2, 3);
    expect(last.map((r) => r.id)).toEqual([ids[3], ids[2], ids[1]]);
    expect(last[0]).toEqual({
      id: ids[3], patientId: PATIENT_A2, appointmentId: null, visitId: null, templateKey: "richiamo",
      recipientName: "Luca Romano", recipientPhone: null, body: "Richiamo 1", action: "copiato",
      outcome: "da_confermare", createdAt: clock.now(), outcomeAt: null,
    });
    expect((await a.listPatientMessages(tx, PRACTICE_A, PATIENT_A2)).map((r) => r.id)).toEqual([...ids].reverse());
    // Il dettaglio dell'appuntamento: solo le sue righe, nello stesso ordine.
    const first = await record(tx, { body: "Uno" });
    const second = await record(tx, { body: "Due" });
    const detail = await a.listAppointmentMessages(tx, PRACTICE_A, APPOINTMENT_A);
    expect(detail.every((r) => r.appointmentId === APPOINTMENT_A)).toBe(true);
    expect(detail.map((r) => r.id)).toEqual(expect.arrayContaining([first.id, second.id, MESSAGE_LOG_A]));
    expect(detail).toHaveLength(3);
    const mine = detail.map((r) => r.id).filter((id) => id === first.id || id === second.id);
    expect(mine).toEqual([second.id, first.id]);
  }).then(async () => {
    const a = await api();
    expect(await inRollback(db, "B", (tx) => a.listPatientMessages(tx, PRACTICE_A, PATIENT_A1))).toEqual([]);
    expect(await inRollback(db, "B", (tx) => a.listAppointmentMessages(tx, PRACTICE_A, APPOINTMENT_A))).toEqual([]);
  }));

  it("mancanti_messaggi", async () => inUserA(db, async (tx) => {
    const a = await api();
    await studioCompleto(tx);
    await tx.query(
      "insert into public.message_templates (practice_id, key, variant, body) values ($1, 'promemoria', 'lei', $2)",
      [PRACTICE_A, "Buongiorno {nome}, le ricordo l'appuntamento{per_paziente} di {quando} alle {ora}, in {indirizzo}. Per disdire chiami il {telefono_studio}. {osteopata}, {studio}"],
    );
    expect((await a.prepareMessage(tx, PRACTICE_A, clock, promemoria))?.missing).toEqual([]);
    expect((await a.prepareMessage(tx, PRACTICE_A, clock, promemoria))?.body).toBe(
      "Buongiorno Giulia, le ricordo l'appuntamento di lunedì 5 ottobre alle 09:00, in Via delle Prove 7, Bologna. Per disdire chiami il +39 051 000 0000. Anna Rossi, Studio A",
    );
    await tx.query("update public.practice_settings set city = null where practice_id = $1", [PRACTICE_A]);
    expect((await a.prepareMessage(tx, PRACTICE_A, clock, promemoria))?.missing).toEqual([{ key: "indirizzo", message: "Manca l'indirizzo dello studio", href: "/impostazioni/studio" }]);
    await studioCompleto(tx);
    await tx.query("update public.practice_settings set phone = null where practice_id = $1", [PRACTICE_A]);
    expect((await a.prepareMessage(tx, PRACTICE_A, clock, promemoria))?.missing).toEqual([{ key: "telefono_studio", message: "Manca il telefono dello studio", href: "/impostazioni/studio" }]);
    // Il minore senza contatto: nessun nome di destinatario, e nessun ripiego sul bambino.
    await tx.query("update public.patient_guardians set is_contact = false where id = $1", [GUARDIAN_A]);
    expect((await a.prepareMessage(tx, PRACTICE_A, clock, recall(PATIENT_A3)))?.missing).toEqual([
      { key: "nome", message: "Manca il nome del destinatario", href: `/pazienti/${PATIENT_A3}?tab=anagrafica` },
      { key: "settimane", message: "Manca la data dell'ultima seduta", href: `/pazienti/${PATIENT_A3}?tab=appuntamenti` },
    ]);
    // Limite finale di 700 code points, anche dopo la compilazione, e testo vuoto.
    await studioCompleto(tx);
    await tx.query("update public.message_templates set body = $2 where practice_id = $1 and key = 'promemoria' and variant = 'lei'", [PRACTICE_A, `${"a".repeat(689)}{indirizzo}`]);
    expect(await a.prepareMessage(tx, PRACTICE_A, clock, promemoria)).toMatchObject({ copyAllowed: false, copyDisabledReason: TOO_LONG, copyDisabledCode: "troppo_lungo", whatsappHref: null });
    expect((await record(tx, { body: "\u{1D11E}".repeat(700) })).id).toBeTruthy();
    await expect(record(tx, { body: "\u{1D11E}".repeat(701) })).rejects.toThrow(TOO_LONG);
    for (const body of ["", "   "]) await expect(record(tx, { body })).rejects.toThrow("Scrivi il testo del messaggio.");
  }));
});
