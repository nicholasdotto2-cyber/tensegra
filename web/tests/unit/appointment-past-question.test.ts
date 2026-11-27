import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppointmentDialog, type AppointmentDialogProps } from "@/components/agenda/appointment-dialog";
import { AgendaView } from "@/components/agenda/agenda-view";
import type { AgendaBlock } from "@/lib/agenda/grid";
import type { AppointmentDetail, AppointmentPreview } from "@/server/domain/appointments/queries";

// Lo stesso harness senza DOM di invoice-editor-panel.test.ts: componenti e callback reali,
// azioni controllate. Nessun timer viene avanzato tra l'ultimo cambio e Salva.
const hooks = vi.hoisted(() => ({
  active: null as null | { slots: unknown[]; cursor: number; effects: (() => void)[] },
  tasks: [] as Promise<unknown>[],
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = () => {
    if (!hooks.active) throw new Error("Hook fuori dal render di prova");
    return { host: hooks.active, index: hooks.active.cursor++ };
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const { host, index } = slot();
      if (!(index in host.slots)) host.slots[index] = typeof initial === "function" ? initial() : initial;
      return [host.slots[index], (next: unknown) => {
        host.slots[index] = typeof next === "function" ? next(host.slots[index]) : next;
      }];
    },
    useRef: (initial: unknown) => {
      const { host, index } = slot();
      return host.slots[index] ??= { current: initial };
    },
    useEffect: (effect: () => void, deps: unknown[]) => {
      const { host, index } = slot();
      const before = host.slots[index] as unknown[] | undefined;
      if (!before || deps.some((dep, i) => !Object.is(dep, before[i]))) {
        host.effects.push(effect);
        host.slots[index] = deps;
      }
    },
    useId: () => "appointment-test",
    useEffectEvent: (fn: unknown) => fn,
    useTransition: () => [false, (fn: () => Promise<unknown>) => hooks.tasks.push(fn())],
    startTransition: (fn: () => void) => fn(),
  };
});
const actions = vi.hoisted(() => ({ defaults: vi.fn(), preview: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock("@/app/(app)/agenda/actions", () => ({
  bookingDefaultsAction: actions.defaults, previewAppointmentAction: actions.preview,
  createAppointmentAction: actions.create, updateAppointmentAction: actions.update, suggestStartAction: vi.fn(),
}));
vi.mock("@/app/(app)/oggi/actions", () => ({ currentDayAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/agenda/patient-picker", () => ({ PatientPicker: () => null, choiceLabel: () => "Ada Prova" }));
vi.mock("@/components/agenda/seduta-fatta-panel", () => ({ SedutaFattaPanel: () => null }));
vi.mock("@/components/cartella/cycle-close-dialog", () => ({ CycleCloseDialog: () => null }));
vi.mock("@/components/messaggi/message-composer", () => ({ MessageComposer: () => null }));
vi.mock("@/components/agenda/appointment-detail", () => ({ AppointmentDetailSheet: () => null }));
vi.mock("@/components/agenda/toolbar", () => ({ AgendaToolbar: () => null }));
vi.mock("@/components/agenda/week-grid", () => ({ WeekGrid: () => null }));

type Props = Record<string, unknown>;
type Element = ReactElement<Props>;
class Host {
  slots: unknown[] = [];
  cursor = 0;
  effects: (() => void)[] = [];
  tree: ReactNode;
  constructor(private element: Element) {}
  render() {
    this.cursor = 0; hooks.active = this;
    try { this.tree = (this.element.type as (props: Props) => ReactNode)(this.element.props); }
    finally { hooks.active = null; }
    return this;
  }
  async flush() {
    for (const effect of this.effects.splice(0)) effect();
    await Promise.all(hooks.tasks.splice(0));
    await Promise.resolve();
    return this.render();
  }
}
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!isValidElement<Props>(tree)) return [];
  return [tree, ...nodes(tree.props.children as ReactNode)];
}
function named(host: Host, name: string): Element {
  const node = nodes(host.tree).find((n) => typeof n.type === "function" && n.type.name === name);
  if (!node) throw new Error(`Elemento ${name} non trovato`);
  return node;
}
function button(host: Host, label: string): Element {
  const node = nodes(host.tree).find((n) => n.props.children === label);
  if (!node) throw new Error(`Pulsante ${label} non trovato`);
  return node;
}
function submit(host: Host, submitter: unknown = null) {
  const form = nodes(host.tree).find((n) => n.type === "form")!;
  (form.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn(), nativeEvent: { submitter } });
  host.render();
}
function changeTime(host: Host, time: string) {
  const select = nodes(host.tree).find((n) => n.props.value === "09:00" && typeof n.props.onValueChange === "function")!;
  (select.props.onValueChange as (value: string) => void)(time);
  host.render();
}
const patient = { id: "paziente", firstName: "Ada", lastName: "Prova", birthDate: "1990-01-01", phone: null, archived: false };
const created = { patientId: patient.id, cycleId: "ciclo", seriesId: null,
  appointments: [{ id: "nuovo-id", startsAt: new Date("2026-11-04T08:00:00Z"), status: "prenotato" }] };
const preview: AppointmentPreview = { pastStart: true, warnings: [], endsNextDay: false, rows: [] };
async function form(extra: Partial<AppointmentDialogProps> = {}) {
  const dialog = new Host(createElement(AppointmentDialog, {
    open: true, onOpenChange: vi.fn(), services: [{ id: "prestazione", name: "Trattamento", kind: "seduta", durationMin: 45, priceCents: 6000 }],
    defaultIntervalWeeks: 1, defaultExpectedSessions: 4,
    prefill: { patientId: patient.id, day: "2026-11-04", time: "09:00" }, ...extra,
  }) as unknown as Element).render();
  return new Host(named(dialog, "AppointmentForm")).render().flush();
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); hooks.tasks = [];
  actions.defaults.mockResolvedValue({ ok: true, data: { patient, serviceId: "prestazione", cycle: { kind: "new" }, intervalWeeks: 1, seriesCount: 4 } });
  actions.preview.mockResolvedValue({ ok: true, data: preview });
  actions.create.mockResolvedValue({ ok: true, data: created });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("orario_passato", () => {
  it.each([
    [{}, true], [{ repeat: true }, false], [{ bornDone: true }, false],
    [{ complete: false }, false], [{ pastStart: false }, false], [{ confirmedChoice: true }, false],
  ])("decisione per %j: %s", async (overrides, expected) => {
    const { needsPastQuestion } = await import("@/lib/agenda/past-question");
    expect(needsPastQuestion({ complete: true, bornDone: false, repeat: false, pastStart: true, confirmedChoice: false, ...overrides })).toBe(expected);
  });
});

describe("salvataggio dell'input corrente", () => {
  it("riprende l'anteprima dei campi cambiati durante la verifica e mostra l'avviso orari", async () => {
    const host = await form();
    let checked!: (value: unknown) => void;
    actions.preview.mockReturnValueOnce(new Promise((resolve) => { checked = resolve; }));
    submit(host);
    changeTime(host, "10:00");
    // L'effetto dei nuovi campi gira mentre il submit possiede ancora la verifica.
    for (const effect of host.effects.splice(0)) effect();
    checked({ ok: true, data: preview });
    await host.flush();
    actions.preview.mockResolvedValue({ ok: true, data: { ...preview, warnings: ["Fuori dagli orari dello studio."] } });
    await host.flush();
    await vi.advanceTimersByTimeAsync(300);
    await host.flush();
    expect(actions.preview).toHaveBeenCalledWith(expect.objectContaining({ time: "10:00" }));
    expect(nodes(host.tree).some((n) => n.props.children === "Fuori dagli orari dello studio.")).toBe(true);
    expect(actions.create).not.toHaveBeenCalled();
  });

  it.each([false, true])("entro300ms, nessun INSERT prima della risposta, fatto=%s", async (asDone) => {
    const host = await form();
    let resolve!: (value: unknown) => void;
    actions.preview.mockReturnValue(new Promise((done) => { resolve = done; }));
    changeTime(host, "07:00");
    submit(host);
    expect(actions.preview).toHaveBeenCalledWith(expect.objectContaining({ time: "07:00" }));
    expect(button(host, "Salva").props.disabled).toBe(true);
    expect(actions.create).not.toHaveBeenCalled();
    resolve({ ok: true, data: preview });
    await host.flush();
    expect(named(host, "AlertDialog").props.open).toBe(true);
    expect(actions.create).not.toHaveBeenCalled();
    actions.preview.mockResolvedValue({ ok: true, data: preview });
    (button(host, asDone ? "Sì, è fatto" : "No, lascia prenotato").props.onClick as () => void)();
    await host.flush();
    expect(actions.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ time: "07:00", status: asDone ? "fatto" : "prenotato" }));
  });

  it("una risposta di verifica obsoleta non salva e non sovrascrive il nuovo orario", async () => {
    const host = await form();
    let resolve!: (value: unknown) => void;
    actions.preview.mockReturnValue(new Promise((done) => { resolve = done; }));
    submit(host);
    changeTime(host, "10:00");
    resolve({ ok: true, data: preview });
    await host.flush();
    expect(actions.create).not.toHaveBeenCalled();
    expect(named(host, "AlertDialog").props.open).toBe(false);
    expect(nodes(host.tree).some((n) => n.props.value === "10:00")).toBe(true);
  });

  it("serie: una data tolta resta tolta dopo un salvataggio rifiutato e torna spuntata se cambia l'orario", async () => {
    const host = await form();
    const seriesPreview = (time: string) => ({ ok: true, data: { ...preview, pastStart: false, rows: [
      { day: "2026-11-04", time, state: "libero", label: "Libero" },
      { day: "2026-11-11", time, state: "sovrapposto", label: "Sovrapposto" },
    ] } });
    actions.preview.mockResolvedValue(seriesPreview("09:00"));
    (named(host, "Checkbox").props.onCheckedChange as (value: boolean) => void)(true);
    host.render();
    await host.flush();
    await vi.advanceTimersByTimeAsync(300);
    await host.flush();
    (named(host, "SeriesPreview").props.onToggle as (day: string, included: boolean) => void)("2026-11-11", false);
    host.render();
    actions.create.mockResolvedValueOnce({ ok: false, message: "Prezzo non valido", fieldErrors: { priceCents: "Valore non valido" } });
    submit(host);
    await host.flush();
    // La rilettura dopo il submit rifiutato, con lo stesso input.
    await host.flush();
    await vi.advanceTimersByTimeAsync(300);
    await host.flush();
    expect(named(host, "SeriesPreview").props.excluded).toEqual(new Set(["2026-11-11"]));
    submit(host);
    await host.flush();
    expect(actions.create).toHaveBeenLastCalledWith(expect.objectContaining({
      repeat: expect.objectContaining({ excludedDays: ["2026-11-11"] }),
    }));
    actions.preview.mockResolvedValue(seriesPreview("10:00"));
    changeTime(host, "10:00");
    await host.flush();
    await vi.advanceTimersByTimeAsync(300);
    await host.flush();
    expect(named(host, "SeriesPreview").props.excluded).toEqual(new Set());
  });

  it("anteprima rifiutata: nessun INSERT, copia o chiusura", async () => {
    const onCreated = vi.fn(); const onConfirmMessage = vi.fn();
    const host = await form({ onCreated, onConfirmMessage });
    actions.preview.mockResolvedValue({ ok: false, message: "Verifica rifiutata" });
    submit(host);
    await host.flush();
    expect(actions.create).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onConfirmMessage).not.toHaveBeenCalled();
  });
});

