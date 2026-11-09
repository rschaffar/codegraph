import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { indexFingerprint } from './index-fingerprint';
import CodeGraph from '../src/index';
import { NODE_KINDS, EDGE_KINDS, type Node, type NodeKind, type EdgeKind } from '../src/types';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';
import { BoardGraph, MAX_BOARD_SCOPE, MAX_BOARD_RELATIONS, MAX_BOARD_TARGET_EVIDENCE } from '../src/graph/board-projection';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

let root: string;
let server: UiServerHandle;
let api: GraphApi;
let evidenceIds: string[];
let uncertainEvidenceIds: string[];
let certainEvidenceIds: string[];
let beforeFiles: string[];
let beforeDb: string;
const databaseHash = () => {
  const reader = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try { return indexFingerprint(reader.getDb(), getDatabasePath(root)).logical; }
  finally { reader.close(); }
};
const metadataFiles = () => fs.readdirSync(path.join(root, '.codegraph')).filter(file => !/-wal$|-shm$/.test(file)).sort();

function request(endpoint: string, params: Record<string, string | number> = {}, method = 'GET'): Promise<{ status: number; body: any }> {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path: `${endpoint}${endpoint.includes('?') ? '&' : '?'}${query}`, method,
      headers: { Host: `127.0.0.1:${server.port}` }, setHost: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: method === 'HEAD' ? '' : JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function get(endpoint: string, params: Record<string, string | number> = {}): Promise<any> {
  const res = await request(endpoint, params);
  expect(res.status).toBe(200);
  return res.body;
}
const project = (ids: string[], filters: Record<string, string | number> = {}) => get('/api/board', { ids: JSON.stringify(ids), ...filters });
const groups = (params: Record<string, string | number>) => get('/api/board/groups', params);
const members = (params: Record<string, string | number>) => get('/api/board/members', params);
const connections = (params: Record<string, string | number>) => get('/api/board/connections', params);
const search = (params: Record<string, string | number> = {}) => get('/api/board/search', params);
const siblings = (params: Record<string, string | number>) => get('/api/board/sibling-sources', params);
const sourceContext = (id: string) => get('/api/board/source-context', { id });

function endpointsResolve(body: any): void {
  const ids = new Set(body.symbols.map((s: any) => s.id));
  const edges = body.items.flatMap((item: any) => item.evidence ?? [item]);
  for (const edge of edges) {
    expect(ids.has(edge.source), `missing source ${edge.source}`).toBe(true);
    expect(ids.has(edge.target), `missing target ${edge.target}`).toBe(true);
  }
  for (const s of body.symbols) if (s.ownerId) expect(ids.has(s.ownerId)).toBe(true);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-board-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/live.ts'), 'export class Actual { run() { return helper(); } }\nexport function helper() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'src/siblings.ts'), `
export class SiblingExtracted {
  first() { function local() {} return local(); }
  second(value: string): string;
  second(value: number): number;
  second(value: string | number) { return value; }
}
export class OtherExtracted { unrelated() {} }
export function freeFirst() { function nested() {} return nested(); }
export function freeSecond() {}
`);
  fs.writeFileSync(path.join(root, 'src/siblings.py'), `
class PythonOwner:
    def first(self):
        def local():
            pass
        return local()
    def second(self):
        pass
class PythonOther:
    def unrelated(self):
        pass
`);
  const cg = CodeGraph.initSync(root);
  await cg.indexAll();
  cg.resolveReferences();
  const queries = cg['queries'];
  const db = cg['db'].getDb();
  const add = (id: string, kind: NodeKind = 'function', file = 'app/main.ts', name = id, line = 2, column = 0): void => {
    const node: Node = { id, kind, name, qualifiedName: `${file}::${name}`, filePath: file,
      language: 'typescript', startLine: line, endLine: line + 8, startColumn: column, endColumn: 1 };
    queries.insertNode(node);
  };
  const edge = (source: string, target: string, kind: EdgeKind, line = 1, metadata?: Record<string, unknown>): void => {
    queries.insertEdge({ source, target, kind, line, column: 3, metadata });
  };
  // A real SQLite catalogue fixture supplements actual AST indexing: not every
  // supported kind/metadata mechanism can be extracted from one small language.
  db.transaction(() => {
    for (const kind of NODE_KINDS) add(`kind-${kind}`, kind, 'catalogue/kinds.ts');
    for (let i = 0; i < NODE_KINDS.length; i++) edge(`kind-${NODE_KINDS[i]}`, `kind-${NODE_KINDS[(i + 1) % NODE_KINDS.length]}`, 'references');
    add('future-node', 'future_node' as NodeKind, 'catalogue/kinds.ts');
    add('generated-peer', 'function', 'generated/schema.pb.go');
    add('generated-content-peer', 'function', 'generated/ordinary.ts');
    db.prepare(`INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at, generated)
      VALUES ('generated/ordinary.ts', 'fixture', 'typescript', 0, 0, 0, 1)`).run();
    add('file-owner', 'file'); add('owner', 'class'); add('member', 'method'); add('parameter', 'parameter');
    add('unproven', 'function');
    edge('file-owner', 'owner', 'contains'); edge('owner', 'member', 'contains'); edge('member', 'parameter', 'contains');
    for (const kind of EDGE_KINDS) {
      add(`peer-${kind}`, 'variable', `other/${kind}.ts`);
      add(`incoming-${kind}`, 'function', '__tests__/hidden.test.ts');
      edge('member', `peer-${kind}`, kind);
      edge(`incoming-${kind}`, 'member', kind);
    }
    add('same-a', 'method', 'one/a.ts', 'Same'); add('same-b', 'method', 'two/b.ts', 'Same');
    add('same-owner', 'class', 'one/a.ts', 'SameOwner'); edge('same-owner', 'same-a', 'contains');
    edge('member', 'same-a', 'calls', 11, { confidence: 0.21, synthesizedBy: 'fixture-callback', via: 'callback', registeredAt: 'fixture/wiring.ts:9', resolvedBy: 'name-only' });
    db.prepare("UPDATE edges SET provenance='heuristic' WHERE source='member' AND target='same-a'").run();
    edge('member', 'same-b', 'calls', 12);
    edge('member', 'same-b', 'references', 12);
    edge('member', 'same-b', 'returns', 12);
    edge('member', 'generated-peer', 'references', 17);
    edge('member', 'generated-content-peer', 'references', 18);
    edge('member', 'member', 'references', 13);
    edge('member', 'future-node', 'future_edge' as EdgeKind, 14);
    add('ambiguous', 'property'); add('parent-a', 'struct'); add('parent-b', 'namespace');
    add('orphan', 'field'); add('partially-ambiguous', 'property');
    edge('parent-a', 'partially-ambiguous', 'contains');
    edge('parent-a', 'ambiguous', 'contains'); edge('parent-b', 'ambiguous', 'contains');
    add('cycle-a'); add('cycle-b'); edge('cycle-a', 'cycle-b', 'contains'); edge('cycle-b', 'cycle-a', 'contains');
    add('literal', 'constant', 'literal%_/entry.ts', '100%_exact');
    add('nonliteral', 'constant', 'literalXX/entry.ts', '100XXexact');
    add('evidence-hub'); add('evidence-target');
    for (let i = 0; i < MAX_BOARD_RELATIONS + 5; i++) edge('evidence-hub', 'evidence-target', 'calls', i + 1);
    add('wide', 'module');
    for (let i = 0; i < MAX_BOARD_SCOPE + 5; i++) {
      add(`wide-${String(i).padStart(4, '0')}`, 'field', 'wide/contents.ts');
      edge('wide', `wide-${String(i).padStart(4, '0')}`, 'contains', i + 1);
    }
    for (const suffix of ['a', 'b']) {
      add(`wide-deep-target-${suffix}`, 'parameter', 'wide/nested.ts');
      edge(`wide-${String(MAX_BOARD_SCOPE + 4).padStart(4, '0')}`, `wide-deep-target-${suffix}`, 'contains');
    }
    for (let i = 0; i < 70; i++) {
      add(`deep-${i}`, 'namespace', 'deep/contents.ts');
      if (i) edge(`deep-${i - 1}`, `deep-${i}`, 'contains');
    }
    // Folder previews include nested contents, all kinds, both generation
    // signals, overlapping test/generated reasons, and literal path characters.
    add('group-class', 'class', 'group-scope/main.ts');
    add('group-fn', 'function', 'group-scope/nested/code.ts');
    add('group-future', 'future_node' as NodeKind, 'group-scope/nested/code.ts');
    add('group-test', 'method', 'group-scope/a.test.ts');
    add('group-gen', 'field', 'group-scope/schema.pb.go');
    add('group-content-gen', 'constant', 'group-scope/ordinary.ts');
    add('group-both', 'function', 'group-scope/tests/schema.pb.go');
    db.prepare(`INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at, generated)
      VALUES ('group-scope/ordinary.ts', 'fixture', 'typescript', 0, 0, 0, 1)`).run();
    add('group-not-prefix', 'variable', 'group-scopeish/other.ts');
    add('root-file', 'file', 'top.ts');
    // Real namespace identities with repeated names and descendants in unrelated
    // folders. Matching qualified-name prefixes without contains is insufficient.
    add('ns-a', 'namespace', 'namespace/one.ts', 'Shared');
    add('ns-b', 'namespace', 'namespace/two.ts', 'Shared');
    add('ns-nested', 'namespace', 'unrelated/nested.ts', 'Inner');
    add('ns-type', 'class', 'other-dir/type.ts', 'Container');
    add('ns-run', 'method', 'other-dir/type.ts', 'run', 20);
    add('ns-param', 'parameter', 'other-dir/type.ts', 'value', 20, 15);
    add('ns-other-run', 'method', 'namespace/two.ts', 'run', 4);
    add('ns-prefix-only', 'function', 'namespace/one.ts', 'Shared.fake');
    add('ns-test', 'function', 'namespace/scope.test.ts');
    edge('ns-a', 'ns-nested', 'contains'); edge('ns-nested', 'ns-type', 'contains');
    edge('ns-type', 'ns-run', 'contains'); edge('ns-run', 'ns-param', 'contains');
    edge('ns-a', 'ns-test', 'contains'); edge('ns-b', 'ns-other-run', 'contains');
    // Filtered automatic members/edges, including a blocked ownership path and
    // explicitly selected excluded identities that must never disappear.
    add('filter-owner', 'class', 'filter-scope/main.ts');
    add('filter-live', 'method', 'filter-scope/main.ts', 'filteredTwin', 30);
    add('filter-test', 'method', 'filter-scope/a.test.ts', 'filteredTwin', 10);
    add('filter-gen', 'field', 'filter-scope/schema.pb.go');
    add('filter-content', 'property', 'filter-scope/ordinary.ts');
    add('filter-both', 'constant', 'filter-scope/tests/schema.pb.go');
    add('filter-weak', 'class', 'filter-scope/weak.ts');
    add('filter-nested', 'method', 'filter-scope/nested.ts');
    db.prepare(`INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at, generated)
      VALUES ('filter-scope/ordinary.ts', 'fixture', 'typescript', 0, 0, 0, 1)`).run();
    for (const target of ['filter-live', 'filter-test', 'filter-gen', 'filter-content', 'filter-both']) edge('filter-owner', target, 'contains');
    edge('filter-owner', 'filter-weak', 'contains', 1, { confidence: 0.5 });
    edge('filter-weak', 'filter-nested', 'contains');
    edge('filter-nested', 'filter-live', 'calls');
    add('filter-test-root', 'module', 'filter-scope/owner.test.ts');
    add('filter-under-test', 'function', 'filter-scope/child.ts');
    edge('filter-test-root', 'filter-under-test', 'contains');
    add('filter-origin', 'function', 'filter-scope/origin.ts');
    for (const target of ['filter-live', 'filter-test', 'filter-gen', 'filter-content', 'filter-both']) {
      edge('filter-origin', target, 'references', 1, { confidence: target === 'filter-both' ? 0.1 : 1 });
    }
    // Strong and weak evidence on the same target: counts are original sites,
    // not max group confidence, and neither synthesis nor malformed metadata
    // should accidentally turn a certain edge into a name-only guess.
    add('uncertainty-root');
    for (const target of ['mixed', 'low', 'name', 'name-high', 'heuristic', 'boundary', 'string', 'bool', 'invalid', 'exact']) add(`uncertainty-${target}`);
    for (let i = 0; i < 60; i++) edge('uncertainty-root', 'uncertainty-mixed', 'calls', i + 1, { confidence: i < 45 ? 0.6 : 0.599 });
    edge('uncertainty-root', 'uncertainty-low', 'calls', 1, { confidence: 0.599 });
    edge('uncertainty-root', 'uncertainty-name', 'calls', 1, { resolvedBy: 'name-only' });
    edge('uncertainty-root', 'uncertainty-name-high', 'calls', 1, { resolvedBy: 'name-only', confidence: 0.9 });
    edge('uncertainty-root', 'uncertainty-heuristic', 'calls', 1, { synthesizedBy: 'fixture-bridge', registeredAt: 'app/wiring.ts:5' });
    db.prepare("UPDATE edges SET provenance='heuristic' WHERE source='uncertainty-root' AND target='uncertainty-heuristic'").run();
    edge('uncertainty-root', 'uncertainty-boundary', 'calls', 1, { confidence: 0.6 });
    edge('uncertainty-root', 'uncertainty-string', 'calls', 1, { confidence: '0.1' });
    edge('uncertainty-root', 'uncertainty-bool', 'calls', 1, { confidence: false });
    edge('uncertainty-root', 'uncertainty-invalid', 'calls');
    db.prepare("UPDATE edges SET metadata='{bad json' WHERE source='uncertainty-root' AND target='uncertainty-invalid'").run();
    edge('uncertainty-root', 'uncertainty-exact', 'calls', 1, { resolvedBy: 'exact-match' });
    // Deliberately shuffled insertion and same-name/same-line declarations.
    add('outline-root', 'class', 'outline/main.ts');
    add('outline-z', 'field', 'outline/main.ts', 'duplicate', 15);
    add('outline-a', 'method', 'outline/main.ts', 'duplicate', 3, 4);
    add('outline-b', 'property', 'outline/main.ts', 'duplicate', 3, 1);
    for (const child of ['outline-z', 'outline-a', 'outline-b']) edge('outline-root', child, 'contains');
    edge('outline-root', 'outline-z', 'contains', 2); // same child, two sites
    edge('outline-a', 'ns-a', 'references');
    add('all-kind-owner', 'module', 'outline/kinds.ts');
    for (const kind of NODE_KINDS) edge('all-kind-owner', `kind-${kind}`, 'contains');
    edge('all-kind-owner', 'future-node', 'contains');
    // Sibling discovery uses real containment, not file/qualified-name guesses.
    const sb = (id: string, kind: NodeKind = 'method', file = 'sibling/main.ts', name = id, line = 2, col = 0) => add(id, kind, file, name, line, col);
    sb('sb-owner', 'struct'); sb('sb-other', 'interface'); sb('sb-namespace', 'namespace');
    edge('sb-namespace', 'sb-owner', 'contains');
    for (const [id, col] of [['sb-origin', 0], ['sb-overload-a', 1], ['sb-overload-b', 2]] as const) {
      sb(id, 'method', 'sibling/main.ts', 'sbOverload', 3, col); edge('sb-owner', id, 'contains');
    }
    edge('sb-owner', 'sb-overload-a', 'contains', 9); // duplicate evidence, not two owners
    sb('sb-wrapper', 'namespace'); edge('sb-owner', 'sb-wrapper', 'contains');
    sb('sb-wrapped', 'function', 'sibling/impl.cpp'); edge('sb-wrapper', 'sb-wrapped', 'contains');
    sb('sb-inner-type', 'class'); sb('sb-inner-method');
    edge('sb-owner', 'sb-inner-type', 'contains'); edge('sb-inner-type', 'sb-inner-method', 'contains');
    sb('sb-local', 'function'); edge('sb-origin', 'sb-local', 'contains');
    sb('sb-unrelated'); edge('sb-other', 'sb-unrelated', 'contains');
    sb('sb-ambiguous'); edge('sb-owner', 'sb-ambiguous', 'contains'); edge('sb-other', 'sb-ambiguous', 'contains');
    for (const [id, file, metadata] of [
      ['sb-test', 'sibling/main.test.ts', undefined],
      ['sb-gen', 'sibling/schema.pb.go', undefined],
      ['sb-content-gen', 'generated/ordinary.ts', undefined],
      ['sb-weak', 'sibling/main.ts', { resolvedBy: 'name-only' }],
      ['sb-test-weak', 'sibling/main.test.ts', { confidence: 0.1 }],
    ] as const) { sb(id, 'method', file); edge('sb-owner', id, 'contains', 1, metadata); }
    sb('sb-file', 'file'); sb('sb-free-origin', 'function'); sb('sb-free-peer', 'function');
    sb('sb-free-ns', 'namespace'); sb('sb-free-wrapped', 'function');
    edge('sb-file', 'sb-free-origin', 'contains'); edge('sb-file', 'sb-free-peer', 'contains');
    edge('sb-file', 'sb-free-ns', 'contains'); edge('sb-free-ns', 'sb-free-wrapped', 'contains');
    sb('sb-free-local', 'function'); edge('sb-free-origin', 'sb-free-local', 'contains');
    sb('sb-root-function', 'function'); sb('sb-orphan-method'); sb('sb-missing-function', 'function');
    sb('sb-prefix', 'function', 'sibling/main.ts.extra');
    sb('sb-function-member', 'function'); edge('sb-other', 'sb-function-member', 'contains');
    sb('sb-free-ambiguous', 'function'); edge('sb-file', 'sb-free-ambiguous', 'contains'); edge('sb-other', 'sb-free-ambiguous', 'contains');
    sb('sb-deep-owner', 'protocol'); sb('sb-deep-origin'); edge('sb-deep-owner', 'sb-deep-origin', 'contains');
    for (let i = 0; i < 66; i++) {
      sb(`sb-depth-${i}`, 'namespace'); edge(i ? `sb-depth-${i - 1}` : 'sb-deep-owner', `sb-depth-${i}`, 'contains');
    }
    sb('sb-too-deep'); edge('sb-depth-65', 'sb-too-deep', 'contains');
    sb('sb-wide-owner', 'trait'); sb('sb-wide-origin'); edge('sb-wide-owner', 'sb-wide-origin', 'contains');
    for (let i = 0; i < MAX_BOARD_SCOPE + 3; i++) {
      sb(`sb-wide-${String(i).padStart(4, '0')}`, 'method', 'sibling/wide.rs', 'overloaded', i + 1);
      edge('sb-wide-owner', `sb-wide-${String(i).padStart(4, '0')}`, 'contains');
    }
    // Source context finds exact-file identity independently of ownership.
    add('sc-file', 'file', 'source-context/exact.ts');
    add('sc-outer', 'class', 'source-context/exact.ts'); add('sc-wrapper', 'namespace', 'source-context/exact.ts');
    add('sc-inner', 'struct', 'source-context/exact.ts'); add('sc-method', 'method', 'source-context/exact.ts');
    edge('sc-file', 'sc-outer', 'contains'); edge('sc-outer', 'sc-wrapper', 'contains');
    edge('sc-wrapper', 'sc-inner', 'contains'); edge('sc-inner', 'sc-method', 'contains'); edge('sc-inner', 'sc-method', 'contains', 2);
    add('sc-free', 'function', 'source-context/exact.ts');
    add('sc-other-file', 'file', 'source-context/exact.ts.extra');
    add('sc-partial-owner', 'class', 'source-context/other.ts'); add('sc-partial-method', 'method', 'source-context/exact.ts');
    edge('sc-partial-owner', 'sc-partial-method', 'contains');
    add('sc-duplicate-file-a', 'file', 'source-context/duplicate.ts'); add('sc-duplicate-file-b', 'file', 'source-context/duplicate.ts');
    add('sc-duplicate-origin', 'function', 'source-context/duplicate.ts');
    add('sc-ambiguous', 'method', 'source-context/exact.ts'); edge('sc-inner', 'sc-ambiguous', 'contains'); edge('sc-outer', 'sc-ambiguous', 'contains');
    add('sc-cycle-a', 'class', 'source-context/exact.ts'); add('sc-cycle-b', 'class', 'source-context/exact.ts');
    edge('sc-cycle-a', 'sc-cycle-b', 'contains'); edge('sc-cycle-b', 'sc-cycle-a', 'contains');
    db.prepare(`INSERT INTO unresolved_refs(from_node_id, reference_name, reference_kind, line, col)
      VALUES ('member', 'uninstalledPackage', 'calls', 15, 2)`).run();
    // Simulate an older/imported corrupt index without inventing a node.
    // Foreign keys are normally on, so insert the dangling boundary separately.
  })();
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO edges(source,target,kind,line) VALUES ('member','outside-index','calls',16), ('missing-parent','orphan','contains',1), ('missing-parent','partially-ambiguous','contains',1), ('missing-parent','sb-missing-function','contains',1)").run();
  db.pragma('foreign_keys = ON');
  evidenceIds = db.prepare("SELECT id FROM edges WHERE source='evidence-hub' ORDER BY id").all().map((r: any) => String(r.id));
  uncertainEvidenceIds = db.prepare("SELECT id FROM edges WHERE source='uncertainty-root' AND target='uncertainty-mixed' ORDER BY id").all().map((r: any) => String(r.id));
  certainEvidenceIds = uncertainEvidenceIds.slice(0, 45);
  cg.close();
  const viewer = path.join(root, 'viewer');
  fs.mkdirSync(viewer);
  fs.writeFileSync(path.join(viewer, 'index.html'), '<div>fixture</div>');
  api = createGraphApi({ projectRoot: root, readOnly: true });
  server = await startUiServer({ projectRoot: root, viewerDir: viewer, port: 0, api: api.handler });
  beforeFiles = metadataFiles();
  beforeDb = databaseHash();
}, 120_000);

