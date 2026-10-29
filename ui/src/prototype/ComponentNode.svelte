<script lang="ts">
  import { tick } from 'svelte';
  import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/svelte';
  import KindGlyph from '../components/KindGlyph.svelte';
  import type { ComponentData } from './board-model';

  let { id, data, selected }: NodeProps<Node<ComponentData, 'component'>> = $props();
  const updateNodeInternals = useUpdateNodeInternals();
  $effect(() => {
    void data.expanded;
    void tick().then(() => updateNodeInternals(id));
  });
</script>

<article class="component" class:context={data.role === 'context'} class:chosen={selected} data-component={id}>
  <header class="board-drag-handle">
    <KindGlyph kind="class" />
    <strong>{data.component.name}</strong>
    <button class="nodrag" aria-label={`Hide ${data.component.name}`} title="Hide from this board" onclick={() => data.act('hide', id)}>×</button>
  </header>
  <div class="description nodrag nopan">
    <div class="folder">{data.component.folder}</div>
    <p>{data.component.purpose}</p>
  </div>

  {#if !data.expanded}
    <Handle type="target" position={Position.Left} id="in" isConnectable={false} style="top: 27px" />
    <Handle type="source" position={Position.Right} id="out" isConnectable={false} style="top: 27px" />
  {:else}
    <div class="methods nodrag nopan">
      {#each data.component.methods as method (method.name)}
        <div class="method" data-method={method.name}>
          <Handle type="target" position={Position.Left} id={`in-${method.name}`} isConnectable={false} />
          <KindGlyph kind="method" />
          <button class="method-name" aria-label={`Open ${data.component.name}.${method.name} code`} title="Open a source card" onclick={() => data.act('code', id, method.name)}>{method.name}()</button>
          <span class="line">:{method.line}</span>
          <Handle type="source" position={Position.Right} id={`out-${method.name}`} isConnectable={false} />
        </div>
      {/each}
    </div>
  {/if}

  <footer class="nodrag nopan">
    <button aria-label={`${data.expanded ? 'Collapse' : 'Expand'} ${data.component.name} methods`} onclick={() => data.act('expand', id)}>{data.expanded ? '▴' : '▾'} Methods <span>{data.component.methods.length}</span></button>
    {#if data.role === 'context'}
      <button class="promote" aria-label={`Add ${data.component.name} to focus`} onclick={() => data.act('promote', id)}>+ Focus</button>
    {:else}
      <button aria-label={`Open ${data.component.name} code`} onclick={() => data.act('code', id)}>Open code ↗</button>
    {/if}
  </footer>
  <div class="status nodrag nopan">
    <span class="role">{data.role === 'focus' ? '● In focus' : '○ Context'}</span>
    {#if data.hiddenConnections}<span>{data.hiddenConnections} hidden call {data.hiddenConnections === 1 ? 'site' : 'sites'}</span>{/if}
  </div>
</article>

<style>
  .component { width: 256px; background: var(--paper); border: 1px solid var(--rule-soft); border-top: 3px solid var(--accent); color: var(--ink); }
  .component.chosen { outline: 2px solid var(--accent); outline-offset: 3px; }
  .context { background: var(--paper-2); border-top-color: var(--rule-soft); color: var(--ink-2); }
  header { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; cursor: grab; }
  header:active { cursor: grabbing; }
  header strong { font: 500 12px var(--mono); flex: 1; }
  header button { font-size: 19px; line-height: 16px; color: var(--ink-3); padding: 2px; }
  .description { padding: 0 12px 10px; }
  .folder { font: 10px var(--mono); color: var(--ink-3); }
  p { font-size: 12px; line-height: 1.4; margin: 7px 0 0; }
  footer { display: flex; justify-content: space-between; border-top: 1px solid var(--rule-faint); padding: 7px 10px; gap: 6px; }
  footer button { font-size: 11px; padding: 3px 2px; }
  footer button span { color: var(--ink-3); padding-left: 4px; }
  .promote { color: var(--accent); font-weight: 600; }
  .methods { border-top: 1px solid var(--rule-soft); }
  .method { position: relative; display: flex; align-items: center; gap: 7px; padding: 9px 12px; border-bottom: 1px solid var(--rule-faint); }
  .method-name { font: 11px var(--mono); text-align: left; flex: 1; }
  .method-name:hover { text-decoration: underline; color: var(--accent); }
  .line { color: var(--ink-3); font: 10px var(--mono); }
  .status { display: flex; justify-content: space-between; gap: 4px; padding: 5px 12px; background: var(--paper-2); font-size: 10px; color: var(--ink-3); }
  .role { color: var(--accent); }
  .context .role { color: var(--ink-3); }
  .component :global(.svelte-flow__handle) { width: 6px; height: 6px; background: var(--paper); border: 1px solid var(--ink-3); }
</style>
