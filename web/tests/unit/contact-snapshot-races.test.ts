import { beforeEach, expect, it, vi } from "vitest";
import { useContactSnapshot } from "@/components/messaggi/use-contact-snapshot";

// Hook reale con slot persistenti, come il probe UI; niente DOM o chiamate esterne.
const host = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, changed: false, effects: [] as (() => void)[] }));
vi.mock("react", () => ({
  useEffectEvent: (fn: unknown) => fn,
  useState: (initial: unknown) => {
    const index = host.cursor++;
    if (!(index in host.slots)) host.slots[index] = initial;
    return [host.slots[index], (next: unknown) => {
      host.slots[index] = typeof next === "function" ? next(host.slots[index]) : next;
      host.changed = true;
    }];
  },
  useRef: (initial: unknown) => host.slots[host.cursor++] ??= { current: initial },
  useEffect: (fn: () => void) => {
    const index = host.cursor++;
    if (!(index in host.slots)) { host.slots[index] = true; host.effects.push(fn); }
  },
}));

type Contact = { href: string | null };
const allowed = { href: "https://wa.me/?text=Prova" };
const denied = { href: null };
beforeEach(() => {
  host.slots = []; host.cursor = 0; host.effects = [];
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
function deferred() {
  let resolve!: (value: { ok: true; data: Contact }) => void;
  return { promise: new Promise<{ ok: true; data: Contact }>(r => { resolve = r; }), resolve: (data: Contact) => resolve({ ok: true, data }) };
}
function ContactProbe(initial: Contact, read: () => Promise<{ ok: true; data: Contact }>) {
  return useContactSnapshot("same-patient", initial, read);
}
function render(initial: Contact, read: () => Promise<{ ok: true; data: Contact }>) {
  let result!: ReturnType<typeof useContactSnapshot<Contact>>;
  do {
    host.changed = false; host.cursor = 0;
    result = ContactProbe(initial, read);
  } while (host.changed);
  for (const effect of host.effects.splice(0)) effect();
  return result;
}

it("una nuova fotografia della pagina durante la rilettura non ripristina il link revocato", async () => {
  const request = deferred();
  const read = () => request.promise;
  const first = render(allowed, read);
  first.refresh();
  const stalePage = { ...allowed };
  expect(render(stalePage, read).snapshot).toBeNull();
  request.resolve(denied);
  await Promise.resolve();
  expect(render(stalePage, read).snapshot).toEqual(denied);
});

it("una risposta superata non ripristina un destinatario precedente", async () => {
  const old = deferred();
  const fresh = deferred();
  const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const state = render(allowed, read);
  state.refresh(); state.refresh();
  fresh.resolve(denied);
  await Promise.resolve();
  expect(render(allowed, read).snapshot).toEqual(denied);
  old.resolve(allowed);
  await Promise.resolve();
  expect(render(allowed, read).snapshot).toEqual(denied);
});
