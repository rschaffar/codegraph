<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { Handle, Position, NodeResizer, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/svelte';
  import { getGraphAdapter } from '../../lib/adapter';
  import { tokensByLine } from '../../lib/highlight';
  import type { CodeBlock, LineRef } from '../../lib/symbol-model';
  import type { WireSource } from '../../lib/wire';
  import type { BoardEvidence, BoardSymbol, SourceCardData } from '../../lib/board-model';
  import type { BoardConnectionRequest, BoardExclusions } from '../../lib/board-wire';
  import {
    BOARD_SOURCE_TARGET_PAGE, BOARD_SOURCE_EVIDENCE_PAGE,
    boardSourceRange, boardSourceContinuation, boardSourceRefs, boardSourceWithMembers, boardSourceEvidenceComplete,
    boardSourceEvidenceTitle, boardEvidenceUncertain, verifiedBoardSourceSymbol, boardSourceForIdentity,
    boardSourceTarget, boardSourceApplyEvidence, boardSourcePageProgress, boardSourceLoadReferences, boardSourceMergeExclusions, type BoardSourceTarget,
  } from '../../lib/board-source-model';
  import type { SourceFold } from '../../lib/source-folds';
  import { boardSourceAnchorPositions, type BoardSourceAnchorPosition } from '../../lib/board-source-anchors';
  import { live } from '../../lib/live.svelte';
  import { fileHref, symbolHref, navigate } from '../../lib/navigation';
  import SourceBlock from '../symbol/SourceBlock.svelte';
  import KindGlyph from '../KindGlyph.svelte';
  import DriftBanner from '../DriftBanner.svelte';

  interface TargetRow extends BoardSourceTarget { open: boolean }
  interface LinkContext { symbol: BoardSymbol; request: BoardConnectionRequest; controller: AbortController }

  let { id, data, selected }: NodeProps<Node<SourceCardData, 'code'>> = $props();
  // Geometry/selection replaces a Flow node's data object. Only semantic
  // identity, collapse, filter or focus changes may refetch its source/graph.
  const expected = $derived(data.symbol);
  const isCollapsed = $derived(data.collapsed);
  const updateNodeInternals = useUpdateNodeInternals();
  $effect(() => {
    const nodeId = id;
    void isCollapsed;
    let cancelled = false;
    void tick().then(() => { if (!cancelled) updateNodeInternals(nodeId); });
    return () => { cancelled = true; };
  });
  const visibility = $derived(data.filters);
  const requestedLine = $derived(data.highlight);
  const reportSourceState = $derived(data.sourceState);
  const sourceSymbolId = $derived(data.symbolId);
  const siblings = $derived(data.siblings);
  const siblingsBusy = $derived(data.siblingsBusy);
  const siblingsAvailable = $derived(data.siblingsAvailable);
  let verifiedIndexTick = $state(-1);
  let verifiedDiskTick = $state(-1);
  let verified = $state<BoardSymbol | null>(null);
  let identityError = $state('');
  let verifying = $state(false);
  let sourceValue = $state<WireSource | null>(null);
  const source = $derived(boardSourceForIdentity(expected, verified, sourceValue));
  let error = $state('');
  let loading = $state(false);
  let current = $state(false);
  let pageFrom = $state<number | null>(null);
  let localHighlight = $state<number | null>(null);
  let sourceEl = $state<HTMLDivElement | null>(null);
  let cardEl = $state<HTMLElement | null>(null);
  const lineAnchors = $derived(data.sourceAnchors);
  let anchorPositions = $state<BoardSourceAnchorPosition[]>([]);
  const offscreenGroups = $derived.by(() => {
    const groups = new Map<string, { direction: 'incoming' | 'outgoing'; offscreen: 'above' | 'below'; y: number; lines: number[] }>();
    for (const anchor of anchorPositions) {
      if (!anchor.offscreen) continue;
      const key = `${anchor.direction}:${anchor.offscreen}`;
      const group = groups.get(key) ?? { direction: anchor.direction, offscreen: anchor.offscreen, y: anchor.y, lines: [] };
      if (!group.lines.includes(anchor.line)) group.lines.push(anchor.line);
      groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({ ...group, lines: group.lines.sort((a, b) => a - b) }));
  });
  let highlight = $derived(current ? null : (localHighlight ?? requestedLine ?? null));

  $effect(() => {
    void requestedLine;
    pageFrom = null;
    localHighlight = null;
  });

  $effect(() => {
    const item = expected; const collapsed = isCollapsed;
    verifiedIndexTick = live.indexTick; verifiedDiskTick = live.diskTick;
    const controller = new AbortController();
    verified = null; sourceValue = null; identityError = ''; verifying = !collapsed;
    pageFrom = null; localHighlight = null;
    if (collapsed) return () => controller.abort();
    if (item.id.startsWith('missing:')) {
      identityError = item.purpose ?? 'Saved symbol does not resolve uniquely. No source range is trusted.';
      verifying = false;
      return () => controller.abort();
    }
    // Never trust a persisted/cached range, even for a source-only card.
    getGraphAdapter().nodes([item.id], controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      const found = verifiedBoardSourceSymbol(item, value.items);
      if (!found) throw new Error('Symbol identity changed or is ambiguous in the index. Refresh the board to re-resolve it; the old source range is not shown.');
      verified = found;
    }).catch((cause) => { if (!controller.signal.aborted) identityError = message(cause); })
      .finally(() => { if (!controller.signal.aborted) verifying = false; });
    return () => controller.abort();
  });

  $effect(() => {
    const item = verified; const showCurrent = current; const collapsed = isCollapsed;
    const wanted = pageFrom; const focus = highlight;
    const controller = new AbortController();
    sourceValue = null; error = ''; loading = !!item && !collapsed;
    if (!item || collapsed) return () => controller.abort();
    const range = boardSourceRange(item, { current: showCurrent, from: wanted, highlight: focus });
    getGraphAdapter().source({ file: item.file, ...range, ...(showCurrent ? { ondrift: 'current' as const } : {}) }, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (value.file !== item.file) throw new Error('Source did not match the verified file. No source is shown.');
        sourceValue = value;
      }).catch((cause) => { if (!controller.signal.aborted) error = message(cause); })
      .finally(() => { if (!controller.signal.aborted) loading = false; });
    return () => controller.abort();
  });

  let targets = $state<TargetRow[]>([]);
  let symbols = $state<BoardSymbol[]>([]);
  let totalTargets = $state<number | null>(null);
  let nextTargets = $state<number | null>(null);
  let linksLoading = $state(false);
  let autoLoading = $state(false);
  let linksError = $state('');
  let notes = $state<string[]>([]);
  let bounded = $state(false);
  let excluded = $state<BoardExclusions | null>(null);
  let context: LinkContext | null = null;

  $effect(() => {
    const item = verified; const collapsed = isCollapsed; const trusted = indexed;
    const filters = visibility;
    const controller = new AbortController();
    targets = []; symbols = item ? [item] : []; totalTargets = null; nextTargets = null;
    linksLoading = false; autoLoading = false; linksError = ''; notes = []; bounded = false; excluded = null; context = null;
    if (!item || collapsed || !trusted) return () => controller.abort();
    const ctx: LinkContext = { symbol: item, controller, request: {
      id: item.id, direction: 'outgoing', members: boardSourceWithMembers(item),
      tests: filters?.tests ?? false, generated: filters?.generated ?? false, uncertain: filters?.uncertain ?? false,
    } };
    context = ctx;
    if (!getGraphAdapter().boardConnections) linksError = 'This host does not provide indexed Board references.';
    else untrack(() => { void loadReferences(ctx); });
    return () => controller.abort();
  });

  function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
  function mergeSymbols(items: readonly BoardSymbol[]): void {
    symbols = [...new Map([...symbols, ...items].map((item) => [item.id, item])).values()];
  }
  function mergeNotes(items: readonly string[]): void {
    notes = [...new Set([...notes, ...items])];
  }
  async function loadReferences(ctx: LinkContext): Promise<void> {
    if (autoLoading || linksLoading || ctx.controller.signal.aborted) return;
    autoLoading = true; linksError = '';
    try {
      await boardSourceLoadReferences({ signal: ctx.controller.signal,
        state: () => ({ total: totalTargets, nextOffset: nextTargets, error: linksError, targets }),
        targets: (offset) => loadTargets(ctx, offset), evidence: (targetId) => loadEvidence(targetId),
      });
    } finally { if (!ctx.controller.signal.aborted) autoLoading = false; }
  }
  function keepVerifiedScope(ctx: LinkContext, items: readonly BoardSymbol[]): boolean {
    const fresh = verifiedBoardSourceSymbol(ctx.symbol, items);
    if (fresh && fresh.line === ctx.symbol.line && fresh.endLine === ctx.symbol.endLine) return true;
    identityError = 'The indexed source scope changed while loading references. Refresh the board to re-resolve it; the old source range is not shown.';
    verified = null; sourceValue = null;
    return false;
  }
  async function loadTargets(ctx: LinkContext, offset: number): Promise<void> {
    const adapter = getGraphAdapter();
    if (!adapter.boardConnections || ctx.controller.signal.aborted) return;
    linksLoading = true; linksError = '';
    try {
      const page = await adapter.boardConnections({ ...ctx.request, offset, limit: BOARD_SOURCE_TARGET_PAGE }, ctx.controller.signal);
      if (ctx.controller.signal.aborted) return;
      if (!keepVerifiedScope(ctx, [page.scope])) return;
      if ((totalTargets !== null && page.total !== totalTargets) ||
        !boardSourcePageProgress(offset, page.items.length, page.total, page.nextOffset) ||
        new Set([...targets.map((row) => row.target.id), ...page.items.map((row) => row.target.id)]).size !== targets.length + page.items.length) {
        throw new Error('Indexed target pages changed or did not advance. Refresh the board before trusting inline links.');
      }
      mergeSymbols([...page.symbols, ...page.items.map((row) => row.target)]);
      const rows = page.items.map((row): TargetRow => ({ ...boardSourceTarget(row, page.bounded, page.excluded), open: false }));
      targets = [...targets, ...rows];
      excluded = totalTargets === null ? page.excluded ?? null : boardSourceMergeExclusions(excluded, page.excluded ?? null);
      totalTargets = page.total; nextTargets = page.nextOffset; mergeNotes(page.notes);
      // A bounded empty page has no target through which to prove scope bounds.
      bounded ||= page.bounded && rows.length === 0;
    } catch (cause) { if (!ctx.controller.signal.aborted) linksError = message(cause); }
    finally { if (!ctx.controller.signal.aborted) linksLoading = false; }
  }
  async function loadEvidence(targetId: string): Promise<void> {
    const ctx = context; const row = targets.find((item) => item.target.id === targetId);
    const adapter = getGraphAdapter();
    if (!ctx || ctx.controller.signal.aborted || !row || row.loading || row.nextOffset === null) return;
    if (!adapter.boardEvidence) { row.error = 'This host does not provide further evidence pages.'; return; }
    row.loading = true; row.error = '';
    try {
      const page = await adapter.boardEvidence({ ...ctx.request, target: targetId, offset: row.nextOffset, limit: BOARD_SOURCE_EVIDENCE_PAGE }, ctx.controller.signal);
      if (ctx.controller.signal.aborted || !keepVerifiedScope(ctx, page.symbols)) return;
      boardSourceApplyEvidence(row, page);
      mergeSymbols(page.symbols); mergeNotes(page.notes);
    } catch (cause) { if (!ctx.controller.signal.aborted) row.error = message(cause); }
    finally { if (!ctx.controller.signal.aborted) row.loading = false; }
  }

  const indexed = $derived(!!verified && !isCollapsed && !verifying && !loading && !identityError && !error &&
    !current && !!source?.lines && !source.drift && source.showing === 'indexed' &&
    verifiedIndexTick === live.indexTick && verifiedDiskTick === live.diskTick);
  const sourceFolds = $derived(indexed ? data.sourceFolds : undefined);
  const noDetachableSources: readonly BoardSymbol[] = [];
  const detachableSources = $derived(indexed ? data.detachableSources ?? noDetachableSources : noDetachableSources);
  const detachableByLine = $derived.by(() => {
    const rows = new Map<number, BoardSymbol[]>();
    for (const member of detachableSources) {
      const items = rows.get(member.line) ?? []; items.push(member); rows.set(member.line, items);
    }
    return rows;
  });
  const block = $derived<CodeBlock>({ windows: source?.lines ? [{ start: source.from ?? verified?.line ?? 1, lines: source.lines }] : [], gapsAfter: [], tailGap: 0, whole: true });
  const tokens = $derived(tokensByLine(source?.lines ?? [], source?.from ?? verified?.line ?? 1, source?.highlight));
  const byId = $derived(new Map(symbols.map((item) => [item.id, item])));
  // Ticks belong to verification, not to whatever bytes happen to be cached.
  $effect(() => {
    const callback = reportSourceState; const symbolId = sourceSymbolId;
    const indexTick = verifiedIndexTick; const diskTick = verifiedDiskTick;
    const trusted = indexed;
    untrack(() => callback?.(symbolId, { indexed: trusted, indexTick, diskTick }));
    return () => untrack(() => callback?.(symbolId, { indexed: false, indexTick, diskTick }));
  });
  const evidenceComplete = $derived(boardSourceEvidenceComplete({ total: totalTargets, nextOffset: nextTargets,
    bounded, loading: linksLoading || autoLoading, error: linksError, filters: visibility, excluded, targets }));
  // Incomplete evidence must not rebuild every rendered source line on each
  // paging update. Only subscribe to symbols/evidence once completeness holds.
  const emptyRefs = new Map<number, LineRef[]>();
  const refs = $derived(indexed && evidenceComplete ? boardSourceRefs({ expected, verified, source, symbols,
    evidence: targets.flatMap((row) => row.evidence), evidenceComplete: true, tokens }) : emptyRefs);
  const continuation = $derived(verified ? boardSourceContinuation(verified, source, current) : { previous: null, next: null });
  const owner = $derived(data.symbol.ownerId ? byId.get(data.symbol.ownerId) : undefined);

  function follow(target: BoardSymbol, line?: number, event?: MouseEvent): void {
    if (data.follow) data.follow(target, line, event);
    else navigate(symbolHref(target.id, line === undefined ? {} : { line }));
  }
  function followRef(ref: LineRef, event?: MouseEvent): void {
    const target = ref.targetId ? byId.get(ref.targetId) : undefined;
    if (indexed && target) follow(target, undefined, event);
  }
  function canFocus(edge: BoardEvidence): boolean {
    return indexed && !!verified && edge.file === verified.file && Number.isSafeInteger(edge.line) && edge.line! >= verified.line && edge.line! <= verified.endLine!;
  }
  function focusSite(edge: BoardEvidence): void {
    if (!canFocus(edge)) return;
    focusSourceLine(edge.line!);
  }
  function sourceLineElement(el: HTMLElement, line: number): HTMLElement | null {
    return el.querySelector<HTMLElement>(`[data-line="${line}"]`) ?? [...el.querySelectorAll<HTMLElement>('[data-source-fold]')]
      .find((row) => Number(row.dataset.line) <= line && Number(row.dataset.foldEnd) >= line) ?? null;
  }
  function focusSourceLine(line: number): void {
    localHighlight = line; pageFrom = null;
    // The same highlighted line may have been scrolled away since the last
    // activation. Do not depend on a changed highlight to reveal it again.
    void tick().then(() => {
      if (!indexed || localHighlight !== line || !sourceEl) return;
      const row = sourceLineElement(sourceEl, line);
      if (row) sourceEl.scrollTop = Math.max(0, row.offsetTop - 40);
    });
  }
  function evidenceOrigin(edge: BoardEvidence): BoardSymbol | undefined {
    const origin = byId.get(edge.source);
    return origin && edge.file === origin.file && edge.line != null && edge.line >= origin.line && edge.line <= (origin.endLine ?? origin.line) ? origin : undefined;
  }
  function goPage(from: number | null): void { if (from !== null) pageFrom = from; }

  // Coordinates come from the rendered source rows and their actual gutter,
  // not a guessed line height. Normalize screen rectangles by the canvas scale.
  // Scrolling/resizing only updates handles; it never requests source or graph.
  $effect(() => {
    const anchors = lineAnchors; const el = sourceEl; const card = cardEl;
    const value = source; const trusted = indexed; const collapsed = isCollapsed;
    void sourceFolds;
    if (!anchors?.length || !el || !card || !trusted || collapsed || !value?.lines?.length) { anchorPositions = []; return; }
    let active = true; let frame: number | null = null;
    function measure() {
      frame = null;
      if (!active || !el || !card || !value?.lines) return;
      const box = card.getBoundingClientRect(); const viewport = el.getBoundingClientRect();
      const sx = card.offsetWidth > 0 && box.width > 0 ? box.width / card.offsetWidth : 1;
      const sy = card.offsetHeight > 0 && box.height > 0 ? box.height / card.offsetHeight : 1;
      const rows = new Map<number, { y: number }>();
      for (const row of el.querySelectorAll<HTMLElement>('.code .ln[data-line]')) {
        const dot = row.querySelector<HTMLElement>('.port i');
        const rect = (dot ?? row).getBoundingClientRect();
        rows.set(Number(row.dataset.line), { y: (rect.top + rect.height / 2 - box.top) / sy });
      }
      const gutter = el.querySelector<HTMLElement>('.code .port')?.getBoundingClientRect();
      const from = value.from ?? verified?.line ?? 1;
      const next = boardSourceAnchorPositions(anchors ?? [], { top: (viewport.top - box.top) / sy,
        bottom: (viewport.bottom - box.top) / sy, gutterX: gutter ? (gutter.right - box.left) / sx - 7 : card.offsetWidth - 20,
        from, to: from + value.lines.length - 1, rows });
      if (JSON.stringify(next) === JSON.stringify(untrack(() => anchorPositions))) return;
      anchorPositions = next;
      void tick().then(() => { if (active) updateNodeInternals(id); });
    }
    function schedule() { if (active && frame === null) frame = requestAnimationFrame(measure); }
    el.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(el); observer.observe(card);
    const code = el.querySelector('.code'); if (code) observer.observe(code);
    void document.fonts?.ready.then(schedule);
    schedule();
    return () => { active = false; if (frame !== null) cancelAnimationFrame(frame); observer.disconnect(); el.removeEventListener('scroll', schedule); };
  });

  // Scroll the card only, not the canvas or the document containing it.
  $effect(() => {
    const line = highlight; const value = source; const el = sourceEl; const trusted = indexed;
    if (!trusted || !line || !value?.lines || !el) return;
    void tick().then(() => {
      if (source !== value || highlight !== line) return;
      const row = sourceLineElement(el, line);
      if (row) el.scrollTop = Math.max(0, row.offsetTop - 40);
    });
  });
