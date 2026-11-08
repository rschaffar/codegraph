import { describe, expect, it } from 'vitest';
import { boardSourceAnchors, boardSourceHandleId, boardSourceRelations, boardSiblingSourceCapacity } from '../ui/src/lib/board-source-relations';
import { createBoardModel, edgeLaneMap, type BoardSymbol, type BoardEvidence, type BoardRelation } from '../ui/src/lib/board-model';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CodeGraph from '../src/index';
import { buildBoard, buildBoardSearch } from '../src/ui-server/api/board';

const cls: BoardSymbol = { id: 'class', name: 'Owner', qualifiedName: 'Owner', kind: 'class', file: 'one.ts', line: 1, endLine: 100 };
const fn: BoardSymbol = { ...cls, id: 'fn', name: 'run', qualifiedName: 'Owner.run', kind: 'method', line: 10, endLine: 30, ownerId: cls.id };
const param: BoardSymbol = { ...fn, id: 'param', name: 'input', kind: 'parameter', endLine: 10, ownerId: fn.id };
const target: BoardSymbol = { ...cls, id: 'target', name: 'Target', qualifiedName: 'Target', file: 'two.ts' };
const method: BoardSymbol = { ...fn, id: 'method', file: target.file, ownerId: target.id };
const field: BoardSymbol = { ...fn, id: 'field', kind: 'field', ownerId: cls.id };
const symbols = [cls, fn, param, target, method, field];
const edge = (patch: Partial<BoardEvidence> = {}): BoardEvidence => ({ id: 'edge', source: fn.id, target: method.id, kind: 'calls', file: fn.file, line: 15, ...patch });

describe('independent source-card relationships', () => {
  it('connects only code endpoints and preserves exact evidence/kind', () => {
    const evidence = edge();
    expect(boardSourceRelations(symbols, [evidence], [fn.id, method.id])).toEqual([expect.objectContaining({
      source: 'code:fn', target: 'code:method', sourceLine: 15, targetLine: 10,
      sourceHandle: boardSourceHandleId('outgoing', 15), targetHandle: boardSourceHandleId('incoming', 10), kind: 'calls', evidence: [evidence],
    })]);
    expect(boardSourceRelations(symbols, [evidence], [fn.id])).toEqual([]);
    expect(boardSourceRelations(symbols, [evidence], [])).toEqual([]);
  });
  it('prefers an open method to its open class; aggregates only to proven owners', () => {
    expect(boardSourceRelations(symbols, [edge()], [cls.id, fn.id, target.id, method.id])[0]).toMatchObject({ source: 'code:fn', target: 'code:method' });
    expect(boardSourceRelations(symbols, [edge()], [cls.id, target.id])[0]).toMatchObject({
      source: 'code:class', target: 'code:target', sourceLine: 15, targetLine: method.line,
      targetHandle: boardSourceHandleId('incoming', method.line),
    });
    expect(boardSourceRelations(symbols.map((item) => item.id === fn.id ? { ...item, ownerId: undefined } : item), [edge()], [cls.id, target.id])).toEqual([]);
  });
  it('includes parameter and return types, but not imports, containment or class-header/field dependencies', () => {
    const evidence = [edge({ id: 'parameter', source: param.id, target: target.id, kind: 'type_of', line: 10 }),
      edge({ id: 'return', target: target.id, kind: 'returns', line: 10 })];
    expect(boardSourceRelations(symbols, evidence, [fn.id, target.id]).map((item) => item.kind)).toEqual(['type_of', 'returns']);
    for (const kind of ['imports', 'exports', 'contains']) expect(boardSourceRelations(symbols, [edge({ kind })], [fn.id, method.id])).toEqual([]);
    for (const source of [cls.id, field.id, 'unknown']) expect(boardSourceRelations(symbols, [edge({ source })], [cls.id, target.id])).toEqual([]);
    for (const patch of [{ file: 'wrong.ts' }, { line: 1 }, { line: 50 }, { line: 15.5 }]) expect(boardSourceRelations(symbols, [edge(patch)], [fn.id, method.id])).toEqual([]);
  });
  it('preserves mixed kinds, uncertainty, synthesized evidence, cycles and deduplication', () => {
    const edges = [edge(), edge(), edge({ id: 'other-site', line: 20 }), edge({ id: 'ref', kind: 'references' }),
      edge({ id: 'guess', confidence: .3 }), edge({ id: 'synth', synthesizedBy: 'callback' })];
    const result = boardSourceRelations(symbols, edges, [fn.id, method.id]);
    expect(result).toHaveLength(5);
    expect(result[0].evidence).toEqual([edges[0]]);
    expect(result.filter((item) => item.kind === 'calls').map((item) => item.sourceLine)).toEqual([15, 20, 15, 15]);
    expect(result.find((item) => item.via === 'callback')?.evidence[0].id).toBe('synth');
    expect(boardSourceRelations(symbols, edges, [fn.id, method.id], 'references').map((item) => item.kind)).toEqual(['references']);
    expect(boardSourceRelations(symbols, [edge({ target: fn.id })], [fn.id])[0]).toMatchObject({ source: 'code:fn', target: 'code:fn' });
    const cycle = symbols.map((item) => item.id === cls.id ? { ...item, ownerId: fn.id } : item);
    expect(boardSourceRelations(cycle, [edge()], ['absent'])).toEqual([]);
  });
});

