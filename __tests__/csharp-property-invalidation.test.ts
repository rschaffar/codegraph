import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { ExtractionOrchestrator } from '../src/extraction';
import { resurrectRefFromDroppedEdge } from '../src/resolution/resurrect-ref';
import type { Edge, Language, Node, UnresolvedReference } from '../src/types';

let root: string, db: DatabaseConnection, queries: QueryBuilder;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-property-pages-'));
  db = DatabaseConnection.initialize(path.join(root, 'graph.db'));
  queries = new QueryBuilder(db.getDb());
});
afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const node = (id: string, language: Language = 'csharp', kind: Node['kind'] = 'method'): Node => ({
  id, language, kind, name: id, qualifiedName: `Demo::${id}`, filePath: `${id}.source`,
  startLine: 1, endLine: 2, startColumn: 0, endColumn: 1, isExported: false,
});
function setupEdges() {
  queries.insertNodes([node('cs'), node('java', 'java'), node('target', 'csharp', 'property')]);
  const edge = (source: string, line: number, metadata?: Edge['metadata']): Edge => ({ source, target: 'target', kind: 'references', line, column: 4, metadata });
  queries.insertEdges([
    edge('java', 1), edge('cs', 2),
    edge('cs', 3, { refName: 'holder.State.Current', refKind: 'property_ref', typeFrom: ['Types.cs'] }),
    edge('cs', 4, { refName: 'other.Current', refKind: 'property_ref', typeFrom: ['Other.cs'] }),
  ]);
}

