import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ConsentCollectDialog } from '@/components/consensi/collect-dialog';
import { ReminderRow } from '@/components/messaggi/reminder-row';
import { RecallActions } from '@/components/pazienti/recall-actions';
import { PatientHeaderBar } from '@/components/pazienti/patient-header';
import { SENT_QUESTION } from '@/lib/messages/texts';

const hooks = vi.hoisted(() => ({ active: null as null | { slots: unknown[]; cursor: number; changed: boolean; effects: (() => void)[] } }));
vi.mock('react', async original => {
  const react = await original<typeof import('react')>();
  const slot = () => {
    if (!hooks.active) throw new Error('Hook fuori dal render');
    return { host: hooks.active, index: hooks.active.cursor++ };
  };
  return { ...react,
    useState: (initial: unknown) => {
      const { host, index } = slot();
      if (!(index in host.slots)) host.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [host.slots[index], (next: unknown) => {
        const value = typeof next === 'function' ? next(host.slots[index]) : next;
        if (!Object.is(value, host.slots[index])) { host.slots[index] = value; host.changed = true; }
      }];
    },
    useRef: (initial: unknown) => { const { host, index } = slot(); return host.slots[index] ??= { current: initial }; },
    useEffect: (effect: () => void, deps: unknown[]) => {
      const { host, index } = slot();
      const before = host.slots[index] as unknown[] | undefined;
      if (!before || deps.some((dep, i) => !Object.is(dep, before[i]))) { host.effects.push(effect); host.slots[index] = deps; }
    },
    useId: () => 'probe-reminder',
    useEffectEvent: (fn: unknown) => fn,
    useTransition: () => [false, (fn: () => unknown) => fn()],
  };
});
const actions = vi.hoisted(() => ({ record: vi.fn(), prepare: vi.fn(), outcome: vi.fn(), recipient: vi.fn() }));
vi.mock('@/app/(app)/pazienti/[id]/message-actions', () => ({ recordMessageAction: actions.record, prepareMessageAction: actions.prepare, setMessageOutcomeAction: actions.outcome, messageRecipientAction: actions.recipient }));
vi.mock('@/app/(app)/pazienti/[id]/actions', () => ({ pauseRecallAction: vi.fn(), snoozeRecallAction: vi.fn() }));
vi.mock('@/components/agenda/appointment-dialog', () => ({ NewAppointmentButton: () => null }));
vi.mock('@/components/pazienti/patient-menu', () => ({ PatientMenu: () => null }));

type Props = Record<string, unknown>;
type Element = ReactElement<Props>;
class Host {
  slots: unknown[] = []; cursor = 0; changed = false; effects: (() => void)[] = []; tree: ReactNode;
  constructor(private element: Element) {}
  render() {
    do {
      this.changed = false; this.cursor = 0; hooks.active = this;
      try { this.tree = (this.element.type as (p: Props) => ReactNode)(this.element.props); } finally { hooks.active = null; }
    } while (this.changed);
    return this;
  }
  async flush() { for (const effect of this.effects.splice(0)) effect(); for (let n = 0; n < 8; n++) await Promise.resolve(); return this.render(); }
}
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!isValidElement<Props>(tree)) return [];
  return [tree, ...nodes(tree.props.children as ReactNode), ...nodes(tree.props.subtitle as ReactNode)];
}

const collection = vi.hoisted(() => ({ preview: vi.fn(), resolve: vi.fn(), upload: vi.fn() }));
vi.mock('@/app/(app)/pazienti/[id]/consent-actions', () => ({ consentPreviewAction: collection.preview, consentCollectionAction: collection.resolve, printConsentAction: vi.fn(), signConsentAction: vi.fn(), uploadConsentAction: collection.upload }));
vi.mock('@/components/consensi/signature-canvas', () => ({ SignatureCanvas: () => null }));
const listeners = new Map<string, () => void>();
beforeEach(() => {
  vi.clearAllMocks(); listeners.clear();
  vi.stubGlobal('window', { addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: vi.fn() });
});

