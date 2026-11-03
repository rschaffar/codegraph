<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Background, Controls, MiniMap, SvelteFlow, MarkerType, useSvelteFlow, type Edge, type Node } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import SymbolNode from '../components/board/BoardSymbolNode.svelte';
  import CodeCard from './CodeCard.svelte';
  import RelationEdge from '../components/board/BoardRelationEdge.svelte';
  import KindGlyph from '../components/KindGlyph.svelte';
  import { children, demoSymbols, initialSelection, symbol } from './demo-data';
  import { cardFamily, edgeKinds, kindLabel, nodeKinds, relationLabel, relationColor } from '../lib/board-catalog';
  import { browseConnections, filterSymbols, includeSymbols, nextCodePosition, nextSymbolPosition, projectBoard, targetState, memberOf,
    type BoardRelation, type BoardEvidence, type CodeCardData, type SymbolAction, type SymbolData } from './board-model';

  type BoardNode = Node<SymbolData, 'symbol'> | Node<CodeCardData, 'code'>;
  const { fitView } = useSvelteFlow();
  const nodeTypes = { symbol: SymbolNode, code: CodeCard };
  const edgeTypes = { relation: RelationEdge };
  let included = $state([...initialSelection]);
  let hidden = $state<string[]>([]);
  let expanded = $state<string[]>([]);
  let limits = $state<Record<string, number>>({});
  let nodes = $state<BoardNode[]>([]);
  let panel = $state<'library' | 'connections' | 'hidden' | 'help' | null>(null);
  let query = $state('');
  let folder = $state('');
  let libraryKind = $state('');
  let librarySelection = $state<string[]>([]);
  let selectedId = $state<string | null>(null);
  let evidence = $state<BoardRelation | null>(null);
  let canvasKind = $state('');
  let showStructure = $state(false);
  let connectionScope = $state('coordinator');
  let direction = $state<'outgoing' | 'incoming'>('outgoing');
  let withMembers = $state(true);
  let connectionKind = $state('');
  let connectionQuery = $state('');
  let targetSelection = $state<string[]>([]);
  let hideHistory = $state<string[]>([]);
  let connectionHistory = $state<Array<{ id: string; direction: 'incoming' | 'outgoing'; members: boolean; kind: string; query: string; selected: string[]; scroll: number }>>([]);
  let locatedMember = $state<string | undefined>();
  let notice = $state('Only the three chosen classes are on the board. Use Connections to choose what to add next.');
  let zIndex = 10;
  const rememberedPositions = new Map<string, { x: number; y: number }>();
  const expandedHeights = new Map<string, number>();
  const folders = [...new Set(demoSymbols.map((item) => item.folder))].sort();
  const availableKinds = [...nodeKinds, 'future_kind'];
  const availableRelations = [...edgeKinds, 'future_relation'];
  const projection = $derived(projectBoard(included, hidden, expanded, canvasKind, showStructure, limits));
  const results = $derived(filterSymbols(query, folder, libraryKind));
  const rows = $derived(browseConnections(connectionScope, direction, withMembers, included, hidden, connectionKind, connectionQuery));
  const groups = $derived.by(() => {
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.target.ownerId ?? row.target.folder ?? row.target.file;
      const list = grouped.get(key) ?? []; list.push(row); grouped.set(key, list);
    }
    return [...grouped].map(([key, entries]) => ({ key, owner: entries[0]?.target.ownerId, entries }));
  });
  const lastHidden = $derived([...hideHistory].reverse().find((id) => hidden.includes(id)));
  const codeCount = $derived(nodes.filter((node) => node.type === 'code').length);
  const edges = $derived<Edge[]>(projection.edges.map((edge) => {
    const parallels = projection.edges.filter((item) => item.source === edge.source && item.target === edge.target);
    const lane = edge.source === edge.target ? 320 + parallels.indexOf(edge) * 48 : (parallels.indexOf(edge) - (parallels.length - 1) / 2) * 56;
    const hot = evidence?.id === edge.id || selectedId === edge.source || selectedId === edge.target;
    const color = relationColor(edge.kind);
    return {
      id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle,
      type: 'relation', data: { relation: edge, lane },
      label: `${relationLabel(edge.kind)}${edge.evidence.length > 1 ? ` · ${edge.evidence.length}` : ''}${edge.via ? ' · heuristic' : ''}`,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      style: `stroke:${color};stroke-width:${hot ? 2.4 : 1.5};${edge.via ? 'stroke-dasharray:6 4;' : ''}opacity:${selectedId && !hot ? 0.3 : 1}`,
      labelStyle: 'color:var(--ink-2);font:10px var(--mono);background:var(--paper);padding:4px 5px', interactionWidth: 20,
    };
  }));

  function refresh() {
    const previous = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) if (node.type === 'symbol') rememberedPositions.set(node.id, { ...node.position });
    const occupied = nodes.map((node) => ({ position: node.position, width: node.width ?? node.measured?.width, height: node.height ?? node.measured?.height }));
    for (const id of hidden) {
      const position = rememberedPositions.get(id);
      if (position) occupied.push({ position, width: 286, height: 500 });
    }
    const placed: BoardNode[] = [];
    for (const item of projection.symbols) {
      const old = previous.get(item.symbol.id);
      let position = old?.position ?? rememberedPositions.get(item.symbol.id);
      if (!position) {
        const index = placed.length;
        const initialPositions: Record<string, { x: number; y: number }> = { coordinator: { x: 30, y: 180 }, factory: { x: 470, y: 30 }, state: { x: 470, y: 400 } };
        position = nextSymbolPosition(occupied, initialPositions[item.symbol.id] ?? { x: 30 + (index % 3) * 400, y: 30 + Math.floor(index / 3) * 300 });
      }
      occupied.push({ position, width: 286, height: old?.measured?.height ?? 240 });
      placed.push({ ...old, id: item.symbol.id, type: 'symbol', position, dragHandle: '.board-drag-handle', connectable: false,
        data: { ...item, expanded: expanded.includes(item.symbol.id), pinned: included.filter((id) => !hidden.includes(id)), hidden, locatedMember, act } });
    }
    nodes = [...placed, ...nodes.filter((node) => node.type === 'code')];
  }
  async function fitGraph() { await tick(); await fitView({ nodes: nodes.filter((node) => node.type === 'symbol'), padding: 0.16, maxZoom: 1, duration: 200 }); }
  async function fitCode() { await tick(); await fitView({ nodes: nodes.filter((node) => node.type === 'code'), padding: 0.14, maxZoom: 1, duration: 200 }); }
  function add(ids: string[]) {
    const next = includeSymbols(included, hidden, ids);
    included = next.included; hidden = next.hidden; evidence = null;
    targetSelection = targetSelection.filter((id) => targetState(id, included, hidden).status !== 'visible');
    librarySelection = librarySelection.filter((id) => !ids.includes(id));
    refresh();
    notice = `${ids.length === 1 ? symbol(ids[0]!).name : `${ids.length} symbols`} included. No neighbours were added; existing positions are unchanged.`;
  }
  function restore(id: string) { add([id]); notice = `${symbol(id).name} restored at its previous position.`; }
  function addTarget(id: string) {
    const state = targetState(id, included, hidden);
    if (state.status === 'visible') { void locate(id); return; }
    if (state.status === 'hidden') restore(state.representative); else add([id]);
  }
  function addSelectedTargets() {
    add([...new Set(targetSelection.map((id) => {
      const state = targetState(id, included, hidden); return state.status === 'hidden' ? state.representative : id;
    }))]);
    targetSelection = [];
  }
  function checkSelection(values: string[], id: string, checked: boolean): string[] {
    return checked ? [...new Set([...values, id])] : values.filter((item) => item !== id);
  }
  function openConnections(id: string) {
    if (panel === 'connections') connectionHistory = [...connectionHistory, { id: connectionScope, direction, members: withMembers, kind: connectionKind, query: connectionQuery, selected: [...targetSelection], scroll: document.querySelector('.connections-panel .result-list')?.scrollTop ?? 0 }];
    else connectionHistory = [];
    connectionScope = id; direction = 'outgoing'; connectionQuery = ''; connectionKind = ''; targetSelection = [];
    withMembers = cardFamily(symbol(id).kind) === 'type' || symbol(id).kind === 'component';
    panel = 'connections'; evidence = null; selectedId = targetState(id, included, hidden).representative;
  }
  async function backConnections() {
    const entry = connectionHistory.at(-1);
    if (!entry) return;
    connectionHistory = connectionHistory.slice(0, -1);
    connectionScope = entry.id; direction = entry.direction; withMembers = entry.members;
    connectionKind = entry.kind; connectionQuery = entry.query; targetSelection = entry.selected;
    await tick(); const list = document.querySelector('.connections-panel .result-list');
    if (list) list.scrollTop = entry.scroll;
  }
  async function locate(id: string) {
    const state = targetState(id, included, hidden);
    if (state.status !== 'visible') return;
    const owner = state.representative;
    locatedMember = owner !== id ? memberOf(id, owner) ?? undefined : undefined;
    if (owner !== id) {
      expanded = [...new Set([...expanded, owner])]; limits = { ...limits, [owner]: children(owner).length }; refresh();
    }
    selectedId = owner; nodes = nodes.map((node) => ({ ...node, selected: node.id === owner }));
    await tick(); await fitView({ nodes: [{ id: owner }], padding: 0.5, maxZoom: 1, duration: 200 });
    notice = owner === id ? `Located ${symbol(id).qualifiedName}.` : `${symbol(id).qualifiedName} is inside ${symbol(owner).name}${locatedMember && locatedMember !== id ? ` → ${symbol(locatedMember).name}` : ''}. The containing row is highlighted; Pin separately reveals the exact symbol as its own card.`;
  }
  function act(action: SymbolAction, id: string) {
    evidence = null;
    if (action === 'connections') openConnections(id);
    else if (action === 'restore') restore(id);
    else if (action === 'hide') {
      hidden = [...new Set([...hidden, id])]; hideHistory = [...hideHistory.filter((item) => item !== id), id];
      if (selectedId === id) selectedId = null; refresh();
      notice = `${symbol(id).name} hidden, not deleted. Undo hide, Hidden items or Connections can restore it.`;
    } else if (action === 'expand' || action === 'more') {
      if (action === 'expand') expanded = expanded.includes(id) ? expanded.filter((item) => item !== id) : [...expanded, id];
      else limits = { ...limits, [id]: (limits[id] ?? 6) + 6 };
      refresh();
    } else if (action === 'locate') void locate(id);
    else openCode(id);
  }
  function closeCard(id: string) { nodes = nodes.filter((node) => node.id !== id); expandedHeights.delete(id); }
  function toggleCard(id: string) {
    nodes = nodes.map((node) => {
      if (node.id !== id || node.type !== 'code') return node;
      if (!node.data.collapsed) expandedHeights.set(id, node.height ?? node.measured?.height ?? 310);
      return { ...node, height: node.data.collapsed ? (expandedHeights.get(id) ?? 310) : 82, data: { ...node.data, collapsed: !node.data.collapsed } };
    });
  }
  function readCard(id: string) { void tick().then(() => fitView({ nodes: [{ id }], padding: 0.25, maxZoom: 1.1, duration: 200 })); }
  function openCode(symbolId: string, fit = true): string {
    const id = `code:${symbolId}`;
    selectedId = targetState(symbolId, included, hidden).representative;
    if (nodes.some((node) => node.id === id)) nodes = nodes.map((node) => ({ ...node, selected: node.id === id, ...(node.id === id ? { zIndex: ++zIndex } : {}) }));
    else {
      const top = Math.max(820, ...nodes.filter((node) => node.type === 'symbol').map((node) => node.position.y + (node.measured?.height ?? 240) + 100));
      nodes = [...nodes.map((node) => ({ ...node, selected: false })), { id, type: 'code', position: nextCodePosition(nodes.filter((node) => node.type === 'code'), top),
        width: 530, height: 310, zIndex: ++zIndex, selected: true, dragHandle: '.board-drag-handle', connectable: false,
        data: { symbolId, collapsed: false, close: closeCard, toggle: toggleCard, read: readCard } }];
    }
    notice = 'Independent source card opened. Use Read or Fit code for readable text; Fit graph returns to the overview.';
    if (fit) { panel = null; evidence = null; readCard(id); }
    return id;
  }
  async function compare(edge: BoardEvidence) { openCode(edge.source, false); openCode(edge.target, false); evidence = null; panel = null; await fitCode(); }
  function reset(mode: 'review' | 'gallery' | 'empty' = 'review') {
    included = mode === 'empty' ? [] : mode === 'gallery' ? [...nodeKinds.map((kind) => demoSymbols.find((item) => item.kind === kind)!.id), 'unknown'] : [...initialSelection];
    hidden = []; expanded = []; limits = {}; nodes = []; selectedId = null; evidence = null; panel = null; canvasKind = ''; showStructure = false;
    query = ''; folder = ''; libraryKind = ''; librarySelection = []; targetSelection = []; hideHistory = []; connectionHistory = []; locatedMember = undefined; zIndex = 10;
    rememberedPositions.clear(); expandedHeights.clear(); refresh();
    notice = mode === 'gallery' ? 'Kind gallery: one of every indexed node kind plus an unknown-kind fallback. All additions are explicit.' : 'Choose symbols, then browse Connections. Adding never expands their neighbourhood.';
    if (included.length) void fitGraph();
  }
  function tidy() {
    let x = 30; let y = 30; let rowHeight = 0;
    nodes = nodes.map((node) => {
      if (node.type !== 'symbol') return node;
      if (x > 900) { x = 30; y += rowHeight + 100; rowHeight = 0; }
      const position = { x, y }; x += 400; rowHeight = Math.max(rowHeight, node.measured?.height ?? 240);
      return { ...node, position };
    });
    notice = 'Tidy explicitly rearranged graph cards. Source cards are unchanged.'; void fitGraph();
  }
  function showEvidence(edge: Edge) { if (edge.data?.relation) { evidence = edge.data.relation as BoardRelation; selectedId = null; panel = null; } }
  function onkeydown(event: KeyboardEvent) { if (event.key === 'Escape') { panel = null; evidence = null; } }
  onMount(() => { refresh(); void fitGraph(); });