afterAll(async () => {
  api?.close();
  await server?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Board selection and identity', () => {
  it('uses a real extracted index and preserves original evidence', async () => {
    const actual = await search({ q: 'Actual', kind: 'class' });
    expect(actual.total).toBe(1);
    const body = await project([actual.items[0].id]);
    expect(body.included).toEqual([actual.items[0].id]);
    expect(body.symbols.some((s: any) => s.name === 'run' && s.ownerId === actual.items[0].id)).toBe(true);
    expect(body.relations.some((e: any) => e.kind === 'contains')).toBe(true);
    expect(body.symbols.some((s: any) => s.name === 'helper')).toBe(false);
  });

  it('has every catalogue kind and raw future-kind fallbacks without ranking exclusions', async () => {
    const catalogue = await search({ path: 'catalogue' });
    expect(catalogue.total).toBe(NODE_KINDS.length + 1);
    expect(new Set(catalogue.items.map((s: any) => s.kind))).toEqual(new Set([...NODE_KINDS, 'future_node']));
    const selected = await project(catalogue.items.map((s: any) => s.id));
    expect(selected.nodeKinds).toEqual([...NODE_KINDS]);
    expect(selected.edgeKinds).toEqual([...EDGE_KINDS]);
    expect(selected.included).toHaveLength(NODE_KINDS.length + 1);
    expect(selected.relations).toHaveLength(NODE_KINDS.length);
    for (const kind of NODE_KINDS) {
      const result = await search({ kind, path: 'catalogue', q: '' });
      expect(result.items.map((s: any) => s.id)).toEqual([`kind-${kind}`]);
      expect(result.total).toBe(1);
    }
  });

  it('includes bounded descendants and ancestors but never admits unselected neighbours', async () => {
    const body = await project(['owner', 'same-a', 'owner', 'missing-id'], { uncertain: 1 });
    expect(body.included).toEqual(['owner', 'same-a']);
    expect(body.missing).toEqual(['missing-id']);
    const byId = new Map(body.symbols.map((s: any) => [s.id, s]));
    expect(byId.has('file-owner')).toBe(true);
    expect(byId.has('same-owner')).toBe(true);
    expect(byId.has('parameter')).toBe(true);
    expect(byId.has('same-b')).toBe(false);
    expect(byId.has('peer-calls')).toBe(false);
    expect(body.symbols.find((s: any) => s.id === 'owner')).toMatchObject({ ownerId: 'file-owner', memberCount: 1 });
    expect(body.relations.some((e: any) => e.source === 'member' && e.target === 'same-a' && e.kind === 'calls')).toBe(true);
    expect(body.relations.every((e: any) => e.source !== 'file-owner' && e.source !== 'same-owner')).toBe(true);
    expect(body.notes.join(' ')).toMatch(/unresolved references/);
    expect(body.notes.join(' ')).toMatch(/outside-index/);
    expect(body.relations.some((e: any) => e.target === 'outside-index')).toBe(false);
  });

  it('retains every parallel kind and future edge as original projection evidence', async () => {
    const ids = ['member', ...EDGE_KINDS.map(kind => `peer-${kind}`), 'future-node'];
    const body = await project(ids);
    expect(new Set(body.relations.map((e: any) => e.kind))).toEqual(new Set([...EDGE_KINDS, 'future_edge']));
    expect(body.relations.some((e: any) => e.source === 'member' && e.target === 'member')).toBe(true);
    const again = await project([...ids, 'owner']);
    expect(new Set(again.relations.map((e: any) => e.id)).size).toBe(again.relations.length);
    const parallel = await project(['member', 'same-b']);
    expect(parallel.relations.filter((e: any) => e.target === 'same-b').map((e: any) => e.kind).sort()).toEqual(['calls', 'references', 'returns']);
    const peers = await connections({ id: 'member', q: 'two/b.ts' });
    expect(peers.items[0].total).toBe(3);
    expect(peers.items[0].evidence.map((e: any) => e.kind).sort()).toEqual(['calls', 'references', 'returns']);
  });

  it('does not infer ownership from ranges, names or ambiguous/cyclic contains edges', async () => {
    const body = await project(['unproven', 'ambiguous', 'cycle-a']);
    for (const id of ['unproven', 'ambiguous', 'cycle-a', 'cycle-b']) {
      expect(body.symbols.find((s: any) => s.id === id).ownerId).toBeUndefined();
    }
    expect(body.notes.join(' ')).toMatch(/Ambiguous contains ownership/);
    expect(body.notes.join(' ')).toMatch(/Cyclic contains ownership/);
    const result = await search({ q: 'ambiguous' });
    expect(result.items[0].ownerId).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/Ambiguous/);
    const corrupt = await project(['orphan', 'partially-ambiguous']);
    expect(corrupt.symbols.every((s: any) => s.ownerId === undefined)).toBe(true);
    expect(corrupt.notes.join(' ')).toMatch(/Missing contains parent/);
    expect(corrupt.notes.join(' ')).toMatch(/Ambiguous contains ownership/);
  });

  it('reports missing selections and permits an empty board without graph expansion', async () => {
    expect(await project([])).toMatchObject({ symbols: [], relations: [], included: [], missing: [], bounded: false });
    expect(await project(['gone'])).toMatchObject({ symbols: [], included: [], missing: ['gone'] });
  });
});