const href = 'https://wa.me/?text=Promemoria';
const prepared = {
  source: { kind: 'appointment', appointmentId: 'a0000000-0000-4000-8000-000000000401', templateKey: 'promemoria' },
  patientId: 'a0000000-0000-4000-8000-000000000202', body: 'Promemoria', copyAllowed: true, copyDisabledReason: null,
  whatsappHref: href, recipient: { phone: '+393330000001', whatsappDisabledReason: null, isDemo: true },
};
const anchor = (host: Host) => nodes(host.tree).find(n => n.type === 'a' && typeof n.props.href === 'string' && n.props.href.startsWith('https://wa.me/'));
const copy = (host: Host) => nodes(host.tree).find(n => n.props.children === 'Copia');
function reminder() {
  return new Host(createElement(ReminderRow, { value: { prepared, lastMessage: null, statusText: 'Da inviare' } as never }) as Element).render();
}
function contactHost(surface: string) {
  if (surface === 'reminder') return reminder();
  if (surface === 'recall') {
    const row = { patientId: prepared.patientId, name: 'Ada Prova', contact: { ...prepared, source: { kind: 'recall', patientId: prepared.patientId, templateKey: 'richiamo' } } };
    return child(new Host(createElement(RecallActions, { row: row as never, booking: {} as never }) as Element).render(), 'ContactActions');
  }
  return new Host(createElement(PatientHeaderBar, { header: { id: prepared.patientId, name: 'Ada Prova', ageText: '18 anni', phone: null, phoneText: null, messageRecipient: prepared.recipient, labels: [], badges: [], clinicalAlert: null, screeningText: null } as never, booking: {} as never }) as Element).render();
}

it.each(['reminder', 'recall'])('%s: un rifiuto nasconde subito il vecchio link e la copia, poi rilegge i permessi', async surface => {
  actions.record.mockResolvedValue({ ok: false, refused: true, message: 'Manca il consenso WhatsApp' });
  let resolve!: (value: unknown) => void;
  actions.prepare.mockReturnValue(new Promise(r => { resolve = r; }));
  const host = await contactHost(surface).flush();
  expect(anchor(host)).toBeDefined();
  (anchor(host)!.props.onClick as () => void)();
  await host.flush();
  expect(anchor(host)).toBeUndefined();
  expect(copy(host)).toBeUndefined();
  expect(actions.prepare).toHaveBeenCalledWith(surface === 'reminder' ? prepared.source : { kind: 'recall', patientId: prepared.patientId, templateKey: 'richiamo' });
  resolve({ ok: true, data: { ...prepared, whatsappHref: null, copyAllowed: surface === 'reminder', recipient: { ...prepared.recipient, whatsappDisabledReason: 'Manca il consenso WhatsApp' } } });
  await host.flush();
  expect(anchor(host)).toBeUndefined();
  expect(copy(host)?.props.disabled).toBe(surface === 'recall');
});

it.each(['reminder', 'recall', 'header'].flatMap(surface => ['focus', 'visibilitychange'].map(event => ({ surface, event }))))('$surface: al $event sospende le azioni fino alla rilettura', async ({ surface, event }) => {
  let resolve!: (value: unknown) => void;
  actions.prepare.mockReturnValue(new Promise(r => { resolve = r; }));
  if (surface === 'header') actions.recipient.mockReturnValue(new Promise(r => { resolve = r; }));
  const host = await contactHost(surface).flush();
  listeners.get(event)?.();
  host.render();
  expect(anchor(host)).toBeUndefined();
  expect(copy(host)).toBeUndefined();
  if (surface === 'header') expect(actions.recipient).toHaveBeenCalledWith(prepared.patientId);
  else expect(actions.prepare).toHaveBeenCalledOnce();
  resolve({ ok: true, data: surface === 'header' ? prepared.recipient : prepared });
  await host.flush();
  expect(anchor(host)?.props).toMatchObject({ target: '_blank', rel: 'noopener', href: surface === 'header' ? 'https://wa.me/?text=' : href });
});

function child(host: Host, name: string) {
  const element = nodes(host.tree).find(n => typeof n.type === 'function' && n.type.name === name);
  if (!element) throw new Error(`Componente ${name} non trovato`);
  return new Host(element).render();
}