</script>

<svelte:window {onkeydown} />
<div class="prototype">
  <header class="topbar">
    <a class="brand" href="./" title="Open the existing viewer"><span class="brandmark"></span> CodeGraph</a>
    <div class="divider"></div><h1>Review board</h1><span class="prototype-badge">Clickdummy</span>
    <span class="sample-warning">Synthetic data · no live index · nothing is saved</span>
    <button class="help-button" onclick={() => { panel = panel === 'help' ? null : 'help'; evidence = null; }}>How to explore</button>
  </header>
  <div class="toolbar">
    <div class="toolgroup">
      <button class="primary" aria-expanded={panel === 'library'} onclick={() => { panel = panel === 'library' ? null : 'library'; evidence = null; }}>+ Add symbols</button>
      <button aria-expanded={panel === 'hidden'} onclick={() => { panel = panel === 'hidden' ? null : 'hidden'; evidence = null; }}>Hidden items ({hidden.length})</button>
      {#if lastHidden}<button onclick={() => restore(lastHidden!)} title={`Restore ${symbol(lastHidden).name}`}>Undo hide</button>{/if}
      <label>Edges <select aria-label="Canvas relationship filter" bind:value={canvasKind} onchange={() => { evidence = null; refresh(); }}><option value="">All kinds</option>{#each availableRelations as kind}<option value={kind}>{kindLabel(kind)}</option>{/each}</select></label>
      <label><input type="checkbox" bind:checked={showStructure} onchange={() => { evidence = null; refresh(); }} /> Ownership arrows</label>
    </div>
    <div class="toolgroup viewport-tools">
      <button onclick={fitGraph} disabled={!projection.symbols.length}>Fit graph</button><button onclick={fitCode} disabled={!codeCount}>Fit code{codeCount ? ` (${codeCount})` : ''}</button>
      <button onclick={tidy} disabled={!projection.symbols.length}>Tidy</button><button onclick={() => reset('gallery')}>Kind gallery</button>
      <button onclick={() => reset('empty')}>Start empty</button><button onclick={() => reset()}>Reset example</button>
    </div>
  </div>
  <main aria-label="Review board canvas">
    <SvelteFlow bind:nodes {edges} {nodeTypes} {edgeTypes} minZoom={0.15} maxZoom={1.6} nodesConnectable={false} deleteKey={null}
      zoomOnDoubleClick={false} panOnDrag fitView fitViewOptions={{ padding: 0.16, maxZoom: 1 }} proOptions={{ hideAttribution: true }}
      onnodeclick={({ node }) => { selectedId = node.type === 'code' ? targetState(node.data.symbolId, included, hidden).representative : node.id; evidence = null;
        if (node.type === 'code') nodes = nodes.map((item) => item.id === node.id ? { ...item, zIndex: ++zIndex } : item); }}
      onedgeclick={({ edge }) => showEvidence(edge)} onselectionchange={({ edges: selected }) => { if (selected.length === 1) showEvidence(selected[0]!); }}
      onpaneclick={() => { selectedId = null; evidence = null; }}>
      <Background gap={24} size={1} patternColor="var(--rule-soft)" /><Controls position="bottom-right" showLock={false} />
      <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => node.type === 'code' ? 'var(--press-2)' : 'var(--accent)'} />
    </SvelteFlow>

    {#if !projection.symbols.length && !hidden.length}
      <section class="empty"><h2>Start with what you want to understand</h2><p>Add classes, functions, values or other symbols. Only your choices appear—no automatic neighbours.</p><button class="primary" onclick={() => panel = 'library'}>+ Add starting symbols</button></section>
    {/if}
    {#if panel === 'library'}
      <aside class="panel library" aria-label="Symbol library">
        <div class="panel-heading"><h2>Add symbols</h2><button aria-label="Close symbol library" onclick={() => panel = null}>×</button></div>
        <p class="panel-hint">All 23 indexed kinds, plus a future-kind fallback. Selection can span namespaces.</p>
        <label class="field">Search<input aria-label="Search sample symbols" placeholder="Name, kind, namespace…" bind:value={query} /></label>
        <div class="filter-row"><label class="field">Kind<select aria-label="Filter symbol kind" bind:value={libraryKind}><option value="">All kinds</option>{#each availableKinds as kind}<option value={kind}>{kindLabel(kind)}</option>{/each}</select></label>
          <label class="field">Namespace<select aria-label="Filter sample namespace" bind:value={folder}><option value="">All namespaces</option>{#each folders as item}<option value={item}>{item}</option>{/each}</select></label></div>
        <div class="batch"><button disabled={!librarySelection.length} onclick={() => { add(librarySelection); librarySelection = []; }}>Add selected ({librarySelection.length})</button>
          {#if folder || libraryKind}<button disabled={!results.length} onclick={() => add(results.map((item) => item.id))}>Add matching ({results.length})</button>{/if}
          {#if librarySelection.length}<button onclick={() => librarySelection = []}>Clear</button>{/if}</div>
        <div class="result-list">
          {#each results as item (item.id)}
            {@const state = targetState(item.id, included, hidden)}
            <div class="result" data-library-symbol={item.id}>
              <label class="choice"><input type="checkbox" aria-label={`Select ${item.qualifiedName}`} checked={librarySelection.includes(item.id)} onchange={(event) => librarySelection = checkSelection(librarySelection, item.id, event.currentTarget.checked)} /><KindGlyph kind={item.kind} /><strong>{item.name}</strong></label>
              <small>{kindLabel(item.kind)} · {item.folder}{item.ownerId ? ` · in ${symbol(item.ownerId).name}` : ''}</small><p>{item.purpose}</p>
              <div class="row-actions"><button aria-label={`${state.status === 'visible' ? 'Locate' : state.status === 'hidden' ? 'Restore' : 'Add'} ${item.qualifiedName}`} onclick={() => addTarget(item.id)}>{state.status === 'visible' ? 'Locate' : state.status === 'hidden' ? 'Restore' : 'Add to board'}</button>
                {#if state.status === 'visible' && state.representative !== item.id}<button aria-label={`Pin ${item.qualifiedName} separately`} onclick={() => add([item.id])}>Pin separately</button>{/if}<button onclick={() => openCode(item.id)}>Source</button></div>
            </div>
          {:else}<p class="panel-hint">No sample symbols match.</p>{/each}
        </div>
      </aside>
    {:else if panel === 'connections'}
      <aside class="panel connections-panel" aria-label="Connections browser">
        <div class="panel-heading">{#if connectionHistory.length}<button class="back" aria-label="Back to previous connections" onclick={backConnections}>← Back</button>{/if}<h2>Connections</h2><button aria-label="Close connections" onclick={() => panel = null}>×</button></div>
        <div class="scope"><KindGlyph kind={symbol(connectionScope).kind} /><strong>{symbol(connectionScope).qualifiedName}</strong><small>{kindLabel(symbol(connectionScope).kind)}</small></div>
        <div class="direction"><button class:active={direction === 'outgoing'} aria-pressed={direction === 'outgoing'} onclick={() => { direction = 'outgoing'; targetSelection = []; }}>Outgoing</button><button class:active={direction === 'incoming'} aria-pressed={direction === 'incoming'} onclick={() => { direction = 'incoming'; targetSelection = []; }}>Incoming</button></div>
        {#if children(connectionScope).length}<label class="scope-toggle"><input type="checkbox" bind:checked={withMembers} onchange={() => targetSelection = []} /> Include contained members</label>{/if}
        <label class="field">Relationship<select aria-label="Connection relationship filter" bind:value={connectionKind}><option value="">All relationship kinds</option>{#each availableRelations as kind}<option value={kind}>{kindLabel(kind)}</option>{/each}</select></label>
        <label class="field">Search targets<input aria-label="Search connection targets" placeholder="Target, kind or namespace…" bind:value={connectionQuery} /></label>
        <p class="panel-hint">{rows.length} targets · {withMembers ? 'symbol + members' : 'this symbol only'} · sample evidence</p>
        <div class="batch"><button disabled={!targetSelection.length} onclick={addSelectedTargets}>Add selected ({targetSelection.length})</button>{#if targetSelection.length}<button onclick={() => targetSelection = []}>Clear</button>{/if}</div>
        <div class="result-list">
          {#each groups as group (group.key)}
            <div class="group-heading"><span>{group.owner ? symbol(group.owner).qualifiedName : group.key}</span>
              {#if group.owner && !included.includes(group.owner)}<button aria-label={`Add owner ${symbol(group.owner).qualifiedName}`} onclick={() => add([group.owner!])}>Add owner</button>{/if}</div>
            {#each group.entries as row (row.target.id)}
              <section class="result" data-connection-target={row.target.id}>
                <label class="choice"><input type="checkbox" aria-label={`Select target ${row.target.qualifiedName}`} disabled={row.status === 'visible'} checked={targetSelection.includes(row.target.id)} onchange={(event) => targetSelection = checkSelection(targetSelection, row.target.id, event.currentTarget.checked)} /><KindGlyph kind={row.target.kind} /><strong>{row.target.name}</strong></label>
                <small>{kindLabel(row.target.kind)} · {row.target.folder}</small>
                <div class="relationship-tags">{#each [...new Set(row.evidence.map((edge) => edge.kind))] as kind}<span>{kindLabel(kind)}</span>{/each}</div>
                <p class="target-status">{row.status === 'visible' ? row.representative === row.target.id ? 'Pinned on board' : 'Folded' : row.status === 'hidden' ? 'Hidden' : 'Not on board'}{row.representative !== row.target.id ? ` in ${symbol(row.representative).name}` : ''}</p>
                <div class="row-actions"><button aria-label={`${row.status === 'visible' ? 'Locate' : row.status === 'hidden' ? 'Restore' : 'Add'} target ${row.target.qualifiedName}`} onclick={() => addTarget(row.target.id)}>{row.status === 'visible' ? 'Locate' : row.status === 'hidden' ? `Restore ${symbol(row.representative).name}` : 'Add to board'}</button>
                  {#if row.status === 'visible' && row.representative !== row.target.id}<button aria-label={`Pin target ${row.target.qualifiedName} separately`} onclick={() => add([row.target.id])}>Pin separately</button>{/if}<button onclick={() => openCode(row.target.id)}>Source</button><button onclick={() => openConnections(row.target.id)}>Connections</button></div>
                <details><summary>{row.evidence.length} sample evidence {row.evidence.length === 1 ? 'item' : 'items'}</summary>{#each row.evidence as edge (edge.id)}<div class="evidence-row"><b>{symbol(edge.source).qualifiedName}</b> → {relationLabel(edge.kind)} → <b>{symbol(edge.target).qualifiedName}</b><small>{edge.file}:{edge.line}</small>{#if edge.via}<p>{edge.via}</p>{/if}<button onclick={() => compare(edge)}>Compare source ↗</button></div>{/each}</details>
              </section>
            {/each}
          {:else}<p class="panel-hint">No connections match this direction, scope and filter. Nothing has been added or removed.</p>{/each}
        </div>
      </aside>
    {:else if panel === 'hidden'}
      <aside class="panel" aria-label="Hidden items">
        <div class="panel-heading"><h2>Hidden items ({hidden.length})</h2><button aria-label="Close hidden items" onclick={() => panel = null}>×</button></div>
        <p class="panel-hint">Hidden symbols stay in your selection. Restore keeps their previous positions and expanded members.</p>
        {#if hidden.length}<div class="batch"><button onclick={() => add([...hidden])}>Restore all hidden</button></div>{/if}
        {#each hidden as id}<div class="result"><div class="choice"><KindGlyph kind={symbol(id).kind} /><strong>{symbol(id).qualifiedName}</strong></div><small>{kindLabel(symbol(id).kind)}</small><div class="row-actions"><button aria-label={`Restore hidden ${symbol(id).qualifiedName}`} onclick={() => restore(id)}>Restore</button></div></div>{:else}<p class="panel-hint">Nothing hidden. Use × on a graph card to hide it without losing it.</p>{/each}
      </aside>
    {:else if panel === 'help'}
      <aside class="panel" aria-label="Prototype instructions"><div class="panel-heading"><h2>Explore deliberately</h2><button aria-label="Close prototype instructions" onclick={() => panel = null}>×</button></div>
        <ol><li>Use <b>Add symbols</b> for any kind, or <b>Kind gallery</b> to see all card families.</li><li>Open a card's <b>Connections…</b>, or a member's <b>Links</b>. Choose a direction and relationship filter.</li><li><b>Add to board</b> adds only that target. <b>Add owner</b> selects its class/container instead. Folded members can be pinned separately.</li><li>Hidden targets offer <b>Restore</b>. The toolbar also has <b>Hidden items</b> and <b>Undo hide</b>.</li><li>Edges keep their kind. Ownership normally uses member outlines; enable its arrows explicitly.</li><li>Source cards can be dragged, resized, collapsed and compared. No source, Git or index writes occur.</li></ol><p class="panel-hint">Fixed sample data only. Reload resets everything.</p>
      </aside>
    {/if}

    {#if evidence}
      <aside class="panel" aria-label="Relationship evidence"><div class="panel-heading"><h2>Relationship evidence</h2><button aria-label="Close relationship evidence" onclick={() => evidence = null}>×</button></div>
        <p class="panel-hint">{symbol(evidence.source).name} → <b>{relationLabel(evidence.kind)}</b> → {symbol(evidence.target).name}. {evidence.evidence.length} hand-authored sample evidence items.</p>
        {#each evidence.evidence as edge (edge.id)}<section class="result"><strong>{symbol(edge.source).qualifiedName}</strong><span>→ {kindLabel(edge.kind)} →</span><strong>{symbol(edge.target).qualifiedName}</strong><small>{edge.file}:{edge.line}</small>{#if edge.via}<p>{edge.via}</p>{/if}<div class="row-actions"><button onclick={() => openCode(edge.source)}>Source endpoint</button><button onclick={() => openCode(edge.target)}>Target endpoint</button><button onclick={() => compare(edge)}>Compare source ↗</button></div></section>{/each}
      </aside>
    {/if}
    <div class="board-key">{projection.symbols.length} symbols on board · {projection.edges.length} typed links · no automatic neighbours{canvasKind ? ` · filter: ${kindLabel(canvasKind)}` : ''}{!showStructure ? ' · ownership in outlines' : ''}</div>
    <div class="notice" role="status" aria-live="polite">{notice}</div>
  </main>
  <footer class="prototype-footer"><span>23 node kinds · 13 relationship kinds · unknown-kind fallbacks</span><span>Session-only sample · no live queries or saving</span></footer>
</div>

<style>
  :global(#app) { display: block; }
  .prototype { height: 100dvh; display: flex; flex-direction: column; background: var(--paper); color: var(--ink); }
  .topbar { height: 58px; display: flex; align-items: center; gap: 14px; padding: 0 22px; border-bottom: 1px solid var(--rule); flex-shrink: 0; }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
  .brandmark { height: 11px; width: 11px; border: 1px solid var(--ink); }
  .divider { height: 20px; border-left: 1px solid var(--rule-soft); }
  h1 { font-size: 15px; margin: 0; font-weight: 500; }
  .prototype-badge { color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-line); padding: 3px 7px; font-size: 11px; }
  .sample-warning { font-size: 11px; color: var(--ink-3); flex: 1; }
  .help-button { font-size: 12px; color: var(--ink-2); margin-left: auto; }
  .toolbar { min-height: 54px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 8px 18px; border-bottom: 1px solid var(--rule-soft); }
  .toolgroup { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .toolgroup button { border: 1px solid var(--rule-soft); padding: 6px 9px; font-size: 12px; background: var(--paper); white-space: nowrap; }
  button.primary, .primary { background: var(--accent); border: 1px solid var(--accent); color: var(--paper); padding: 7px 12px; font-size: 12px; }
  button:hover:not(:disabled) { background: var(--press); }
  button.primary:hover { background: var(--accent-ink); }
  button:disabled { opacity: 0.45; cursor: default; }
  .toolgroup label, .scope-toggle { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--ink-2); white-space: nowrap; }
  .toolgroup select { background: var(--paper); color: var(--ink); border: 1px solid var(--rule-soft); padding: 5px; max-width: 120px; font-size: 11px; }
  input[type='checkbox'] { accent-color: var(--accent); }
  main { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  main :global(.svelte-flow__minimap) { bottom: 45px; width: 135px; height: 90px; border: 1px solid var(--rule-soft); background: var(--paper); }
  main :global(.svelte-flow__controls) { display: flex; right: 15px; bottom: 10px; flex-direction: row; box-shadow: none; border: 1px solid var(--rule-soft); }
  main :global(.svelte-flow__controls-button) { width: 30px; height: 28px; }
  main :global(.svelte-flow__edge.selected .svelte-flow__edge-path) { stroke: var(--accent); }
  .panel { position: absolute; z-index: 20; width: 380px; right: 14px; top: 14px; max-height: calc(100% - 94px); display: flex; flex-direction: column; background: var(--paper); border: 1px solid var(--rule); overflow: auto; }
  .library { left: 14px; right: auto; }
  .panel-heading { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--rule-soft); }
  h2 { margin: 0; font-size: 14px; }
  .panel-heading button { font-size: 22px; line-height: 18px; }
  .panel-hint { color: var(--ink-2); font-size: 12px; padding: 0 16px; line-height: 1.5; }
  .field { padding: 0 16px; display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; font-size: 11px; color: var(--ink-2); min-width: 0; flex: 1; }
  .field input, .field select { font: inherit; color: var(--ink); background: var(--paper-2); padding: 9px 8px; border: 1px solid var(--rule-soft); width: 100%; }
  .filter-row { display: flex; }
  .filter-row .field:first-child { padding-right: 6px; }
  .filter-row .field:last-child { padding-left: 6px; }
  .batch, .direction { display: flex; gap: 10px; padding: 0 16px 12px; flex-wrap: wrap; }
  .batch button, .direction button { padding: 7px; border: 1px solid var(--rule-soft); font-size: 11px; }
  .direction .active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .connections-panel { overflow: hidden; }
  .connections-panel > :not(.result-list) { flex-shrink: 0; }
  .connections-panel .result-list { overflow: auto; min-height: 100px; flex: 1; }
  .connections-panel .field { margin-bottom: 5px; }
  .connections-panel .field input, .connections-panel .field select { padding: 5px 7px; }
  .connections-panel .panel-hint { margin: 4px 0; font-size: 10px; }
  .connections-panel .direction, .connections-panel .batch { padding-bottom: 5px; }
  .connections-panel .scope-toggle { padding-bottom: 5px; }
  .back { font-size: 11px !important; color: var(--accent); }
  .scope { display: flex; align-items: center; gap: 8px; padding: 7px 16px; flex-wrap: wrap; }
  .scope strong { font: 12px var(--mono); overflow-wrap: anywhere; }
  .scope small { font-size: 10px; color: var(--ink-3); }
  .scope-toggle { padding: 0 16px 14px; }
  .result-list { border-top: 1px solid var(--rule-soft); }
  .result { padding: 12px 16px; border-bottom: 1px solid var(--rule-soft); display: flex; flex-direction: column; gap: 6px; }
  .choice { display: flex; align-items: center; gap: 8px; font: 12px var(--mono); overflow-wrap: anywhere; }
  .result strong { font: 12px var(--mono); overflow-wrap: anywhere; }
  .result small { color: var(--ink-3); font: 10px var(--mono); overflow-wrap: anywhere; }
  .result p { font-size: 11px; color: var(--ink-2); margin: 0; line-height: 1.5; }
  .row-actions { display: flex; gap: 12px; flex-wrap: wrap; margin: 4px 0; }
  .row-actions button { font-size: 11px; text-decoration: underline; text-underline-offset: 3px; }
  .row-actions button:first-child { color: var(--accent); font-weight: 600; }
  .relationship-tags { display: flex; gap: 5px; flex-wrap: wrap; }
  .relationship-tags span { background: var(--paper-2); border: 1px solid var(--rule-soft); padding: 2px 5px; font: 10px var(--mono); }
  .target-status { color: var(--accent) !important; }
  .group-heading { padding: 9px 16px; background: var(--paper-2); font: 10px var(--mono); display: flex; justify-content: space-between; gap: 8px; overflow-wrap: anywhere; }
  .group-heading button { color: var(--accent); white-space: nowrap; }
  details { font-size: 11px; }
  summary { color: var(--ink-2); cursor: pointer; padding: 6px 0; }
  .evidence-row { padding: 8px 0; line-height: 1.6; border-top: 1px solid var(--rule-faint); overflow-wrap: anywhere; }
  .evidence-row small { display: block; }
  .evidence-row button { color: var(--accent); text-decoration: underline; margin-top: 6px; }
  .panel ol { padding: 0 22px 0 34px; line-height: 1.7; font-size: 12px; }
  .panel li { margin: 9px 0; }
  .board-key { position: absolute; left: 18px; bottom: 39px; z-index: 5; padding: 7px 10px; background: var(--paper); border: 1px solid var(--rule-soft); font-size: 10px; color: var(--ink-2); pointer-events: none; max-width: calc(100% - 200px); }
  .notice { position: absolute; left: 18px; bottom: 10px; z-index: 5; font-size: 11px; color: var(--ink-2); pointer-events: none; background: var(--paper); max-width: calc(100% - 200px); padding: 2px 4px; }
  .prototype-footer { display: flex; justify-content: space-between; padding: 7px 22px; border-top: 1px solid var(--rule-soft); font-size: 10px; color: var(--ink-3); }
  .empty { position: absolute; inset: 22% 25%; text-align: center; z-index: 5; pointer-events: none; }
  .empty h2 { font-size: 20px; }
  .empty p { color: var(--ink-2); line-height: 1.6; }
  .empty button { pointer-events: auto; }
  @media (max-width: 1100px) { .sample-warning { display: none; } .topbar { gap: 10px; } .toolbar { padding: 8px 12px; } }
  @media (max-width: 760px) { .panel { width: min(380px, calc(100% - 28px)); } .prototype-footer span:last-child { display: none; } .notice, .board-key { max-width: calc(100% - 30px); } .notice { bottom: 5px; } .board-key { bottom: 50px; } }
</style>
