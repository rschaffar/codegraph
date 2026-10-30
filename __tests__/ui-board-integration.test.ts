import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as http from 'node:http';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { indexFingerprint } from './index-fingerprint';
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
const longIds = Array.from({ length: 128 }, (_, index) => `function:long-${index}:`.padEnd(2048, 'x'));
const source = `export class Factory { build(): string { return normalize(' 1 '); } }
export function normalize(value: string): string { return value.trim(); }
`;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'codegraph-board-integrated-'));
  writeFileSync(join(root, 'review.ts'), source);
  const cg = CodeGraph.initSync(root, { config: { include: ['*.ts'], exclude: [] } });
  await cg.indexAll(); cg.resolveReferences();
  for (const [index, id] of longIds.entries()) cg['queries'].insertNode({ id, kind: 'function', name: `long${index}`,
    qualifiedName: `Long.long${index}`, filePath: 'review.ts', language: 'typescript', startLine: 10 + index,
    endLine: 10 + index, startColumn: 0, endColumn: 1 });
  cg.close();
  const viewer = join(root, 'viewer'); mkdirSync(viewer); writeFileSync(join(viewer, 'index.html'), '<div id="app"></div>');
  api = createGraphApi({ projectRoot: root }); readonlyApi = createGraphApi({ projectRoot: root, readOnly: true });
  writable = await startUiServer({ projectRoot: root, viewerDir: viewer, port: 0, api: api.handler });
  readOnly = await startUiServer({ projectRoot: root, viewerDir: viewer, port: 0, api: readonlyApi.handler });
}, 120000);
afterAll(async () => { api?.close(); readonlyApi?.close(); await writable?.close(); await readOnly?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

function post(server: UiServerHandle, body: string, headers: Record<string, string> = {}, endpoint = '/api/board', chunked = false): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.port, path: endpoint, method: 'POST', setHost: false,
      headers: { Host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', 'X-CodeGraph-UI': '1',
        ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(Buffer.byteLength(body)) }), ...headers } }, (response) => {
      const chunks: Buffer[] = []; response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    if (chunked) { const middle = Math.floor(body.length / 2); request.write(body.slice(0, middle)); request.end(body.slice(middle)); }
    else request.end(body);
  });
}

describe('live Board adapter → guarded server integration', () => {
  it.each([64, 128])('projects %i maximum-length identities without an oversized URL or index mutation', async (count) => {
    const ids = longIds.slice(0, count);
    expect(Buffer.byteLength(`/api/board?${new URLSearchParams({ ids: JSON.stringify(ids) })}`)).toBeGreaterThan(http.maxHeaderSize);
    const reader = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
    try {
      const before = indexFingerprint(reader.getDb(), getDatabasePath(root));
      const hadMetadata = existsSync(join(root, '.codegraph/ui'));
      for (const server of [writable, readOnly]) {
        const adapter = createHttpAdapter({ baseUrl: `${server.url}/` });
        const result = await adapter.board!(ids, undefined, { tests: false, generated: false, uncertain: false });
        expect(result.included).toEqual(ids); expect(result.missing).toEqual([]);
      }
      expect(indexFingerprint(reader.getDb(), getDatabasePath(root))).toEqual(before);
      expect(existsSync(join(root, '.codegraph/ui'))).toBe(hadMetadata);
    } finally { reader.close(); }
  });

  it('retains short GET/HEAD compatibility with the same projection and boolean filters', async () => {
    const ids = [longIds[0]]; const flags = { tests: true, generated: false, uncertain: true };
    const adapter = createHttpAdapter({ baseUrl: `${readOnly.url}/` });
    const result = await adapter.board!(ids, undefined, flags);
    const endpoint = `${readOnly.url}/api/board?${new URLSearchParams({ ids: JSON.stringify(ids), tests: '1', generated: '0', uncertain: '1' })}`;
    expect(await (await fetch(endpoint)).json()).toEqual(result);
    const head = await fetch(endpoint, { method: 'HEAD' }); expect(head.status).toBe(200); expect(await head.text()).toBe('');
  });

  it('keeps Host/Origin/marker/content-type gates on body-based reads', async () => {
    const body = JSON.stringify({ ids: [] });
    expect((await post(readOnly, body)).status).toBe(200);
    for (const headers of [{ 'X-CodeGraph-UI': '' }, { Host: 'foreign.example' }, { Host: `127.0.0.1:${readOnly.port + 1}` },
      { origin: 'https://foreign.example' }, { origin: 'null' }, { origin: `http://127.0.0.1:${readOnly.port + 1}` },
      { 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' }]) {
      expect((await post(readOnly, body, headers)).status, JSON.stringify(headers)).toBe(403);
    }
    const missingMarker = await fetch(`${readOnly.url}/api/board`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(missingMarker.status).toBe(403);
  });

  it('rejects malformed/ambiguous projection bodies without weakening selection bounds', async () => {
    for (const body of ['', '{', 'null', '[]', '{}', JSON.stringify({ ids: '[]' }), JSON.stringify({ ids: [''] }),
      JSON.stringify({ ids: ['x'.repeat(2049)] }), JSON.stringify({ ids: Array(129).fill('same') }),
      JSON.stringify({ ids: ['x\n'] }), JSON.stringify({ ids: [], tests: '1' }), JSON.stringify({ ids: [], projectPath: '/outside' })]) {
      expect((await post(readOnly, body)).status, body.slice(0, 60)).toBe(400);
    }
    expect((await post(readOnly, JSON.stringify({ ids: [] }), {}, '/api/board?tests=1')).status).toBe(400);
  });

  it.each([false, true])('bounds incoming bytes for oversized multibyte bodies (chunked=%s)', async (chunked) => {
    const body = JSON.stringify({ ids: ['界'.repeat(350_000)] });
    expect(body.length).toBeLessThan(1024 * 1024); expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024);
    try {
      const response = await post(readOnly, body, {}, '/api/board', chunked);
      expect(response.status).toBe(400); expect(response.body).toContain('1048576 bytes');
    } catch (error) { expect(['ECONNRESET', 'EPIPE']).toContain((error as NodeJS.ErrnoException).code); }
    expect((await post(readOnly, JSON.stringify({ ids: [] }))).status).toBe(200);
  });
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
