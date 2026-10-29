<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Background, Controls, MiniMap, SvelteFlow, MarkerType, useSvelteFlow, type Edge, type Node } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import ComponentNode from './ComponentNode.svelte';
  import CodeCard from './CodeCard.svelte';
  import { component, demoComponents, initialFocus, type DemoCall } from './demo-data';
  import { filterComponents, nextCodePosition, projectBoard, type BoardCall, type CodeCardData, type ComponentData, type ComponentAction } from './board-model';

  type BoardNode = Node<ComponentData, 'component'> | Node<CodeCardData, 'code'>;
  const { fitView } = useSvelteFlow();
  const nodeTypes = { component: ComponentNode, code: CodeCard };
  let focus = $state([...initialFocus]);
  let hidden = $state<string[]>([]);
  let expanded = $state<string[]>([]);
  let includeContext = $state(true);
  let nodes = $state<BoardNode[]>([]);
  let libraryOpen = $state(false);
  let helpOpen = $state(false);
  let query = $state('');
  let folder = $state('');
  let selectedComponent = $state<string | null>(null);
  let evidence = $state<BoardCall | null>(null);
  let notice = $state('Start with the three highlighted components. Muted cards are their direct neighbours.');
  let zIndex = 10;
  const expandedHeights = new Map<string, number>();
  const rememberedPositions = new Map<string, { x: number; y: number }>();
  const folders = [...new Set(demoComponents.map((item) => item.folder))].sort();
  const projection = $derived(projectBoard(focus, hidden, expanded, includeContext));
  const results = $derived(filterComponents(query, folder));
  const codeCount = $derived(nodes.filter((node) => node.type === 'code').length);
  const focusCount = $derived(projection.components.filter((item) => item.role === 'focus').length);
  const contextCount = $derived(projection.components.length - focusCount);
  const edges = $derived<Edge[]>(projection.edges.map((edge) => {
    const hot = evidence?.id === edge.id || selectedComponent === edge.source || selectedComponent === edge.target;
    return {
      id: edge.id, source: edge.source, target: edge.target,
      sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle,
      type: 'smoothstep', data: { call: edge },
      label: `${edge.calls.length} call ${edge.calls.length === 1 ? 'site' : 'sites'}${edge.via ? ' · interface' : ''}`,
      markerEnd: { type: MarkerType.ArrowClosed, color: hot ? 'var(--accent)' : 'var(--ink-3)', width: 16, height: 16 },
      style: `stroke:${hot ? 'var(--accent)' : 'var(--ink-3)'};stroke-width:${hot ? 2 : 1.2};${edge.via ? 'stroke-dasharray:6 4;' : ''}opacity:${selectedComponent && !hot ? 0.3 : 1}`,
      labelStyle: `color:${hot ? 'var(--accent)' : 'var(--ink-2)'};font:10px var(--mono);background:var(--paper);padding:4px 5px`,
      interactionWidth: 20,
    };
  }));

  /** Reconcile graph facts without replacing positions or independent source cards. */
  function refresh() {
    const previous = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      if (node.type === 'component') rememberedPositions.set(node.id, { ...node.position });
    }
    const cards = nodes.filter((node) => node.type === 'code');
    nodes = [
      ...projection.components.map((item): BoardNode => ({
        ...previous.get(item.component.id),
        id: item.component.id, type: 'component',
        position: previous.get(item.component.id)?.position ?? rememberedPositions.get(item.component.id) ?? { ...item.component.position },
        dragHandle: '.board-drag-handle', connectable: false,
        data: { ...item, expanded: expanded.includes(item.component.id), act },
      })),
      ...cards,
    ];
  }

  async function fitGraph() {
    await tick();
    await fitView({ nodes: nodes.filter((node) => node.type === 'component'), padding: 0.16, maxZoom: 1, duration: 200 });
  }

  async function fitCode() {
    await tick();
    await fitView({ nodes: nodes.filter((node) => node.type === 'code'), padding: 0.14, maxZoom: 1, duration: 200 });
  }

  function add(ids: string[]) {
    focus = [...new Set([...focus, ...ids])];
    hidden = hidden.filter((id) => !ids.includes(id));
    evidence = null;
    refresh();
    notice = `Added ${ids.length === 1 ? component(ids[0]!).name : `${ids.length} components`} to focus. Existing positions are unchanged.`;
  }

  function act(action: ComponentAction, id: string, method?: string) {
    evidence = null;
    if (action === 'promote') {
      add([id]);
    } else if (action === 'hide') {
      hidden = [...new Set([...hidden, id])];
      selectedComponent = null;
      refresh();
      notice = `${component(id).name} is hidden. Restore it from Add components or Show hidden.`;
    } else if (action === 'expand') {
      expanded = expanded.includes(id) ? expanded.filter((item) => item !== id) : [...expanded, id];
      refresh();
      notice = `${component(id).name}: ${expanded.includes(id) ? 'methods expanded' : 'collapsed'}. Source cards and other positions stay put.`;
    } else {
      openCode(id, method ?? component(id).methods[0]!.name);
    }
  }

  function closeCard(id: string) {
    nodes = nodes.filter((node) => node.id !== id);
    expandedHeights.delete(id);
  }

  function toggleCard(id: string) {
    nodes = nodes.map((node) => {
      if (node.id !== id || node.type !== 'code') return node;
      if (!node.data.collapsed) expandedHeights.set(id, node.height ?? node.measured?.height ?? 310);
      return { ...node, height: node.data.collapsed ? (expandedHeights.get(id) ?? 310) : 82,
        data: { ...node.data, collapsed: !node.data.collapsed } };
    });
  }

  function readCard(id: string) {
    void tick().then(() => fitView({ nodes: [{ id }], padding: 0.25, maxZoom: 1.1, duration: 200 }));
  }

  function openCode(componentId: string, method: string, fit = true): string {
    const id = `code:${componentId}.${method}`;
    selectedComponent = componentId;
    if (nodes.some((node) => node.id === id)) {
      nodes = nodes.map((node) => ({ ...node, selected: node.id === id, ...(node.id === id ? { zIndex: ++zIndex } : {}) }));
    } else {
      const position = nextCodePosition(nodes.filter((node) => node.type === 'code'));
      nodes = [...nodes.map((node) => ({ ...node, selected: false })), {
        id, type: 'code', position,
        width: 530, height: 310, zIndex: ++zIndex, selected: true,
        dragHandle: '.board-drag-handle', connectable: false,
        data: { componentId, method, collapsed: false, close: closeCard, toggle: toggleCard, read: readCard },
      }];
    }
    notice = 'Source cards share the canvas. Drag their headers, resize the selected card, or use Fit graph to return to the overview.';
    if (fit) {
      // Keep the originating component in sight; Read is the explicit zoom
      // into source, not an automatic departure from the graph on every click.
      void tick().then(() => fitView({ nodes: [{ id: componentId }, { id }], padding: 0.2, maxZoom: 1, duration: 200 }));
    }
    return id;
  }

  async function compare(call: DemoCall) {
    openCode(call.source, call.sourceMethod, false);
    openCode(call.target, call.targetMethod, false);
    evidence = null;
    await fitCode();
  }

  function reset(empty = false) {
    focus = empty ? [] : [...initialFocus]; hidden = []; expanded = [];
    nodes = []; selectedComponent = null; evidence = null; includeContext = true;
    query = ''; folder = ''; libraryOpen = false; helpOpen = false; zIndex = 10;
    expandedHeights.clear(); rememberedPositions.clear(); refresh();
    notice = empty ? 'Add starting components from the library.' : 'Example restored. All changes in this prototype are session-only.';
    if (!empty) void fitGraph();
  }

  function tidy() {
    nodes = nodes.map((node) => node.type === 'component' ? { ...node, position: { ...component(node.id).position } } : node);
    notice = 'Example layout restored. Tidy is explicit; ordinary exploration never rearranges your board.';
    void fitGraph();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { libraryOpen = false; helpOpen = false; evidence = null; }
  }

  onMount(() => { refresh(); void fitGraph(); });
