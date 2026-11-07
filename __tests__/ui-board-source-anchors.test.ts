import { describe, expect, it } from 'vitest';
import { boardSourceAnchorPositions, type BoardSourceAnchorGeometry } from '../ui/src/lib/board-source-anchors';
import type { BoardSourceAnchor } from '../ui/src/lib/board-model';
const outgoing: BoardSourceAnchor = { id: 'out:20', line: 20, direction: 'outgoing' };
const incoming: BoardSourceAnchor = { id: 'in:30', line: 30, direction: 'incoming' };
function geometry(changes: Partial<BoardSourceAnchorGeometry> = {}): BoardSourceAnchorGeometry {
  return { top: 60, bottom: 260, gutterX: 510, from: 10, to: 409,
    rows: new Map([[20, { y: 120 }], [30, { y: 200 }]]), ...changes };
}
describe('source-line endpoint geometry', () => {
  it('uses the measured right gutter and the target card left edge at their exact lines', () => {
    expect(boardSourceAnchorPositions([outgoing, incoming], geometry())).toEqual([
      { ...outgoing, x: 510, y: 120, offscreen: null }, { ...incoming, x: 0, y: 200, offscreen: null },
    ]);
  });
  it('tracks each independently scrolled row and clamps only offscreen endpoints', () => {
    expect(boardSourceAnchorPositions([outgoing, incoming], geometry({ rows: new Map([[20, { y: -20 }], [30, { y: 500 }]]) }))).toEqual([
      { ...outgoing, x: 510, y: 69, offscreen: 'above' }, { ...incoming, x: 0, y: 251, offscreen: 'below' },
    ]);
    expect(boardSourceAnchorPositions([outgoing], geometry({ rows: new Map([[20, { y: 95 }]]) }))[0]).toMatchObject({ y: 95, offscreen: null });
  });
  it('represents lines on other pages without pretending they are on the current page', () => {
    expect(boardSourceAnchorPositions([outgoing, incoming], geometry({ from: 21, to: 29, rows: new Map() }))).toEqual([
      { ...outgoing, x: 510, y: 69, offscreen: 'above' }, { ...incoming, x: 0, y: 251, offscreen: 'below' },
    ]);
    expect(boardSourceAnchorPositions([outgoing], geometry({ rows: new Map() }))).toEqual([]);
  });
  it('retains distinct line handle IDs even when several lines share one offscreen boundary', () => {
    const second = { ...outgoing, id: 'out:21', line: 21 };
    const positions = boardSourceAnchorPositions([outgoing, second], geometry({ from: 50, to: 449, rows: new Map() }));
    expect(positions.map((item) => [item.id, item.y])).toEqual([['out:20', 69], ['out:21', 69]]);
  });
  it('handles a small resized viewport and refuses invalid or unmeasurable rows', () => {
    expect(boardSourceAnchorPositions([outgoing], geometry({ top: 60, bottom: 70, rows: new Map([[20, { y: 120 }]]) }))[0]).toMatchObject({ y: 65, offscreen: 'below' });
    expect(boardSourceAnchorPositions([outgoing], geometry({ bottom: 60 }))).toEqual([]);
    expect(boardSourceAnchorPositions([outgoing], geometry({ gutterX: NaN }))).toEqual([]);
    for (const line of [0, -1, 1.5, NaN]) expect(boardSourceAnchorPositions([{ ...outgoing, line }], geometry())).toEqual([]);
  });
});