describe('bounded C# property maintenance', () => {
  it('compares qualified declaration identity and multiplicity, not names or positions', () => {
    const first = { ...node('one', 'csharp', 'interface'), name: 'IState', qualifiedName: 'Demo::IState', filePath: 'Types.cs' };
    queries.insertNodes([first]);
    const original = queries.getCsharpLookupShapeByFiles(['Types.cs']);
    queries.updateNode({ ...first, startLine: 20, endLine: 30, signature: 'changed body' });
    expect(queries.getCsharpLookupShapeByFiles(['Types.cs'])).toEqual(original);
    queries.insertNodes([{ ...first, id: 'nearer', qualifiedName: 'Client::IState' }]);
    const qualified = queries.getCsharpLookupShapeByFiles(['Types.cs']);
    expect(qualified.size).toBe(2);
    queries.insertNodes([{ ...first, id: 'duplicate', startLine: 40 }]);
    expect([...queries.getCsharpLookupShapeByFiles(['Types.cs']).values()].sort()).toEqual([1, 2]);
    queries.insertNodes([node('method'), node('non-csharp', 'java', 'class')]);
    expect(queries.getCsharpLookupShapeByFiles(['Types.cs'])).not.toEqual(original);
  });

  it('advances examined edge windows through zero matches and preserves occurrence identity', () => {
    setupEdges();
    const prepare = vi.spyOn(db.getDb(), 'prepare');
    const first = queries.getCsharpPropertyTypeEdgesPage(['Types.cs'], 0, 2);
    expect(first.edges).toEqual([]);
    expect(first.cursor).toBeGreaterThan(0);
    const second = queries.getCsharpPropertyTypeEdgesPage(['Types.cs'], first.cursor, 2);
    expect(second.edges).toHaveLength(1);
    const ref = resurrectRefFromDroppedEdge(second.edges[0]!)!;
    expect(ref).toMatchObject({ fromNodeId: 'cs', referenceName: 'holder.State.Current', referenceKind: 'property_ref', line: 3, column: 4, filePath: 'cs.source', language: 'csharp' });
    queries.replaceResolutionEdgesWithUnresolvedRefs([second.edges[0]!.edgeId], [ref]);
    expect(queries.getCsharpPropertyTypeEdgesPage(['Types.cs'], second.cursor, 2).cursor).toBe(second.cursor);
    const sql = prepare.mock.calls.find(([text]) => text.includes('SELECT id FROM edges INDEXED BY idx_edges_kind'))![0];
    const plan = db.getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0, 2) as Array<{ detail: string }>;
    expect(plan.map(row => row.detail).join('\n')).toMatch(/idx_edges_kind.*rowid>/);
    expect(queries.getPendingCsharpPropertyReferencesAfter(0, 1)).toEqual([expect.objectContaining({ ...ref, rowId: expect.any(Number) })]);
    const broad = queries.getCsharpPropertyTypeEdgesPage([], first.cursor, 2, true);
    expect(broad.edges.map(edge => edge.line)).toEqual([4]);
  });

  it('keeps deletion and reference resurrection in one transaction', () => {
    setupEdges();
    const page = queries.getCsharpPropertyTypeEdgesPage(['Types.cs'], 0, 10);
    const ref = resurrectRefFromDroppedEdge(page.edges[0]!)!;
    vi.spyOn(queries, 'insertUnresolvedRefsBatch').mockImplementationOnce(() => { throw new Error('controlled insertion failure'); });
    expect(() => queries.replaceResolutionEdgesWithUnresolvedRefs([page.edges[0]!.edgeId], [ref])).toThrow('controlled insertion failure');
    expect(queries.getCsharpPropertyTypeEdgesPage(['Types.cs'], 0, 10).edges).toHaveLength(1);
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
  });

  it('advances empty failed windows and admits only pending C# property rows', () => {
    queries.insertNodes([node('cs'), node('java', 'java')]);
    const inputs: Array<UnresolvedReference> = [
      { fromNodeId: 'java', referenceName: 'value.Current', referenceKind: 'property_ref', language: 'java', filePath: 'java.source', line: 1, column: 4 },
      { fromNodeId: 'cs', referenceName: 'Other', referenceKind: 'calls', language: 'csharp', filePath: 'cs.source', line: 2, column: 4 },
      { fromNodeId: 'cs', referenceName: 'value.Current', referenceKind: 'property_ref', language: 'csharp', filePath: 'cs.source', line: 3, column: 4 },
      { fromNodeId: 'cs', referenceName: 'value.Current', referenceKind: 'property_ref', language: 'csharp', filePath: 'cs.source', line: 4, column: 8 },
    ];
    queries.insertUnresolvedRefsBatch(inputs);
    db.getDb().exec("UPDATE unresolved_refs SET status='failed'");
    const first = queries.reopenFailedCsharpPropertyPage(['cs.source'], 0, 2);
    expect(first.count).toBe(0);
    expect(first.after).toBeGreaterThan(0);
    const second = queries.reopenFailedCsharpPropertyPage(['cs.source'], first.after, 2);
    expect(second.count).toBe(2);
    expect(second.after).toBeGreaterThan(first.after);
    expect(queries.reopenFailedCsharpPropertyPage(['cs.source'], second.after, 2)).toEqual({ after: second.after, count: 0 });
    const one = queries.getPendingCsharpPropertyReferencesAfter(0, 1);
    const two = queries.getPendingCsharpPropertyReferencesAfter(one[0]!.rowId!, 1);
    expect([...one, ...two].map(ref => [ref.referenceKind, ref.language, ref.line, ref.column])).toEqual([
      ['property_ref', 'csharp', 3, 4], ['property_ref', 'csharp', 4, 8],
    ]);
    expect(queries.getPendingCsharpPropertyReferencesAfter(two[0]!.rowId!, 1)).toEqual([]);
    const other = db.getDb().prepare("SELECT status FROM unresolved_refs WHERE reference_kind='calls' OR language='java'").all() as Array<{ status: string }>;
    expect(other.every(row => row.status === 'failed')).toBe(true);
  });

  it('awaits yield/backpressure between examined pages, including an empty one', async () => {
    setupEdges();
    const driver = new ExtractionOrchestrator(root, queries);
    const pages = vi.spyOn(queries, 'getCsharpPropertyTypeEdgesPage');
    let release!: () => void, macrotasks = 0;
    const pressure = new Promise<void>(resolve => { release = resolve; });
    const boundary = vi.fn(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      macrotasks++;
      if (boundary.mock.calls.length === 1) await pressure;
    });
    const running = driver.resurrectCsharpPropertyEdges(['Types.cs'], [], false, boundary, 2);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(macrotasks).toBe(1);
    expect(pages).toHaveBeenCalledTimes(1);
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
    release();
    await running;
    expect(pages.mock.calls.every(([, , limit]) => limit === 2)).toBe(true);
    expect(macrotasks).toBeGreaterThanOrEqual(2);
    expect(queries.getUnresolvedReferencesCount()).toBe(1);
    expect(queries.getCsharpPropertyTypeEdgesPage([], 0, 20, true).edges.map(edge => edge.line)).toEqual([4]);
  });
});
