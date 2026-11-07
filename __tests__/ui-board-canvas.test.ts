import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReviewBoardView from '../ui/src/views/ReviewBoardView.svelte';
import { setGraphAdapter, type GraphAdapter, type SourceRequest } from '../ui/src/lib/adapter';
import { boardRequests } from '../ui/src/lib/board-requests.svelte';
import type { BoardSymbol } from '../ui/src/lib/board-model';
import { edgeKinds, relationColor, relationLabel } from '../ui/src/lib/board-catalog';
import type { BoardConnections, BoardConnectionRequest, BoardDocument, BoardExclusions, BoardLoaded, BoardSnapshot, SaveBoardRequest } from '../ui/src/lib/board-wire';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const noExclusions: BoardExclusions = { symbols: { tests: 0, generated: 0, uncertain: 0 }, relations: { tests: 0, generated: 0, uncertain: 0 } };
const a: BoardSymbol = { id: 'a', name: 'Alpha', qualifiedName: 'Alpha', kind: 'class', file: 'a.ts', line: 1, endLine: 100, memberCount: 12 };
const b: BoardSymbol = { id: 'b', name: 'Beta', qualifiedName: 'Beta', kind: 'function', file: 'b.ts', line: 2, endLine: 4, memberCount: 0 };
const children = Array.from({ length: 12 }, (_, index): BoardSymbol => ({ ...b, id: `m${index}`, name: `member${index}`,
  qualifiedName: `Alpha.member${index}`, kind: 'method', file: a.file, line: index + 2, endLine: index + 2, ownerId: a.id }));
const edge = { id: 'reference', source: a.id, target: b.id, kind: 'references', file: a.file, line: 2, col: 0 };
function documentFor(symbol: BoardSymbol): BoardDocument {
  return { version: 1, symbols: [{ key: 's0', identity: { id: symbol.id, qualifiedName: symbol.qualifiedName, kind: symbol.kind, file: symbol.file },
    position: { x: 91, y: 72 }, included: true, hidden: false, expanded: false }], cards: [],
    viewport: { x: 0, y: 0, zoom: 1 }, filters: { kind: '', showStructure: false } };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let host: HTMLDivElement;
let mounted: Record<string, unknown>;
let facts: BoardSymbol[];
let exclusions: BoardExclusions | undefined;
let records: Map<string, { name: string; document: BoardDocument }>;
function loaded(document: BoardDocument): BoardLoaded {
  return { board: clone(document), symbols: clone(facts), readOnly: false, resolutions: document.symbols.map((entry) => {
    const matches = facts.filter((item) => item.qualifiedName === entry.identity.qualifiedName && item.kind === entry.identity.kind && item.file === entry.identity.file && item.signature === entry.identity.signature);
    const node = matches.length === 1 ? clone(matches[0]) : null;
    return { key: entry.key, status: node ? node.id === entry.identity.id ? 'ok' : 'moved' : matches.length > 1 ? 'ambiguous' : 'missing', node, note: null };
  }) };
}
function snapshot(ids: readonly string[]): BoardSnapshot {
  return { symbols: clone(facts), included: [...ids], scopeIds: [...ids, ...facts.filter((item) => item.ownerId && ids.includes(item.ownerId)).map((item) => item.id)],
    missing: [], relations: [], nodeKinds: [], edgeKinds: ['calls', 'references'], bounded: false, notes: [], ...(exclusions ? { excluded: clone(exclusions) } : {}) };
}
function connections(request: BoardConnectionRequest): BoardConnections {
  return { scope: clone(facts.find((item) => item.id === request.id)!), direction: request.direction, withMembers: request.members,
    symbols: clone(facts), items: request.id === a.id ? [{ target: clone(b), evidence: [edge], total: 2 }] : [],
    total: request.id === a.id ? 2 : 0, nextOffset: request.id === a.id ? 1 : null, bounded: false, notes: [], excluded: noExclusions };
}
function mocks() {
  return {
    board: vi.fn(async (ids: readonly string[]) => snapshot(ids)),
    boardSearch: vi.fn(async () => ({ items: clone(facts), symbols: clone(facts), total: facts.length, nextOffset: null, bounded: false })),
    boardConnections: vi.fn(async (request: BoardConnectionRequest) => connections(request)),
    boardEvidence: vi.fn(async (_request: BoardConnectionRequest) => ({ symbols: clone(facts), items: [{ ...edge, id: 'reference-two' }], total: 2, nextOffset: null, bounded: false, notes: [] })),
    boardSiblingSources: vi.fn(async (request: { id: string }) => {
      const origin = facts.find((item) => item.id === request.id)!;
      const items = facts.filter((item) => item.id !== origin.id && item.kind === origin.kind && item.ownerId === origin.ownerId && item.file === origin.file);
      return { symbols: clone(facts), items: clone(items), total: items.length, nextOffset: null, bounded: false, notes: [], excluded: clone(noExclusions) };
    }),
    boardMembers: vi.fn(async (request: { id: string }) => {
      const items = facts.filter((item) => item.ownerId === request.id);
      return { symbols: clone(facts), items: clone(items), total: items.length, nextOffset: null, bounded: false, notes: [] };
    }),
    boards: vi.fn(async () => ({ boards: [...records].map(([id, value]) => ({ id, name: value.name, updatedAt: 'now' })),
      readOnly: false, readOnlyReason: null, directory: '.codegraph/ui/boards', skipped: 0, bounded: false })),
    loadBoard: vi.fn(async (id: string) => loaded(records.get(id)!.document)),
    resolveBoard: vi.fn(async (document: BoardDocument) => loaded(document)),
    saveBoard: vi.fn(async (request: SaveBoardRequest) => {
      const id = request.id ?? 'new'; records.set(id, { name: request.name, document: clone(request.document) });
      return { id, name: request.name, updatedAt: 'now' };
    }),
    deleteBoard: vi.fn(async (id: string) => { records.delete(id); return { deleted: id }; }),
    nodes: vi.fn(async (ids: readonly string[]) => ({ items: clone(facts.filter((item) => ids.includes(item.id))), missing: [] })),
    source: vi.fn(async (request: SourceRequest) => ({ file: request.file, language: 'typescript', drift: false, showing: 'indexed',
      contentHash: 'matching', indexedAt: 1, generated: false, totalLines: 100, from: request.from, to: request.from, lines: ['// source'] })),
  };
}
let calls: ReturnType<typeof mocks>;
async function settle() { for (let turn = 0; turn < 6; turn++) { await new Promise((resolve) => setTimeout(resolve, 0)); flushSync(); } }
function button(label: string, scope: ParentNode = host): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label);
  if (!found) throw new Error(`Missing button: ${label}`); return found;
}
async function click(label: string) { button(label).click(); await settle(); }
function input(label: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); flushSync();
}
function deleteRow(name: string) {
  const row = [...host.querySelectorAll('[aria-label="Saved boards"] .result')].find((item) => item.querySelector('strong')?.textContent === name)!;
  button('Delete', row).click();
}
async function render() { mounted = mount(ReviewBoardView, { target: host }); await settle(); }
async function open(name = 'Alpha review') { await click('Saved boards'); await click(`Open ${name}`); }
async function moveCard(id: string) {
  const node = host.querySelector<HTMLElement>(`.svelte-flow__node[data-id="${id}"]`)!;
  node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); await settle();
  const before = node.style.transform;
  node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true })); await settle();
  expect(node.style.transform).not.toBe(before);
}
function identityGeometry(document: BoardDocument) {
  const identity = (value: BoardDocument['symbols'][number]['identity']) => JSON.stringify([value.qualifiedName, value.kind, value.file, value.signature ?? null]);
  const byKey = new Map(document.symbols.map((item) => [item.key, identity(item.identity)]));
  return { symbols: document.symbols.map(({ key, identity: value, ...presentation }) => ({ identity: identity(value), ...presentation })).sort((a, b) => a.identity.localeCompare(b.identity)),
    cards: document.cards.map(({ key, symbolKey, ...presentation }) => ({ identity: byKey.get(symbolKey), ...presentation })).sort((a, b) => a.identity!.localeCompare(b.identity!)),
    viewport: document.viewport, filters: { ...document.filters, includeTests: document.filters.includeTests ?? false, includeGenerated: document.filters.includeGenerated ?? false, includeUncertain: document.filters.includeUncertain ?? false } };
}

