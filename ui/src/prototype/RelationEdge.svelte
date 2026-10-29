<script lang="ts">
  import { BaseEdge, EdgeLabel, type EdgeProps } from '@xyflow/svelte';

  let { id, sourceX, sourceY, targetX, targetY, markerEnd, style, label, labelStyle, data, interactionWidth }: EdgeProps = $props();
  // A small presentation-only lane keeps different kinds between the same
  // endpoints independently visible and clickable, even on horizontal links.
  const lane = $derived(Number(data?.lane ?? 0));
  const bend = $derived(Math.max(80, Math.abs(targetX - sourceX) * 0.5));
  const path = $derived(`M ${sourceX},${sourceY} C ${sourceX + bend},${sourceY + lane} ${targetX - bend},${targetY + lane} ${targetX},${targetY}`);
  const x = $derived((sourceX + targetX) / 2);
  const y = $derived((sourceY + targetY) / 2 + lane * 0.75);
</script>

<BaseEdge {id} {path} {markerEnd} {style} {interactionWidth} />
<EdgeLabel {x} {y} selectEdgeOnClick style={labelStyle}>{label}</EdgeLabel>
