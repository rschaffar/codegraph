<script lang="ts">
  import { tick } from 'svelte';
  import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from '@xyflow/svelte';
  import KindGlyph from '../KindGlyph.svelte';
  import { cardFamily, kindLabel } from '../../lib/board-catalog';
  import type { BoardMemberPage, BoardMemberRow, SymbolData } from '../../lib/board-model';

  let { id, data, selected }: NodeProps<Node<SymbolData, 'symbol'>> = $props();
  const updateNodeInternals = useUpdateNodeInternals();
  // Old hosts can still supply only a direct member list.
  const rows = $derived<BoardMemberRow[]>(data.memberRows ?? data.members.map((symbol, rowKey) => ({
    rowKey, parentRow: -1, reference: false, symbol, ownerId: id, depth: 1, hasChildren: false, expanded: false,
    hidden: data.hidden.includes(symbol.id), pinned: data.pinned.includes(symbol.id),
    located: data.locatedMember === symbol.id, handles: !data.hidden.includes(symbol.id) && !data.pinned.includes(symbol.id), memberCount: symbol.memberCount ?? 0,
  })));
  const rowsByParent = $derived.by(() => {
    const grouped = new Map<number, BoardMemberRow[]>();
    for (const row of rows) { const list = grouped.get(row.parentRow) ?? []; list.push(row); grouped.set(row.parentRow, list); }
    return grouped;
  });
  const pages = $derived<Record<string, BoardMemberPage>>(data.memberPages ?? {
    [id]: { ownerId: id, total: data.memberCount, loaded: data.members.length, shown: data.members.length, filtered: 0,
      remaining: Math.max(0, data.memberCount - data.members.length), hasMore: data.members.length < data.memberCount,
      nextOffset: data.members.length < data.memberCount ? data.members.length : null, loading: false, bounded: false },
  });
  const pathLabel = $derived(data.locatedPath?.map((item) => item.name).join(' → '));
  function listId(owner: string, parentRow = -1) { return `board-members-${encodeURIComponent(JSON.stringify([id, owner, parentRow]))}`; }
  function located(row: BoardMemberRow) { return row.located || (row.symbol.id !== id && row.ownershipProven !== false && data.locatedMember === row.symbol.id); }
  $effect(() => {
    void data.expanded; void data.members; void data.memberRows; void data.hidden; void data.pinned;
    void tick().then(() => updateNodeInternals(id));
  });
</script>

