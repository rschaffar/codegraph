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
import type { BoardConnections, BoardConnectionRequest, BoardEvidencePage } from '../ui/src/lib/board-wire';
import { BOARD_SOURCE_TARGET_PAGE, BOARD_SOURCE_EVIDENCE_PAGE, BOARD_SOURCE_AUTO_REQUESTS } from '../ui/src/lib/board-source-model';
import type { WireFileCodePayload, WireFilePayload, WireNodeRef, WireSource, WireSymbolPayload } from '../ui/src/lib/wire';
import { live } from '../ui/src/lib/live.svelte';

// These seams require a Flow provider in production. Real handle geometry and
// pointer resizing are covered by the canvas suite, not these isolated cards.
const flow = vi.hoisted(() => ({ updateNodeInternals: vi.fn() }));
vi.mock('@xyflow/svelte', () => ({
  NodeResizer: () => {}, Handle: () => {}, Position: { Left: 'left', Right: 'right' },
  useUpdateNodeInternals: () => flow.updateNodeInternals,
}));

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
    boardConnections: vi.fn(async (request: BoardConnectionRequest, _signal?: AbortSignal): Promise<BoardConnections> => ({
      scope: symbol, direction: 'outgoing', withMembers: request.members, symbols: [symbol, target, second], total: 2,
      items: request.offset ? [{ target: second, evidence: [{ ...edge, id: 'edge:3', target: second.id, kind: 'contains' }], total: 1 }] : [{ target, evidence: [edge], total: 2 }],
      nextOffset: request.offset ? null : 1, bounded: true, notes: ['Evidence is paged.'], excluded: noExclusions,
    })),
    boardEvidence: vi.fn(async (request: BoardConnectionRequest, _signal?: AbortSignal): Promise<BoardEvidencePage> => ({
      symbols: [symbol, target, second], items: request.target === second.id
        ? [{ ...edge, id: 'edge:3', target: second.id, kind: 'contains' }]
        : [edge, { ...edge, id: 'edge:2', line: 450, provenance: 'heuristic', registeredAt: 'src/wiring.ts:20' }].slice(request.offset ?? 0),
      total: request.target === second.id ? 1 : 2, nextOffset: null, bounded: false, notes: [], excluded: noExclusions,
    })),
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
async function until(assertion: () => void): Promise<void> {
  await vi.waitFor(() => { flushSync(); assertion(); }, { timeout: 5000, interval: 5 });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
  boardRequests.take(); adapter = makeAdapter(); setGraphAdapter(adapter.adapter); navigate = vi.fn(); flow.updateNodeInternals.mockClear();
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
    expect(adapter.calls.boardConnections.mock.calls[0][0]).toMatchObject({ id: symbol.id, direction: 'outgoing', members: true, tests: false, generated: false, uncertain: false, limit: BOARD_SOURCE_TARGET_PAGE });
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

  it('automatically loads a late ambiguous target without ever linking the prefix', async () => {
    const peers = Array.from({ length: 9 }, (_, index) => ({ ...target, id: `method:peer${index}`,
      name: index === 0 || index === 8 ? 'render' : `other${index}`, qualifiedName: index === 0 ? 'A.render' : index === 8 ? 'Z.render' : `Peer.other${index}` }));
    const late = deferred<BoardConnections>();
    const pageFor = (offset: number): BoardConnections => {
      const page = offset ? peers.slice(8) : peers.slice(0, 8);
      return { scope: symbol, direction: 'outgoing', withMembers: true, symbols: [symbol, ...page],
        items: page.map((target) => ({ target, evidence: [{ ...edge, id: `edge:${target.id}`, target: target.id }], total: 1 })),
        total: 9, nextOffset: offset ? null : 8, bounded: false, notes: [], excluded: noExclusions };
    };
    adapter.calls.boardConnections.mockImplementation(async (request) => request.offset ? late.promise : pageFor(0));
    const follow = vi.fn(); renderCard({ follow });
    await until(() => expect(adapter.calls.boardConnections).toHaveBeenCalledTimes(2));
    expect(host.querySelector('.source [role="link"]')).toBeNull();
    expect(host.textContent).toContain('Inline target links wait for complete');
    host.querySelector<HTMLButtonElement>('.target-link')!.click();
    expect(follow).toHaveBeenCalledWith(expect.objectContaining({ id: peers[0].id }), undefined, expect.any(MouseEvent));
    late.resolve(pageFor(8));
    await until(() => expect(host.textContent).toContain('Z.render'));
    await settle();
    expect(host.querySelector('.source [role="link"]')).toBeNull();
    expect(host.textContent).not.toContain('Inline target links wait'); // Complete, but genuinely ambiguous.
    expect(adapter.calls.boardConnections.mock.calls.map(([request]) => request.offset)).toEqual([0, 8]);
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

  it('automatically pages targets and replaces capped previews, retaining raw kind metadata', async () => {
    renderCard();
    await until(() => expect(host.textContent).not.toContain('Loading indexed references…'));
    await until(() => expect(adapter.calls.boardEvidence).toHaveBeenCalledTimes(2));
    await settle();
    button('Show evidence').click(); flushSync();
    expect(adapter.calls.boardEvidence).toHaveBeenCalledWith(expect.objectContaining({ id: symbol.id, target: target.id, offset: 0, limit: BOARD_SOURCE_EVIDENCE_PAGE, tests: false, generated: false, uncertain: false }), expect.any(AbortSignal));
    expect(adapter.calls.boardEvidence).toHaveBeenCalledWith(expect.objectContaining({ target: second.id, offset: 0 }), expect.any(AbortSignal));
    expect(host.textContent).toContain('wired at src/wiring.ts:20');
    expect(adapter.calls.boardConnections.mock.calls[1][0]).toMatchObject({ offset: 1, limit: BOARD_SOURCE_TARGET_PAGE });
    expect(host.textContent).toContain('Loaded kinds: contains');
    expect(host.textContent).not.toContain('Inline target links wait');
    expect(host.querySelector('.source [role="link"]')).not.toBeNull();
    expect(adapter.calls.board).not.toHaveBeenCalled();
  });

  it('automatically completes a class with more than eight targets and forty evidence sites', async () => {
    const peers = Array.from({ length: BOARD_SOURCE_TARGET_PAGE + 1 }, (_, index) => index === 0 ? target
      : { ...second, id: `peer:${index}`, name: `other${index}`, qualifiedName: `Peer.other${index}` });
    const edges = Array.from({ length: BOARD_SOURCE_EVIDENCE_PAGE + 1 }, (_, index) => ({ ...edge, id: `site:${index}` }));
    let active = 0; let maxActive = 0;
    adapter.calls.boardConnections.mockImplementation(async (request) => {
      maxActive = Math.max(maxActive, ++active);
      const offset = request.offset ?? 0;
      const page = peers.slice(offset, offset + request.limit!);
      await Promise.resolve(); active--;
      return { scope: symbol, direction: 'outgoing', withMembers: true, symbols: [symbol, ...page],
        items: page.map((peer) => ({ target: peer, evidence: peer.id === target.id ? edges.slice(0, 10)
          : [{ ...edge, id: `site:${peer.id}`, target: peer.id }], total: peer.id === target.id ? edges.length : 1 })),
        total: peers.length, nextOffset: offset + page.length < peers.length ? offset + page.length : null,
        bounded: offset === 0, notes: ['Evidence per target is a bounded preview.'], excluded: noExclusions };
    });
    adapter.calls.boardEvidence.mockImplementation(async (request) => {
      maxActive = Math.max(maxActive, ++active);
      const peer = peers.find((item) => item.id === request.target)!;
      const all = peer.id === target.id ? edges : [{ ...edge, id: `site:${peer.id}`, target: peer.id }];
      const offset = request.offset ?? 0;
      const items = all.slice(offset, offset + request.limit!);
      await Promise.resolve(); active--;
      return { symbols: [symbol, peer], items, total: all.length,
        nextOffset: offset + items.length < all.length ? offset + items.length : null,
        bounded: false, notes: [], excluded: noExclusions };
    });
    renderCard();
    await until(() => expect(host.querySelector('.source [role="link"]')).not.toBeNull());
    expect(host.querySelectorAll('.target')).toHaveLength(peers.length);
    expect(adapter.calls.boardConnections.mock.calls.map(([request]) => request.offset)).toEqual([0, BOARD_SOURCE_TARGET_PAGE]);
    expect(adapter.calls.boardEvidence.mock.calls.filter(([request]) => request.target === target.id).map(([request]) => request.offset)).toEqual([0, BOARD_SOURCE_EVIDENCE_PAGE]);
    expect(adapter.calls.boardEvidence.mock.calls.every(([request]) => request.limit === BOARD_SOURCE_EVIDENCE_PAGE)).toBe(true);
    expect(host.textContent).toContain(`${edges.length} of ${edges.length} indexed relationships`);
    expect(host.querySelectorAll('.source [role="link"]')).toHaveLength(1);
    expect(maxActive).toBe(1);
    expect(host.textContent).not.toContain('Inline target links wait');
    expect(adapter.calls.board).not.toHaveBeenCalled(); expect(boardRequests.pending).toEqual([]);
  });

  it('keeps hard scope bounds and unknown exclusions suppressing inline links after automatic paging', async () => {
    for (const reason of ['hard-bound', 'unknown-exclusions'] as const) {
      adapter.calls.boardConnections.mockResolvedValue({ scope: symbol, direction: 'outgoing', withMembers: true,
        symbols: [symbol, target], items: [{ target, evidence: [edge], total: 1 }], total: 1, nextOffset: null,
        bounded: true, notes: [], excluded: noExclusions });
      adapter.calls.boardEvidence.mockResolvedValue({ symbols: [symbol, target], items: [edge], total: 1, nextOffset: null,
        bounded: reason === 'hard-bound', notes: [], ...(reason === 'hard-bound' ? { excluded: noExclusions } : {}) });
      const follow = vi.fn(); renderCard({ follow });
      await until(() => expect(adapter.calls.boardEvidence).toHaveBeenCalledTimes(1)); await settle();
      expect(host.querySelector('.source [role="link"]'), reason).toBeNull();
      expect(host.textContent).toContain('Inline target links wait');
      host.querySelector<HTMLButtonElement>('.target-link')!.click();
      expect(follow).toHaveBeenCalledWith(expect.objectContaining({ id: target.id }), undefined, expect.any(MouseEvent));
      await unmount(mounted.pop()!); host.replaceChildren(); adapter.calls.boardEvidence.mockClear();
    }
  });

  it('cancels in-flight evidence on collapse and ignores its late response before a fresh expansion', async () => {
    adapter.calls.boardConnections.mockResolvedValue({ scope: symbol, direction: 'outgoing', withMembers: true,
      symbols: [symbol, target], items: [{ target, evidence: [edge], total: 2 }], total: 1, nextOffset: null,
      bounded: true, notes: [], excluded: noExclusions });
    const late = deferred<BoardEvidencePage>();
    adapter.calls.boardEvidence.mockImplementationOnce(() => late.promise);
    const props = cardProps({ sourceState: vi.fn() }); const values = new SvelteMap([['data', props.data]]);
    mounted.push(mount(BoardSourceCard, { target: host, props: { ...props, get data() { return values.get('data')!; } } }));
    await until(() => expect(adapter.calls.boardEvidence).toHaveBeenCalledTimes(1));
    const signal = adapter.calls.boardEvidence.mock.calls[0][1]!;
    expect(signal.aborted).toBe(false);
    values.set('data', { ...values.get('data')!, collapsed: true }); flushSync();
    expect(signal.aborted).toBe(true);
    expect(props.data.sourceState).toHaveBeenLastCalledWith(symbol.id, expect.objectContaining({ indexed: false }));
    late.resolve({ symbols: [symbol, target], items: [edge, { ...edge, id: 'stale', line: 450 }], total: 2,
      nextOffset: null, bounded: false, notes: [], excluded: noExclusions });
    await settle();
    expect(host.querySelector('.source')).toBeNull();
    expect(adapter.calls.boardEvidence).toHaveBeenCalledTimes(1);
    values.set('data', { ...values.get('data')!, collapsed: false });
    await until(() => expect(host.querySelector('.source [role="link"]')).not.toBeNull());
    expect(adapter.calls.nodes).toHaveBeenCalledTimes(2);
    expect(adapter.calls.boardEvidence).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('stale');
    expect(flow.updateNodeInternals).toHaveBeenCalledWith('card:one');
    expect(flow.updateNodeInternals.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('aborts pending target discovery on unmount without starting late evidence requests', async () => {
    const late = deferred<BoardConnections>();
    adapter.calls.boardConnections.mockImplementationOnce(() => late.promise);
    renderCard(); await until(() => expect(adapter.calls.boardConnections).toHaveBeenCalledTimes(1));
    const signal = adapter.calls.boardConnections.mock.calls[0][1]!;
    await unmount(mounted.pop()!);
    expect(signal.aborted).toBe(true);
    late.resolve({ scope: symbol, direction: 'outgoing', withMembers: true, symbols: [symbol, target],
      items: [{ target, evidence: [edge], total: 2 }], total: 1, nextOffset: null,
      bounded: true, notes: [], excluded: noExclusions });
    await settle();
    expect(host.querySelector('[data-code-card]')).toBeNull();
    expect(adapter.calls.boardEvidence).not.toHaveBeenCalled();
    expect(adapter.calls.boardConnections).toHaveBeenCalledTimes(1);
  });

  it('pauses at the automatic request budget and only continues a larger scope explicitly', async () => {
    adapter.calls.source.mockImplementation(async (request) => ({ ...slice(request), to: 3,
      lines: ['class Container {', 'object.render();', '}'] }));
    const peers = Array.from({ length: BOARD_SOURCE_AUTO_REQUESTS + 1 }, (_, index) => index === 0 ? target
      : { ...second, id: `peer:${index}`, name: `other${index}`, qualifiedName: `Peer.other${index}` });
    adapter.calls.boardConnections.mockImplementation(async (request) => {
      const offset = request.offset ?? 0; const peer = peers[offset];
      return { scope: symbol, direction: 'outgoing', withMembers: true, symbols: [symbol, peer],
        items: [{ target: peer, evidence: [{ ...edge, id: `site:${peer.id}`, target: peer.id }], total: 1 }],
        total: peers.length, nextOffset: offset + 1 < peers.length ? offset + 1 : null,
        bounded: false, notes: [], excluded: noExclusions };
    });
    renderCard();
    await until(() => {
      expect(adapter.calls.boardConnections).toHaveBeenCalledTimes(BOARD_SOURCE_AUTO_REQUESTS);
      expect(host.textContent).not.toContain('Loading indexed references…');
    });
    expect(host.querySelector('.source [role="link"]')).toBeNull();
    expect(host.textContent).toContain('Inline target links wait');
    await settle(); expect(adapter.calls.boardConnections).toHaveBeenCalledTimes(BOARD_SOURCE_AUTO_REQUESTS);
    button(`Continue loading references (${BOARD_SOURCE_AUTO_REQUESTS} of ${peers.length} targets)`).click();
    await until(() => expect(host.querySelector('.source [role="link"]')).not.toBeNull());
    expect(adapter.calls.boardConnections).toHaveBeenCalledTimes(peers.length);
    expect(adapter.calls.boardEvidence).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Continue loading references');
    expect(boardRequests.pending).toEqual([]);
  });

  it.each(['stalled-targets', 'changed-total', 'overlapping-evidence'] as const)('withholds inline links on %s instead of certifying a loaded prefix', async (failure) => {
    adapter.calls.boardConnections.mockImplementation(async (request) => ({ scope: symbol, direction: 'outgoing', withMembers: true,
      symbols: [symbol, target, second],
      items: request.offset ? (failure === 'stalled-targets' ? [] : [{ target: second, evidence: [{ ...edge, id: 'next', target: second.id }], total: 1 }])
        : [{ target, evidence: [edge], total: failure === 'overlapping-evidence' ? 2 : 1 }],
      total: failure === 'overlapping-evidence' ? 1 : request.offset && failure === 'changed-total' ? 3 : 2,
      nextOffset: failure === 'overlapping-evidence' || request.offset ? null : 1,
      bounded: false, notes: [], excluded: noExclusions }));
    adapter.calls.boardEvidence.mockResolvedValue({ symbols: [symbol, target], items: [edge], total: 2,
      nextOffset: null, bounded: false, notes: [], excluded: noExclusions });
    renderCard();
    await until(() => expect(host.textContent).not.toContain('Loading indexed references…'));
    if (failure === 'overlapping-evidence') {
      await until(() => expect(adapter.calls.boardEvidence).toHaveBeenCalledTimes(1));
      button('Show evidence').click(); flushSync();
      await until(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('overlap'));
    } else await until(() => expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/changed|advance/));
    expect(host.querySelector('.source [role="link"]')).toBeNull();
    expect(host.textContent).toContain('Inline target links wait');
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
