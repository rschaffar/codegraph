<script lang="ts">
  import { NodeResizer, type Node, type NodeProps } from '@xyflow/svelte';
  import { BOARD_COMMENT_TEXT_LIMIT, type CommentCardData } from '../../lib/board-comments';

  let { id, data, selected }: NodeProps<Node<CommentCardData, 'comment'>> = $props();
</script>

<NodeResizer minWidth={240} minHeight={160} maxWidth={4096} maxHeight={4096} isVisible={selected} />
<article class="comment-card" class:chosen={selected} data-comment-card={id}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (SvelteFlow owns Enter selection and arrow-key movement on this focusable move handle.) -->
  <header class="board-drag-handle" role="group" tabindex="0" aria-label="Comment card" aria-describedby={`${id}-move-help`}>
    <strong>Comment</strong>
    <button class="nodrag nopan nokey" aria-label="Delete comment" title="Delete comment" onclick={(event) => { event.stopPropagation(); data.close(id); }}>×</button>
  </header>
  <span id={`${id}-move-help`} class="sr-only">Drag the header to move. Select the card with Enter or Space, then use arrow keys to move it.</span>
  <textarea class="nodrag nopan nowheel nokey" aria-label="Comment text" placeholder="Write a note…" maxlength={BOARD_COMMENT_TEXT_LIMIT}
    value={data.text} oninput={(event) => data.edit(id, event.currentTarget.value)}></textarea>
  <details class="size nodrag nopan nowheel nokey"><summary>Size</summary><div role="group" aria-label="Resize comment card">
    <button onclick={() => data.resize(id, -80, 0)}>Narrower</button><button onclick={() => data.resize(id, 80, 0)}>Wider</button>
    <button onclick={() => data.resize(id, 0, -80)}>Shorter</button><button onclick={() => data.resize(id, 0, 80)}>Taller</button>
  </div></details>
</article>

<style>
  .comment-card { width:100%; height:100%; box-sizing:border-box; display:flex; flex-direction:column; background:var(--paper); color:var(--ink); border:1px dashed var(--ink-3); border-radius:6px; box-shadow:0 6px 20px #0002; }
  .comment-card.chosen { outline:2px solid var(--accent); outline-offset:2px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 12px; border-bottom:1px solid var(--rule-soft); background:var(--paper-2); cursor:grab; }
  header strong { font:600 12px var(--mono); }
  textarea { flex:1; min-height:0; width:100%; box-sizing:border-box; resize:none; padding:12px; border:0; background:transparent; color:inherit; font:14px/1.5 var(--sans); }
  textarea:focus-visible { outline:2px solid var(--accent); outline-offset:-3px; }
  button { border:1px solid var(--rule); background:var(--paper); color:var(--ink-2); border-radius:3px; padding:2px 6px; cursor:pointer; }
  button:focus-visible, summary:focus-visible, header:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .size { padding:4px 12px; border-top:1px solid var(--rule-soft); font:11px var(--mono); }
  summary { cursor:pointer; }
  .size div { display:flex; flex-wrap:wrap; gap:4px; padding-top:4px; }
  .sr-only { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; }
</style>
