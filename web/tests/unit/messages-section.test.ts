import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesSection } from "@/components/impostazioni/messages-section";
import type { ActionResult } from "@/server/actions/result";

// Come gli altri test dei moduli: componenti e callback reali, hook persistenti senza DOM.
// Solo le azioni server e i nodi nativi per focus/selezione sono sostituiti.
const hooks = vi.hoisted(() => ({ active: null as null | Host }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = () => {
    const host = hooks.active!;
    return { host, index: host.cursor++ };
  };
  return {
    ...react,
    useCallback: (fn: () => void) => hooks.active ? fn : react.useCallback(fn, []),
    useState: (initial: unknown) => {
      if (!hooks.active) return react.useState(initial);
      const { host, index } = slot();
      if (!(index in host.slots)) host.slots[index] = initial;
      return [host.slots[index], (next: unknown) => {
        host.slots[index] = typeof next === "function" ? next(host.slots[index]) : next;
      }];
    },
    useRef: (initial: unknown) => {
      if (!hooks.active) return react.useRef(initial);
      const { host, index } = slot();
      return host.slots[index] ??= { current: initial };
    },
    useEffect: (effect: () => void, deps: unknown[]) => {
      if (!hooks.active) return react.useEffect(effect, deps);
      const { host, index } = slot();
      const before = host.slots[index] as unknown[] | undefined;
      if (!before || deps.some((dep, i) => !Object.is(dep, before[i]))) host.effects.push(effect);
      host.slots[index] = deps;
    },
    useId: () => hooks.active ? "test-messages" : react.useId(),
  };
});
const actions = vi.hoisted(() => ({ save: vi.fn(), tone: vi.fn(), restore: vi.fn(), preview: vi.fn() }));
vi.mock("@/app/(app)/impostazioni/actions", () => ({
  saveMessageTemplateAction: actions.save, saveCommunicationSettingsAction: actions.tone,
  restoreMessageTemplateAction: actions.restore, previewMessageTemplateAction: actions.preview,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));

type Props = Record<string, unknown>;
type Element = ReactElement<Props>;
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!isValidElement<Props>(tree)) return [];
  return [tree, ...nodes(tree.props.children as ReactNode)];
}
class Host {
  slots: unknown[] = [];
  cursor = 0;
  effects: (() => void)[] = [];
  tree: ReactNode;
  focused: Element | null = null;
  constructor(private element: Element) {}
  render() {
    this.cursor = 0;
    hooks.active = this;
    try { this.tree = (this.element.type as (props: Props) => ReactNode)(this.element.props); }
    finally { hooks.active = null; }
    for (const node of nodes(this.tree)) {
      const ref = node.props.ref as { current: unknown } | undefined;
      if (ref && typeof ref === "object") ref.current = {
        value: node.props.value,
        focus: () => { this.focused = node; },
        setSelectionRange: () => {},
        querySelector: (selector: string) => {
          const match = nodes(this.tree).find((n) => selector.includes("aria-invalid") ? n.props["aria-invalid"] === true : n.props.role === "alert");
          return match ? { focus: () => { this.focused = match; } } : null;
        },
      };
    }
    for (const effect of this.effects.splice(0)) effect();
    return this;
  }
  find(predicate: (n: Element) => boolean) {
    const found = nodes(this.tree).find(predicate);
    if (!found) throw new Error("Elemento del modulo assente");
    return found;
  }
  change(value: string) {
    const field = this.find((n) => typeof n.props.onChange === "function");
    (field.props.onChange as (event: unknown) => void)({ target: { value } });
    return this.render();
  }
  submit() {
    (this.find((n) => n.type === "form").props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
    return this.render();
  }
  async settle() { await Promise.resolve(); await Promise.resolve(); return this.render(); }
}
function editor(part: "DefaultTone" | "TemplateEditor", body = "Testo personalizzato") {
  const root = new Host({ type: MessagesSection, key: null, props: {
    initial: [{ key: "conferma", variant: "tu", body, isCustomized: true }], defaultAddressing: "tu", hasPatients: true,
  } } as unknown as Element).render();
  return new Host(root.find((n) => typeof n.type === "function" && n.type.name === part)).render();
}
function deferred() {
  let resolve!: (result: ActionResult<void>) => void;
  return { promise: new Promise<ActionResult<void>>((done) => { resolve = done; }), resolve: (result: ActionResult<void>) => resolve(result) };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { fn(); return 1; });
});

