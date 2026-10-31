import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { resurrectRefFromDroppedEdge } from '../src/resolution/resurrect-ref';
import type { Edge, Language, Node, UnresolvedReference } from '../src/types';

let root: string;
let db: DatabaseConnection;
let queries: QueryBuilder;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-span-pages-'));
  db = DatabaseConnection.initialize(path.join(root, 'graph.db'));
  queries = new QueryBuilder(db.getDb());
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function node(id: string, language: Language, name = id, kind: Node['kind'] = 'method'): Node {
  return { id, language, name, kind, qualifiedName: `Example::${id}`, filePath: `${id}.${language === 'vbnet' ? 'vb' : language === 'java' ? 'java' : 'cs'}`,
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, isExported: false };
}

describe('bounded .NET span invalidation queries', () => {
  it('advances through rejected name-index windows without broadening target eligibility', () => {
    queries.insertNodes([
      node('java-target', 'java', 'AsSpan'), node('class-target', 'csharp', 'AsSpan', 'class'),
      node('wrong-case', 'csharp', 'asspan'), node('cs-target', 'csharp', 'AsSpan'),
      node('vb-target', 'vbnet', 'aSsPaN'), node('other-target', 'csharp', 'Other'),
    ]);
    const prepare = vi.spyOn(db.getDb(), 'prepare');
    const first = queries.getDotnetSpanTargetsPage(0, 2);
    expect(first).toHaveLength(2);
    expect(first.map((row) => row.target)).toEqual([null, null]);
    let after = first.at(-1)!.cursor;
    const targets: string[] = [];
    for (;;) {
      const page = queries.getDotnetSpanTargetsPage(after, 2);
      if (page.length === 0) break;
      expect(page.length).toBeLessThanOrEqual(2);
      expect(page[0]!.cursor).toBeGreaterThan(after);
      after = page.at(-1)!.cursor;
      targets.push(...page.flatMap((row) => row.target === null ? [] : [row.target]));
    }
    expect(targets).toEqual(['cs-target', 'vb-target']);
    for (const id of ['cs-target', 'vb-target', 'wrong-case', 'java-target', 'class-target']) {
      expect(queries.hasDotnetSpanMethod(queries.getNodeById(id)!.filePath), id).toBe(id === 'cs-target' || id === 'vb-target');
    }
    const sql = prepare.mock.calls.find(([text]) => text.includes('SELECT rowid AS cursor'))![0];
    const plan = db.getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0, 2) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join('\n')).toMatch(/idx_nodes_lower_name.*rowid>/);
    expect(plan.some((row) => /TEMP B-TREE/.test(row.detail))).toBe(false);
  });

  it('pages target calls before filtering, preserves original refs, and progresses while deleting', () => {
    const target = node('target', 'csharp', 'AsSpan');
    const cs = node('cs-caller', 'csharp');
    const vb = node('vb-caller', 'vbnet');
    const java = node('java-caller', 'java');
    queries.insertNodes([target, cs, vb, java, node('other', 'csharp', 'Other')]);
    const edge = (source: string, line: number, extra: Partial<Edge> = {}): Edge => ({ source, target: target.id, kind: 'calls', line, column: 3,
      metadata: { refName: 'value.AsSpan', refKind: 'calls' }, ...extra });
    queries.insertEdges([
      edge(java.id, 1), edge(cs.id, 2, { provenance: 'heuristic' }),
      edge(cs.id, 3, { kind: 'contains' }), edge(cs.id, 7), edge(cs.id, 8, { metadata: undefined }),
      edge(vb.id, 9, { metadata: { refName: 'value.aSsPaN', refKind: 'references' } }), edge(cs.id, 10, { target: 'other' }),
    ]);
    const through = queries.getMaxEdgeId();
    queries.insertEdges([edge(cs.id, 11)]); // Outside this drain's fence.
    const prepare = vi.spyOn(db.getDb(), 'prepare');
    let after = 0;
    let emptyWindow = false;
    const refs: UnresolvedReference[] = [];
    for (;;) {
      const page = queries.getDotnetSpanCallsPage(target.id, after, through, 2);
      if (page.cursor === after) break;
      expect(page.cursor).toBeGreaterThan(after);
      expect(page.edges.length).toBeLessThanOrEqual(2);
      if (after === 0) {
        expect(page.edges).toEqual([]); // Java and heuristic calls, not exhaustion.
        emptyWindow = true;
      }
      after = page.cursor;
      const ids: number[] = [];
      const pending: UnresolvedReference[] = [];
      for (const record of page.edges) {
        const ref = resurrectRefFromDroppedEdge(record);
        if (ref) { ids.push(record.edgeId); pending.push(ref); }
      }
      queries.replaceResolutionEdgesWithUnresolvedRefs(ids, pending);
      refs.push(...pending);
    }
    expect(emptyWindow).toBe(true);
    expect(refs.map((ref) => [ref.referenceName, ref.referenceKind, ref.line, ref.column, ref.language, ref.filePath])).toEqual([
      ['value.AsSpan', 'calls', 7, 3, 'csharp', cs.filePath],
      ['value.aSsPaN', 'references', 9, 3, 'vbnet', vb.filePath],
    ]);
    const remaining = db.getDb().prepare('SELECT line FROM edges ORDER BY line').all() as Array<{ line: number }>;
    expect(remaining.map((row) => row.line)).toEqual([1, 2, 3, 8, 10, 11]);
    expect(queries.getUnresolvedReferencesCount()).toBe(2);
    const sql = prepare.mock.calls.find(([text]) => text.includes('SELECT id FROM edges INDEXED BY'))![0];
    const plan = db.getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(target.id, 0, through, 2) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join('\n')).toMatch(/idx_edges_target_kind.*rowid>/);
    expect(plan.some((row) => /TEMP B-TREE/.test(row.detail))).toBe(false);
  });

  it('bounds failed candidates, not matches, and retries whole segments with VB case folding', () => {
    queries.insertNodes([node('cs', 'csharp'), node('vb', 'vbnet'), node('java', 'java')]);
    const cases: Array<[Language, string, boolean, UnresolvedReference['referenceKind']?]> = [
      ['java', 'value.AsSpan', false], ['csharp', 'Unrelated', false], // A zero-match first page.
      ['csharp', 'value.AsSpan', true], ['csharp', 'AsSpan.Member', true, 'references'],
      ['csharp', 'value.AsSpan.Member', true, 'type_of'], ['csharp', 'AsSpan', true],
      ['vbnet', 'value.aSsPaN.Member', true, 'references'], ['vbnet', 'ASSPAN', true],
      ['csharp', 'value.asspan', false], ['csharp', 'value.AsSpanExtra', false],
      ['vbnet', 'value.MyAsSpan', false],
    ];
    queries.insertUnresolvedRefsBatch(cases.map(([language, referenceName, , referenceKind], i) => ({
      fromNodeId: language === 'csharp' ? 'cs' : language === 'vbnet' ? 'vb' : 'java', language,
      filePath: `${language}.source`, referenceName, referenceKind: referenceKind ?? 'calls', line: i + 1, column: 4,
    })));
    db.getDb().exec("UPDATE unresolved_refs SET status = 'failed'");
    queries.insertUnresolvedRefsBatch([{ fromNodeId: 'cs', language: 'csharp', filePath: 'cs.source',
      referenceName: 'alreadyPending.AsSpan', referenceKind: 'calls', line: 100, column: 6 }]);
    const before = db.getDb().prepare('SELECT * FROM unresolved_refs ORDER BY id').all() as Array<Record<string, unknown>>;
    const prepare = vi.spyOn(db.getDb(), 'prepare');
    let after = queries.reopenFailedDotnetSpanPage(0, 2);
    expect(after).toBe(before[1]!.id);
    expect(queries.getUnresolvedReferencesCount()).toBe(1); // Only the pre-existing pending ref.
    for (;;) {
      const cursor = queries.reopenFailedDotnetSpanPage(after, 2);
      if (cursor === after) break;
      expect(cursor).toBeGreaterThan(after);
      after = cursor;
    }
    const expected = before.map((row, i) => ({ ...row, status: i === cases.length || cases[i]![2] ? 'pending' : 'failed' }));
    expect(db.getDb().prepare('SELECT * FROM unresolved_refs ORDER BY id').all()).toEqual(expected);
    const sql = prepare.mock.calls.find(([text]) => text.includes('WITH candidates AS MATERIALIZED'))![0];
    const plan = db.getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0, 2) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join('\n')).toMatch(/idx_unresolved_status.*rowid>/);
  });
});
