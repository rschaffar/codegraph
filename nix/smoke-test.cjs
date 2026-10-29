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
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
