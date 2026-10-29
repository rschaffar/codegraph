import { describe, expect, it } from 'vitest';
import { EDGE_KINDS, NODE_KINDS } from '../src/types';
import { cardFamily, edgeKinds, kindLabel, nodeKinds, relationLabel } from '../ui/src/prototype/catalog';
import { browseConnections, filterSymbols, includeSymbols, nextCodePosition, nextSymbolPosition, projectBoard, representative, scopeIds, targetState } from '../ui/src/prototype/board-model';
import { children, demoRelations, demoSymbols, initialSelection, symbol } from '../ui/src/prototype/demo-data';

// Fixture/presentation contracts only, not extraction, runtime dispatch or live API accuracy.
describe('all-kind review board clickdummy', () => {
  it('covers the engine catalogues and all six card families without importing the engine in the browser', () => {
    expect(nodeKinds).toEqual(NODE_KINDS);
    expect(edgeKinds).toEqual(EDGE_KINDS);
    for (const kind of NODE_KINDS) {
      expect(demoSymbols.some((item) => item.kind === kind)).toBe(true);
      expect(cardFamily(kind)).not.toBe('symbol');
    }
    for (const kind of EDGE_KINDS) expect(demoRelations.some((edge) => edge.kind === kind)).toBe(true);
    expect(new Set(NODE_KINDS.map(cardFamily)).size).toBe(6);
    expect(cardFamily('future_kind')).toBe('symbol');
    expect(kindLabel('future_kind')).toBe('future kind');
    expect(relationLabel('future_relation')).toBe('future relation');
  });

  it('adds only explicitly selected symbols, with no automatic neighbours', () => {
    const state = includeSymbols([], [], ['coordinator', 'coordinator']);
    expect(state.included).toEqual(['coordinator']);
    expect(projectBoard(state.included, [], []).symbols.map((item) => item.symbol.id)).toEqual(['coordinator']);
    expect(projectBoard([], [], []).symbols).toEqual([]);
    expect(projectBoard(initialSelection, [], []).symbols).toHaveLength(3);
    expect(includeSymbols([], [], ['not-a-symbol']).included).toEqual([]);
  });

  it('browses class/member scopes and both directions without changing membership', () => {
    expect(browseConnections('coordinator', 'outgoing', false, initialSelection, [], 'calls')).toEqual([]);
    const all = browseConnections('coordinator', 'outgoing', true, initialSelection, [], 'calls');
    expect(all.map((row) => row.target.id)).toContain('factory.Build');
    expect(all.map((row) => row.target.id)).toContain('publisher.Publish');
    const method = browseConnections('coordinator.Report', 'outgoing', false, initialSelection, [], 'calls');
    expect(method.map((row) => row.target.id)).toEqual(['state.Read']);
    const incoming = browseConnections('factory.Build', 'incoming', false, initialSelection, [], 'calls');
    expect(incoming.map((row) => row.target.id).sort()).toEqual(['coordinator.Apply', 'coordinator.Refresh']);
    expect(initialSelection).toEqual(['coordinator', 'factory', 'state']);
  });

  it('can browse every relation kind in both directions, including future kinds', () => {
    for (const kind of [...EDGE_KINDS, 'future_relation']) {
      const edge = demoRelations.find((item) => item.kind === kind)!;
      const outgoing = browseConnections(edge.source, 'outgoing', false, [], [], kind);
      const incoming = browseConnections(edge.target, 'incoming', false, [], [], kind);
      expect(outgoing.find((row) => row.target.id === edge.target)?.evidence).toContainEqual(edge);
      expect(incoming.find((row) => row.target.id === edge.source)?.evidence).toContainEqual(edge);
      expect(outgoing.flatMap((row) => row.evidence).every((item) => item.kind === kind)).toBe(true);
    }
  });

  it('offers hidden and absent targets even though they have no visible canvas edge', () => {
    const rows = browseConnections('coordinator', 'outgoing', true, initialSelection, ['factory'], 'calls');
    expect(rows.find((row) => row.target.id === 'factory.Build')).toMatchObject({ status: 'hidden', representative: 'factory' });
    expect(rows.find((row) => row.target.id === 'publisher.Publish')).toMatchObject({ status: 'absent', representative: 'publisher.Publish' });
    expect(projectBoard(initialSelection, ['factory'], []).symbols.map((item) => item.symbol.id)).not.toContain('factory');
    const restored = includeSymbols(initialSelection, ['factory'], ['factory']);
    expect(restored.included).toEqual(initialSelection);
    expect(restored.hidden).toEqual([]);
  });

  it('folds proven owners but prefers independently pinned members without duplicate evidence', () => {
    expect(representative('factory.Build', ['factory'], [])).toBe('factory');
    expect(representative('parameter', ['factory'], [])).toBe('factory');
    expect(representative('factory.Build', ['factory', 'factory.Build'], [])).toBe('factory.Build');
    expect(representative('factory.Build', ['factory', 'factory.Build'], ['factory'])).toBe('factory.Build');
    expect(targetState('factory.Build', ['factory'], [])).toMatchObject({ status: 'visible', representative: 'factory' });
    const board = projectBoard([...initialSelection, 'factory.Build'], [], []);
    const calls = board.edges.filter((edge) => edge.kind === 'calls' && edge.target === 'factory.Build');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.evidence).toHaveLength(2);
    expect(board.edges.some((edge) => edge.kind === 'calls' && edge.target === 'factory')).toBe(false);
  });

  it('keeps parallel relationship kinds separate and preserves all original evidence once', () => {
    const board = projectBoard(demoSymbols.map((item) => item.id), [], [], '', true);
    const evidence = board.edges.flatMap((edge) => edge.evidence.map((item) => item.id));
    expect(evidence.sort()).toEqual(demoRelations.map((item) => item.id).sort());
    expect(new Set(evidence).size).toBe(evidence.length);
    const pair = board.edges.filter((edge) => edge.source === 'factory.Build' && edge.target === 'candidate');
    expect(pair.map((edge) => edge.kind).sort()).toEqual(['instantiates', 'returns']);
    expect(board.edges.some((edge) => edge.kind === 'future_relation')).toBe(true);
  });

  it('uses member handles on expansion and header handles when a member is beyond the outline bound', () => {
    const expanded = projectBoard(initialSelection, [], ['coordinator', 'factory'], 'calls');
    expect(expanded.edges.some((edge) => edge.sourceHandle === 'out-coordinator.Refresh' && edge.targetHandle === 'in-factory.Build')).toBe(true);
    const bounded = projectBoard(initialSelection, [], ['coordinator'], 'calls', false, { coordinator: 1 });
    expect(bounded.symbols.find((item) => item.symbol.id === 'coordinator')?.members).toHaveLength(1);
    expect(bounded.edges.every((edge) => edge.sourceHandle === 'out')).toBe(true); // the field sorts before methods
  });

  it('supports filters, containment and search independently of selected membership', () => {
    const board = projectBoard(initialSelection, [], [], 'type_of');
    expect(board.edges.every((edge) => edge.kind === 'type_of')).toBe(true);
    expect(board.symbols).toHaveLength(3);
    expect(projectBoard(initialSelection, [], [], 'contains').edges).toEqual([]);
    expect(projectBoard(initialSelection, [], [], 'contains', true).edges.length).toBeGreaterThan(0);
    expect(browseConnections('coordinator', 'outgoing', false, [], [], 'contains').length).toBe(children('coordinator').length);
    expect(filterSymbols('candidate', '', 'struct').map((item) => item.id)).toEqual(['candidate']);
    expect(filterSymbols('', 'Demo.Contracts').map((item) => item.kind).sort()).toEqual(['protocol', 'trait']);
    expect(browseConnections('coordinator', 'outgoing', true, [], [], 'calls', 'publisher').map((row) => row.target.id)).toEqual(['publisher.Publish']);
    expect(scopeIds('factory', true).has('parameter')).toBe(true);
  });

  it('preserves the callback cycle and keeps interface declarations separate from implementations', () => {
    const board = projectBoard(['coordinator', 'audit', 'factory', 'contract', 'loader'], [], []);
    expect(board.edges.some((edge) => edge.source === 'coordinator' && edge.target === 'audit')).toBe(true);
    expect(board.edges.find((edge) => edge.source === 'audit' && edge.target === 'coordinator')?.via).toContain('not proven');
    expect(board.edges.some((edge) => edge.source === 'factory' && edge.target === 'contract' && edge.kind === 'calls')).toBe(true);
    expect(board.edges.some((edge) => edge.source === 'factory' && edge.target === 'loader')).toBe(false);
    expect(board.edges.some((edge) => edge.source === 'loader' && edge.target === 'contract' && edge.kind === 'implements')).toBe(true);
  });

  it('reserves pre-existing geometry regardless of fixture/insertion order', () => {
    const occupied = [{ position: { x: 30, y: 180 }, width: 286, height: 240 }];
    expect(nextSymbolPosition(occupied, { x: 30, y: 30 })).toEqual({ x: 30, y: 630 });
    expect(occupied[0]!.position).toEqual({ x: 30, y: 180 });
    expect(nextSymbolPosition(occupied, { x: 470, y: 30 })).toEqual({ x: 470, y: 30 });
  });

  it('finds free source-card slots after close/resize, including a lower reading lane', () => {
    expect(nextCodePosition([])).toEqual({ x: 30, y: 820 });
    expect(nextCodePosition([{ position: { x: 600, y: 820 }, width: 530, height: 310 }])).toEqual({ x: 30, y: 820 });
    expect(nextCodePosition([{ position: { x: 30, y: 820 }, width: 1100, height: 700 }])).toEqual({ x: 30, y: 1560 });
    expect(nextCodePosition([], 2000)).toEqual({ x: 30, y: 2000 });
  });

  it('keeps fixture identities, ownership and callable evidence valid, while allowing metadata-only cards', () => {
    expect(new Set(demoSymbols.map((item) => item.id)).size).toBe(demoSymbols.length);
    for (const item of demoSymbols) if (item.ownerId) expect(symbol(item.ownerId)).toBeDefined();
    for (const edge of demoRelations) {
      const source = symbol(edge.source); expect(symbol(edge.target)).toBeDefined();
      if (edge.kind === 'calls' && source.code) {
        expect(edge.line).toBeGreaterThanOrEqual(source.line);
        expect(edge.line).toBeLessThan(source.line + source.code.length);
      }
    }
    expect(symbol('trait').code).toBeUndefined();
    expect(symbol('route').code?.join('\n')).toContain('MapPost');
  });
});