describe('Board exact filtering and paging', () => {
  it('escapes LIKE wildcards and SQL injection strings and uses folder boundaries', async () => {
    expect((await search({ q: '%_' })).items.map((s: any) => s.id)).toEqual(['literal']);
    expect((await search({ path: 'literal%_' })).items.map((s: any) => s.id)).toEqual(['literal']);
    expect((await search({ path: 'literal' })).total).toBe(0);
    expect((await search({ path: 'Catalogue' })).total).toBe(0);
    expect((await search({ q: "' OR 1=1 --" })).total).toBe(0);
    expect((await search({ kind: 'class%' })).total).toBe(0);
  });

  it('enumerates folders and repeated names with exact totals and continuations', async () => {
    const first = await search({ path: 'catalogue', limit: 5 });
    expect(first.total).toBe(NODE_KINDS.length + 1);
    expect(first.nextOffset).toBe(5);
    expect(first.bounded).toBe(false); // ordinary paging is not truncation
    const all = [...first.items];
    let offset = first.nextOffset;
    while (offset !== null) {
      const page = await search({ path: 'catalogue', limit: 5, offset });
      expect(page.total).toBe(first.total);
      all.push(...page.items);
      offset = page.nextOffset;
    }
    expect(new Set(all.map(s => s.id)).size).toBe(first.total);
    const same = await search({ q: 'Same', kind: 'method' });
    expect(same.items.map((s: any) => s.id)).toEqual(['same-a', 'same-b']);
    expect(same.items.map((s: any) => s.file)).toEqual(['one/a.ts', 'two/b.ts']);
    const pastEnd = await search({ path: 'catalogue', offset: 999 });
    expect(pastEnd).toMatchObject({ items: [], total: first.total, nextOffset: null });
  });
});

