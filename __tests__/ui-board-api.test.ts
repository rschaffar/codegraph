import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { createHash } from 'crypto';
import CodeGraph from '../src/index';
import { NODE_KINDS, EDGE_KINDS, type Node, type NodeKind, type EdgeKind } from '../src/types';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';
import { MAX_BOARD_SCOPE, MAX_BOARD_RELATIONS, MAX_BOARD_TARGET_EVIDENCE } from '../src/graph/board-projection';

let root: string;
let server: UiServerHandle;
let api: GraphApi;
let evidenceIds: string[];
let beforeFiles: string[];
let beforeDb: string;
const databaseHash = () => createHash('sha256').update(fs.readFileSync(path.join(root, '.codegraph/codegraph.db'))).digest('hex');
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
const project = (ids: string[]) => get('/api/board', { ids: JSON.stringify(ids) });
const connections = (params: Record<string, string | number>) => get('/api/board/connections', params);
const search = (params: Record<string, string | number> = {}) => get('/api/board/search', params);

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
  const cg = CodeGraph.initSync(root);
  await cg.indexAll();
  cg.resolveReferences();
  const queries = cg['queries'];
  const db = cg['db'].getDb();
  const add = (id: string, kind: NodeKind = 'function', file = 'fixture/main.ts', name = id): void => {
    const node: Node = { id, kind, name, qualifiedName: `${file}::${name}`, filePath: file,
      language: 'typescript', startLine: 2, endLine: 10, startColumn: 0, endColumn: 1 };
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
    for (let i = 0; i < 70; i++) {
      add(`deep-${i}`, 'namespace', 'deep/contents.ts');
      if (i) edge(`deep-${i - 1}`, `deep-${i}`, 'contains');
    }
    db.prepare(`INSERT INTO unresolved_refs(from_node_id, reference_name, reference_kind, line, col)
      VALUES ('member', 'uninstalledPackage', 'calls', 15, 2)`).run();
    // Simulate an older/imported corrupt index without inventing a node.
    // Foreign keys are normally on, so insert the dangling boundary separately.
  })();
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO edges(source,target,kind,line) VALUES ('member','outside-index','calls',16), ('missing-parent','orphan','contains',1), ('missing-parent','partially-ambiguous','contains',1)").run();
  db.pragma('foreign_keys = ON');
  evidenceIds = db.prepare("SELECT id FROM edges WHERE source='evidence-hub' ORDER BY id").all().map((r: any) => String(r.id));
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
    const body = await project(['owner', 'same-a', 'owner', 'missing-id']);
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

describe('Board Connections are independent of canvas membership', () => {
  it('discovers every kind in both directions, including contains and unselected test targets', async () => {
    for (const kind of EDGE_KINDS) {
      const outgoing = await connections({ id: 'member', direction: 'outgoing', kind });
      expect(outgoing.items.some((r: any) => r.target.id === `peer-${kind}`)).toBe(true);
      expect(outgoing.items.flatMap((r: any) => r.evidence).every((e: any) => e.kind === kind)).toBe(true);
      endpointsResolve(outgoing);
      const incoming = await connections({ id: 'member', direction: 'incoming', kind });
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
    const body = await connections({ id: 'member', q: 'generated/' });
    expect(body.items.map((r: any) => r.target.id).sort()).toEqual(['generated-content-peer', 'generated-peer']);
    expect(body.items.every((r: any) => r.target.generated === true)).toBe(true);
  });

  it('distinguishes member-only and recursive member scope with exact direction and original endpoint IDs', async () => {
    expect((await connections({ id: 'owner', members: 0, kind: 'calls' })).total).toBe(0);
    const body = await connections({ id: 'owner', members: 1, kind: 'calls' });
    expect(body.withMembers).toBe(true);
    expect(body.total).toBe(3); // peer-calls + two identically named methods
    expect(body.items.every((r: any) => r.evidence.every((e: any) => e.source === 'member'))).toBe(true);
    expect(body.notes.join(' ')).toMatch(/1 unresolved/);
    expect(body.notes.join(' ')).toMatch(/1 indexed relationships/);
    const same = body.items.find((r: any) => r.target.id === 'same-a');
    expect(same.owner.id).toBe('same-owner');
    expect(same.evidence[0]).toMatchObject({ kind: 'calls', confidence: 0.21, provenance: 'heuristic', synthesizedBy: 'fixture-callback', via: 'callback', registeredAt: 'fixture/wiring.ts:9', resolvedBy: 'name-only', line: 11, col: 3, file: 'fixture/main.ts' });
    endpointsResolve(body);
    const incoming = await connections({ id: 'owner', members: 1, direction: 'incoming', kind: 'calls' });
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
    expect((await connections({ id: 'member', q: 'one/a.ts', kind: 'calls' })).items[0].target.id).toBe('same-a');
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
    const conn = await connections({ id: 'owner', members: 1, kind: 'calls', q: 'Same' });
    expect(conn.total).toBe(2);
    const body = await get('/api/board/evidence', { id: 'owner', target: 'same-a', members: 1, kind: 'calls', q: 'Same' });
    expect(body.items).toEqual(conn.items.find((r: any) => r.target.id === 'same-a').evidence);
    endpointsResolve(body);
    expect((await get('/api/board/evidence', { id: 'owner', target: 'same-a', members: 0, kind: 'calls' })).total).toBe(0);
    expect((await get('/api/board/evidence', { id: 'owner', target: 'same-a', members: 1, kind: 'references' })).total).toBe(0);
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
  ])('rejects invalid requests: %s %j', async (endpoint, params) => {
    expect((await request(endpoint as string, params as Record<string, string>)).status).toBe(400);
  });

  it('returns not-found for missing scopes without fuzzy/name fallback', async () => {
    expect((await request('/api/board/connections', { id: 'Same' })).status).toBe(404);
    expect((await request('/api/board/evidence', { id: 'owner', target: 'gone' })).status).toBe(404);
  });

  it('supports HEAD, advertises read endpoints and never creates board metadata', async () => {
    expect((await request('/api/board', { ids: '[]' }, 'HEAD')).status).toBe(200);
    const index = await get('/api');
    expect(index.endpoints.map((e: any) => e.path)).toEqual(expect.arrayContaining(['/api/board', '/api/board/search', '/api/board/connections', '/api/board/evidence']));
    const refused = await request('/api/board', { ids: '[]' }, 'POST');
    expect(refused.status).not.toBe(200);
    expect(fs.existsSync(path.join(root, '.codegraph/ui/boards'))).toBe(false);
    expect(metadataFiles()).toEqual(beforeFiles);
    expect(databaseHash()).toBe(beforeDb);
    expect(fs.readFileSync(path.join(root, 'src/live.ts'), 'utf8')).toContain('export class Actual');
  });
});