</script>

{#snippet sourceLineActions(line: number)}
  {#each detachableByLine.get(line) ?? noDetachableSources as member (member.id)}
    <button type="button" class="inline-detach nodrag nopan nokey" disabled={!data.detachSource}
      data-detach-source={member.id} aria-label={`Detach ${member.qualifiedName} source at line ${member.line}`}
      title={`Open a separate source card for ${member.qualifiedName}${member.signature ? ` · ${member.signature}` : ''}; fold its body here without adding symbol pins.`}
      onclick={(event) => { event.stopPropagation(); if (indexed) data.detachSource?.(member, event); }}>
      Detach{(detachableByLine.get(line)?.length ?? 0) > 1 ? ` ${member.name}` : ''}
    </button>
  {/each}
{/snippet}

{#snippet detachedSource(fold: SourceFold)}
  <span class="detached-placeholder"><span>{fold.label}</span><span class="dim"> · lines {fold.start}–{fold.end} · detached source</span>
    <button type="button" aria-label={`Locate detached source ${fold.label} at lines ${fold.start}–${fold.end}`} onclick={(event) => { event.stopPropagation(); data.locateDetached?.(fold.id, event); }}>Locate ↗</button>
    <button type="button" aria-label={`Reattach source ${fold.label} at lines ${fold.start}–${fold.end}`} onclick={(event) => { event.stopPropagation(); data.reattachSource?.(fold.id, event); }}>Reattach</button>
  </span>
{/snippet}

<NodeResizer minWidth={380} minHeight={190} maxWidth={4096} maxHeight={4096} isVisible={selected && !data.collapsed} />
<article class="source-card" class:chosen={selected} data-code-card={data.symbolId} bind:this={cardEl}>
  <Handle type="target" id="source-owner" position={Position.Left} isConnectable={false} tabindex={-1} aria-hidden="true" style={`top:20px;opacity:${data.sourceOwners?.length ? 1 : 0};pointer-events:none`} />
  {#each anchorPositions as anchor (anchor.id)}
    <Handle type={anchor.direction === 'outgoing' ? 'source' : 'target'} id={anchor.id} position={anchor.direction === 'outgoing' ? Position.Right : Position.Left}
      isConnectable={false} tabindex={-1} aria-hidden="true" class="source-line-port"
      style={`left:${anchor.x}px;right:auto;top:${anchor.y}px;transform:translate(-50%,-50%);pointer-events:none`}
      data-source-anchor={anchor.id} data-source-line={anchor.line} data-source-direction={anchor.direction} data-offscreen={anchor.offscreen ?? undefined} />
  {/each}
  {#each offscreenGroups as group (`${group.direction}:${group.offscreen}`)}
    {@const nearest = (group.offscreen === 'above' ? group.lines[group.lines.length - 1] : group.lines[0])!}
    <button type="button" class="offscreen-lines nodrag nopan nokey" class:incoming={group.direction === 'incoming'} class:below={group.offscreen === 'below'}
      style={`top:${group.y}px`} data-offscreen-lines={group.lines.join(',')}
      title={`${group.direction} connections ${group.offscreen}: lines ${group.lines.join(', ')}. Show line ${nearest}.`}
      aria-label={`Show ${group.direction} connection line ${nearest} ${group.offscreen}`}
      onclick={(event) => { event.stopPropagation(); focusSourceLine(nearest); }}>
      {group.offscreen === 'above' ? '↑' : '↓'} L{nearest}{group.lines.length > 1 ? ` +${group.lines.length - 1}` : ''}
    </button>
  {/each}
  <span class="keyboard-help" id={`${id}-move-help`}>Press Enter to select, then use arrow keys to move this source card.</span>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (SvelteFlow owns Enter selection and arrow-key movement on this focusable move handle.) -->
  <header class="board-drag-handle" role="group" tabindex="0" aria-label={`Source card ${data.symbol.qualifiedName}`} aria-describedby={`${id}-move-help`}><KindGlyph kind={data.symbol.kind} /><strong title={data.symbol.qualifiedName}>{data.symbol.qualifiedName}</strong>
    <div class="actions nodrag nopan nokey">
      {#if data.sourceOwners?.length}<button type="button" aria-label={`Reattach source ${data.symbol.qualifiedName}`} onclick={(event) => { event.stopPropagation(); data.reattachSource?.(data.symbolId, event); }}>Reattach</button>{/if}
      {#if data.symbol.kind === 'function' || data.symbol.kind === 'method'}
        <button type="button" aria-label={`Open sibling sources for ${data.symbol.name}`} disabled={!siblings || !siblingsAvailable || siblingsBusy}
          title={siblingsBusy ? 'Loading sibling sources…' : !siblings || !siblingsAvailable ? 'This host does not provide sibling sources.' : 'Open source cards for siblings in the indexed owner scope'}
          onclick={(event) => { void siblings?.(data.symbolId, event); }}>{siblingsBusy ? 'Opening siblings…' : 'Open sibling sources'}</button>
      {/if}
      <button type="button" aria-label={`Fit code card ${data.symbol.name}`} onclick={() => data.read(id)}>Read ↗</button>
      <button type="button" aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} code card ${data.symbol.name}`} onclick={() => data.toggle(id)}>{data.collapsed ? '▾' : '▴'}</button>
      <button type="button" aria-label={`Close code card ${data.symbol.name}`} onclick={() => data.close(id)}>×</button></div>
  </header>
  <div class="location nodrag nopan nokey">{data.symbol.kind} · {data.symbol.file}:{verified?.line ?? data.symbol.line}{#if owner} · in {owner.qualifiedName}{/if}{#if data.sourceOwners?.length} · source detached from {data.sourceOwners.map((item) => item.qualifiedName).join(', ')}{/if}</div>
  {#if !data.collapsed}
    <div class="source nodrag nopan nowheel nokey" data-source-body bind:this={sourceEl}>
      {#if verifying || loading}<p role="status">Loading source…</p>{:else if identityError || error}<p role="alert">{identityError || error}</p>{/if}
      {#if source?.drift}<DriftBanner file={data.symbol.file}>indexed symbol ranges may be stale; no line-anchored graph markings are shown here. {#if !current}<button type="button" onclick={() => { current = true; pageFrom = null; }}>Read current file</button>{/if}</DriftBanner>{/if}
      {#if source?.lines}
        <SourceBlock {block} {tokens} {refs} defLine={indexed ? verified!.line : -1} defName={verified?.name ?? data.symbol.name} highlight={indexed ? highlight : null} onfollow={followRef} folds={sourceFolds} renderFold={detachedSource} renderLineActions={sourceLineActions} />
        <nav class="pages" aria-label="Source pages">
          <button type="button" disabled={continuation.previous === null} onclick={() => goPage(continuation.previous)}>Previous lines</button>
          <span>{#if source.lines.length}Lines {source.from ?? 1}–{(source.from ?? 1) + source.lines.length - 1}{:else}No lines in this page{/if}{current ? ' · current file' : ' · indexed symbol'}</span>
          <button type="button" disabled={continuation.next === null} onclick={() => goPage(continuation.next)}>Next lines</button>
          {#if current}<button type="button" onclick={() => { current = false; pageFrom = null; localHighlight = null; }}>Return to indexed symbol</button>{/if}
        </nav>
        {#if source.truncated}<p>Source response is bounded. Continue above or <a href={fileHref(data.symbol.file, { source: true })}>read the whole file</a>.</p>{/if}
      {:else if source && !source.drift}<p>{source.reason ?? 'No readable source body.'} {data.symbol.purpose ?? data.symbol.signature ?? ''}</p>{/if}
      {#if indexed}
        <details class="links">
          <summary>Indexed outgoing links · {targets.length}{totalTargets === null ? '' : ` of ${totalTargets}`} targets</summary>
          <p>{boardSourceWithMembers(verified!) ? 'Symbol and contained members' : 'This symbol only'} · reading links does not add or restore board symbols.</p>
          {#if !evidenceComplete}<p class="dim">Inline target links wait for complete, unfiltered evidence with no hard scope bounds. References load automatically in bounded batches; continue below for larger scopes, or follow an explicit target.</p>{/if}
          <p class="dim">Tests {data.filters?.tests ? 'included' : 'excluded'} · generated {data.filters?.generated ? 'included' : 'excluded'} · uncertain {data.filters?.uncertain ? 'included' : 'excluded'}</p>
          {#if excluded}<p class="dim">Filtered relationships · tests {excluded.relations.tests} · generated {excluded.relations.generated} · uncertain {excluded.relations.uncertain} (disjoint reasons)</p>{/if}
          {#if linksLoading || autoLoading}<p role="status">Loading indexed references…</p>{/if}
          {#if linksError}<p role="alert">{linksError}</p><button type="button" disabled={linksLoading || autoLoading} onclick={() => { if (context) void loadReferences(context); }}>Retry references</button>{/if}
          {#each targets as row (row.target.id)}
            <div class="target">
              <button type="button" class="target-link" title={`${row.target.kind} · ${row.target.qualifiedName} — ${row.target.file}:${row.target.line}`} onclick={(event) => follow(row.target, undefined, event)}>{row.target.qualifiedName} ↗</button>
              <span class="dim">{row.target.kind} · {row.target.file}:{row.target.line}</span>
              <span>Loaded kinds: {[...new Set(row.evidence.map((edge) => edge.kind))].join(', ') || 'none'} · {row.evidence.length} of {row.total} indexed relationships</span>
              <button type="button" aria-expanded={row.open} onclick={() => row.open = !row.open}>{row.open ? 'Hide' : 'Show'} evidence</button>
              {#if row.open}
                <ul>
                  {#each row.evidence as edge (edge.id)}
                    <li title={boardSourceEvidenceTitle(edge, row.target)}>
                      <span class="kind">{edge.kind}</span> · {byId.get(edge.source)?.qualifiedName ?? edge.source} → {row.target.name}
                      {#if boardEvidenceUncertain(edge)}<span class="dim"> · uncertain</span>{/if}
                      {#if edge.file}<a href={fileHref(edge.file, { source: true, ...(edge.line ? { line: edge.line } : {}) })}>{edge.file}{edge.line ? `:${edge.line}` : ''}</a>{:else}<span class="dim"> · no indexed source location</span>{/if}
                      {#if canFocus(edge)}<button type="button" onclick={() => focusSite(edge)}>Focus site</button>
                      {:else if evidenceOrigin(edge)}<button type="button" onclick={(event) => { const origin = evidenceOrigin(edge); if (origin) follow(origin, edge.line, event); }}>Open evidence source</button>{/if}
                      <span class="dim">{edge.provenance ? `provenance ${edge.provenance}` : ''}{edge.confidence != null ? ` · confidence ${edge.confidence}` : ''}{edge.synthesizedBy ? ` · synthesized by ${edge.synthesizedBy}` : ''}{edge.via ? ` · via ${edge.via}` : ''}{edge.registeredAt ? ` · wired at ${edge.registeredAt}` : ''}{edge.resolvedBy ? ` · resolved by ${edge.resolvedBy}` : ''}</span>
                    </li>
                  {/each}
                </ul>
                {#if row.error}<p role="alert">{row.error}</p>{/if}
                {#if row.nextOffset !== null}
                  {#if getGraphAdapter().boardEvidence}<button type="button" disabled={row.loading || autoLoading} onclick={() => void loadEvidence(row.target.id)}>{row.loading ? 'Loading evidence…' : 'Load more evidence'} ({row.evidence.length} of {row.total})</button>{:else}<span class="dim">This host does not provide further evidence pages.</span>{/if}
                {/if}
              {/if}
            </div>
          {/each}
          {#if totalTargets === 0}<p>No indexed outgoing targets match these filters.</p>{/if}
          {#if nextTargets !== null || targets.some((row) => row.nextOffset !== null && !row.error)}<button type="button" disabled={linksLoading || autoLoading} onclick={() => { if (context) void loadReferences(context); }}>Continue loading references ({targets.length} of {totalTargets ?? '?' } targets)</button>{/if}
          {#if bounded || targets.some((row) => row.bounded)}<p class="dim">Indexed scope/identity or an unverified evidence preview is bounded; inline links remain withheld until hard bounds can be ruled out.</p>{/if}
          {#each notes as note (note)}<p class="dim">{note}</p>{/each}
        </details>
      {/if}
    </div>
    <footer class="nodrag nopan nokey"><a href={symbolHref(data.symbolId)}>Symbol reader ↗</a><a href={fileHref(data.symbol.file, { source: true, ...(indexed && highlight ? { line: highlight } : {}) })}>File source ↗</a>
      {#if data.resize}<details class="size"><summary>Size</summary><div role="group" aria-label={`Resize source card ${data.symbol.name}`}>
        <button type="button" onclick={() => data.resize?.(id, -80, 0)}>Narrower</button><button type="button" onclick={() => data.resize?.(id, 80, 0)}>Wider</button>
        <button type="button" onclick={() => data.resize?.(id, 0, -80)}>Shorter</button><button type="button" onclick={() => data.resize?.(id, 0, 80)}>Taller</button>
      </div></details>{/if}<span>Read-only</span></footer>
  {/if}
</article>

<style>
  .source-card { position: relative; width: 100%; height: 100%; background: var(--paper); border: 1px solid var(--ink-3); display: flex; flex-direction: column; overflow: hidden; color: var(--ink); }
  .chosen { outline: 2px solid var(--accent); outline-offset: 3px; }
  .source-card :global(.source-line-port) { width: 6px; height: 6px; min-width: 6px; min-height: 6px; border: 1px solid var(--accent); background: var(--paper); z-index: 4; }
  .source-card :global(.source-line-port[data-source-direction='outgoing']) { border: 0; background: transparent; }
  .offscreen-lines { position: absolute; right: 26px; z-index: 5; transform: translateY(2px); padding: 2px 5px; border: 1px solid var(--rule); background: var(--paper); color: var(--accent); font: 10px var(--mono); }
  .offscreen-lines.incoming { left: 5px; right: auto; }
  .offscreen-lines.below { transform: translateY(calc(-100% - 2px)); }
  .keyboard-help { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: grab; background: var(--paper-2); flex-shrink: 0; }
  header strong { font: 500 12px var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; max-width: 75%; }
  .inline-detach { font: 10px var(--mono); line-height: 1.4; white-space: nowrap; color: var(--accent); padding: 1px 4px; border: 1px solid var(--rule); margin-block: 1px; }
  .detached-placeholder { line-height: 1.7; overflow-wrap: anywhere; }
  .detached-placeholder button { color: var(--accent); text-decoration: underline; margin-left: 10px; font: inherit; }
  .actions button { font-size: 12px; }
  .location { font: 10px var(--mono); color: var(--ink-3); padding: 7px 12px; border-bottom: 1px solid var(--rule-soft); flex-shrink: 0; overflow-wrap: anywhere; }
  .source { position: relative; flex: 1; min-height: 0; overflow: auto; cursor: text; user-select: text; }
  p { font-size: 12px; padding: 0 12px; line-height: 1.5; }
  a, .target-link { color: var(--accent); text-decoration: underline; }
  button { cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  header:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .pages { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; border-block: 1px solid var(--rule-soft); padding: 8px 12px; font-size: 11px; }
  .links { font-size: 11px; padding: 10px 12px; overflow-wrap: anywhere; }
  summary { cursor: pointer; }
  .links p { padding: 0; font-size: inherit; }
  .target { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; padding: 10px 0; border-top: 1px solid var(--rule-soft); }
  .target-link { text-align: left; font: 12px var(--mono); }
  .dim { color: var(--ink-3); }
  .kind { font: 500 11px var(--mono); }
  ul { margin: 3px 0; padding-left: 18px; }
  li { padding: 4px 0; line-height: 1.6; }
  li a, li button, li > .dim { display: block; }
  footer { display: flex; flex-wrap: wrap; gap: 8px 12px; justify-content: space-between; align-items: baseline; font-size: 10px; padding: 7px 12px; border-top: 1px solid var(--rule-soft); }
  .size > div { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 8px; }
</style>