describe('Board search identity context', () => {
  it('returns proven ancestors beyond projection scope while keeping only matches in the paged items', async () => {
    const owner = `wide-${String(MAX_BOARD_SCOPE + 4).padStart(4, '0')}`;
    const selection = await project(['wide']);
    expect(selection.bounded).toBe(true);
    expect(selection.symbols.some((s: any) => s.id === owner || s.id === 'wide-deep-target-a')).toBe(false);
    const first = await search({ q: 'wide-deep-target', limit: 1 });
    expect(first.total).toBe(2);
    expect(first.nextOffset).toBe(1);
    expect(first.items.map((s: any) => s.id)).toEqual(['wide-deep-target-a']);
    expect(first.items[0].ownerId).toBe(owner);
    expect(first.symbols.map((s: any) => s.id).sort()).toEqual(['wide', owner, 'wide-deep-target-a'].sort());
    expect(first.symbols.find((s: any) => s.id === owner).ownerId).toBe('wide');
    expect(first.symbols.some((s: any) => s.id === 'wide-deep-target-b')).toBe(false);
    const second = await search({ q: 'wide-deep-target', offset: first.nextOffset, limit: 1 });
    expect(second.total).toBe(2);
    expect(second.items.map((s: any) => s.id)).toEqual(['wide-deep-target-b']);
    expect(second.symbols.map((s: any) => s.id).sort()).toEqual(['wide', owner, 'wide-deep-target-b'].sort());
    expect(second.nextOffset).toBeNull();
    for (const page of [first, second]) {
      const ids = new Set(page.symbols.map((s: any) => s.id));
      for (const symbol of page.symbols) if (symbol.ownerId) expect(ids.has(symbol.ownerId)).toBe(true);
    }
    const empty = await search({ q: 'wide-deep-target', offset: 2 });
    expect(empty).toMatchObject({ items: [], symbols: [], total: 2, nextOffset: null });
  });
});

describe('Board Connections are independent of canvas membership', () => {
  it('discovers every kind in both directions, including contains and unselected test targets', async () => {
    for (const kind of EDGE_KINDS) {
      const outgoing = await connections({ id: 'member', direction: 'outgoing', kind });
      expect(outgoing.items.some((r: any) => r.target.id === `peer-${kind}`)).toBe(true);
      expect(outgoing.items.flatMap((r: any) => r.evidence).every((e: any) => e.kind === kind)).toBe(true);
      endpointsResolve(outgoing);
      const incoming = await connections({ id: 'member', direction: 'incoming', kind, tests: 1 });
      const hidden = incoming.items.find((r: any) => r.target.id === `incoming-${kind}`);
      expect(hidden.target.test).toBe(true);
      expect(hidden.evidence[0]).toMatchObject({ source: `incoming-${kind}`, target: 'member', kind, file: '__tests__/hidden.test.ts' });
      endpointsResolve(incoming);
    }
    const future = await connections({ id: 'member', kind: 'future_edge' });
    expect(future.items[0].target.kind).toBe('future_node');
    expect((await connections({ id: 'member', kind: 'call' })).total).toBe(0);
  });

  it('discovers generated targets without canvas or reader-rail exclusions and labels generation', async () => {
    const body = await connections({ id: 'member', q: 'generated/', generated: 1 });
    expect(body.items.map((r: any) => r.target.id).sort()).toEqual(['generated-content-peer', 'generated-peer']);
    expect(body.items.every((r: any) => r.target.generated === true)).toBe(true);
  });

  it('distinguishes member-only and recursive member scope with exact direction and original endpoint IDs', async () => {
    expect((await connections({ id: 'owner', members: 0, kind: 'calls' })).total).toBe(0);
    const body = await connections({ id: 'owner', members: 1, kind: 'calls', uncertain: 1 });
    expect(body.withMembers).toBe(true);
    expect(body.total).toBe(3); // peer-calls + two identically named methods
    expect(body.items.every((r: any) => r.evidence.every((e: any) => e.source === 'member'))).toBe(true);
    expect(body.notes.join(' ')).toMatch(/1 unresolved/);
    expect(body.notes.join(' ')).toMatch(/1 indexed relationships/);
    const same = body.items.find((r: any) => r.target.id === 'same-a');
    expect(same.owner.id).toBe('same-owner');
    expect(same.evidence[0]).toMatchObject({ kind: 'calls', confidence: 0.21, provenance: 'heuristic', synthesizedBy: 'fixture-callback', via: 'callback', registeredAt: 'fixture/wiring.ts:9', resolvedBy: 'name-only', line: 11, col: 3, file: 'app/main.ts' });
    endpointsResolve(body);
    const incoming = await connections({ id: 'owner', members: 1, direction: 'incoming', kind: 'calls', tests: 1 });
    expect(incoming.items.map((r: any) => r.target.id)).toEqual(['incoming-calls']);
    endpointsResolve(incoming);
  });

  it('retains self-relations, exact query filters, grouped totals and complete target paging', async () => {
    const self = await connections({ id: 'member', kind: 'references', q: 'member' });
    expect(self.items.map((r: any) => r.target.id)).toEqual(['member']);
    const first = await connections({ id: 'member', limit: 2 });
    expect(first.nextOffset).toBe(2);
    const collected: string[] = [];
    let page = first;
    do {
      expect(page.total).toBe(first.total);
      collected.push(...page.items.map((r: any) => r.target.id));
      if (page.nextOffset === null) break;
      page = await connections({ id: 'member', offset: page.nextOffset, limit: 2 });
    } while (true);
    expect(new Set(collected).size).toBe(first.total);
    expect(collected).toHaveLength(first.total);
    expect((await connections({ id: 'member', q: '%_' })).total).toBe(0);
    expect((await connections({ id: 'member', q: 'one/a.ts', kind: 'calls', uncertain: 1 })).items[0].target.id).toBe('same-a');
  });
});