describe("conferma e spostamento dopo il commit", () => {
  it.each([false, true])("dopo NOT_SAVED il controllo premuto riprende il focus a fieldset abilitato, conferma=%s", async (confirmMessage) => {
    const host = await form({ onConfirmMessage: vi.fn() });
    const control = { focus: vi.fn(() => {
      expect(nodes(host.tree).find((n) => n.type === "fieldset")?.props.disabled).toBe(false);
    }) };
    actions.preview.mockResolvedValue({ ok: true, data: { ...preview, pastStart: false } });
    actions.create.mockRejectedValueOnce(new Error("Connessione interrotta"));
    if (confirmMessage) {
      (button(host, "Salva e copia la conferma").props.onClick as (event: unknown) => void)({ currentTarget: control });
      host.render();
    } else submit(host, control);
    for (const effect of host.effects.splice(0)) effect();
    expect(control.focus).not.toHaveBeenCalled();
    await host.flush();
    await host.flush();
    expect(nodes(host.tree).some((n) => n.props.children === "Non ho salvato l'appuntamento. Riprova.")).toBe(true);
    expect(control.focus).toHaveBeenCalledOnce();
  });

  it.each([false, true])("un default tardivo non perde un commit riuscito, conferma=%s", async (confirmMessage) => {
    const onCreated = vi.fn(); const onConfirmMessage = vi.fn(); const onOpenChange = vi.fn();
    const host = await form({ onCreated, onConfirmMessage, onOpenChange });
    let defaultsReady!: (value: unknown) => void;
    actions.defaults.mockReturnValueOnce(new Promise((resolve) => { defaultsReady = resolve; }));
    (named(host, "PatientPicker").props.onChange as (value: unknown) => void)({ kind: "existing", hit: patient });
    host.render();
    let committed!: (value: unknown) => void;
    actions.create.mockReturnValueOnce(new Promise((resolve) => { committed = resolve; }));
    actions.preview.mockResolvedValue({ ok: true, data: { ...preview, pastStart: false } });
    if (confirmMessage) (button(host, "Salva e copia la conferma").props.onClick as (event: unknown) => void)({ currentTarget: null });
    else submit(host);
    await Promise.resolve();
    expect(actions.create).toHaveBeenCalledOnce();
    defaultsReady({ ok: true, data: { patient, serviceId: "prestazione", cycle: { kind: "new" }, intervalWeeks: 2, seriesCount: 3 } });
    await Promise.resolve();
    committed({ ok: true, data: created });
    await host.flush();
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(created);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    if (confirmMessage) expect(onConfirmMessage).toHaveBeenCalledExactlyOnceWith(created);
    else expect(onConfirmMessage).not.toHaveBeenCalled();
    // Il commit riuscito viene gestito; gli errori dei campi vecchi continuano a essere ignorati.
    const refusedCreated = vi.fn(); const refusedClose = vi.fn();
    const refusedHost = await form({ onCreated: refusedCreated, onOpenChange: refusedClose });
    let result!: (value: unknown) => void;
    actions.create.mockReturnValueOnce(new Promise((resolve) => { result = resolve; }));
    submit(refusedHost);
    await Promise.resolve();
    changeTime(refusedHost, "10:00");
    result({ ok: false, message: "Rifiuto precedente", fieldErrors: { time: "Ora precedente non valida" } });
    await refusedHost.flush();
    expect(refusedCreated).not.toHaveBeenCalled();
    expect(refusedClose).not.toHaveBeenCalled();
    expect(nodes(refusedHost.tree).some((n) => n.props.error === "Ora precedente non valida")).toBe(false);
  });

  it("conferma richiesta su orario passato: No apre il messaggio, Sì fatto apre solo il pannello", async () => {
    for (const asDone of [false, true]) {
      const onCreated = vi.fn(); const onConfirmMessage = vi.fn(); const onOpenChange = vi.fn();
      const host = await form({ onCreated, onConfirmMessage, onOpenChange });
      actions.create.mockImplementation(async (input) => ({ ok: true, data: {
        ...created, appointments: [{ ...created.appointments[0], status: input.status }],
      } }));
      (button(host, "Salva e copia la conferma").props.onClick as (event: unknown) => void)({ currentTarget: null });
      await host.flush();
      expect(named(host, "AlertDialog").props.open).toBe(true);
      (button(host, asDone ? "Sì, è fatto" : "No, lascia prenotato").props.onClick as () => void)();
      await host.flush();
      expect(onCreated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        appointments: [expect.objectContaining({ id: "nuovo-id", status: asDone ? "fatto" : "prenotato" })],
      }));
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      if (asDone) expect(onConfirmMessage).not.toHaveBeenCalled();
      else expect(onConfirmMessage).toHaveBeenCalledExactlyOnceWith(created);
    }
  });

  it.each([false, true])("salva_copia_conferma, salvataggio rifiutato=%s", async (refused) => {
    const onCreated = vi.fn(); const onConfirmMessage = vi.fn();
    const host = await form({ onCreated, onConfirmMessage });
    actions.preview.mockResolvedValue({ ok: true, data: { ...preview, pastStart: false } });
    if (refused) actions.create.mockResolvedValue({ ok: false, message: "Rifiuto di prova" });
    (button(host, "Salva e copia la conferma").props.onClick as (event: unknown) => void)({ currentTarget: null });
    expect(onConfirmMessage).not.toHaveBeenCalled();
    await host.flush();
    if (refused) {
      expect(onCreated).not.toHaveBeenCalled();
      expect(onConfirmMessage).not.toHaveBeenCalled();
    } else {
      expect(onCreated).toHaveBeenCalledWith(created);
      expect(onConfirmMessage).toHaveBeenCalledExactlyOnceWith(created);
    }
  });

  it("serie: avvisa Conferma del primo appuntamento", async () => {
    const host = await form({ onConfirmMessage: vi.fn() });
    (named(host, "Checkbox").props.onCheckedChange as (value: boolean) => void)(true);
    host.render();
    expect(nodes(host.tree).some((n) => n.props.children === "Conferma del primo appuntamento")).toBe(true);
  });

  it.each([false, true])("spostato_confermato: onUpdated conserva la semantica, moved=%s", async (moved) => {
    const onUpdated = vi.fn(); const onMoved = vi.fn();
    const detail = { id: "appuntamento", patient, serviceId: "prestazione", priceCents: 6000, status: "confermato", visit: null,
      cycleTitle: "Ciclo prova", edit: { day: "2026-11-05", time: "09:00", durationMin: 45, updatedAt: "2026-11-04T08:00:00Z" } } as AppointmentDetail;
    const host = await form({ mode: { kind: "edit", detail }, onUpdated, onMoved });
    actions.update.mockResolvedValue({ ok: true, data: { movedFromConfirmed: moved } });
    submit(host);
    await host.flush();
    expect(onUpdated).toHaveBeenCalledOnce();
    if (moved) expect(onMoved).toHaveBeenCalledExactlyOnceWith(detail.id);
    else expect(onMoved).not.toHaveBeenCalled();
  });
});

