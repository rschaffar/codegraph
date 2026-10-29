// Installed-package acceptance: native loading cannot silently fall back, the
// WASM path still works, and the viewer serves its real assets and indexed data.
// This is not a full language-parity suite or a browser interaction test.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const output = process.argv[2];
const packageRoot = path.join(output, 'lib/codegraph');
const executable = path.join(output, 'bin/codegraph');
const { getKernel, kernelSupports } = require(path.join(packageRoot, 'dist/extraction/kernel/loader.js'));
const { decodeExtractBuffers } = require(path.join(packageRoot, 'dist/extraction/kernel/decode.js'));

function run(args, cwd, env = {}) {
  return execFileSync(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function main() {
  const kernel = getKernel();
  assert.ok(kernel, 'installed native kernel must load and pass the engine ABI contract');
  assert.ok(kernelSupports('typescript'));
  assert.ok(kernelSupports('csharp'));
  const source = 'export function hello(name: string) { return name; }\n';
  const extracted = decodeExtractBuffers(kernel.extractFile('hello.ts', source, 'typescript'), 'hello.ts', 'typescript');
  assert.deepEqual(extracted.errors, []);
  assert.ok(extracted.nodes.some((node) => node.kind === 'function' && node.name === 'hello'));
  console.log('native addon: loaded, contract verified, TypeScript extraction decoded');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-nix-'));
  let nativeFixture;
  for (const mode of ['native', 'wasm']) {
    const fixture = path.join(workspace, mode);
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, 'hello.ts'), source);
    const env = { CODEGRAPH_KERNEL: mode === 'native' ? '1' : '0' };
    run(['init'], fixture, env);
    const matches = JSON.parse(run(['query', 'hello', '--json'], fixture, env));
    assert.ok(matches.some(({ node }) => node.kind === 'function' && node.name === 'hello'));
    assert.match(run(['explore', 'hello'], fixture, env), /export function hello/);
    if (mode === 'native') nativeFixture = fixture;
    console.log(`${mode} CLI: init, query and explore passed`);
  }

  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(executable, ['ui', nativeFixture, '--read-only', '--no-open', '--port', String(port)], {
    cwd: nativeFixture,
    env: { ...process.env, CODEGRAPH_UI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', (chunk) => { logs += chunk; });
  server.stderr.on('data', (chunk) => { logs += chunk; });
  const exited = once(server, 'exit');
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(server.exitCode, null, `viewer exited before becoming ready: ${logs}`);
      try {
        const response = await fetch(`${base}/api/stats`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // The child may still be opening the index or binding its socket.
      }
      await delay(100);
    }
    assert.ok(ready, `viewer did not become ready: ${logs}`);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<div id="app">/);
    const script = html.match(/<script[^>]+src="([^"]+)"/);
    assert.ok(script, 'viewer HTML must reference its built JavaScript');
    const asset = await fetch(new URL(script[1], base));
    assert.equal(asset.status, 200);
    assert.ok((await asset.text()).length > 100);
    const search = await fetch(`${base}/api/search?q=hello`);
    assert.equal(search.status, 200);
    const result = await search.json();
    assert.ok(result.results.items.some((node) => node.name === 'hello'));
    console.log('viewer: read-only server, bundled HTML/JavaScript and indexed search passed');

    const selected = await (await fetch(`${base}/api/board/search?q=hello&kind=function`)).json();
    const id = selected.items.find((item) => item.name === 'hello').id;
    const board = await (await fetch(`${base}/api/board?ids=${encodeURIComponent(JSON.stringify([id]))}`)).json();
    assert.deepEqual(board.included, [id]);
    assert.ok(board.symbols.some((item) => item.id === id));
    const boards = await (await fetch(`${base}/api/boards`)).json();
    assert.equal(boards.readOnly, true);
    const refused = await fetch(`${base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-CodeGraph-UI': '1' }, body: '{}' });
    assert.equal(refused.status, 403);
    const resolved = await fetch(`${base}/api/boards/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-CodeGraph-UI': '1' }, body: JSON.stringify({ document: { version: 1, symbols: [], cards: [], viewport: { x: 0, y: 0, zoom: 1 }, filters: { kind: '', showStructure: false } } }) });
    assert.equal(resolved.status, 200);
    assert.equal(fs.existsSync(path.join(nativeFixture, '.codegraph/ui/boards')), false);
    console.log('live board: indexed selection, metadata-only read-only refusal and in-memory resolution passed');

    const prototype = await fetch(`${base}/board-prototype.html`);
    assert.equal(prototype.status, 200);
    const prototypeHtml = await prototype.text();
    assert.match(prototypeHtml, /Review board clickdummy/);
    const prototypeScript = prototypeHtml.match(/<script[^>]+src="([^"]+)"/);
    assert.ok(prototypeScript, 'clickdummy must ship its own entry point');
    const prototypeAsset = await fetch(new URL(prototypeScript[1], base));
    assert.equal(prototypeAsset.status, 200);
    assert.ok((await prototypeAsset.text()).length > 100);
    console.log('clickdummy: isolated HTML and built JavaScript are shipped');
  } finally {
    server.kill('SIGTERM');
    const killTimer = setTimeout(() => server.kill('SIGKILL'), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(killTimer);
    }
  }

  const writePort = await unusedPort();
  const writeBase = `http://127.0.0.1:${writePort}`;
  const writable = spawn(executable, ['ui', nativeFixture, '--no-open', '--port', String(writePort)], {
    cwd: nativeFixture, env: { ...process.env, CODEGRAPH_UI: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let writeLogs = '';
  writable.stdout.on('data', (chunk) => { writeLogs += chunk; });
  writable.stderr.on('data', (chunk) => { writeLogs += chunk; });
  const writeExited = once(writable, 'exit');
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(writable.exitCode, null, `writable viewer exited: ${writeLogs}`);
      try { if ((await fetch(`${writeBase}/api/stats`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(ready, `writable viewer not ready: ${writeLogs}`);
    const before = await (await fetch(`${writeBase}/api/stats`)).json();
    const search = await (await fetch(`${writeBase}/api/board/search?q=hello&kind=function`)).json();
    const hello = search.items.find((item) => item.name === 'hello');
    assert.ok(hello);
    const document = {
      version: 1,
      symbols: [{ key: 's0', identity: { id: hello.id, qualifiedName: hello.qualifiedName, kind: hello.kind, file: hello.file }, position: { x: 12, y: 34 }, included: true, hidden: false, expanded: true }],
      cards: [{ key: 'c0', symbolKey: 's0', position: { x: 30, y: 700 }, width: 530, height: 310, collapsed: false, zIndex: 11 }],
      viewport: { x: -10, y: 20, zoom: .9 }, filters: { kind: '', showStructure: false },
    };
    const savedResponse = await fetch(`${writeBase}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-CodeGraph-UI': '1' }, body: JSON.stringify({ name: 'Installed board acceptance', document }) });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    const loaded = await (await fetch(`${writeBase}/api/boards/${saved.id}`)).json();
    assert.deepEqual(loaded.board, document);
    assert.equal(loaded.resolutions[0].node.id, hello.id);
    const stored = JSON.parse(fs.readFileSync(path.join(nativeFixture, '.codegraph/ui/boards', `${saved.id}.json`), 'utf8'));
    assert.equal(stored.document.symbols.length, 1);
    assert.equal('relations' in stored.document, false);
    assert.equal(JSON.stringify(stored).includes('return name'), false);
    const deleted = await fetch(`${writeBase}/api/boards/${saved.id}`, { method: 'DELETE', headers: { 'X-CodeGraph-UI': '1' } });
    assert.equal(deleted.status, 200);
    assert.equal(fs.existsSync(path.join(nativeFixture, '.codegraph/ui/boards', `${saved.id}.json`)), false);
    assert.equal(fs.readFileSync(path.join(nativeFixture, 'hello.ts'), 'utf8'), source);
    const after = await (await fetch(`${writeBase}/api/stats`)).json();
    assert.equal(after.graph.nodes, before.graph.nodes);
    assert.equal(after.graph.edges, before.graph.edges);
    console.log('live board: writable installed Save/Open/Delete persists metadata only; source and graph counts unchanged');
  } finally {
    writable.kill('SIGTERM');
    const killTimer = setTimeout(() => writable.kill('SIGKILL'), 5_000);
    try { await writeExited; } finally { clearTimeout(killTimer); }
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