describe('Board caps and evidence drilling', () => {
  it('caps god-target evidence explicitly but pages every original evidence ID with exact totals', async () => {
    const body = await connections({ id: 'evidence-hub', kind: 'calls' });
    expect(body.total).toBe(1);
    expect(body.items[0].total).toBe(evidenceIds.length);
    expect(body.items[0].evidence).toHaveLength(MAX_BOARD_TARGET_EVIDENCE);
    expect(body.bounded).toBe(true);
    expect(body.notes.join(' ')).toMatch(/Evidence per target bounded/);
    const ids: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await get('/api/board/evidence', { id: 'evidence-hub', target: 'evidence-target', direction: 'outgoing', kind: 'calls', offset, limit: 200 });
      expect(page.total).toBe(evidenceIds.length);
      expect(page.bounded).toBe(false);
      endpointsResolve(page);
      ids.push(...page.items.map((e: any) => e.id));
      offset = page.nextOffset;
    }
    expect(ids).toEqual(evidenceIds);
    const reverse = await get('/api/board/evidence', { id: 'evidence-target', target: 'evidence-hub', direction: 'incoming', offset: 200, limit: 2 });
    expect(reverse.items.map((e: any) => e.id)).toEqual(evidenceIds.slice(200, 202));
    expect(reverse.total).toBe(evidenceIds.length);
    endpointsResolve(reverse);
  });

  it('bounds selection evidence without silently changing indexed identities or totals', async () => {
    const body = await project(['evidence-hub', 'evidence-target']);
    expect(body.relations).toHaveLength(MAX_BOARD_RELATIONS);
    expect(body.relations.map((e: any) => e.id)).toEqual(evidenceIds.slice(0, MAX_BOARD_RELATIONS));
    expect(body.bounded).toBe(true);
    expect(body.notes.join(' ')).toMatch(/Board evidence bounded/);
  });

  it('bounds wide/deep descendant scopes but keeps direct member totals exact', async () => {
    const body = await project(['wide']);
    expect(body.symbols).toHaveLength(MAX_BOARD_SCOPE);
    expect(body.included).toEqual(['wide']);
    expect(body.symbols.find((s: any) => s.id === 'wide')).toMatchObject({ memberCount: MAX_BOARD_SCOPE + 5, membersBounded: true });
    expect(body.bounded).toBe(true);
    expect(body.notes.join(' ')).toMatch(/totals describe only the returned scope/);
    const peers = await connections({ id: 'wide', kind: 'contains', members: 0, limit: 2 });
    expect(peers.total).toBe(MAX_BOARD_SCOPE + 5);
    expect(peers.nextOffset).toBe(2);
    expect(peers.bounded).toBe(false);
    const deep = await project(['deep-0']);
    expect(deep.bounded).toBe(true);
    expect(deep.notes.join(' ')).toMatch(/Contains scope bounded/);
    const ancestor = await project(['deep-69']);
    expect(ancestor.bounded).toBe(true);
    expect(ancestor.notes.join(' ')).toMatch(/Ancestor identity context bounded/);
  });

  it('shares member scope, filters and evidence IDs with connection drilling', async () => {
    const conn = await connections({ id: 'owner', members: 1, kind: 'calls', q: 'Same', uncertain: 1 });
    expect(conn.total).toBe(2);
    const body = await get('/api/board/evidence', { id: 'owner', target: 'same-a', members: 1, kind: 'calls', q: 'Same', uncertain: 1 });
    expect(body.items).toEqual(conn.items.find((r: any) => r.target.id === 'same-a').evidence);
    endpointsResolve(body);
    expect((await get('/api/board/evidence', { id: 'owner', target: 'same-a', members: 0, kind: 'calls' })).total).toBe(0);
    expect((await get('/api/board/evidence', { id: 'owner', target: 'same-a', members: 1, kind: 'references' })).total).toBe(0);
  });
});

describe('Board default visibility filters and exact exclusion counts', () => {
  it('filters discovery by both generation signals and the shared test/non-production predicate', async () => {
    const defaults = await search({ path: 'group-scope' });
    expect(defaults.total).toBe(3);
    expect(defaults.items.map((s: any) => s.id).sort()).toEqual(['group-class', 'group-fn', 'group-future']);
    expect(defaults.excluded).toEqual({ symbols: { tests: 2, generated: 2, uncertain: 0 }, relations: { tests: 0, generated: 0, uncertain: 0 } });
    expect(defaults.notes.join(' ')).toMatch(/exact before paging/);
    const tests = await search({ path: 'group-scope', tests: 1, limit: 1 });
    expect(tests.total).toBe(4);
    expect(tests.excluded.symbols).toEqual({ tests: 0, generated: 3, uncertain: 0 });
    const generated = await search({ path: 'group-scope', generated: 1 });
    expect(generated.total).toBe(5);
    expect(generated.excluded.symbols).toEqual({ tests: 2, generated: 0, uncertain: 0 });
    const all = await search({ path: 'group-scope', generated: 1, tests: 1 });
    expect(all.total).toBe(7);
    expect(all.items.filter((s: any) => s.generated).map((s: any) => s.id).sort()).toEqual(['group-both', 'group-content-gen', 'group-gen']);
    expect(all.items.filter((s: any) => s.test).map((s: any) => s.id).sort()).toEqual(['group-both', 'group-test']);
    // Existing `fixture/`/examples classification must remain shared with the wire badge.
    expect((await search({ q: 'incoming-', tests: 0 })).total).toBe(0);
    expect((await search({ q: 'incoming-', tests: 1 })).total).toBe(EDGE_KINDS.length);
  });

  it('retains explicit selections but filters automatic members and all their relationships', async () => {
    const selected = await project(['filter-owner']);
    expect(selected.symbols.map((s: any) => s.id).sort()).toEqual(['filter-live', 'filter-owner']);
    expect(selected.symbols.find((s: any) => s.id === 'filter-owner').memberCount).toBe(1);
    expect(selected.excluded.symbols).toEqual({ tests: 2, generated: 2, uncertain: 2 });
    expect(selected.excluded.relations).toEqual({ tests: 2, generated: 2, uncertain: 3 });
    expect(selected.relations.map((e: any) => e.target)).toEqual(['filter-live']);
    const explicit = await project(['filter-owner', 'filter-test', 'filter-gen', 'filter-weak']);
    expect(explicit.included).toEqual(['filter-owner', 'filter-test', 'filter-gen', 'filter-weak']);
    for (const id of explicit.included) expect(explicit.symbols.some((s: any) => s.id === id)).toBe(true);
    expect(explicit.symbols.some((s: any) => s.id === 'filter-nested')).toBe(true); // independently pinned owner
    expect(explicit.relations.some((e: any) => e.target === 'filter-test' || e.target === 'filter-gen')).toBe(false);
    const testRoot = await project(['filter-test-root']);
    expect(testRoot.included).toEqual(['filter-test-root']);
    expect(testRoot.symbols.map((s: any) => s.id)).toEqual(['filter-test-root']);
    expect(testRoot.symbols[0].memberCount).toBe(0);
    const all = await project(['filter-owner'], { tests: 1, generated: 1, uncertain: 1 });
    expect(all.symbols).toHaveLength(8);
    expect(all.symbols.find((s: any) => s.id === 'filter-owner').memberCount).toBe(6);
    expect(all.excluded.symbols).toEqual({ tests: 0, generated: 0, uncertain: 0 });
  });

  it('separates eligible scope IDs from filtered ancestors retained only as identity context', async () => {
    const body = await project(['filter-owner', 'filter-nested']);
    expect(new Set(body.scopeIds)).toEqual(new Set(['filter-owner', 'filter-live', 'filter-nested']));
    expect(body.symbols.find((s: any) => s.id === 'filter-nested').ownerId).toBe('filter-weak');
    expect(body.symbols.some((s: any) => s.id === 'filter-weak')).toBe(true);
    for (const id of ['filter-weak', 'filter-test', 'filter-gen', 'filter-content', 'filter-both']) expect(body.scopeIds).not.toContain(id);
    const explicit = await project(['filter-owner', 'filter-test']);
    expect(explicit.scopeIds).toContain('filter-test'); // explicit cards still survive the filter
    expect(explicit.scopeIds).not.toContain('filter-both');
    expect((await project([])).scopeIds).toEqual([]);
  });

  it('keeps counts disjoint for overlapping reasons and applies identical filters in both directions and evidence', async () => {
    const page = await connections({ id: 'filter-origin', kind: 'references', limit: 1 });
    expect(page.total).toBe(1);
    expect(page.nextOffset).toBeNull();
    expect(page.excluded).toEqual({ symbols: { tests: 2, generated: 2, uncertain: 0 }, relations: { tests: 2, generated: 2, uncertain: 0 } });
    const both = await get('/api/board/evidence', { id: 'filter-origin', target: 'filter-both', kind: 'references' });
    expect(both.total).toBe(0);
    expect(both.excluded.relations).toEqual({ tests: 1, generated: 0, uncertain: 0 });
    expect(both.symbols.some((s: any) => s.id === 'filter-both')).toBe(true); // explicit identity context
    const generation = await get('/api/board/evidence', { id: 'filter-origin', target: 'filter-both', tests: 1 });
    expect(generation.excluded.relations).toEqual({ tests: 0, generated: 1, uncertain: 0 });
    const uncertain = await get('/api/board/evidence', { id: 'filter-origin', target: 'filter-both', tests: 1, generated: 1 });
    expect(uncertain.excluded.relations).toEqual({ tests: 0, generated: 0, uncertain: 1 });
    const visible = await get('/api/board/evidence', { id: 'filter-origin', target: 'filter-both', tests: 1, generated: 1, uncertain: 1 });
    expect(visible.total).toBe(1);
    const reverse = await connections({ id: 'filter-both', direction: 'incoming', kind: 'references' });
    expect(reverse.total).toBe(0);
    expect(reverse.excluded.relations.tests).toBe(1);
    expect((await connections({ id: 'filter-both', direction: 'incoming', kind: 'references', tests: 1, generated: 1, uncertain: 1 })).total).toBe(1);
    const canvas = await project(['filter-origin', 'filter-live', 'filter-test', 'filter-gen', 'filter-content', 'filter-both']);
    expect(canvas.relations.map((e: any) => e.id)).toEqual(page.items[0].evidence.map((e: any) => e.id));
    expect(canvas.excluded.relations).toEqual(page.excluded.relations);
  });

  it('filters original weak sites, not whole mixed-confidence targets, and preserves exact evidence paging', async () => {
    const conn = await connections({ id: 'uncertainty-root', kind: 'calls' });
    expect(conn.total).toBe(7);
    expect(conn.excluded).toEqual({ symbols: { tests: 0, generated: 0, uncertain: 3 }, relations: { tests: 0, generated: 0, uncertain: 18 } });
    const mixed = conn.items.find((r: any) => r.target.id === 'uncertainty-mixed');
    expect(mixed.total).toBe(45);
    expect(mixed.evidence).toHaveLength(MAX_BOARD_TARGET_EVIDENCE);
    const heuristic = conn.items.find((r: any) => r.target.id === 'uncertainty-heuristic');
    expect(heuristic.evidence[0]).toMatchObject({ provenance: 'heuristic', synthesizedBy: 'fixture-bridge', registeredAt: 'app/wiring.ts:5' });
    expect(conn.items.some((r: any) => r.target.id === 'uncertainty-boundary')).toBe(true); // exactly .6
    for (const suffix of ['string', 'bool', 'invalid', 'exact']) expect(conn.items.some((r: any) => r.target.id === `uncertainty-${suffix}`)).toBe(true);
    const ids: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await get('/api/board/evidence', { id: 'uncertainty-root', target: 'uncertainty-mixed', offset, limit: 13 });
      expect(page.total).toBe(45);
      expect(page.excluded.relations.uncertain).toBe(15);
      expect(page.excluded.symbols.uncertain).toBe(0); // mixed target is still visible
      endpointsResolve(page);
      ids.push(...page.items.map((e: any) => e.id));
      offset = page.nextOffset;
    }
    expect(ids).toEqual(certainEvidenceIds);
    const all = await get('/api/board/evidence', { id: 'uncertainty-root', target: 'uncertainty-mixed', uncertain: 1 });
    expect(all.items.map((e: any) => e.id)).toEqual(uncertainEvidenceIds);
    expect(all.total).toBe(60);
    const reverse = await get('/api/board/evidence', { id: 'uncertainty-mixed', target: 'uncertainty-root', direction: 'incoming', offset: 40, limit: 10 });
    expect(reverse.items.map((e: any) => e.id)).toEqual(certainEvidenceIds.slice(40));
    expect(reverse.total).toBe(45);
    const peers = await connections({ id: 'uncertainty-root', uncertain: 1 });
    expect(peers.total).toBe(10);
    expect(peers.excluded.relations.uncertain).toBe(0);
    const canvas = await project(['uncertainty-root', ...peers.items.map((r: any) => r.target.id)]);
    expect(canvas.included).toHaveLength(11); // excluded edges never remove selected cards
    expect(canvas.relations.map((e: any) => e.id).sort()).toEqual(conn.items.flatMap((r: any) => r.evidence.map((e: any) => e.id)).concat(certainEvidenceIds.slice(40)).sort());
    expect(canvas.excluded.relations).toEqual(conn.excluded.relations);
  });
});

