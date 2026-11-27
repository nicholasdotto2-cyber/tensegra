import { isValidElement, type ReactElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { SectionE } from "@/components/visita/section-e";
import { createSaveQueue } from "@/lib/visits/save-queue";
import type { VisitEditor } from "@/server/domain/visits/editor";

// Stesso harness senza DOM di invoice-editor-panel: callback reali e coda reale,
// hook conservati tra render; non vengono eseguiti i dialoghi figli.
const hooks = vi.hoisted(() => ({ active: null as null | { slots: unknown[]; cursor: number } }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = () => {
    if (!hooks.active) throw new Error("Hook fuori dal render di prova");
    return { host: hooks.active, index: hooks.active.cursor++ };
  };
  return {
    ...react,
    useId: () => "advice-test",
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
  };
});
const actions = vi.hoisted(() => ({ editor: vi.fn() }));
vi.mock("@/app/(app)/pazienti/[id]/visite/[visitId]/actions", () => ({
  visitEditorAction: actions.editor, cycleOpeningAction: vi.fn(),
}));
vi.mock("@/components/agenda/appointment-dialog", () => ({ NewAppointmentButton: () => null }));
vi.mock("@/components/cartella/cycle-close-dialog", () => ({ CycleCloseDialog: () => null }));
vi.mock("@/components/messaggi/message-composer", () => ({ MessageComposer: () => null }));
vi.mock("@/components/visita/right-column", () => ({ usePrepareReferral: vi.fn() }));

type Props = Record<string, unknown>;
type Element = ReactElement<Props>;
class Host {
  slots: unknown[] = [];
  cursor = 0;
  tree: ReactNode;
  render(element: Element) {
    this.cursor = 0;
    hooks.active = this;
    try { this.tree = (element.type as (props: Props) => ReactNode)(element.props); }
    finally { hooks.active = null; }
    return this;
  }
}
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return isValidElement<Props>(tree) ? [tree, ...nodes(tree.props.children as ReactNode)] : [];
}
function named(host: Host, name: string): Element {
  const element = nodes(host.tree).find((n) => typeof n.type === "function" && n.type.name === name);
  if (!element) throw new Error(`Elemento ${name} assente`);
  return element;
}

it("finisce l'autosave accodato prima di consentire la copia, conservando testo e canali", async () => {
  let row = { id: "advice-a", templateCode: "camminata", text: "Testo precedente", communicatedVia: ["a_voce"] };
  // Solo i dati usati dai componenti esercitati; gli altri figli restano elementi React.
  const view = () => ({
    visit: { id: "visit-a" }, cycle: { showsOpening: false }, advice: [row],
    suggestedAdvice: [{ code: "camminata", title: "Camminata" }],
    canCopyAdvice: true, adviceCopyReason: null,
  }) as unknown as VisitEditor;
  let editor = view();
  actions.editor.mockImplementation(async () => ({ ok: true, data: view() }));
  const queue = createSaveQueue<VisitEditor>({
    onView: (next) => { editor = next; }, onChange: () => {}, reread: actions.editor,
  });
  const section = new Host();
  const message = new Host();
  const render = () => {
    section.render({ type: SectionE, key: null, props: { editor, mode: "bozza", run: queue.run, op, booking: null } });
    message.render(named(section, "AdviceMessage"));
  };
  const op = (operation: unknown) => queue.run(async () => {
    row = { ...row, ...operation as { text: string; communicatedVia: string[] } };
    return { ok: true, data: view() };
  });
  render();
  const advice = new Host().render(named(section, "Advice"));
  const item = new Host().render(named(advice, "AdviceItem"));
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  queue.run(async () => { await blocked; return { ok: true, data: view() }; });
  // Il blur del campo accoda il testo con i vecchi canali mentre un'altra scrittura aspetta.
  (named(item, "VisitTextField").props.onSave as (text: string, options: object) => void)("Testo aggiornato", {});
  const copyButton = nodes(message.tree).find((n) => n.props.children === "Copia il messaggio")!;
  (copyButton.props.onClick as () => void)();
  render();
  const openedEarly = named(message, "MessageComposer").props.source !== null;
  const frozen = named(section, "Advice").props.disabled;
  // Se il compositore è già aperto, la copia precede il vecchio autosave: è la regressione.
  if (openedEarly) row = { ...row, communicatedVia: [...row.communicatedVia, "messaggio_copiato"] };
  unblock();
  await vi.waitFor(() => expect(queue.snapshot().pending).toBe(false));
  render();
  expect(named(message, "MessageComposer").props.source).toMatchObject({ adviceIds: ["advice-a"] });
  // Effetto del comando di copia, qui al confine del compositore; il percorso DB ha il suo test.
  if (!openedEarly) row = { ...row, communicatedVia: [...row.communicatedVia, "messaggio_copiato"] };
  (named(message, "MessageComposer").props.onRecorded as () => void)();
  let finishRefresh!: () => void;
  const refreshing = new Promise<void>((resolve) => { finishRefresh = resolve; });
  actions.editor.mockImplementationOnce(async () => { await refreshing; return { ok: true, data: view() }; });
  (named(message, "MessageComposer").props.onClose as () => void)();
  render();
  expect(named(section, "Advice").props.disabled).toBe(true);
  finishRefresh();
  await vi.waitFor(() => expect(queue.snapshot().pending).toBe(false));
  render();
  expect(editor.advice[0]).toMatchObject({ text: "Testo aggiornato", communicatedVia: ["a_voce", "messaggio_copiato"] });
  expect(openedEarly).toBe(false);
  expect(frozen).toBe(true);
  expect(named(section, "Advice").props.disabled).toBe(false);
});
