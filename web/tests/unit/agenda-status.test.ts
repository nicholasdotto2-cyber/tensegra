import { describe, expect, it } from "vitest";
import { sessionLabel, sessionPosition, type CycleAppointment } from "@/lib/agenda/session-label";
import {
  ACTION_LABEL,
  allowedActions,
  canOpenVisit,
  doneQuestion,
  isActive,
  needsDoneConfirmation,
  SIGNAL_LABEL,
  STATUS_LABEL,
  type ActionContext,
} from "@/lib/agenda/status";

// Adesso = mercoledì 4/11/2026 alle 08:30 di Roma (ora solare, UTC+1).
const NOW = new Date("2026-11-04T07:30:00Z");
const TODAY = "2026-11-04";

function ctx(overrides: Partial<ActionContext>): ActionContext {
  return {
    status: "prenotato",
    startsAt: new Date("2026-11-04T16:00:00Z"), // 17:00 di Roma
    day: TODAY,
    today: TODAY,
    now: NOW,
    hasVisit: false,
    hasAnyInvoiceLine: false,
    hasMessage: false,
    ...overrides,
  };
}

const TODAY_17 = ctx({});
const CONFIRMED_STARTED_08 = ctx({ status: "confermato", startsAt: new Date("2026-11-04T07:00:00Z") });
const BOOKED_TOMORROW = ctx({ startsAt: new Date("2026-11-05T08:00:00Z"), day: "2026-11-05" });

describe("allowedActions", () => {
  it("un prenotato più tardi oggi si segna fatto con la domanda, ma non è ancora saltato", () => {
    expect(allowedActions(TODAY_17)).toEqual([
      "segna_confermato",
      "segna_fatta",
      "annulla",
      "elimina",
      "modifica",
    ]);
    expect(needsDoneConfirmation(TODAY_17)).toBe(true);
    expect(doneQuestion("17:00")).toBe("Inizia alle 17:00. Segnarlo comunque come fatto?");
  });

  it("un confermato già iniziato si segna fatto o saltato, senza domanda", () => {
    const actions = allowedActions(CONFIRMED_STARTED_08);
    for (const action of ["segna_fatta", "saltato", "annulla", "elimina", "modifica"] as const) {
      expect(actions).toContain(action);
    }
    expect(actions).not.toContain("segna_confermato");
    expect(needsDoneConfirmation(CONFIRMED_STARTED_08)).toBe(false);
  });

  it("un confermato già iniziato con una visita non si segna saltato: la seduta c'è stata", () => {
    const actions = allowedActions({ ...CONFIRMED_STARTED_08, hasVisit: true });
    expect(actions).not.toContain("saltato");
    expect(actions).toContain("segna_fatta");
  });

  it("un giorno futuro non si segna né fatto né saltato", () => {
    const actions = allowedActions(BOOKED_TOMORROW);
    expect(actions).not.toContain("segna_fatta");
    expect(actions).not.toContain("saltato");
    expect(needsDoneConfirmation(BOOKED_TOMORROW)).toBe(false);
  });

  it("un messaggio, una riga di fattura o una visita tolgono Elimina; la visita anche Annulla", () => {
    const withMessage = allowedActions(ctx({ hasMessage: true }));
    expect(withMessage).not.toContain("elimina");
    expect(withMessage).toContain("annulla");

    const withInvoiceLine = allowedActions(ctx({ hasAnyInvoiceLine: true }));
    expect(withInvoiceLine).not.toContain("elimina");
    expect(withInvoiceLine).toContain("annulla");

    const withVisit = allowedActions(ctx({ hasVisit: true }));
    expect(withVisit).not.toContain("elimina");
    expect(withVisit).not.toContain("annulla");
  });

  it("fatto, saltato e annullato hanno le loro uscite", () => {
    expect(allowedActions(ctx({ status: "fatto", startsAt: new Date("2026-11-04T07:00:00Z") }))).toEqual([
      "annulla_fatto",
    ]);
    expect(
      allowedActions(ctx({ status: "saltato", startsAt: new Date("2026-11-09T08:00:00Z"), day: "2026-11-09" })),
    ).toEqual(["ripristina"]);
    expect(
      allowedActions(
        ctx({ status: "annullato", startsAt: new Date("2026-11-03T08:00:00Z"), day: "2026-11-03" }),
      ),
    ).toEqual([]);
  });

  it("un saltato dato per errore si annulla dopo l'inizio, anche nei giorni passati", () => {
    // Oggi alle 08:00, già iniziato alle 08:30: torna confermato con "Annulla 'saltato'".
    expect(allowedActions(ctx({ status: "saltato", startsAt: new Date("2026-11-04T07:00:00Z") }))).toEqual([
      "annulla_saltato",
    ]);
    expect(
      allowedActions(ctx({ status: "saltato", startsAt: new Date("2026-11-03T17:00:00Z"), day: "2026-11-03" })),
    ).toEqual(["annulla_saltato"]);
    // All'inizio esatto vale già "iniziato", come per "Saltato".
    expect(allowedActions(ctx({ status: "saltato", startsAt: NOW }))).toEqual(["annulla_saltato"]);
    // Un annullato passato non ha uscite: "Annulla 'saltato'" è solo del saltato.
    expect(
      allowedActions(
        ctx({ status: "annullato", startsAt: new Date("2026-11-03T08:00:00Z"), day: "2026-11-03" }),
      ),
    ).toEqual([]);
  });
});