it('carta mostra modulo storico e genitori prima della conferma, tela torna al modulo di oggi', async () => {
  const target = { patientId: prepared.patientId, appointmentId: null, guardianId: null, cycleId: prepared.source.appointmentId, moduleKey: 'trattamento' as const };
  const initial = { target, signerName: 'Ada Prova', signerKind: 'paziente', rendered: { text: 'Modulo adulto', missingFields: [] }, missingLinks: [], hash: 'a'.repeat(64), minorOpinionDefault: null };
  const historical = { ...initial, target: { ...target, moduleKey: 'trattamento_minore', guardianId: 'a0000000-0000-4000-8000-000000000205' }, signerName: 'Elena Prova', signerKind: 'genitore', rendered: { text: 'Modulo minore', missingFields: [] } };
  collection.preview.mockResolvedValue({ ok: true, data: initial });
  collection.resolve.mockImplementation(async (_target, day) => ({ ok: true, data: { target: day ? historical.target : target, preview: day ? historical : initial, guardians: day ? [{ id: historical.target.guardianId, name: 'Elena Prova' }] : [], problem: null } }));
  const root = new Host(createElement(ConsentCollectDialog, { target, onClose: vi.fn() }) as Element).render();
  const body = await child(root, 'CollectBody').flush();
  const host = child(body, 'CollectForm');
  await host.flush();
  const mode = () => nodes(host.tree).find(n => n.props.value === 'tela' && typeof n.props.onValueChange === 'function')!;
  (mode().props.onValueChange as (v: string) => void)('carta');
  host.render();
  const date = nodes(host.tree).find(n => n.props.type === 'date')!;
  (date.props.onChange as (e: unknown) => void)({ target: { value: '2026-11-02' } });
  await host.flush(); await host.flush();
  expect(collection.resolve).toHaveBeenCalledWith(target, '2026-11-02', undefined);
  expect(nodes(host.tree).some(n => n.props.children === 'Modulo minore')).toBe(true);
  expect(nodes(host.tree).some(n => n.type === 'select' && n.props.value === historical.target.guardianId)).toBe(true);
  expect(nodes(host.tree).some(n => n.props.children === "Voce del minore")).toBe(true);
  const modeNow = nodes(host.tree).find(n => n.props.value === 'carta' && typeof n.props.onValueChange === 'function')!;
  (modeNow.props.onValueChange as (v: string) => void)('tela');
  await host.flush(); await host.flush();
  expect(nodes(host.tree).some(n => n.props.children === 'Modulo adulto')).toBe(true);
  expect(nodes(host.tree).some(n => n.type === 'select')).toBe(false);
});


const GUARDIAN_A = 'a0000000-0000-4000-8000-000000000205';
const GUARDIAN_B = 'a0000000-0000-4000-8000-000000000206';
const minorTarget = { patientId: prepared.patientId, appointmentId: null, guardianId: GUARDIAN_A, cycleId: prepared.source.appointmentId, moduleKey: 'trattamento_minore' as const };
const minorPreview = { target: minorTarget, signerName: 'Elena Prova', signerKind: 'genitore', rendered: { text: 'Modulo minore', missingFields: [] }, missingLinks: [], hash: 'b'.repeat(64), minorOpinionDefault: null as string | null };
async function openForm(target: unknown) {
  const root = new Host(createElement(ConsentCollectDialog, { target: target as never, onClose: vi.fn() }) as Element).render();
  const body = await child(root, 'CollectBody').flush();
  const host = child(body, 'CollectForm');
  return host.flush();
}
const field = (host: Host, id: string) => nodes(host.tree).find(n => n.props.id === `probe-reminder-${id}`)!;
async function paperWithDate(host: Host, day: string) {
  (nodes(host.tree).find(n => n.props.value === 'tela' && typeof n.props.onValueChange === 'function')!.props.onValueChange as (v: string) => void)('carta');
  await host.flush(); await host.flush();
  (field(host, 'signedOn').props.onChange as (e: unknown) => void)({ target: { value: day } });
  await host.flush(); await host.flush();
}

it.each([
  { name: 'stesso modulo e stesso firmatario', atDay: minorPreview },
  { name: 'minore oggi e minore alla data, con firmatario e voce predefinita diversi', atDay: { ...minorPreview, target: { ...minorTarget, guardianId: GUARDIAN_B }, signerName: 'Marco Prova', minorOpinionDefault: "Non applicabile per l'età" } },
])('la «Voce del minore» scritta resta dopo carta e data ($name)', async ({ atDay }) => {
  collection.preview.mockResolvedValue({ ok: true, data: minorPreview });
  collection.resolve.mockImplementation(async (_target, day) => {
    const shown = day ? atDay : minorPreview;
    return { ok: true, data: { target: shown.target, preview: shown, guardians: [{ id: shown.target.guardianId, name: shown.signerName }], problem: null } };
  });
  const host = await openForm(minorTarget);
  (field(host, 'minorOpinionNote').props.onChange as (e: unknown) => void)({ target: { value: 'Non vuole le manipolazioni cervicali' } });
  host.render();
  await paperWithDate(host, '2026-11-02');
  expect(collection.resolve).toHaveBeenCalledWith(minorTarget, '2026-11-02', undefined);
  expect(nodes(host.tree).some(n => n.props.children === atDay.signerName || n.props.value === atDay.signerName)).toBe(true);
  expect(field(host, 'minorOpinionNote').props.value).toBe('Non vuole le manipolazioni cervicali');
});