describe('Board indexed folder and namespace groups', () => {
  it('previews all kinds with exact filtered subtree totals, not filesystem folders or prefix siblings', async () => {
    const page = await groups({ type: 'folder', q: 'group-scope', limit: 1 });
    expect(page.total).toBe(3); // scope, nested, and scopeish; test-only folder hidden
    expect(page.nextOffset).toBe(1);
    expect(page.bounded).toBe(false);
    const group = page.items[0];
    expect(group).toMatchObject({ id: 'folder:group-scope', type: 'folder', name: 'group-scope', path: 'group-scope', total: 3 });
    expect(group.byKind).toEqual([{ kind: 'class', count: 1 }, { kind: 'function', count: 1 }, { kind: 'future_node', count: 1 }]);
    expect(group.total).toBe((await search({ path: group.path })).total);
    expect(page.excluded.symbols).toEqual({ tests: 2, generated: 2, uncertain: 0 });
    const all = await groups({ type: 'folder', q: 'group-scope', tests: 1, generated: 1 });
    expect(all.total).toBe(4);
    expect(all.items.find((g: any) => g.path === 'group-scope').total).toBe(7);
    for (const item of all.items) {
      const enumeration = await search({ path: item.path, tests: 1, generated: 1 });
      expect(item.total).toBe(enumeration.total);
      expect(item.byKind.reduce((sum: number, k: any) => sum + k.count, 0)).toBe(item.total);
    }
    const paths: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const nextPage = await groups({ type: 'folder', q: 'group-scope', offset, limit: 1 });
      expect(nextPage.total).toBe(page.total);
      paths.push(...nextPage.items.map((g: any) => g.path));
      offset = nextPage.nextOffset;
    }
    expect(new Set(paths).size).toBe(page.total);
    expect((await groups({ type: 'folder', q: 'literal%_' })).items.map((g: any) => g.path)).toEqual(['literal%_']);
    expect((await groups({ type: 'folder', q: "' OR 1=1 --" })).total).toBe(0);
    const rootGroup = (await groups({ type: 'folder', limit: 100 })).items.find((g: any) => g.path === '');
    expect(rootGroup.total).toBe((await search()).total);
    expect((await groups({ type: 'folder', q: 'group-scope', offset: 999 })).nextOffset).toBeNull();
  });

  it('uses real namespace ancestors for labels, scope and previews across folders with repeated names', async () => {
    const page = await groups({ type: 'namespace', q: 'Shared' });
    expect(page.items.map((g: any) => g.id)).toEqual(['ns-a', 'ns-b']);
    expect(page.items.map((g: any) => g.total)).toEqual([5, 2]);
    expect(page.items[0].namespace).toBe('ns-a');
    expect(page.items[0].path).toBe('namespace/one.ts');
    expect(page.items[0].byKind).toEqual([{ kind: 'class', count: 1 }, { kind: 'method', count: 1 }, { kind: 'namespace', count: 2 }, { kind: 'parameter', count: 1 }]);
    const scoped = await search({ namespace: 'ns-a', limit: 2 });
    expect(scoped.total).toBe(5);
    expect(scoped.nextOffset).toBe(2);
    const all = await search({ namespace: 'ns-a', tests: 1 });
    expect(all.total).toBe(6);
    expect(all.items.map((s: any) => s.id).sort()).toEqual(['ns-a', 'ns-nested', 'ns-param', 'ns-run', 'ns-test', 'ns-type']);
    const repeated = await search({ namespace: 'ns-a', q: 'run', kind: 'method' });
    expect(repeated.items.map((s: any) => s.id)).toEqual(['ns-run']);
    expect(repeated.items[0]).toMatchObject({ ownerId: 'ns-type', namespace: 'unrelated/nested.ts::Inner' });
    expect((await search({ namespace: 'ns-b', kind: 'method' })).items.map((s: any) => s.id)).toEqual(['ns-other-run']);
    expect((await search({ namespace: 'ns-a', path: 'other-dir' })).total).toBe(3);
    expect((await groups({ type: 'namespace', q: 'group-scope' })).total).toBe(0); // no fake folder namespaces
    expect((await groups({ type: 'namespace', q: 'Shared', limit: 1, offset: 1 })).items[0].id).toBe('ns-b');
    expect((await groups({ type: 'namespace', q: 'Shared', tests: 1 })).items[0].total).toBe(all.total);
    const deep = await groups({ type: 'namespace', q: 'deep-0' });
    expect(deep.items[0].total).toBe(70); // previews/enumeration are not projection-capped
    expect((await search({ namespace: 'deep-0' })).total).toBe(70);
  });
});