describe("etichette", () => {
  it("stati, azioni e segnali con i loro testi", () => {
    expect(STATUS_LABEL).toEqual({
      prenotato: "Prenotato",
      confermato: "Confermato",
      fatto: "Fatto",
      saltato: "Saltato",
      annullato: "Annullato",
    });
    expect(Object.entries(ACTION_LABEL)).toEqual([
      ["segna_confermato", "Segna confermato"],
      ["segna_fatta", "Segna come fatta"],
      ["saltato", "Saltato"],
      ["annulla", "Annulla appuntamento"],
      ["annulla_fatto", "Annulla 'fatto'"],
      ["ripristina", "Ripristina"],
      ["annulla_saltato", "Annulla 'saltato'"],
      ["elimina", "Elimina"],
      ["modifica", "Modifica"],
    ]);
    expect(SIGNAL_LABEL).toEqual({
      consenso_mancante: "Consenso mancante",
      anagrafica_da_completare: "Anagrafica da completare",
      visita_da_compilare: "Visita da compilare",
      da_chiudere: "Da chiudere",
      avviso_clinico: "Avviso clinico",
    });
  });

  it("attivi sono prenotato, confermato e fatto", () => {
    expect(isActive("prenotato")).toBe(true);
    expect(isActive("confermato")).toBe(true);
    expect(isActive("fatto")).toBe(true);
    expect(isActive("saltato")).toBe(false);
    expect(isActive("annullato")).toBe(false);
  });
});

describe("etichetta di seduta", () => {
  // Ciclo da 4: prima visita fatta il 15/10, seduta saltata il 20/10, seduta prenotata il 22/10.
  // In ordine sparso: la posizione segue l'orario, non l'ordine della lista.
  const cycle: CycleAppointment[] = [
    { id: "s22", startsAt: new Date("2026-10-22T07:00:00Z"), status: "prenotato" },
    { id: "pv15", startsAt: new Date("2026-10-15T07:00:00Z"), status: "fatto" },
    { id: "s20", startsAt: new Date("2026-10-20T07:00:00Z"), status: "saltato" },
  ];

  it("conta solo i non annullati e non saltati, in ordine di orario", () => {
    expect(sessionPosition("pv15", cycle)).toBe(1);
    expect(sessionPosition("s22", cycle)).toBe(2);
    expect(sessionLabel(2, 4)).toBe("Seduta 2 di 4");
    expect(sessionLabel(2, null)).toBe("Seduta 2");
  });

  it("un saltato o un appuntamento fuori dal ciclo non hanno posizione", () => {
    expect(sessionPosition("s20", cycle)).toBeNull();
    expect(sessionPosition("altro", cycle)).toBeNull();
    expect(sessionLabel(null, 4)).toBeNull();
  });
});

describe("canOpenVisit", () => {
  it("prenotato, confermato e fatto fino a oggi; mai saltato, annullato o un giorno dopo oggi", () => {
    expect(canOpenVisit("prenotato", TODAY, TODAY)).toBe(true);
    expect(canOpenVisit("confermato", TODAY, TODAY)).toBe(true);
    expect(canOpenVisit("fatto", "2026-10-20", TODAY)).toBe(true);
    expect(canOpenVisit("saltato", TODAY, TODAY)).toBe(false);
    expect(canOpenVisit("annullato", TODAY, TODAY)).toBe(false);
    expect(canOpenVisit("confermato", "2026-11-05", TODAY)).toBe(false);
  });
});
