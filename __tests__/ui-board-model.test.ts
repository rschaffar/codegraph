import { describe, expect, it } from 'vitest';
import { NODE_KINDS } from '../src/types';
import {
  createBoardModel, edgeLaneMap, isBoardEvidenceUncertain,
  type BoardEvidence, type BoardMemberPageState, type BoardSymbol,
} from '../ui/src/lib/board-model';

import { BOARD_MEMBER_REVEAL_LIMIT, mergeBoardFacts } from '../ui/src/lib/board-model';
import { MAX_BOARD_SCOPE } from '../src/graph/board-projection';

const node = (id: string, ownerId?: string, line = 1, extra: Partial<BoardSymbol> = {}): BoardSymbol => ({
  id, name: id, qualifiedName: id, kind: 'function', file: 'src/sample.ts', line, ...(ownerId ? { ownerId } : {}), ...extra,
});
const edge = (id: string, source: string, target: string, extra: Partial<BoardEvidence> = {}): BoardEvidence => ({ id, source, target, kind: 'calls', ...extra });
const nested = () => createBoardModel([
  node('root', undefined, 1, { kind: 'module' }), node('nested', 'root', 2, { kind: 'class' }),
  node('method', 'nested', 3, { kind: 'method' }), node('parameter', 'method', 4, { kind: 'parameter' }),
  node('peer'), node('other', 'root', 20),
], [edge('call', 'parameter', 'peer'), edge('within', 'method', 'parameter', { kind: 'references' })]);

describe('bounded discovery facts', () => {
  it('evicts old search hits even when they share a selected expanded owner', () => {
    const retained = new Set(['root', 'visible']); let facts = [node('root'), node('visible', 'root')];
    for (let page = 0; page < 12; page++) facts = mergeBoardFacts(facts, Array.from({ length: 30 }, (_, i) => node(`discovery${page * 30 + i}`, 'root')), retained, 64);
    expect(facts).toHaveLength(64); expect(facts.some((item) => item.id === 'root')).toBe(true);
    expect(facts.some((item) => item.id === 'visible')).toBe(true); expect(facts.some((item) => item.id === 'discovery0')).toBe(false);
    expect(retained).toEqual(new Set(['root', 'visible']));
  });
  it('replaces authoritative facts instead of retaining obsolete ownership/generated flags', () => {
    const result = mergeBoardFacts([node('changed', 'old', 1, { generated: true })], [node('changed')], new Set());
    expect(result[0]!.ownerId).toBeUndefined(); expect(result[0]!.generated).toBeUndefined();
  });
});

describe('authoritative filtered membership versus cached identity facts', () => {
  it('does not inflate zero eligible counts from cached descendants', () => {
    const model = createBoardModel([node('root', undefined, 1, { memberCount: 0 }), node('cached', 'root', 2, { test: true })], []);
    const detail = model.projectBoard(['root'], [], ['root'], '', false, {}, { tests: false, eligibleIds: new Set(['root']) }).symbols[0]!;
    expect(detail.memberCount).toBe(0); expect(detail.memberRows).toEqual([]);
  });
  it('keeps uncertain/out-of-scope cached identities out of automatic rows', () => {
    const model = createBoardModel([node('root', undefined, 1, { memberCount: 1 }), node('cached', 'root', 2), node('eligible', 'root', 3)], []);
    const detail = model.projectBoard(['root'], [], ['root'], '', false, {}, { eligibleIds: new Set(['root', 'eligible']) }).symbols[0]!;
    expect(detail.memberCount).toBe(1); expect(detail.memberRows.map((row) => row.symbol.id)).toEqual(['eligible']);
  });
  it('retains hidden Restore rows outside filtered pages without counting them as eligible', () => {
    const model = createBoardModel([node('root'), node('hidden', 'root', 2, { test: true }), node('eligible', 'root', 3)], []);
    const detail = model.projectBoard(['root'], ['hidden'], ['root'], '', false, {}, { tests: false,
      memberPages: { root: { ids: ['eligible'], total: 1, loaded: 1, nextOffset: null } } }).symbols[0]!;
    expect(detail.memberRows.map((row) => row.symbol.id)).toEqual(['hidden', 'eligible']);
    expect(detail.memberRows[0]).toMatchObject({ hidden: true, handles: false });
    expect(detail.memberPages.root).toMatchObject({ total: 1, shown: 1, retained: 1 });
  });
  it('caps reveal independently of the exact indexed total and persisted geometry', () => {
    expect(BOARD_MEMBER_REVEAL_LIMIT).toBe(MAX_BOARD_SCOPE);
    const model = createBoardModel([node('root', undefined, 1, { memberCount: 3000 }), ...Array.from({ length: 2055 }, (_, i) => node(`child${i}`, 'root', i + 2))], []);
    const detail = model.projectBoard(['root'], [], ['root'], '', false, { root: 2054 }).symbols[0]!;
    expect(detail.memberRows).toHaveLength(BOARD_MEMBER_REVEAL_LIMIT);
    expect(detail.memberPages.root).toMatchObject({ total: 3000, shown: BOARD_MEMBER_REVEAL_LIMIT, hasMore: false, bounded: true });
  });
});

