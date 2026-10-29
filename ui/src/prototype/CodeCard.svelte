<script lang="ts">
  import { NodeResizer, type Node, type NodeProps } from '@xyflow/svelte';
  import SourceBlock from '../components/symbol/SourceBlock.svelte';
  import KindGlyph from '../components/KindGlyph.svelte';
  import { tokensByLine } from '../lib/highlight';
  import type { CodeBlock, LineRef } from '../lib/symbol-model';
  import { component, sourceMethod } from './demo-data';
  import type { CodeCardData } from './board-model';

  let { id, data, selected }: NodeProps<Node<CodeCardData, 'code'>> = $props();
  const owner = $derived(component(data.componentId));
  const method = $derived(sourceMethod(data.componentId, data.method));
  const block = $derived<CodeBlock>({
    windows: [{ start: method.line, lines: method.code }], gapsAfter: [], tailGap: 0, whole: true,
  });
  const tokens = $derived(tokensByLine(method.code, method.line, undefined));
  const refs = new Map<number, LineRef[]>();
</script>

<NodeResizer minWidth={380} minHeight={190} isVisible={selected && !data.collapsed} />
<article class="code-card" class:chosen={selected} data-code-card={`${owner.name}.${method.name}`}>
  <header class="board-drag-handle">
    <div class="identity"><KindGlyph kind="method" /><strong>{owner.name}.{method.name}()</strong></div>
    <div class="card-actions nodrag nopan">
      <button aria-label={`Fit code card ${owner.name}.${method.name}`} onclick={() => data.read(id)}>Read ↗</button>
      <button aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} code card ${owner.name}.${method.name}`} onclick={() => data.toggle(id)}>{data.collapsed ? '▾' : '▴'}</button>
      <button aria-label={`Close code card ${owner.name}.${method.name}`} onclick={() => data.close(id)}>×</button>
    </div>
  </header>
  <div class="location nodrag nopan">Sample source · {owner.folder}/{owner.name}.cs:{method.line}</div>
  {#if !data.collapsed}
    <div class="source nodrag nopan nowheel">
      <SourceBlock {block} {tokens} {refs} defLine={method.line} defName={method.name} highlight={null} onfollow={() => {}} />
    </div>
    <footer class="nodrag nopan">Read-only sample · drag the header · select the card to resize</footer>
  {/if}
</article>

<style>
  .code-card { width: 100%; height: 100%; background: var(--paper); border: 1px solid var(--ink-3); display: flex; flex-direction: column; overflow: hidden; color: var(--ink); }
  .chosen { outline: 2px solid var(--accent); outline-offset: 3px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--paper-2); padding: 11px 12px; cursor: grab; flex-shrink: 0; }
  header:active { cursor: grabbing; }
  .identity { display: flex; align-items: center; gap: 7px; min-width: 0; }
  strong { font: 500 12px var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .card-actions button { font-size: 12px; padding: 2px; }
  .card-actions button:first-child { color: var(--accent); font-size: 11px; }
  .location { padding: 7px 12px; color: var(--ink-3); font: 10px var(--mono); border-bottom: 1px solid var(--rule-soft); flex-shrink: 0; }
  .source { flex: 1; overflow: auto; min-height: 0; padding: 0 4px 12px; cursor: text; user-select: text; }
  .source :global(.codeblock) { margin-top: 0; }
  footer { font-size: 10px; padding: 7px 12px; color: var(--ink-3); border-top: 1px solid var(--rule-soft); flex-shrink: 0; }
</style>