it('su carta il modulo caricato parte col modulo del minore e il genitore scelto', async () => {
  const target = { ...minorTarget, guardianId: null, moduleKey: 'trattamento' as const };
  const adult = { ...minorPreview, target, signerName: 'Ada Prova', signerKind: 'paziente', rendered: { text: 'Modulo adulto', missingFields: [] }, hash: 'a'.repeat(64) };
  const atDay = (guardianId: string) => ({ ...minorPreview, target: { ...minorTarget, guardianId }, signerName: guardianId === GUARDIAN_B ? 'Marco Prova' : 'Elena Prova', hash: guardianId.slice(-1).repeat(64) });
  collection.preview.mockImplementation(async (asked: typeof minorTarget, day?: string) => ({ ok: true, data: day ? atDay(asked.guardianId) : adult }));
  collection.resolve.mockImplementation(async (_target, day, guardian?: string) => {
    const shown = day ? atDay(guardian ?? GUARDIAN_A) : adult;
    return { ok: true, data: { target: shown.target, preview: shown, guardians: day ? [{ id: GUARDIAN_A, name: 'Elena Prova' }, { id: GUARDIAN_B, name: 'Marco Prova' }] : [], problem: null } };
  });
  collection.upload.mockResolvedValue({ ok: true, data: { id: 'c0000000-0000-4000-8000-000000000001' } });
  const host = await openForm(target);
  await paperWithDate(host, '2026-11-02');
  (field(host, 'guardian').props.onChange as (e: unknown) => void)({ target: { value: GUARDIAN_B } });
  await host.flush(); await host.flush();
  (field(host, 'document').props.onChange as (e: unknown) => void)({ target: { files: [new File(['%PDF-1.4'], 'modulo.pdf', { type: 'application/pdf' })] } });
  host.render();
  const declaration = nodes(host.tree).find(n => Array.isArray(n.props.children) && (n.props.children as unknown[]).some(c => typeof c === 'string' && c.startsWith('Io sottoscritto/a')))!;
  const checkbox = nodes(declaration.props.children as ReactNode).find(n => typeof n.props.onCheckedChange === 'function')!;
  (checkbox.props.onCheckedChange as (v: boolean) => void)(true);
  host.render();
  (nodes(host.tree).find(n => n.type === 'form')!.props.onSubmit as (e: unknown) => void)({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  await host.flush();
  expect(collection.upload).toHaveBeenCalledOnce();
  const body = collection.upload.mock.calls[0]?.[0] as FormData;
  expect(JSON.parse(body.get('fields') as string)).toMatchObject({ moduleKey: 'trattamento_minore', guardianId: GUARDIAN_B, signerName: 'Marco Prova', singleGuardianDeclaration: true, previewHash: GUARDIAN_B.slice(-1).repeat(64) });
  expect(body.get('signedOn')).toBe('2026-11-02');
});

const headerReason = (host: Host) => nodes(host.tree).find(n => n.type === 'span' && n.props.id === 'probe-reminder')?.props.children;
it.each(['pending', 'failed'])('testata: durante la rilettura (%s) non scrive «Numero mancante» e il pulsante resta disattivato', async state => {
  const recipient = { ...prepared.recipient, isDemo: false, kind: 'paziente', name: 'Ada Prova' };
  if (state === 'pending') actions.recipient.mockReturnValue(new Promise(() => {}));
  else actions.recipient.mockRejectedValue(new Error('rete'));
  const host = await new Host(createElement(PatientHeaderBar, { header: { id: prepared.patientId, name: 'Ada Prova', ageText: '30 anni', phone: recipient.phone, phoneText: '333 000 0001', messageRecipient: recipient, labels: [], badges: [], clinicalAlert: null, screeningText: null } as never, booking: {} as never }) as Element).render().flush();
  expect(anchor(host)).toBeDefined();
  listeners.get('focus')?.();
  await host.flush();
  expect(anchor(host)).toBeUndefined();
  expect(headerReason(host)).toBeUndefined();
  expect(nodes(host.tree).some(n => n.props.children === 'Numero mancante')).toBe(false);
  const button = nodes(host.tree).find(n => n.props.children === 'Apri WhatsApp' && n.type !== 'a')!;
  expect(button.props.disabled).toBe(true);
  expect(button.props['aria-describedby']).toBeUndefined();
});

it('richiamo: durante la rilettura nasconde link e copia ma tiene «Hai inviato il messaggio?»', async () => {
  actions.record.mockResolvedValue({ ok: true, data: null });
  const host = await contactHost('recall').flush();
  (anchor(host)!.props.onClick as () => void)();
  await host.flush();
  expect(nodes(host.tree).some(n => n.props.children === SENT_QUESTION)).toBe(true);
  actions.prepare.mockReturnValue(new Promise(() => {}));
  listeners.get('focus')?.();
  await host.flush();
  expect(anchor(host)).toBeUndefined();
  expect(copy(host)).toBeUndefined();
  expect(nodes(host.tree).some(n => n.props.children === SENT_QUESTION)).toBe(true);
});
