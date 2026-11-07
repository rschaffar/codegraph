<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { Background, Controls, MiniMap, SvelteFlow, MarkerType, SelectionMode, useSvelteFlow, useStore, type Edge, type Node } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import BoardSymbolNode from './BoardSymbolNode.svelte';
  import BoardSourceCard from './BoardSourceCard.svelte';
  import BoardRelationEdge from './BoardRelationEdge.svelte';
  import KindGlyph from '../KindGlyph.svelte';
  import { getGraphAdapter } from '../../lib/adapter';
  import { cardFamily, edgeKinds, nodeKinds, kindLabel, relationLabel, relationColor } from '../../lib/board-catalog';
  import { createBoardModel, edgeLaneMap, mergeBoardFacts, isBoardEvidenceUncertain, BOARD_MEMBER_REVEAL_LIMIT, nextSymbolPosition, type BoardMemberPageState, type BoardSymbol, type BoardEvidence, type BoardRelation, type SymbolAction, type SymbolData, type SourceCardData } from '../../lib/board-model';
  import type { BoardSnapshot, BoardDocument, BoardLoaded, BoardList, BoardSearch, BoardConnections, BoardConnectionRequest, BoardGroups } from '../../lib/board-wire';
  import { live } from '../../lib/live.svelte';
  import { boardRequests } from '../../lib/board-requests.svelte';
  import { boardSourceRelations, boardSourceAnchors, boardSiblingSourceCapacity } from '../../lib/board-source-relations';
  import { boardSourceDetachments, boardSourceDetachTargets } from '../../lib/board-source-detachments';

  const adapter = getGraphAdapter();
  const { fitView, screenToFlowPosition, getIntersectingNodes } = useSvelteFlow();
  const flow = $derived(useStore());
  const nodeTypes = { symbol: BoardSymbolNode, code: BoardSourceCard };
  const edgeTypes = { relation: BoardRelationEdge };
  type BoardNode = Node<SymbolData, 'symbol'> | Node<SourceCardData, 'code'>;
  let symbols = $state<BoardSymbol[]>([]);
  let relations = $state<BoardEvidence[]>([]);
  let sourceSnapshot = $state<BoardSnapshot | null>(null);
  let sourceSnapshotVersion = $state({ indexTick: -1, diskTick: -1 });
  let sourceStates = $state<Record<string, { indexed: boolean; indexTick: number; diskTick: number }>>({});
  let sourceNotes = $state<string[]>([]);
  let sourceError = $state('');
  let siblingsBusy = $state(false);
  let siblingController: AbortController | null = null;
  let included = $state<string[]>([]);
  let hidden = $state<string[]>([]);
  let expanded = $state<string[]>([]);
  let limits = $state<Record<string, number>>({});
  let nodes = $state<BoardNode[]>([]);
  let viewport = $state({ x: 0, y: 0, zoom: 1 });
  let selected = $state<string | null>(null);
  let selectedSources = $state<string[]>([]);
  let rectangleBase: string[] = [];
  let rectangleOrigin: { x: number; y: number } | null = null;
  let selectingRectangle = false;
  let locatedMember = $state<string | undefined>();
  let panel = $state<'library' | 'connections' | 'hidden' | 'boards' | null>(null);
  let evidence = $state<BoardRelation | null>(null);
  let kind = $state('');
  let structure = $state(false);
  let includeTests = $state(false);
  let includeGenerated = $state(false);
  let includeUncertain = $state(false);
  let excluded = $state<BoardSnapshot['excluded']>();
  let libraryMode = $state<'symbols' | 'folder' | 'namespace'>('symbols');
  let groupQuery = $state('');
  let groupPage = $state<BoardGroups | null>(null);
  let activeGroup = $state<Parameters<NonNullable<typeof adapter.boardGroups>>[0] | null>(null);
  let groupBusy = $state(false);
  let libraryNamespace = $state('');
  let namespaceName = $state('');
  let helpOpen = $state(false);
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
  let activeSearch = $state<Parameters<NonNullable<typeof adapter.boardSearch>>[0] | null>(null);
  type CompletedConnections = { criteria: BoardConnectionRequest; page: BoardConnections };
  let completedConnection = $state<CompletedConnections | null>(null);
  const activeConnection = $derived(completedConnection?.criteria ?? null);
  let pendingConnection: BoardConnectionRequest | null = null;
  let memberPages = $state<Record<string, BoardMemberPageState>>({});
  let memberGeneration = 0;
  let connectionScope = $state<string | null>(null);
  let direction = $state<'incoming' | 'outgoing'>('outgoing');
  let withMembers = $state(true);
  let connectionKind = $state('');
  let connectionQ = $state('');
  const connectionPage = $derived(completedConnection?.page ?? null);
  let connectionBusy = $state(false);
  let connectionSelection = $state<string[]>([]);
  type HistoryEntry = { criteria: BoardConnectionRequest; completed: CompletedConnections | null; query: string; selected: string[]; scroll: number };
  let history = $state<HistoryEntry[]>([]);
  let pendingEvidence = $state<Record<string, number>>({});
  let importFile = $state<HTMLInputElement>(null!);
  let boardElement = $state<HTMLDivElement>(null!);
  let returnFocus: HTMLElement | null = null;
  const positions = new Map<string, { x: number; y: number }>();
  let snapshotIds = new Set<string>();
  let eligibleIds = $state<ReadonlySet<string>>(new Set());
  const sourceHeights = new Map<string, number>();
  const originalIdentities = new Map<string, BoardDocument['symbols'][number]['identity']>();
  let request = 0; let searchRequest = 0; let connectionRequest = $state(0); let groupRequest = 0; let zIndex = 10; let epoch = 0; let saveEpoch = 0; let saveRequest = 0;
  let listRequest = 0; let deletionSerial = 0;
  const deletedAfter = new Map<string, number>();
  const pendingSaves = new Map<number, { id?: string; resultId?: string; promise: ReturnType<NonNullable<typeof adapter.saveBoard>> }>();
  let pendingReplacement: { id?: string; token: number } | null = null;
  let deletingIds = $state<string[]>([]);
  const model = $derived(createBoardModel(symbols, relations));
  const filters = $derived({ tests: includeTests, generated: includeGenerated, uncertain: includeUncertain });
  const projection = $derived(model.projectBoard(included, hidden, expanded, kind, structure, limits, { ...filters, locatedMember, memberPages, eligibleIds }));
  const sourceIdsKey = $derived(JSON.stringify(nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId).sort()));
  const sourceIdentityKey = $derived(JSON.stringify(nodes.filter((node) => node.type === 'code').map((node) => node.data.symbol).sort((a, b) => a.id.localeCompare(b.id))));
  function sourceReady(id: string): boolean {
    const state = sourceStates[id];
    return !!state?.indexed && state.indexTick === live.indexTick && state.diskTick === live.diskTick &&
      sourceSnapshotVersion.indexTick === live.indexTick && sourceSnapshotVersion.diskTick === live.diskTick;
  }
  // Choose representatives from every open card before checking readiness. A
  // collapsed/loading detached method must never fall back into its class code.
  const sourceEdges = $derived(boardSourceRelations(sourceSnapshot?.symbols ?? [], sourceSnapshot?.relations ?? [],
    JSON.parse(sourceIdsKey) as string[], kind).filter((edge) => sourceReady(edge.source.slice(5)) && sourceReady(edge.target.slice(5))));
  const sourceDetachments = $derived(boardSourceDetachments(sourceSnapshot?.symbols ?? [], JSON.parse(sourceIdentityKey) as BoardSymbol[])
    .filter((item) => sourceReady(item.owner.id)));
  const detachTargets = $derived.by(() => {
    const open = new Set(JSON.parse(sourceIdsKey) as string[]);
    const eligible = new Set(sourceSnapshot?.scopeIds ?? sourceSnapshot?.symbols.map((item) => item.id) ?? []);
    return boardSourceDetachTargets(sourceSnapshot?.symbols ?? [], JSON.parse(sourceIdentityKey) as BoardSymbol[])
      .filter((item) => sourceReady(item.owner.id) && eligible.has(item.member.id) && !open.has(item.member.id));
  });
  const canvasRelations = $derived([...projection.edges, ...sourceEdges]);
  const lanes = $derived(new Map([...edgeLaneMap(projection.edges), ...edgeLaneMap(sourceEdges, true)]));
  const sourceAnchorGroups = $derived(new Map((JSON.parse(sourceIdsKey) as string[]).map((id) => [id, {
    anchors: [...boardSourceAnchors(sourceEdges, id), ...sourceDetachments.filter((item) => item.owner.id === id)
      .map((item) => ({ id: `source-detached:${item.member.id}`, line: item.fold?.start ?? item.anchorLine, direction: 'outgoing' as const }))],
    folds: sourceDetachments.filter((item) => item.owner.id === id).flatMap((item) => item.fold ? [{ ...item.fold, id: item.member.id }] : []),
    owners: sourceDetachments.filter((item) => item.member.id === id).map((item) => item.owner),
    detachable: detachTargets.filter((item) => item.owner.id === id).map((item) => item.member),
  }])));
  const detachedEdges = $derived<Edge[]>(sourceDetachments.map((item) => ({
    id: `source-detachment:${JSON.stringify([item.owner.id, item.member.id])}`, source: `code:${item.owner.id}`, target: `code:${item.member.id}`,
    sourceHandle: `source-detached:${item.member.id}`, targetHandle: 'source-owner', type: 'relation', selectable: false,
    ariaLabel: `Detached source ${item.member.qualifiedName} from ${item.owner.qualifiedName}`,
    label: 'detached source', data: { lane: 0, detachedMember: item.member.id, presentationOnly: true },
    style: 'stroke:var(--ink-3);stroke-width:1;stroke-dasharray:2 5;',
    labelStyle: 'color:var(--ink-3);font:10px var(--mono);background:var(--paper);padding:3px', interactionWidth: 12,
  })));
  $effect(() => {
    const groups = sourceAnchorGroups;
    untrack(() => {
      let changed = false;
      const next = nodes.map((node) => {
        if (node.type !== 'code') return node;
        const group = groups.get(node.data.symbolId) ?? { anchors: [], folds: [], owners: [], detachable: [] };
        if (JSON.stringify([node.data.sourceAnchors ?? [], node.data.sourceFolds ?? [], node.data.sourceOwners ?? [], node.data.detachableSources ?? []]) === JSON.stringify([group.anchors, group.folds, group.owners, group.detachable])) return node;
        changed = true;
        return { ...node, data: { ...node.data, sourceAnchors: group.anchors, sourceFolds: group.folds, sourceOwners: group.owners,
          detachableSources: group.detachable, detachSource, locateDetached: locateDetachedSource, reattachSource } };
      });
      if (changed) nodes = next;
    });
  });
  const related = $derived(model.sourceSelection(selectedSources, included, hidden));
  const lastHidden = $derived([...hideHistory].reverse().find((id) => hidden.includes(id)));
  const codeCount = $derived(nodes.filter((node) => node.type === 'code').length);
  const dirty = $derived(savedFingerprint !== fingerprint());
  const readOnly = $derived(boardList?.readOnly !== false || !adapter.saveBoard);
  const allNodeKinds = $derived([...new Set([...nodeKinds, ...symbols.map((item) => item.kind), ...(groupPage?.items ?? []).flatMap((item) => item.byKind.map((entry) => entry.kind)), ...(libraryKind ? [libraryKind] : [])])]);
  const allEdgeKinds = $derived([...new Set([...edgeKinds, ...relations.map((item) => item.kind), ...(connectionPage?.items ?? []).flatMap((item) => item.evidence.map((edge) => edge.kind)), ...(kind ? [kind] : []), ...(connectionKind ? [connectionKind] : [])])]);
  const edges = $derived<Edge[]>([...canvasRelations.map((edge) => {
    const lane = lanes.get(edge.id) ?? 0;
    const hot = evidence?.id === edge.id || (selectedSources.length ? edge.evidence.some((item) => related.evidenceIds.has(item.id)) : selected === edge.source || selected === edge.target);
    const uncertain = edge.evidence.some(isBoardEvidenceUncertain);
    const color = relationColor(edge.kind);
    return { id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle,
      type: 'relation', selectable: false, data: { relation: edge, lane }, label: `${relationLabel(edge.kind)}${edge.evidence.length > 1 ? ` · ${edge.evidence.length}` : ''}${edge.via ? ' · synthesized' : ''}${uncertain ? ' · uncertain' : ''}`,
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: `stroke:${color};stroke-width:${hot ? 2.4 : 1.5};${edge.via || uncertain ? 'stroke-dasharray:6 4;' : ''}`,
      labelStyle: 'color:var(--ink-2);font:10px var(--mono);background:var(--paper);padding:4px 5px', interactionWidth: 20 };
  }), ...detachedEdges]);
  function merge(items: BoardSymbol[]) {
    const keep = new Set([...snapshotIds, ...included, ...expanded, ...hidden,
      ...nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId),
      ...projection.symbols.flatMap((item) => item.memberRows.map((row) => row.symbol.id)),
      ...(searchPage?.items ?? []).map((item) => item.id), ...(connectionPage?.symbols ?? []).map((item) => item.id)]);
    symbols = mergeBoardFacts(symbols, items, keep);
  }
  function setPanel(next: typeof panel) {
    if (!panel && document.activeElement instanceof HTMLElement) returnFocus = document.activeElement;
    panel = next; evidence = null;
    if (next) void tick().then(() => boardElement?.querySelector<HTMLElement>('aside input:not([type=checkbox]), aside h2, aside button')?.focus());
  }
  function closePanel() {
    panel = null; evidence = null;
    void tick().then(() => { if (returnFocus?.isConnected) returnFocus.focus(); else boardElement?.querySelector<HTMLElement>('[data-add-symbols]')?.focus(); });
  }
  function display(id: string) { return sourceSnapshot?.symbols.find((item) => item.id === id)?.qualifiedName ?? symbols.find((item) => item.id === id)?.qualifiedName ?? id; }
  function exclusionLabel(value?: BoardSnapshot['excluded']): string {
    if (!value) return '';
    return (['symbols', 'relations'] as const).map((unit) => {
      const counts = value[unit];
      return counts.tests + counts.generated + counts.uncertain ? `${unit}: ${counts.tests} test, ${counts.generated} generated, ${counts.uncertain} uncertain` : '';
    }).filter(Boolean).join(' · ');
  }
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
        data: { ...item, hidden, pinned: included.filter((id) => !hidden.includes(id)), expanded: expanded.includes(item.symbol.id), locatedMember, canPinMembers: true, canOpenSiblingSources: !!adapter.boardSiblingSources, siblingsBusy, related: related.representatives.has(item.symbol.id), relatedIds: related.members, act } });
    }
    nodes = [...graph, ...nodes.filter((node) => node.type === 'code').map((node) => node.type === 'code' ? { ...node, data: { ...node.data, filters, follow: followSource, resize: resizeCard, siblings: openSiblingSources, siblingsBusy, siblingsAvailable: !!adapter.boardSiblingSources, sourceState: reportSourceState } } : node)];
  }
  // Flow replaces selection during a marquee, even with its multi-select key held.
  function startPointerSelection(event: PointerEvent) {
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.classList.contains('svelte-flow__pane')) return;
    rectangleBase = event.shiftKey ? nodes.filter((node) => node.selected).map((node) => node.id) : [];
    rectangleOrigin = screenToFlowPosition({ x: event.clientX, y: event.clientY });
  }
  function finishRectangleSelection(event: PointerEvent) {
    if (rectangleOrigin) {
      const end = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const width = Math.abs(end.x - rectangleOrigin.x), height = Math.abs(end.y - rectangleOrigin.y);
      // Flow considers a zero-area rectangle to contain every node.
      const hits = width > 0 && height > 0 ? getIntersectingNodes({ x: Math.min(rectangleOrigin.x, end.x), y: Math.min(rectangleOrigin.y, end.y), width, height }, true) : [];
      const chosen = new Set([...rectangleBase, ...hits.map((node) => node.id)]);
      // Recompute on release: Flow can skip reselecting the same hits on consecutive marquees.
      selectingRectangle = false;
      nodes = nodes.map((node) => ({ ...node, selected: chosen.has(node.id) }));
    }
    rectangleOrigin = null; rectangleBase = []; selectingRectangle = false;
    // Keep the selected cards, not Flow's persistent group bounding rectangle.
    flow.selectionRectMode = null;
  }
  function retainRectangleSelection() {
    if (selectingRectangle && rectangleBase.some((id) => nodes.some((node) => node.id === id && !node.selected))) {
      nodes = nodes.map((node) => rectangleBase.includes(node.id) ? { ...node, selected: true } : node);
    }
  }
  function openingPosition(event?: MouseEvent, width = 530, height = 310) {
    if (event && event.detail > 0) return screenToFlowPosition({ x: event.clientX + 12, y: event.clientY + 12 });
    const bounds = boardElement?.querySelector('.svelte-flow')?.getBoundingClientRect();
    return screenToFlowPosition({ x: (bounds?.left ?? 0) + ((bounds?.width ?? 0) - width * viewport.zoom) / 2,
      y: (bounds?.top ?? 0) + ((bounds?.height ?? 0) - height * viewport.zoom) / 2 });
  }
  function reflectSourceSelection(items: readonly Node[]) {
    const ids = items.filter((item) => item.type === 'code').map((item) => String(item.data.symbolId));
    if (JSON.stringify(ids) !== JSON.stringify(selectedSources)) { selectedSources = ids; refresh(); }
  }
  async function loadSnapshot(fit = false) {
    if (!adapter.board) return;
    const current = ++request; error = ''; busy = true;
    try {
      const value = await adapter.board(included.filter((id) => !id.startsWith('missing:')), undefined, filters);
      if (current !== request) return;
      snapshotIds = new Set(value.symbols.map((item) => item.id)); eligibleIds = new Set(value.scopeIds ?? snapshotIds); merge(value.symbols); relations = value.relations; notes = value.notes; excluded = value.excluded;
      if (value.missing.length) notes = [...notes, `${value.missing.length} selected identities no longer resolve. Reload/open the saved board to re-resolve them.`];
      refresh();
      // Viewport animations may be interrupted by normal pointer input. Their
      // completion must never hold the request/save controls in a busy state.
      if (fit) void fitGraph().catch((cause) => { if (current === request) fail(cause); });
    } catch (cause) { if (current === request) fail(cause); }
    finally { if (current === request) busy = false; }
  }
  async function add(ids: string[], position = openingPosition(undefined, 286, 240)) {
    const generation = epoch;
    const unique = [...new Set([...included, ...ids])];
    if (new Set([...unique, ...expanded, ...hidden, ...nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId)]).size > 128) { error = 'A board can retain at most 128 symbol identities including source cards. Narrow the selection first.'; return; }
    for (const [index, id] of ids.entries()) if (!included.includes(id)) {
      positions.set(id, { x: position.x + index * 24, y: position.y + index * 24 });
    }
    included = unique; hidden = hidden.filter((id) => !ids.includes(id)); evidence = null;
    searchSelection = searchSelection.filter((id) => !ids.includes(id)); connectionSelection = [];
    await loadSnapshot();
    if (generation !== epoch) return;
    notice = `${ids.length} chosen symbol(s) included. No neighbours added. Existing positions preserved.`;
    if (panel === 'hidden') void tick().then(() => boardElement.querySelector<HTMLElement>('aside h2, aside button')?.focus());
  }
  async function restoreHidden(ids: string[]) {
    const generation = epoch;
    hidden = hidden.filter((id) => !ids.includes(id)); await loadSnapshot();
    if (generation !== epoch) return;
    notice = 'Restored previous placement/visibility preferences without pinning new symbols; active filters still apply.';
    if (panel === 'hidden') void tick().then(() => {
      if (generation === epoch && panel === 'hidden') boardElement.querySelector<HTMLElement>('aside h2')?.focus();
    });
  }
  async function includeTargets(ids: string[]) {
    const generation = epoch;
    const states = ids.map((id) => ({ id, ...model.targetState(id, included, hidden) }));
    hidden = hidden.filter((id) => !states.some((item) => item.status === 'hidden' && item.representative === id));
    const additions = states.filter((item) => item.status === 'absent').map((item) => item.id);
    if (additions.length) await add(additions); else await loadSnapshot();
    if (generation === epoch) connectionSelection = [];
  }
  async function targetAction(id: string) {
    const state = model.targetState(id, included, hidden);
    if (state.status === 'visible') await locate(id);
    else if (state.status === 'hidden') await restoreHidden([state.representative]);
    else await add([id]);
  }
  function choose(values: string[], id: string, checked: boolean) { return checked ? [...new Set([...values, id])] : values.filter((item) => item !== id); }
  async function fitGraph() { const generation = epoch; await tick(); if (generation === epoch) await fitView({ nodes: nodes.filter((node) => node.type === 'symbol'), padding: 0.16, maxZoom: 1, duration: 200 }); }
  async function fitCode() { const generation = epoch; await tick(); if (generation === epoch) await fitView({ nodes: nodes.filter((node) => node.type === 'code'), padding: 0.14, maxZoom: 1, duration: 200 }); }
  async function fitSelection() {
    const selection = nodes.filter((node) => node.selected);
    if (!selection.length) { notice = 'Select cards by their headers (Shift for several), then Fit selection.'; return; }
    await tick(); await fitView({ nodes: selection, padding: 0.25, maxZoom: 1.1, duration: 200 });
  }
  async function locate(id: string) {
    const generation = epoch;
    const state = model.targetState(id, included, hidden); if (state.status !== 'visible') return;
    const owner = state.representative;
    const reveal = model.revealMember(id, owner, expanded, limits);
    if (new Set([...included, ...hidden, ...expanded, ...reveal.expanded, ...nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId)]).size > 128) { error = 'Locating this path would exceed the 128 retained-identity limit. Collapse or remove another selection first.'; return; }
    expanded = reveal.expanded; limits = reveal.limits; locatedMember = reveal.locatedMember;
    for (const parent of reveal.path.slice(0, -1)) { await ensureMembers(parent, limits[parent] ?? 6); if (generation !== epoch) return; }
    selected = owner; refresh(); nodes = nodes.map((node) => ({ ...node, selected: node.id === owner }));
    await tick(); if (generation !== epoch) return;
    await fitView({ nodes: [{ id: owner }], padding: 0.5, maxZoom: 1, duration: 200 });
    await tick(); if (generation !== epoch) return;
    boardElement?.querySelector<HTMLElement>(`[data-member="${CSS.escape(id)}"] button.member-name`)?.focus();
    notice = owner === id ? `Located ${display(id)}.` : `Located exact member: ${reveal.path.map(display).join(' → ')}.`;
  }
  function act(action: SymbolAction, id: string, event?: MouseEvent) {
    error = ''; evidence = null;
    if (action === 'connections') void openConnections(id);
    else if (action === 'siblingSources') void openSiblingSources(id, event);
    else if (action === 'contents') void openConnections(id, { members: false, kind: 'contains' });
    else if (action === 'restore') void restoreHidden([id]);
    else if (action === 'pin') { event?.stopPropagation(); void add([id], openingPosition(event, 286, 240)); }
    else if (action === 'hide') {
      if (new Set([...included, ...expanded, ...hidden, ...nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId), id]).size > 128) { error = 'The board already retains 128 identities; remove an existing selection before retaining another hidden member.'; return; }
      hidden = [...new Set([...hidden, id])]; hideHistory = [...hideHistory.filter((item) => item !== id), id]; selected = null; refresh(); notice = `${display(id)} hidden. Undo hide or restore from Connections/Hidden items.`;
      void tick().then(() => boardElement.querySelector<HTMLElement>('[data-hidden-items]')?.focus());
    } else if (action === 'expand' || action === 'more') {
      if (action === 'expand') {
        if (expanded.includes(id)) expanded = expanded.filter((item) => item !== id);
        else {
          if (new Set([...included, ...expanded, ...hidden, ...nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId), id]).size > 128) { error = 'The board already retains 128 identities. Collapse or remove another selection before retaining nested expansion state.'; return; }
          expanded = [...expanded, id]; void ensureMembers(id, limits[id] ?? 6);
        }
      } else {
        const desired = Math.min(BOARD_MEMBER_REVEAL_LIMIT, (limits[id] ?? 6) + 6);
        limits = { ...limits, [id]: desired }; void ensureMembers(id, desired);
        if (desired === BOARD_MEMBER_REVEAL_LIMIT) notice = `Outline capped at ${BOARD_MEMBER_REVEAL_LIMIT} eligible rows. Use Connections → contains for the remaining members.`;
      }
      refresh();
      if ((action === 'more' || expanded.includes(id)) && (limits[id] ?? 6) < BOARD_MEMBER_REVEAL_LIMIT) notice = 'Member detail changed without moving cards. Pan or Fit graph if the longer outline extends beyond the viewport.';
    } else if (action === 'locate') void locate(id);
    else openCode(id, true, null, event);
  }
  function connectionArgs(offset = 0): BoardConnectionRequest { return { id: connectionScope!, direction, members: withMembers, kind: connectionKind || undefined, q: connectionQ || undefined, offset, ...filters }; }
  async function loadConnections(offset = 0, paging = false, submitted?: BoardConnectionRequest) {
    if (!adapter.boardConnections || !connectionScope) return;
    const current = ++connectionRequest; connectionBusy = true; error = ''; pendingEvidence = {};
    const criteria = submitted ?? (paging && activeConnection ? { ...activeConnection, offset } : connectionArgs(offset));
    pendingConnection = { ...criteria };
    try {
      const value = await adapter.boardConnections(criteria);
      if (current !== connectionRequest) return;
      merge([value.scope, ...value.symbols, ...value.items.flatMap((row) => row.owner ? [row.target, row.owner] : [row.target])]);
      completedConnection = { criteria: { ...criteria }, page: value };
      notice = `Connections: showing ${offset + (value.items.length ? 1 : 0)}–${offset + value.items.length} of ${value.total} targets. Selection is retained across pages.`;
      if (paging) void tick().then(() => { if (current !== connectionRequest) return; boardElement.querySelector<HTMLElement>('.connections-panel h2')?.focus(); const list = boardElement.querySelector('.connections-panel .result-list'); if (list) list.scrollTop = 0; });
    } catch (cause) { if (current === connectionRequest) fail(cause); }
    finally { if (current === connectionRequest) { connectionBusy = false; pendingConnection = null; } }
  }
  async function openConnections(id: string, options: { members?: boolean; kind?: string } = {}) {
    if (panel === 'connections' && connectionScope) history = [...history.slice(-9), {
      criteria: { ...(completedConnection?.criteria ?? pendingConnection ?? connectionArgs()) }, completed: completedConnection,
      query: connectionQ, selected: [...connectionSelection], scroll: boardElement.querySelector('.connections-panel .result-list')?.scrollTop ?? 0,
    }];
    else history = [];
    connectionScope = id; direction = 'outgoing'; withMembers = options.members ?? (cardFamily(model.symbol(id).kind) === 'type' || model.symbol(id).kind === 'component');
    connectionKind = options.kind ?? ''; connectionQ = ''; connectionSelection = []; completedConnection = null; pendingConnection = null; setPanel('connections');
    await loadConnections();
  }
  async function backConnections() {
    const entry = history.at(-1); if (!entry) return;
    ++connectionRequest; history = history.slice(0, -1);
    const criteria = entry.completed?.criteria ?? entry.criteria;
    connectionScope = criteria.id; direction = criteria.direction; withMembers = criteria.members;
    connectionKind = criteria.kind ?? ''; connectionQ = entry.query; connectionSelection = entry.selected; connectionBusy = false;
    completedConnection = entry.completed; pendingConnection = null; pendingEvidence = {};
    if (entry.completed) merge(entry.completed.page.symbols);
    const pending = entry.completed ? null : loadConnections(criteria.offset ?? 0, false, criteria);
    const current = connectionRequest;
    if (pending) await pending;
    await tick(); if (current !== connectionRequest) return;
    boardElement.querySelector<HTMLElement>('.connections-panel h2')?.focus();
    const list = boardElement.querySelector('.connections-panel .result-list'); if (list) list.scrollTop = entry.scroll;
  }
  async function moreEvidence(target: string, offset: number) {
    if (!adapter.boardEvidence || !completedConnection || connectionBusy || busy || pendingEvidence[target] === connectionRequest) return;
    const current = connectionRequest; const criteria = completedConnection.criteria;
    pendingEvidence = { ...pendingEvidence, [target]: current };
    try {
      const value = await adapter.boardEvidence({ ...criteria, offset, target });
      if (current !== connectionRequest || completedConnection?.criteria !== criteria) return;
      merge(value.symbols);
      completedConnection = { criteria, page: { ...completedConnection.page, items: completedConnection.page.items.map((row) => row.target.id === target ? { ...row, evidence: [...new Map([...row.evidence, ...value.items].map((edge) => [edge.id, edge])).values()] } : row) } };
    } catch (cause) { if (current === connectionRequest && completedConnection?.criteria === criteria) fail(cause); }
    finally { if (pendingEvidence[target] === current) { const rest = { ...pendingEvidence }; delete rest[target]; pendingEvidence = rest; } }
  }
  async function changeFilters() {
    const generation = epoch;
    ++memberGeneration; memberPages = {}; connectionSelection = []; searchSelection = []; history = [];
    await loadSnapshot();
    if (generation !== epoch) return;
    if (panel === 'library') { if (libraryMode === 'symbols') await search(); else await groups(); }
    if (panel === 'connections') await loadConnections();
  }
  async function groups(offset = 0, paging = false) {
    if (!adapter.boardGroups || libraryMode === 'symbols') return;
    const current = ++groupRequest; groupBusy = true; error = '';
    try {
      const criteria = paging && activeGroup ? { ...activeGroup, offset } : { type: libraryMode, q: groupQuery, offset, limit: 30, ...filters };
      const value = await adapter.boardGroups(criteria);
      if (current === groupRequest) {
        activeGroup = criteria; groupPage = value;
        if (paging) void tick().then(() => { boardElement.querySelector<HTMLElement>('.library h2')?.focus(); const list = boardElement.querySelector('.library .result-list'); if (list) list.scrollTop = 0; });
      }
    } catch (cause) { if (current === groupRequest) fail(cause); } finally { if (current === groupRequest) groupBusy = false; }
  }
  async function browseGroup(item: BoardGroups['items'][number]) {
    libraryPath = item.type === 'folder' ? item.path ?? item.id : '';
    libraryNamespace = item.type === 'namespace' ? item.namespace ?? item.id : '';
    namespaceName = item.type === 'namespace' ? item.name : '';
    libraryQ = ''; libraryMode = 'symbols'; searchPage = null; activeSearch = null; await search();
    void tick().then(() => boardElement.querySelector<HTMLElement>('[aria-label="Search indexed symbols"]')?.focus());
  }
  async function addAllMatches() {
    if (!adapter.boardSearch || !searchPage || !activeSearch || searchPage.total > 128) return;
    const current = searchRequest; const index = live.indexTick; const criteria = { ...activeSearch }; const total = searchPage.total;
    try {
      const items: BoardSymbol[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = await adapter.boardSearch({ ...criteria, offset, limit: 100 });
        if (current !== searchRequest || live.indexTick !== index || page.total !== total) throw new Error('Selection changed while loading. Review the preview and try again.');
        items.push(...page.items); offset = page.nextOffset;
      }
      merge(items); await add(items.map((item) => item.id));
    } catch (cause) { if (current === searchRequest) fail(cause); }
  }
  async function ensureMembers(id: string, desired = 6) {
    if (!adapter.boardMembers || id.startsWith('missing:')) return;
    const generation = memberGeneration;
    let cached = memberPages[id];
    if (cached?.loading) return;
    desired = Math.min(BOARD_MEMBER_REVEAL_LIMIT, desired);
    const available = new Set(symbols.map((item) => item.id));
    const held = cached?.ids?.filter((child) => available.has(child)).length ?? 0;
    if (held >= desired) return;
    if (cached?.ids && held < cached.ids.length) {
      cached = { total: cached.total, ids: [], loaded: 0, nextOffset: 0 };
      memberPages = { ...memberPages, [id]: cached };
    }
    let offset = cached?.nextOffset ?? 0;
    if (cached?.nextOffset === null) return;
    memberPages = { ...memberPages, [id]: { ...cached, loading: true } };
    try {
      do {
        const page = await adapter.boardMembers({ id, offset, limit: 100, ...filters });
        if (generation !== memberGeneration) return;
        merge(page.symbols); merge(page.items);
        memberPages = { ...memberPages, [id]: { ids: [...new Set([...(memberPages[id]?.ids ?? []), ...page.items.map((item) => item.id)])], total: page.total, loaded: (memberPages[id]?.loaded ?? 0) + page.items.length, nextOffset: page.nextOffset, bounded: page.bounded, loading: false } };
        if (page.notes.length) notes = [...new Set([...notes, ...page.notes])];
        offset = page.nextOffset ?? -1;
      } while (offset >= 0 && (memberPages[id]?.ids?.length ?? 0) < desired);
      refresh();
    } catch (cause) { if (generation === memberGeneration) fail(cause); }
    finally { if (generation === memberGeneration) { memberPages = { ...memberPages, [id]: { ...memberPages[id], loading: false } }; refresh(); } }
  }
  async function search(offset = 0, paging = false) {
    if (!adapter.boardSearch) return;
    const current = ++searchRequest; searchBusy = true; error = '';
    try {
      const criteria = paging && activeSearch ? { ...activeSearch, offset } : { q: libraryQ, kind: libraryKind || undefined, path: libraryPath || undefined, namespace: libraryNamespace || undefined, offset, ...filters };
      const value = await adapter.boardSearch(criteria);
      if (current !== searchRequest) return;
      merge([...(value.symbols ?? []), ...value.items]); activeSearch = { ...criteria }; searchPage = value;
      notice = `Selection: showing ${offset + (value.items.length ? 1 : 0)}–${offset + value.items.length} of ${value.total} matches. Selected identities are retained across pages.`;
      if (paging) void tick().then(() => { boardElement.querySelector<HTMLElement>('.library h2')?.focus(); const list = boardElement.querySelector('.library .result-list'); if (list) list.scrollTop = 0; });
    } catch (cause) { if (current === searchRequest) fail(cause); }
    finally { if (current === searchRequest) searchBusy = false; }
  }
  async function acceptReaderRequests(ids: string[]) {
    if (!adapter.board) return;
    const token = epoch;
    try {
      if (new Set([...included, ...expanded, ...hidden, ...nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId), ...ids]).size > 128) throw new Error('The requested symbols exceed this board’s 128-identity limit. Remove hidden selections or start a new board.');
      const value = await adapter.board(ids, undefined, filters);
      if (token !== epoch) return;
      merge(value.symbols);
      if (value.missing.length) notes = [...notes, `${value.missing.length} requested reader identities are no longer in this index.`];
      if (value.included.length) await add(value.included);
    } catch (cause) { if (token === epoch) fail(cause); }
  }
  $effect(() => { if (boardRequests.pending.length) untrack(() => { void acceptReaderRequests(boardRequests.take()); }); });
  async function forget(id: string) {
    const generation = epoch;
    if (!window.confirm(`Remove ${display(id)} from this board's selection? Its source and indexed graph are unchanged.`)) return;
    included = included.filter((item) => item !== id); hidden = hidden.filter((item) => item !== id && model.representative(item, included, []) !== null);
    expanded = expanded.filter((item) => item !== id && model.representative(item, included, []) !== null);
    positions.delete(id); hideHistory = hideHistory.filter((item) => item !== id); selected = null;
    await loadSnapshot(); if (generation === epoch) notice = 'Removed from the board recipe only. Any independent source card remains open.';
  }
  function closeCard(id: string) { nodes = nodes.filter((node) => node.id !== id); sourceHeights.delete(id); void tick().then(() => boardElement?.querySelector<HTMLElement>('[data-add-symbols]')?.focus()); }
  function resizeCard(id: string, widthDelta: number, heightDelta: number) {
    nodes = nodes.map((node) => node.id === id && node.type === 'code' ? { ...node, width: Math.max(380, Math.min(4096, (node.width ?? node.measured?.width ?? 530) + widthDelta)), height: Math.max(190, Math.min(4096, (node.height ?? node.measured?.height ?? 310) + heightDelta)) } : node);
  }
  function followSource(target: BoardSymbol, line?: number, event?: MouseEvent) { merge([target]); openCode(target.id, true, line ?? null, event); }
  function toggleCard(id: string) {
    nodes = nodes.map((node) => {
      if (node.type !== 'code' || node.id !== id) return node;
      if (!node.data.collapsed) sourceHeights.set(id, node.height ?? node.measured?.height ?? 310);
      return { ...node, height: node.data.collapsed ? sourceHeights.get(id) ?? 310 : 82, data: { ...node.data, collapsed: !node.data.collapsed } };
    });
  }
  function readCard(id: string) { void tick().then(() => fitView({ nodes: [{ id }], padding: 0.25, maxZoom: 1.1, duration: 200 })); }
  function openCode(id: string, activate = true, highlight: number | null = null, event?: MouseEvent, position?: { x: number; y: number }) {
    event?.stopPropagation();
    if (codeCount >= 32 && !nodes.some((node) => node.id === `code:${id}`)) { error = 'Close a source card before opening another (maximum 32).'; return; }
    if (new Set([...included, ...expanded, ...hidden, ...nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId), id]).size > 128) { error = 'This board already retains 128 symbol identities. Close a source-only card or start another board.'; return; }
    const item = model.symbol(id); const key = `code:${id}`;
    if (nodes.some((node) => node.id === key)) nodes = nodes.map((node) => node.id === key && node.type === 'code' ? { ...node, selected: true, zIndex: ++zIndex, data: { ...node.data, highlight } } : { ...node, selected: false });
    else {
      nodes = [...nodes.map((node) => ({ ...node, selected: false })), { id: key, type: 'code', position: position ?? openingPosition(event), width: 530, height: 310, selected: true, zIndex: ++zIndex, dragHandle: '.board-drag-handle', connectable: false,
        data: { symbolId: id, symbol: item, collapsed: false, highlight, filters, follow: followSource, resize: resizeCard, close: closeCard, toggle: toggleCard, read: readCard, siblings: openSiblingSources, siblingsBusy, siblingsAvailable: !!adapter.boardSiblingSources, sourceState: reportSourceState } }];
    }
    if (activate) { panel = null; evidence = null; void tick().then(() => boardElement?.querySelector<HTMLElement>(`[data-id="${CSS.escape(key)}"]`)?.focus({ preventScroll: true })); }
  }
  function detachSource(target: BoardSymbol, event?: MouseEvent) {
    // A class source-only card can expose members absent from the symbol cache.
    // Reuse normal source-card opening, including its capacity and identity guards.
    followSource(target, undefined, event);
  }
  function locateDetachedSource(id: string, event?: MouseEvent) {
    event?.stopPropagation();
    const key = `code:${id}`;
    if (!nodes.some((node) => node.id === key)) return;
    nodes = nodes.map((node) => ({ ...node, selected: node.id === key, ...(node.id === key ? { zIndex: ++zIndex } : {}) }));
    readCard(key);
  }
  function reattachSource(id: string, event?: MouseEvent) {
    event?.stopPropagation(); closeCard(`code:${id}`);
    notice = 'Reattached source: the separate method card was closed and its code restored inside the class. Symbol membership is unchanged.';
  }
  function reportSourceState(id: string, state: { indexed: boolean; indexTick: number; diskTick: number }) {
    const old = sourceStates[id];
    if (old?.indexed === state.indexed && old.indexTick === state.indexTick && old.diskTick === state.diskTick) return;
    sourceStates = { ...sourceStates, [id]: state };
  }
  // Only card identities/filters/index revisions trigger this independent graph
  // query. Dragging, resizing and selection never change either membership layer.
  $effect(() => {
    const ids = JSON.parse(sourceIdsKey) as string[]; const visibility = filters;
    const version = { indexTick: live.indexTick, diskTick: live.diskTick };
    const controller = new AbortController();
    sourceSnapshot = null; sourceNotes = []; sourceError = '';
    if (!ids.length || !adapter.board) return () => controller.abort();
    adapter.board(ids.filter((id) => !id.startsWith('missing:')), controller.signal, visibility).then((value) => {
      if (controller.signal.aborted) return;
      sourceSnapshot = value; sourceSnapshotVersion = version;
      sourceNotes = ['Source arrows require indexed source locations and land at target declarations. Relationships without a trusted line remain available in Indexed outgoing links.',
        ...(value.bounded ? ['Source-card relationships are bounded; shown arrows are a partial indexed view.'] : []), ...value.notes];
    }).catch((cause) => { if (!controller.signal.aborted) sourceError = cause instanceof Error ? cause.message : String(cause); });
    return () => controller.abort();
  });
  async function openSiblingSources(id: string, event?: MouseEvent) {
    event?.stopPropagation();
    if (!adapter.boardSiblingSources || siblingsBusy) return;
    const controller = new AbortController(); siblingController = controller;
    const generation = epoch; const visibility = { ...filters };
    const index = live.indexTick; const disk = live.diskTick;
    const anchor = openingPosition(event);
    siblingsBusy = true; error = ''; refresh();
    try {
      const items = new Map<string, BoardSymbol>(); let offset: number | null = 0;
      while (offset !== null) {
        const page = await adapter.boardSiblingSources({ id, ...visibility, offset, limit: 100 }, controller.signal);
        if (controller.signal.aborted || generation !== epoch) return;
        if (page.scope?.kind === 'unavailable') throw new Error(page.notes?.join(' ') || 'No uniquely proven sibling scope is available.');
        if (page.bounded) throw new Error('The sibling scope is incomplete or ambiguous; no source cards were opened. Inspect Connections instead.');
        if (page.total > 32) throw new Error('This scope has more sibling sources than the 32-card board limit. Open individual sources through Connections instead.');
        for (const item of page.items) items.set(item.id, item);
        if (page.nextOffset !== null && page.nextOffset <= offset) throw new Error('Sibling paging did not advance; no source cards were opened.');
        offset = page.nextOffset;
      }
      if (index !== live.indexTick || disk !== live.diskTick || JSON.stringify(visibility) !== JSON.stringify(filters)) throw new Error('The index, disk or filters changed during discovery. Try opening sibling sources again.');
      const existing = nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId);
      const capacity = boardSiblingSourceCapacity(existing, [...items.keys()], [...included, ...expanded, ...hidden]);
      if (capacity) throw new Error(capacity);
      merge([...items.values()]);
      let added = 0;
      for (const item of items.values()) if (!existing.includes(item.id)) {
        openCode(item.id, false, null, undefined, { x: anchor.x + (added % 4) * 560, y: anchor.y + Math.floor(added / 4) * 340 }); added++;
      }
      notice = `${added} sibling source cards opened; ${items.size - added} already open. Symbol membership and existing positions unchanged.`;
    } catch (cause) { if (!controller.signal.aborted && generation === epoch) fail(cause); }
    finally { if (siblingController === controller) { siblingController = null; siblingsBusy = false; refresh(); } }
  }
  async function compare(edge: BoardEvidence) {
    // A source-only class can expose method endpoints absent from the symbol
    // diagram's cache. Admit just the two chosen source identities, never pins.
    merge((sourceSnapshot?.symbols ?? []).filter((item) => item.id === edge.source || item.id === edge.target));
    openCode(edge.source, false, edge.line ?? null); openCode(edge.target, false); panel = null; evidence = null;
  }
  function tidy() {
    let x = 30; let y = 30; let height = 0;
    nodes = nodes.map((node) => { if (node.type !== 'symbol') return node; if (x > 900) { x = 30; y += height + 100; height = 0; }
      const position = { x, y }; x += 400; height = Math.max(height, node.measured?.height ?? 240); return { ...node, position }; });
    void fitGraph();
  }
  /** Reset reviewer-owned recipe/discovery state, not host capabilities or in-flight metadata writes. */
  function resetBoardState() {
    ++request; ++searchRequest; ++connectionRequest; ++groupRequest; ++memberGeneration;
    siblingController?.abort(); siblingController = null; siblingsBusy = false;
    sourceSnapshot = null; sourceStates = {}; sourceNotes = []; sourceError = '';
    memberPages = {}; symbols = []; relations = []; included = []; hidden = []; expanded = []; limits = {}; nodes = [];
    originalIdentities.clear(); positions.clear(); sourceHeights.clear(); snapshotIds = new Set(); eligibleIds = new Set();
    selected = null; selectedSources = []; locatedMember = undefined; hideHistory = []; zIndex = 10;
    kind = ''; structure = false; includeTests = false; includeGenerated = false; includeUncertain = false; excluded = undefined;
    libraryMode = 'symbols'; libraryQ = ''; libraryKind = ''; libraryPath = ''; libraryNamespace = ''; namespaceName = '';
    searchSelection = []; searchPage = null; activeSearch = null; searchBusy = false;
    groupQuery = ''; groupPage = null; activeGroup = null; groupBusy = false;
    connectionScope = null; direction = 'outgoing'; withMembers = true; connectionKind = ''; connectionQ = '';
    completedConnection = null; pendingConnection = null; connectionSelection = []; connectionBusy = false; pendingEvidence = {}; history = [];
    panel = null; evidence = null; helpOpen = false; returnFocus = null; viewport = { x: 0, y: 0, zoom: 1 };
    busy = false; notes = []; error = '';
  }
  function documentState(): BoardDocument {
    const ids = [...new Set([...included, ...expanded, ...hidden, ...nodes.filter((node) => node.type === 'code').map((node) => node.data.symbolId as string)])];
    const keys = new Map(ids.map((id, index) => [id, `s${index}`]));
    return { version: 1, symbols: ids.flatMap((id) => {
      const item = symbols.find((value) => value.id === id); if (!item) return [];
      return [{ key: keys.get(id)!, identity: originalIdentities.get(id) ?? { id: item.id, qualifiedName: item.qualifiedName, kind: item.kind, file: item.file, ...(item.signature ? { signature: item.signature } : {}) },
        position: { ...(nodes.find((node) => node.id === id)?.position ?? positions.get(id) ?? { x: 30, y: 30 }) }, included: included.includes(id), hidden: hidden.includes(id), expanded: expanded.includes(id), ...(limits[id] ? { memberLimit: limits[id] } : {}) }];
    }), cards: nodes.filter((node) => node.type === 'code').map((node, index) => ({ key: `c${index}`, symbolKey: keys.get(node.data.symbolId as string)!, position: { ...node.position }, width: node.width ?? node.measured?.width ?? 530, height: node.data.collapsed ? sourceHeights.get(node.id) ?? 310 : node.height ?? node.measured?.height ?? 310, collapsed: Boolean(node.data.collapsed), zIndex: node.zIndex ?? 10 })),
      viewport: { ...viewport }, filters: { kind, showStructure: structure, includeTests, includeGenerated, includeUncertain } };
  }
  function fingerprint(name = boardName, document = documentState()) { return JSON.stringify({ name, document }); }
  async function listBoards() {
    const current = ++listRequest;
    try { if (adapter.boards) { const value = await adapter.boards(); if (current === listRequest) boardList = value; } }
    catch (cause) { if (current === listRequest) fail(cause); }
  }
  async function save(asNew = false) {
    const id = asNew ? undefined : boardId;
    if (readOnly || !adapter.saveBoard || saving || (id && deletingIds.includes(id))) return;
    error = ''; saving = true;
    const token = saveEpoch; const operation = ++saveRequest; const name = boardName; const document = documentState(); const started = deletionSerial;
    try {
      const pending = { id, resultId: undefined as string | undefined, promise: adapter.saveBoard({ name, ...(id ? { id } : {}), document }) };
      pendingSaves.set(operation, pending);
      const value = await pending.promise; pending.resultId = value.id;
      if (token !== saveEpoch || operation !== saveRequest || (deletedAfter.get(value.id) ?? 0) > started) return;
      boardId = value.id; if (boardName === name) boardName = value.name;
      savedFingerprint = fingerprint(value.name, document); notice = `Saved ${value.name} in .codegraph/ui/boards/.`; await listBoards();
    } catch (cause) { if (token === saveEpoch && operation === saveRequest) fail(cause); }
    finally { pendingSaves.delete(operation); if (!pendingSaves.size) deletedAfter.clear(); if (operation === saveRequest) saving = false; }
  }
  function canReplace() { return !dirty || window.confirm('This board has unsaved changes. Replace it without saving?'); }
  async function applyLoaded(value: BoardLoaded, token: number, expected: string, commit: () => void, options: { preserveSave?: boolean } = {}): Promise<boolean> {
    if (token !== epoch) return false;
    // Resolve and fetch into locals before changing any reviewer-owned state.
    const mapping = new Map(value.resolutions.filter((item) => item.node).map((item) => [item.key, item.node!.id]));
    const ids = value.board.symbols.filter((item) => item.included && mapping.has(item.key)).map((item) => mapping.get(item.key)!);
    const restoredFilters = { tests: value.board.filters.includeTests ?? false, generated: value.board.filters.includeGenerated ?? false, uncertain: value.board.filters.includeUncertain ?? false };
    const snapshot = adapter.board ? await adapter.board(ids, undefined, restoredFilters) : null;
    const restoredMembers: BoardSymbol[] = [];
    const restoredPages: Record<string, BoardMemberPageState> = {};
    if (adapter.boardMembers) for (const entry of value.board.symbols.filter((item) => item.expanded)) {
      const id = mapping.get(entry.key); if (!id) continue;
      const desired = entry.memberLimit ?? 6; let offset: number | null = 0; const childIds: string[] = [];
      do {
        if (token !== epoch || fingerprint() !== expected) return false;
        const page = await adapter.boardMembers({ id, offset, limit: 100, ...restoredFilters });
        restoredMembers.push(...page.symbols, ...page.items); childIds.push(...page.items.map((item) => item.id));
        offset = page.nextOffset;
        restoredPages[id] = { ids: [...new Set(childIds)], total: page.total, loaded: childIds.length, nextOffset: offset, bounded: page.bounded };
      } while (offset !== null && childIds.length < desired);
    }
    if (token !== epoch) return false;
    if (expected !== fingerprint()) { notice = 'Board changed while a replacement was loading; newer work was preserved. Retry the operation.'; busy = false; return false; }
    // Refresh updates facts for this recipe; it must not orphan a server-side
    // first Save/Save-as that has not returned its assigned identity yet.
    if (!options.preserveSave) { ++saveEpoch; ++saveRequest; saving = false; }
    resetBoardState();
    const loaded: BoardSymbol[] = [];
    for (const entry of value.board.symbols) {
      const resolution = value.resolutions.find((item) => item.key === entry.key);
      const id = resolution?.node?.id ?? `missing:${entry.key}`;
      mapping.set(entry.key, id); positions.set(id, { ...entry.position });
      originalIdentities.set(id, { ...entry.identity, ...(resolution?.node ? { id } : {}) });
      loaded.push(resolution?.node ?? { id, kind: entry.identity.kind, name: entry.identity.qualifiedName, qualifiedName: entry.identity.qualifiedName, file: entry.identity.file, line: 1, purpose: `${resolution?.status ?? 'missing'}: ${resolution?.note ?? 'Saved symbol is not uniquely present in this index.'}` });
    }
    symbols = [...new Map(loaded.map((item) => [item.id, item])).values()]; nodes = []; relations = snapshot?.relations ?? [];
    snapshotIds = new Set(snapshot?.symbols.map((item) => item.id) ?? []);
    eligibleIds = new Set(snapshot?.scopeIds ?? snapshotIds); excluded = snapshot?.excluded;
    merge(value.symbols ?? []); if (snapshot) merge(snapshot.symbols); merge(restoredMembers); notes = [...(snapshot?.notes ?? []), ...(value.notes ?? [])]; memberPages = restoredPages;
    included = [...new Set(value.board.symbols.filter((item) => item.included).map((item) => mapping.get(item.key)!))];
    hidden = [...new Set(value.board.symbols.filter((item) => item.hidden).map((item) => mapping.get(item.key)!))];
    expanded = [...new Set(value.board.symbols.filter((item) => item.expanded).map((item) => mapping.get(item.key)!))];
    kind = value.board.filters.kind; structure = value.board.filters.showStructure;
    includeTests = restoredFilters.tests; includeGenerated = restoredFilters.generated; includeUncertain = restoredFilters.uncertain;
    limits = Object.fromEntries(value.board.symbols.filter((item) => item.memberLimit).map((item) => [mapping.get(item.key)!, item.memberLimit!])); history = []; hideHistory = [];
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
    commit();
    return true;
  }
  async function openBoard(id: string) {
    if (!adapter.loadBoard || !canReplace()) return;
    const token = ++epoch; const expected = fingerprint(); busy = true; pendingReplacement = { id, token };
    try {
      const value = await adapter.loadBoard(id);
      await applyLoaded(value, token, expected, () => { boardId = id; boardName = boardList?.boards.find((item) => item.id === id)?.name ?? ''; savedFingerprint = fingerprint(); });
    } catch (cause) { if (token === epoch) fail(cause); }
    finally { if (pendingReplacement?.token === token) pendingReplacement = null; if (token === epoch) busy = false; }
  }
  async function removeBoard(id: string) {
    if (readOnly || !adapter.deleteBoard || deletingIds.includes(id) || !window.confirm('Delete this saved board metadata? Source and graph are unchanged.')) return;
    deletingIds = [...deletingIds, id];
    try {
      // An abort/generation guard cannot undo an already dispatched server write.
      // Wait for same-ID (or not-yet-assigned Save-as) requests before deleting.
      await Promise.all([...pendingSaves.values()].filter((item) => item.id === id || item.id === undefined).map((item) => item.promise.catch(() => undefined)));
      await adapter.deleteBoard(id);
      deletedAfter.set(id, ++deletionSerial);
      if (pendingReplacement?.id === id && pendingReplacement.token === epoch) { ++epoch; pendingReplacement = null; busy = false; }
      const activeSave = pendingSaves.get(saveRequest);
      if (activeSave?.id === id || activeSave?.resultId === id) { ++saveRequest; saving = false; }
      if (boardId === id) { boardId = undefined; savedFingerprint = ''; }
      ++listRequest; notice = 'Saved board deleted. Any in-memory arrangement is retained without its saved binding.';
      await listBoards();
    } catch (cause) { fail(cause); }
    finally { deletingIds = deletingIds.filter((item) => item !== id); if (!pendingSaves.size) deletedAfter.clear(); }
  }
  function newBoard() {
    if (!canReplace()) return;
    ++epoch; ++saveEpoch; ++saveRequest; pendingReplacement = null; saving = false;
    resetBoardState(); boardRequests.take(); boardId = undefined; boardName = '';
    savedFingerprint = fingerprint(); notice = 'New empty board. Add only the symbols you choose.';
    void tick().then(() => boardElement?.querySelector<HTMLElement>('[data-add-symbols]')?.focus());
  }
  function exportBoard() {
    const blob = new Blob([JSON.stringify({ name: boardName || 'Review board', document: documentState() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'review-board.json'; link.click(); URL.revokeObjectURL(url);
  }
  async function importBoard(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0]; if (!file || !canReplace()) return;
    const token = ++epoch; const expected = fingerprint(); busy = true; pendingReplacement = { token };
    try {
      if (file.size > 1024 * 1024) throw new Error('Board import exceeds 1 MiB.');
      const value = JSON.parse(await file.text()) as { name?: string; document?: BoardDocument };
      if (!adapter.resolveBoard) throw new Error('This host cannot validate/resolve imported boards.');
      const loaded = await adapter.resolveBoard(value.document ?? value as unknown as BoardDocument);
      await applyLoaded(loaded, token, expected, () => { boardId = undefined; boardName = typeof value.name === 'string' ? value.name.slice(0, 120) : 'Imported board'; savedFingerprint = ''; notice = 'Imported into memory only. Save as to keep a project-local copy.'; });
    } catch (cause) { if (token === epoch) fail(cause); } finally { if (pendingReplacement?.token === token) pendingReplacement = null; importFile.value = ''; if (token === epoch) busy = false; }
  }
  function showEvidence(edge: Edge) {
    if (!edge.data?.relation) return;
    if (!panel && !evidence && document.activeElement instanceof HTMLElement) returnFocus = document.activeElement;
    evidence = edge.data.relation as BoardRelation; panel = null;
    void tick().then(() => boardElement?.querySelector<HTMLElement>('[aria-label="Relationship evidence"] h2')?.focus());
  }
  function beforeUnload(event: BeforeUnloadEvent) { if (dirty) { event.preventDefault(); event.returnValue = ''; } }
  function onkeydown(event: KeyboardEvent) {
    if (!(event.target instanceof HTMLElement) || !boardElement?.contains(event.target) || boardElement.closest('[hidden]')) return;
    const typing = event.target.closest('input,select,textarea,[contenteditable=true]');
    if (event.key === 'Escape' && (panel || evidence || helpOpen)) { event.preventDefault(); event.stopPropagation(); helpOpen = false; closePanel(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); if (!busy && !saving) void save(); return; }
    if (typing) return;
    if (event.altKey) {
      const key = event.key.toLowerCase();
      if (['g', 'f', 'c', 'a', 'arrowleft'].includes(key)) { event.preventDefault(); event.stopPropagation(); }
      if (key === 'g') void fitGraph(); else if (key === 'f') void fitSelection(); else if (key === 'c') void fitCode();
      else if (key === 'a') { setPanel('library'); void search(); } else if (key === 'arrowleft' && panel === 'connections') void backConnections();
    } else if (event.key === 'Delete' && (event.target.matches('.svelte-flow__node') || event.target.matches('.board-drag-handle[tabindex]'))) {
      const id = event.target.closest<HTMLElement>('.svelte-flow__node')?.dataset.id;
      if (id) { event.preventDefault(); event.stopPropagation(); if (id.startsWith('code:')) closeCard(id); else act('hide', id); }
    }
  }
  async function refreshIndex() {
    if (!adapter.resolveBoard || !documentState().symbols.length) return;
    const token = ++epoch; const expected = fingerprint(); const wasDirty = dirty; busy = true; pendingReplacement = { id: boardId, token };
    try {
      const loaded = await adapter.resolveBoard(documentState());
      await applyLoaded(loaded, token, expected, () => { if (!wasDirty) savedFingerprint = fingerprint(); notice = 'Index refreshed; identities re-resolved and arrangement preserved.'; }, { preserveSave: true });
    } catch (cause) { if (token === epoch) fail(cause); } finally { if (pendingReplacement?.token === token) pendingReplacement = null; if (token === epoch) busy = false; }
  }
  let seenIndex = live.indexTick;
  $effect(() => { const value = live.indexTick; if (value !== seenIndex) { seenIndex = value; untrack(() => { void refreshIndex(); }); } });
  onMount(() => { void listBoards(); savedFingerprint = fingerprint(); return () => { siblingController?.abort(); }; });
</script>

<svelte:window onbeforeunload={beforeUnload} {onkeydown} />
{#if !adapter.board || !adapter.boardSearch || !adapter.boardConnections}
  <p class="unavailable">This host does not provide Review Board graph queries.</p>
{:else}
<div class="board" bind:this={boardElement} role="region" aria-label="Review Board">
  <div class="toolbar">
    <div class="tools"><button class="primary" data-add-symbols onclick={() => { setPanel('library'); void search(); }}>+ Add symbols</button><button data-hidden-items onclick={() => setPanel('hidden')}>Hidden items ({hidden.length})</button>{#if lastHidden}<button onclick={() => restoreHidden([lastHidden!])}>Undo hide</button>{/if}
      <label>Edges <select aria-label="Canvas relationship filter" bind:value={kind} onchange={() => { evidence = null; refresh(); }}><option value="">All kinds</option>{#each allEdgeKinds as item}<option value={item}>{kindLabel(item)}</option>{/each}</select></label>
      <label><input type="checkbox" bind:checked={structure} onchange={refresh} /> Ownership arrows</label>
    </div>
    <div class="tools"><button disabled={busy || !adapter.resolveBoard || (!included.length && !codeCount && !expanded.length && !hidden.length)} onclick={refreshIndex}>Refresh index</button><button onclick={fitGraph}>Fit graph</button><button onclick={fitSelection}>Fit selection</button><button disabled={!codeCount} onclick={fitCode}>Fit code ({codeCount})</button><button onclick={tidy}>Tidy</button><button onclick={() => { setPanel('boards'); void listBoards(); }}>Saved boards</button><button onclick={newBoard}>New</button><button aria-expanded={helpOpen} onclick={() => helpOpen = !helpOpen}>Keyboard help</button></div>
  </div>
  <div class="visibility" aria-label="Board visibility filters"><span>Include:</span><label><input type="checkbox" bind:checked={includeTests} onchange={changeFilters} /> Tests</label><label><input type="checkbox" bind:checked={includeGenerated} onchange={changeFilters} /> Generated code</label><label><input type="checkbox" bind:checked={includeUncertain} onchange={changeFilters} /> Uncertain matches</label><span>Explicitly selected cards stay included.{#if exclusionLabel(excluded)} Excluded from loaded board: {exclusionLabel(excluded)}. Counts are disjoint in test → generated → uncertain order.{/if}</span></div>
  {#if helpOpen}<section class="keyboard-help" aria-label="Board keyboard help"><b>Keyboard:</b> Tab to controls; Enter/Space activates. Focus a graph/source card and press Enter/Space to select it; arrow keys then move it (Shift for larger steps). Alt+G fits the graph, Alt+F fits selected cards, Alt+C fits code, Alt+A opens selection, Alt+Left returns in Connections, Ctrl/Cmd+S saves. Delete on a focused card hides it (or closes a source card). Escape closes the panel and restores focus. Source cards provide size buttons. Right-drag empty canvas to pan; left-drag to select touched cards (Shift adds). Shift-click toggles cards; drag a selected header to move the group.</section>{/if}
  <div class="savebar"><input aria-label="Board name" placeholder="Name this board…" bind:value={boardName} maxlength={120} /><button disabled={readOnly || busy || saving || !boardName.trim()} onclick={() => save()}>Save</button><button disabled={readOnly || busy || saving || !boardName.trim()} onclick={() => save(true)}>Save as</button>
    <span>{dirty ? 'Unsaved changes' : boardId ? 'Saved' : 'New board'}{readOnly ? ` · ${boardList?.readOnlyReason ?? 'Read-only host'}` : ' · metadata only'}</span>
    <button onclick={exportBoard}>Export JSON</button><button disabled={!adapter.resolveBoard} onclick={() => importFile.click()}>Import JSON</button><input class="file-input" type="file" accept="application/json,.json" bind:this={importFile} onchange={importBoard} />
  </div>
  {#if error}<div class="error" role="alert">{error}<button onclick={() => error = ''} aria-label="Dismiss board error">×</button></div>{/if}
  {#if sourceError}<div class="error" role="alert">Source-card connections: {sourceError}</div>{/if}
  {#if notes.length || sourceNotes.length}<details class="bounds"><summary>Index boundaries / query limits ({notes.length + sourceNotes.length})</summary>{#each [...notes, ...sourceNotes] as note, i (i)}<p>{note}</p>{/each}</details>{/if}
  <div class="canvas" aria-label="Review board canvas" role="group" onpointerdowncapture={startPointerSelection} onpointercancel={() => { selectingRectangle = false; rectangleBase = []; rectangleOrigin = null; }}>
    <SvelteFlow bind:nodes bind:viewport {edges} {nodeTypes} {edgeTypes} minZoom={0.15} maxZoom={1.6} nodesConnectable={false} deleteKey={[]} zoomOnDoubleClick={false} panOnDrag={[2]} panActivationKey={[]} selectionOnDrag selectionKey={[]} multiSelectionKey="Shift" selectionMode={SelectionMode.Partial} autoPanOnNodeFocus={false} proOptions={{ hideAttribution: true }}
      onnodeclick={({ node, event }) => { if (!event.shiftKey) nodes = nodes.map((item) => ({ ...item, selected: item.id === node.id })); selected = node.type === 'symbol' ? node.id : model.targetState(node.data.symbolId, included, hidden).representative; if (node.type === 'code') nodes = nodes.map((item) => item.id === node.id ? { ...item, zIndex: ++zIndex } : item); }}
      onselectionstart={() => { selectingRectangle = true; }} onselectionend={finishRectangleSelection}
      onedgeclick={({ edge }) => { if (edge.data?.detachedMember) locateDetachedSource(String(edge.data.detachedMember)); else showEvidence(edge); }} onselectionchange={() => { retainRectangleSelection(); reflectSourceSelection(nodes.filter((node) => node.selected)); }} onpaneclick={() => { selected = null; evidence = null; }}>
      <Background gap={24} size={1} patternColor="var(--rule-soft)" /><Controls showLock={false} /><MiniMap pannable zoomable nodeColor={(node) => node.type === 'code' ? 'var(--press-2)' : 'var(--accent)'} />
    </SvelteFlow>
    {#if !included.length && !codeCount}<section class="empty"><h2>Choose what you want to understand</h2><p>Add symbols from this index. Connections helps you follow only the targets you choose.</p></section>{/if}
    {#if panel === 'library'}
      <aside class="panel library" aria-label="Symbol library"><div class="panel-heading"><h2 tabindex="-1">Add symbols</h2><button aria-label="Close symbol library" onclick={closePanel}>×</button></div>
        <div class="direction" aria-label="Selection source"><button class:active={libraryMode === 'symbols'} onclick={() => { libraryMode = 'symbols'; void search(); }}>Symbols</button><button class:active={libraryMode === 'folder'} disabled={!adapter.boardGroups} onclick={() => { libraryMode = 'folder'; groupPage = null; activeGroup = null; void groups(); }}>Folders</button><button class:active={libraryMode === 'namespace'} disabled={!adapter.boardGroups} onclick={() => { libraryMode = 'namespace'; groupPage = null; activeGroup = null; void groups(); }}>Namespaces</button></div>
        {#if libraryMode !== 'symbols'}
          <form onsubmit={(event) => { event.preventDefault(); void groups(); }}><label class="field">Find {libraryMode === 'folder' ? 'folders' : 'namespaces'}<input aria-label="Search selection groups" bind:value={groupQuery} /></label><button class="search" type="submit">Find groups</button></form>
          <div class="batch"><span>{groupPage?.total ?? 0} groups · preview before adding</span></div>
          <div class="result-list">{#each groupPage?.notes ?? [] as note}<p class="hint">{note}</p>{/each}{#each groupPage?.items ?? [] as group (group.id)}<section class="result"><strong>{group.name}</strong><span>{group.total} eligible symbols{group.type === 'folder' ? ' including nested folders' : ' in this indexed namespace scope'}</span>{#if group.type === 'namespace'}<small>{group.path}</small>{/if}<small>{group.byKind.map((entry) => `${entry.count} ${kindLabel(entry.kind)}`).join(' · ')}</small><button aria-label={`Preview ${group.type} ${group.name}`} onclick={() => browseGroup(group)}>Preview symbols</button></section>{/each}{#if (activeGroup?.offset ?? 0) > 0}<button class="more" disabled={groupBusy} onclick={() => groups(Math.max(0, (activeGroup?.offset ?? 0) - 30), true)}>Previous groups</button>{/if}{#if groupPage?.nextOffset !== null && groupPage?.nextOffset !== undefined}<button class="more" disabled={groupBusy} onclick={() => groups(groupPage!.nextOffset!, true)}>Next groups</button>{/if}{#if groupBusy}<p class="hint">Loading groups…</p>{/if}</div>
        {:else}
        <form onsubmit={(event) => { event.preventDefault(); void search(); }}><label class="field">Search<input aria-label="Search indexed symbols" bind:value={libraryQ} placeholder="Name or qualified name" /></label>
          <div class="filter-row"><label class="field">Kind<select aria-label="Symbol kind filter" bind:value={libraryKind}><option value="">All kinds</option>{#each allNodeKinds as item}<option value={item}>{kindLabel(item)}</option>{/each}</select></label><label class="field">Folder / file prefix<input aria-label="Symbol path filter" bind:value={libraryPath} placeholder="src/" /></label></div><button class="search" type="submit">Search index</button></form>
        {#if libraryNamespace}<div class="batch"><span>Namespace: {namespaceName}</span><button onclick={() => { libraryNamespace = ''; namespaceName = ''; void search(); }}>Clear namespace</button></div>{/if}
        <div class="batch"><span>{searchPage?.total ?? 0} matches{searchPage?.bounded ? ' · bounded' : ''}</span><button disabled={!searchSelection.length} onclick={() => add(searchSelection)}>Add selected ({searchSelection.length})</button><button disabled={!searchPage?.total || searchPage.total > 128 || searchBusy} onclick={addAllMatches}>Add all matches ({searchPage?.total ?? 0})</button>{#if (searchPage?.total ?? 0) > 128}<small>Narrow the folder/namespace, name or kind: a board retains at most 128 identities.</small>{/if}</div>
        <div class="result-list">{#each searchPage?.notes ?? [] as note}<p class="hint">{note}</p>{/each}{#each searchPage?.items ?? [] as item (item.id)}{@const state = model.targetState(item.id, included, hidden)}<section class="result"><label class="choice"><input type="checkbox" checked={searchSelection.includes(item.id)} aria-label={`Select ${item.qualifiedName}`} onchange={(event) => searchSelection = choose(searchSelection, item.id, event.currentTarget.checked)} /><KindGlyph kind={item.kind} /><strong>{item.name}</strong></label><small>{item.kind} · {item.qualifiedName} · {item.file}:{item.line}</small>
          <div class="row-actions"><button aria-label={`${state.status === 'visible' ? 'Locate' : state.status === 'hidden' ? 'Restore' : 'Add'} ${item.qualifiedName}`} onclick={() => targetAction(item.id)}>{state.status === 'visible' ? state.representative === item.id ? 'Pinned · Locate' : 'Folded · Locate' : state.status === 'hidden' ? 'Restore' : 'Add to board'}</button>{#if state.status === 'visible' && state.representative !== item.id}<button onclick={() => add([item.id])}>Pin separately</button>{/if}<button onclick={() => openCode(item.id)}>Source</button></div></section>{/each}
          {#if (activeSearch?.offset ?? 0) > 0}<button class="more" disabled={searchBusy} onclick={() => search(Math.max(0, (activeSearch?.offset ?? 0) - 40), true)}>Previous symbols</button>{/if}{#if searchPage?.nextOffset !== null && searchPage?.nextOffset !== undefined}<button class="more" disabled={searchBusy} onclick={() => search(searchPage!.nextOffset!, true)}>Next symbols</button>{/if}{#if searchBusy}<p>Searching…</p>{/if}</div>
        {/if}
      </aside>
    {:else if panel === 'connections' && connectionScope}
      <aside class="panel connections-panel" aria-label="Connections browser"><div class="panel-heading">{#if history.length}<button class="back" aria-label="Back to previous connections" onclick={backConnections}>← Back</button>{/if}<h2 tabindex="-1">Connections</h2><button aria-label="Close connections" onclick={closePanel}>×</button></div>
        <div class="scope">{display(connectionScope)} · {withMembers ? 'with contained members' : 'this symbol only'}</div>
        <div class="direction"><button class:active={direction === 'outgoing'} aria-pressed={direction === 'outgoing'} onclick={() => { direction = 'outgoing'; connectionSelection = []; void loadConnections(); }}>Outgoing</button><button class:active={direction === 'incoming'} aria-pressed={direction === 'incoming'} onclick={() => { direction = 'incoming'; connectionSelection = []; void loadConnections(); }}>Incoming</button><label><input type="checkbox" bind:checked={withMembers} onchange={() => { connectionSelection = []; void loadConnections(); }} /> Members</label></div>
        <form onsubmit={(event) => { event.preventDefault(); void loadConnections(); }}><div class="filter-row"><label class="field">Relationship<select aria-label="Connection relationship filter" bind:value={connectionKind} onchange={() => loadConnections()}><option value="">All kinds</option>{#each allEdgeKinds as item}<option value={item}>{kindLabel(item)}</option>{/each}</select></label><label class="field">Targets<input aria-label="Search connection targets" bind:value={connectionQ} placeholder="Name…" /></label><button type="submit">Find</button></div></form>
        <div class="batch"><span>{connectionPage?.total ?? 0} targets{connectionPage?.bounded ? ' · bounded scope/evidence' : ''}</span><button disabled={!connectionSelection.length} onclick={() => includeTargets(connectionSelection)}>Add selected ({connectionSelection.length})</button></div>
        <div class="result-list">{#each connectionPage?.notes ?? [] as note}<p class="hint">{note}</p>{/each}{#each connectionPage?.items ?? [] as row (row.target.id)}{@const state = model.targetState(row.target.id, included, hidden)}
          <section class="result" data-connection-target={row.target.id}><label class="choice"><input type="checkbox" aria-label={`Select target ${row.target.qualifiedName}`} disabled={state.status === 'visible'} checked={connectionSelection.includes(row.target.id)} onchange={(event) => connectionSelection = choose(connectionSelection, row.target.id, event.currentTarget.checked)} /><KindGlyph kind={row.target.kind} /><strong>{row.target.name}</strong></label><small>{row.target.kind} · {row.target.qualifiedName} · {row.target.file}</small>
            <div class="tags">{#each [...new Set(row.evidence.map((edge) => edge.kind))] as item}<span>{kindLabel(item)}</span>{/each}</div><p>{state.status === 'visible' ? state.representative === row.target.id ? 'Pinned on board' : `Folded in ${display(state.representative)}` : state.status === 'hidden' ? `Hidden in ${display(state.representative)}` : 'Not on board'}</p>
            <div class="row-actions"><button aria-label={`${state.status === 'visible' ? 'Locate' : state.status === 'hidden' ? 'Restore' : 'Add'} target ${row.target.qualifiedName}`} onclick={() => targetAction(row.target.id)}>{state.status === 'visible' ? 'Locate' : state.status === 'hidden' ? 'Restore' : 'Add to board'}</button>{#if row.owner}{@const ownerState = model.targetState(row.owner.id, included, hidden)}<button onclick={() => targetAction(row.owner!.id)}>{ownerState.status === 'visible' ? 'Locate' : ownerState.status === 'hidden' ? 'Restore' : 'Add'} owner: {row.owner.name}</button>{/if}{#if state.status === 'visible' && state.representative !== row.target.id}<button onclick={() => add([row.target.id])}>Pin separately</button>{/if}<button onclick={() => openCode(row.target.id)}>Source</button><button aria-label={`Connections for target ${row.target.qualifiedName}`} onclick={() => openConnections(row.target.id)}>Connections</button></div>
            <details><summary>{row.total} indexed evidence items</summary>{#each row.evidence as edge (edge.id)}<div class="evidence-row"><b>{display(edge.source)}</b> → {relationLabel(edge.kind)} → <b>{display(edge.target)}</b><small>{edge.file ?? 'Indexed edge'}{edge.line ? `:${edge.line}` : ''} · {edge.provenance ?? 'provenance unspecified'}{edge.confidence !== undefined ? ` · confidence ${edge.confidence}` : ''}</small>{#if edge.via || edge.synthesizedBy}<p>{edge.via ?? edge.synthesizedBy} {edge.registeredAt ?? ''}</p>{/if}<button onclick={() => compare(edge)}>Compare source ↗</button></div>{/each}{#if row.evidence.length < row.total}<button disabled={!adapter.boardEvidence || connectionBusy || busy || pendingEvidence[row.target.id] === connectionRequest} onclick={() => moreEvidence(row.target.id, row.evidence.length)}>More evidence ({row.total - row.evidence.length})</button>{#if !adapter.boardEvidence}<p class="hint">This host does not provide further evidence pages.</p>{/if}{/if}</details>
          </section>{/each}
          {#if (activeConnection?.offset ?? 0) > 0}<button class="more" disabled={connectionBusy} onclick={() => loadConnections(Math.max(0, (activeConnection?.offset ?? 0) - 30), true)}>Previous targets</button>{/if}{#if connectionPage?.nextOffset !== null && connectionPage?.nextOffset !== undefined}<button class="more" disabled={connectionBusy} onclick={() => loadConnections(connectionPage!.nextOffset!, true)}>Next targets</button>{/if}{#if connectionBusy}<p>Loading connections…{connectionPage ? ' Previous completed results are shown until this request finishes.' : ''}</p>{/if}
        </div>
      </aside>
    {:else if panel === 'hidden'}
      <aside class="panel" aria-label="Hidden items"><div class="panel-heading"><h2 tabindex="-1">Hidden items ({hidden.length})</h2>{#if hidden.length}<button onclick={() => restoreHidden([...hidden])}>Restore all hidden</button>{/if}<button onclick={closePanel} aria-label="Close hidden items">×</button></div><div class="result-list">{#each hidden as id}<section class="result"><strong>{display(id)}</strong><div class="row-actions"><button onclick={() => restoreHidden([id])}>Restore</button>{#if included.includes(id)}<button onclick={() => forget(id)}>Remove from board</button>{/if}</div></section>{:else}<p class="hint">Nothing hidden.</p>{/each}</div></aside>
    {:else if panel === 'boards'}
      <aside class="panel" aria-label="Saved boards"><div class="panel-heading"><h2 tabindex="-1">Saved boards</h2><button onclick={closePanel} aria-label="Close saved boards">×</button></div><p class="hint">{boardList?.directory ?? '.codegraph/ui/boards/'} · {boardList?.skipped ?? 0} unreadable files skipped{boardList?.bounded ? ' · list bounded' : ''}</p><div class="result-list">{#each boardList?.boards ?? [] as item}<section class="result"><strong>{item.name}</strong><small>{item.updatedAt}</small><div class="row-actions"><button disabled={!adapter.loadBoard} onclick={() => openBoard(item.id)}>Open {item.name}</button><button disabled={readOnly || !adapter.deleteBoard || deletingIds.includes(item.id)} onclick={() => removeBoard(item.id)}>{deletingIds.includes(item.id) ? 'Deleting…' : 'Delete'}</button></div></section>{:else}<p class="hint">No saved boards.</p>{/each}</div></aside>
    {/if}
    {#if evidence}<aside class="panel" aria-label="Relationship evidence"><div class="panel-heading"><h2 tabindex="-1">{relationLabel(evidence.kind)}</h2><button onclick={closePanel} aria-label="Close relationship evidence">×</button></div><p class="hint">{evidence.evidence.length} shown indexed edges. Browse Connections for full paged evidence when this projection is bounded.</p><div class="result-list">{#each evidence.evidence as edge (edge.id)}<section class="result"><strong>{display(edge.source)}</strong><span>→ {relationLabel(edge.kind)} →</span><strong>{display(edge.target)}</strong><small>{edge.file ?? ''}:{edge.line ?? ''} · {edge.provenance ?? 'unspecified'} · {edge.confidence ?? 'confidence unspecified'}</small>{#if edge.via || edge.synthesizedBy}<p>{edge.via ?? edge.synthesizedBy} {edge.registeredAt ?? ''}</p>{/if}<button onclick={() => compare(edge)}>Compare source ↗</button></section>{/each}</div></aside>{/if}
    <div class="notice" role="status">{busy ? 'Loading board…' : notice}</div>
  </div>
</div>
{/if}

<style>
  /* Only the active marquee is visible; selection remains on the cards after release. */
  .canvas :global(.svelte-flow__selection) { background: transparent; }
  /* Keep marquee-selected cards and the gaps between them directly interactive. */
  .canvas :global(.svelte-flow__selection-wrapper), .canvas :global(.svelte-flow__selection-wrapper .svelte-flow__selection) { pointer-events: none; }
  .board { height: 100%; display: flex; flex-direction: column; color: var(--ink); background: var(--paper); }
  .toolbar, .savebar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--rule-soft); flex-shrink: 0; }
  .toolbar { justify-content: space-between; }
  .visibility { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 5px 14px; border-bottom: 1px solid var(--rule-soft); font-size: 10px; color: var(--ink-2); flex-shrink: 0; }
  .visibility label { display: inline-flex; align-items: center; gap: 4px; }
  .keyboard-help { padding: 8px 14px; font-size: 11px; line-height: 1.5; border-bottom: 1px solid var(--rule-soft); }
  :global(.board :focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
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
