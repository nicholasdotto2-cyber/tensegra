import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EditAppointmentInput, NewAppointmentInput, PreviewInput } from "@/server/domain/appointments/schemas";

// Il giorno di un appuntamento ha gli stessi limiti del dialogo e dell'agenda (2000-01-01..2099-12-31,
// `AGENDA_FIRST_DAY` e `AGENDA_LAST_DAY`): fuori, il testo del campo data, prima del comando.

const DAY = "Scrivi la data nel formato 22/10/2026.";
const ID = "a0000000-0000-4000-8000-000000000001";

const newInput = (day: string) => ({
  patient: { kind: "existing", patientId: ID },
  serviceId: ID,
  day,
  time: "10:00",
  durationMin: 45,
  cycle: { kind: "existing", cycleId: ID },
  priceCents: 5500,
  status: "prenotato",
});

const editInput = (day: string) => ({
  id: ID,
  expectedUpdatedAt: "2026-11-04T07:30:00.000Z",
  serviceId: ID,
  day,
  time: "10:00",
  durationMin: 45,
  priceCents: 5500,
  status: "prenotato",
});

const previewInput = (day: string) => ({ day, time: "10:00", durationMin: 45 });

const schemas: [name: string, schema: z.ZodType, input: (day: string) => unknown][] = [
  ["NewAppointmentInput", NewAppointmentInput, newInput],
  ["PreviewInput", PreviewInput, previewInput],
  ["EditAppointmentInput", EditAppointmentInput, editInput],
];

describe.each(schemas)("%s: limiti del giorno", (_name, schema, input) => {
  it.each(["1999-12-31", "2100-01-01", "1026-11-04", "2150-11-04"])("%s è rifiutato sul campo data", (day) => {
    const parsed = schema.safeParse(input(day));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(z.flattenError(parsed.error).fieldErrors).toEqual({ day: [DAY] });
  });

  it.each(["2000-01-01", "2099-12-31"])("%s passa", (day) => {
    expect(schema.safeParse(input(day)).success).toBe(true);
  });
});

describe("le date escluse della serie hanno gli stessi limiti", () => {
  it("una data esclusa del 2100 è rifiutata", () => {
    const parsed = NewAppointmentInput.safeParse({
      ...newInput("2026-11-09"),
      repeat: { intervalWeeks: 1, count: 2, excludedDays: ["2100-01-01"] },
    });
    expect(parsed.success).toBe(false);
  });
});
