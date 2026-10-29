<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { Background, Controls, MiniMap, SvelteFlow, MarkerType, useSvelteFlow, type Edge, type Node } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import BoardSymbolNode from './BoardSymbolNode.svelte';
  import BoardSourceCard from './BoardSourceCard.svelte';
  import BoardRelationEdge from './BoardRelationEdge.svelte';
  import KindGlyph from '../KindGlyph.svelte';
  import { getGraphAdapter } from '../../lib/adapter';
  import { cardFamily, edgeKinds, nodeKinds, kindLabel, relationLabel } from '../../lib/board-catalog';
  import { createBoardModel, nextCodePosition, nextSymbolPosition, type BoardSymbol, type BoardEvidence, type BoardRelation, type SymbolAction, type SymbolData, type SourceCardData } from '../../lib/board-model';
  import type { BoardDocument, BoardLoaded, BoardList, BoardSearch, BoardConnections, BoardConnectionRequest } from '../../lib/board-wire';
  import { live } from '../../lib/live.svelte';

  const adapter = getGraphAdapter();
  const { fitView } = useSvelteFlow();
  const nodeTypes = { symbol: BoardSymbolNode, code: BoardSourceCard };
  const edgeTypes = { relation: BoardRelationEdge };
  type BoardNode = Node<SymbolData, 'symbol'> | Node<SourceCardData, 'code'>;
  let symbols = $state<BoardSymbol[]>([]);
  let relations = $state<BoardEvidence[]>([]);
  let included = $state<string[]>([]);
  let hidden = $state<string[]>([]);
  let expanded = $state<string[]>([]);
  let limits = $state<Record<string, number>>({});
  let nodes = $state<BoardNode[]>([]);
  let viewport = $state({ x: 0, y: 0, zoom: 1 });
  let selected = $state<string | null>(null);
  let locatedMember = $state<string | undefined>();
  let panel = $state<'library' | 'connections' | 'hidden' | 'boards' | null>(null);
  let evidence = $state<BoardRelation | null>(null);
  let kind = $state('');
  let structure = $state(false);
  let notes = $state<string[]>([]);
  let error = $state('');
  let busy = $state(false);
  let saving = $state(false);
  let notice = $state('Add symbols from this project, then use Connections to choose what to include.');
  let hideHistory = $state<string[]>([]);
  let boardName = $state('');
  let boardId = $state<string | undefined>();
  let boardList = $state<BoardList | null>(null);
  let savedFingerprint = $state('');
  let libraryQ = $state('');
  let libraryKind = $state('');
  let libraryPath = $state('');
  let searchPage = $state<BoardSearch | null>(null);
  let searchSelection = $state<string[]>([]);
  let searchBusy = $state(false);
  let connectionScope = $state<string | null>(null);
  let direction = $state<'incoming' | 'outgoing'>('outgoing');
  let withMembers = $state(true);
  let connectionKind = $state('');
  let connectionQ = $state('');
  let connectionPage = $state<BoardConnections | null>(null);
  let connectionBusy = $state(false);
  let connectionSelection = $state<string[]>([]);
  type HistoryEntry = { id: string; direction: 'incoming' | 'outgoing'; members: boolean; kind: string; query: string; page: BoardConnections | null; selected: string[]; scroll: number };
  let history = $state<HistoryEntry[]>([]);
  let importFile = $state<HTMLInputElement>(null!);
  const positions = new Map<string, { x: number; y: number }>();
  const sourceHeights = new Map<string, number>();
  const originalIdentities = new Map<string, BoardDocument['symbols'][number]['identity']>();
  let request = 0; let searchRequest = 0; let connectionRequest = 0; let zIndex = 10; let epoch = 0; let saveEpoch = 0; let saveRequest = 0;
  const model = $derived(createBoardModel(symbols, relations));
  const projection = $derived(model.projectBoard(included, hidden, expanded, kind, structure, limits));
  const lastHidden = $derived([...hideHistory].reverse().find((id) => hidden.includes(id)));
  const codeCount = $derived(nodes.filter((node) => node.type === 'code').length);
  const dirty = $derived(savedFingerprint !== fingerprint());
  const readOnly = $derived(boardList?.readOnly !== false || !adapter.saveBoard);
  const allNodeKinds = $derived([...new Set([...nodeKinds, ...symbols.map((item) => item.kind)])]);
  const allEdgeKinds = $derived([...new Set([...edgeKinds, ...relations.map((item) => item.kind)])]);
  const edges = $derived<Edge[]>(projection.edges.map((edge) => {
    const same = projection.edges.filter((item) => item.source === edge.source && item.target === edge.target);
    const lane = edge.source === edge.target ? 320 + same.indexOf(edge) * 48 : (same.indexOf(edge) - (same.length - 1) / 2) * 56;
    const hot = evidence?.id === edge.id || selected === edge.source || selected === edge.target;
    const uncertain = edge.evidence.some((item) => (item.confidence ?? 1) < 0.6);
    return { id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle,
      type: 'relation', data: { relation: edge, lane }, label: `${relationLabel(edge.kind)}${edge.evidence.length > 1 ? ` · ${edge.evidence.length}` : ''}${edge.via ? ' · synthesized' : ''}${uncertain ? ' · uncertain' : ''}`,
      markerEnd: { type: MarkerType.ArrowClosed, color: hot ? 'var(--accent)' : 'var(--ink-3)' },
      style: `stroke:${hot ? 'var(--accent)' : 'var(--ink-3)'};stroke-width:${hot ? 2 : 1.2};${edge.via || uncertain ? 'stroke-dasharray:6 4;' : ''}`,
      labelStyle: 'color:var(--ink-2);font:10px var(--mono);background:var(--paper);padding:4px 5px', interactionWidth: 20 };
  }));
  function merge(items: BoardSymbol[]) {
    const map = new Map(symbols.map((item) => [item.id, item]));
    for (const item of items) map.set(item.id, { ...map.get(item.id), ...item });
    symbols = [...map.values()];
  }
  function display(id: string) { return symbols.find((item) => item.id === id)?.qualifiedName ?? id; }
  function fail(cause: unknown) { error = cause instanceof Error ? cause.message : String(cause); }
  function refresh() {
    for (const node of nodes) if (node.type === 'symbol') positions.set(node.id, { ...node.position });
    const previous = new Map(nodes.map((node) => [node.id, node]));
    const occupied = nodes.map((node) => ({ position: node.position, width: node.width ?? node.measured?.width, height: node.height ?? node.measured?.height }));
    for (const id of hidden) if (positions.has(id)) occupied.push({ position: positions.get(id)!, width: 286, height: 500 });
    const graph: BoardNode[] = [];
    for (const item of projection.symbols) {
      const old = previous.get(item.symbol.id);
      const position = old?.position ?? positions.get(item.symbol.id) ?? nextSymbolPosition(occupied, { x: 30 + (graph.length % 3) * 400, y: 30 });
      occupied.push({ position, width: 286, height: old?.measured?.height ?? 240 });
      graph.push({ ...old, id: item.symbol.id, type: 'symbol', position, dragHandle: '.board-drag-handle', connectable: false,
        data: { ...item, hidden, pinned: included.filter((id) => !hidden.includes(id)), expanded: expanded.includes(item.symbol.id), locatedMember, act } });
    }
    nodes = [...graph, ...nodes.filter((node) => node.type === 'code')];
  }
  async function loadSnapshot(fit = false) {
    if (!adapter.board) return;
    const current = ++request; error = ''; busy = true;
    try {
      const value = await adapter.board(included.filter((id) => !id.startsWith('missing:')));
      if (current !== request) return;
      merge(value.symbols); relations = value.relations; notes = value.notes;
      if (value.missing.length) notes = [...notes, `${value.missing.length} selected identities no longer resolve. Reload/open the saved board to re-resolve them.`];
      refresh(); if (fit) await fitGraph();
    } catch (cause) { if (current === request) fail(cause); }
    finally { if (current === request) busy = false; }
  }
  async function add(ids: string[]) {
    const unique = [...new Set([...included, ...ids])];
    if (new Set([...unique, ...nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId)]).size > 128) { error = 'A board can retain at most 128 symbol identities including source cards. Narrow the selection first.'; return; }
    included = unique; hidden = hidden.filter((id) => !ids.includes(id)); evidence = null;
    searchSelection = searchSelection.filter((id) => !ids.includes(id)); connectionSelection = [];
    await loadSnapshot(included.length === ids.length);
    notice = `${ids.length} chosen symbol(s) included. No neighbours added. Existing positions preserved.`;
  }
  async function targetAction(id: string) {
    const state = model.targetState(id, included, hidden);
    if (state.status === 'visible') await locate(id);
    else await add([state.status === 'hidden' ? state.representative : id]);
  }
  function choose(values: string[], id: string, checked: boolean) { return checked ? [...new Set([...values, id])] : values.filter((item) => item !== id); }
  async function fitGraph() { await tick(); await fitView({ nodes: nodes.filter((node) => node.type === 'symbol'), padding: 0.16, maxZoom: 1, duration: 200 }); }
  async function fitCode() { await tick(); await fitView({ nodes: nodes.filter((node) => node.type === 'code'), padding: 0.14, maxZoom: 1, duration: 200 }); }
  async function locate(id: string) {
    const state = model.targetState(id, included, hidden); if (state.status !== 'visible') return;
    const owner = state.representative; locatedMember = model.memberOf(id, owner) ?? undefined;
    if (owner !== id) { expanded = [...new Set([...expanded, owner])]; limits = { ...limits, [owner]: model.children(owner).length }; }
    selected = owner; refresh(); nodes = nodes.map((node) => ({ ...node, selected: node.id === owner }));
    await tick(); await fitView({ nodes: [{ id: owner }], padding: 0.5, maxZoom: 1, duration: 200 });
    notice = owner === id ? `Located ${display(id)}.` : `${display(id)} is folded in ${display(owner)}${locatedMember && locatedMember !== id ? ` → ${display(locatedMember)}` : ''}. Containing row highlighted; Pin separately for an exact card.`;
  }
  function act(action: SymbolAction, id: string) {
    error = ''; evidence = null;
    if (action === 'connections') void openConnections(id);
    else if (action === 'restore') void add([id]);
    else if (action === 'hide') {
      hidden = [...new Set([...hidden, id])]; hideHistory = [...hideHistory.filter((item) => item !== id), id]; selected = null; refresh(); notice = `${display(id)} hidden. Undo hide or restore from Connections/Hidden items.`;
    } else if (action === 'expand' || action === 'more') {
      if (action === 'expand') expanded = expanded.includes(id) ? expanded.filter((item) => item !== id) : [...expanded, id];
      else limits = { ...limits, [id]: (limits[id] ?? 6) + 6 };
      refresh();
      if (model.children(id).length < (symbols.find((item) => item.id === id)?.memberCount ?? 0)) notice = 'The loaded member scope is bounded. Browse Connections → contains to page the full indexed contents and pin individual members.';
    } else if (action === 'locate') void locate(id);
    else openCode(id);
  }
  function connectionArgs(offset = 0): BoardConnectionRequest { return { id: connectionScope!, direction, members: withMembers, kind: connectionKind || undefined, q: connectionQ || undefined, offset }; }
  async function loadConnections(offset = 0) {
    if (!adapter.boardConnections || !connectionScope) return;
    const current = ++connectionRequest; connectionBusy = true; error = '';
    try {
      const value = await adapter.boardConnections(connectionArgs(offset));
      if (current !== connectionRequest) return;
      merge([value.scope, ...value.symbols, ...value.items.flatMap((row) => row.owner ? [row.target, row.owner] : [row.target])]);
      connectionPage = offset && connectionPage ? { ...value, items: [...connectionPage.items, ...value.items] } : value;
    } catch (cause) { if (current === connectionRequest) fail(cause); }
    finally { if (current === connectionRequest) connectionBusy = false; }
  }
  async function openConnections(id: string) {
    if (panel === 'connections' && connectionScope) history = [...history, { id: connectionScope, direction, members: withMembers, kind: connectionKind, query: connectionQ, page: connectionPage, selected: [...connectionSelection], scroll: document.querySelector('.connections-panel .result-list')?.scrollTop ?? 0 }];
    else history = [];
    connectionScope = id; direction = 'outgoing'; withMembers = cardFamily(model.symbol(id).kind) === 'type' || model.symbol(id).kind === 'component';
    connectionKind = ''; connectionQ = ''; connectionSelection = []; connectionPage = null; panel = 'connections'; evidence = null;
    await loadConnections();
  }
  async function backConnections() {
    const entry = history.at(-1); if (!entry) return;
    ++connectionRequest; history = history.slice(0, -1); connectionScope = entry.id; direction = entry.direction; withMembers = entry.members;
    connectionKind = entry.kind; connectionQ = entry.query; connectionPage = entry.page; connectionSelection = entry.selected; connectionBusy = false;
    await tick(); const list = document.querySelector('.connections-panel .result-list'); if (list) list.scrollTop = entry.scroll;
  }
  async function moreEvidence(target: string, offset: number) {
    if (!adapter.boardEvidence || !connectionPage) return;
    const current = connectionRequest;
    try {
      const value = await adapter.boardEvidence({ ...connectionArgs(offset), target });
      if (current !== connectionRequest || !connectionPage) return;
      merge(value.symbols);
      connectionPage = { ...connectionPage, items: connectionPage.items.map((row) => row.target.id === target ? { ...row, evidence: [...row.evidence, ...value.items] } : row) };
    } catch (cause) { fail(cause); }
  }
  async function search(offset = 0) {
    if (!adapter.boardSearch) return;
    const current = ++searchRequest; searchBusy = true; error = '';
    try {
      const value = await adapter.boardSearch({ q: libraryQ, kind: libraryKind || undefined, path: libraryPath || undefined, offset });
      if (current !== searchRequest) return;
      merge(value.items); searchPage = offset && searchPage ? { ...value, items: [...searchPage.items, ...value.items] } : value;
    } catch (cause) { if (current === searchRequest) fail(cause); }
    finally { if (current === searchRequest) searchBusy = false; }
  }
  function closeCard(id: string) { nodes = nodes.filter((node) => node.id !== id); sourceHeights.delete(id); }
  function toggleCard(id: string) {
    nodes = nodes.map((node) => {
      if (node.type !== 'code' || node.id !== id) return node;
      if (!node.data.collapsed) sourceHeights.set(id, node.height ?? node.measured?.height ?? 310);
      return { ...node, height: node.data.collapsed ? sourceHeights.get(id) ?? 310 : 82, data: { ...node.data, collapsed: !node.data.collapsed } };
    });
  }
  function readCard(id: string) { void tick().then(() => fitView({ nodes: [{ id }], padding: 0.25, maxZoom: 1.1, duration: 200 })); }
  function openCode(id: string, fit = true) {
    if (codeCount >= 32 && !nodes.some((node) => node.id === `code:${id}`)) { error = 'Close a source card before opening another (maximum 32).'; return; }
    if (new Set([...included, ...nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId), id]).size > 128) { error = 'This board already retains 128 symbol identities. Close a source-only card or start another board.'; return; }
    const item = model.symbol(id); const key = `code:${id}`;
    if (nodes.some((node) => node.id === key)) nodes = nodes.map((node) => ({ ...node, selected: node.id === key, ...(node.id === key ? { zIndex: ++zIndex } : {}) }));
    else {
      const top = Math.max(820, ...nodes.filter((node) => node.type === 'symbol').map((node) => node.position.y + (node.measured?.height ?? 240) + 100));
      nodes = [...nodes.map((node) => ({ ...node, selected: false })), { id: key, type: 'code', position: nextCodePosition(nodes.filter((node) => node.type === 'code'), top), width: 530, height: 310, selected: true, zIndex: ++zIndex, dragHandle: '.board-drag-handle', connectable: false,
        data: { symbolId: id, symbol: item, collapsed: false, close: closeCard, toggle: toggleCard, read: readCard } }];
    }
    if (fit) { panel = null; evidence = null; readCard(key); }
  }
  async function compare(edge: BoardEvidence) { openCode(edge.source, false); openCode(edge.target, false); panel = null; evidence = null; await fitCode(); }
  function tidy() {
    let x = 30; let y = 30; let height = 0;
    nodes = nodes.map((node) => { if (node.type !== 'symbol') return node; if (x > 900) { x = 30; y += height + 100; height = 0; }
      const position = { x, y }; x += 400; height = Math.max(height, node.measured?.height ?? 240); return { ...node, position }; });
    void fitGraph();
  }
  function documentState(): BoardDocument {
    const ids = [...new Set([...included, ...nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId as string)])];
    const keys = new Map(ids.map((id, index) => [id, `s${index}`]));
    return { version: 1, symbols: ids.flatMap((id) => {
      const item = symbols.find((value) => value.id === id); if (!item) return [];
      return [{ key: keys.get(id)!, identity: originalIdentities.get(id) ?? { id: item.id, qualifiedName: item.qualifiedName, kind: item.kind, file: item.file, ...(item.signature ? { signature: item.signature } : {}) },
        position: { ...(nodes.find((node) => node.id === id)?.position ?? positions.get(id) ?? { x: 30, y: 30 }) }, included: included.includes(id), hidden: hidden.includes(id), expanded: expanded.includes(id) }];
    }), cards: nodes.filter((node) => node.type === 'code').map((node, index) => ({ key: `c${index}`, symbolKey: keys.get(node.data.symbolId as string)!, position: { ...node.position }, width: node.width ?? node.measured?.width ?? 530, height: node.data.collapsed ? sourceHeights.get(node.id) ?? 310 : node.height ?? node.measured?.height ?? 310, collapsed: Boolean(node.data.collapsed), zIndex: node.zIndex ?? 10 })),
      viewport: { ...viewport }, filters: { kind, showStructure: structure } };
  }
  function fingerprint(name = boardName, document = documentState()) { return JSON.stringify({ name, document }); }
  async function listBoards() { try { if (adapter.boards) boardList = await adapter.boards(); } catch (cause) { fail(cause); } }
  async function save(asNew = false) {
    if (readOnly || !adapter.saveBoard) return;
    error = ''; saving = true;
    const token = saveEpoch; const operation = ++saveRequest; const name = boardName; const document = documentState();
    try {
      const value = await adapter.saveBoard({ name, ...(!asNew && boardId ? { id: boardId } : {}), document });
      if (token !== saveEpoch || operation !== saveRequest) return;
      boardId = value.id; if (boardName === name) boardName = value.name;
      savedFingerprint = fingerprint(value.name, document); notice = `Saved ${value.name} in .codegraph/ui/boards/.`; await listBoards();
    } catch (cause) { if (token === saveEpoch && operation === saveRequest) fail(cause); } finally { if (operation === saveRequest) saving = false; }
  }
  function canReplace() { return !dirty || window.confirm('This board has unsaved changes. Replace it without saving?'); }
  async function applyLoaded(value: BoardLoaded, token: number, expected: string): Promise<boolean> {
    // Resolve and fetch into locals before changing any reviewer-owned state.
    const mapping = new Map(value.resolutions.filter((item) => item.node).map((item) => [item.key, item.node!.id]));
    const ids = value.board.symbols.filter((item) => item.included && mapping.has(item.key)).map((item) => mapping.get(item.key)!);
    const snapshot = adapter.board ? await adapter.board(ids) : null;
    if (token !== epoch) return false;
    if (expected !== fingerprint()) { notice = 'Board changed while a replacement was loading; newer work was preserved. Retry the operation.'; busy = false; return false; }
    ++request; ++connectionRequest; ++searchRequest;
    originalIdentities.clear(); positions.clear(); sourceHeights.clear();
    const loaded: BoardSymbol[] = [];
    for (const entry of value.board.symbols) {
      const resolution = value.resolutions.find((item) => item.key === entry.key);
      const id = resolution?.node?.id ?? `missing:${entry.key}`;
      mapping.set(entry.key, id); positions.set(id, { ...entry.position });
      originalIdentities.set(id, { ...entry.identity, ...(resolution?.node ? { id } : {}) });
      loaded.push(resolution?.node ?? { id, kind: entry.identity.kind, name: entry.identity.qualifiedName, qualifiedName: entry.identity.qualifiedName, file: entry.identity.file, line: 1, purpose: `${resolution?.status ?? 'missing'}: ${resolution?.note ?? 'Saved symbol is not uniquely present in this index.'}` });
    }
    symbols = [...new Map(loaded.map((item) => [item.id, item])).values()]; nodes = []; relations = snapshot?.relations ?? [];
    if (snapshot) merge(snapshot.symbols); notes = snapshot?.notes ?? [];
    included = [...new Set(value.board.symbols.filter((item) => item.included).map((item) => mapping.get(item.key)!))];
    hidden = [...new Set(value.board.symbols.filter((item) => item.hidden).map((item) => mapping.get(item.key)!))];
    expanded = [...new Set(value.board.symbols.filter((item) => item.expanded).map((item) => mapping.get(item.key)!))];
    kind = value.board.filters.kind; structure = value.board.filters.showStructure; limits = {}; history = []; hideHistory = [];
    panel = null; evidence = null; selected = null; locatedMember = undefined;
    refresh();
    for (const card of value.board.cards) {
      const id = mapping.get(card.symbolKey); if (!id) continue;
      openCode(id, false);
      nodes = nodes.map((node) => node.id === `code:${id}` && node.type === 'code' ? { ...node, position: { ...card.position }, width: card.width, height: card.collapsed ? 82 : card.height, zIndex: card.zIndex, selected: false, data: { ...node.data, collapsed: card.collapsed } } : node);
      sourceHeights.set(`code:${id}`, card.height);
      zIndex = Math.max(zIndex, card.zIndex);
    }
    viewport = { ...value.board.viewport };
    notice = 'Board restored; missing or ambiguous symbols are labelled placeholders. No fuzzy replacements.';
    return true;
  }
  async function openBoard(id: string) {
    if (!adapter.loadBoard || !canReplace()) return;
    const token = ++epoch; const expected = fingerprint(); busy = true;
    try {
      const value = await adapter.loadBoard(id);
      if (await applyLoaded(value, token, expected)) { ++saveEpoch; ++saveRequest; saving = false; boardId = id; boardName = boardList?.boards.find((item) => item.id === id)?.name ?? ''; savedFingerprint = fingerprint(); }
    } catch (cause) { if (token === epoch) fail(cause); } finally { if (token === epoch) busy = false; }
  }
  async function removeBoard(id: string) {
    if (readOnly || !adapter.deleteBoard || !window.confirm('Delete this saved board metadata? Source and graph are unchanged.')) return;
    try { await adapter.deleteBoard(id); if (boardId === id) { boardId = undefined; savedFingerprint = ''; } await listBoards(); } catch (cause) { fail(cause); }
  }
  function newBoard() {
    if (!canReplace()) return;
    ++epoch; ++saveEpoch; ++saveRequest; ++request; ++searchRequest; ++connectionRequest; busy = false; saving = false; symbols = []; relations = []; included = []; hidden = []; expanded = []; nodes = []; originalIdentities.clear(); positions.clear();
    boardId = undefined; boardName = ''; kind = ''; structure = false; panel = null; evidence = null; viewport = { x: 0, y: 0, zoom: 1 };
    savedFingerprint = fingerprint(); notes = []; error = ''; notice = 'New empty board. Add only the symbols you choose.';
  }
  function exportBoard() {
    const blob = new Blob([JSON.stringify({ name: boardName || 'Review board', document: documentState() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'review-board.json'; link.click(); URL.revokeObjectURL(url);
  }
  async function importBoard(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0]; if (!file || !canReplace()) return;
    const token = ++epoch; const expected = fingerprint(); busy = true;
    try {
      if (file.size > 1024 * 1024) throw new Error('Board import exceeds 1 MiB.');
      const value = JSON.parse(await file.text()) as { name?: string; document?: BoardDocument };
      if (!adapter.resolveBoard) throw new Error('This host cannot validate/resolve imported boards.');
      const loaded = await adapter.resolveBoard(value.document ?? value as unknown as BoardDocument);
      if (await applyLoaded(loaded, token, expected)) { ++saveEpoch; ++saveRequest; saving = false; boardId = undefined; boardName = typeof value.name === 'string' ? value.name.slice(0, 120) : 'Imported board'; savedFingerprint = ''; notice = 'Imported into memory only. Save as to keep a project-local copy.'; }
    } catch (cause) { if (token === epoch) fail(cause); } finally { importFile.value = ''; if (token === epoch) busy = false; }
  }
  function showEvidence(edge: Edge) { if (edge.data?.relation) { evidence = edge.data.relation as BoardRelation; panel = null; } }
  function beforeUnload(event: BeforeUnloadEvent) { if (dirty) { event.preventDefault(); event.returnValue = ''; } }
  function onkeydown(event: KeyboardEvent) { if (event.key === 'Escape') { panel = null; evidence = null; } }
  async function refreshIndex() {
    if (!adapter.resolveBoard || !documentState().symbols.length) return;
    const token = ++epoch; const expected = fingerprint(); const wasDirty = dirty; busy = true;
    try {
      const loaded = await adapter.resolveBoard(documentState());
      if (await applyLoaded(loaded, token, expected)) { if (!wasDirty) savedFingerprint = fingerprint(); notice = 'Index refreshed; identities re-resolved and arrangement preserved.'; }
    } catch (cause) { if (token === epoch) fail(cause); } finally { if (token === epoch) busy = false; }
  }
  let seenIndex = live.indexTick;
  $effect(() => { const value = live.indexTick; if (value !== seenIndex) { seenIndex = value; untrack(() => { void refreshIndex(); }); } });
  onMount(() => { void listBoards(); savedFingerprint = fingerprint(); });
</script>

<svelte:window onbeforeunload={beforeUnload} {onkeydown} />
{#if !adapter.board || !adapter.boardSearch || !adapter.boardConnections}
  <p class="unavailable">This host does not provide Review Board graph queries.</p>
{:else}
<div class="board">
  <div class="toolbar">
    <div class="tools"><button class="primary" onclick={() => { panel = 'library'; evidence = null; void search(); }}>+ Add symbols</button><button onclick={() => { panel = 'hidden'; evidence = null; }}>Hidden items ({hidden.length})</button>{#if lastHidden}<button onclick={() => add([lastHidden!])}>Undo hide</button>{/if}
      <label>Edges <select aria-label="Canvas relationship filter" bind:value={kind} onchange={() => { evidence = null; refresh(); }}><option value="">All kinds</option>{#each allEdgeKinds as item}<option value={item}>{kindLabel(item)}</option>{/each}</select></label>
      <label><input type="checkbox" bind:checked={structure} onchange={refresh} /> Ownership arrows</label>
    </div>
    <div class="tools"><button disabled={busy} onclick={refreshIndex}>Refresh index</button><button onclick={fitGraph}>Fit graph</button><button disabled={!codeCount} onclick={fitCode}>Fit code ({codeCount})</button><button onclick={tidy}>Tidy</button><button onclick={() => { panel = 'boards'; evidence = null; void listBoards(); }}>Saved boards</button><button onclick={newBoard}>New</button></div>
  </div>
  <div class="savebar"><input aria-label="Board name" placeholder="Name this board…" bind:value={boardName} maxlength={120} /><button disabled={readOnly || busy || saving || !boardName.trim()} onclick={() => save()}>Save</button><button disabled={readOnly || busy || saving || !boardName.trim()} onclick={() => save(true)}>Save as</button>
    <span>{dirty ? 'Unsaved changes' : boardId ? 'Saved' : 'New board'}{readOnly ? ` · ${boardList?.readOnlyReason ?? 'Read-only host'}` : ' · metadata only'}</span>
    <button onclick={exportBoard}>Export JSON</button><button disabled={!adapter.resolveBoard} onclick={() => importFile.click()}>Import JSON</button><input class="file-input" type="file" accept="application/json,.json" bind:this={importFile} onchange={importBoard} />
  </div>
  {#if error}<div class="error" role="alert">{error}<button onclick={() => error = ''} aria-label="Dismiss board error">×</button></div>{/if}
  {#if notes.length}<details class="bounds"><summary>Index boundaries / query limits ({notes.length})</summary>{#each notes as note}<p>{note}</p>{/each}</details>{/if}
  <div class="canvas" aria-label="Review board canvas">
    <SvelteFlow bind:nodes bind:viewport {edges} {nodeTypes} {edgeTypes} minZoom={0.15} maxZoom={1.6} nodesConnectable={false} deleteKey={null} zoomOnDoubleClick={false} panOnDrag proOptions={{ hideAttribution: true }}
      onnodeclick={({ node }) => { selected = node.type === 'symbol' ? node.id : node.data.symbolId; if (node.type === 'code') nodes = nodes.map((item) => item.id === node.id ? { ...item, zIndex: ++zIndex } : item); }}
      onedgeclick={({ edge }) => showEvidence(edge)} onselectionchange={({ edges: selectedEdges }) => { if (selectedEdges.length === 1) showEvidence(selectedEdges[0]!); }} onpaneclick={() => { selected = null; evidence = null; }}>
      <Background gap={24} size={1} patternColor="var(--rule-soft)" /><Controls showLock={false} /><MiniMap pannable zoomable nodeColor={(node) => node.type === 'code' ? 'var(--press-2)' : 'var(--accent)'} />
    </SvelteFlow>
    {#if !included.length}<section class="empty"><h2>Choose what you want to understand</h2><p>Add symbols from this index. Connections helps you follow only the targets you choose.</p></section>{/if}
    {#if panel === 'library'}
      <aside class="panel library" aria-label="Symbol library"><div class="panel-heading"><h2>Add symbols</h2><button aria-label="Close symbol library" onclick={() => panel = null}>×</button></div>
        <form onsubmit={(event) => { event.preventDefault(); void search(); }}><label class="field">Search<input aria-label="Search indexed symbols" bind:value={libraryQ} placeholder="Name or qualified name" /></label>
          <div class="filter-row"><label class="field">Kind<select aria-label="Symbol kind filter" bind:value={libraryKind}><option value="">All kinds</option>{#each allNodeKinds as item}<option value={item}>{kindLabel(item)}</option>{/each}</select></label><label class="field">Folder / file prefix<input aria-label="Symbol path filter" bind:value={libraryPath} placeholder="src/" /></label></div><button class="search" type="submit">Search index</button></form>
        <div class="batch"><span>{searchPage?.total ?? 0} matches{searchPage?.bounded ? ' · bounded' : ''}</span><button disabled={!searchSelection.length} onclick={() => add(searchSelection)}>Add selected ({searchSelection.length})</button></div>
        <div class="result-list">{#each searchPage?.items ?? [] as item (item.id)}{@const state = model.targetState(item.id, included, hidden)}<section class="result"><label class="choice"><input type="checkbox" checked={searchSelection.includes(item.id)} aria-label={`Select ${item.qualifiedName}`} onchange={(event) => searchSelection = choose(searchSelection, item.id, event.currentTarget.checked)} /><KindGlyph kind={item.kind} /><strong>{item.name}</strong></label><small>{item.kind} · {item.qualifiedName} · {item.file}:{item.line}</small>
          <div class="row-actions"><button aria-label={`${state.status === 'visible' ? 'Locate' : state.status === 'hidden' ? 'Restore' : 'Add'} ${item.qualifiedName}`} onclick={() => targetAction(item.id)}>{state.status === 'visible' ? state.representative === item.id ? 'Pinned · Locate' : 'Folded · Locate' : state.status === 'hidden' ? 'Restore' : 'Add to board'}</button>{#if state.status === 'visible' && state.representative !== item.id}<button onclick={() => add([item.id])}>Pin separately</button>{/if}<button onclick={() => openCode(item.id)}>Source</button></div></section>{/each}
          {#if searchPage?.nextOffset !== null && searchPage?.nextOffset !== undefined}<button class="more" disabled={searchBusy} onclick={() => search(searchPage!.nextOffset!)}>Show more</button>{/if}{#if searchBusy}<p>Searching…</p>{/if}</div>
      </aside>
    {:else if panel === 'connections' && connectionScope}
      <aside class="panel connections-panel" aria-label="Connections browser"><div class="panel-heading">{#if history.length}<button class="back" aria-label="Back to previous connections" onclick={backConnections}>← Back</button>{/if}<h2>Connections</h2><button aria-label="Close connections" onclick={() => panel = null}>×</button></div>
        <div class="scope">{display(connectionScope)} · {withMembers ? 'with contained members' : 'this symbol only'}</div>
        <div class="direction"><button class:active={direction === 'outgoing'} onclick={() => { direction = 'outgoing'; connectionSelection = []; void loadConnections(); }}>Outgoing</button><button class:active={direction === 'incoming'} onclick={() => { direction = 'incoming'; connectionSelection = []; void loadConnections(); }}>Incoming</button><label><input type="checkbox" bind:checked={withMembers} onchange={() => { connectionSelection = []; void loadConnections(); }} /> Members</label></div>
        <form onsubmit={(event) => { event.preventDefault(); void loadConnections(); }}><div class="filter-row"><label class="field">Relationship<select aria-label="Connection relationship filter" bind:value={connectionKind} onchange={() => loadConnections()}><option value="">All kinds</option>{#each allEdgeKinds as item}<option value={item}>{kindLabel(item)}</option>{/each}</select></label><label class="field">Targets<input aria-label="Search connection targets" bind:value={connectionQ} placeholder="Name…" /></label><button type="submit">Find</button></div></form>
        <div class="batch"><span>{connectionPage?.total ?? 0} targets{connectionPage?.bounded ? ' · bounded scope/evidence' : ''}</span><button disabled={!connectionSelection.length} onclick={() => add([...new Set(connectionSelection.map((id) => { const state = model.targetState(id, included, hidden); return state.status === 'hidden' ? state.representative : id; }))])}>Add selected ({connectionSelection.length})</button></div>
        <div class="result-list">{#each connectionPage?.notes ?? [] as note}<p class="hint">{note}</p>{/each}{#each connectionPage?.items ?? [] as row (row.target.id)}{@const state = model.targetState(row.target.id, included, hidden)}
          <section class="result" data-connection-target={row.target.id}><label class="choice"><input type="checkbox" aria-label={`Select target ${row.target.qualifiedName}`} disabled={state.status === 'visible'} checked={connectionSelection.includes(row.target.id)} onchange={(event) => connectionSelection = choose(connectionSelection, row.target.id, event.currentTarget.checked)} /><KindGlyph kind={row.target.kind} /><strong>{row.target.name}</strong></label><small>{row.target.kind} · {row.target.qualifiedName} · {row.target.file}</small>
            <div class="tags">{#each [...new Set(row.evidence.map((edge) => edge.kind))] as item}<span>{kindLabel(item)}</span>{/each}</div><p>{state.status === 'visible' ? state.representative === row.target.id ? 'Pinned on board' : `Folded in ${display(state.representative)}` : state.status === 'hidden' ? `Hidden in ${display(state.representative)}` : 'Not on board'}</p>
            <div class="row-actions"><button aria-label={`${state.status === 'visible' ? 'Locate' : state.status === 'hidden' ? 'Restore' : 'Add'} target ${row.target.qualifiedName}`} onclick={() => targetAction(row.target.id)}>{state.status === 'visible' ? 'Locate' : state.status === 'hidden' ? 'Restore' : 'Add to board'}</button>{#if row.owner}<button onclick={() => targetAction(row.owner!.id)}>Owner: {row.owner.name}</button>{/if}{#if state.status === 'visible' && state.representative !== row.target.id}<button onclick={() => add([row.target.id])}>Pin separately</button>{/if}<button onclick={() => openCode(row.target.id)}>Source</button><button onclick={() => openConnections(row.target.id)}>Connections</button></div>
            <details><summary>{row.total} indexed evidence items</summary>{#each row.evidence as edge (edge.id)}<div class="evidence-row"><b>{display(edge.source)}</b> → {relationLabel(edge.kind)} → <b>{display(edge.target)}</b><small>{edge.file ?? 'Indexed edge'}{edge.line ? `:${edge.line}` : ''} · {edge.provenance ?? 'provenance unspecified'}{edge.confidence !== undefined ? ` · confidence ${edge.confidence}` : ''}</small>{#if edge.via || edge.synthesizedBy}<p>{edge.via ?? edge.synthesizedBy} {edge.registeredAt ?? ''}</p>{/if}<button onclick={() => compare(edge)}>Compare source ↗</button></div>{/each}{#if row.evidence.length < row.total}<button onclick={() => moreEvidence(row.target.id, row.evidence.length)}>More evidence ({row.total - row.evidence.length})</button>{/if}</details>
          </section>{/each}
          {#if connectionPage?.nextOffset !== null && connectionPage?.nextOffset !== undefined}<button class="more" disabled={connectionBusy} onclick={() => loadConnections(connectionPage!.nextOffset!)}>Show more targets</button>{/if}{#if connectionBusy}<p>Loading connections…</p>{/if}
        </div>
      </aside>
    {:else if panel === 'hidden'}
      <aside class="panel" aria-label="Hidden items"><div class="panel-heading"><h2>Hidden items ({hidden.length})</h2><button onclick={() => panel = null} aria-label="Close hidden items">×</button></div><div class="result-list">{#each hidden as id}<section class="result"><strong>{display(id)}</strong><button onclick={() => add([id])}>Restore</button></section>{:else}<p class="hint">Nothing hidden.</p>{/each}</div></aside>
    {:else if panel === 'boards'}
      <aside class="panel" aria-label="Saved boards"><div class="panel-heading"><h2>Saved boards</h2><button onclick={() => panel = null} aria-label="Close saved boards">×</button></div><p class="hint">{boardList?.directory ?? '.codegraph/ui/boards/'} · {boardList?.skipped ?? 0} unreadable files skipped{boardList?.bounded ? ' · list bounded' : ''}</p><div class="result-list">{#each boardList?.boards ?? [] as item}<section class="result"><strong>{item.name}</strong><small>{item.updatedAt}</small><div class="row-actions"><button onclick={() => openBoard(item.id)}>Open {item.name}</button><button disabled={readOnly} onclick={() => removeBoard(item.id)}>Delete</button></div></section>{:else}<p class="hint">No saved boards.</p>{/each}</div></aside>
    {/if}
    {#if evidence}<aside class="panel" aria-label="Relationship evidence"><div class="panel-heading"><h2>{relationLabel(evidence.kind)}</h2><button onclick={() => evidence = null} aria-label="Close relationship evidence">×</button></div><p class="hint">{evidence.evidence.length} shown indexed edges. Browse Connections for full paged evidence when this projection is bounded.</p><div class="result-list">{#each evidence.evidence as edge (edge.id)}<section class="result"><strong>{display(edge.source)}</strong><span>→ {relationLabel(edge.kind)} →</span><strong>{display(edge.target)}</strong><small>{edge.file ?? ''}:{edge.line ?? ''} · {edge.provenance ?? 'unspecified'} · {edge.confidence ?? 'confidence unspecified'}</small>{#if edge.via || edge.synthesizedBy}<p>{edge.via ?? edge.synthesizedBy} {edge.registeredAt ?? ''}</p>{/if}<button onclick={() => compare(edge)}>Compare source ↗</button></section>{/each}</div></aside>{/if}
    <div class="notice" role="status">{busy ? 'Loading board…' : notice}</div>
  </div>
</div>
{/if}

<style>
  .board { height: 100%; display: flex; flex-direction: column; color: var(--ink); background: var(--paper); }
  .toolbar, .savebar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--rule-soft); flex-shrink: 0; }
  .toolbar { justify-content: space-between; }
  .tools { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  button { font-size: 11px; padding: 5px 8px; border: 1px solid var(--rule-soft); }
  button:hover:not(:disabled) { background: var(--press); }
  button:disabled { opacity: .45; }
  .primary { background: var(--accent); color: var(--paper); border-color: var(--accent); }
  label, .savebar span { font-size: 11px; color: var(--ink-2); }
  select, input:not([type=checkbox]) { background: var(--paper-2); border: 1px solid var(--rule-soft); padding: 5px 7px; font-size: 11px; color: var(--ink); min-width: 0; }
  .savebar input { width: 180px; }
  .savebar span { flex: 1; }
  .file-input { display: none; }
  input[type=checkbox] { accent-color: var(--accent); }
  .canvas { flex: 1; min-height: 0; position: relative; overflow: hidden; }
  .panel { position: absolute; z-index: 20; right: 14px; top: 12px; bottom: 45px; width: min(390px, calc(100% - 28px)); display: flex; flex-direction: column; background: var(--paper); border: 1px solid var(--rule); overflow: hidden; }
  .panel > :not(.result-list) { flex-shrink: 0; }
  .library { left: 14px; right: auto; }
  .panel-heading { display: flex; align-items: center; gap: 8px; justify-content: space-between; padding: 9px 12px; border-bottom: 1px solid var(--rule-soft); }
  h2 { margin: 0; font-size: 14px; }
  .panel-heading button { border: 0; padding: 2px 5px; }
  .scope { padding: 6px 12px; font: 11px var(--mono); overflow-wrap: anywhere; }
  .direction, .batch { display: flex; gap: 8px; align-items: center; padding: 5px 12px; flex-wrap: wrap; }
  .direction .active { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
  .batch span { font-size: 10px; flex: 1; }
  .field { display: flex; flex-direction: column; gap: 3px; padding: 5px 12px; flex: 1; min-width: 0; }
  .filter-row { display: flex; align-items: flex-end; }
  .filter-row button { margin: 0 12px 5px 0; }
  .filter-row .field:first-child { padding-right: 4px; }
  .filter-row .field:nth-child(2) { padding-left: 4px; }
  .search { margin: 3px 12px; }
  .result-list { overflow: auto; min-height: 70px; flex: 1; border-top: 1px solid var(--rule-soft); }
  .result { padding: 10px 12px; border-bottom: 1px solid var(--rule-soft); display: flex; flex-direction: column; gap: 6px; }
  .choice { display: flex; gap: 7px; align-items: center; }
  strong { font: 12px var(--mono); overflow-wrap: anywhere; }
  small { font: 10px var(--mono); color: var(--ink-3); overflow-wrap: anywhere; }
  p { font-size: 11px; line-height: 1.5; margin: 3px 0; }
  .row-actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .row-actions button { padding: 0; border: 0; text-decoration: underline; color: var(--accent); text-underline-offset: 3px; }
  .tags { display: flex; gap: 5px; flex-wrap: wrap; }
  .tags span { font: 10px var(--mono); background: var(--paper-2); padding: 2px 4px; border: 1px solid var(--rule-soft); }
  summary { font-size: 11px; cursor: pointer; }
  .evidence-row { padding: 7px 0; border-top: 1px solid var(--rule-faint); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
  .evidence-row b { font: 11px var(--mono); }
  .evidence-row small { display: block; }
  .more { margin: 10px 12px; }
  .hint { padding: 7px 12px; color: var(--ink-2); }
  .error { padding: 7px 14px; border-bottom: 1px solid var(--accent); font-size: 12px; display: flex; justify-content: space-between; background: var(--accent-soft); }
  .bounds { padding: 5px 14px; border-bottom: 1px solid var(--rule-soft); max-height: 100px; overflow: auto; }
  .empty { position: absolute; inset: 25% 25%; text-align: center; pointer-events: none; }
  .empty p { color: var(--ink-2); font-size: 13px; margin-top: 10px; }
  .notice { position: absolute; bottom: 10px; left: 15px; background: var(--paper); font-size: 10px; color: var(--ink-2); max-width: calc(100% - 200px); padding: 3px 6px; pointer-events: none; }
  .unavailable { padding: 24px; }
  .canvas :global(.svelte-flow__minimap) { width: 120px; height: 80px; }
</style>