{#snippet memberList(ownerId: string, label: string, parentRow: number)}
  <ul class="members" id={listId(ownerId, parentRow)} aria-label={`Members of ${label}`}>
    {#each rowsByParent.get(parentRow) ?? [] as row (row.symbol.id)}
      <li>
        <div class="member" class:hidden={row.hidden} class:located={located(row)} class:related={data.relatedIds?.has(row.symbol.id)}
          data-member={row.symbol.id} data-depth={row.depth} style={`--member-indent: ${Math.min(row.depth - 1, 6) * 10}px`}>
          {#if row.handles && !row.hidden}<Handle type="target" position={Position.Left} id={`in-${row.symbol.id}`} isConnectable={false} tabindex={-1} aria-hidden="true" />{/if}
          <div class="member-identity">
            {#if row.hasChildren && !row.hidden && !row.reference}
              <button class="disclosure" aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${row.symbol.qualifiedName} members`}
                aria-expanded={row.expanded} aria-controls={listId(row.symbol.id, row.rowKey)} onclick={() => data.act('expand', row.symbol.id)}>{row.expanded ? '▴' : '▸'}</button>
            {:else}<span class="disclosure-spacer" aria-hidden="true"></span>{/if}
            <KindGlyph kind={row.symbol.kind} />
            <button class="member-name" title={`${kindLabel(row.symbol.kind)} · ${row.symbol.qualifiedName}`}
              aria-label={`Open ${row.symbol.qualifiedName} source`} aria-current={located(row) ? 'location' : undefined}
              onclick={() => data.act('code', row.symbol.id)}>{row.symbol.name}</button>
            {#if row.hasChildren}<span class="member-count" title="Eligible indexed direct members">{row.memberCount}</span>{/if}
          </div>
          <div class="member-actions">
            {#if row.reference}<span class="ownership" title="Already present in this outline. Expansion stops here to avoid repeating containment or following a cycle.">Already outlined</span>
            {:else if row.ownershipProven === false}<span class="ownership" title="Containment is indexed, but this outline path is not proven unique ownership. Pin separately for an exact endpoint.">Ownership unproven</span>{/if}
            {#if row.hidden}
              <button class="restore" aria-label={`Restore member ${row.symbol.qualifiedName}`} onclick={() => data.act('restore', row.symbol.id)}>Hidden · Restore</button>
            {:else}
              {#if row.pinned}
                <button class="pinned" aria-label={`Locate pinned ${row.symbol.qualifiedName}`} title="Edges use the separate pinned card" onclick={() => data.act('locate', row.symbol.id)}>Pinned · Locate</button>
              {:else if data.canPinMembers}
                <button aria-label={`Pin ${row.symbol.qualifiedName} separately`} onclick={() => data.act('pin', row.symbol.id)}>Pin</button>
              {/if}
              {#if data.canPinMembers}<button aria-label={`Hide member ${row.symbol.qualifiedName}`} onclick={() => data.act('hide', row.symbol.id)}>Hide</button>{/if}
            {/if}
            <button class="links" aria-label={`Connections for ${row.symbol.qualifiedName}`} onclick={() => data.act('connections', row.symbol.id)}>Links…</button>
          </div>
          {#if row.handles && !row.hidden}<Handle type="source" position={Position.Right} id={`out-${row.symbol.id}`} isConnectable={false} tabindex={-1} aria-hidden="true" />{/if}
        </div>
        {#if row.expanded && !row.hidden}{@render memberList(row.symbol.id, row.symbol.qualifiedName, row.rowKey)}{/if}
      </li>
    {/each}
    {#if pages[ownerId]}
      {@const page = pages[ownerId]}
      {#if page.hasMore || page.filtered || page.loading || page.bounded || page.retained}
        <li class="member-page" style={`--member-indent: ${Math.min((rowsByParent.get(parentRow)?.[0]?.depth ?? 1) - 1, 6) * 10}px`}>
          <span>{page.shown} shown / {page.total} eligible indexed{page.filtered ? ` · ${page.filtered} loaded excluded` : ''}{page.retained ? ` · ${page.retained} retained/requested outside this filter/page` : ''}</span>
          {#if page.hasMore || page.loading}
            <button class="show-more" disabled={page.loading} aria-label={`Show more members of ${label}`} onclick={() => data.act('more', ownerId)}>
              {page.loading ? 'Loading members…' : `Show more${page.remaining ? ` (${page.remaining} outside this eligible reveal)` : ''}`}
            </button>
          {/if}
          {#if page.bounded}<span>Loaded scope or outline reveal is bounded; Connections can inspect the indexed contents.</span>{#if data.canPinMembers}<button onclick={() => data.act('contents', ownerId)}>Browse members in Connections</button>{/if}{/if}
        </li>
      {/if}
    {/if}
  </ul>
{/snippet}

<article class="symbol" class:chosen={selected} class:related={data.related} data-symbol={id} data-source-related={data.related ? 'true' : undefined} data-family={cardFamily(data.symbol.kind)} aria-label={`${kindLabel(data.symbol.kind)} ${data.symbol.qualifiedName}`}>
  <header class="board-drag-handle" title="Drag the header to move this card. Keyboard: focus the card and use arrow keys.">
    <KindGlyph kind={data.symbol.kind} />
    <strong title={data.symbol.qualifiedName}>{data.symbol.name}</strong>
    <button class="nodrag nopan nokey" aria-label={`Hide ${data.symbol.qualifiedName}`} title="Hide from board (reversible)" onclick={() => data.act('hide', id)}>×</button>
  </header>
  <Handle type="target" position={Position.Left} id="in" isConnectable={false} tabindex={-1} aria-hidden="true" style="top: 27px" />
  <Handle type="source" position={Position.Right} id="out" isConnectable={false} tabindex={-1} aria-hidden="true" style="top: 27px" />
  <div class="description nodrag nopan nokey">
    <div class="identity"><span class="kind">{kindLabel(data.symbol.kind)}</span><span>{data.symbol.folder ?? data.symbol.file}</span></div>
    <p>{data.symbol.purpose}</p>
  </div>
  <div class="actions nodrag nopan nokey">
    <button class="connections" aria-label={`Connections for ${data.symbol.qualifiedName}`} onclick={() => data.act('connections', id)}>Connections…</button>
    <button aria-label={`Open ${data.symbol.qualifiedName} source`} onclick={() => data.act('code', id)}>Source ↗</button>
  </div>
  {#if data.memberCount || data.retainedMemberCount || data.memberRows?.length}
    <div class="member-toggle nodrag nopan nokey"><button aria-label={`${data.expanded ? 'Collapse' : 'Expand'} ${data.symbol.qualifiedName} members`}
      aria-expanded={data.expanded} aria-controls={listId(id)} onclick={() => data.act('expand', id)}>{data.expanded ? '▴' : '▾'} Members <span>{data.memberCount} eligible{data.retainedMemberCount ? ` · ${data.retainedMemberCount} pinned/hidden` : ''}</span></button></div>
    {#if data.expanded}
      <div class="outline nodrag nopan nokey">
        {#if pathLabel}<p class="located-path" title={pathLabel} aria-live="polite">Located: {pathLabel}</p>{/if}
        {@render memberList(id, data.symbol.qualifiedName, -1)}
      </div>
    {/if}
  {/if}
  <footer class="nodrag nopan nokey"><span>{cardFamily(data.symbol.kind)} card</span>{#if data.undrawn}<button aria-label={`Browse undrawn connections for ${data.symbol.qualifiedName}`} onclick={() => data.act('connections', id)}>{data.undrawn} not drawn →</button>{/if}</footer>
</article>

<style>
  .symbol { width: 286px; background: var(--paper); border: 1px solid var(--rule-soft); border-top: 3px solid var(--accent); color: var(--ink); }
  .symbol.related { outline: 2px dashed var(--accent); outline-offset: 3px; }
  .member.related { background: var(--accent-soft); border-left: 3px solid var(--accent); }
  .symbol.chosen { outline: 2px solid var(--accent); outline-offset: 3px; }
  header { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; cursor: grab; }
  header:active { cursor: grabbing; }
  header strong { font: 500 12px var(--mono); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header button { font-size: 19px; line-height: 16px; color: var(--ink-3); padding: 2px; }
  .description { padding: 0 12px 10px; }
  .identity { display: flex; gap: 8px; flex-wrap: wrap; font: 10px var(--mono); color: var(--ink-3); overflow-wrap: anywhere; }
  .kind { color: var(--accent); }
  p { font-size: 12px; line-height: 1.4; margin: 7px 0 0; }
  .actions { display: flex; justify-content: space-between; border-top: 1px solid var(--rule-faint); padding: 8px 12px; }
  .actions button { font-size: 11px; }
  .connections { color: var(--accent); font-weight: 600; }
  .member-toggle { border-top: 1px solid var(--rule-faint); padding: 7px 12px; }
  .member-toggle button { font-size: 11px; }
  .member-toggle span { color: var(--ink-3); padding-left: 5px; }
  .outline { border-top: 1px solid var(--rule-soft); }
  .members { list-style: none; padding: 0; margin: 0; }
  .member { position: relative; padding: 6px 10px 5px calc(10px + var(--member-indent)); border-bottom: 1px solid var(--rule-faint); }
  .member.hidden { background: var(--paper-2); color: var(--ink-3); }
  .member.located { outline: 2px solid var(--accent); outline-offset: -2px; background: var(--accent-soft); }
  .member-identity { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .disclosure, .disclosure-spacer { width: 16px; flex: 0 0 16px; }
  .disclosure { color: var(--ink-2); font-size: 12px; padding: 3px 0; }
  .member-name { font: 11px var(--mono); text-align: left; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 0; }
  .member-name:hover { text-decoration: underline; }
  .member-count { color: var(--ink-3); font: 10px var(--mono); }
  .member-actions { display: flex; flex-wrap: wrap; gap: 4px 10px; padding-left: 22px; }
  .member-actions button { color: var(--accent); font-size: 10px; padding: 3px 0; }
  .member-actions .links { margin-left: auto; }
  .ownership { color: var(--ink-3); font-size: 10px; padding: 3px 0; }
  .member-page { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 7px 10px 8px calc(12px + var(--member-indent)); border-bottom: 1px solid var(--rule-faint); font-size: 10px; color: var(--ink-3); }
  .show-more { font-size: 11px; padding: 4px 0; color: var(--accent); }
  .show-more:disabled { color: var(--ink-3); }
  .located-path { margin: 0; padding: 7px 12px; color: var(--accent); font: 10px/1.5 var(--mono); overflow-wrap: anywhere; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  footer { display: flex; justify-content: space-between; gap: 6px; padding: 6px 12px; background: var(--paper-2); font-size: 10px; color: var(--ink-3); }
  footer button { color: var(--ink-2); font-size: 10px; }
  .symbol :global(.svelte-flow__handle) { width: 6px; height: 6px; background: var(--paper); border: 1px solid var(--ink-3); }
</style>
