import { describe, expect, it } from 'vitest';
import { boardSourceDetachments, boardSourceDetachTargets } from '../ui/src/lib/board-source-detachments';
import type { BoardSymbol } from '../ui/src/lib/board-model';

const owner: BoardSymbol = {
  id: 'type:reader', kind: 'class', name: 'Reader', qualifiedName: 'Reader',
  file: 'src/reader.ts', line: 1, endLine: 40,
};
const member: BoardSymbol = {
  id: 'method:read', kind: 'method', name: 'read', qualifiedName: 'Reader.read',
  signature: 'read(input: string): string', file: owner.file,
  line: 4, endLine: 10, ownerId: owner.id,
};
const detach = (symbols: readonly BoardSymbol[] = [owner, member], open: readonly BoardSymbol[] = [owner, member]) =>
  boardSourceDetachments(symbols, open);

function expectSafeIntervals(symbols: readonly BoardSymbol[], open: readonly BoardSymbol[]): void {
  const rows = detach(symbols, open);
  for (const row of rows) {
    expect(row.anchorLine).toBe(row.member.line);
    if (!row.fold) continue;
    expect(Number.isSafeInteger(row.fold.start)).toBe(true);
    expect(Number.isSafeInteger(row.fold.end)).toBe(true);
    expect(row.fold.start).toBeGreaterThan(row.member.line);
    expect(row.fold.end).toBeLessThan(row.member.endLine!);
    expect(row.fold.start).toBeGreaterThan(row.owner.line);
    expect(row.fold.end).toBeLessThan(row.owner.endLine!);
    expect(row.fold.start).toBeLessThanOrEqual(row.fold.end);
    for (const other of rows) {
      if (other === row || other.owner.id !== row.owner.id || !other.fold) continue;
      expect(row.fold.end < other.fold.start || row.fold.start > other.fold.end).toBe(true);
    }
  }
}

describe('pure Board source auto-detachment identity', () => {
  it('derives folds for existing saved class/method cards without a detach action or new recipe state', () => {
    const saved = [structuredClone(owner), structuredClone(member)];
    expect(detach([owner, member], saved)).toEqual([{
      owner, member, anchorLine: 4,
      fold: { id: `source-detachment:${JSON.stringify([owner.id, member.id])}`, start: 5, end: 9, label: 'read' },
    }]);
    expect(detach()[0]!.owner).toBe(owner);
    expect(detach()[0]!.member).toBe(member);
  });

  it('uses fresh ranges, not saved line hints, with stable fold identity across shifts', () => {
    const freshOwner = { ...owner, line: 101, endLine: 140 };
    const freshMember = { ...member, line: 104, endLine: 110 };
    const [row] = detach([freshOwner, freshMember]);
    expect(row!.owner).toBe(freshOwner);
    expect(row!.member).toBe(freshMember);
    expect(row!.anchorLine).toBe(104);
    expect(row!.fold).toEqual({ ...detach()[0]!.fold, start: 105, end: 109 });
  });

  it.each(['id', 'name', 'qualifiedName', 'kind', 'file', 'signature'] as const)(
    'refuses changed %s identities on either the class or method', (field) => {
      for (const index of [0, 1]) {
        const symbols = [owner, member].map((item, i) => i === index ? { ...item, [field]: 'changed' } : item);
        expect(detach(symbols), `${index}:${field}`).toEqual([]);
      }
    },
  );

  it('does not normalize signature whitespace or acquire missing/ambiguous identities', () => {
    expect(detach([owner, { ...member, signature: 'read(input: string):\tstring' }])).toEqual([]);
    expect(detach([owner])).toEqual([]);
    expect(detach([member])).toEqual([]);
    expect(detach([owner, owner, member])).toEqual([]);
    expect(detach([owner, member, member])).toEqual([]);
    const missingOwner = { ...owner, id: 'missing:type' };
    const missingMember = { ...member, id: 'missing:method', ownerId: missingOwner.id };
    expect(detach([missingOwner, missingMember], [missingOwner, missingMember])).toEqual([]);
  });

  it.each([
    { line: 0 }, { line: 1.5 }, { line: NaN }, { line: Infinity },
    { endLine: undefined }, { endLine: -1 }, { endLine: 1.5 }, { endLine: Infinity },
  ])('rejects invalid fresh ranges %j', (range) => {
    expect(detach([owner, { ...member, ...range }])).toEqual([]);
    expect(detach([{ ...owner, ...range }, member])).toEqual([]);
  });

  it('pairs every class and method independent of card/fact order and deduplicates repeated open cards', () => {
    const next = { ...member, id: 'method:write', name: 'write', qualifiedName: 'Reader.write', line: 15, endLine: 20 };
    const otherOwner = { ...owner, id: 'type:other', name: 'Other', qualifiedName: 'Other', line: 45, endLine: 80 };
    const other = { ...member, id: 'method:other', ownerId: otherOwner.id, line: 50, endLine: 60 };
    const facts = [owner, member, next, otherOwner, other];
    const expected = detach(facts, facts);
    expect(expected.map((row) => [row.owner.id, row.member.id])).toEqual([
      [owner.id, member.id], [owner.id, next.id], [otherOwner.id, other.id],
    ]);
    expect(detach([...facts].reverse(), [...facts].reverse())).toEqual(expected);
    expect(detach(facts, [...facts, member, owner])).toEqual(expected);
    expectSafeIntervals(facts, facts);
  });

  it('restores all derived bytes by removing the separate method card, without mutating inputs', () => {
    const facts = Object.freeze([Object.freeze({ ...owner }), Object.freeze({ ...member })]);
    const cards = Object.freeze([...facts]);
    const before = JSON.stringify({ facts, cards });
    expect(detach(facts, cards)).toHaveLength(1);
    expect(detach(facts, [owner])).toEqual([]);
    expect(detach(facts, [member])).toEqual([]);
    expect(detach(facts, [])).toEqual([]);
    expect(detach(facts, cards)).toHaveLength(1);
    expect(JSON.stringify({ facts, cards })).toBe(before);
  });
});

