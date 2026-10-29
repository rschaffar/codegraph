import { describe, expect, it } from 'vitest';
import {
  BOARD_SOURCE_PAGE_LINES, boardSourceRange, boardSourceContinuation, boardSourceWithMembers,
  boardSourceForIdentity, boardSourceRefs, boardSourceEvidenceTitle, verifiedBoardSourceSymbol,
} from '../ui/src/lib/board-source-model';
import type { BoardEvidence, BoardSymbol } from '../ui/src/lib/board-model';
import { tokensByLine, type Token } from '../ui/src/lib/highlight';
import { assignRefs } from '../ui/src/lib/symbol-model';
import type { WireSource } from '../ui/src/lib/wire';

const owner: BoardSymbol = { id: 'class:one', kind: 'class', name: 'Container', qualifiedName: 'Container', file: 'src/one.ts', line: 10, endLine: 900 };
const member: BoardSymbol = { id: 'method:one', kind: 'method', name: 'read', qualifiedName: 'Container.read', file: owner.file, line: 12, endLine: 30, ownerId: owner.id };
const target: BoardSymbol = { id: 'function:target', kind: 'function', name: 'render', qualifiedName: 'Renderer.render', file: 'src/two.ts', line: 8, endLine: 12 };
const other: BoardSymbol = { ...target, id: 'method:other', qualifiedName: 'Other.render' };
function source(overrides: Partial<WireSource> = {}): WireSource {
  return { file: owner.file, language: 'typescript', drift: false, showing: 'indexed', contentHash: 'matching', indexedAt: 1,
    generated: false, totalLines: 1000, from: 12, to: 12, lines: ['  object.render();'], ...overrides };
}
function evidence(overrides: Partial<BoardEvidence> = {}): BoardEvidence {
  return { id: 'edge:one', source: member.id, target: target.id, kind: 'calls', file: owner.file, line: 12, col: 2, ...overrides };
}
function refs(edges: BoardEvidence[] = [evidence()], slice = source(), overrides: {
  expected?: BoardSymbol; verified?: BoardSymbol | null; symbols?: BoardSymbol[]; tokens?: Map<number, Token[]>;
} = {}) {
  return boardSourceRefs({ expected: owner, verified: owner, source: slice, symbols: [owner, member, target, other],
    evidence: edges, tokens: tokensByLine(slice.lines ?? [], slice.from ?? 1, slice.highlight), ...overrides });
}

