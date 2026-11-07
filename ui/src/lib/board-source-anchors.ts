import type { BoardSourceAnchor } from './board-model';

export interface BoardSourceAnchorPosition extends BoardSourceAnchor {
  x: number;
  y: number;
  offscreen: 'above' | 'below' | null;
}
export interface BoardSourceAnchorGeometry {
  /** All coordinates are card-local CSS pixels, independent of canvas zoom. */
  top: number;
  bottom: number;
  gutterX: number;
  from: number;
  to: number;
  rows: ReadonlyMap<number, { y: number }>;
}

/** A missing row within a loaded page is not permission to invent its position. */
export function boardSourceAnchorPositions(anchors: readonly BoardSourceAnchor[], geometry: BoardSourceAnchorGeometry): BoardSourceAnchorPosition[] {
  const { top, bottom, gutterX, from, to, rows } = geometry;
  if (![top, bottom, gutterX, from, to].every(Number.isFinite) || bottom <= top || to < from) return [];
  const margin = Math.min(9, (bottom - top) / 2);
  const first = top + margin; const last = bottom - margin;
  return anchors.flatMap((anchor) => {
    if (!Number.isSafeInteger(anchor.line) || anchor.line < 1) return [];
    const row = rows.get(anchor.line);
    let offscreen: BoardSourceAnchorPosition['offscreen'] = null;
    let y: number;
    if (row && Number.isFinite(row.y)) {
      y = row.y;
      if (y < first) offscreen = 'above';
      else if (y > last) offscreen = 'below';
    } else if (anchor.line < from) { y = first; offscreen = 'above'; }
    else if (anchor.line > to) { y = last; offscreen = 'below'; }
    else return [];
    return [{ ...anchor, x: anchor.direction === 'outgoing' ? gutterX : 0, y: Math.max(first, Math.min(last, y)), offscreen }];
  });
}