describe('proven type containment only', () => {
  it.each(['class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'union', 'type_alias'])(
    'supports an indexed %s owner, including function-kind methods', (kind) => {
      const type = { ...owner, kind };
      const method = { ...member, kind: 'function' };
      expect(detach([type, method], [type, method])).toHaveLength(1);
    },
  );

  it.each(['file', 'module', 'namespace', 'function', 'component', 'future-container'])(
    'never treats a %s source card as a type source', (kind) => {
      const container = { ...owner, kind };
      expect(detach([container, member], [container, member])).toEqual([]);
    },
  );

  it('never infers membership from a qualified name, same file, or containing range', () => {
    const unowned = { ...member, ownerId: undefined };
    expect(detach([owner, unowned], [owner, unowned])).toEqual([]);
    const unrelated = { ...owner, id: 'type:unrelated' };
    expect(detach([owner, unrelated, member], [unrelated, member])).toEqual([]);
    const free = { ...member, kind: 'function', ownerId: 'file:reader' };
    expect(detach([owner, free], [owner, free])).toEqual([]);
  });

  it('does not detach from an open file card or let file metadata block a proven class fold', () => {
    const file = { ...owner, id: 'file:reader', kind: 'file', name: 'reader.ts' };
    const facts = [file, owner, member];
    expect(detach(facts, facts).map((row) => row.owner.id)).toEqual([owner.id]);
    expect(detach(facts, facts)[0]!.fold).toBeDefined();
    const parentedType = { ...owner, ownerId: file.id };
    expect(detach([file, parentedType, member], [file, parentedType, member])[0]!.fold).toBeDefined();
  });

  it('uses fresh ownership evidence instead of a saved ownerId hint', () => {
    const actualOwner = { ...owner, id: 'type:actual' };
    const fresh = { ...member, ownerId: actualOwner.id };
    expect(detach([actualOwner, fresh], [actualOwner, member])[0]!.member.ownerId).toBe(actualOwner.id);
    expect(detach([owner, actualOwner, fresh], [owner, member])).toEqual([]);
  });

  it('requires same-file, range-consistent ownership hops, not cross-file or partial range matches', () => {
    for (const changed of [
      { file: 'elsewhere.ts' }, { line: 41, endLine: 50 }, { line: 4, endLine: 41 },
    ]) {
      const invalid = { ...member, ...changed };
      expect(detach([owner, invalid], [owner, invalid])).toEqual([]);
    }
  });

  it('skips local functions and local methods instead of walking through their enclosing callable', () => {
    for (const kind of ['function', 'method']) {
      const local = { ...member, id: 'local', kind, line: 6, endLine: 8, ownerId: member.id };
      expect(detach([owner, member, local], [owner, local])).toEqual([]);
      // Locals are nevertheless legitimately part of the enclosing method fold.
      expect(detach([owner, member, local])[0]!.fold).toMatchObject({ start: 5, end: 9 });
    }
  });

  it('withholds missing/ambiguous ownership hops and rejects observed cycles', () => {
    const missing = { ...member, ownerId: 'unknown' };
    expect(detach([owner, missing], [owner, missing])).toEqual([]);
    for (const parent of [{ ...owner, ownerId: owner.id }, { ...owner, ownerId: member.id }]) {
      expect(detach([parent, member], [parent, member])).toEqual([]);
    }
    const intermediate = { ...owner, id: 'intermediate', line: 2, endLine: 30, ownerId: owner.id };
    const child = { ...member, ownerId: intermediate.id };
    expect(detach([owner, intermediate, intermediate, child], [owner, child])).toEqual([]);
  });

  it('detaches from every genuinely containing open type, retaining the actual immediate owner', () => {
    const inner = { ...owner, id: 'type:inner', name: 'Inner', line: 2, endLine: 30, ownerId: owner.id };
    const method = { ...member, ownerId: inner.id };
    const facts = [owner, inner, method];
    const rows = detach(facts, facts);
    expect(rows.map((row) => row.owner.id)).toEqual([owner.id, inner.id]);
    expect(rows.every((row) => row.member === method && row.member.ownerId === inner.id)).toBe(true);
    expect(rows.every((row) => row.fold?.start === 5 && row.fold.end === 9)).toBe(true);
    expect(rows[0]!.fold!.id).not.toBe(rows[1]!.fold!.id);
    expect(detach(facts, [owner, method]).map((row) => row.owner.id)).toEqual([owner.id]);
    expect(detach(facts, [inner, method]).map((row) => row.owner.id)).toEqual([inner.id]);
    expect(detach(facts, [owner, inner])).toEqual([]);
    expectSafeIntervals(facts, facts);
    const cyclic = { ...owner, ownerId: inner.id };
    expect(detach([cyclic, inner, method], [cyclic, inner, method])).toEqual([]);
  });

  it('does not jump a missing or inconsistent hop to an outer type', () => {
    const inner = { ...owner, id: 'type:inner', line: 2, endLine: 30, ownerId: 'missing-hop' };
    const method = { ...member, ownerId: inner.id };
    expect(detach([owner, inner, method], [owner, inner, method]).map((row) => row.owner.id)).toEqual([inner.id]);
    const invalidOuter = { ...owner, endLine: 20 };
    const connectedInner = { ...inner, ownerId: owner.id };
    expect(detach([invalidOuter, connectedInner, method], [invalidOuter, connectedInner, method]).map((row) => row.owner.id)).toEqual([inner.id]);
  });
});

describe('pure direct Detach candidate discovery', () => {
  const targets = (symbols: readonly BoardSymbol[] = [owner, member], open: readonly BoardSymbol[] = [owner]) =>
    boardSourceDetachTargets(symbols, open);

  it('discovers unopened methods from a class-only old saved identity using fresh indexed facts', () => {
    const saved = { ...owner, line: 900, endLine: undefined, ownerId: 'old-owner-hint' };
    const freshOwner = { ...owner, line: 101, endLine: 140 };
    const freshMember = { ...member, line: 104, endLine: 110 };
    const rows = targets([freshOwner, freshMember], [saved]);
    expect(rows).toEqual([{ owner: freshOwner, member: freshMember }]);
    expect(rows[0]!.owner).toBe(freshOwner);
    expect(rows[0]!.member).toBe(freshMember);
    expect(detach([freshOwner, freshMember], [saved])).toEqual([]);
  });

  it('leaves filtering already-open method cards to the caller and requires an open type', () => {
    expect(targets()).toEqual([{ owner, member }]);
    expect(targets([owner, member], [owner, member])).toEqual(targets());
    expect(targets([owner, member], [member])).toEqual([]);
    expect(targets([owner, member], [])).toEqual([]);
  });

  it.each(['class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'union', 'type_alias'])(
    'discovers function-kind callable members for an open %s', (kind) => {
      const type = { ...owner, kind };
      const method = { ...member, kind: 'function' };
      expect(targets([type, method], [type])).toEqual([{ owner: type, member: method }]);
    },
  );

  it.each(['file', 'module', 'namespace', 'function', 'component', 'future-container'])(
    'does not offer Detach on a non-type %s source card', (kind) => {
      const container = { ...owner, kind };
      expect(targets([container, member], [container])).toEqual([]);
    },
  );

  it.each(['id', 'name', 'qualifiedName', 'kind', 'file', 'signature'] as const)(
    'rejects a stale open type %s identity', (field) => {
      const stale = { ...owner, [field]: 'changed' };
      expect(targets([owner, member], [stale, member])).toEqual([]);
    },
  );

  it('requires exact signature whitespace and never promotes saved-only methods into facts', () => {
    const type = { ...owner, signature: 'class Reader<T>\n  extends Base' };
    expect(targets([type, member], [{ ...type, signature: 'class Reader<T> extends Base' }])).toEqual([]);
    expect(targets([owner], [owner, member])).toEqual([]);
    const fresh = { ...member, name: 'freshName', signature: 'fresh(): void' };
    expect(targets([owner, fresh], [owner, member])).toEqual([{ owner, member: fresh }]);
  });

  it('rejects missing and ambiguous owner/member IDs even when duplicate facts agree', () => {
    expect(targets([owner, owner, member])).toEqual([]);
    expect(targets([owner, member, member])).toEqual([]);
    expect(targets([member])).toEqual([]);
    const missingOwner = { ...owner, id: 'missing:type' };
    const missingMember = { ...member, ownerId: missingOwner.id };
    expect(targets([missingOwner, missingMember], [missingOwner])).toEqual([]);
    expect(targets([owner, { ...member, id: 'missing:method' }])).toEqual([]);
  });

  it('never guesses membership from names, source ranges, or same-file free functions', () => {
    const unrelatedType = { ...owner, id: 'other-type', name: 'Other', qualifiedName: 'Other' };
    const unrelated = { ...member, id: 'other-method', ownerId: unrelatedType.id };
    const unowned = { ...member, id: 'unowned', ownerId: undefined };
    const free = { ...member, id: 'free', kind: 'function', ownerId: 'file:reader' };
    const file = { ...owner, id: 'file:reader', kind: 'file' };
    const field = { ...member, id: 'field', kind: 'field' };
    expect(targets([owner, unrelatedType, unrelated, unowned, free, file, field])).toEqual([]);
    expect(targets([owner, unrelatedType, unrelated, member])).toEqual([{ owner, member }]);
  });

  it('excludes local callables directly owned by another callable or a value', () => {
    const value = { ...member, id: 'value', kind: 'property' };
    const locals = ['function', 'method'].flatMap((kind) => [member.id, value.id].map((ownerId) => ({
      ...member, id: `${kind}:${ownerId}:local`, kind, line: 6, endLine: 8, ownerId,
    })));
    expect(targets([owner, member, value, ...locals])).toEqual([{ owner, member }]);
  });

  it('validates every fresh range and same-file containment hop', () => {
    for (const range of [
      { line: 0 }, { line: 1.5 }, { line: NaN }, { line: Infinity },
      { endLine: undefined }, { endLine: -1 }, { endLine: 1.5 }, { endLine: Infinity },
    ]) {
      expect(targets([owner, { ...member, ...range }])).toEqual([]);
      expect(targets([{ ...owner, ...range }, member])).toEqual([]);
    }
    for (const changed of [
      { file: 'elsewhere.ts' }, { line: 41, endLine: 50 }, { line: 4, endLine: 41 },
    ]) expect(targets([owner, { ...member, ...changed }])).toEqual([]);
  });

  it('withholds missing/ambiguous ownership hops and all observed cycles', () => {
    expect(targets([owner, { ...member, ownerId: 'unknown' }])).toEqual([]);
    const inner = { ...owner, id: 'inner', line: 2, endLine: 30, ownerId: owner.id };
    const method = { ...member, ownerId: inner.id };
    expect(targets([owner, inner, inner, method], [owner, inner])).toEqual([]);
    for (const parent of [{ ...owner, ownerId: owner.id }, { ...owner, ownerId: member.id }]) {
      expect(targets([parent, member], [parent])).toEqual([]);
    }
    const cyclic = { ...owner, ownerId: inner.id };
    expect(targets([cyclic, inner, method], [cyclic, inner])).toEqual([]);
  });

  it('offers a nested type member on every containing open type, even if its own type is not open', () => {
    const inner = { ...owner, id: 'inner', name: 'Inner', line: 2, endLine: 30, ownerId: owner.id };
    const method = { ...member, ownerId: inner.id };
    const facts = [owner, inner, method];
    expect(targets(facts)).toEqual([{ owner, member: method }]);
    const rows = targets(facts, [inner, owner]);
    expect(rows).toEqual([{ owner, member: method }, { owner: inner, member: method }]);
    expect(rows.every((row) => row.member === method && row.member.ownerId === inner.id)).toBe(true);
    expect(targets(facts, [inner])).toEqual([{ owner: inner, member: method }]);
  });

  it('does not jump a missing, cross-file, or range-inconsistent hop to an outer type', () => {
    for (const changed of [{ ownerId: 'missing-hop' }, { file: 'elsewhere.ts' }, { endLine: 45 }]) {
      const inner = { ...owner, id: 'inner', line: 2, endLine: 30, ownerId: owner.id, ...changed };
      const method = { ...member, file: inner.file, ownerId: inner.id };
      expect(targets([owner, inner, method], [owner, inner])).toEqual([{ owner: inner, member: method }]);
    }
  });

  it('preserves existing ancestor coverage for a type declared inside a callable', () => {
    const outerMethod = { ...member, endLine: 30 };
    const inner = { ...owner, id: 'inner', line: 6, endLine: 20, ownerId: outerMethod.id };
    const innerMethod = { ...member, id: 'inner:method', line: 8, endLine: 15, ownerId: inner.id };
    expect(targets([owner, outerMethod, inner, innerMethod], [owner, inner])).toEqual([
      { owner, member: outerMethod }, { owner, member: innerMethod }, { owner: inner, member: innerMethod },
    ]);
  });

  it('keeps one/two-line methods and methods whose interiors cannot safely fold', () => {
    for (const endLine of [4, 5]) {
      const short = { ...member, endLine };
      expect(targets([owner, short])).toEqual([{ owner, member: short }]);
    }
    const overlap = { ...member, id: 'overlap', line: 8, endLine: 15 };
    const unrelated = { ...member, id: 'unknown-field', kind: 'field', line: 6, endLine: 7, ownerId: undefined };
    const facts = [owner, member, overlap, unrelated];
    expect(targets(facts)).toEqual([{ owner, member }, { owner, member: overlap }]);
    expect(detach(facts, [owner, member, overlap]).every((row) => !row.fold)).toBe(true);
  });

  it('returns unique source-ordered pairs independent of input order without mutating either input', () => {
    const next = { ...member, id: 'next', line: 15, endLine: 20 };
    const earlyColumn = { ...next, id: 'z-early', startColumn: 2 };
    const lateColumn = { ...next, id: 'a-late', startColumn: 8 };
    const otherOwner = { ...owner, id: 'other-type', file: 'src/z.ts' };
    const other = { ...member, id: 'other-method', file: otherOwner.file, ownerId: otherOwner.id };
    const facts = Object.freeze([other, lateColumn, owner, member, earlyColumn, otherOwner].map((item) => Object.freeze(item)));
    const cards = Object.freeze([otherOwner, owner, owner, member].map((item) => Object.freeze({ ...item })));
    const before = JSON.stringify({ facts, cards });
    const rows = targets(facts, cards);
    expect(rows).toEqual([
      { owner, member }, { owner, member: earlyColumn }, { owner, member: lateColumn },
      { owner: otherOwner, member: other },
    ]);
    expect(targets([...facts].reverse(), [...cards].reverse())).toEqual(rows);
    expect(JSON.stringify({ facts, cards })).toBe(before);
  });
});

describe('safe original-line fold intervals', () => {
  it.each([
    ['typescript', 'reader.ts', ['class Reader { read() {', '  first();', '  second();', '} }']],
    ['csharp', 'Reader.cs', ['class Reader { void Read() {', '  First();', '  Second();', '} }']],
    ['python', 'reader.py', ['class Reader:', '  def read(self):', '    first()', '    second()']],
  ])('preserves declaration boundary lines for %s without language heuristics', (language, file, lines) => {
    const type = { ...owner, file, language, endLine: lines.length };
    const method = { ...member, file, language, line: language === 'python' ? 2 : 1, endLine: lines.length };
    const rows = detach([type, method], [type, method]);
    const fold = rows[0]!.fold!;
    expect(fold).toMatchObject({ start: method.line + 1, end: method.endLine - 1 });
    const visible = lines.filter((_, i) => i + 1 < fold.start || i + 1 > fold.end);
    expect(visible).toContain(lines[0]);
    expect(visible).toContain(lines[method.line - 1]);
    expect(visible).toContain(lines[lines.length - 1]);
    expectSafeIntervals([type, method], [type, method]);
  });

  it('keeps one/two-line methods as anchor-only ownership entries, never invalid or zero-width folds', () => {
    for (const endLine of [4, 5]) {
      const short = { ...member, endLine };
      expect(detach([owner, short], [owner, short])).toEqual([{ owner, member: short, anchorLine: 4 }]);
    }
    const threeLine = { ...member, endLine: 6 };
    expect(detach([owner, threeLine], [owner, threeLine])[0]!.fold).toMatchObject({ start: 5, end: 5 });
    const sameLineType = { ...owner, line: 4, endLine: 4 };
    const sameLine = { ...member, endLine: 4 };
    expect(detach([sameLineType, sameLine], [sameLineType, sameLine])[0]!.fold).toBeUndefined();
  });

  it('preserves shared method boundaries and class opening/closing lines', () => {
    const type = { ...owner, endLine: 9 };
    const a = { ...member, line: 1, endLine: 5 };
    const b = { ...member, id: 'method:b', line: 5, endLine: 9 };
    const facts = [type, a, b];
    expect(detach(facts, facts).map((row) => row.fold && [row.fold.start, row.fold.end])).toEqual([[2, 4], [6, 8]]);
    expectSafeIntervals(facts, facts);
  });

  it('withholds folds hiding an unrelated declaration, including a method whose card is not open', () => {
    const overlap = { ...member, id: 'method:overlap', line: 8, endLine: 15 };
    const facts = [owner, member, overlap];
    expect(detach(facts)[0]!.fold).toBeUndefined();
    const rows = detach(facts, facts);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.fold)).toBe(true);
    expect(detach([...facts].reverse(), [...facts].reverse())).toEqual(rows);
    const unrelatedField = { ...member, id: 'field', kind: 'field', line: 6, endLine: undefined };
    expect(detach([owner, member, unrelatedField])[0]!.fold).toBeUndefined();
    expectSafeIntervals(facts, facts);
  });

  it('allows proven parameters/local declarations inside a method, not unknown-owner lookalikes', () => {
    const local = { ...member, id: 'variable:local', kind: 'variable', line: 6, endLine: 7, ownerId: member.id };
    const parameter = { ...local, id: 'parameter', kind: 'parameter', line: 4, endLine: 4 };
    expect(detach([owner, member, local, parameter])[0]!.fold).toBeDefined();
    expect(detach([owner, member, { ...local, ownerId: undefined }])[0]!.fold).toBeUndefined();
    expect(detach([owner, member, { ...local, file: 'another.ts', ownerId: undefined }])[0]!.fold).toBeDefined();
  });

  it('withholds overlapping nested-method folds on an outer card, without losing the inner card fold', () => {
    const outerMethod = { ...member, endLine: 30 };
    const inner = { ...owner, id: 'inner', line: 6, endLine: 20, ownerId: outerMethod.id };
    const innerMethod = { ...member, id: 'inner:method', line: 8, endLine: 15, ownerId: inner.id };
    const facts = [owner, outerMethod, inner, innerMethod];
    const rows = detach(facts, facts);
    expect(rows.filter((row) => row.owner.id === owner.id).map((row) => row.fold)).toEqual([undefined, undefined]);
    expect(rows.find((row) => row.owner.id === inner.id)!.fold).toMatchObject({ start: 9, end: 14 });
    expectSafeIntervals(facts, facts);
    expect(detach([...facts].reverse(), [...facts].reverse())).toEqual(rows);
  });
});
