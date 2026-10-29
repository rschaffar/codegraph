import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import CodeGraph from '../src/index';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';
import { createHttpAdapter, ApiFailure } from '../ui/src/lib/adapter';
import { createBoardModel } from '../ui/src/lib/board-model';
import type { BoardDocument } from '../ui/src/lib/board-wire';

let root: string;
let writable: UiServerHandle;
let readOnly: UiServerHandle;
let api: GraphApi;
let readonlyApi: GraphApi;
const source = `export class Factory { build(): string { return normalize(' 1 '); } }
export function normalize(value: string): string { return value.trim(); }
`;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'codegraph-board-integrated-'));
  writeFileSync(join(root, 'review.ts'), source);
  const cg = CodeGraph.initSync(root, { config: { include: ['*.ts'], exclude: [] } });
  await cg.indexAll(); cg.resolveReferences(); cg.close();
  const viewer = join(root, 'viewer'); mkdirSync(viewer); writeFileSync(join(viewer, 'index.html'), '<div id="app"></div>');
  api = createGraphApi({ projectRoot: root }); readonlyApi = createGraphApi({ projectRoot: root, readOnly: true });
  writable = await startUiServer({ projectRoot: root, viewerDir: viewer, port: 0, api: api.handler });
  readOnly = await startUiServer({ projectRoot: root, viewerDir: viewer, port: 0, api: readonlyApi.handler });
}, 120000);
afterAll(async () => { api?.close(); readonlyApi?.close(); await writable?.close(); await readOnly?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

describe('live Board adapter → guarded server integration', () => {
  it('discovers real targets, projects explicit membership and saves/reopens metadata only', async () => {
    const adapter = createHttpAdapter({ baseUrl: `${writable.url}/` });
    const search = await adapter.boardSearch!({ q: 'Factory', kind: 'class' });
    const factory = search.items.find((item) => item.name === 'Factory')!;
    expect(factory).toBeDefined();
    const snapshot = await adapter.board!([factory.id]);
    expect(snapshot.included).toEqual([factory.id]);
    const connection = await adapter.boardConnections!({ id: factory.id, direction: 'outgoing', members: true, kind: 'calls' });
    const normalized = connection.items.find((row) => row.target.name === 'normalize')!;
    expect(normalized).toBeDefined();
    const second = await adapter.board!([factory.id, normalized.target.id]);
    const model = createBoardModel(second.symbols, second.relations);
    expect(model.projectBoard(second.included, [], []).symbols).toHaveLength(2);
    expect(model.projectBoard(second.included, [normalized.target.id], []).symbols).toHaveLength(1);
    const document: BoardDocument = {
      version: 1,
      symbols: [factory, normalized.target].map((item, index) => ({ key: `s${index}`, identity: { id: item.id, qualifiedName: item.qualifiedName, kind: item.kind, file: item.file, ...(item.signature ? { signature: item.signature } : {}) }, position: { x: index * 400, y: 80 }, included: true, hidden: index === 1, expanded: index === 0 })),
      cards: [{ key: 'c0', symbolKey: 's1', position: { x: 10, y: 700 }, width: 600, height: 400, collapsed: true, zIndex: 12 }],
      viewport: { x: -10, y: 20, zoom: .8 }, filters: { kind: '', showStructure: false },
    };
    const saved = await adapter.saveBoard!({ name: 'Factory review', document });
    expect(saved.name).toBe('Factory review');
    const reopened = await adapter.loadBoard!(saved.id);
    expect(reopened.board).toEqual(document);
    expect(reopened.resolutions.every((item) => item.node && item.status === 'ok')).toBe(true);
    const content = readFileSync(join(root, '.codegraph/ui/boards', `${saved.id}.json`), 'utf8');
    expect(content).not.toContain('return value.trim');
    expect(JSON.parse(content).document).not.toHaveProperty('relations');
    expect(readFileSync(join(root, 'review.ts'), 'utf8')).toBe(source);
    expect((await adapter.boards!()).boards.some((item) => item.id === saved.id)).toBe(true);
    const resolved = await adapter.resolveBoard!(document);
    expect(resolved.resolutions).toHaveLength(2);
    await expect(adapter.saveBoard!({ name: 'Factory review', document })).rejects.toMatchObject({ status: 409 });
    await adapter.deleteBoard!(saved.id);
    expect((await adapter.boards!()).boards).toEqual([]);
  });

  it('enforces marker/Origin and read-only refusal; in-memory resolution is still allowed', async () => {
    const adapter = createHttpAdapter({ baseUrl: `${readOnly.url}/` });
    const empty: BoardDocument = { version: 1, symbols: [], cards: [], viewport: { x: 0, y: 0, zoom: 1 }, filters: { kind: '', showStructure: false } };
    expect((await adapter.boards!()).readOnly).toBe(true);
    await expect(adapter.saveBoard!({ name: 'Denied', document: empty })).rejects.toBeInstanceOf(ApiFailure);
    await expect(adapter.deleteBoard!('denied')).rejects.toMatchObject({ status: 403 });
    expect((await adapter.resolveBoard!(empty)).board).toEqual(empty);
    const noMarker = await fetch(`${writable.url}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'No marker', document: empty }) });
    expect(noMarker.status).toBe(403);
    const foreign = await fetch(`${writable.url}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-CodeGraph-UI': '1', origin: 'https://not-local.example' }, body: JSON.stringify({ name: 'Cross origin', document: empty }) });
    expect(foreign.status).toBe(403);
    expect(existsSync(join(root, '.codegraph/ui/boards/denied.json'))).toBe(false);
  });
});