beforeAll(() => {
  class NoopObserver { observe() {} unobserve() {} disconnect() {} }
  const globals = globalThis as Record<string, unknown>;
  globals.ResizeObserver ??= NoopObserver; globals.IntersectionObserver ??= NoopObserver;
  globals.requestAnimationFrame ??= (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0);
  globals.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
  (window as unknown as Record<string, unknown>).DOMMatrixReadOnly ??= class { readonly m22 = 1; };
  const media = (query: string) => ({ media: query, matches: false, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: media }); globals.matchMedia = media;
  globals.CSS ??= { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`) };
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host);
  facts = clone([a, b, ...children]); exclusions = clone(noExclusions); boardRequests.take();
  records = new Map([['a', { name: 'Alpha review', document: documentFor(a) }], ['b', { name: 'Beta review', document: documentFor(b) }]]);
  calls = mocks(); setGraphAdapter(calls as unknown as GraphAdapter); vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(async () => { if (mounted) await unmount(mounted); host.remove(); boardRequests.take(); setGraphAdapter(null); vi.restoreAllMocks(); });

describe('Board pointer interactions and placement', () => {
  const bounds = { x: 100, y: 200, left: 100, top: 200, right: 1100, bottom: 900, width: 1000, height: 700, toJSON() {} };
  const view = { x: 80, y: -40, zoom: 0.8 };
  function node(id: string) { return host.querySelector<HTMLElement>(`.svelte-flow__node[data-id="${id}"]`)!; }
  function selectedIds() { return [...host.querySelectorAll<HTMLElement>('.svelte-flow__node.selected')].map((item) => item.dataset.id).sort(); }
  function mouse(type: string, init: MouseEventInit) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    // Vitest's global Window proxy fails jsdom's constructor brand check; d3 needs event.view.
    Object.defineProperty(event, 'view', { value: window });
    return event;
  }
  function pointer(target: EventTarget, type: string, x: number, y: number, shift = false, button = 0) {
    const event = mouse(type, { clientX: x, clientY: y, shiftKey: shift, button, buttons: type === 'pointerup' ? 0 : button === 2 ? 2 : 1 });
    Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
    target.dispatchEvent(event);
  }
  async function marquee(from: [number, number], to: [number, number], shift = false) {
    const pane = host.querySelector('.svelte-flow__pane')!;
    pointer(pane, 'pointerdown', ...from, shift); await settle();
    pointer(pane, 'pointermove', ...to, shift); await settle();
    pointer(pane, 'pointerup', ...to, shift); await settle();
  }
  async function cardClick(id: string, shift = false) {
    if (shift) { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', shiftKey: true })); await settle(); }
    node(id).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: shift, detail: 1 })); await settle();
    if (shift) { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft' })); await settle(); }
  }
  async function savedState() {
    input('Board name', 'Pointer review'); await click('Save');
    return calls.saveBoard.mock.calls.at(-1)![0].document;
  }
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: (entries: { target: Element }[]) => void) {}
      observe(target: Element) { if (target.hasAttribute('data-id')) queueMicrotask(() => { if (target.isConnected) this.callback([{ target }]); }); }
      unobserve() {} disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () { return this.classList.contains('svelte-flow__node-code') ? 530 : 286; });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () { return this.classList.contains('svelte-flow__node-code') ? 310 : 160; });
    const recipe = documentFor(a); recipe.viewport = { ...view }; recipe.symbols[0].position = { x: 50, y: 50 };
    recipe.symbols.push({ ...documentFor(b).symbols[0], key: 's1', position: { x: 500, y: 300 } });
    records.get('a')!.document = recipe;
  });

  afterEach(() => vi.unstubAllGlobals());

  it('toggles mixed card selections with Shift, replaces on plain click, and moves the selected group', async () => {
    await render(); await open(); await click('Open Alpha source');
    expect(selectedIds()).toEqual(['code:a']);
    await cardClick('a', true); expect(selectedIds()).toEqual(['a', 'code:a']);
    await cardClick('a', true); expect(selectedIds()).toEqual(['code:a']);
    await cardClick('b', true); expect(selectedIds()).toEqual(['b', 'code:a']);
    const before = [node('b').style.transform, node('code:a').style.transform, node('a').style.transform];
    node('b').querySelector('header')!.dispatchEvent(mouse('mousedown', { button: 0, buttons: 1, clientX: 600, clientY: 520 }));
    window.dispatchEvent(mouse('mousemove', { button: 0, buttons: 1, clientX: 605, clientY: 525 })); await settle();
    window.dispatchEvent(mouse('mousemove', { button: 0, buttons: 1, clientX: 650, clientY: 545 })); await settle();
    window.dispatchEvent(mouse('mouseup', { button: 0, clientX: 650, clientY: 545 })); await settle();
    expect(selectedIds()).toEqual(['b', 'code:a']);
    expect(node('b').style.transform).not.toBe(before[0]); expect(node('code:a').style.transform).not.toBe(before[1]); expect(node('a').style.transform).toBe(before[2]);
    // d3 suppresses the click immediately following a drag until the next task.
    await settle(); await cardClick('b'); expect(selectedIds()).toEqual(['b']);
  });

  it('selects touched cards with a rectangle, adds with Shift, and clears on empty click without panning', async () => {
    const initialView = { x: 0, y: 0, zoom: 1 }; records.get('a')!.document.viewport = initialView;
    await render(); await open();
    // Alpha starts at screen (150, 250); select just a small corner, not its whole bounds.
    await marquee([140, 240], [160, 260]); expect(selectedIds()).toEqual(['a']);
    await marquee([590, 490], [610, 510], true); expect(selectedIds()).toEqual(['a', 'b']);
    await marquee([590, 490], [610, 510]); expect(selectedIds()).toEqual(['b']);
    await marquee([800, 600], [900, 600], true); expect(selectedIds()).toEqual(['b']);
    await marquee([800, 600], [800, 700]); expect(selectedIds()).toEqual([]);
    await marquee([1000, 800], [1000, 800]); expect(selectedIds()).toEqual([]);
    expect((await savedState()).viewport).toEqual(initialView);
    expect(host.querySelector('[aria-label="Relationship evidence"]')).toBeNull();
  });

  it('removes the marquee on release and retains enclosed and touched cards', async () => {
    records.get('a')!.document.viewport = { x: 0, y: 0, zoom: 1 };
    await render(); await open();
    const pane = host.querySelector('.svelte-flow__pane')!;
    // Enclose Alpha entirely and touch only Beta's top-left corner.
    pointer(pane, 'pointerdown', 140, 240); await settle();
    pointer(pane, 'pointermove', 610, 510); await settle();
    const marquee = host.querySelector<HTMLElement>('.svelte-flow__selection')!;
    expect(marquee).not.toBeNull();
    pointer(pane, 'pointerup', 610, 510); await settle();
    expect(selectedIds()).toEqual(['a', 'b']);
    expect(marquee.isConnected).toBe(false);
    expect(host.querySelector('.svelte-flow__selection')).toBeNull();
    expect(host.querySelector('.svelte-flow__selection-wrapper')).toBeNull();
  });

  it('pans with the right mouse button on empty canvas but not on cards', async () => {
    const initialView = { x: 0, y: 0, zoom: 1 }; records.get('a')!.document.viewport = initialView;
    await render(); await open();
    async function drag(target: Element) {
      target.dispatchEvent(mouse('mousedown', { button: 2, buttons: 2, clientX: 700, clientY: 500 }));
      window.dispatchEvent(mouse('mousemove', { button: 2, buttons: 2, clientX: 760, clientY: 530 }));
      window.dispatchEvent(mouse('mouseup', { button: 2, clientX: 760, clientY: 530 })); await settle();
    }
    await drag(node('a').querySelector('header')!); expect((await savedState()).viewport).toEqual(initialView);
    await drag(host.querySelector('.svelte-flow__pane')!);
    expect((await savedState()).viewport).toEqual({ x: 60, y: 30, zoom: 1 });
  });

  it('opens direct source actions at the click under pan/zoom, preserves the viewport, and raises existing cards in place', async () => {
    await render(); await open();
    button('Open Alpha source').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 620, clientY: 440 })); await settle();
    let recipe = await savedState();
    expect(recipe.cards[0].position).toEqual({ x: 565, y: 365 }); expect(recipe.viewport).toEqual(view);
    expect(selectedIds()).toEqual(['code:a']);
    const firstZ = recipe.cards[0].zIndex;
    button('Open Beta source').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 620, clientY: 440 })); await settle();
    recipe = await savedState(); expect(recipe.cards[1].position).toEqual(recipe.cards[0].position); // overlap is deliberate
    button('Open Alpha source').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 900, clientY: 800 })); await settle();
    recipe = await savedState(); expect(recipe.cards).toHaveLength(2); expect(recipe.cards[0].position).toEqual({ x: 565, y: 365 });
    expect(recipe.cards[0].zIndex).toBeGreaterThan(firstZ); expect(selectedIds()).toEqual(['code:a']); expect(recipe.viewport).toEqual(view);
  });

  it('uses the pin click rather than a restored source-only placeholder position', async () => {
    const recipe = records.get('a')!.document; recipe.symbols[0].expanded = true;
    recipe.symbols.push({ ...documentFor(children[0]).symbols[0], key: 'member', included: false, position: { x: 30, y: 30 } });
    recipe.cards.push({ key: 'code-member', symbolKey: 'member', position: { x: 800, y: 600 }, width: 530, height: 310, collapsed: false, zIndex: 12 });
    await render(); await open();
    button('Pin Alpha.member0 separately').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 620, clientY: 440 })); await settle();
    const saved = await savedState();
    expect(saved.symbols.find((item) => item.identity.id === 'm0')).toMatchObject({ included: true, position: { x: 565, y: 365 } });
    expect(saved.cards[0].position).toEqual({ x: 800, y: 600 }); expect(saved.viewport).toEqual(view);
  });

  it('keeps pan and zoom when accepting Add to board from another reader', async () => {
    await render(); await open(); boardRequests.enqueue(['m0']); await settle();
    const saved = await savedState();
    expect(saved.symbols.find((item) => item.identity.id === 'm0')?.included).toBe(true);
    expect(saved.viewport).toEqual(view);
  });

  it('follows a source card target at the click without reselecting the origin or moving the viewport', async () => {
    await render(); await open(); await click('Open Alpha source');
    host.querySelector<HTMLButtonElement>('.target-link')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 620, clientY: 440 })); await settle();
    const saved = await savedState();
    expect(saved.cards).toHaveLength(2); expect(saved.cards[1].position).toEqual({ x: 565, y: 365 });
    expect(selectedIds()).toEqual(['code:b']); expect(saved.viewport).toEqual(view);
  });

  it('keeps keyboard source-link activation centered and selects the opened card, not its origin', async () => {
    calls.boardConnections.mockResolvedValue({ ...connections({ id: 'a', direction: 'outgoing', members: true }),
      total: 1, nextOffset: null, items: [{ target: b, evidence: [edge], total: 1 }] });
    calls.source.mockImplementation(async (request) => ({ file: request.file, language: 'typescript', drift: false, showing: 'indexed',
      contentHash: 'matching', indexedAt: 1, generated: false, totalLines: 100, from: 1, to: 2, lines: ['// source', 'Beta();'] }));
    await render(); await open(); await click('Open Alpha source');
    const ref = host.querySelector<HTMLElement>('.source [role="link"]')!; expect(ref).not.toBeNull();
    ref.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle();
    const saved = await savedState(); expect(saved.cards).toHaveLength(2);
    expect(selectedIds()).toEqual(['code:b']); expect(saved.cards[1].position).toEqual({ x: 260, y: 332.5 }); expect(saved.viewport).toEqual(view);
  });

  it('opens sibling source cards without pinning, moving existing cards, changing the viewport or duplicating cards', async () => {
    await render(); await open(); await click('Expand Alpha members');
    await click('Open Alpha.member0 source');
    const before = await savedState();
    await click('Open sibling sources for member0');
    const after = await savedState();
    expect(after.cards).toHaveLength(children.length);
    expect(after.symbols.filter((item) => item.included)).toEqual(before.symbols.filter((item) => item.included));
    expect(after.cards[0].position).toEqual(before.cards[0].position);
    expect(after.viewport).toEqual(before.viewport);
    const byKey = new Map(after.symbols.map((item) => [item.key, item.identity.id]));
    expect(after.cards.map((item) => byKey.get(item.symbolKey)).sort()).toEqual(children.map((item) => item.id).sort());
    await click('Open sibling sources for member0');
    expect((await savedState()).cards).toHaveLength(children.length);
  });

  it('opens no sibling prefix when the full batch exceeds source-card capacity', async () => {
    await render(); await open(); await click('Expand Alpha members'); await click('Open Alpha.member0 source');
    calls.boardSiblingSources.mockResolvedValueOnce({ symbols: clone(facts), items: clone(children), total: 40, nextOffset: 12, bounded: false, notes: [], excluded: noExclusions });
    await click('Open sibling sources for member0');
    expect(host.textContent).toContain('32-card board limit');
    expect((await savedState()).cards).toHaveLength(1);
  });

  it('centers menu and keyboard openings in the current view rather than using their screen click', async () => {
    await render(); await open(); await click('+ Add symbols');
    const row = [...host.querySelectorAll('.library .result')].find((item) => item.querySelector('strong')?.textContent === 'Alpha')!;
    button('Source', row).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 1050, clientY: 270 })); await settle();
    let recipe = await savedState(); expect(recipe.cards[0].position).toEqual({ x: 260, y: 332.5 }); expect(recipe.viewport).toEqual(view);
    await click('Open Beta source'); // .click() is also how keyboard button activation is surfaced (detail = 0)
    recipe = await savedState(); expect(recipe.cards[1].position).toEqual(recipe.cards[0].position); expect(recipe.viewport).toEqual(view);
  });
});

describe('Board relationship rendering', () => {
  it('compares unloaded member endpoints discovered only through source-card arrows without pinning them', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(286);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(160);
    const beta = { ...b, kind: 'class', endLine: 100 };
    const betaMethod = { ...children[0], id: 'betaMethod', file: b.file, ownerId: b.id, qualifiedName: 'Beta.member0' };
    facts = [a, beta, ...children, betaMethod];
    calls.boardSearch.mockResolvedValue({ items: clone([a, beta]), symbols: clone([a, beta]), total: 2, nextOffset: null, bounded: false });
    calls.board.mockImplementation(async (ids) => ({ ...snapshot(ids), relations: [{ ...edge, source: children[0].id, target: betaMethod.id, kind: 'calls' }] }));
    await render();
    for (const name of ['Alpha', 'Beta']) {
      await click('+ Add symbols');
      const row = [...host.querySelectorAll('.library .result')].find((item) => item.querySelector('strong')?.textContent === name)!;
      button('Source', row).click(); await settle();
    }
    let arrow: Element | undefined;
    await vi.waitFor(() => { arrow = [...host.querySelectorAll('.svelte-flow__edge')].find((item) => item.getAttribute('data-id')?.startsWith('source-relation:')); expect(arrow).toBeDefined(); });
    arrow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await settle();
    await click('Compare source ↗');
    expect(host.querySelectorAll('[data-code-card]')).toHaveLength(4);
    expect(host.querySelector('[data-code-card="m0"]')).not.toBeNull();
    expect(host.querySelector('[data-code-card="betaMethod"]')).not.toBeNull();
    expect(host.querySelectorAll('.svelte-flow__node-symbol')).toHaveLength(0);
  });
  it('draws a separate source-only layer, excludes module/header edges, and drops it for drifted bytes', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(286);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(160);
    const methodEdge = { ...edge, source: children[0].id, kind: 'calls' };
    const relations = [methodEdge, { ...methodEdge, id: 'import', kind: 'imports' }, edge];
    calls.board.mockImplementation(async (ids) => ({ ...snapshot(ids), relations }));
    await render(); boardRequests.enqueue(['a', 'b']); await settle();
    await click('Open Alpha source'); await click('Open Beta source');
    const sourceEdges = () => [...host.querySelectorAll<HTMLElement>('.svelte-flow__edge')].filter((item) => item.dataset.id?.startsWith('source-relation:'));
    await vi.waitFor(() => expect(sourceEdges()).toHaveLength(1));
    expect(sourceEdges()[0].dataset.id).toContain('["a","b","calls"');
    expect(host.querySelectorAll('.svelte-flow__node-symbol')).toHaveLength(2);
    const requests = calls.board.mock.calls.length;
    await moveCard('code:a'); expect(calls.board.mock.calls).toHaveLength(requests);
    calls.source.mockResolvedValue({ file: a.file, language: 'typescript', drift: true, showing: 'none', contentHash: 'changed', indexedAt: 1, generated: false, totalLines: 100 });
    // Reopening after a collapse re-verifies bytes without altering symbol membership.
    await click('Collapse code card Alpha'); await click('Expand code card Alpha');
    expect(sourceEdges()).toHaveLength(0);
    expect(host.querySelectorAll('.svelte-flow__node-symbol')).toHaveLength(2);
  });

  it('matches line/arrow colors per kind and retains them with labels and evidence dashes on selection', async () => {
    // Svelte Flow suppresses edges for zero-size jsdom nodes. Give this test's
    // nodes measurable dimensions without changing the lifecycle-test sandbox.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(286);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(160);
    const kinds = [...edgeKinds, 'future_relation'];
    const relations = kinds.map((kind) => ({ ...edge, id: kind, kind,
      ...(kind === 'calls' ? { synthesizedBy: 'callback', via: 'callback' } : {}),
      ...(kind === 'references' ? { confidence: 0.3 } : {}),
    }));
    calls.board.mockImplementation(async (ids) => ({ ...snapshot(ids), relations }));
    await render(); boardRequests.enqueue(['a', 'b']); await settle();
    for (const label of ['Ownership arrows', 'Uncertain matches']) {
      const checkbox = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((item) => item.parentElement?.textContent?.trim() === label)!;
      checkbox.click(); await settle();
    }
    function assertColors() {
      const paths = [...host.querySelectorAll<SVGElement>('.svelte-flow__edge-path')];
      expect(paths).toHaveLength(kinds.length);
      for (const kind of kinds) {
        const path = paths.find((item) => item.style.stroke === relationColor(kind))!;
        expect(path, kind).toBeDefined();
        const markerId = path.getAttribute('marker-end')!.match(/url\(['"]?#(.*?)['"]?\)$/)![1];
        const arrow = [...host.querySelectorAll<SVGElement>('marker')].find((item) => item.id === markerId)!.querySelector<SVGElement>('polyline')!;
        expect(arrow.style.fill).toBe(relationColor(kind));
        expect(host.textContent).toContain(relationLabel(kind));
        expect(path.style.strokeDasharray).toBe(['calls', 'references'].includes(kind) ? '6 4' : '');
      }
      return paths;
    }
    const before = assertColors().map((path) => path.style.strokeWidth);
    host.querySelector<HTMLElement>('.svelte-flow__node[data-id="a"]')!.click(); await settle();
    expect(assertColors().map((path) => path.style.strokeWidth)).not.toEqual(before);
  });
});

describe('Board replacement and metadata request lifetimes', () => {
  it('orders same-board Delete after pending Save and keeps the retained recipe unsaved', async () => {
    await render(); await open();
    const pending = deferred<{ id: string; name: string; updatedAt: string }>(); calls.saveBoard.mockImplementationOnce(() => pending.promise);
    await click('Save'); await click('Saved boards'); deleteRow('Alpha review'); await settle();
    expect(calls.deleteBoard).not.toHaveBeenCalled();
    pending.resolve({ id: 'a', name: 'Alpha review', updatedAt: 'now' }); await settle();
    expect(calls.deleteBoard).toHaveBeenCalledWith('a'); expect(records.has('a')).toBe(false);
    expect(host.querySelector('[data-symbol="a"]')).not.toBeNull(); expect(host.querySelector('.savebar')?.textContent).toContain('Unsaved changes');
    await click('Save'); expect(calls.saveBoard.mock.calls.at(-1)![0].id).toBeUndefined();
  });

  it.each(['load', 'projection', 'members'] as const)('does not resurrect a deleted board from pending %s', async (stage) => {
    await render(); await open('Beta review');
    const replacement = documentFor(a); if (stage === 'members') replacement.symbols[0].expanded = true;
    const result = loaded(replacement); const pending = deferred<any>();
    if (stage === 'load') calls.loadBoard.mockImplementationOnce(() => pending.promise);
    else {
      calls.loadBoard.mockResolvedValueOnce(result);
      if (stage === 'projection') calls.board.mockImplementationOnce(() => pending.promise);
      else calls.boardMembers.mockImplementationOnce(() => pending.promise);
    }
    await click('Saved boards'); await click('Open Alpha review'); deleteRow('Alpha review'); await settle();
    expect(calls.deleteBoard).toHaveBeenCalledWith('a');
    pending.resolve(stage === 'load' ? result : stage === 'projection' ? snapshot(['a']) : { symbols: facts, items: children, total: 12, nextOffset: null, bounded: false, notes: [] });
    await settle();
    expect(host.querySelector('[data-symbol="b"]')).not.toBeNull(); expect(host.querySelector('[data-symbol="a"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('[aria-label="Board name"]')!.value).toBe('Beta review');
  });

  it.each([false, true])('does not cancel another board Open or invalidate it after failed Delete (failure=%s)', async (failure) => {
    await render(); await open('Beta review');
    const pending = deferred<BoardLoaded>(); calls.loadBoard.mockImplementationOnce(() => pending.promise);
    if (failure) calls.deleteBoard.mockRejectedValueOnce(new Error('Delete refused'));
    await click('Saved boards'); await click('Open Alpha review'); deleteRow(failure ? 'Alpha review' : 'Beta review'); await settle();
    pending.resolve(loaded(documentFor(a))); await settle();
    expect(host.querySelector('[data-symbol="a"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[aria-label="Board name"]')!.value).toBe('Alpha review');
  });

  it('keeps geometry moved during pending Save dirty relative to the submitted recipe', async () => {
    await render(); await open(); const pending = deferred<{ id: string; name: string; updatedAt: string }>();
    calls.saveBoard.mockImplementationOnce(() => pending.promise); await click('Save'); await moveCard('a');
    pending.resolve({ id: 'a', name: 'Alpha review', updatedAt: 'now' }); await settle();
    expect(host.querySelector('.savebar')?.textContent).toContain('Unsaved changes');
    const submitted = calls.saveBoard.mock.calls[0][0].document.symbols[0].position;
    await click('Save'); expect(calls.saveBoard.mock.calls.at(-1)![0].document.symbols[0].position).not.toEqual(submitted);
  });

  it('preserves geometry moved while another board Open is pending', async () => {
    await render(); await open('Beta review'); const pending = deferred<BoardLoaded>(); calls.loadBoard.mockImplementationOnce(() => pending.promise);
    await click('Saved boards'); await click('Open Alpha review'); await moveCard('b');
    const moved = host.querySelector<HTMLElement>('.svelte-flow__node[data-id="b"]')!.style.transform;
    pending.resolve(loaded(documentFor(a))); await settle();
    expect(host.querySelector<HTMLElement>('.svelte-flow__node[data-id="b"]')!.style.transform).toBe(moved);
    expect(host.querySelector('[data-symbol="a"]')).toBeNull(); expect(host.querySelector('.notice')?.textContent).toContain('newer work was preserved');
  });

  it('preserves New against a late successful Save', async () => {
    await render(); await open(); const pending = deferred<{ id: string; name: string; updatedAt: string }>();
    calls.saveBoard.mockImplementationOnce(() => pending.promise); await click('Save'); await click('New');
    pending.resolve({ id: 'a', name: 'Alpha review', updatedAt: 'now' }); await settle();
    expect(host.querySelector('[data-symbol]')).toBeNull(); expect(host.querySelector<HTMLInputElement>('[aria-label="Board name"]')!.value).toBe('');
    expect(host.querySelector('.notice')?.textContent).not.toContain('Saved Alpha');
  });

  it.each([false, true])('retains a pending first Save/Save-as binding across index refresh (asNew=%s)', async (asNew) => {
    await render();
    if (asNew) await open(); else { boardRequests.enqueue(['a']); await settle(); }
    input('Board name', asNew ? 'Clone review' : 'Fresh review');
    const pending = deferred<{ id: string; name: string; updatedAt: string }>(); calls.saveBoard.mockImplementationOnce(() => pending.promise);
    await click(asNew ? 'Save as' : 'Save'); await click('Refresh index');
    pending.resolve({ id: 'created', name: asNew ? 'Clone review' : 'Fresh review', updatedAt: 'now' }); await settle();
    expect(host.querySelector('.savebar')?.textContent).not.toContain('Unsaved changes');
    await click('Save'); expect(calls.saveBoard.mock.calls.at(-1)![0].id).toBe('created');
  });

  it('recovers keyboard focus after the last hidden row is restored, so Escape still closes the panel', async () => {
    await render(); await open(); await click('Hide Alpha'); await click('Hidden items (1)');
    const restore = button('Restore'); restore.focus(); restore.click(); await settle();
    expect(document.activeElement?.closest('[aria-label="Hidden items"]')).not.toBeNull();
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle();
    expect(host.querySelector('[aria-label="Hidden items"]')).toBeNull();
    expect(host.contains(document.activeElement)).toBe(true);
  });

  it('does not publish old Add completion notices after New', async () => {
    await render(); const pending = deferred<BoardSnapshot>(); let count = 0;
    calls.board.mockImplementation(async (ids) => ++count === 2 ? pending.promise : snapshot(ids));
    boardRequests.enqueue(['a']); await settle(); expect(calls.board).toHaveBeenCalledTimes(2);
    await click('New'); pending.resolve(snapshot(['a'])); await settle();
    expect(host.querySelector('[data-symbol]')).toBeNull(); expect(host.querySelector('.notice')?.textContent).toContain('New empty board');
  });

  it('does not resurrect a deleted library row from an older list response', async () => {
    await render(); await open();
    const stale = await calls.boards(); const pending = deferred<typeof stale>(); calls.boards.mockImplementationOnce(() => pending.promise);
    await click('Saved boards'); deleteRow('Alpha review'); await settle();
    expect(host.querySelector('[aria-label="Saved boards"]')?.textContent).not.toContain('Alpha review');
    pending.resolve(stale); await settle();
    expect(host.querySelector('[aria-label="Saved boards"]')?.textContent).not.toContain('Alpha review');
    expect(host.querySelector('[aria-label="Saved boards"]')?.textContent).toContain('Beta review');
  });

  it('does not cancel another board Save when deleting an unrelated record', async () => {
    await render(); await open('Beta review'); const pending = deferred<{ id: string; name: string; updatedAt: string }>();
    calls.saveBoard.mockImplementationOnce(() => pending.promise); await click('Save'); await click('Saved boards'); deleteRow('Alpha review'); await settle();
    expect(calls.deleteBoard).toHaveBeenCalledWith('a');
    pending.resolve({ id: 'b', name: 'Beta review', updatedAt: 'now' }); await settle();
    expect(host.querySelector('.savebar')?.textContent).not.toContain('Unsaved changes');
    expect(host.querySelector('.notice')?.textContent).toContain('Saved Beta review');
  });

  it.each([undefined, noExclusions, { ...noExclusions, symbols: { tests: 2, generated: 0, uncertain: 0 } }])('replaces exclusion counters when opening a recipe', async (replacement) => {
    exclusions = { ...noExclusions, symbols: { tests: 9, generated: 0, uncertain: 0 } };
    await render(); boardRequests.enqueue(['a']); await settle(); expect(host.querySelector('.visibility')?.textContent).toContain('9 test');
    exclusions = replacement; await open();
    expect(host.querySelector('.visibility')?.textContent).not.toContain('9 test');
    if (replacement?.symbols.tests) expect(host.querySelector('.visibility')?.textContent).toContain('2 test');
  });

  it('starts New with fresh reveal limits, source stacking and discovery controls', async () => {
    const saved = records.get('a')!.document; saved.symbols[0].expanded = true; saved.symbols[0].memberLimit = 12;
    saved.cards = [{ key: 'c0', symbolKey: 's0', position: { x: 200, y: 700 }, width: 600, height: 487, collapsed: true, zIndex: 91 }];
    await render(); await open(); expect(host.querySelectorAll('[data-member]')).toHaveLength(12);
    await click('+ Add symbols'); input('Search indexed symbols', 'old draft'); input('Symbol path filter', 'old/');
    await click('New'); boardRequests.enqueue(['a']); await settle(); await click('Expand Alpha members');
    expect(host.querySelectorAll('[data-member]')).toHaveLength(6);
    expect(host.querySelector('.member.located')).toBeNull();
    await click('+ Add symbols'); expect(host.querySelector<HTMLInputElement>('[aria-label="Search indexed symbols"]')!.value).toBe('');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Symbol path filter"]')!.value).toBe('');
    await click('Close symbol library'); await click('Open Alpha source'); input('Board name', 'Fresh'); await click('Save');
    const recipe = calls.saveBoard.mock.calls.at(-1)![0].document;
    expect(recipe.symbols.find((item) => item.identity.id === 'a')?.memberLimit ?? 6).toBe(6);
    expect(recipe.cards[0]).toMatchObject({ height: 310, width: 530, collapsed: false, zIndex: 11 });
  });
});

describe('identity-keyed arrangement restoration', () => {
  it('round-trips positions, viewport, visibility, member limits and independent source cards through moved/missing/ambiguous identities', async () => {
    facts = facts.map((item) => item.id === 'a' ? { ...item, id: 'a-current', line: 25, endLine: 125 }
      : item.id === 'b' ? { ...item, id: 'b-current' } : { ...item, ownerId: item.ownerId === 'a' ? 'a-current' : item.ownerId });
    facts.push({ ...a, id: 'ambiguous-one', name: 'Ambiguous', qualifiedName: 'Ambiguous', file: 'ambiguous.ts' },
      { ...a, id: 'ambiguous-two', name: 'Ambiguous', qualifiedName: 'Ambiguous', file: 'ambiguous.ts', line: 30 });
    const recipe = documentFor(a); recipe.symbols[0].expanded = true; recipe.symbols[0].memberLimit = 12;
    recipe.symbols.push({ ...documentFor(b).symbols[0], key: 'source-only', included: false, position: { x: 432, y: -25 } },
      { ...documentFor(a).symbols[0], key: 'missing', identity: { qualifiedName: 'Gone', kind: 'class', file: 'gone.ts' }, hidden: true, position: { x: -440, y: 320 } },
      { ...documentFor(a).symbols[0], key: 'ambiguous', identity: { id: 'ambiguous-one', qualifiedName: 'Ambiguous', kind: 'class', file: 'ambiguous.ts' }, position: { x: 810, y: 460 } });
    recipe.cards = [{ key: 'card-a', symbolKey: 's0', position: { x: -310, y: 740 }, width: 640, height: 411, collapsed: true, zIndex: 5 },
      { key: 'card-b', symbolKey: 'source-only', position: { x: 520, y: 780 }, width: 720, height: 389, collapsed: false, zIndex: 9 }];
    recipe.viewport = { x: -125, y: 90, zoom: .7 }; recipe.filters = { kind: 'references', showStructure: true, includeTests: true, includeGenerated: false, includeUncertain: true };
    records.get('a')!.document = recipe;
    await render(); await open(); expect(host.textContent).toContain('ambiguous:');
    expect(host.querySelector('[data-symbol="b-current"]')).toBeNull();
    await click('Save'); const first = clone(calls.saveBoard.mock.calls.at(-1)![0].document);
    expect(identityGeometry(first)).toEqual(identityGeometry(recipe));
    expect(first.symbols.find((item) => item.identity.qualifiedName === 'Alpha')!.identity.id).toBe('a-current');
    expect(first.symbols.find((item) => item.identity.qualifiedName === 'Beta')!.included).toBe(false);
    await click('New'); await open(); await click('Save');
    expect(identityGeometry(calls.saveBoard.mock.calls.at(-1)![0].document)).toEqual(identityGeometry(first));
  });

  it('re-resolves shifted source identities on index refresh without resetting geometry', async () => {
    const recipe = records.get('a')!.document;
    recipe.cards = [{ key: 'card-a', symbolKey: 's0', position: { x: 620, y: 710 }, width: 650, height: 400, collapsed: false, zIndex: 18 }];
    recipe.viewport = { x: -42, y: 81, zoom: .9 };
    await render(); await open();
    facts = facts.map((item) => item.id === 'a' ? { ...item, id: 'a-shifted', line: 25, endLine: 125 } : { ...item, ownerId: item.ownerId === 'a' ? 'a-shifted' : item.ownerId });
    await click('Refresh index');
    expect(host.querySelector('[data-code-card="a"]')).toBeNull(); expect(host.querySelector('[data-code-card="a-shifted"]')).not.toBeNull();
    expect(calls.source.mock.calls.at(-1)![0]).toMatchObject({ file: a.file, from: 25 });
    await click('Save'); expect(identityGeometry(calls.saveBoard.mock.calls.at(-1)![0].document)).toEqual(identityGeometry(recipe));
  });
});

describe('completed Connections contexts', () => {
  it.each(['kind', 'direction', 'members'] as const)('restores completed criteria/results after pending %s, preserving draft/selection/scroll', async (control) => {
    await render(); await open(); await click('Connections for Alpha');
    const pending = deferred<BoardConnections>(); calls.boardConnections.mockImplementation(async (request) => request.id === 'a' &&
      (control === 'kind' ? request.kind === 'calls' : control === 'direction' ? request.direction === 'incoming' : request.members === false) ? pending.promise : connections(request));
    if (control === 'kind') {
      const select = host.querySelector<HTMLSelectElement>('[aria-label="Connection relationship filter"]')!;
      select.value = 'calls'; select.dispatchEvent(new Event('change', { bubbles: true })); await settle();
    } else if (control === 'direction') await click('Incoming');
    else { const members = host.querySelector<HTMLInputElement>('.connections-panel .direction input')!; members.checked = false; members.dispatchEvent(new Event('change', { bubbles: true })); await settle(); }
    input('Search connection targets', 'unsubmitted draft');
    const checkbox = host.querySelector<HTMLInputElement>('[aria-label="Select target Beta"]')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    host.querySelector('.connections-panel .result-list')!.scrollTop = 47;
    await click('Connections for target Beta'); await click('Back to previous connections');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Connection relationship filter"]')!.value).toBe('');
    expect(button('Outgoing').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector<HTMLInputElement>('.connections-panel .direction input')!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Search connection targets"]')!.value).toBe('unsubmitted draft');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Select target Beta"]')!.checked).toBe(true);
    expect(host.querySelector('.connections-panel .result-list')!.scrollTop).toBe(47);
    pending.resolve({ ...connections({ id: 'a', members: true, direction: 'outgoing' }), items: [], total: 0, nextOffset: null }); await settle();
    expect(host.querySelector('[data-connection-target="b"]')).not.toBeNull();
    await click('More evidence (1)'); expect(calls.boardEvidence.mock.calls.at(-1)?.[0]).toMatchObject({ id: 'a', kind: undefined, q: undefined });
    await click('Next targets'); expect(calls.boardConnections.mock.calls.at(-1)![0]).toMatchObject({ id: 'a', offset: 1, kind: undefined, q: undefined });
  });

  it('refetches a history entry that never completed, instead of showing a completed empty page', async () => {
    records.get('a')!.document.symbols.push({ ...documentFor(b).symbols[0], key: 'second' });
    await render(); await open(); const first = deferred<BoardConnections>(); let attempts = 0;
    calls.boardConnections.mockImplementation(async (request) => request.id === 'a' && ++attempts === 1 ? first.promise : connections(request));
    await click('Connections for Alpha'); input('Search connection targets', 'draft while pending');
    await click('Connections for Beta'); await click('Back to previous connections');
    expect(calls.boardConnections.mock.calls.filter(([request]) => request.id === 'a')).toHaveLength(2);
    expect(host.querySelector('[data-connection-target="b"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[aria-label="Search connection targets"]')!.value).toBe('draft while pending');
    expect(calls.boardConnections.mock.calls.at(-1)![0].q).toBeUndefined();
    first.resolve({ ...connections({ id: 'a', direction: 'outgoing', members: true }), items: [], total: 0, nextOffset: null }); await settle();
    expect(host.querySelector('[data-connection-target="b"]')).not.toBeNull();
  });

  it('explains and disables evidence pagination when the optional capability is absent', async () => {
    const { boardEvidence, ...partial } = calls; setGraphAdapter(partial as unknown as GraphAdapter);
    await render(); await open(); await click('Connections for Alpha');
    expect(button('More evidence (1)').disabled).toBe(true);
    expect(host.textContent).toContain('This host does not provide further evidence pages.'); expect(boardEvidence).not.toHaveBeenCalled();
  });
});