describe('Board direct member paging and filter-aware counts', () => {
  it('uses deterministic declaration source order and distinct direct children, not recursive scope', async () => {
    const first = await members({ id: 'outline-root', limit: 2 });
    expect(first.items.map((s: any) => s.id)).toEqual(['outline-b', 'outline-a']);
    expect(first.items.map((s: any) => [s.line, s.startColumn])).toEqual([[3, 1], [3, 4]]);
    expect(first.symbols.find((s: any) => s.id === 'outline-a').startColumn).toBe(4);
    expect(first.total).toBe(3);
    expect(first.nextOffset).toBe(2);
    expect(first.symbols.find((s: any) => s.id === 'outline-root').memberCount).toBe(3);
    const second = await members({ id: 'outline-root', offset: first.nextOffset, limit: 2 });
    expect(second.items.map((s: any) => s.id)).toEqual(['outline-z']);
    expect(second.nextOffset).toBeNull();
    const snapshot = await project(['outline-root']);
    const sourceOrdered = snapshot.symbols.filter((s: any) => s.ownerId === 'outline-root')
      .sort((a: any, b: any) => a.line - b.line || a.startColumn - b.startColumn || a.id.localeCompare(b.id));
    expect(sourceOrdered.map((s: any) => s.id)).toEqual(['outline-b', 'outline-a', 'outline-z']);
    expect((await search({ path: 'outline', q: 'duplicate' })).items.map((s: any) => s.startColumn)).toEqual([1, 4, 0]);
    expect((await connections({ id: 'outline-root', kind: 'contains' })).items.map((r: any) => r.target.startColumn)).toEqual([1, 4, 0]);
    const kinds = await members({ id: 'all-kind-owner' });
    expect(new Set(kinds.items.map((s: any) => s.kind))).toEqual(new Set([...NODE_KINDS, 'future_node']));
    const nested = await members({ id: 'ns-run' });
    expect(nested.items.map((s: any) => s.id)).toEqual(['ns-param']);
    const byId = new Map(nested.symbols.map((s: any) => [s.id, s]));
    for (const id of ['ns-run', 'ns-type', 'ns-nested', 'ns-a']) expect(byId.has(id)).toBe(true);
    expect(nested.items[0]).toMatchObject({ ownerId: 'ns-run', namespace: 'unrelated/nested.ts::Inner' });
    expect((await members({ id: 'ns-param' })).items).toEqual([]);
    expect((await members({ id: 'outline-root', offset: 99 })).nextOffset).toBeNull();
  });

  it('pages members beyond the projection selection scope cap', async () => {
    const page = await members({ id: 'wide', offset: MAX_BOARD_SCOPE - 1 });
    expect(page.total).toBe(MAX_BOARD_SCOPE + 5);
    expect(page.items.map((s: any) => s.id)).toEqual(Array.from({ length: 6 }, (_, i) => `wide-${String(MAX_BOARD_SCOPE - 1 + i).padStart(4, '0')}`));
    expect(page.nextOffset).toBeNull();
    expect(page.bounded).toBe(false);
    const ids = new Set(page.symbols.map((s: any) => s.id));
    for (const child of page.items) expect(ids.has(child.ownerId)).toBe(true);
  });

  it('aligns filtered memberCount across projection, search, Connections and member paging', async () => {
    const page = await members({ id: 'filter-owner' });
    expect(page.total).toBe(1);
    expect(page.items.map((s: any) => s.id)).toEqual(['filter-live']);
    expect(page.excluded.symbols).toEqual({ tests: 2, generated: 2, uncertain: 1 });
    const owner = page.symbols.find((s: any) => s.id === 'filter-owner');
    expect(owner.memberCount).toBe(page.total);
    expect((await search({ q: 'filter-owner' })).items[0].memberCount).toBe(page.total);
    expect((await project(['filter-owner'])).symbols.find((s: any) => s.id === 'filter-owner').memberCount).toBe(page.total);
    expect((await connections({ id: 'filter-owner', kind: 'contains' })).scope.memberCount).toBe(page.total);
    const all = await members({ id: 'filter-owner', tests: 1, generated: 1, uncertain: 1 });
    expect(all.total).toBe(6);
    expect(all.symbols.find((s: any) => s.id === 'filter-owner').memberCount).toBe(6);
    expect((await members({ id: 'filter-test-root' })).total).toBe(0);
    expect((await members({ id: 'filter-test-root', tests: 1 })).total).toBe(1);
  });
});

describe('Board source navigation context', () => {
  it('returns ordered proven enclosing types through wrappers, plus the exact file', async () => {
    const context = await sourceContext('sc-method');
    expect(context.symbol.id).toBe('sc-method');
    expect(context.containers.map((item: any) => item.id)).toEqual(['sc-inner', 'sc-outer', 'sc-file']);
    expect(context.symbols.find((item: any) => item.id === 'sc-method').ownerId).toBe('sc-inner');
    expect(context.bounded).toBe(false);
    expect(context).not.toHaveProperty('relations');
  });
  it('finds a free function’s exact file without containment or path-prefix guessing', async () => {
    const context = await sourceContext('sc-free');
    expect(context.containers.map((item: any) => item.id)).toEqual(['sc-file']);
    expect(context.symbol.ownerId).toBeUndefined();
    expect(context.symbols.some((item: any) => item.id === 'sc-other-file')).toBe(false);
  });
  it('keeps the origin file even when a partial type owner is declared in another file', async () => {
    const context = await sourceContext('sc-partial-method');
    expect(context.containers.map((item: any) => item.id)).toEqual(['sc-partial-owner', 'sc-file']);
    expect(context.containers.at(-1).file).toBe('source-context/exact.ts');
  });
  it('does not guess missing or duplicate file identities', async () => {
    const duplicate = await sourceContext('sc-duplicate-origin');
    expect(duplicate.containers).toEqual([]); expect(duplicate.notes.join(' ')).toContain('no unique indexed file');
    const missing = await sourceContext('unproven');
    expect(missing.containers.map((item: any) => item.id)).toEqual(['file-owner']);
    const noFile = await sourceContext('same-b');
    expect(noFile.containers).toEqual([]); expect(noFile.notes.join(' ')).toContain('no unique indexed file');
  });
  it('withholds ambiguous/cyclic ownership but still offers a unique exact file', async () => {
    for (const id of ['sc-ambiguous', 'sc-cycle-a']) {
      const context = await sourceContext(id);
      expect(context.symbol.ownerId).toBeUndefined();
      expect(context.containers.map((item: any) => item.id)).toEqual(['sc-file']);
    }
    const missingParent = await sourceContext('orphan');
    expect(missingParent.symbol.ownerId).toBeUndefined();
    expect(missingParent.notes.join(' ')).toContain('Missing contains parent');
  });
  it('keeps depth limits explicit and supports genuinely extracted ownership', async () => {
    expect((await sourceContext('sb-too-deep')).bounded).toBe(true);
    const results = await search({ q: 'freeSecond' });
    const origin = results.items.find((item: any) => item.name === 'freeSecond');
    const context = await sourceContext(origin.id);
    expect(context.containers.at(-1)).toMatchObject({ kind: 'file', file: 'src/siblings.ts' });
  });
});

describe('Board read-only sibling source discovery', () => {
  it('uses real TypeScript and Python owners, preserving overloads and excluding local functions/other classes', async () => {
    for (const file of ['src/siblings.ts', 'src/siblings.py']) {
      const found = await search({ path: file });
      const origin = found.items.find((item: any) => item.name === 'first');
      const page = await siblings({ id: origin.id });
      expect(page.scope.kind).toBe('type');
      expect(page.items.every((item: any) => item.name === 'second')).toBe(true);
      expect(page.items).toHaveLength(file.endsWith('.ts') ? 3 : 1);
      expect(new Set(page.items.map((item: any) => item.id)).size).toBe(page.items.length);
      expect(page.nextOffset).toBeNull();
    }
  });

  it('uses the nearest exact type across namespace wrappers and keeps same-name overload IDs/source ordering', async () => {
    const page = await siblings({ id: 'sb-origin', limit: 2 });
    expect(page.scope).toEqual({ kind: 'type', id: 'sb-owner', label: 'sibling/main.ts::sb-owner' });
    expect(page.total).toBe(3);
    expect(page.items.map((item: any) => item.id)).toEqual(['sb-wrapped', 'sb-overload-a']);
    expect(page.nextOffset).toBe(2);
    expect(page.bounded).toBe(false);
    expect((await siblings({ id: 'sb-origin', offset: 2 })).items.map((item: any) => item.id)).toEqual(['sb-overload-b']);
    expect(page.notes.join(' ')).toMatch(/Origin excluded/);
    const wrapped = await siblings({ id: 'sb-wrapped' });
    expect(wrapped.scope.id).toBe('sb-owner');
    expect(wrapped.items.map((item: any) => item.id)).toEqual(['sb-origin', 'sb-overload-a', 'sb-overload-b']);
    const inner = await siblings({ id: 'sb-inner-method' });
    expect(inner.scope.id).toBe('sb-inner-type');
    expect(inner.total).toBe(0);
  });

  it('returns exact-file top-level functions only, including indexed namespace/root functions', async () => {
    const page = await siblings({ id: 'sb-free-origin' });
    expect(page.scope).toEqual({ kind: 'file', label: 'sibling/main.ts' });
    expect(page.items.map((item: any) => item.id).sort()).toEqual(['sb-free-peer', 'sb-free-wrapped', 'sb-root-function']);
    expect(page.total).toBe(3);
    const actual = await search({ path: 'src/siblings.ts', q: 'freeFirst' });
    expect((await siblings({ id: actual.items[0].id })).items.map((item: any) => item.name)).toEqual(['freeSecond']);
  });

  it('applies normal disjoint test/generated/uncertain filters to ownership evidence', async () => {
    const page = await siblings({ id: 'sb-origin' });
    expect(page.excluded.symbols).toEqual({ tests: 2, generated: 2, uncertain: 1 });
    expect(page.excluded.relations).toEqual({ tests: 0, generated: 0, uncertain: 0 });
    const all = await siblings({ id: 'sb-origin', tests: 1, generated: 1, uncertain: 1 });
    expect(all.total).toBe(8);
    expect(all.excluded.symbols).toEqual({ tests: 0, generated: 0, uncertain: 0 });
    const weakOrigin = await siblings({ id: 'sb-weak' });
    expect(weakOrigin.total).toBe(0);
    expect(weakOrigin.excluded.symbols).toEqual({ tests: 2, generated: 2, uncertain: 4 });
  });

  it('never guesses ambiguous, nested-local, cyclic, missing or non-callable scopes', async () => {
    for (const id of ['sb-ambiguous', 'sb-local', 'sb-free-local', 'sb-orphan-method', 'sb-missing-function', 'cycle-a', 'orphan', 'partially-ambiguous', 'sb-owner']) {
      const page = await siblings({ id });
      expect(page.scope.kind, id).toBe('unavailable');
      expect(page.total, id).toBe(0);
      expect(page.notes.length, id).toBeGreaterThan(0);
    }
  });

  it('bounds deep proof explicitly while paging hubs beyond the projection scope cap', async () => {
    const deep = await siblings({ id: 'sb-deep-origin' });
    expect(deep.bounded).toBe(true);
    expect(deep.total).toBe(0);
    expect(deep.notes.join(' ')).toMatch(/totals cover only proven candidates/);
    const origin = await siblings({ id: 'sb-too-deep' });
    expect(origin.scope.kind).toBe('unavailable');
    expect(origin.bounded).toBe(true);
    const first = await siblings({ id: 'sb-wide-origin', limit: 2 });
    expect(first.total).toBe(MAX_BOARD_SCOPE + 3);
    expect(first.nextOffset).toBe(2);
    expect(first.bounded).toBe(false);
    const last = await siblings({ id: 'sb-wide-origin', offset: MAX_BOARD_SCOPE + 2 });
    expect(last.items.map((item: any) => item.id)).toEqual([`sb-wide-${MAX_BOARD_SCOPE + 2}`]);
    expect(last.nextOffset).toBeNull();
    expect((await siblings({ id: 'sb-wide-origin', offset: 99999 })).items).toEqual([]);
  });
});