describe('Board source identity and bounded reading', () => {
  it('uses only the current exact identity and range, never the cached range', () => {
    const fresh = { ...owner, line: 50, endLine: 1000 };
    expect(verifiedBoardSourceSymbol(owner, [fresh])).toBe(fresh);
    expect(boardSourceRange(fresh)).toEqual({ from: 50, to: 449 });
    for (const field of ['id', 'name', 'qualifiedName', 'kind', 'file', 'signature'] as const) {
      expect(verifiedBoardSourceSymbol(owner, [{ ...owner, [field]: 'different' }]), field).toBeNull();
    }
    expect(verifiedBoardSourceSymbol({ ...owner, signature: '()' }, [owner])).toBeNull();
    expect(verifiedBoardSourceSymbol(owner, [])).toBeNull();
    expect(verifiedBoardSourceSymbol(owner, [owner, owner])).toBeNull();
    expect(verifiedBoardSourceSymbol({ ...owner, id: 'missing:one' }, [{ ...owner, id: 'missing:one' }])).toBeNull();
    expect(verifiedBoardSourceSymbol(owner, [{ ...owner, endLine: undefined }])).toBeNull();
  });

  it('does not show cached bytes under a changed, missing or ambiguous identity', () => {
    const slice = source();
    expect(boardSourceForIdentity(owner, owner, slice)).toBe(slice);
    expect(boardSourceForIdentity({ ...owner, file: 'another.ts' }, owner, slice)).toBeNull();
    expect(boardSourceForIdentity(owner, verifiedBoardSourceSymbol(owner, [owner, owner]), slice)).toBeNull();
    expect(boardSourceForIdentity(owner, null, slice)).toBeNull();
    expect(boardSourceForIdentity(owner, owner, source({ file: 'another.ts' }))).toBeNull();
    // Current drifted bytes remain readable, but cannot acquire graph markings.
    const current = source({ drift: true, showing: 'current' });
    expect(boardSourceForIdentity(owner, owner, current)).toBe(current);
    expect(refs([evidence()], current).size).toBe(0);
  });

  it('offers pages after 400 lines and lands evidence focus without enlarging requests', () => {
    expect(boardSourceRange(owner)).toEqual({ from: 10, to: 409 });
    expect(boardSourceRange(owner, { highlight: 850 })).toEqual({ from: 810, to: 900 });
    expect(boardSourceRange(owner, { from: 410 })).toEqual({ from: 410, to: 809 });
    expect(boardSourceRange(owner, { highlight: 2 })).toEqual({ from: 10, to: 409 });
    expect(boardSourceRange(owner, { current: true, highlight: 850 })).toEqual({ from: 1, to: 400 });
    expect(boardSourceRange(owner, { current: true, from: 401 })).toEqual({ from: 401, to: 800 });
    const slice = source({ from: 410, lines: Array(400).fill('') });
    expect(boardSourceContinuation(owner, slice)).toEqual({ previous: 10, next: 810 });
    expect(boardSourceContinuation(owner, source({ from: 810, lines: Array(91).fill('') }))).toEqual({ previous: 410, next: null });
    expect(boardSourceContinuation(owner, source({ from: 401, lines: Array(400).fill('') }), true)).toEqual({ previous: 1, next: 801 });
    expect(boardSourceContinuation(owner, source({ from: 12, lines: ['one', 'two'], truncated: true }))).toEqual({ previous: 10, next: 14 });
    expect(boardSourceContinuation(owner, source({ from: 401, lines: [], totalLines: 100, showing: 'current', drift: true }), true)).toEqual({ previous: 1, next: null });
    expect(BOARD_SOURCE_PAGE_LINES).toBe(400);
  });

  it('uses contained scopes for types/containers but not individual callables', () => {
    for (const kind of ['file', 'module', 'namespace', 'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'union', 'type_alias', 'component']) {
      expect(boardSourceWithMembers({ ...owner, kind }), kind).toBe(true);
    }
    expect(boardSourceWithMembers({ ...owner, kind: 'method', memberCount: 10 })).toBe(false);
    expect(boardSourceWithMembers({ ...owner, kind: 'function', memberCount: 10 })).toBe(false);
    expect(boardSourceWithMembers({ ...owner, kind: 'future-container', memberCount: 1 })).toBe(true);
    expect(boardSourceWithMembers({ ...owner, kind: 'constant' })).toBe(false);
  });
});

describe('Board source references use original indexed evidence', () => {
  it('reuses SourceBlock matching and preserves the original expression column', () => {
    const found = refs().get(12)!;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ ident: 'render', col: 2, targetId: target.id, outside: false });
    const tokens = tokensByLine(source().lines!, 12, undefined).get(12)!;
    const assigned = assignRefs(tokens, found);
    expect([...assigned].map(([index, ref]) => [tokens[index].text, ref.targetId])).toEqual([['render', target.id]]);
  });

  it('never overlays drifted, non-indexed, mismatched or unverified source', () => {
    for (const patch of [{ drift: true }, { showing: 'current' as const }, { showing: 'none' as const }, { file: 'another.ts' }, { lines: undefined }]) {
      expect(refs([evidence()], source(patch)).size).toBe(0);
    }
    expect(refs([evidence()], source(), { verified: null }).size).toBe(0);
    expect(refs([evidence()], source(), { expected: { ...owner, signature: 'new' } }).size).toBe(0);
  });

  it('requires a real source file/line, an indexed target and a proven contained origin', () => {
    for (const patch of [{ file: undefined }, { file: 'another.ts' }, { line: undefined }, { line: 0 }, { line: 950 }, { line: 12.5 }, { source: 'not-a-member' }, { target: 'not-indexed' }]) {
      expect(refs([evidence(patch)]).size, JSON.stringify(patch)).toBe(0);
    }
    expect(refs([evidence()], source(), { symbols: [owner, { ...member, file: 'another.ts' }, target] }).size).toBe(0);
    const nested = { ...member, id: 'nested', ownerId: member.id };
    expect(refs([evidence({ source: nested.id })], source(), { symbols: [owner, member, nested, target] }).size).toBe(1);
    expect(refs([evidence({ source: nested.id })], source(), { expected: member, verified: member, symbols: [member, nested, target] }).size).toBe(0);
    expect(refs([evidence()], source(), { symbols: [owner, { ...member, ownerId: member.id }, target] }).size).toBe(0);
  });

  it('matches exact tokens only, never substrings, comments or strings', () => {
    expect(refs([evidence()], source({ lines: ['prerender();'] })).size).toBe(0);
    for (const [kind, name] of [['file', 'example.render'], ['route', '/path.render'], ['file', 'render']] as const) {
      expect(refs([evidence()], source(), { symbols: [owner, member, { ...target, kind, name }] }).size).toBe(0);
    }
    for (const cls of ['comment', 'string'] as const) {
      const slice = source({ lines: ['render'], highlight: { engine: 'tree-sitter', grammar: 'typescript', classes: [cls], lines: [[[0, 'render']]] } });
      expect(refs([evidence({ col: 0 })], slice).size).toBe(0);
    }
  });

  it('refuses missing-column repetition and same-site target ambiguity rather than guessing', () => {
    const repeated = source({ lines: ['a.render(b.render());'] });
    expect(refs([evidence({ col: undefined })], repeated).size).toBe(0);
    expect(refs([evidence({ col: 100 })], repeated).size).toBe(0);
    expect(refs([evidence({ col: -1 })], repeated).size).toBe(0);
    expect(refs([evidence(), evidence({ id: 'other', target: other.id })]).size).toBe(0);
    const separate = refs([evidence({ col: 0 }), evidence({ id: 'other', target: other.id, col: 9 })], repeated).get(12)!;
    const tokens = tokensByLine(repeated.lines!, 12, undefined).get(12)!;
    expect([...assignRefs(tokens, separate)].map(([, ref]) => ref.targetId)).toEqual([target.id, other.id]);
    expect(refs([evidence({ col: undefined })]).get(12)?.[0].col).toBeNull();
  });

  it('keeps every relation kind and mixed provenance in titles, without claiming calls', () => {
    const edges = ['imports', 'contains', 'returns', 'type_of', 'navigates', 'future_kind'].map((kind) => evidence({ id: kind, kind,
      provenance: 'heuristic', synthesizedBy: 'bridge', via: 'registration', registeredAt: 'src/wiring.ts:20', confidence: .4, resolvedBy: 'name-match' }));
    const found = refs(edges).get(12)!;
    expect(found).toHaveLength(1);
    expect(found[0].uncertain).toBe(true);
    for (const edge of edges) expect(found[0].title).toContain(`${edge.kind} ${target.qualifiedName}`);
    expect(found[0].title).toContain('provenance heuristic');
    expect(found[0].title).toContain('wired at src/wiring.ts:20');
    expect(found[0].title).toContain('uncertain');
    expect(found[0].title).not.toContain('calls');
    const mixed = refs([...edges, evidence({ id: 'sure', kind: 'references', confidence: 1 })]).get(12)!;
    expect(mixed[0].uncertain).toBe(false);
    expect(mixed[0].title).toContain('references');
    expect(refs([evidence({ resolvedBy: 'name-only', confidence: 1 })]).get(12)?.[0].uncertain).toBe(true);
    expect(boardSourceEvidenceTitle(evidence({ kind: 'contains', file: undefined }), target)).toContain('no indexed source location');
  });
});