describe('source selection decorates existing indexed endpoints only', () => {
  it('highlights the proven owner and exact original evidence for a nested body', () => {
    const result = nested().sourceSelection(['method'], ['root', 'peer'], []);
    expect([...result.members]).toEqual(['method', 'parameter']);
    expect([...result.representatives]).toEqual(['root']);
    expect([...result.evidenceIds]).toEqual(['call', 'within']);
  });
  it('respects independent pinning and hidden branches without admitting peers', () => {
    const model = nested(); const included = ['root', 'parameter', 'peer'];
    expect([...model.sourceSelection(['parameter'], included, []).representatives]).toEqual(['parameter']);
    expect([...model.sourceSelection(['parameter'], included, ['parameter']).representatives]).toEqual([]);
    expect([...model.sourceSelection(['root'], included, ['root']).representatives]).toEqual(['parameter']);
    expect(included).toEqual(['root', 'parameter', 'peer']);
  });
  it('does not fabricate a representative or evidence for an unavailable identity', () => {
    const result = nested().sourceSelection(['unavailable'], ['root'], []);
    expect([...result.representatives]).toEqual([]); expect([...result.evidenceIds]).toEqual([]);
  });
});

describe('recursive review board presentation', () => {
  it('renders every kind recursively in source order, with unknown-kind fallback', () => {
    const kinds = [...NODE_KINDS, 'future_kind'];
    const symbols = kinds.map((kind, index) => node(`n${index}`, index ? `n${index - 1}` : undefined, index + 1, { kind }));
    const model = createBoardModel([...symbols].reverse(), []);
    const board = model.projectBoard(['n0'], [], symbols.map((item) => item.id));
    expect(board.symbols).toHaveLength(1);
    expect(board.symbols[0]!.memberRows.map((row) => [row.symbol.kind, row.depth])).toEqual(kinds.slice(1).map((kind, index) => [kind, index + 1]));
    expect(board.symbols[0]!.memberRows.every((row) => row.handles && row.ownershipProven)).toBe(true);
    expect(model.ownershipPath(`n${kinds.length - 1}`, 'n0')).toEqual(symbols.map((item) => item.id));
  });

  it('pages each expanded parent independently at six, retaining nested expansion on collapse', () => {
    const symbols = [node('root'), node('branch', 'root', 1),
      ...Array.from({ length: 9 }, (_, index) => node(`s${index}`, 'root', index + 10)),
      ...Array.from({ length: 9 }, (_, index) => node(`c${index}`, 'branch', index + 2))];
    const model = createBoardModel([...symbols].reverse(), []);
    const open = ['root', 'branch'];
    const outline = model.visibleOutline('root', ['root'], [], open);
    expect(outline.memberRows.filter((row) => row.depth === 1).map((row) => row.symbol.id)).toEqual(['branch', 's0', 's1', 's2', 's3', 's4']);
    expect(outline.memberRows.filter((row) => row.depth === 2).map((row) => row.symbol.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
    expect(outline.memberPages.root).toMatchObject({ total: 10, loaded: 10, shown: 6, remaining: 4, hasMore: true });
    expect(outline.memberPages.branch).toMatchObject({ total: 9, shown: 6, remaining: 3, hasMore: true });
    const more = model.visibleOutline('root', ['root'], [], open, { branch: 8 });
    expect(more.memberPages.root!.shown).toBe(6);
    expect(more.memberPages.branch!.shown).toBe(8);
    expect(model.visibleOutline('root', ['root'], [], ['branch']).memberRows).toEqual([]);
    expect(model.visibleOutline('root', ['root'], [], open).memberRows).toEqual(outline.memberRows);
    expect(open).toEqual(['root', 'branch']);
  });

  it('orders same-line declarations by indexed start column rather than alphabetically', () => {
    const model = createBoardModel([node('root'), node('a-last', 'root', 2, { startColumn: 30 }), node('z-first', 'root', 2, { startColumn: 5 })], []);
    expect(model.children('root').map((item) => item.id)).toEqual(['z-first', 'a-last']);
    expect(model.projectBoard(['root'], [], ['root']).symbols[0]!.memberRows.map((row) => row.symbol.id)).toEqual(['z-first', 'a-last']);
  });

  it('uses the deepest actually visible row as an endpoint, including nested pagination', () => {
    const model = nested();
    const project = (expanded: string[], limits = {}) => model.projectBoard(['root', 'peer'], [], expanded, 'calls', false, limits).edges[0]!;
    expect(project([]).sourceHandle).toBe('out');
    expect(project(['root']).sourceHandle).toBe('out-nested');
    expect(project(['root', 'nested']).sourceHandle).toBe('out-method');
    expect(project(['root', 'nested', 'method']).sourceHandle).toBe('out-parameter');
    expect(project(['root', 'nested', 'method'], { method: 0 }).sourceHandle).toBe('out-method');
    expect(project(['root', 'nested', 'method'], { nested: 0 }).sourceHandle).toBe('out-nested');
    const board = model.projectBoard(['root'], [], ['root', 'nested', 'method'], 'references');
    expect(board.edges[0]).toMatchObject({ source: 'root', target: 'root', sourceHandle: 'out-method', targetHandle: 'in-parameter' });
  });

  it('locates the exact nested row and breadcrumb without unbounded sibling expansion', () => {
    const symbols = [node('root'), node('branch', 'root', 100), node('target', 'branch', 200),
      ...Array.from({ length: 80 }, (_, index) => node(`a${index}`, 'root', index + 1)),
      ...Array.from({ length: 90 }, (_, index) => node(`b${index}`, 'branch', index + 101))];
    const model = createBoardModel(symbols, [edge('call', 'target', 'root')]);
    const limits = { root: 6, branch: 6 };
    const reveal = model.revealMember('target', 'root', [], limits);
    expect(reveal).toEqual({ path: ['root', 'branch', 'target'], expanded: ['root', 'branch'], limits, locatedMember: 'target' });
    const board = model.projectBoard(['root'], [], reveal.expanded, '', false, reveal.limits, { locatedMember: reveal.locatedMember });
    const item = board.symbols[0]!;
    expect(item.memberRows).toHaveLength(14); // Six ordinary siblings plus one path row per parent.
    expect(item.memberRows.filter((row) => row.located).map((row) => row.symbol.id)).toEqual(['target']);
    expect(item.locatedPath.map((symbol) => symbol.id)).toEqual(['root', 'branch', 'target']);
    expect(board.edges[0]!.sourceHandle).toBe('out-target');
    expect(limits).toEqual({ root: 6, branch: 6 });
    expect(model.revealMember('not-loaded', 'root', ['root'], limits).expanded).toEqual(['root']);
    expect(model.ownershipPath('target', 'unrelated')).toBeNull();
    expect(model.memberOf('target', 'root')).toBe('branch'); // Legacy API remains direct-only.
  });

  it('keeps contiguous member pages distinct from incidental loaded ancestry facts', () => {
    const items = [node('root', undefined, 1, { memberCount: 10_000, membersBounded: true }),
      ...Array.from({ length: 6 }, (_, index) => node(`p${index}`, 'root', index + 2)), node('far-target', 'root', 9999)];
    const model = createBoardModel(items, []);
    const state: BoardMemberPageState = { ids: items.slice(1, 7).map((item) => item.id), total: 10_000, nextOffset: 6 };
    const options = { memberPages: { root: state } };
    const ordinary = model.visibleOutline('root', ['root'], [], ['root'], {}, options);
    expect(ordinary.memberRows.map((row) => row.symbol.id)).not.toContain('far-target');
    expect(ordinary.memberPages.root).toMatchObject({ total: 10_000, loaded: 6, shown: 6, nextOffset: 6, bounded: true });
    const located = model.visibleOutline('root', ['root'], [], ['root'], {}, { ...options, locatedMember: 'far-target' });
    expect(located.memberRows.at(-1)).toMatchObject({ symbol: { id: 'far-target' }, located: true });
    expect(located.memberPages.root).toMatchObject({ loaded: 6, shown: 6, retained: 1, nextOffset: 6, remaining: 9994 });
    expect(state.ids).toHaveLength(6);
  });

  it('uses authoritative page totals and exposes loading, continuation and exclusions', () => {
    const model = createBoardModel([node('root', undefined, 1, { memberCount: 100 }), node('test', 'root', 2, { test: true }), node('normal', 'root', 3)], []);
    const outline = model.visibleOutline('root', ['root'], [], ['root'], {}, {
      tests: false, memberPages: { root: { ids: ['normal'], total: 1, nextOffset: null, loading: true, bounded: false } },
    });
    expect(outline.memberRows.map((row) => row.symbol.id)).toEqual(['normal']);
    expect(outline.memberPages.root).toMatchObject({ total: 1, shown: 1, loaded: 1, hasMore: false, loading: true, bounded: false });
    expect(model.visibleOutline('root', ['root'], [], ['root'], {}, { tests: false }).memberPages.root!.filtered).toBe(1);
  });

  it('prefers independently pinned nested cards without duplicate owner evidence or handles', () => {
    const model = nested();
    const board = model.projectBoard(['root', 'method', 'peer'], [], ['root', 'nested', 'method']);
    const root = board.symbols.find((item) => item.symbol.id === 'root')!;
    expect(root.memberRows.find((row) => row.symbol.id === 'method')).toMatchObject({ pinned: true, handles: false });
    expect(root.memberRows.find((row) => row.symbol.id === 'parameter')).toMatchObject({ handles: false });
    expect(board.symbols.find((item) => item.symbol.id === 'method')!.memberRows[0]).toMatchObject({ symbol: { id: 'parameter' }, handles: true });
    expect(board.edges.find((item) => item.evidence.some((fact) => fact.id === 'call'))).toMatchObject({ source: 'method', sourceHandle: 'out-parameter', target: 'peer' });
    expect(board.edges.flatMap((item) => item.evidence.map((fact) => fact.id)).sort()).toEqual(['call', 'within']);
    expect(model.projectBoard(['root', 'method', 'peer'], [], []).symbols.map((item) => item.symbol.id)).toEqual(['root', 'method', 'peer']);
  });

  it('anchors Restore on a hidden unpinned direct child, not its included owner', () => {
    const model = nested(); const included = ['root']; const hidden = ['nested'];
    expect(model.targetState('nested', included, hidden)).toEqual({ status: 'hidden', representative: 'nested' });
    expect(model.representative('nested', included, hidden)).toBeNull();
    const anchor = model.targetState('nested', included, hidden).representative;
    const restoredHidden = hidden.filter((id) => id !== anchor);
    expect(model.targetState('nested', included, restoredHidden)).toEqual({ status: 'visible', representative: 'root' });
    const board = model.projectBoard(included, restoredHidden, ['root']);
    expect(board.symbols.map((item) => item.symbol.id)).toEqual(['root']);
    expect(board.symbols[0]!.memberRows[0]).toMatchObject({ symbol: { id: 'nested' }, hidden: false, pinned: false, handles: true });
    expect(included).toEqual(['root']);
  });

  it('anchors Restore on the nearest hidden ancestor when several branches are hidden', () => {
    const model = nested(); const included = ['root'];
    expect(model.targetState('parameter', included, ['root', 'nested', 'method'])).toEqual({ status: 'hidden', representative: 'method' });
    expect(model.targetState('parameter', included, ['root', 'nested'])).toEqual({ status: 'hidden', representative: 'nested' });
    expect(model.targetState('parameter', included, ['root'])).toEqual({ status: 'hidden', representative: 'root' });
    expect(model.targetState('parameter', included, [])).toEqual({ status: 'visible', representative: 'root' });
    expect(model.browseConnections('peer', 'incoming', false, included, ['root', 'nested', 'method'])[0])
      .toMatchObject({ target: { id: 'parameter' }, status: 'hidden', representative: 'method' });
  });

  it('keeps independently pinned children and their folded descendants visible inside a hidden selected owner', () => {
    const model = nested(); const included = ['root', 'nested']; const hidden = ['root'];
    expect(model.targetState('nested', included, hidden)).toEqual({ status: 'visible', representative: 'nested' });
    expect(model.targetState('parameter', included, hidden)).toEqual({ status: 'visible', representative: 'nested' });
    expect(model.targetState('other', included, hidden)).toEqual({ status: 'hidden', representative: 'root' });
    expect(model.projectBoard(included, hidden, ['root', 'nested', 'method']).symbols.map((item) => item.symbol.id)).toEqual(['nested']);
    expect(model.browseConnections('peer', 'incoming', false, included, hidden)[0])
      .toMatchObject({ target: { id: 'parameter' }, status: 'visible', representative: 'nested' });
  });

  it('keeps a selected hidden owner as the Restore anchor for itself and its ordinary children', () => {
    const model = nested();
    expect(model.targetState('root', ['root'], ['root'])).toEqual({ status: 'hidden', representative: 'root' });
    expect(model.targetState('parameter', ['root'], ['root'])).toEqual({ status: 'hidden', representative: 'root' });
    expect(model.targetState('parameter', ['root', 'nested'], ['root', 'nested'])).toEqual({ status: 'hidden', representative: 'nested' });
  });

  it('retains a hidden branch Restore row, suppresses descendants, and restores without admitting neighbours', () => {
    const model = nested();
    const included = ['root', 'peer']; const hidden = ['nested']; const open = ['root', 'nested', 'method'];
    const board = model.projectBoard(included, hidden, open);
    expect(board.symbols[0]!.memberRows.map((row) => row.symbol.id)).toEqual(['nested', 'other']);
    expect(board.symbols[0]!.memberRows[0]).toMatchObject({ hidden: true, handles: false, expanded: false });
    expect(board.edges).toEqual([]);
    expect(model.targetState('parameter', included, hidden)).toEqual({ status: 'hidden', representative: 'nested' });
    expect(model.browseConnections('peer', 'incoming', false, included, hidden)[0]).toMatchObject({ status: 'hidden', representative: 'nested' });
    const restored = model.projectBoard(included, hidden.filter((id) => id !== 'nested'), open);
    expect(restored.symbols.map((item) => item.symbol.id)).toEqual(included);
    expect(restored.edges.find((item) => item.kind === 'calls')!.sourceHandle).toBe('out-parameter');
    expect(included).toEqual(['root', 'peer']); expect(hidden).toEqual(['nested']);
  });

  it('allows a pinned descendant to stay independent of a hidden ancestor', () => {
    const model = nested();
    const board = model.projectBoard(['root', 'parameter', 'peer'], ['nested'], ['root', 'nested', 'method']);
    expect(board.symbols.map((item) => item.symbol.id)).toEqual(['root', 'parameter', 'peer']);
    expect(board.edges).toHaveLength(1);
    expect(board.edges[0]).toMatchObject({ source: 'parameter', target: 'peer', sourceHandle: 'out' });
    expect(model.targetState('parameter', ['root', 'parameter'], ['nested'])).toMatchObject({ status: 'visible', representative: 'parameter' });
    const hiddenPin = model.projectBoard(['root', 'method', 'peer'], ['method'], ['root', 'nested', 'method']);
    expect(hiddenPin.symbols[0]!.memberRows.find((row) => row.symbol.id === 'method')).toMatchObject({ hidden: true, pinned: false, handles: false });
    expect(hiddenPin.edges).toEqual([]);
  });

  it('restores an exact hidden inline identity even when contains ownership is ambiguous', () => {
    const model = createBoardModel([node('first'), node('second'), node('shared'), node('peer')], [
      edge('a', 'first', 'shared', { kind: 'contains' }), edge('b', 'second', 'shared', { kind: 'contains' }),
      edge('call', 'shared', 'peer'),
    ]);
    const included = ['first']; const hidden = ['shared'];
    const outline = model.projectBoard(included, hidden, ['first']).symbols[0]!;
    expect(outline.memberRows[0]).toMatchObject({ symbol: { id: 'shared' }, hidden: true, pinned: false, ownershipProven: false });
    expect(model.targetState('shared', included, hidden)).toEqual({ status: 'hidden', representative: 'shared' });
    expect(model.browseConnections('peer', 'incoming', false, included, hidden)[0])
      .toMatchObject({ target: { id: 'shared' }, status: 'hidden', representative: 'shared' });
    const restored = model.projectBoard(included, [], ['first']);
    expect(restored.symbols.map((item) => item.symbol.id)).toEqual(['first']);
    expect(restored.symbols[0]!.memberRows[0]).toMatchObject({ hidden: false, pinned: false });
    expect(model.representative('shared', included, [])).toBeNull();
    expect(included).toEqual(['first']);
  });

  it('does not turn an unrelated hidden ancestor into board membership', () => {
    const model = nested();
    expect(model.targetState('parameter', ['peer'], ['nested'])).toEqual({ status: 'absent', representative: 'parameter' });
    expect(model.browseConnections('peer', 'incoming', false, ['peer'], ['nested'])[0]).toMatchObject({ status: 'absent' });
  });

  it('supports explicit contains membership without asserting ambiguous ownership', () => {
    const symbols = [node('first'), node('second'), node('shared')];
    const model = createBoardModel(symbols, [edge('a', 'first', 'shared', { kind: 'contains' }), edge('b', 'second', 'shared', { kind: 'contains' }),
      edge('duplicate-site', 'first', 'shared', { kind: 'contains' }), edge('call', 'shared', 'second')]);
    expect(model.children('first').map((item) => item.id)).toEqual(['shared']);
    expect(model.scopeIds('first', true)).toEqual(new Set(['first', 'shared']));
    const board = model.projectBoard(['first', 'second'], [], ['first', 'second']);
    for (const item of board.symbols) expect(item.memberRows[0]).toMatchObject({ symbol: { id: 'shared' }, ownershipProven: false, handles: false });
    expect(board.edges).toEqual([]);
    expect(model.representative('shared', ['first', 'second'], [])).toBeNull();
    expect(model.ownershipPath('shared', 'first')).toBeNull();
    const pinned = model.projectBoard(['first', 'second', 'shared'], [], ['first', 'second']);
    expect(pinned.edges).toHaveLength(1);
    expect(pinned.edges[0]).toMatchObject({ source: 'shared', target: 'second' });
  });

  it('shows shared direct children under both parents with explicit repeat boundaries', () => {
    const model = createBoardModel([node('root'), node('first', 'root', 2), node('second', 'root', 3), node('shared'), node('inside', 'shared')], [
      edge('a', 'first', 'shared', { kind: 'contains' }), edge('b', 'second', 'shared', { kind: 'contains' }),
    ]);
    const board = model.projectBoard(['root'], [], ['root', 'first', 'second', 'shared']);
    const rows = board.symbols[0]!.memberRows;
    expect(rows.filter((row) => row.symbol.id === 'shared').map((row) => [row.ownerId, row.reference, row.handles])).toEqual([
      ['first', false, false], ['second', true, false],
    ]);
    expect(rows.filter((row) => row.symbol.id === 'inside')).toHaveLength(1);
    expect(new Set(rows.map((row) => row.rowKey)).size).toBe(rows.length);
  });

  it('keeps Locate and handle ports on the proven path when another membership also lists a symbol', () => {
    const model = createBoardModel([node('root'), node('first', 'root', 2), node('second', 'root', 3), node('shared', 'second'), node('target', 'shared'), node('peer')], [
      edge('other-membership', 'first', 'shared', { kind: 'contains' }), edge('call', 'target', 'peer'),
    ]);
    const board = model.projectBoard(['root', 'peer'], [], ['root', 'first', 'second', 'shared'], 'calls', false, {}, { locatedMember: 'target' });
    const rows = board.symbols[0]!.memberRows;
    expect(rows.filter((row) => row.symbol.id === 'target')).toHaveLength(2);
    expect(rows.filter((row) => row.located)).toHaveLength(1);
    expect(rows.filter((row) => row.symbol.id === 'target' && row.handles)).toHaveLength(1);
    const actual = rows.find((row) => row.located)!;
    expect(rows.find((row) => row.rowKey === actual.parentRow)).toMatchObject({ symbol: { id: 'shared' }, ownerId: 'second', ownershipProven: true });
    expect(board.edges[0]!.sourceHandle).toBe('out-target');
  });

  it('accepts direct member IDs from /members without manufacturing contains evidence', () => {
    const model = createBoardModel([node('owner'), node('shared')], []);
    const options = { memberPages: { owner: { ids: ['shared'], total: 1, nextOffset: null } } };
    const board = model.projectBoard(['owner'], [], ['owner'], '', true, {}, options);
    expect(board.symbols[0]!.members.map((item) => item.id)).toEqual(['shared']);
    expect(board.symbols[0]!.memberRows[0]).toMatchObject({ ownerId: 'owner', depth: 1, ownershipProven: false, handles: false });
    expect(board.edges).toEqual([]);
    expect(model.children('owner', options).map((item) => item.id)).toEqual(['shared']);
    expect(model.children('owner')).toEqual([]);
    expect(model.ownershipPath('shared', 'owner')).toBeNull();
  });

  it('applies test/generated/uncertainty presets without removing explicit cards or changing selection', () => {
    const symbols = [node('root'), node('test', 'root', 2, { test: true }), node('generated', 'root', 3, { generated: true }), node('normal', 'root', 4), node('peer')];
    const relations = [edge('test-edge', 'test', 'peer'), edge('generated-edge', 'generated', 'peer'),
      edge('certain', 'normal', 'peer'), edge('weak', 'normal', 'peer', { confidence: 0.4 }), edge('name', 'normal', 'peer', { resolvedBy: 'name-only' })];
    const model = createBoardModel(symbols, relations); const included = ['root', 'test', 'peer'];
    const defaults = model.projectBoard(included, [], ['root']);
    expect(defaults.edges.flatMap((item) => item.evidence)).toHaveLength(5);
    const filtered = model.projectBoard(included, [], ['root'], '', false, {}, { tests: false, generated: false, uncertain: false });
    expect(filtered.symbols.map((item) => item.symbol.id)).toEqual(included);
    expect(filtered.edges.flatMap((item) => item.evidence.map((fact) => fact.id))).toEqual(['certain']);
    expect(filtered.symbols[0]!.memberRows.map((row) => row.symbol.id)).toEqual(['test', 'normal']); // Explicit pinned test identity remains visible.
    expect(filtered.symbols[0]!.memberPages.root).toMatchObject({ filtered: 2, retained: 1, total: 1 });
    expect(model.filterSymbols('', '', '', { tests: false, generated: false }).map((item) => item.id)).toEqual(['root', 'normal', 'peer']);
    expect(model.browseConnections('root', 'outgoing', true, included, [], '', '', { tests: false, generated: false, uncertain: false })[0]!.evidence.map((fact) => fact.id)).toEqual(['certain']);
    expect(included).toEqual(['root', 'test', 'peer']);
  });

  it('keeps hidden Restore rows and exact Locate paths reachable under exclusion presets', () => {
    const model = createBoardModel([node('root'), node('hidden', 'root', 2, { generated: true }), node('located', 'root', 3, { test: true })], []);
    const outline = model.visibleOutline('root', ['root'], ['hidden'], ['root'], {}, { tests: false, generated: false, locatedMember: 'located' });
    expect(outline.memberRows.map((row) => row.symbol.id)).toEqual(['hidden', 'located']);
    expect(outline.memberRows.every((row) => !row.handles)).toBe(true);
    expect(outline.memberRows[1]!.located).toBe(true);
  });

  it('treats only finite low-confidence or name-only evidence as uncertain', () => {
    expect(isBoardEvidenceUncertain(edge('a', 'a', 'b', { confidence: 0.59 }))).toBe(true);
    expect(isBoardEvidenceUncertain(edge('a', 'a', 'b', { resolvedBy: 'name-only' }))).toBe(true);
    for (const confidence of [undefined, 0.6, 1, NaN, Infinity, -Infinity, '0.1' as unknown as number]) {
      expect(isBoardEvidenceUncertain(edge('a', 'a', 'b', { confidence, provenance: 'heuristic' }))).toBe(false);
    }
  });

  it('deduplicates overlapping evidence pages while preserving kind, mechanism and uncertainty lanes', () => {
    const a = edge('a', 'a', 'b');
    const model = createBoardModel([node('a'), node('b')], [a, a, edge('b', 'a', 'b', { kind: 'references' }),
      edge('c', 'a', 'b', { synthesizedBy: 'callback' }), edge('d', 'a', 'b', { confidence: 0.3 })]);
    const board = model.projectBoard(['a', 'b'], [], []);
    expect(board.edges).toHaveLength(4);
    expect(board.edges.flatMap((item) => item.evidence.map((fact) => fact.id)).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(model.browseConnections('a', 'outgoing', false, [], [])[0]!.evidence).toHaveLength(4);
  });

  it('counts each undrawn self/pair evidence item once per representative', () => {
    const model = createBoardModel([node('root'), node('child', 'root'), node('peer')], [edge('within', 'root', 'child'), edge('other', 'child', 'peer'), edge('absent', 'child', 'not-loaded')]);
    const board = model.projectBoard(['root', 'peer'], [], [], 'references');
    expect(board.edges).toEqual([]);
    expect(board.symbols.map((item) => [item.symbol.id, item.undrawn])).toEqual([['root', 3], ['peer', 1]]);
  });

  it('terminates malformed ownership/contains cycles with explicit reference boundaries', () => {
    const model = createBoardModel([node('a', 'c'), node('b', 'a'), node('c', 'b'), node('self', 'self'), node('outside')], [
      edge('cycle', 'c', 'a', { kind: 'contains' }), edge('call', 'c', 'outside'),
    ]);
    expect(model.scopeIds('a', true)).toEqual(new Set(['a', 'b', 'c']));
    expect(model.representative('c', [], [])).toBeNull();
    expect(model.ownershipPath('c', 'outside')).toBeNull();
    const rows = model.projectBoard(['a', 'outside'], [], ['a', 'b', 'c']).symbols[0]!.memberRows;
    expect(rows.map((row) => row.symbol.id)).toEqual(['b', 'c', 'a']);
    expect(rows.at(-1)).toMatchObject({ reference: true, expanded: false, handles: false });
    expect(model.projectBoard(['self'], [], ['self']).symbols[0]!.memberRows[0]).toMatchObject({ reference: true, expanded: false, handles: false });
  });

  it('terminates contains-only and paged membership cycles without inventing ownership', () => {
    const model = createBoardModel([node('a'), node('b'), node('c')], [
      edge('ab', 'a', 'b', { kind: 'contains' }), edge('bc', 'b', 'c', { kind: 'contains' }), edge('ca', 'c', 'a', { kind: 'contains' }),
    ]);
    const board = model.projectBoard(['a'], [], ['a', 'b', 'c']);
    expect(board.symbols[0]!.memberRows.map((row) => row.symbol.id)).toEqual(['b', 'c', 'a']);
    expect(board.symbols[0]!.memberRows.at(-1)).toMatchObject({ reference: true, expanded: false });
    expect(board.symbols[0]!.memberRows.every((row) => !row.handles && !row.ownershipProven)).toBe(true);
    expect(model.scopeIds('a', true)).toEqual(new Set(['a', 'b', 'c']));
    expect(model.ownershipPath('c', 'a')).toBeNull();
    const paged = createBoardModel([node('a'), node('b')], []).projectBoard(['a'], [], ['a', 'b'], '', false, {}, {
      memberPages: { a: { ids: ['b'], total: 1 }, b: { ids: ['a'], total: 1 } },
    });
    expect(paged.symbols[0]!.memberRows.map((row) => row.symbol.id)).toEqual(['b', 'a']);
    expect(paged.symbols[0]!.memberRows.at(-1)).toMatchObject({ reference: true, expanded: false });
  });

  it('handles deep supplied slices iteratively instead of overflowing the JS stack', () => {
    const symbols = Array.from({ length: 5000 }, (_, index) => node(`n${index}`, index ? `n${index - 1}` : undefined, index));
    const model = createBoardModel(symbols, [edge('deep', 'n4999', 'n0')]);
    const board = model.projectBoard(['n0'], [], symbols.map((item) => item.id));
    expect(board.symbols[0]!.memberRows).toHaveLength(4999);
    expect(board.edges[0]).toMatchObject({ sourceHandle: 'out-n4999', targetHandle: 'in' });
    expect(model.ownershipPath('n4999', 'n0')).toHaveLength(5000);
  });

  it('indexes ownership and evidence instead of rescanning nodes/edges for each visible card', () => {
    let ownershipReads = 0; let edgeReads = 0;
    const symbols = Array.from({ length: 120 }, (_, index) => ({ ...node(`n${index}`), get ownerId() { ownershipReads++; return undefined; } }));
    const relations = Array.from({ length: 3000 }, (_, index) => ({ ...edge(`e${index}`, '', ''),
      get source() { edgeReads++; return `n${index % 120}`; }, get target() { edgeReads++; return `n${(index + 1) % 120}`; } }));
    const model = createBoardModel(symbols, relations);
    for (let index = 0; index < 120; index++) model.children(`n${index}`);
    const board = model.projectBoard(symbols.map((item) => item.id), [], [], 'references');
    expect(board.symbols).toHaveLength(120);
    expect(ownershipReads).toBeLessThan(120 * 4);
    expect(edgeReads).toBeLessThan(relations.length * 12);
  });

  it('sanitizes outline limits without accepting negative, NaN or infinite page sizes', () => {
    const model = createBoardModel([node('root'), ...Array.from({ length: 10 }, (_, index) => node(`n${index}`, 'root', index))], []);
    for (const limit of [-1, NaN, Infinity]) expect(model.visibleOutline('root', ['root'], [], ['root'], { root: limit }).memberRows).toHaveLength(6);
    expect(model.visibleOutline('root', ['root'], [], ['root'], { root: 0 }).memberRows).toEqual([]);
    expect(model.visibleOutline('root', ['root'], [], ['root'], { root: 2.9 }).memberRows).toHaveLength(2);
  });
});

describe('linear typed-edge lane mapping', () => {
  it('matches the old lane offsets for parallel, reverse and self edges without mutating input', () => {
    const edges = [
      { id: 'a', source: 'one', target: 'two' }, { id: 'b', source: 'one', target: 'two' }, { id: 'c', source: 'one', target: 'two' },
      { id: 'reverse', source: 'two', target: 'one' }, { id: 'self1', source: 'one', target: 'one' }, { id: 'self2', source: 'one', target: 'one' },
    ];
    const lanes = edgeLaneMap(Object.freeze(edges));
    expect([...lanes]).toEqual([['a', -56], ['b', 0], ['c', 56], ['reverse', 0], ['self1', 320], ['self2', 368]]);
    expect(edges.map((item) => item.id)).toEqual(['a', 'b', 'c', 'reverse', 'self1', 'self2']);
    expect(edgeLaneMap([]).size).toBe(0);
  });

  it('groups opaque endpoint IDs without delimiter collisions in a single pass', () => {
    let reads = 0;
    const edges = Array.from({ length: 4000 }, (_, index) => ({ id: `e${index}`,
      get source() { reads++; return index % 2 ? 'a:b' : 'a'; }, get target() { reads++; return index % 2 ? 'c' : 'b:c'; } }));
    const lanes = edgeLaneMap(edges);
    expect(lanes.size).toBe(4000);
    expect(lanes.get('e0')).toBe(lanes.get('e1'));
    expect(reads).toBeLessThanOrEqual(edges.length * 5);
  });
});
