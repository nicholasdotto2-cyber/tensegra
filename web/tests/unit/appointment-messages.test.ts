import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppointmentDetailSheet } from "@/components/agenda/appointment-detail";
import { MessagesTabView } from "@/components/pazienti/messages-tab";
import type { AppointmentDetail } from "@/server/domain/appointments/queries";
import type { MessageLogRow } from "@/server/domain/messages/queries";

// Come invoice-editor-panel.test.ts: carica il pannello dagli hook e dalla risposta dell'azione.
// Poi renderizza il suo contenuto con React reale, inclusi ReminderRow e MessagesTabView.
const hooks = vi.hoisted(() => ({ active: false, cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!hooks.active) return react.useState(initial);
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = initial;
      return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = value; }];
    },
    useEffect: (effect: () => void, deps: unknown[]) => {
      if (!hooks.active) return react.useEffect(effect, deps);
      hooks.effects.push(effect);
    },
    useEffectEvent: (fn: () => void) => fn,
    useTransition: () => hooks.active ? [false, vi.fn()] : react.useTransition(),
  };
});
const actions = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock("@/app/(app)/agenda/actions", () => ({ appointmentDetailAction: actions.detail }));
vi.mock("@/app/(app)/pazienti/[id]/message-actions", () => ({ recordMessageAction: vi.fn(), setMessageOutcomeAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/agenda/appointment-dialog", () => ({ AppointmentDialog: () => null }));
vi.mock("@/components/agenda/cancel-dialog", () => ({ CancelDialog: () => null }));
vi.mock("@/components/agenda/delete-dialog", () => ({ DeleteDialog: () => null }));
vi.mock("@/components/cartella/open-visit", () => ({ OpenVisitButton: () => null }));
vi.mock("@/components/consensi/collect-dialog", () => ({ ConsentCollectDialog: () => null }));
vi.mock("@/components/messaggi/message-composer", () => ({ MessageComposer: () => null }));

const message: MessageLogRow = {
  id: "messaggio-attuale", patientId: "paziente", appointmentId: "appuntamento", visitId: null,
  templateKey: "promemoria", recipientName: "Ada Prova", recipientPhone: null, body: "Testo congelato",
  action: "copiato", outcome: "da_confermare", createdAt: new Date("2026-11-04T08:00:00Z"), outcomeAt: null,
};
const base: AppointmentDetail = {
  id: "appuntamento", patientId: "paziente", patientName: "Ada Prova",
  patient: { id: "paziente", firstName: "Ada", lastName: "Prova", birthDate: "1990-01-01", phone: null, archived: false },
  serviceId: "prestazione", serviceName: "Trattamento", dayText: "giovedì 5 novembre 2026", timeText: "09:00-09:45", durationText: "45 min",
  cycleId: "ciclo", cycleTitle: "Ciclo prova", sessionLabel: null, status: "prenotato", actions: [], doneQuestion: null,
  priceCents: 6000, notes: null, consentMissing: false, consentTarget: null, consentRevocationText: null, consentBlockText: null,
  stepsDone: null, visit: null, invoice: null, canOpenVisit: false, seriesFollowing: 0,
  edit: { day: "2026-11-05", time: "09:00", durationMin: 45, updatedAt: "2026-11-04T08:00:00Z" },
  messages: [], reminder: null,
};
const reminder: NonNullable<AppointmentDetail["reminder"]> = {
  appointmentId: base.id, startsAt: new Date("2026-11-05T08:00:00Z"), recipientText: "Ada Prova",
  lastMessage: message, statusText: "Copiato alle 09:00, inviato?",
  prepared: {
    source: { kind: "appointment", appointmentId: base.id, templateKey: "promemoria" }, patientId: base.patientId, templateKey: "promemoria",
    recipient: { kind: "paziente", name: "Ada Prova", firstName: "Ada", patientFirstName: "Ada", phone: null, addressing: "tu",
      preferredChannel: "whatsapp", whatsappConsent: true, recallConsent: false, whatsappDisabledReason: "Manca il numero",
      isDemo: true, demoTestPhone: null },
    body: message.body, missing: [], copyAllowed: true, copyDisabledReason: null, copyDisabledCode: null, whatsappHref: null,
  },
};

function findBody(tree: ReactNode): ReactElement | undefined {
  if (Array.isArray(tree)) return tree.map(findBody).find((node) => node !== undefined);
  if (!isValidElement<{ detail?: AppointmentDetail; children?: ReactNode }>(tree)) return undefined;
  return tree.props.detail === undefined ? findBody(tree.props.children) : tree;
}
async function renderDetail(detail: AppointmentDetail): Promise<string> {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = [];
  actions.detail.mockResolvedValue({ ok: true, data: detail });
  const render = () => {
    hooks.active = true; hooks.cursor = 0;
    try {
      return AppointmentDetailSheet({ appointmentId: detail.id, onClose: vi.fn(), services: [], defaultIntervalWeeks: 8, defaultExpectedSessions: 4 });
    } finally { hooks.active = false; }
  };
  render();
  for (const effect of hooks.effects.splice(0)) effect();
  await Promise.resolve();
  const body = findBody(render());
  if (!body) throw new Error("Dettaglio non caricato");
  return renderToStaticMarkup(body);
}
const yesCount = (html: string) => (html.match(/>Sì<\/button>/g) ?? []).length;
const noCount = (html: string) => (html.match(/>No<\/button>/g) ?? []).length;
function logRow(html: string, id: string): string {
  const row = html.match(new RegExp(`<li[^>]*data-message-id="${id}"[^>]*>[\\s\\S]*?</li>`))?.[0];
  if (!row) throw new Error(`Riga ${id} assente`);
  return row;
}

describe("cronologia nel dettaglio appuntamento", () => {
  it("vuoto_e_titolo_si_riferiscono_all_appuntamento", async () => {
    const html = await renderDetail(base);
    expect.soft(html).toContain("Nessun messaggio preparato per questo appuntamento.");
    expect.soft(html).not.toContain("per questo paziente");
    expect.soft(html).toMatch(/<h3[^>]*>Messaggi dell&#x27;appuntamento<\/h3>/);
  });

  it("un_solo_si_no_per_log_senza_perdere_stato_storico_o_rettifica", async () => {
    const older: MessageLogRow = { ...message, id: "promemoria-precedente", outcome: "non_inviato", outcomeAt: new Date("2026-11-04T08:05:00Z") };
    const confirmation: MessageLogRow = { ...message, id: "conferma", templateKey: "conferma" };
    const rows = [message, older, confirmation];
    const html = await renderDetail({ ...base, reminder, messages: rows });
    expect.soft(yesCount(html)).toBe(3);
    expect.soft(noCount(html)).toBe(3);
    expect.soft(yesCount(logRow(html, message.id))).toBe(0);
    expect.soft(noCount(logRow(html, message.id))).toBe(0);
    expect.soft(logRow(html, message.id)).toContain("Da confermare");
    expect.soft(logRow(html, message.id)).toContain("Testo congelato");
    for (const row of [older, confirmation]) expect.soft(yesCount(logRow(html, row.id))).toBe(1);
    expect.soft(logRow(html, older.id)).toContain("Non inviato");
    expect.soft(logRow(html, older.id)).toContain("09:05");

    // Dopo Sì/No ReminderRow non offre più la domanda: la cronologia permette ancora di correggere.
    for (const outcome of ["inviato", "non_inviato"] as const) {
      const answered = { ...message, outcome, outcomeAt: older.outcomeAt };
      const after = await renderDetail({ ...base, reminder: { ...reminder, lastMessage: answered }, messages: [answered] });
      expect.soft(yesCount(after)).toBe(1);
      expect.soft(noCount(after)).toBe(1);
    }
    const noReminder = await renderDetail({ ...base, messages: [message] });
    expect.soft(yesCount(noReminder)).toBe(1);
    const patientTab = renderToStaticMarkup(createElement(MessagesTabView, { rows }));
    expect.soft(yesCount(patientTab)).toBe(3);
    expect.soft(noCount(patientTab)).toBe(3);
  });
});