</script>

<svelte:window {onkeydown} />
<div class="prototype">
  <header class="topbar">
    <a class="brand" href="./" title="Open the existing CodeGraph viewer"><span class="brandmark"></span> CodeGraph</a>
    <div class="divider"></div>
    <h1>Review board</h1>
    <span class="prototype-badge">Clickdummy</span>
    <span class="sample-warning">Synthetic example · no live index · nothing is saved</span>
    <button class="help-button" onclick={() => helpOpen = !helpOpen} aria-expanded={helpOpen}>How to explore</button>
  </header>

  <div class="toolbar">
    <div class="toolgroup">
      <button class="primary" onclick={() => libraryOpen = !libraryOpen} aria-expanded={libraryOpen}>+ Add components</button>
      <label><input type="checkbox" checked={includeContext} onchange={(event) => { includeContext = event.currentTarget.checked; evidence = null; refresh(); }} /> Show context</label>
      {#if hidden.length}<button onclick={() => { hidden = []; refresh(); notice = 'Hidden components restored.'; }}>Show hidden ({hidden.length})</button>{/if}
    </div>
    <div class="toolgroup viewport-tools">
      <button onclick={fitGraph} disabled={!projection.components.length}>Fit graph</button>
      <button onclick={fitCode} disabled={!codeCount}>Fit code{codeCount ? ` (${codeCount})` : ''}</button>
      <button onclick={tidy} disabled={!projection.components.length}>Tidy layout</button>
      <span class="tool-divider"></span>
      <button onclick={() => reset(true)}>Start empty</button>
      <button onclick={() => reset()}>Reset example</button>
    </div>
  </div>

  <main aria-label="Review board canvas">
    <SvelteFlow
      bind:nodes {edges} {nodeTypes}
      minZoom={0.2} maxZoom={1.6} nodesConnectable={false} deleteKey={null}
      zoomOnDoubleClick={false} panOnDrag fitView fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
      proOptions={{ hideAttribution: true }}
      onnodeclick={({ node }) => {
        if (node.type === 'code') { selectedComponent = node.data.componentId; nodes = nodes.map((item) => item.id === node.id ? { ...item, zIndex: ++zIndex } : item); }
        else selectedComponent = node.id;
        evidence = null;
      }}
      onedgeclick={({ edge }) => { evidence = edge.data?.call as BoardCall; selectedComponent = null; }}
      onselectionchange={({ edges: selectedEdges }) => {
        // Built-in edge labels select their edge without forwarding a path click.
        if (selectedEdges.length === 1) { evidence = selectedEdges[0]!.data?.call as BoardCall; selectedComponent = null; }
      }}
      onpaneclick={() => { selectedComponent = null; evidence = null; }}
    >
      <Background gap={24} size={1} patternColor="var(--rule-soft)" />
      <Controls position="bottom-right" showLock={false} />
      <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => node.type === 'code' ? 'var(--press-2)' : focus.includes(node.id) ? 'var(--accent)' : 'var(--rule-soft)'} />
    </SvelteFlow>

    {#if !focus.length}
      <section class="empty">
        <span class="empty-glyph">⌑</span><h2>Start with what you want to understand</h2>
        <p>Add a few classes. Their direct neighbours appear as context—not the whole repository.</p>
        <button class="primary" onclick={() => libraryOpen = true}>+ Add starting components</button>
      </section>
    {/if}

    {#if libraryOpen}
      <aside class="library panel" aria-label="Component library">
        <div class="panel-heading"><h2>Add components</h2><button aria-label="Close component library" onclick={() => libraryOpen = false}>×</button></div>
        <p class="panel-hint">Choose your starting points. Adding preserves the current board.</p>
        <label class="field">Search sample components<input aria-label="Search sample components" placeholder="Class, namespace or purpose…" bind:value={query} /></label>
        <label class="field">Namespace<select aria-label="Filter sample namespace" bind:value={folder}><option value="">All namespaces</option>{#each folders as item}<option value={item}>{item}</option>{/each}</select></label>
        {#if folder}<button class="add-group" onclick={() => add(results.map((item) => item.id))} disabled={!results.length}>Add {results.length} matching {results.length === 1 ? 'component' : 'components'}</button>{/if}
        <div class="component-results">
          {#each results as item (item.id)}
            {@const inFocus = focus.includes(item.id) && !hidden.includes(item.id)}
            <button class="result" disabled={inFocus} aria-label={`Add ${item.name}`} onclick={() => add([item.id])}>
              <span class="result-name">{item.name}<span>{inFocus ? '✓' : '+'}</span></span>
              <small>{item.folder}{hidden.includes(item.id) ? ' · hidden' : inFocus ? ' · in focus' : ''}</small>
              <span class="result-purpose">{item.purpose}</span>
            </button>
          {:else}<p class="no-results">No sample components match.</p>{/each}
        </div>
      </aside>
    {/if}

    {#if evidence}
      <aside class="evidence panel" aria-label="Call evidence">
        <div class="panel-heading"><h2>What connects these?</h2><button aria-label="Close call evidence" onclick={() => evidence = null}>×</button></div>
        <div class="edge-heading"><strong>{component(evidence.source).name}</strong><span>↓ calls</span><strong>{component(evidence.target).name}</strong></div>
        <p class="panel-hint">{evidence.calls.length} hand-authored sample call {evidence.calls.length === 1 ? 'site' : 'sites'}. In the real board these would come from indexed evidence.</p>
        {#each evidence.calls as call (call.id)}
          <section class="call-pair">
            <div class="pair-name">{call.sourceMethod}() → {call.targetMethod}()</div>
            <div class="call-location">{component(call.source).name}.cs:{call.line}</div>
            {#if call.via}<p class="via">{call.via}. This is not a claim about runtime dispatch.</p>{/if}
            <div class="pair-actions"><button onclick={() => openCode(call.source, call.sourceMethod)}>Caller code</button><button onclick={() => openCode(call.target, call.targetMethod)}>Callee code</button><button class="compare" onclick={() => compare(call)}>Compare ↗</button></div>
          </section>
        {/each}
      </aside>
    {/if}

    {#if helpOpen}
      <aside class="help panel" aria-label="Prototype instructions">
        <div class="panel-heading"><h2>A board for understanding code</h2><button aria-label="Close prototype instructions" onclick={() => helpOpen = false}>×</button></div>
        <ol><li>Add starting classes, or promote a muted neighbour with <b>+ Focus</b>.</li><li>Use <b>Methods</b> to expand one class without rearranging the others.</li><li>Click a connecting arrow for the calls behind it.</li><li>Open code cards side by side; drag headers and resize the selected card.</li><li>Drag the background to pan; scroll to zoom. Use <b>Fit graph</b> to regain the overview.</li></ol>
        <p>This clickdummy deliberately has no live queries, saved boards or repository writes. Reloading resets the example.</p>
      </aside>
    {/if}

    <div class="board-key"><span><i class="focus-dot"></i>{focusCount} in focus</span><span><i class="context-dot"></i>{contextCount} context</span><span class="key-line"></span><span>Calls →</span><span class="key-dash"></span><span>Interface bridge</span></div>
    <div class="notice" role="status" aria-live="polite">{notice}</div>
  </main>
  <footer class="prototype-footer"><span>Prototype / refresh lifecycle</span><span>Session-only · saved boards come after interaction review</span></footer>
</div>

<style>
  :global(#app) { display: block; }
  .prototype { height: 100dvh; display: flex; flex-direction: column; background: var(--paper); color: var(--ink); }
  .topbar { height: 58px; display: flex; align-items: center; gap: 14px; padding: 0 22px; border-bottom: 1px solid var(--rule); flex-shrink: 0; }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
  .brandmark { display: inline-block; height: 11px; width: 11px; border: 1px solid var(--ink); }
  .divider { height: 20px; border-left: 1px solid var(--rule-soft); }
  h1 { font-size: 15px; margin: 0; font-weight: 500; }
  .prototype-badge { color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-line); padding: 3px 7px; font-size: 11px; }
  .sample-warning { font-size: 11px; color: var(--ink-3); flex: 1; }
  .help-button { font-size: 12px; color: var(--ink-2); }
  .toolbar { min-height: 54px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 8px 22px; border-bottom: 1px solid var(--rule-soft); flex-shrink: 0; }
  .toolgroup { display: flex; gap: 12px; align-items: center; }
  .toolgroup button { border: 1px solid var(--rule-soft); padding: 6px 10px; font-size: 12px; background: var(--paper); white-space: nowrap; }
  button.primary, .primary { background: var(--accent); border: 1px solid var(--accent); color: var(--paper); padding: 7px 12px; font-size: 12px; }
  button:hover:not(:disabled) { background: var(--press); }
  button.primary:hover { background: var(--accent-ink); }
  button:disabled { opacity: 0.45; cursor: default; }
  .toolgroup label { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-2); white-space: nowrap; }
  input[type='checkbox'] { accent-color: var(--accent); }
  .tool-divider { height: 18px; border-left: 1px solid var(--rule-soft); }
  main { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  main :global(.svelte-flow__minimap) { bottom: 45px; width: 135px; height: 90px; border: 1px solid var(--rule-soft); background: var(--paper); }
  main :global(.svelte-flow__controls) { display: flex; right: 15px; bottom: 10px; flex-direction: row; box-shadow: none; border: 1px solid var(--rule-soft); }
  main :global(.svelte-flow__controls-button) { width: 30px; height: 28px; }
  main :global(.svelte-flow__edge.selected .svelte-flow__edge-path) { stroke: var(--accent); }
  .panel { position: absolute; z-index: 20; width: 310px; top: 14px; max-height: calc(100% - 94px); display: flex; flex-direction: column; background: var(--paper); border: 1px solid var(--rule); overflow: auto; }
  .library { left: 14px; }
  .evidence, .help { right: 14px; }
  .help { width: 350px; }
  .panel-heading { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--rule-soft); }
  h2 { margin: 0; font-size: 14px; }
  .panel-heading button { font-size: 22px; line-height: 18px; }
  .panel-hint { color: var(--ink-2); font-size: 12px; padding: 0 16px; line-height: 1.5; }
  .field { padding: 0 16px; display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; font-size: 11px; color: var(--ink-2); }
  .field input, .field select { font: inherit; color: var(--ink); background: var(--paper-2); padding: 9px 8px; border: 1px solid var(--rule-soft); width: 100%; }
  .add-group { text-align: left; margin: 0 16px 12px; padding: 7px; border: 1px solid var(--accent-line); color: var(--accent); font-size: 12px; }
  .component-results { border-top: 1px solid var(--rule-soft); overflow: auto; }
  .result { padding: 12px 16px; width: 100%; text-align: left; border-bottom: 1px solid var(--rule-faint); display: flex; flex-direction: column; gap: 5px; }
  .result-name { display: flex; justify-content: space-between; font: 12px var(--mono); }
  .result-name span { color: var(--accent); }
  .result small { color: var(--ink-3); font: 10px var(--mono); }
  .result-purpose { font-size: 11px; color: var(--ink-2); }
  .no-results { padding: 12px 16px; color: var(--ink-3); }
  .edge-heading { display: flex; flex-direction: column; gap: 8px; padding: 16px; }
  .edge-heading strong { font: 12px var(--mono); }
  .edge-heading span { color: var(--ink-3); font-size: 11px; }
  .call-pair { border-top: 1px solid var(--rule-soft); padding: 14px 16px; }
  .pair-name { font: 11px var(--mono); }
  .call-location { color: var(--ink-3); font: 10px var(--mono); margin-top: 6px; }
  .pair-actions { display: flex; gap: 12px; margin-top: 14px; }
  .pair-actions button { font-size: 11px; text-decoration: underline; text-underline-offset: 3px; }
  .compare { color: var(--accent); }
  .via { font-size: 11px; color: var(--ink-2); line-height: 1.5; }
  .help ol { padding: 0 22px 0 34px; line-height: 1.7; font-size: 12px; }
  .help li { margin: 9px 0; }
  .help p { margin: 0 16px 16px; color: var(--ink-3); font-size: 11px; }
  .board-key { position: absolute; left: 18px; bottom: 39px; z-index: 5; display: flex; align-items: center; gap: 9px; padding: 7px 10px; background: var(--paper); border: 1px solid var(--rule-soft); font-size: 10px; color: var(--ink-2); pointer-events: none; }
  .board-key span { display: inline-flex; align-items: center; gap: 5px; }
  .focus-dot, .context-dot { width: 7px; height: 7px; background: var(--accent); display: inline-block; }
  .context-dot { background: var(--rule-soft); border: 1px solid var(--ink-3); }
  .key-line { width: 22px; border-top: 1px solid var(--ink-3); margin-left: 6px; }
  .key-dash { width: 22px; border-top: 1px dashed var(--ink-3); margin-left: 6px; }
  .notice { position: absolute; left: 18px; bottom: 12px; right: 180px; z-index: 5; font-size: 11px; color: var(--ink-2); pointer-events: none; background: var(--paper); width: fit-content; max-width: calc(100% - 200px); padding: 2px 4px; }
  .prototype-footer { display: flex; justify-content: space-between; padding: 7px 22px; border-top: 1px solid var(--rule-soft); font-size: 10px; color: var(--ink-3); flex-shrink: 0; }
  .empty { position: absolute; inset: 22% 20%; text-align: center; z-index: 5; pointer-events: none; }
  .empty-glyph { font-size: 44px; color: var(--ink-3); }
  .empty h2 { font-size: 20px; margin: 10px 0; }
  .empty p { max-width: 400px; margin: 12px auto 22px; color: var(--ink-2); line-height: 1.6; }
  .empty button { pointer-events: auto; }
  @media (max-width: 1100px) { .sample-warning { display: none; } .topbar { gap: 10px; } .help-button { margin-left: auto; } .toolbar { padding: 8px 12px; } .toolgroup { gap: 6px; } .viewport-tools button { padding: 6px 7px; } }
  @media (max-width: 760px) { .toolbar { justify-content: flex-start; } .viewport-tools { flex-wrap: wrap; } .prototype-footer span:last-child { display: none; } .notice { right: 15px; max-width: calc(100% - 30px); bottom: 7px; } .board-key { bottom: 45px; } }
</style>
