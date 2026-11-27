import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock, romeDateTime } from "@/server/clock";
import type { Db } from "@/server/db/db";
import { getAppointmentDetail } from "@/server/domain/appointments/queries";
import { recordMessage } from "@/server/domain/messages/commands";
import { getSummaryTab } from "@/server/domain/patients/card";
import { APPOINTMENT_A, CYCLE_A, PATIENT_A1, PRACTICE_A, SERVICE_A, VISIT_A } from "./fixtures";
import { inUserA, insertRow, openTestDb } from "./helpers";

const clock = fixedClock("2026-11-04T08:30:00+01:00");
let db: Db;
let pg: PGlite;
beforeAll(async () => { ({ db, pg } = await openTestDb()); });
afterAll(async () => { await pg?.close(); });

describe("superfici dei messaggi", () => {
  it("ultimi_tre_fissi", async () => inUserA(db, async (tx) => {
    for (const hour of [10, 11, 12, 13]) {
      await recordMessage(tx, PRACTICE_A, fixedClock(`2026-11-04T${hour}:00:00+01:00`), {
        id: randomUUID(), source: { kind: "appointment", appointmentId: APPOINTMENT_A, templateKey: "promemoria" },
        body: `Testo congelato delle ${hour}`, action: "copiato",
      });
    }
    const before = await getSummaryTab(tx, PRACTICE_A, clock, PATIENT_A1);
    expect(before?.messages?.map((row) => row.body)).toEqual([
      "Testo congelato delle 13", "Testo congelato delle 12", "Testo congelato delle 11",
    ]);
    await tx.query("update public.patients set first_name = 'Nome cambiato', phone = '+393330000099' where id = $1", [PATIENT_A1]);
    await tx.query("update public.message_templates set body = 'Nuovo modello {nome}' where practice_id = $1", [PRACTICE_A]);
    expect((await getSummaryTab(tx, PRACTICE_A, clock, PATIENT_A1))?.messages).toEqual(before?.messages);
  }));

  it("dettaglio_filtra", async () => inUserA(db, async (tx) => {
    const other = await insertRow(tx, "appointments", {
      practice_id: PRACTICE_A, patient_id: PATIENT_A1, cycle_id: CYCLE_A, service_id: SERVICE_A,
      starts_at: romeDateTime("2026-11-06", "11:00"), duration_min: 45, price_cents: 6000, status: "prenotato",
    });
    const ownId = randomUUID();
    await recordMessage(tx, PRACTICE_A, clock, {
      id: ownId, source: { kind: "appointment", appointmentId: APPOINTMENT_A, templateKey: "promemoria" },
      body: "Solo questo appuntamento", action: "copiato",
    });
    await recordMessage(tx, PRACTICE_A, clock, {
      id: randomUUID(), source: { kind: "appointment", appointmentId: String(other.id), templateKey: "promemoria" },
      body: "Altro appuntamento", action: "copiato",
    });
    await insertRow(tx, "message_log", {
      practice_id: PRACTICE_A, patient_id: PATIENT_A1, visit_id: VISIT_A, template_key: "consigli",
      recipient_kind: "paziente", recipient_name: "Giulia Ferrari", body: "Consigli senza appuntamento nel log",
      action: "copiato", created_at: clock.now(),
    });
    const detail = await getAppointmentDetail(tx, PRACTICE_A, clock, APPOINTMENT_A);
    expect(detail?.messages?.map((row) => row.body)).toEqual([
      "Solo questo appuntamento", "Buongiorno Giulia, le confermo la seduta di lunedì alle 9.",
    ]);
    expect(detail?.messages[0]?.id).toBe(ownId);
    expect((await getAppointmentDetail(tx, PRACTICE_A, clock, String(other.id)))?.messages.map((row) => row.body))
      .toEqual(["Altro appuntamento"]);
  }));
});
