import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { CodeGraph } from '../src';
import { getDatabasePath, type SqliteDatabase } from '../src/db';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import { GraphSession } from '../src/ui-server/api/session';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';
import { indexFingerprint } from './index-fingerprint';

const fixtures: Array<{ root: string; writer: CodeGraph; api?: GraphApi; server?: UiServerHandle; session?: GraphSession }> = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-viewer-readonly-'));
  const writer = CodeGraph.initSync(root);
  const db = writer['db'].getDb();
  db.pragma('wal_autocheckpoint = 0');
  writer['queries'].insertNode({ id: 'function:one', name: 'one', qualifiedName: 'one', kind: 'function',
    filePath: 'sample.ts', language: 'typescript', startLine: 1, endLine: 1, startColumn: 0, endColumn: 1 });
  const value: typeof fixtures[number] = { root, writer }; fixtures.push(value);
  return { value, root, writer, db, fingerprint: () => indexFingerprint(db, getDatabasePath(root)) };
}
async function serve(value: typeof fixtures[number], readOnly: boolean) {
  const viewerDir = path.join(value.root, 'viewer'); fs.mkdirSync(viewerDir); fs.writeFileSync(path.join(viewerDir, 'index.html'), 'fixture');
  value.api = createGraphApi({ projectRoot: value.root, readOnly });
  value.server = await startUiServer({ projectRoot: value.root, viewerDir, port: 0, api: value.api.handler });
  return value.server;
}
async function stats(server: UiServerHandle): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.port, path: '/api/stats', headers: { Host: `127.0.0.1:${server.port}` } }, (response) => {
      const chunks: Buffer[] = []; response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on('error', reject); request.end();
  });
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    await value.server?.close(); value.api?.close(); value.session?.close(); value.writer.close();
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

const brokenStates = [
  ['old schema', (db: SqliteDatabase) => {
    db.prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, 0, ?)').run(CURRENT_SCHEMA_VERSION - 1, 'older fixture');
    db.prepare('DELETE FROM schema_versions WHERE version >= ?').run(CURRENT_SCHEMA_VERSION);
    db.exec('DROP INDEX idx_unresolved_failed_module_member');
  }],
  ['newer schema', (db: SqliteDatabase) => db.prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, 0, ?)').run(CURRENT_SCHEMA_VERSION + 1, 'future fixture')],
  ['interrupted FTS load', (db: SqliteDatabase) => db.exec('DROP TRIGGER nodes_ai')],
  ['interrupted parse load', (db: SqliteDatabase) => db.exec('DROP INDEX idx_nodes_kind')],
  ['interrupted reference load', (db: SqliteDatabase) => db.exec('DROP INDEX idx_unresolved_from_node')],
  ['interrupted edge load', (db: SqliteDatabase) => db.exec('DROP INDEX idx_edges_kind')],
] as const;

describe.each([false, true])('viewer graph immutability (metadata readOnly=%s)', (readOnly) => {
  it.each(brokenStates)('refuses %s without migrating or repairing logical data/schema/WAL', async (_, breakIndex) => {
    const { value, db, fingerprint } = fixture(); breakIndex(db);
    const before = fingerprint(); expect(before.wal).not.toBeNull();
    const server = await serve(value, readOnly);
    const response = await stats(server);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'index-unusable', hint: expect.stringContaining('never migrates or repairs') });
    value.api!.close();
    expect(fingerprint()).toEqual(before);
  });

  it('queries and closes a healthy live WAL without modifying it', async () => {
    const { value, fingerprint } = fixture(); const before = fingerprint();
    const server = await serve(value, readOnly);
    expect((await stats(server)).status).toBe(200);
    value.api!.close(); expect(fingerprint()).toEqual(before);
  });

  it('preserves a legitimate FTS-less index rather than trying to create search tables', async () => {
    const { value, db, fingerprint } = fixture();
    for (const name of ['nodes_ai', 'nodes_ad', 'nodes_au']) db.exec(`DROP TRIGGER ${name}`);
    db.exec('DROP TABLE nodes_fts'); const before = fingerprint();
    const server = await serve(value, readOnly);
    expect((await stats(server)).status).toBe(200);
    value.api!.close(); expect(fingerprint()).toEqual(before);
  });

  it('rejects cached incomplete state and recovers only after an external writer repairs it', async () => {
    const { value, db, fingerprint } = fixture(); const server = await serve(value, readOnly);
    expect((await stats(server)).status).toBe(200);
    const original = db.prepare("SELECT sql FROM sqlite_master WHERE name='nodes_ai'").get() as { sql: string };
    db.exec('DROP TRIGGER nodes_ai'); const before = fingerprint();
    expect((await stats(server)).status).toBe(503);
    expect(fingerprint()).toEqual(before);
    db.exec(original.sql);
    expect((await stats(server)).status).toBe(200);
  });
});

it.runIf(process.platform !== 'win32')('reads a live index with non-writable database files and directory', () => {
  const { value, root, fingerprint } = fixture(); const dbPath = getDatabasePath(root);
  const directory = path.dirname(dbPath); const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const modes = files.map((file) => fs.statSync(file).mode & 0o777);
  const directoryMode = fs.statSync(directory).mode & 0o777;
  const before = fingerprint();
  try {
    for (const file of files) fs.chmodSync(file, 0o444);
    fs.chmodSync(directory, 0o555);
    value.session = new GraphSession(root);
    expect(value.session.acquire()['db'].readOnly).toBe(true);
    value.session.close(); expect(fingerprint()).toEqual(before);
  } finally {
    fs.chmodSync(directory, directoryMode);
    files.forEach((file, index) => fs.chmodSync(file, modes[index]));
  }
});

it('acquires a genuinely read-only graph connection, not only a read-only UI policy', () => {
  const { value, root, fingerprint } = fixture(); const before = fingerprint();
  value.session = new GraphSession(root); const cg = value.session.acquire();
  expect(cg['db'].readOnly).toBe(true);
  expect(() => cg['db'].getDb().exec('CREATE TABLE forbidden_viewer_write (value TEXT)')).toThrow(/readonly|read.only/i);
  value.session.close(); expect(fingerprint()).toEqual(before);
});
