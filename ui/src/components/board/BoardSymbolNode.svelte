<script lang="ts">
  import { tick } from 'svelte';
  import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/svelte';
  import KindGlyph from '../KindGlyph.svelte';
  import { cardFamily, kindLabel } from '../../lib/board-catalog';
  import type { SymbolData } from '../../lib/board-model';

  let { id, data, selected }: NodeProps<Node<SymbolData, 'symbol'>> = $props();
  const updateNodeInternals = useUpdateNodeInternals();
  $effect(() => {
    void data.expanded; void data.members.length;
    void tick().then(() => updateNodeInternals(id));
  });
</script>

<article class="symbol" class:chosen={selected} data-symbol={id} data-family={cardFamily(data.symbol.kind)}>
  <header class="board-drag-handle">
    <KindGlyph kind={data.symbol.kind} />
    <strong title={data.symbol.qualifiedName}>{data.symbol.name}</strong>
    <button class="nodrag" aria-label={`Hide ${data.symbol.qualifiedName}`} title="Hide from board (reversible)" onclick={() => data.act('hide', id)}>×</button>
  </header>
  <Handle type="target" position={Position.Left} id="in" isConnectable={false} style="top: 27px" />
  <Handle type="source" position={Position.Right} id="out" isConnectable={false} style="top: 27px" />
  <div class="description nodrag nopan">
    <div class="identity"><span class="kind">{kindLabel(data.symbol.kind)}</span><span>{data.symbol.folder ?? data.symbol.file}</span></div>
    <p>{data.symbol.purpose}</p>
  </div>
  <div class="actions nodrag nopan">
    <button class="connections" aria-label={`Connections for ${data.symbol.qualifiedName}`} onclick={() => data.act('connections', id)}>Connections…</button>
    <button aria-label={`Open ${data.symbol.qualifiedName} source`} onclick={() => data.act('code', id)}>Source ↗</button>
  </div>
  {#if data.memberCount}
    <div class="member-toggle nodrag nopan"><button aria-label={`${data.expanded ? 'Collapse' : 'Expand'} ${data.symbol.qualifiedName} members`} onclick={() => data.act('expand', id)}>{data.expanded ? '▴' : '▾'} Members <span>{data.memberCount}</span></button></div>
    {#if data.expanded}
      <div class="members nodrag nopan">
        {#each data.members as member (member.id)}
          <div class="member" class:hidden={data.hidden.includes(member.id)} class:located={data.locatedMember === member.id} data-member={member.id}>
            {#if !data.hidden.includes(member.id)}<Handle type="target" position={Position.Left} id={`in-${member.id}`} isConnectable={false} />{/if}
            <KindGlyph kind={member.kind} />
            <button class="member-name" title={`${kindLabel(member.kind)} · ${member.qualifiedName}`} aria-label={`Open ${member.qualifiedName} source`} onclick={() => data.act('code', member.id)}>{member.name}</button>
            {#if data.hidden.includes(member.id)}<button class="pinned" aria-label={`Restore member ${member.qualifiedName}`} onclick={() => data.act('restore', member.id)}>Hidden · Restore</button>
            {:else if data.pinned.includes(member.id)}<button class="pinned" aria-label={`Locate ${member.qualifiedName}`} onclick={() => data.act('locate', member.id)}>pinned</button>{/if}
            <button class="links" aria-label={`Connections for ${member.qualifiedName}`} onclick={() => data.act('connections', member.id)}>Links</button>
            {#if !data.hidden.includes(member.id)}<Handle type="source" position={Position.Right} id={`out-${member.id}`} isConnectable={false} />{/if}
          </div>
        {/each}
        {#if data.members.length < data.memberCount}<button class="show-more" onclick={() => data.act('more', id)}>Show more ({data.memberCount - data.members.length} remaining)</button>{/if}
      </div>
    {/if}
  {/if}
  <footer class="nodrag nopan"><span>{cardFamily(data.symbol.kind)} card</span>{#if data.undrawn}<button aria-label={`Browse undrawn connections for ${data.symbol.qualifiedName}`} onclick={() => data.act('connections', id)}>{data.undrawn} not drawn →</button>{/if}</footer>
</article>

<style>
  .symbol { width: 286px; background: var(--paper); border: 1px solid var(--rule-soft); border-top: 3px solid var(--accent); color: var(--ink); }
  .chosen { outline: 2px solid var(--accent); outline-offset: 3px; }
  header { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; cursor: grab; }
  header:active { cursor: grabbing; }
  header strong { font: 500 12px var(--mono); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header button { font-size: 19px; line-height: 16px; color: var(--ink-3); padding: 2px; }
  .description { padding: 0 12px 10px; }
  .identity { display: flex; gap: 8px; flex-wrap: wrap; font: 10px var(--mono); color: var(--ink-3); }
  .kind { color: var(--accent); }
  p { font-size: 12px; line-height: 1.4; margin: 7px 0 0; }
  .actions { display: flex; justify-content: space-between; border-top: 1px solid var(--rule-faint); padding: 8px 12px; }
  .actions button { font-size: 11px; }
  .connections { color: var(--accent); font-weight: 600; }
  .member-toggle { border-top: 1px solid var(--rule-faint); padding: 7px 12px; }
  .member-toggle button { font-size: 11px; }
  .member-toggle span { color: var(--ink-3); padding-left: 5px; }
  .members { border-top: 1px solid var(--rule-soft); }
  .member { position: relative; display: flex; align-items: center; gap: 7px; padding: 9px 12px; border-bottom: 1px solid var(--rule-faint); }
  .member.hidden { background: var(--paper-2); color: var(--ink-3); }
  .member.located { outline: 1px solid var(--accent); outline-offset: -1px; background: var(--accent-soft); }
  .member-name { font: 11px var(--mono); text-align: left; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .member-name:hover { text-decoration: underline; }
  .links, .pinned { color: var(--accent); font-size: 10px; }
  .show-more { font-size: 11px; padding: 9px 12px; color: var(--accent); }
  footer { display: flex; justify-content: space-between; gap: 6px; padding: 6px 12px; background: var(--paper-2); font-size: 10px; color: var(--ink-3); }
  footer button { color: var(--ink-2); font-size: 10px; }
  .symbol :global(.svelte-flow__handle) { width: 6px; height: 6px; background: var(--paper); border: 1px solid var(--ink-3); }
</style>
