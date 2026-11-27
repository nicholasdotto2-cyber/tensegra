import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceEditorSheet } from "@/components/fatture/invoice-editor";
import { SedutaFattaPanel } from "@/components/agenda/seduta-fatta-panel";
import { DEFAULT_RATES } from "@/lib/fiscal/types";
import type { InvoiceEditorView } from "@/server/domain/invoices/queries";

// Harness senza DOM: esegue i componenti reali, conserva gli hook fra render e invoca i loro callback.
// I componenti UI figli restano elementi React. Il focus è osservato sul ref del titolo del passo 1.
const hooks = vi.hoisted(() => ({
  active: null as null | { slots: unknown[]; cursor: number; changed: boolean; effects: (() => void)[] },
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
        const value = typeof next === "function" ? next(host.slots[index]) : next;
        if (!Object.is(value, host.slots[index])) { host.slots[index] = value; host.changed = true; }
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
    useId: () => "test-editor",
    useEffectEvent: (fn: unknown) => fn,
    useTransition: () => [false, (fn: () => Promise<unknown>) => hooks.tasks.push(fn())],
  };
});

const actions = vi.hoisted(() => ({ editor: vi.fn(), save: vi.fn(), issue: vi.fn(), panel: vi.fn(), peek: vi.fn() }));
vi.mock("@/app/(app)/fatture/actions", () => ({
  invoiceEditorAction: actions.editor, saveDraftAction: actions.save, issueFromEditorAction: actions.issue,
  deleteDraftAction: vi.fn(), peekInvoiceNumberAction: actions.peek,
}));
vi.mock("@/app/(app)/agenda/actions", () => ({
  sedutaFattaAction: actions.panel, savePaymentMethodAction: vi.fn(), createAppointmentAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/fatture/recipient-fields", () => ({ RecipientFields: () => null }));
vi.mock("@/components/cartella/open-visit", () => ({ OpenVisitButton: () => null }));
vi.mock("@/components/cartella/cycle-close-dialog", () => ({ CycleCloseDialog: () => null }));
vi.mock("@/components/agenda/appointment-dialog", () => ({ AppointmentDialog: () => null }));
vi.mock("@/components/consensi/collect-dialog", () => ({ ConsentCollectDialog: () => null }));

type Props = Record<string, unknown>;
type Element = ReactElement<Props>;
class Host {
  slots: unknown[] = [];
  cursor = 0;
  changed = false;
  effects: (() => void)[] = [];
  tree: ReactNode;
  constructor(private element: Element) {}
  render(element = this.element) {
    this.element = element;
    let count = 0;
    do {
      if (++count > 10) throw new Error("Render di prova non converge");
      this.changed = false;
      this.cursor = 0;
      hooks.active = this;
      try { this.tree = (element.type as (props: Props) => ReactNode)(element.props); }
      finally { hooks.active = null; }
    } while (this.changed);
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
function button(host: Host, text: string): Element {
  const node = nodes(host.tree).find((n) => n.props.children === text && typeof n.props.onClick === "function");
  if (!node) throw new Error(`Pulsante ${text} non trovato`);
  return node;
}
const ID = "b1919191-1919-4191-8191-191919191919";
const input = {
  invoiceId: null, recipient: { kind: "paziente" as const, patientId: ID },
  lines: [{ serviceId: null, appointmentId: null, description: "Trattamento osteopatico", serviceDate: "2026-11-03", quantity: 1, unitPriceCents: 5500 }],
  paymentMethod: "carta" as const, paidOn: null, stampMarkCode: null, internalNotes: null,
};
const view: InvoiceEditorView = {
  invoiceId: null, defaultPaymentMethod: "carta", regime: "forfettario", regimeChanged: false,
  rates: DEFAULT_RATES, supplierReady: true, recipients: { patients: [], parties: [] },
  draft: null, prefill: input, toInvoice: [], services: [], today: "2026-11-04", nextNumber: "1/2026",
  problems: [], recipientFields: null,
};
async function editor(props: Props = {}, editorView = view, editorProps: Props = {}) {
  actions.editor.mockResolvedValue({ ok: true, data: editorView });
  const sheet = await new Host({ type: InvoiceEditorSheet, key: null, props: { start: { kind: "new" }, onClose: vi.fn(), ...props } } as Element).render().flush();
  const element = named(sheet, "InvoiceEditor");
  return new Host({ ...element, props: { ...element.props, ...editorProps } }).render();
}
beforeEach(() => {
  vi.clearAllMocks(); hooks.tasks = [];
  actions.peek.mockImplementation(async ({ issueDate }: { issueDate: string }) => ({ ok: true, data: `1/${issueDate.slice(0, 4)}` }));
});

describe("editor dal pannello Seduta fatta", () => {
  it.each([
    { label: "vista 2027 e incasso 30/12/2026", paidOn: "2026-12-30", reopened: false, expected: "9/2026" },
    { label: "bozza incassata 30/12 riaperta 2/01 senza spunta", paidOn: null, reopened: true, expected: "3/2027" },
    { label: "incasso in un anno precedente al 2026", paidOn: "2025-12-30", reopened: false, expected: "8/2025" },
  ])("E3 annuncia il numero della Data prevista: $label", async ({ paidOn, reopened, expected }) => {
    const editorView: InvoiceEditorView = { ...view, today: "2027-01-02", nextNumber: reopened ? "9/2026" : "3/2027",
      draft: reopened ? { ...input, invoiceId: ID, paidOn: "2026-12-30" } : null };
    const host = await editor({}, editorView);
    const checkbox = nodes(host.tree).find((n) => "checked" in n.props)!;
    (checkbox.props.onCheckedChange as (v: boolean) => void)(!reopened);
    host.render();
    if (paidOn !== null) {
      const date = nodes(host.tree).find((n) => n.props.type === "date")!;
      (date.props.onChange as (e: unknown) => void)({ target: { value: paidOn } });
      host.render();
    }
    const plannedDate = paidOn ?? "2027-01-02";
    expect(named(host, "EditorSummary").props.issueDate).toBe(plannedDate);
    let resolvePeek!: (v: unknown) => void;
    actions.peek.mockReturnValue(new Promise((resolve) => { resolvePeek = resolve; }));
    (button(host, "Emetti").props.onClick as () => void)();
    host.render();
    expect(nodes(host.tree).some((n) => typeof n.props.children === "string" && n.props.children.includes(`numero ${expected}`))).toBe(false);
    // Prima della risposta non deve essere possibile confermare un numero vecchio.
    expect(named(host, "AlertDialog").props.open).toBe(false);
    expect(actions.peek).toHaveBeenCalledWith({ issueDate: plannedDate });
    resolvePeek({ ok: true, data: expected });
    await host.flush();
    expect(named(host, "AlertDialog").props.open).toBe(true);
    expect(nodes(host.tree).some((n) => typeof n.props.children === "string" && n.props.children.includes(`numero ${expected}`))).toBe(true);
    actions.issue.mockResolvedValue({ ok: false, message: "Rifiuto di prova" });
    (button(host, "Emetti fattura").props.onClick as () => void)();
    await host.flush();
    expect(actions.issue).toHaveBeenCalledWith(expect.objectContaining({ paidOn }));
  });

  it("E2 conserva la modifica durante il salvataggio e lascia il pannello sporco", async () => {
    const onDirtyChange = vi.fn();
    const editing = await editor({}, view, { onDirtyChange });
    await editing.flush();
    let resolveSave!: (v: unknown) => void;
    actions.save.mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
    (button(editing, "Salva bozza").props.onClick as () => void)();
    const linesElement = named(editing, "EditorLines");
    const lines = linesElement.props.lines as { description: string }[];
    (linesElement.props.onChange as (v: unknown) => void)([{ ...lines[0], description: "Modificata durante il salvataggio" }]);
    editing.render();
    resolveSave({ ok: true, data: { id: ID } });
    await editing.flush();
    expect((named(editing, "EditorLines").props.lines as { description: string }[])[0]?.description).toBe("Modificata durante il salvataggio");
    await editing.flush();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    actions.save.mockResolvedValue({ ok: true, data: { id: ID } });
    (button(editing, "Salva bozza").props.onClick as () => void)();
    await editing.flush();
    await editing.flush();
    expect(actions.save).toHaveBeenLastCalledWith(expect.objectContaining({ invoiceId: ID, lines: [expect.objectContaining({ description: "Modificata durante il salvataggio" })] }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("E1 elimina il rifiuto del bonifico passando a contanti e riapre la conferma", async () => {
    const host = await editor();
    const method = () => nodes(host.tree).find((n) => n.props.label === "Metodo")!;
    (method().props.onChange as (v: string) => void)("bonifico");
    host.render();
    (button(host, "Emetti").props.onClick as () => void)();
    await host.flush();
    actions.issue.mockResolvedValue({ ok: false, message: "IBAN mancante", fieldErrors: { "payment.iban": "IBAN mancante" }, refused: true });
    (button(host, "Emetti fattura").props.onClick as () => void)();
    await host.flush();
    expect(nodes(host.tree).some((n) => n.props.children === "IBAN mancante")).toBe(true);
    (method().props.onChange as (v: string) => void)("contanti");
    host.render();
    (button(host, "Emetti").props.onClick as () => void)();
    await host.flush();
    expect(named(host, "AlertDialog").props.open).toBe(true);
    expect(nodes(host.tree).some((n) => n.props.children === "IBAN mancante")).toBe(false);
  });

  it("markPaid preseleziona Già incassata e oggi anche premendo solo Emetti", async () => {
    const host = await editor({ markPaid: true });
    const checkbox = nodes(host.tree).find((n) => "checked" in n.props)!;
    expect(checkbox.props.checked).toBe(true);
    expect(nodes(host.tree).find((n) => n.props.type === "date")?.props.value).toBe(view.today);
    (button(host, "Emetti").props.onClick as () => void)();
    await host.flush();
    actions.issue.mockResolvedValue({ ok: false, message: "Rifiuto di prova" });
    (button(host, "Emetti fattura").props.onClick as () => void)();
    await host.flush();
    expect(actions.issue).toHaveBeenCalledWith(expect.objectContaining({ paidOn: view.today }));
  });

  it("conserva lo stesso uuid del client su salvataggi e ripetizione dell'emissione", async () => {
    const random = vi.spyOn(crypto, "randomUUID").mockReturnValue(ID);
    try {
      const host = await editor();
      actions.save.mockResolvedValue({ ok: true, data: { id: ID } });
      for (let i = 0; i < 2; i++) {
        (button(host, "Salva bozza").props.onClick as () => void)();
        await host.flush();
      }
      for (let i = 0; i < 2; i++) {
        (button(host, "Emetti").props.onClick as () => void)();
        await host.flush();
        actions.issue.mockResolvedValue({ ok: false, message: "Rifiuto di prova" });
        (button(host, "Emetti fattura").props.onClick as () => void)();
        await host.flush();
      }
      expect(random).toHaveBeenCalledTimes(1);
      expect(actions.save.mock.calls.map(([draft]) => draft.id)).toEqual([ID, ID]);
      expect(actions.issue.mock.calls.map(([draft]) => draft.id)).toEqual([ID, ID]);
      expect(actions.issue).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: ID }));
    } finally { random.mockRestore(); }
  });

  it.each(["carta", null])("dal metodo %s passa l'intento di incasso all'editor", async (paymentMethod) => {
    actions.panel.mockResolvedValue({ ok: true, data: {
      appointmentId: ID, paymentMethod, patient: { id: ID }, title: "Seduta fatta", consentMissing: false,
      steps: { incasso: false, prossima: true, visita: true }, invoice: null, next: { kind: "none" }, canCloseCycle: false,
    } });
    const panel = await new Host({ type: SedutaFattaPanel, key: null, props: { appointmentId: ID, onClose: vi.fn(), services: [] } } as Element).render().flush();
    const body = new Host(named(panel, "PanelBody")).render();
    expect(named(body, "InvoiceEditorSheet").props.markPaid).toBe(paymentMethod !== null);
  });

  it("dopo Salva bozza e chiusura riporta il focus al titolo del passo 1", async () => {
    const data = {
      appointmentId: ID, paymentMethod: "carta", patient: { id: ID }, title: "Seduta fatta", consentMissing: false,
      steps: { incasso: false, prossima: true, visita: true }, invoice: null, next: { kind: "none" }, canCloseCycle: false,
    };
    actions.panel.mockResolvedValue({ ok: true, data });
    const panel = await new Host({ type: SedutaFattaPanel, key: null, props: { appointmentId: ID, onClose: vi.fn(), services: [] } } as Element).render().flush();
    const element = named(panel, "PanelBody");
    const body = new Host(element).render();
    const step = nodes(body.tree).find((n) => n.props.title === "Incasso e fattura")!;
    const focus = vi.fn();
    (step.props.headingRef as { current: unknown }).current = { focus };
    await body.flush();
    (button(body, "Emetti e segna pagata").props.onClick as () => void)();
    await body.render().flush();
    // Il salvataggio è già confermato dal server; la rilettura può arrivare dopo la chiusura.
    (named(body, "InvoiceEditorSheet").props.onClose as () => void)();
    await body.render().flush();
    expect(focus).not.toHaveBeenCalled();
    await body.render({ ...element, props: { ...element.props, view: {
      ...data, steps: { ...data.steps, incasso: true }, invoice: { id: ID, numberLabel: null },
    } } }).flush();
    expect(focus).toHaveBeenCalledOnce();
  });
});

describe("controlli e conferma coerenti nell'editor", () => {
  const IBAN = { field: "payment.iban", message: "Per il bonifico serve l'IBAN dello studio: completalo in Impostazioni, Fisco.", href: "/impostazioni/fisco" };
  const SDI = { field: "sdi.00471", message: "Controllo SdI 00471: cedente e cessionario con la stessa partita IVA", href: null };
  const texts = (host: Host) => nodes(host.tree).flatMap((n) => typeof n.props.children === "string" ? [n.props.children] : []);
  const confirmText = (host: Host) => texts(host).filter((t) => t.startsWith("Alla fattura verrà assegnato il numero"));
  const fieldset = (host: Host) => {
    const node = nodes(host.tree).find((n) => n.type === "fieldset");
    if (!node) throw new Error("Fieldset dei campi non trovato");
    return node;
  };

  it("iban_non_nasconde_00471: passando a Carta sparisce l'IBAN, 00471 resta e blocca prima del numero", async () => {
    const host = await editor({}, { ...view, problems: [IBAN, SDI] });
    const method = () => nodes(host.tree).find((n) => n.props.label === "Metodo")!;
    (method().props.onChange as (v: string) => void)("bonifico");
    host.render();
    expect(texts(host)).toEqual(expect.arrayContaining([IBAN.message, SDI.message]));
    (method().props.onChange as (v: string) => void)("carta");
    host.render();
    expect(texts(host)).not.toContain(IBAN.message);
    expect(texts(host)).toContain(SDI.message);
    (button(host, "Emetti").props.onClick as () => void)();
    await host.flush();
    expect(actions.peek).not.toHaveBeenCalled();
    expect(named(host, "AlertDialog").props.open).toBe(false);
  });

  it("edit_durante_peek: i campi sono disabilitati dal clic alla chiusura e Torna indietro conserva il testo", async () => {
    const host = await editor();
    const linesElement = named(host, "EditorLines");
    const lines = linesElement.props.lines as { description: string }[];
    (linesElement.props.onChange as (v: unknown) => void)([{ ...lines[0], description: "Ultimo testo ammesso" }]);
    host.render();
    expect(fieldset(host).props.disabled).toBe(false);
    let resolvePeek!: (v: unknown) => void;
    actions.peek.mockReturnValue(new Promise((resolve) => { resolvePeek = resolve; }));
    (button(host, "Emetti").props.onClick as () => void)();
    host.render();
    expect(fieldset(host).props.disabled).toBe(true);
    resolvePeek({ ok: true, data: "1/2026" });
    await host.flush();
    expect(named(host, "AlertDialog").props.open).toBe(true);
    expect(fieldset(host).props.disabled).toBe(true);
    (named(host, "AlertDialog").props.onOpenChange as (open: boolean) => void)(false);
    host.render();
    (named(host, "AlertDialog").props.onOpenChangeComplete as (open: boolean) => void)(false);
    host.render();
    expect(fieldset(host).props.disabled).toBe(false);
    expect((named(host, "EditorLines").props.lines as { description: string }[])[0]?.description).toBe("Ultimo testo ammesso");
  });

  it("numero_durante_chiusura: il numero resta nel testo finché la conferma non ha finito di chiudersi", async () => {
    const host = await editor();
    (button(host, "Emetti").props.onClick as () => void)();
    await host.flush();
    expect(actions.peek).toHaveBeenCalledWith({ issueDate: view.today });
    expect(confirmText(host)).toEqual(["Alla fattura verrà assegnato il numero 1/2026. Il numero non si può riusare."]);
    (named(host, "AlertDialog").props.onOpenChange as (open: boolean) => void)(false);
    host.render();
    expect(named(host, "AlertDialog").props.open).toBe(false);
    expect(confirmText(host)).toEqual(["Alla fattura verrà assegnato il numero 1/2026. Il numero non si può riusare."]);
    (named(host, "AlertDialog").props.onOpenChangeComplete as (open: boolean) => void)(false);
    host.render();

    // Anche un rifiuto dell'emissione chiude la conferma senza perdere il numero.
    (button(host, "Emetti").props.onClick as () => void)();
    await host.flush();
    actions.issue.mockResolvedValue({ ok: false, message: "Rifiuto di prova" });
    (button(host, "Emetti fattura").props.onClick as () => void)();
    await host.flush();
    expect(named(host, "AlertDialog").props.open).toBe(false);
    expect(confirmText(host)).toEqual(["Alla fattura verrà assegnato il numero 1/2026. Il numero non si può riusare."]);
    expect(texts(host).some((t) => t.includes("numero ."))).toBe(false);
  });
});
