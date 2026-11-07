import { describe, expect, it } from 'vitest';
import { boardSourceRelations, boardSiblingSourceCapacity } from '../ui/src/lib/board-source-relations';
import type { BoardSymbol, BoardEvidence } from '../ui/src/lib/board-model';
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
      source: 'code:fn', target: 'code:method', sourceHandle: 'source-out', targetHandle: 'source-in', kind: 'calls', evidence: [evidence],
    })]);
    expect(boardSourceRelations(symbols, [evidence], [fn.id])).toEqual([]);
    expect(boardSourceRelations(symbols, [evidence], [])).toEqual([]);
  });
  it('prefers an open method to its open class; aggregates only to proven owners', () => {
    expect(boardSourceRelations(symbols, [edge()], [cls.id, fn.id, target.id, method.id])[0]).toMatchObject({ source: 'code:fn', target: 'code:method' });
    expect(boardSourceRelations(symbols, [edge()], [cls.id, target.id])[0]).toMatchObject({ source: 'code:class', target: 'code:target' });
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
    expect(result).toHaveLength(4);
    expect(result[0].evidence).toHaveLength(2);
    expect(result.find((item) => item.via === 'callback')?.evidence[0].id).toBe('synth');
    expect(boardSourceRelations(symbols, edges, [fn.id, method.id], 'references').map((item) => item.kind)).toEqual(['references']);
    expect(boardSourceRelations(symbols, [edge({ target: fn.id })], [fn.id])[0]).toMatchObject({ source: 'code:fn', target: 'code:fn' });
    const cycle = symbols.map((item) => item.id === cls.id ? { ...item, ownerId: fn.id } : item);
    expect(boardSourceRelations(cycle, [edge()], ['absent'])).toEqual([]);
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
    } finally { cg?.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe('bulk sibling source capacity', () => {
  it('reuses existing sources and admits the entire batch or none', () => {
    const existing = Array.from({ length: 32 }, (_, i) => `fn${i}`);
    expect(boardSiblingSourceCapacity(existing, ['fn0', 'fn1'], [])).toBeNull();
    expect(boardSiblingSourceCapacity(existing, ['new'], [])).toContain('32 source cards');
    const retained = Array.from({ length: 128 }, (_, i) => `id${i}`);
    expect(boardSiblingSourceCapacity(['id0'], ['id1'], retained)).toBeNull();
    expect(boardSiblingSourceCapacity([], ['new'], retained)).toContain('128 retained identities');
  });
});