describe('precise source sites and ownership ranges', () => {
  it('withholds line arrows without actual file/line evidence, even with synthesis metadata', () => {
    const patches: Partial<BoardEvidence>[] = [
      { file: undefined }, { file: '' }, { line: undefined }, { line: NaN }, { line: Infinity },
      { line: 0 }, { line: -1 }, { line: 15.5 }, { line: Number.MAX_SAFE_INTEGER + 1 },
      { line: undefined, synthesizedBy: 'callback', registeredAt: 'one.ts:15' },
    ];
    for (const patch of patches) expect(boardSourceRelations(symbols, [edge(patch)], [fn.id, method.id])).toEqual([]);
    for (const line of [fn.line, fn.endLine!]) expect(boardSourceRelations(symbols, [edge({ line })], [fn.id, method.id])[0].sourceLine).toBe(line);
  });

  it('checks both the callable and nearest chosen source card file/range without falling back', () => {
    const cases: [string, Partial<BoardSymbol>, string[]][] = [
      [cls.id, { file: 'other.ts' }, [cls.id, target.id]],
      [cls.id, { endLine: 14 }, [cls.id, target.id]],
      [cls.id, { line: 16 }, [cls.id, target.id]],
      [fn.id, { endLine: 14 }, [cls.id, target.id]],
      [fn.id, { line: 16 }, [cls.id, target.id]],
      [fn.id, { line: NaN }, [fn.id, method.id]],
      [fn.id, { endLine: Infinity }, [fn.id, method.id]],
      [param.id, { file: 'other.ts' }, [param.id, fn.id, method.id]],
      [param.id, { endLine: 14 }, [param.id, fn.id, method.id]],
    ];
    for (const [id, patch, open] of cases) {
      const facts = symbols.map((item) => item.id === id ? { ...item, ...patch } : item);
      expect(boardSourceRelations(facts, [edge({ source: id === param.id ? param.id : fn.id })], open)).toEqual([]);
    }
  });

  it('lands at the original method declaration within a target class, never its header', () => {
    const other: BoardSymbol = { ...method, id: 'other-method', line: 60, endLine: 80 };
    const relations = boardSourceRelations([...symbols, other], [edge(), edge({ id: 'other', target: other.id })], [cls.id, target.id]);
    expect(relations.map((item) => [item.sourceLine, item.targetLine, item.targetHandle])).toEqual([
      [15, 10, boardSourceHandleId('incoming', 10)], [15, 60, boardSourceHandleId('incoming', 60)],
    ]);
    expect(boardSourceAnchors(relations, target.id).map((item) => item.line)).toEqual([10, 60]);
    for (const patch of [{ file: 'partial.ts' }, { line: 101 }, { line: 0 }, { line: NaN }, { line: 10.5 }]) {
      const facts = symbols.map((item) => item.id === method.id ? { ...item, ...patch } : item);
      expect(boardSourceRelations(facts, [edge()], [cls.id, target.id])).toEqual([]);
    }
    for (const patch of [{ file: 'partial.ts' }, { line: 11 }, { endLine: 9 }, { endLine: NaN }]) {
      const facts = symbols.map((item) => item.id === target.id ? { ...item, ...patch } : item);
      expect(boardSourceRelations(facts, [edge()], [cls.id, target.id])).toEqual([]);
    }
    expect(boardSourceRelations(symbols, [edge({ target: 'missing' })], [cls.id, target.id])).toEqual([]);
  });

  it('keeps lines, columns, original endpoints, kinds and provenance distinct with stable IDs', () => {
    const alias: BoardSymbol = { ...method, id: 'same-line-target' };
    const edges = [edge(), edge({ id: 'same-site' }), edge({ id: 'line', line: 16 }),
      edge({ id: 'col1', col: 1 }), edge({ id: 'col2', col: 2 }),
      edge({ id: 'source', source: param.id }), edge({ id: 'target', target: alias.id }),
      edge({ id: 'kind', kind: 'references' }), edge({ id: 'provenance', provenance: 'heuristic' }),
      edge({ id: 'via', via: 'callback' }), edge({ id: 'uncertain', resolvedBy: 'name-only' })];
    const facts = [...symbols, alias];
    const open = [cls.id, target.id];
    const result = boardSourceRelations(facts, edges, open);
    expect(result).toHaveLength(edges.length - 1);
    expect(result[0].evidence).toEqual(edges.slice(0, 2));
    expect(new Set(result.map((item) => item.id)).size).toBe(result.length);
    expect(boardSourceRelations(facts, [...edges].reverse(), [...open].reverse()).map((item) => item.id).sort())
      .toEqual(result.map((item) => item.id).sort());
  });

  it('does not mutate discovery facts, open sources, evidence or symbol membership', () => {
    const facts = Object.freeze(symbols.map((item) => Object.freeze({ ...item })));
    const evidence = Object.freeze([Object.freeze(edge())]);
    const open = Object.freeze([cls.id, target.id]);
    const included = Object.freeze([cls.id]);
    const model = createBoardModel(facts, evidence);
    const before = model.projectBoard(included, [], []);
    expect(boardSourceRelations(facts, evidence, open)).toHaveLength(1);
    expect(model.projectBoard(included, [], [])).toEqual(before);
    expect(included).toEqual([cls.id]);
    expect(open).toEqual([cls.id, target.id]);
  });
});

