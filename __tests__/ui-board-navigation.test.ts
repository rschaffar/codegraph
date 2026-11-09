import { describe, expect, it } from 'vitest';
import { boardConnectionDestinations, boardSourceDestination } from '../ui/src/lib/board-navigation';
import type { BoardRelation, BoardSymbol } from '../ui/src/lib/board-model';

const file: BoardSymbol = { id: 'file', name: 'a.ts', qualifiedName: 'a.ts', kind: 'file', file: 'a.ts', line: 1, endLine: 1000 };
const outer: BoardSymbol = { ...file, id: 'outer', name: 'Outer', qualifiedName: 'Outer', kind: 'class', ownerId: file.id, line: 10, endLine: 900 };
const inner: BoardSymbol = { ...outer, id: 'inner', name: 'Inner', qualifiedName: 'Outer.Inner', ownerId: outer.id, line: 20, endLine: 800 };
const method: BoardSymbol = { ...inner, id: 'method', name: 'run', qualifiedName: 'Outer.Inner.run', kind: 'method', ownerId: inner.id, line: 500, endLine: 600 };
const facts = [file, outer, inner, method];

describe('Board source navigation representatives', () => {
  it('prefers an existing individual card without changing open cards or ownership', () => {
    const open = [outer, method, inner];
    expect(boardSourceDestination(method, facts, open)).toEqual(method);
    expect(open).toEqual([outer, method, inner]);
    expect(method.ownerId).toBe(inner.id);
  });
  it('uses the nearest proven containing source rather than detaching the method', () => {
    expect(boardSourceDestination(method, facts, [outer, file, inner])).toEqual(inner);
    expect(boardSourceDestination(method, facts, [file, outer])).toEqual(outer);
  });
  it('finds a file card even when extraction has no top-level contains edge', () => {
    const free = { ...method, kind: 'function', ownerId: undefined };
    expect(boardSourceDestination(free, [free, file], [file])).toEqual(file);
  });
  it('retains independently proven exact-file source across partial/corrupt outer ownership', () => {
    const partial = { ...inner, file: 'other-part.ts' };
    expect(boardSourceDestination(method, [method, partial, file], [file])).toEqual(file);
    const cycle = { ...inner, ownerId: method.id };
    expect(boardSourceDestination(method, [method, cycle, file], [file])).toEqual(file);
  });
  it('does not infer a containing class from file/range overlap', () => {
    const free = { ...method, kind: 'function', ownerId: undefined };
    expect(boardSourceDestination(free, [free, inner], [inner])).toBeNull();
  });
  it('does not use another file, an invalid parent range or an ambiguous file card', () => {
    expect(boardSourceDestination(method, [method, { ...inner, file: 'elsewhere.ts' }], [inner])).toBeNull();
    expect(boardSourceDestination(method, [method, { ...inner, endLine: 550 }], [inner])).toBeNull();
    const free = { ...method, ownerId: undefined };
    const secondFile = { ...file, id: 'duplicate-file' };
    expect(boardSourceDestination(free, [free, file, secondFile], [file, secondFile])).toBeNull();
  });
  it('rejects cyclic or ambiguous identity facts instead of choosing an owner', () => {
    expect(boardSourceDestination(method, [method, { ...inner, ownerId: method.id }], [inner])).toBeNull();
    expect(boardSourceDestination(method, [...facts, inner], [inner])).toBeNull();
    expect(boardSourceDestination(method, [...facts, method], [method])).toBeNull();
  });
  it('does not match missing, renamed, overloaded or stale card identities', () => {
    expect(boardSourceDestination({ ...method, id: 'missing:method' }, facts, [method])).toBeNull();
    expect(boardSourceDestination(method, facts, [{ ...method, signature: '(other: string)' }])).toBeNull();
    expect(boardSourceDestination(method, facts, [{ ...inner, qualifiedName: 'Other.Inner' }])).toBeNull();
  });
  it('uses current verified ranges and refuses out-of-scope focus lines', () => {
    const moved = { ...method, line: 510, endLine: 610 };
    expect(boardSourceDestination(moved, [file, outer, inner, moved], [method], 520)).toEqual(moved);
    expect(boardSourceDestination(method, facts, [inner], 100)).toBeNull();
  });
});

describe('Board connection navigation choices', () => {
  const relation: BoardRelation = { id: 'group', source: outer.id, target: inner.id, sourceHandle: 'out', targetHandle: 'in', kind: 'calls', evidence: [
    { id: 'one', source: method.id, target: inner.id, kind: 'calls', file: method.file, line: 520, col: 4 },
    { id: 'repeat', source: method.id, target: inner.id, kind: 'calls', file: method.file, line: 520, col: 4 },
    { id: 'two', source: method.id, target: inner.id, kind: 'calls', file: method.file, line: 550, col: 8 },
  ] };
  it('requires a source-site choice instead of picking the first evidence item', () => {
    expect(boardConnectionDestinations(relation, 'source', facts).map(({ symbol, line, col }) => [symbol.id, line, col]))
      .toEqual([[method.id, 520, 4], [method.id, 550, 8]]);
  });
  it('uses a source arrow’s proven displayed scope/site for parameter and local-value origins', () => {
    const local = { ...method, id: 'local', kind: 'variable', ownerId: method.id, line: 505, endLine: 505 };
    const sourceArrow = { ...relation, source: `code:${inner.id}`, target: `code:${outer.id}`, sourceLine: 550,
      evidence: [{ id: 'local-call', source: local.id, target: outer.id, kind: 'calls', file: method.file, line: 550 }] };
    expect(boardConnectionDestinations(sourceArrow, 'source', [...facts, local])).toEqual([{ symbol: inner, file: inner.file, line: 550, col: undefined }]);
  });
  it('does not ask again for different call sites that all have the same target', () => {
    expect(boardConnectionDestinations(relation, 'target', facts)).toEqual([{ symbol: inner, file: inner.file, line: inner.line, col: undefined }]);
  });
  it('keeps distinct member targets and same-line occurrence columns', () => {
    const other = { ...method, id: 'other', qualifiedName: 'Outer.Inner.other' };
    const mixed = { ...relation, evidence: [...relation.evidence,
      { ...relation.evidence[0]!, id: 'other-target', target: other.id, col: 20 }] };
    expect(boardConnectionDestinations(mixed, 'source', [...facts, other])).toHaveLength(3);
    expect(boardConnectionDestinations(mixed, 'target', [...facts, other])).toHaveLength(2);
  });
  it('labels absent/untrusted occurrence locations as declaration fallbacks, never invented sites', () => {
    for (const site of [{ file: 'wrong.ts', line: 520 }, { file: method.file, line: 900 }, {}]) {
      const noSite = { ...relation, evidence: [{ id: 'unknown', source: method.id, target: inner.id, kind: 'future_relation', ...site }] };
      expect(boardConnectionDestinations(noSite, 'source', facts)[0]).toMatchObject({ symbol: method, line: undefined, col: undefined });
    }
  });
  it('does not offer unresolved or duplicate symbol identities as destinations', () => {
    expect(boardConnectionDestinations(relation, 'source', [inner])).toEqual([]);
    expect(boardConnectionDestinations(relation, 'target', [...facts, inner])).toEqual([]);
  });
});