describe('Board snapshot consistency', () => {
  it('keeps counts, file classification, pages and facts in one snapshot and refreshes on the next request', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-board-snapshot-'));
    const cg = CodeGraph.initSync(projectRoot);
    let writer: DatabaseConnection | undefined;
    try {
      const node: Node = { id: 'snapshot-owner', kind: 'module', name: 'snapshot-owner', qualifiedName: 'snapshot-owner', filePath: 'live.ts',
        language: 'typescript', startLine: 1, endLine: 10, startColumn: 0, endColumn: 1 };
      cg['queries'].insertNode(node);
      cg['queries'].insertNode({ ...node, id: 'snapshot-child', name: 'child', qualifiedName: 'child' });
      cg['queries'].insertEdge({ source: node.id, target: 'snapshot-child', kind: 'contains' });
      cg['db'].getDb().prepare(`INSERT INTO files(path,content_hash,language,size,modified_at,indexed_at) VALUES ('live.ts','x','typescript',0,0,0)`).run();
      writer = DatabaseConnection.open(getDatabasePath(projectRoot));
      const graph = new BoardGraph(cg);
      graph.snapshot(() => {
        expect(graph.search('', undefined, undefined, 0, 10).total).toBe(2);
        writer!.getDb().prepare("UPDATE files SET generated=1 WHERE path='live.ts'").run();
        new QueryBuilder(writer!.getDb()).insertNode({ ...node, id: 'snapshot-new', name: 'new', qualifiedName: 'new' });
        expect(graph.search('', undefined, undefined, 0, 10).total).toBe(2);
        expect(graph.members(node.id, 0, 50, {}).total).toBe(1);
        expect(graph.facts([node.id], []).facts.get(node.id)!.memberCount).toBe(1);
      });
      graph.snapshot(() => {
        const current = graph.search('', undefined, undefined, 0, 10);
        expect(current.total).toBe(0);
        expect(current.excluded.generated).toBe(3);
        expect(graph.members(node.id, 0, 50, {}).total).toBe(0);
        expect(graph.facts([node.id], []).facts.get(node.id)!.memberCount).toBe(0);
        expect(graph.search('', undefined, undefined, 0, 10, { includeGenerated: true }).total).toBe(3);
      });
    } finally {
      writer?.close(); cg.close(); fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('Board validation and read-only boundary', () => {
  it.each([
    ['/api/board', {}], ['/api/board', { ids: '{}' }], ['/api/board', { ids: '[null]' }],
    ['/api/board', { ids: JSON.stringify(Array(129).fill('owner')) }],
    ['/api/board/search', { offset: '-1' }], ['/api/board/search', { limit: '0' }],
    ['/api/board/search', { limit: '101' }], ['/api/board/search', { offset: '1.2' }],
    ['/api/board/search?kind=class&kind=struct', {}],
    ['/api/board/search', { q: '\u0000' }],
    ['/api/board/search', { path: '../outside' }], ['/api/board/search', { path: '/etc' }],
    ['/api/board/search', { path: 'C:\\outside' }], ['/api/board/search', { projectPath: '/elsewhere' }],
    ['/api/board/connections', {}], ['/api/board/connections', { id: 'owner', direction: 'sideways' }],
    ['/api/board/connections', { id: 'owner', members: 'true' }],
    ['/api/board/evidence', { id: 'owner' }], ['/api/board/evidence', { id: 'owner', target: 'same-a', limit: 201 }],
    ['/api/board', { ids: '[]', tests: 'true' }], ['/api/board', { ids: '[]', generated: '' }],
    ['/api/board/search', { uncertain: '2' }], ['/api/board/search?tests=1&tests=0', {}],
    ['/api/board/search', { namespace: '\u0000' }],
    ['/api/board/groups', {}], ['/api/board/groups', { type: 'directory' }],
    ['/api/board/groups', { type: 'folder', tests: 'yes' }], ['/api/board/groups', { type: 'namespace', generated: '-1' }],
    ['/api/board/groups', { type: 'folder', limit: 101 }], ['/api/board/groups', { type: 'folder', q: '\u0000' }],
    ['/api/board/groups?type=folder&type=namespace', {}], ['/api/board/groups', { type: 'folder', projectPath: '/elsewhere' }],
    ['/api/board/members', {}], ['/api/board/members', { id: 'owner', uncertain: 'true' }],
    ['/api/board/members', { id: 'owner', limit: 0 }], ['/api/board/members', { id: 'owner', offset: -1 }],
    ['/api/board/members', { id: 'owner', root: '/elsewhere' }],
    ['/api/board/source-context', {}],
    ['/api/board/source-context', { id: 'sc-method', root: '/elsewhere' }],
    ['/api/board/source-context?id=sc-method&id=sc-free', {}],
    ['/api/board/sibling-sources', {}],
    ['/api/board/sibling-sources', { id: 'sb-origin', root: '/elsewhere' }],
    ['/api/board/sibling-sources', { id: 'sb-origin', offset: '-1' }],
    ['/api/board/sibling-sources', { id: 'sb-origin', limit: '101' }],
    ['/api/board/sibling-sources', { id: 'sb-origin', uncertain: 'true' }],
    ['/api/board/connections', { id: 'owner', generated: 'true' }],
    ['/api/board/evidence', { id: 'owner', target: 'member', uncertain: '' }],
  ])('rejects invalid requests: %s %j', async (endpoint, params) => {
    expect((await request(endpoint as string, params as Record<string, string>)).status).toBe(400);
  });

  it('returns not-found for missing scopes without fuzzy/name fallback', async () => {
    expect((await request('/api/board/connections', { id: 'Same' })).status).toBe(404);
    expect((await request('/api/board/evidence', { id: 'owner', target: 'gone' })).status).toBe(404);
    expect((await request('/api/board/members', { id: 'gone' })).status).toBe(404);
    expect((await request('/api/board/search', { namespace: 'gone' })).status).toBe(404);
    expect((await request('/api/board/search', { namespace: 'owner' })).status).toBe(404);
    expect((await request('/api/board/search', { namespace: "' OR 1=1 --" })).status).toBe(404);
  });

  it('supports HEAD, advertises read endpoints and never creates board metadata', async () => {
    expect((await request('/api/board', { ids: '[]' }, 'HEAD')).status).toBe(200);
    expect((await request('/api/board/groups', { type: 'folder' }, 'HEAD')).status).toBe(200);
    expect((await request('/api/board/members', { id: 'owner' }, 'HEAD')).status).toBe(200);
    expect((await request('/api/board/source-context', { id: 'sc-method' }, 'HEAD')).status).toBe(200);
    expect((await request('/api/board/source-context', { id: 'not-indexed' })).status).toBe(404);
    expect((await request('/api/board/source-context', { id: 'sc-method' }, 'POST')).status).toBe(403);
    expect((await request('/api/board/sibling-sources', { id: 'sb-origin' }, 'HEAD')).status).toBe(200);
    expect((await request('/api/board/sibling-sources', { id: 'not-indexed' })).status).toBe(404);
    expect((await request('/api/board/sibling-sources', { id: 'sb-origin' }, 'POST')).status).toBe(403);
    const index = await get('/api');
    expect(index.endpoints.map((e: any) => e.path)).toEqual(expect.arrayContaining(['/api/board', '/api/board/search', '/api/board/groups', '/api/board/members', '/api/board/sibling-sources', '/api/board/connections', '/api/board/evidence']));
    const refused = await request('/api/board', { ids: '[]' }, 'POST');
    expect(refused.status).not.toBe(200);
    expect(fs.existsSync(path.join(root, '.codegraph/ui/boards'))).toBe(false);
    expect(metadataFiles()).toEqual(beforeFiles);
    expect(databaseHash()).toBe(beforeDb);
    expect(fs.readFileSync(path.join(root, 'src/live.ts'), 'utf8')).toContain('export class Actual');
  });
});