describe('source anchor descriptors and lanes', () => {
  it('deduplicates each direction/line independently, including both ends of a self-edge', () => {
    const relations = boardSourceRelations(symbols, [edge(), edge({ id: 'ref', kind: 'references' }),
      edge({ id: 'loop', target: fn.id, line: 10 }), edge({ id: 'reverse', source: method.id, target: fn.id, file: method.file, line: 20 })], [fn.id, method.id]);
    expect(boardSourceAnchors(relations, fn.id)).toEqual([
      { id: boardSourceHandleId('incoming', 10), line: 10, direction: 'incoming' },
      { id: boardSourceHandleId('outgoing', 10), line: 10, direction: 'outgoing' },
      { id: boardSourceHandleId('outgoing', 15), line: 15, direction: 'outgoing' },
    ]);
    expect(boardSourceAnchors(relations, method.id)).toEqual([
      { id: boardSourceHandleId('incoming', 10), line: 10, direction: 'incoming' },
      { id: boardSourceHandleId('outgoing', 20), line: 20, direction: 'outgoing' },
    ]);
    expect(boardSourceAnchors(relations, 'missing')).toEqual([]);
    expect(boardSourceAnchors([...relations].reverse(), fn.id)).toEqual(boardSourceAnchors(relations, fn.id));
  });

  it('never exposes symbol-layer, cross-layer or unlocated ports', () => {
    const relation = boardSourceRelations(symbols, [edge()], [fn.id, method.id])[0];
    const invalid: BoardRelation[] = [
      { ...relation, source: fn.id, target: method.id },
      { ...relation, target: method.id }, { ...relation, source: fn.id },
      { ...relation, sourceLine: undefined, targetLine: undefined },
      { ...relation, sourceLine: 0, targetLine: Infinity },
    ];
    expect(boardSourceAnchors(invalid, fn.id)).toEqual([]);
    expect(boardSourceAnchors(invalid, method.id)).toEqual([]);
  });

  it('optionally groups lanes by ports without changing default lanes or self-edge routing', () => {
    const edges = [
      { id: 'a', source: 'a', target: 'b', sourceHandle: 'out:10', targetHandle: 'in:20' },
      { id: 'b', source: 'a', target: 'b', sourceHandle: 'out:30', targetHandle: 'in:20' },
      { id: 'c', source: 'a', target: 'b', sourceHandle: 'out:10', targetHandle: 'in:20' },
      { id: 'd', source: 'a', target: 'b', sourceHandle: 'out:10', targetHandle: 'in:40' },
      { id: 'loop1', source: 'a', target: 'a', sourceHandle: 'out:10', targetHandle: 'in:20' },
      { id: 'loop2', source: 'a', target: 'a', sourceHandle: 'out:30', targetHandle: 'in:20' },
      { id: 'loop3', source: 'a', target: 'a', sourceHandle: 'out:10', targetHandle: 'in:20' },
    ];
    expect([...edgeLaneMap(edges)]).toEqual([
      ['a', -84], ['b', -28], ['c', 28], ['d', 84], ['loop1', 320], ['loop2', 368], ['loop3', 416],
    ]);
    expect(edgeLaneMap(edges, false)).toEqual(edgeLaneMap(edges));
    expect(edgeLaneMap(edges, true)).toEqual(new Map([
      ['a', -28], ['b', 0], ['c', 28], ['d', 0], ['loop1', 320], ['loop2', 320], ['loop3', 368],
    ]));
    expect(edgeLaneMap([{ id: 'no-handles', source: 'a', target: 'b' }], true).get('no-handles')).toBe(0);
  });
});

