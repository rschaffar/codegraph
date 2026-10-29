<script lang="ts">
  import { NodeResizer, type Node, type NodeProps } from '@xyflow/svelte';
  import { getGraphAdapter } from '../../lib/adapter';
  import { tokensByLine } from '../../lib/highlight';
  import type { CodeBlock, LineRef } from '../../lib/symbol-model';
  import type { WireSource } from '../../lib/wire';
  import type { SourceCardData } from '../../lib/board-model';
  import { live } from '../../lib/live.svelte';
  import { fileHref, symbolHref } from '../../lib/navigation';
  import SourceBlock from '../symbol/SourceBlock.svelte';
  import KindGlyph from '../KindGlyph.svelte';
  import DriftBanner from '../DriftBanner.svelte';

  let { id, data, selected }: NodeProps<Node<SourceCardData, 'code'>> = $props();
  let source = $state<WireSource | null>(null);
  let error = $state('');
  let loading = $state(false);
  let current = $state(false);
  $effect(() => {
    const item = data.symbol; const showCurrent = current;
    void live.indexTick; void live.diskTick;
    const controller = new AbortController();
    source = null; error = ''; loading = true;
    if (item.id.startsWith('missing:')) { error = item.purpose ?? 'Saved symbol does not resolve uniquely. No source range is trusted.'; loading = false; return () => controller.abort(); }
    const adapter = getGraphAdapter();
    // Re-check the identity before trusting any stored line range, including
    // source-only cards while the board is resolving an index notification.
    adapter.nodes([item.id], controller.signal).then((value) => {
      const liveItem = value.items.find((node) => node.id === item.id);
      if (!liveItem || liveItem.qualifiedName !== item.qualifiedName || liveItem.kind !== item.kind || liveItem.file !== item.file || (item.signature !== undefined && liveItem.signature !== item.signature)) {
        throw new Error('Symbol identity changed in the index. Refresh the board to re-resolve it; the old source range is not shown.');
      }
      const from = showCurrent ? 1 : Math.max(1, liveItem.line);
      return adapter.source({ file: liveItem.file, from, to: showCurrent ? 400 : Math.min(liveItem.endLine, from + 399), ...(showCurrent ? { ondrift: 'current' as const } : {}) }, controller.signal);
    }).then((value) => { if (!controller.signal.aborted) source = value; })
      .catch((cause) => { if (!controller.signal.aborted) error = String(cause instanceof Error ? cause.message : cause); })
      .finally(() => { if (!controller.signal.aborted) loading = false; });
    return () => controller.abort();
  });
  const block = $derived<CodeBlock>({ windows: source?.lines ? [{ start: source.from ?? data.symbol.line, lines: source.lines }] : [], gapsAfter: [], tailGap: 0, whole: true });
  const tokens = $derived(tokensByLine(source?.lines ?? [], source?.from ?? data.symbol.line, source?.highlight));
  const refs = new Map<number, LineRef[]>();
</script>

<NodeResizer minWidth={380} minHeight={190} isVisible={selected && !data.collapsed} />
<article class="source-card" class:chosen={selected} data-code-card={data.symbolId}>
  <header class="board-drag-handle"><KindGlyph kind={data.symbol.kind} /><strong title={data.symbol.qualifiedName}>{data.symbol.qualifiedName}</strong>
    <div class="actions nodrag nopan"><button aria-label={`Fit code card ${data.symbol.name}`} onclick={() => data.read(id)}>Read ↗</button>
      <button aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} code card ${data.symbol.name}`} onclick={() => data.toggle(id)}>{data.collapsed ? '▾' : '▴'}</button>
      <button aria-label={`Close code card ${data.symbol.name}`} onclick={() => data.close(id)}>×</button></div>
  </header>
  <div class="location nodrag nopan">{data.symbol.kind} · {data.symbol.file}:{data.symbol.line}</div>
  {#if !data.collapsed}
    <div class="source nodrag nopan nowheel">
      {#if loading}<p>Loading source…</p>{:else if error}<p role="alert">{error}</p>{/if}
      {#if source?.drift}<DriftBanner file={data.symbol.file}>indexed symbol ranges may be stale; no line-anchored graph markings are shown here. {#if !current}<button onclick={() => current = true}>Read current file</button>{/if}</DriftBanner>{/if}
      {#if source?.lines}<SourceBlock {block} {tokens} {refs} defLine={source.drift ? -1 : data.symbol.line} defName={data.symbol.name} highlight={null} onfollow={() => {}} />
      {:else if source && !source.drift}<p>No readable source body. {data.symbol.purpose ?? data.symbol.signature ?? ''}</p>{/if}
      {#if source?.truncated}<p>Source slice is bounded. Open the file for the rest.</p>{/if}
    </div>
    <footer class="nodrag nopan"><a href={symbolHref(data.symbolId)}>Symbol reader ↗</a><a href={fileHref(data.symbol.file, { source: true })}>File source ↗</a><span>Read-only</span></footer>
  {/if}
</article>

<style>
  .source-card { width: 100%; height: 100%; background: var(--paper); border: 1px solid var(--ink-3); display: flex; flex-direction: column; overflow: hidden; color: var(--ink); }
  .chosen { outline: 2px solid var(--accent); outline-offset: 3px; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: grab; background: var(--paper-2); flex-shrink: 0; }
  header strong { font: 500 12px var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .actions { display: flex; gap: 10px; flex-shrink: 0; }
  .actions button { font-size: 12px; }
  .location { font: 10px var(--mono); color: var(--ink-3); padding: 7px 12px; border-bottom: 1px solid var(--rule-soft); flex-shrink: 0; overflow-wrap: anywhere; }
  .source { flex: 1; min-height: 0; overflow: auto; cursor: text; user-select: text; }
  p { font-size: 12px; padding: 0 12px; line-height: 1.5; }
  footer { display: flex; gap: 12px; justify-content: space-between; font-size: 10px; padding: 7px 12px; border-top: 1px solid var(--rule-soft); }
  footer a { color: var(--accent); text-decoration: underline; }
</style>