describe("focus dopo la conferma dall'agenda", () => {
  it.each([false, true])("chiuso il compositore torna al blocco nuovo o alla cella, blocco disponibile=%s", async (hasBlock) => {
    const blockFocus = vi.fn(); const cellFocus = vi.fn();
    const appointment = { id: "nuovo-id", timeRange: "09:00-09:45", patientLabel: "Prova Ada", serviceName: "Trattamento" } as AgendaBlock;
    const newBlock = { getAttribute: () => "09:00-09:45, Prova Ada, Trattamento, Prenotato", focus: blockFocus };
    const cell = { tabIndex: 0, isConnected: true, focus: cellFocus, querySelectorAll: () => hasBlock ? [newBlock] : [] };
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 16));
    const host = new Host(createElement(AgendaView, {
      view: "giorno", day: "2026-11-04", label: "4 novembre", prevDay: "2026-11-03", nextDay: "2026-11-05",
      today: "2026-11-04", showCancelled: false, todayDay: "2026-11-04", nowMin: 510,
      days: [{ day: "2026-11-04", header: "mer 4", bands: [], blocks: [appointment] }],
      window: { startMin: 420, endMin: 1260 }, services: [], defaultIntervalWeeks: 1, defaultExpectedSessions: 4,
    }) as unknown as Element).render();
    const root = nodes(host.tree)[0]!;
    if (root.props.ref) (root.props.ref as { current: unknown }).current = { querySelector: () => cell };
    (named(host, "WeekGrid").props.onCellClick as (day: string, minutes: number) => void)("2026-11-04", 540);
    host.render();
    (named(host, "AppointmentDialog").props.onConfirmMessage as (value: unknown) => void)(created);
    host.render();
    (named(host, "MessageComposer").props.onClose as () => void)();
    host.render();
    expect(blockFocus).not.toHaveBeenCalled();
    expect(cellFocus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    expect(hasBlock ? blockFocus : cellFocus).toHaveBeenCalledOnce();
    expect(hasBlock ? cellFocus : blockFocus).not.toHaveBeenCalled();
    expect(nodes(host.tree).some((n) => typeof n.type === "function" && n.type.name === "MessageComposer")).toBe(false);
  });
});