describe('real indexed callable type relationships', () => {
  it('projects real C# signature type references onto source-only cards without inventing edge kinds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'board-source-types-'));
    let cg: CodeGraph | undefined;
    try {
      writeFileSync(join(root, 'Example.cs'), 'public class Payload {}\npublic class Worker {\n public Payload Read(Payload input) { return input; }\n}\n');
      cg = CodeGraph.initSync(root, { config: { include: ['*.cs'], exclude: [] } });
      await cg.indexAll(); cg.resolveReferences();
      const read = buildBoardSearch(cg, new URLSearchParams({ q: 'Read', kind: 'method' })).items[0];
      const payload = buildBoardSearch(cg, new URLSearchParams({ q: 'Payload', kind: 'class' })).items[0];
      expect(read).toBeDefined(); expect(payload).toBeDefined();
      const snapshot = buildBoard(cg, new URLSearchParams({ ids: JSON.stringify([read.id, payload.id]) }));
      const arrows = boardSourceRelations(snapshot.symbols, snapshot.relations, [read.id, payload.id]);
      // C# currently records signature uses as references, not returns/type_of.
      // Preserve that actual evidence rather than synthesizing more precise kinds.
      expect(arrows.map((item) => item.kind)).toContain('references');
      expect(arrows.flatMap((item) => item.evidence).some((item) => item.file === 'Example.cs' && item.line === 3)).toBe(true);
      expect(arrows.every((item) => item.source === `code:${read.id}` && item.target === `code:${payload.id}`)).toBe(true);
      expect(arrows.every((item) => item.sourceLine === 3 && item.targetLine === 1 &&
        item.sourceHandle === boardSourceHandleId('outgoing', 3) && item.targetHandle === boardSourceHandleId('incoming', 1))).toBe(true);
      expect(arrows.flatMap((item) => item.evidence).every((item) => snapshot.relations.includes(item))).toBe(true);
    } finally { cg?.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe('bulk sibling source capacity', () => {
  it('reuses existing sources and admits the entire batch or none', () => {
    const existing = Array.from({ length: 32 }, (_, i) => `fn${i}`);
    expect(boardSiblingSourceCapacity(existing, ['fn0', 'fn1'], [])).toBeNull();
    expect(boardSiblingSourceCapacity(existing, ['new'], [])).toBeNull();
    const retained = Array.from({ length: 128 }, (_, i) => `id${i}`);
    expect(boardSiblingSourceCapacity(retained, retained, retained)).toBeNull();
    expect(boardSiblingSourceCapacity(['id0'], ['id1'], retained)).toBeNull();
    expect(boardSiblingSourceCapacity([], ['new'], retained)).toContain('128 retained identities');
    expect(boardSiblingSourceCapacity(['id0'], ['new', 'new'], retained.slice(0, 127))).toBeNull();
    expect(boardSiblingSourceCapacity(['id0'], ['new', 'another'], retained.slice(0, 127))).toContain('128 retained identities');
  });
});