describe("Messaggi: risposte lente e accessibilita", () => {
  it.each(["DefaultTone", "TemplateEditor"] as const)("%s conserva il rifiuto generale dopo un ritocco", async (part) => {
    const request = deferred();
    (part === "DefaultTone" ? actions.tone : actions.save).mockReturnValue(request.promise);
    const host = editor(part).submit().change(part === "DefaultTone" ? "lei" : "Testo nuovo");
    request.resolve({ ok: false, message: "Operazione non consentita.", refused: true });
    await host.settle();
    expect.soft(renderToStaticMarkup(host.tree)).toContain("Operazione non consentita.");
    expect(host.find((n) => typeof n.props.onChange === "function").props.value).toBe(part === "DefaultTone" ? "lei" : "Testo nuovo");
  });

  it.each(["DefaultTone", "TemplateEditor"] as const)("%s scarta solo gli errori di campo superati", async (part) => {
    const request = deferred();
    (part === "DefaultTone" ? actions.tone : actions.save).mockReturnValue(request.promise);
    const host = editor(part).submit().change(part === "DefaultTone" ? "lei" : "Testo nuovo");
    request.resolve({ ok: false, message: "Campo non valido.", fieldErrors: { [part === "DefaultTone" ? "defaultAddressing" : "body"]: "Campo non valido." } });
    await host.settle();
    expect(renderToStaticMarkup(host.tree)).not.toContain("Campo non valido.");
    expect(host.focused).toBeNull();
  });

  it("tono: il rifiuto generale riceve il focus, il rifiuto di campo va al select", async () => {
    const host = editor("DefaultTone");
    actions.tone.mockResolvedValueOnce({ ok: false, message: "Operazione non consentita." });
    await host.submit().settle();
    expect.soft(host.focused?.props.role).toBe("alert");
    expect.soft(host.focused?.props.tabIndex).toBe(-1);
    actions.tone.mockResolvedValueOnce({ ok: false, message: "Tono non valido.", fieldErrors: { defaultAddressing: "Tono non valido." } });
    await host.submit().settle();
    expect(host.focused?.type).toBe("select");
  });

  it("oltre 700: una sola descrizione collegata al campo prima e dopo Salva", () => {
    const host = editor("TemplateEditor", "a".repeat(701));
    for (const save of [false, true]) {
      if (save) host.submit();
      const html = renderToStaticMarkup(host.tree);
      expect.soft(html.match(/Il modello supera i 700 caratteri\./g)).toHaveLength(1);
      const field = host.find((n) => typeof n.props.onChange === "function");
      const ids = String(field.props["aria-describedby"]).split(" ");
      expect.soft(ids.some((id) => html.includes(`id="${id}">Il modello supera i 700 caratteri.`) || new RegExp(`id="${id}"[^>]*>Il modello supera i 700 caratteri\\.`).test(html))).toBe(true);
    }
  });

  it.each(["Testo personalizzato", "Ciao {nome}, ti confermo l'appuntamento{per_paziente} di {quando} alle {ora}, in {indirizzo}. Se hai un imprevisto, scrivimi pure qui. {osteopata}, {studio}"])("ripristino: il segnaposto segue il testo sostituito (%s)", async (body) => {
    const host = editor("TemplateEditor", body);
    host.change("Bozza diversa");
    const field = host.find((n) => typeof n.props.onSelect === "function");
    (field.props.onSelect as (event: unknown) => void)({ currentTarget: { selectionStart: 2, selectionEnd: 2 } });
    actions.restore.mockResolvedValue({ ok: true, data: undefined });
    const restore = host.find((n) => n.props.children === "Ripristina");
    (restore.props.onClick as () => void)();
    await host.settle();
    const restored = String(host.find((n) => typeof n.props.onSelect === "function").props.value);
    (host.find((n) => n.props["aria-label"] === "Inserisci {nome}").props.onClick as () => void)();
    host.render();
    expect(host.find((n) => typeof n.props.onSelect === "function").props.value).toBe(`${restored}{nome}`);
  });

  it("salvataggio senza sostituzione: conserva la selezione scelta nella bozza", async () => {
    const host = editor("TemplateEditor").change("Bozza nuova");
    (host.find((n) => typeof n.props.onSelect === "function").props.onSelect as (event: unknown) => void)({ currentTarget: { selectionStart: 2, selectionEnd: 2 } });
    actions.save.mockResolvedValue({ ok: true, data: undefined });
    await host.submit().settle();
    (host.find((n) => n.props["aria-label"] === "Inserisci {nome}").props.onClick as () => void)();
    host.render();
    expect(host.find((n) => typeof n.props.onSelect === "function").props.value).toBe("Bo{nome}zza nuova");
  });
});
