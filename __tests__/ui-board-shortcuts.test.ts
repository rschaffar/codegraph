/** Browser seam tests only; no index, fixture catalogue, network or filesystem writes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import BoardSourceCard from '../ui/src/components/board/BoardSourceCard.svelte';
import SymbolHeader from '../ui/src/components/symbol/SymbolHeader.svelte';
import FileView from '../ui/src/views/FileView.svelte';
import FileCodeView from '../ui/src/views/FileCodeView.svelte';
import { addToBoard, boardRequests } from '../ui/src/lib/board-requests.svelte';
import { boardHref, fileHref, hashNavigation, setNavigationDriver, symbolHref, type NavigationDriver } from '../ui/src/lib/navigation';
import { setGraphAdapter, type GraphAdapter, type SourceRequest } from '../ui/src/lib/adapter';
import type { BoardEvidence, BoardSymbol } from '../ui/src/lib/board-model';
import type { BoardConnectionRequest } from '../ui/src/lib/board-wire';
import type { WireFileCodePayload, WireFilePayload, WireNodeRef, WireSource, WireSymbolPayload } from '../ui/src/lib/wire';
import { live } from '../ui/src/lib/live.svelte';

// The pointer resizer needs a Flow provider; these tests exercise the card's
// own keyboard controls. The real provider/canvas is covered by the parent.
vi.mock('@xyflow/svelte', () => ({ NodeResizer: () => {} }));

const symbol: BoardSymbol & WireNodeRef = {
  id: 'class:container', kind: 'class', name: 'Container', qualifiedName: 'Container', file: 'src/example.ts',
  line: 1, endLine: 850, language: 'typescript', test: false,
};
const target: BoardSymbol & WireNodeRef = { ...symbol, id: 'method:render', kind: 'method', name: 'render', qualifiedName: 'Renderer.render', file: 'src/renderer.ts', line: 2, endLine: 4 };
const second: BoardSymbol & WireNodeRef = { ...target, id: 'method:other', name: 'other', qualifiedName: 'Renderer.other' };
const edge: BoardEvidence = { id: 'edge:1', source: symbol.id, target: target.id, kind: 'references', file: symbol.file, line: 2, col: 0, confidence: 1 };
const noExclusions = { symbols: { tests: 0, generated: 0, uncertain: 0 }, relations: { tests: 0, generated: 0, uncertain: 0 } };
const list = <T,>(items: T[] = []) => ({ total: items.length, shown: items.length, truncated: false, items });
const header: WireSymbolPayload = {
  node: { ...symbol, startColumn: 0, endColumn: 1, lines: 850 }, ancestors: [], members: list(), hierarchy: null,
  incoming: list(), outgoing: list(), typesUsed: [],
  counts: { callers: 0, callees: 0, typesUsed: 0, fanIn: 0, fanOut: 0, members: 0, hub: false },
  tests: { reached: false, hops: null, fileCount: 0, files: [], exhaustive: true, hopsSearched: 3 },
  outsideIndex: { total: 0, byKind: {}, samples: [] }, blast: null, drift: false,
};
const file: WireFilePayload = {
  file: { path: symbol.file, language: 'typescript', size: 30, modifiedAt: 1, indexedAt: 1, contentHash: 'matching', nodeCount: 2, generated: false, test: false, errors: [], id: 'file:example' },
  topLevel: { calls: 0 }, drift: false, outline: list(), imports: list(), importedBy: list(), unresolvedImports: [], dependencies: [], dependents: [],
};
const fileCode: WireFileCodePayload = { file: { ...file.file, totalLines: 3 }, drift: false, outline: list(), calls: list(), outside: list(), intraFileCalls: 0, timing: { elapsedMs: 0 } };
function slice(request: SourceRequest): WireSource {
  const from = request.from ?? 1; const to = Math.min(request.to ?? from, request.file === symbol.file ? 850 : 4);
  return { file: request.file, language: 'typescript', drift: false, showing: 'indexed', contentHash: 'matching', indexedAt: 1,
    generated: false, totalLines: request.file === symbol.file ? 850 : 4, from, to, lines: Array.from({ length: to - from + 1 }, () => 'object.render();') };
}
function makeAdapter() {
  const calls = {
    nodes: vi.fn(async (ids: readonly string[]) => ({ items: [symbol, target, second].filter((item) => ids.includes(item.id)), missing: [] })),
    source: vi.fn(async (request: SourceRequest) => slice(request)),
    board: vi.fn(async () => ({ symbols: [], relations: [], included: [], missing: [], bounded: false, notes: [], nodeKinds: [], edgeKinds: [] })),
    boardConnections: vi.fn(async (request: BoardConnectionRequest) => ({
      scope: symbol, direction: 'outgoing', withMembers: request.members, symbols: [symbol, target, second], total: 2,
      items: request.offset ? [{ target: second, evidence: [{ ...edge, id: 'edge:3', target: second.id, kind: 'contains' }], total: 1 }] : [{ target, evidence: [edge], total: 2 }],
      nextOffset: request.offset ? null : 1, bounded: true, notes: ['Evidence is paged.'], excluded: noExclusions,
    })),
    boardEvidence: vi.fn(async () => ({ symbols: [symbol, target], items: [{ ...edge, id: 'edge:2', line: 450, provenance: 'heuristic', registeredAt: 'src/wiring.ts:20' }], total: 2, nextOffset: null, bounded: false, notes: [] })),
    file: vi.fn(async () => file), fileCode: vi.fn(async () => fileCode),
  };
  return { calls, adapter: calls as unknown as GraphAdapter };
}
let host: HTMLDivElement;
let mounted: Record<string, unknown>[];
let adapter: ReturnType<typeof makeAdapter>;
let navigate: ReturnType<typeof vi.fn>;
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) { await new Promise((resolve) => setTimeout(resolve, 0)); flushSync(); }
}
function cardProps(overrides: Partial<ComponentProps<typeof BoardSourceCard>['data']> = {}, id = 'card:one'): ComponentProps<typeof BoardSourceCard> {
  return { id, type: 'code', data: { symbolId: symbol.id, symbol, collapsed: false, close: vi.fn(), toggle: vi.fn(), read: vi.fn(), ...overrides },
    selected: false, dragging: false, isConnectable: false, deletable: true, selectable: true, zIndex: 1,
    positionAbsoluteX: 0, positionAbsoluteY: 0, draggable: true };
}
function renderCard(overrides: Partial<ComponentProps<typeof BoardSourceCard>['data']> = {}, id = 'card:one'): void {
  mounted.push(mount(BoardSourceCard, { target: host, props: cardProps(overrides, id) })); flushSync();
}
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); mounted = [];
  boardRequests.take(); adapter = makeAdapter(); setGraphAdapter(adapter.adapter); navigate = vi.fn();
  setNavigationDriver({ ...hashNavigation, boardHref: () => '/workspace/review/board', navigate });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected direct network access'); }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterEach(async () => {
  for (const component of mounted) await unmount(component);
  host.remove(); boardRequests.take(); setGraphAdapter(null); setNavigationDriver(null); vi.unstubAllGlobals();
});

describe('reader Add-to-board handoff and optional navigation', () => {
  it('deduplicates IDs in order, exposes pending and atomically drains the queue', () => {
    boardRequests.enqueue(['one', 'two']); boardRequests.enqueue(['two', '', 'three']);
    expect(boardRequests.pending).toEqual(['one', 'two', 'three']);
    const taken = boardRequests.take(); taken.push('not-pending');
    expect(boardRequests.pending).toEqual([]); expect(boardRequests.take()).toEqual([]);
    addToBoard(['chosen']);
    expect(boardRequests.pending).toEqual(['chosen']); expect(navigate).toHaveBeenCalledWith('/workspace/review/board', {});
    expect(adapter.calls.board).not.toHaveBeenCalled();
  });

  it('supports both an old driver with no Board method and a custom host path', () => {
    const { boardHref: omitted, ...oldDriver } = hashNavigation;
    const legacy: NavigationDriver = { ...oldDriver, navigate };
    setNavigationDriver(legacy);
    expect(boardHref()).toBe('#/board');
    expect(symbolHref('function:id')).toBe(hashNavigation.symbolHref('function:id'));
    expect(fileHref('src/file.ts')).toBe(hashNavigation.fileHref('src/file.ts'));
    addToBoard(['from-legacy-host']);
    expect(navigate).toHaveBeenLastCalledWith('#/board', {});
    setNavigationDriver({ ...legacy, boardHref: () => '/custom/board' });
    expect(boardHref()).toBe('/custom/board');
    expect(omitted?.()).toBe('#/board');
  });

  it('offers a symbol shortcut only on a Board-capable host and preserves keyboard activation', async () => {
    mounted.push(mount(SymbolHeader, { target: host, props: { payload: header, onopen: vi.fn() } })); flushSync();
    const add = button('Add to board');
    const bubbled = vi.fn(); window.addEventListener('keydown', bubbled);
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); add.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false); expect(bubbled).not.toHaveBeenCalled(); window.removeEventListener('keydown', bubbled);
    add.click(); expect(boardRequests.take()).toEqual([symbol.id]); expect(navigate).toHaveBeenCalled();
    await unmount(mounted.pop()!); host.replaceChildren();
    const { board, ...readerOnly } = adapter.adapter; setGraphAdapter(readerOnly);
    mounted.push(mount(SymbolHeader, { target: host, props: { payload: header, onopen: vi.fn() } })); flushSync();
    expect(host.textContent).not.toContain('Add to board'); expect(board).toBeDefined();
  });

  it('adds only the indexed file node from the outline and whole-source readers', async () => {
    for (const component of [FileView, FileCodeView]) {
      mounted.push(mount(component, { target: host, props: { path: symbol.file, line: null } })); await settle();
      button('Add to board').click(); expect(boardRequests.take()).toEqual(['file:example']);
      expect(adapter.calls.board).not.toHaveBeenCalled();
      await unmount(mounted.pop()!); host.replaceChildren();
    }
  });

  it('hides file shortcuts without Board support or an indexed file node', async () => {
    const { board, ...readerOnly } = adapter.adapter; setGraphAdapter(readerOnly);
    mounted.push(mount(FileView, { target: host, props: { path: symbol.file, line: null } })); await settle();
    expect(host.textContent).not.toContain('Add to board');
    await unmount(mounted.pop()!); host.replaceChildren(); setGraphAdapter(adapter.adapter);
    adapter.calls.fileCode.mockResolvedValue({ ...fileCode, file: { ...fileCode.file, id: null } });
    mounted.push(mount(FileCodeView, { target: host, props: { path: symbol.file, line: null } })); await settle();
    expect(host.textContent).not.toContain('Add to board'); expect(board).toBeDefined();
  });
});

describe('linked source cards', () => {
  it('does not refetch identity, source or graph for presentation-only Flow data replacement', async () => {
    const props = cardProps(); const values = new SvelteMap([['data', props.data]]);
    mounted.push(mount(BoardSourceCard, { target: host, props: { ...props, get data() { return values.get('data')!; } } }));
    await settle();
    const counts = [adapter.calls.nodes.mock.calls.length, adapter.calls.source.mock.calls.length, adapter.calls.boardConnections.mock.calls.length];
    values.set('data', { ...values.get('data')!, resize: vi.fn(), read: vi.fn() }); await settle();
    expect([adapter.calls.nodes.mock.calls.length, adapter.calls.source.mock.calls.length, adapter.calls.boardConnections.mock.calls.length]).toEqual(counts);
  });
  it('links complete unambiguous evidence, follows another card, and never changes graph membership', async () => {
    adapter.calls.boardConnections.mockResolvedValue({ scope: symbol, direction: 'outgoing', withMembers: true,
      symbols: [symbol, target], items: [{ target, evidence: [edge], total: 1 }], total: 1, nextOffset: null,
      bounded: false, notes: [], excluded: noExclusions });
    const follow = vi.fn(); renderCard({ follow }); renderCard({}, 'card:two'); await settle();
    expect(host.querySelectorAll('[data-code-card]')).toHaveLength(2);
    expect(adapter.calls.boardConnections.mock.calls[0][0]).toMatchObject({ id: symbol.id, direction: 'outgoing', members: true, tests: false, generated: false, uncertain: false, limit: 8 });
    expect(adapter.calls.boardEvidence).not.toHaveBeenCalled();
    const ref = host.querySelector<HTMLElement>('.source [role="link"]')!;
    expect(ref.textContent).toBe('render'); expect(ref.title).toContain('references Renderer.render');
    ref.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(follow).toHaveBeenCalledWith(expect.objectContaining({ id: target.id }), undefined, undefined);
    const event = new MouseEvent('click', { bubbles: true, detail: 1, clientX: 420, clientY: 280 });
    ref.dispatchEvent(event);
    expect(follow).toHaveBeenLastCalledWith(expect.objectContaining({ id: target.id }), undefined, event);
    expect(host.querySelectorAll('[data-code-card]')).toHaveLength(2);
    expect(adapter.calls.board).not.toHaveBeenCalled(); expect(boardRequests.pending).toEqual([]);
    expect(host.querySelectorAll('.source [role="link"]')).toHaveLength(2);
  });

  it('never links a same-site target that is ambiguous on a later target page', async () => {
    const peers = Array.from({ length: 9 }, (_, index) => ({ ...target, id: `method:peer${index}`,
      name: index === 0 || index === 8 ? 'render' : `other${index}`, qualifiedName: index === 0 ? 'A.render' : index === 8 ? 'Z.render' : `Peer.other${index}` }));
    adapter.calls.boardConnections.mockImplementation(async (request) => {
      const page = request.offset ? peers.slice(8) : peers.slice(0, 8);
      return { scope: symbol, direction: 'outgoing', withMembers: true, symbols: [symbol, ...page],
        items: page.map((target) => ({ target, evidence: [{ ...edge, id: `edge:${target.id}`, target: target.id }], total: 1 })),
        total: 9, nextOffset: request.offset ? null : 8, bounded: false, notes: [], excluded: noExclusions };
    });
    const follow = vi.fn(); renderCard({ follow }); await settle();
    expect(host.querySelector('.source [role="link"]')).toBeNull();
    expect(host.textContent).toContain('Inline target links are withheld');
    host.querySelector<HTMLButtonElement>('.target-link')!.click();
    expect(follow).toHaveBeenCalledWith(expect.objectContaining({ id: peers[0].id }), undefined, expect.any(MouseEvent));
    button('Load more targets (8 of 9)').click(); await settle();
    expect(host.querySelector('.source [role="link"]')).toBeNull();
    expect(host.textContent).toContain('Z.render');
    expect(adapter.calls.board).not.toHaveBeenCalled();
  });

  it('does not treat filtered-out evidence as proof of a unique inline target', async () => {
    adapter.calls.boardConnections.mockResolvedValue({ scope: symbol, direction: 'outgoing', withMembers: true,
      symbols: [symbol, target], items: [{ target, evidence: [edge], total: 1 }], total: 1, nextOffset: null,
      bounded: false, notes: [], excluded: { ...noExclusions, relations: { tests: 0, generated: 0, uncertain: 1 } } });
    renderCard(); await settle();
    expect(host.querySelector('.source [role="link"]')).toBeNull();
    expect(host.querySelector('.target-link')?.textContent).toContain('Renderer.render');
  });

  it('pages target discovery and evidence only on explicit Load more, retaining raw kind metadata', async () => {
    renderCard(); await settle();
    button('Show evidence').click(); flushSync();
    expect(adapter.calls.boardEvidence).not.toHaveBeenCalled();
    button('Load more evidence (1 of 2)').click(); await settle();
    expect(adapter.calls.boardEvidence).toHaveBeenCalledWith(expect.objectContaining({ id: symbol.id, target: target.id, offset: 1, limit: 40, tests: false, generated: false, uncertain: false }), expect.any(AbortSignal));
    expect(host.textContent).toContain('wired at src/wiring.ts:20');
    button('Load more targets (1 of 2)').click(); await settle();
    expect(adapter.calls.boardConnections.mock.calls[1][0]).toMatchObject({ offset: 1, limit: 8 });
    expect(host.textContent).toContain('Loaded kinds: contains');
    expect(adapter.calls.board).not.toHaveBeenCalled();
  });

  it('continues beyond 400 lines and focuses a requested endpoint evidence line', async () => {
    renderCard({ highlight: 450 }); await settle();
    expect(adapter.calls.source.mock.calls[0][0]).toMatchObject({ from: 401, to: 800 });
    expect(host.querySelector('[data-line="450"]')?.classList.contains('hot')).toBe(true);
    button('Next lines').click(); await settle();
    expect(adapter.calls.source.mock.calls[1][0]).toMatchObject({ from: 801, to: 850 });
    expect(host.querySelector('[data-line="850"]')).not.toBeNull();
    button('Previous lines').click(); await settle();
    expect(adapter.calls.source.mock.calls[2][0]).toMatchObject({ from: 401, to: 800 });
    expect(adapter.calls.source.mock.calls.every(([request]) => request.to! - request.from! < 400)).toBe(true);
  });

  it('focuses an original evidence site in this card without opening or admitting anything', async () => {
    const follow = vi.fn(); renderCard({ follow }); await settle();
    button('Show evidence').click(); flushSync(); button('Focus site').click(); await settle();
    expect(host.querySelector('[data-line="2"]')?.classList.contains('hot')).toBe(true);
    expect(follow).not.toHaveBeenCalled(); expect(adapter.calls.board).not.toHaveBeenCalled();
  });

  it('never requests source or evidence for a changed or ambiguous identity', async () => {
    adapter.calls.nodes.mockResolvedValue({ items: [{ ...symbol, signature: 'changed' }], missing: [] });
    renderCard(); await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('identity changed');
    expect(adapter.calls.source).not.toHaveBeenCalled(); expect(adapter.calls.boardConnections).not.toHaveBeenCalled();
    expect(host.querySelector('.source .ln')).toBeNull();
  });

  it('drops cached source immediately on index invalidation and ignores late old responses', async () => {
    renderCard(); await settle(); expect(host.querySelector('.source .ln')).not.toBeNull();
    let resolve!: (value: { items: typeof symbol[]; missing: string[] }) => void;
    adapter.calls.nodes.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    live.signal('index'); flushSync();
    expect(host.querySelector('.source .ln')).toBeNull();
    resolve({ items: [{ ...symbol, file: 'another.ts' }], missing: [] }); await settle();
    expect(host.querySelector('.source .ln')).toBeNull(); expect(adapter.calls.source).toHaveBeenCalledTimes(1);
  });

  it('reads current drifted bytes without references, definition markings or indexed line highlight', async () => {
    adapter.calls.source.mockImplementation(async (request) => request.ondrift === 'current'
      ? { ...slice(request), drift: true, showing: 'current' }
      : { ...slice(request), drift: true, showing: 'none', lines: undefined });
    renderCard({ highlight: 2 }); await settle(); expect(host.querySelector('.source .ln')).toBeNull();
    button('Read current file').click(); await settle();
    expect(adapter.calls.source.mock.calls[1][0]).toMatchObject({ from: 1, to: 400, ondrift: 'current' });
    expect(host.querySelector('.source .ln')).not.toBeNull();
    expect(host.querySelector('.source [role="link"]')).toBeNull(); expect(host.querySelector('.source .ln.hot')).toBeNull(); expect(host.querySelector('.source .t-def')).toBeNull();
    button('Next lines').click(); await settle(); expect(adapter.calls.source.mock.calls[2][0]).toMatchObject({ from: 401, to: 800, ondrift: 'current' });
  });

  it('passes active exclusion controls and offers keyboard-operable resize buttons', async () => {
    const resize = vi.fn(); renderCard({ filters: { tests: true, generated: false, uncertain: true }, resize }); await settle();
    expect(adapter.calls.boardConnections.mock.calls[0][0]).toMatchObject({ tests: true, generated: false, uncertain: true });
    for (const [label, width, height] of [['Wider', 80, 0], ['Narrower', -80, 0], ['Taller', 0, 80], ['Shorter', 0, -80]] as const) {
      button(label).click(); expect(resize).toHaveBeenLastCalledWith('card:one', width, height);
    }
    const moveHandle = host.querySelector<HTMLElement>('header[role="group"]')!;
    moveHandle.focus(); expect(document.activeElement).toBe(moveHandle); expect(moveHandle.tabIndex).toBe(0);
    expect(host.querySelector('[role="group"][aria-label="Resize source card Container"]')).not.toBeNull();
    expect(adapter.calls.board).not.toHaveBeenCalled();
  });

  it('does not fetch a collapsed source card', async () => {
    renderCard({ collapsed: true }); await settle();
    expect(adapter.calls.nodes).not.toHaveBeenCalled(); expect(adapter.calls.source).not.toHaveBeenCalled(); expect(adapter.calls.boardConnections).not.toHaveBeenCalled();
  });
});
