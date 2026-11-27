import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES, type TemplateKey } from "@/lib/messages/templates";
import { whatsappHref } from "@/lib/messages/links";
import { renderMessage } from "@/lib/messages/render";
import { fixedClock, romeDateTime } from "@/server/clock";
import type { Db } from "@/server/db/db";
import { getMessageRecipient } from "@/server/domain/messages/recipient";
import { buildMessageValues, getMessageTemplate } from "@/server/domain/messages/queries";
import { getPracticeSettings } from "@/server/domain/settings/queries";
import { CONSENT_A, GUARDIAN_A, PATIENT_A1, PATIENT_A3, PATIENT_B1, PRACTICE_A, PRACTICE_B } from "./fixtures";
import { asUserB, inUserA, openTestDb } from "./helpers";

const clock = fixedClock("2026-10-22T08:30:00+02:00");
let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });
const keys: TemplateKey[] = ["conferma", "promemoria", "spostamento", "richiamo", "consigli"];

describe("destinatario messaggi", () => {
  it("adulto_consensi_del_paziente", async () => {
    await inUserA(db, async (tx) => {
      await tx.query("update public.patients set phone = '+393330000077', preferred_channel = 'whatsapp' where id = $1", [PATIENT_A1]);
      expect(await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_A1)).toMatchObject({ kind: "paziente", name: "Giulia Ferrari", firstName: "Giulia", patientFirstName: "Giulia", addressing: "lei", preferredChannel: "whatsapp", whatsappConsent: true, recallConsent: false, whatsappDisabledReason: null });
      await tx.query("insert into public.consent_choices (practice_id, patient_id, choice, value, decided_on, mode) values ($1, $2, 'richiami', true, '2026-10-22', 'verbale')", [PRACTICE_A, PATIENT_A1]);
      expect((await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_A1))?.recallConsent).toBe(true);
    });
  });

  it.each(keys)("canale_negato_prima_della_demo_per_%s", async (key) => {
    await inUserA(db, async (tx) => {
      await tx.query("update public.practice_settings set is_demo = true, demo_test_phone = '+393330000099' where practice_id = $1", [PRACTICE_A]);
      const practice = (await getPracticeSettings(tx, PRACTICE_A))!;
      const context = { appointment: { startsAt: romeDateTime("2026-10-23", "09:30"), durationMin: 45 }, lastDoneOn: "2026-08-10", advice: "Camminare ogni giorno." };
      // Il diniego vale per ogni modello e precede il numero per le prove; "Copia" resta, con lo stesso testo.
      const denied = async (reason: string, phoneBlocks: boolean) => {
        const recipient = (await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_A1))!;
        expect(recipient.whatsappDisabledReason).toBe(reason);
        const { text } = renderMessage(key, DEFAULT_TEMPLATES[key][recipient.addressing], buildMessageValues(clock, practice, recipient, context));
        expect(text).toMatch(/^Buongiorno Giulia, /);
        if (phoneBlocks) expect(() => whatsappHref(recipient, text)).toThrow(reason);
      };
      for (const [phone, channel, reason] of [
        [null, "whatsapp", "Numero mancante"],
        ["+390510000000", "whatsapp", "Numero fisso: WhatsApp non disponibile"],
      ] as const) {
        await tx.query("update public.patients set phone = $2, preferred_channel = $3 where id = $1", [PATIENT_A1, phone, channel]);
        await denied(reason, true);
      }
      for (const [channel, reason] of [["telefono", "Preferisce una telefonata"], ["nessuno", "Nessun promemoria"]] as const) {
        await tx.query("update public.patients set phone = '+393330000077', preferred_channel = $2 where id = $1", [PATIENT_A1, channel]);
        await denied(reason, false);
      }
      await tx.query("update public.patients set phone = '+442079460000', preferred_channel = 'whatsapp' where id = $1", [PATIENT_A1]);
      expect((await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_A1))?.whatsappDisabledReason).toBeNull();
      await tx.query("insert into public.consent_choices (practice_id, patient_id, choice, value, decided_on, mode) values ($1, $2, 'whatsapp', false, '2026-10-22', 'verbale')", [PRACTICE_A, PATIENT_A1]);
      await denied("Manca il consenso WhatsApp", false);
    });
  });

  it("informativa_revocata_disattiva_il_canale", async () => {
    await inUserA(db, async (tx) => {
      await tx.query("update public.patients set phone = '+393330000077', preferred_channel = 'whatsapp' where id = $1", [PATIENT_A1]);
      await tx.query("update public.consent_records set status = 'revocato', revoked_on = '2026-10-22', revocation_mode = 'verbale', revocation_note = 'Prova' where id = $1", [CONSENT_A]);
      expect((await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_A1))?.whatsappDisabledReason).toBe("Manca il consenso WhatsApp");
    });
  });

  it("minore_contatto_tono_del_paziente_e_nessun_ripiego_sul_bambino", async () => {
    await inUserA(db, async (tx) => {
      await tx.query("update public.patients set phone = '+393330000077', addressing = 'lei' where id = $1", [PATIENT_A3]);
      await tx.query("update public.patient_guardians set first_name = 'Elena', phone = '+393330000099' where id = $1", [GUARDIAN_A]);
      expect(await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_A3)).toMatchObject({ kind: "genitore", firstName: "Elena", patientFirstName: "Sofia", phone: "+393330000099", addressing: "lei", whatsappConsent: false });
      await tx.query("update public.patient_guardians set relationship = 'tutore' where id = $1", [GUARDIAN_A]);
      expect((await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_A3))?.kind).toBe("tutore");
      await tx.query("update public.patient_guardians set is_contact = false where id = $1", [GUARDIAN_A]);
      expect(await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_A3)).toMatchObject({ phone: null, firstName: "", name: "", whatsappDisabledReason: "Numero mancante" });
    });
  });

  it("esempio_chiara_e_minore", async () => {
    await inUserA(db, async (tx) => {
      await tx.query("update public.practices set name = 'Studio Osteopatico Borgo Tiglio' where id = $1", [PRACTICE_A]);
      await tx.query("update public.practice_settings set practitioner_first_name = 'Laura', practitioner_last_name = 'Benedetti', address_line = 'Via delle Prove 7', city = 'Bologna', phone = '+390510000000' where practice_id = $1", [PRACTICE_A]);
      await tx.query("update public.patients set first_name = 'Chiara', addressing = 'tu' where id = $1", [PATIENT_A1]);
      const practice = (await getPracticeSettings(tx, PRACTICE_A))!;
      const recipient = (await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_A1))!;
      const context = { appointment: { startsAt: romeDateTime("2026-10-23", "09:30"), durationMin: 45 }, lastDoneOn: "2026-08-10" };
      const values = buildMessageValues(clock, practice, recipient, context);
      expect(values.quando).toBe("domani, venerdì 23 ottobre,");
      expect(values.settimane).toBe("10");
      expect(values.durata).toBe("45 minuti");
      expect(values.telefono_studio).toBe("+39 051 000 0000");
      expect(renderMessage("promemoria", DEFAULT_TEMPLATES.promemoria.tu, values)).toEqual({ text: "Ciao Chiara, ti ricordo l'appuntamento di domani, venerdì 23 ottobre, alle 09:30, in Via delle Prove 7, Bologna. Se non riesci a venire, avvisami qui: così posso dare l'orario a qualcun altro. A presto. Laura Benedetti, Studio Osteopatico Borgo Tiglio", missing: [] });
      await tx.query("update public.patient_guardians set first_name = 'Elena' where id = $1", [GUARDIAN_A]);
      const minor = (await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_A3))!;
      const text = renderMessage("promemoria", DEFAULT_TEMPLATES.promemoria.tu, buildMessageValues(clock, practice, minor, context)).text;
      expect(text).toContain("Ciao Elena, ti ricordo l'appuntamento per Sofia di domani, venerdì 23 ottobre,");
      expect(buildMessageValues(clock, practice, minor, context).di_paziente).toBe(" di Sofia");
    });
  });

  it("esempio_non_domani_giorni_calendario_e_contesto_mancante", async () => {
    await inUserA(db, async (tx) => {
      const practice = (await getPracticeSettings(tx, PRACTICE_A))!;
      const recipient = (await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_A1))!;
      const values = buildMessageValues(clock, practice, recipient, { appointment: { startsAt: romeDateTime("2026-11-05", "09:30"), durationMin: 45 } });
      expect(renderMessage("promemoria", DEFAULT_TEMPLATES.promemoria.tu, values).text).toContain("ti ricordo l'appuntamento di giovedì 5 novembre alle 09:30");
      expect(values.indirizzo).toBeNull();
      expect(renderMessage("promemoria", DEFAULT_TEMPLATES.promemoria.tu, values).missing).toContain("indirizzo");
      expect(renderMessage("promemoria", DEFAULT_TEMPLATES.promemoria.tu, values).text).not.toMatch(/[{}]/);
      const saturday = fixedClock("2026-10-24T08:30:00+02:00");
      expect(buildMessageValues(saturday, practice, recipient, { appointment: { startsAt: romeDateTime("2026-10-26", "09:30"), durationMin: 45 } }).quando).toBe("lunedì 26 ottobre");
      const beforeDST = fixedClock("2026-10-24T08:30:00+02:00");
      expect(buildMessageValues(beforeDST, practice, recipient, { appointment: { startsAt: romeDateTime("2026-10-25", "09:30"), durationMin: 45 } }).quando).toBe("domani, domenica 25 ottobre,");
      expect(buildMessageValues(fixedClock("2026-10-26T08:30:00+01:00"), practice, recipient, { lastDoneOn: "2026-10-19" }).settimane).toBe("1");
      expect(buildMessageValues(clock, practice, recipient, {})).toMatchObject({ quando: null, ora: null, settimane: null, consigli: null, per_paziente: "", di_paziente: "" });
    });
  });

  it("modello_salvato_e_default_sotto_rls", async () => {
    await inUserA(db, async (tx) => {
      expect(await getMessageTemplate(tx, PRACTICE_A, "conferma", "lei")).toBe("Buongiorno {nome}, le confermo la seduta di {giorno} alle {ora}.");
      expect(await getMessageTemplate(tx, PRACTICE_A, "promemoria", "tu")).toBe(DEFAULT_TEMPLATES.promemoria.tu);
      expect(await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_B1)).toBeNull();
      expect(await getMessageRecipient(tx, PRACTICE_B, clock, PATIENT_B1)).toBeNull();
    });
    await asUserB(db, async (tx) => {
      expect(await getMessageRecipient(tx, PRACTICE_A, clock, PATIENT_A1)).toBeNull();
      expect(await getMessageTemplate(tx, PRACTICE_A, "promemoria", "tu")).toBeNull();
    });
  });
});
