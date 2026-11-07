#!/usr/bin/env node
/** Focused real-index browser regression for source cards. Build first.
 * CODEGRAPH_BOARD_ARTIFACT_ROOT selects an existing private artifact directory;
 * CODEGRAPH_BROWSER_EXECUTABLE selects an already installed Chromium executable.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
process.env.CODEGRAPH_TELEMETRY = '0'; process.env.DO_NOT_TRACK = '1'; process.env.CODEGRAPH_NO_PROMPT_HOOK = '1';
const CodeGraph = require(path.join(root, 'dist/index.js')).default;
const work = fs.mkdtempSync(path.join(process.env.CODEGRAPH_BOARD_ARTIFACT_ROOT ?? os.tmpdir(), 'codegraph-source-browser-'));
console.log(`Artifacts: ${work}`);
const project = path.join(work, 'project'); fs.mkdirSync(project);
const contents = new Map([
  ['group.ts', `${Array.from({ length: 36 }, (_, i) => `function sourceDep${i}() { return ${i}; }`).join('\n')}\nexport class SourceGroup {\n first() { return this.second() + ${Array.from({ length: 36 }, (_, i) => `sourceDep${i}()`).join(' + ')}; }\n second() { return 2; }\n third() { return this.second(); }\n}\nexport class UnrelatedGroup { unrelated() { return 99; } }\n`],
  ['free.ts', 'export function freeA() { return freeB(); }\nexport function freeB() { return 1; }\nexport function freeC() { return freeB(); }\nclass Unrelated { hiddenMethod() { return 2; } }\n'],
  ['free.ts.extra.ts', 'export function wrongFile() { return 0; }\n'],
]);
for (const [file, text] of contents) fs.writeFileSync(path.join(project, file), text);
const cg = CodeGraph.initSync(project, { config: { include: ['*.ts'], exclude: [] } });
await cg.indexAll(); cg.resolveReferences(); cg.close();
const session = `source-board-${process.pid}`;
const browser = process.env.CODEGRAPH_BROWSER_EXECUTABLE;
const viewerExecutable = process.env.CODEGRAPH_BOARD_EXECUTABLE ? fs.realpathSync(process.env.CODEGRAPH_BOARD_EXECUTABLE) : null;
function command(...args) {
  return execFileSync('agent-browser', ['--session', session, ...(browser ? ['--executable-path', browser] : []), ...args],
    { encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 }).trim();
}
function evaluate(body) { return JSON.parse(command('eval', `(async()=>{${body}})()`)); }
async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (evaluate(`return Boolean(${expression});`)) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function click(name) { command('find', 'role', 'button', 'click', '--name', name, '--exact'); }
function fill(label, value) { command('find', 'label', label, 'fill', value); }
const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const viewerArgs = ['ui', project, '--no-open', '--port', String(port)];
const child = spawn(viewerExecutable ?? process.execPath, viewerExecutable ? viewerArgs : ['--liftoff-only', '--disable-warning=ExperimentalWarning', path.join(root, 'dist/bin/codegraph.js'), ...viewerArgs],
  { cwd: root, env: { ...process.env, CODEGRAPH_UI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
const results = [];
function pass(message) { results.push(message); console.log(`PASS ${message}`); }
async function api(endpoint) { const response = await fetch(`${base}${endpoint}`); assert.equal(response.status, 200); return response.json(); }
async function search(query) {
  click('+ Add symbols'); fill('Search indexed symbols', query); click('Search index');
  await waitFor(`document.querySelector('.library .result strong')?.textContent===${JSON.stringify(query)}`, `search ${query}`);
}
function geometry() { return evaluate('return {viewport:document.querySelector(".svelte-flow__viewport").style.transform,symbols:document.querySelectorAll("[data-symbol]").length,positions:[...document.querySelectorAll(".svelte-flow__node-code")].map(node=>[node.dataset.id,node.style.transform])};'); }
try {
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null) throw new Error(`Viewer exited: ${log}`);
    try { await api('/api/stats'); break; } catch (cause) { if (attempt >= 100) throw cause; await delay(100); }
  }
  command('open', `${base}/#/board`); command('set', 'viewport', '1440', '1000');
  await waitFor('document.querySelector("[data-add-symbols]")', 'Board');
  // All mutations are confined to this throwaway project and browser session.
  evaluate('window.confirm=()=>true; return true;');
  await search('SourceGroup'); click('Add SourceGroup'); await delay(200); click('Close symbol library'); click('Open SourceGroup source');
  await waitFor('[...document.querySelectorAll(".source-card .ref")].some(link=>link.textContent==="sourceDep35")', 'automatic whole-class reference pages');
  pass('whole-class clickable references load across target pages without manual evidence clicks');
  await search('first'); click('Source');
  await waitFor('document.querySelectorAll("[data-code-card]").length===2', 'individual method source');
  const before = geometry(); click('Open sibling sources for first');
  await waitFor('document.querySelectorAll("[data-code-card]").length===4', 'one-click sibling sources');
  const after = geometry(); assert.equal(after.symbols, 1); assert.equal(after.viewport, before.viewport);
  for (const [id, position] of before.positions) assert.equal(after.positions.find(item => item[0] === id)[1], position);
  await waitFor('[...document.querySelectorAll(".svelte-flow__edge")].some(edge=>edge.dataset.id.startsWith("source-relation:"))', 'source relationship arrows');
  const layers = evaluate('return [...document.querySelectorAll(".svelte-flow__edge")].map(edge=>({id:edge.dataset.id,label:edge.getAttribute("aria-label")}));');
  for (const edge of layers) {
    if (edge.id.startsWith('source-relation:')) { assert.match(edge.label, /^Edge from code:/); assert.ok(edge.label.includes(' to code:')); assert.ok(!edge.id.includes('"imports"')); }
    else assert.ok(!edge.label.includes('code:'), 'symbol edges must not connect source cards');
  }
  const first = (await api('/api/board/search?q=first&kind=method')).items[0];
  const siblings = await api(`/api/board/sibling-sources?id=${encodeURIComponent(first.id)}`);
  assert.deepEqual(siblings.items.map(item => item.name), ['second', 'third']);
  pass('same-class sibling source cards preserve symbols, existing geometry and viewport; arrow layers stay separate');
  click('Fit code (4)'); await delay(300);
  // A second activation reuses all existing cards, even when the canvas is zoomed.
  evaluate('[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="Open sibling sources for first").click();return true;');
  await delay(300); assert.equal(evaluate('return document.querySelectorAll("[data-code-card]").length;'), 4);
  click('New'); await search('freeA'); click('Source'); click('Open sibling sources for freeA');
  await waitFor('document.querySelectorAll("[data-code-card]").length===3', 'same-file free function sources');
  assert.equal(geometry().symbols, 0);
  assert.deepEqual(evaluate('return [...document.querySelectorAll(".source-card header strong")].map(node=>node.textContent).sort();'), ['freeA', 'freeB', 'freeC']);
  await waitFor('[...document.querySelectorAll(".svelte-flow__edge")].some(edge=>edge.dataset.id.startsWith("source-relation:"))', 'source-only board arrows');
  pass('free-function siblings use the exact file and exclude unrelated methods and filename prefixes');
  assert.equal(command('errors'), '');
  for (const [file, text] of contents) assert.equal(fs.readFileSync(path.join(project, file), 'utf8'), text);
  pass('no browser errors or source-file changes');
} finally {
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify({ viewerExecutable, results }, null, 2));
  try { fs.writeFileSync(path.join(work, 'snapshot.txt'), command('snapshot')); command('screenshot', path.join(work, 'final.png')); } catch {}
  try { command('close'); } catch {}
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })]);
}
