import { describe, expect, it } from "vitest";
import { RecallInput } from "@/server/domain/patients/schemas";
import {
  recallDay,
  recallDueText,
  recallRevokedText,
  recallVisible,
  recallWait,
  snoozeDay,
} from "@/server/domain/patients/recall";

// Data e scadenza del richiamo: ultimo appuntamento fatto
// più la cadenza in settimane, in giorni di calendario; il testo conta i giorni da oggi.
// Il rinvio nasconde la riga fino al suo giorno senza toccare la data clinica; l'attesa dei 14
// giorni parte dal giorno di Roma del richiamo inviato; la revoca si dice con chi l'ha data.

describe("recallDay", () => {
  it("data_clinica: 17/08/2026 + 8 settimane = 12/10/2026", () => {
    expect(recallDay("2026-08-17", 8)).toBe("2026-10-12");
  });

  it.each<[number, string]>([
    [6, "2026-12-03"],
    [4, "2026-11-19"],
    [8, "2026-12-17"],
    [12, "2027-01-14"],
  ])("dal 22/10/2026 con %i settimane: %s", (weeks, day) => {
    expect(recallDay("2026-10-22", weeks)).toBe(day);
  });

  it("attraversa il cambio d'ora del 25/10 a giorni interi", () => {
    expect(recallDay("2026-10-20", 2)).toBe("2026-11-03");
  });
});

describe("recallDueText", () => {
  it.each<[string, string]>([
    ["2026-10-12", "Scaduto da 10 giorni"],
    ["2026-10-20", "Scaduto da 2 giorni"],
    ["2026-10-21", "Scaduto ieri"],
    ["2026-10-22", "Scade oggi"],
    ["2026-10-23", "Scade domani"],
    ["2026-10-24", "Fra 2 giorni"],
    ["2026-10-25", "Fra 3 giorni"],
  ])("scadenza %s con oggi 22/10: %s", (dueDay, text) => {
    expect(recallDueText(dueDay, "2026-10-22")).toBe(text);
  });
});

describe("rinvia: «Rimanda di 2 settimane»", () => {
  it("dal 22/10 il rinvio è fino al 5/11, anche attraverso il cambio d'ora", () => {
    expect(snoozeDay("2026-10-22")).toBe("2026-11-05");
  });

  it("la riga manca fino al 4/11 compreso e torna il 5/11; senza rinvio c'è sempre", () => {
    expect(recallVisible("2026-11-05", "2026-10-22")).toBe(false);
    expect(recallVisible("2026-11-05", "2026-11-04")).toBe(false);
    expect(recallVisible("2026-11-05", "2026-11-05")).toBe(true);
    expect(recallVisible("2026-11-05", "2026-11-20")).toBe(true);
    expect(recallVisible(null, "2026-10-22")).toBe(true);
  });

  it("alla fine del rinvio la scadenza resta quella clinica, con il ritardo vero", () => {
    expect(recallDueText(recallDay("2026-08-17", 8), "2026-11-05")).toBe("Scaduto da 24 giorni");
  });
});

describe("attesa14: 14 giorni «In attesa di risposta» dal richiamo inviato", () => {
  it("inviato il 22/10: in attesa fino al 4/11 compreso, il 5/11 «Richiamato il 22/10, nessuna risposta»", () => {
    expect(recallWait("2026-10-22", "2026-10-22")).toEqual({ waitingUntil: "2026-11-04", waitingText: "In attesa di risposta" });
    expect(recallWait("2026-10-22", "2026-11-04")).toEqual({ waitingUntil: "2026-11-04", waitingText: "In attesa di risposta" });
    expect(recallWait("2026-10-22", "2026-11-05")).toEqual({
      waitingUntil: null,
      waitingText: "Richiamato il 22/10, nessuna risposta",
    });
  });

  it("attesa_cambio_ora: inviato il 20/10, in attesa fino al 2/11, il 3/11 richiamato", () => {
    expect(recallWait("2026-10-20", "2026-11-02")).toEqual({ waitingUntil: "2026-11-02", waitingText: "In attesa di risposta" });
    expect(recallWait("2026-10-20", "2026-11-03")).toEqual({
      waitingUntil: null,
      waitingText: "Richiamato il 20/10, nessuna risposta",
    });
  });

  it("senza un richiamo inviato non c'è attesa", () => {
    expect(recallWait(null, "2026-10-22")).toEqual({ waitingUntil: null, waitingText: null });
  });
});

describe("revoca_martina: la ragione del gruppo senza consenso", () => {
  it.each<["madre" | "padre" | "tutore" | "altro" | null, string]>([
    ["madre", "Consenso ai richiami revocato dalla madre il 15/09"],
    ["padre", "Consenso ai richiami revocato dal padre il 15/09"],
    ["tutore", "Consenso ai richiami revocato dal tutore il 15/09"],
    ["altro", "Consenso ai richiami revocato dal genitore il 15/09"],
    [null, "Consenso ai richiami revocato il 15/09"],
  ])("contatto %s: %s", (relationship, text) => {
    expect(recallRevokedText("2026-09-15", relationship)).toBe(text);
  });
});

describe("pausa: la cadenza resta da 2 a 52 settimane", () => {
  const PATIENT = "a0000000-0000-4000-8000-000000000202";
  it.each([2, 52])("%i settimane ammesse", (weeks) => {
    expect(RecallInput.safeParse({ patientId: PATIENT, weeks, paused: true }).success).toBe(true);
  });
  it.each([1, 53])("%i settimane rifiutate", (weeks) => {
    expect(RecallInput.safeParse({ patientId: PATIENT, weeks, paused: true }).success).toBe(false);
  });
});
