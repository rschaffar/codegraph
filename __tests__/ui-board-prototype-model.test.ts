import { describe, expect, it } from 'vitest';
import { filterComponents, nextCodePosition, projectBoard } from '../ui/src/prototype/board-model';
import { component, demoCalls, demoComponents, sourceMethod } from '../ui/src/prototype/demo-data';

// Synthetic fixture behaviour only: these tests do not prove index accuracy,
// real interface dispatch, browser layout or the future live board API.
describe('review board clickdummy model', () => {
  it('includes one-hop context but does not recursively expand it', () => {
    const board = projectBoard(['endpoint'], [], []);
    expect(board.components.map(({ component: item }) => item.id)).toEqual(['endpoint', 'coordinator']);
    expect(board.components.map(({ role }) => role)).toEqual(['focus', 'context']);
    expect(board.edges).toHaveLength(1);
  });

  it('allows an explicit focus set across namespaces and omits context on request', () => {
    const board = projectBoard(['coordinator', 'state'], [], [], false);
    expect(board.components.map(({ component: item }) => item.id)).toEqual(['coordinator', 'state']);
    expect(board.edges).toHaveLength(1);
    expect(board.edges[0]!.calls).toHaveLength(3);
  });

  it('keeps hidden neighbours hidden and reports their missing call sites', () => {
    const board = projectBoard(['endpoint'], ['coordinator'], []);
    expect(board.components.map(({ component: item }) => item.id)).toEqual(['endpoint']);
    expect(board.components[0]!.hiddenConnections).toBe(1);
    expect(board.edges).toEqual([]);
  });

  it('counts filtered context-to-context calls even when both endpoints are visible', () => {
    const board = projectBoard(['endpoint', 'loader'], [], []);
    expect(board.components.map(({ component: item }) => item.id)).toContain('factory');
    expect(board.components.map(({ component: item }) => item.id)).toContain('coordinator');
    expect(board.edges.some((edge) => edge.source === 'coordinator' && edge.target === 'factory')).toBe(false);
    expect(board.components.find(({ component: item }) => item.id === 'factory')!.hiddenConnections).toBe(2);
  });

  it('aggregates collapsed calls and splits them onto expanded method handles', () => {
    const collapsed = projectBoard(['coordinator', 'factory'], [], [], false);
    expect(collapsed.edges).toHaveLength(1);
    expect(collapsed.edges[0]!.calls).toHaveLength(2);
    const expanded = projectBoard(['coordinator', 'factory'], [], ['coordinator', 'factory'], false);
    expect(expanded.edges.map((edge) => edge.sourceHandle)).toEqual(['out-Refresh', 'out-Apply']);
    expect(expanded.edges.every((edge) => edge.targetHandle === 'in-Build')).toBe(true);
    expect(expanded.edges.flatMap((edge) => edge.calls)).toEqual(collapsed.edges[0]!.calls);
  });

  it('preserves both directions of the sample cycle and interface evidence', () => {
    const board = projectBoard(['coordinator', 'audit', 'factory', 'loader'], [], [], false);
    expect(board.edges.some((edge) => edge.source === 'coordinator' && edge.target === 'audit')).toBe(true);
    expect(board.edges.some((edge) => edge.source === 'audit' && edge.target === 'coordinator')).toBe(true);
    const dispatch = board.edges.find((edge) => edge.target === 'loader');
    expect(dispatch?.via).toBe(true);
    expect(dispatch?.calls[0]?.via).toContain('IDataLoader');
  });

  it('can start empty and search or enumerate a sample namespace', () => {
    expect(projectBoard([], [], []).components).toEqual([]);
    expect(filterComponents('candidate', '').map((item) => item.id)).toEqual(['factory']);
    expect(filterComponents('', 'Demo.Refresh').map((item) => item.id)).toEqual(['coordinator', 'factory']);
    expect(filterComponents('nothing matches', '')).toEqual([]);
  });

  it('places new source cards in a free slot after another card is closed or resized', () => {
    expect(nextCodePosition([])).toEqual({ x: 30, y: 820 });
    const right = { position: { x: 600, y: 820 }, width: 530, height: 310 };
    expect(nextCodePosition([right])).toEqual({ x: 30, y: 820 });
    const wide = { position: { x: 30, y: 820 }, width: 1100, height: 700 };
    expect(nextCodePosition([wide])).toEqual({ x: 30, y: 1560 });
  });

  it('keeps every fixture call anchored to existing sample methods and source lines', () => {
    expect(new Set(demoComponents.map((item) => item.id)).size).toBe(demoComponents.length);
    for (const call of demoCalls) {
      const caller = sourceMethod(call.source, call.sourceMethod);
      expect(call.line).toBeGreaterThanOrEqual(caller.line);
      expect(call.line).toBeLessThan(caller.line + caller.code.length);
      expect(sourceMethod(call.target, call.targetMethod)).toBeDefined();
      expect(component(call.target)).toBeDefined();
    }
  });
});
