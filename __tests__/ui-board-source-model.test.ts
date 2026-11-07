import { describe, expect, it } from 'vitest';
import {
  BOARD_SOURCE_PAGE_LINES, boardSourceRange, boardSourceContinuation, boardSourceWithMembers,
  boardSourceForIdentity, boardSourceRefs, boardSourceEvidenceTitle, verifiedBoardSourceSymbol, boardSourceEvidenceComplete,
  BOARD_SOURCE_TARGET_PAGE, BOARD_SOURCE_EVIDENCE_PAGE, BOARD_SOURCE_AUTO_REQUESTS,
  boardSourceTarget, boardSourceApplyEvidence, boardSourceLoadReferences, boardSourceMergeExclusions, boardSourcePageProgress, type BoardSourceTarget,
} from '../ui/src/lib/board-source-model';
import type { BoardEvidence, BoardSymbol } from '../ui/src/lib/board-model';
import { tokensByLine, type Token } from '../ui/src/lib/highlight';
import { assignRefs } from '../ui/src/lib/symbol-model';
import type { WireSource } from '../ui/src/lib/wire';
import type { BoardEvidencePage, BoardExclusions } from '../ui/src/lib/board-wire';

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
  expected?: BoardSymbol; verified?: BoardSymbol | null; symbols?: BoardSymbol[]; tokens?: Map<number, Token[]>; evidenceComplete?: boolean;
} = {}) {
  return boardSourceRefs({ expected: owner, verified: owner, source: slice, symbols: [owner, member, target, other], evidenceComplete: true,
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

const noExclusions: BoardExclusions = {
  symbols: { tests: 0, generated: 0, uncertain: 0 }, relations: { tests: 0, generated: 0, uncertain: 0 },
};
function evidencePage(items: BoardEvidence[], total = items.length, nextOffset: number | null = null, bounded = false): BoardEvidencePage {
  return { items, total, nextOffset, bounded, symbols: [owner, member, target], notes: [], excluded: noExclusions };
}
function completeTargets(targets: BoardSourceTarget[], overrides = {}) {
  return boardSourceEvidenceComplete({ total: targets.length, nextOffset: null, bounded: false, loading: false,
    excluded: noExclusions, targets, ...overrides });
}

describe('Board source automatic reference paging', () => {
  it('automatically loads more than eight class targets, then replaces capped previews and pages their evidence', async () => {
    const count = BOARD_SOURCE_TARGET_PAGE + 9;
    const peers = Array.from({ length: count }, (_, i) => ({ ...target, id: `target:${i}`, name: `render${i}` }));
    const rows: BoardSourceTarget[] = [];
    const controller = new AbortController();
    const calls: string[] = [];
    let total: number | null = null;
    let nextOffset: number | null = null;
    let active = 0; let maxActive = 0;
    await boardSourceLoadReferences({ signal: controller.signal,
      state: () => ({ total, nextOffset, targets: rows }),
      targets: async (offset) => {
        maxActive = Math.max(maxActive, ++active);
        calls.push(`targets:${offset}`);
        expect(completeTargets(rows, { total: count, nextOffset: offset })).toBe(false);
        const page = peers.slice(offset, offset + BOARD_SOURCE_TARGET_PAGE);
        // The first Connections page is bounded because ONE target preview is capped.
        for (const peer of page) rows.push(boardSourceTarget({ target: peer,
          evidence: [evidence({ id: `preview:${peer.id}`, target: peer.id })],
          total: peer === peers[0] ? BOARD_SOURCE_EVIDENCE_PAGE + 1 : 1 }, offset === 0, noExclusions));
        total = count; nextOffset = offset + page.length < count ? offset + page.length : null;
        active--;
      },
      evidence: async (id) => {
        maxActive = Math.max(maxActive, ++active);
        const row = rows.find((item) => item.target.id === id)!;
        const offset = row.nextOffset!;
        calls.push(`${id}:${offset}`);
        const n = Math.min(BOARD_SOURCE_EVIDENCE_PAGE, row.total - offset);
        const items = Array.from({ length: n }, (_, i) => evidence({ id: `${id}:${offset + i}`, target: id }));
        boardSourceApplyEvidence(row, evidencePage(items, row.total, offset + n < row.total ? offset + n : null));
        active--;
      },
    });
    expect(calls.slice(0, 2)).toEqual(['targets:0', `targets:${BOARD_SOURCE_TARGET_PAGE}`]);
    expect(calls).toContain('target:0:0');
    expect(calls).toContain(`target:0:${BOARD_SOURCE_EVIDENCE_PAGE}`);
    expect(maxActive).toBe(1);
    expect(rows).toHaveLength(count);
    expect(completeTargets(rows)).toBe(true);
    expect(rows[0].evidence).toHaveLength(BOARD_SOURCE_EVIDENCE_PAGE + 1);
    expect(rows[0].evidence.some((edge) => edge.id.startsWith('preview:'))).toBe(false);
  });

  it('recovers preview bounds but never clears a hard scope/identity bound', () => {
    for (const hardBound of [false, true]) {
      const row = boardSourceTarget({ target, evidence: [evidence()], total: 1 }, true, noExclusions);
      expect(row.nextOffset).toBe(0); // Even a full-looking preview must be checked.
      expect(completeTargets([row])).toBe(false);
      boardSourceApplyEvidence(row, evidencePage([evidence()], 1, null, hardBound));
      expect(completeTargets([row])).toBe(!hardBound);
    }
    const row = boardSourceTarget({ target, evidence: [], total: 2 }, true, noExclusions);
    boardSourceApplyEvidence(row, evidencePage([evidence()], 2, 1, true));
    boardSourceApplyEvidence(row, evidencePage([evidence({ id: 'next' })], 2, null, false));
    expect(row.bounded).toBe(true);
    expect(completeTargets([row])).toBe(false);
  });

  it('waits for the late ambiguous candidate instead of making a prefix clickable', () => {
    const a = boardSourceTarget({ target, evidence: [evidence()], total: 1 }, false, noExclusions);
    const b = boardSourceTarget({ target: other, evidence: [], total: 1 }, true, noExclusions);
    expect(refs(a.evidence, source(), { evidenceComplete: completeTargets([a, b]) }).size).toBe(0);
    boardSourceApplyEvidence(b, evidencePage([evidence({ id: 'ambiguous', target: other.id })]));
    expect(completeTargets([a, b])).toBe(true);
    expect(refs([...a.evidence, ...b.evidence], source(), { evidenceComplete: completeTargets([a, b]) }).size).toBe(0);
  });

  it('preserves unknown or filtered exclusions across authoritative pages', () => {
    const filtered = { ...noExclusions, relations: { tests: 0, generated: 0, uncertain: 1 } };
    expect(boardSourceMergeExclusions(filtered, noExclusions)).toEqual(filtered);
    expect(boardSourceMergeExclusions(null, noExclusions)).toBeNull();
    for (const excluded of [undefined, filtered]) {
      const row = boardSourceTarget({ target, evidence: [], total: 1 }, true, noExclusions);
      boardSourceApplyEvidence(row, { ...evidencePage([evidence()]), excluded });
      expect(completeTargets([row])).toBe(false);
      expect(completeTargets([row], { filters: { tests: true, generated: true, uncertain: true } })).toBe(true);
    }
  });

  it('rejects inconsistent previews and does not mistake stalled target pages for completion', () => {
    for (const row of [
      { target, evidence: [evidence(), evidence()], total: 2 },
      { target, evidence: [evidence()], total: 0 },
      { target, evidence: [evidence({ target: other.id })], total: 1 },
    ]) expect(() => boardSourceTarget(row, false, noExclusions)).toThrow(/inconsistent/);
    expect(boardSourcePageProgress(0, 0, 0, null)).toBe(true);
    expect(boardSourcePageProgress(0, 0, 10, null)).toBe(false);
    expect(boardSourcePageProgress(0, 0, 10, 0)).toBe(false);
    expect(boardSourcePageProgress(0, 8, 10, 8)).toBe(true);
    expect(boardSourcePageProgress(8, 2, 10, null)).toBe(true);
    expect(boardSourcePageProgress(8, 2, 10, 10)).toBe(false);
    expect(boardSourcePageProgress(-1, 1, 0, null)).toBe(false);
  });

  it('refuses changed totals, repeated pages, stalled pages and wrong endpoints', () => {
    const row = boardSourceTarget({ target, evidence: [evidence()], total: 2 }, false, noExclusions);
    for (const page of [evidencePage([], 2, 1), evidencePage([evidence()], 2),
      evidencePage([evidence({ id: 'new' })], 3, 2), evidencePage([evidence({ id: 'new', target: other.id })], 2)]) {
      expect(() => boardSourceApplyEvidence(row, page)).toThrow(/changed|advance|overlap/);
      expect(row.evidence).toEqual([evidence()]);
      expect(completeTargets([row])).toBe(false);
    }
  });

  it('bounds automatic work and leaves larger scopes explicitly incomplete', async () => {
    let calls = 0;
    let total: number | null = null;
    let nextOffset: number | null = null;
    await boardSourceLoadReferences({ signal: new AbortController().signal,
      state: () => ({ total, nextOffset, targets: [] }),
      targets: async () => { calls++; total = 1_000_000; nextOffset = calls * BOARD_SOURCE_TARGET_PAGE; },
      evidence: async () => { throw new Error('Not reached'); },
    });
    expect(calls).toBe(BOARD_SOURCE_AUTO_REQUESTS);
    expect(boardSourceEvidenceComplete({ total, nextOffset, targets: [], bounded: false, loading: false, excluded: noExclusions })).toBe(false);
  });

  it('respects cancellation before/during a request and stops on errors or unavailable evidence', async () => {
    for (const before of [true, false]) {
      const controller = new AbortController();
      if (before) controller.abort();
      let calls = 0;
      await boardSourceLoadReferences({ signal: controller.signal,
        state: () => ({ total: null, nextOffset: null, targets: [] }),
        targets: async () => { calls++; controller.abort(); }, evidence: async () => { calls++; },
      });
      expect(calls).toBe(before ? 0 : 1);
    }
    const row = boardSourceTarget({ target, evidence: [], total: 1 }, true, noExclusions);
    let calls = 0;
    await boardSourceLoadReferences({ signal: new AbortController().signal,
      state: () => ({ total: 1, nextOffset: null, targets: [row] }),
      targets: async () => { throw new Error('Not reached'); },
      evidence: async () => { calls++; row.error = 'Evidence unavailable'; },
    });
    expect(calls).toBe(1);
    expect(completeTargets([row])).toBe(false);
  });
});

describe('Board source references use original indexed evidence', () => {
  it('requires every target/evidence page and no unknown filtered or capped candidates', () => {
    const row = { evidence: [evidence()], total: 1, nextOffset: null };
    const page = { total: 1, nextOffset: null, bounded: false, loading: false, targets: [row],
      excluded: { symbols: { tests: 0, generated: 0, uncertain: 0 }, relations: { tests: 0, generated: 0, uncertain: 0 } } };
    expect(boardSourceEvidenceComplete(page)).toBe(true);
    for (const change of [{ total: null }, { total: 2 }, { nextOffset: 1 }, { bounded: true }, { loading: true },
      { error: 'failed' }, { excluded: null }, { targets: [{ ...row, total: 2 }] }, { targets: [{ ...row, nextOffset: 1 }] },
      { targets: [{ ...row, loading: true }] }, { targets: [{ ...row, error: 'failed' }] }, { targets: [{ ...row, bounded: true }] },
      { excluded: { ...page.excluded, relations: { tests: 0, generated: 0, uncertain: 1 } } }]) {
      expect(boardSourceEvidenceComplete({ ...page, ...change }), JSON.stringify(change)).toBe(false);
    }
    expect(boardSourceEvidenceComplete({ ...page, excluded: null, filters: { tests: true, generated: true, uncertain: true } })).toBe(true);
  });

  it('does not infer unique targets from incomplete or unknown evidence', () => {
    expect(refs([evidence()], source(), { evidenceComplete: false }).size).toBe(0);
    expect(refs([evidence()], source(), { evidenceComplete: undefined }).size).toBe(0);
    expect(refs([evidence()], source(), { evidenceComplete: true }).size).toBe(1);
  });

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
    expect(refs([evidence()], source(), { symbols: [owner, { ...member, line: 20 }, target] }).size).toBe(0);
    expect(refs([evidence()], source(), { symbols: [owner, { ...member, endLine: 11 }, target] }).size).toBe(0);
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
