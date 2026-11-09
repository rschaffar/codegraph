#!/usr/bin/env node
/** Real-index Board navigation regression. Keeps disposable projects/evidence in the supplied task artifact root. */
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
const work = fs.mkdtempSync(path.join(process.env.CODEGRAPH_BOARD_ARTIFACT_ROOT ?? os.tmpdir(), 'codegraph-navigation-browser-'));
console.log(`Artifacts: ${work}`);
const project = path.join(work, 'project'); fs.mkdirSync(project);
const contents = new Map([
  ['target.ts', `export class Target {\n${Array.from({ length: 460 }, (_, i) => `  // class context ${i}`).join('\n')}\n  static run() {\n    return 42;\n  }\n  static other() { return 7; }\n}\n`],
  ['caller.ts', "import { Target } from './target';\nexport class Caller {\n  first() { return Target.run(); }\n  second() { return Target.other(); }\n}\n"],
]);
for (const [file, text] of contents) fs.writeFileSync(path.join(project, file), text);
const cg = CodeGraph.initSync(project, { config: { include: ['*.ts'], exclude: [] } });
await cg.indexAll(); cg.resolveReferences(); cg.close();
const session = `board-navigation-${process.pid}`;
const browser = process.env.CODEGRAPH_BROWSER_EXECUTABLE;
function command(...args) {
  return execFileSync('agent-browser', ['--session', session, ...(browser ? ['--executable-path', browser] : []), ...args],
    { encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 }).trim();
}
function evaluate(body) { return JSON.parse(command('eval', `(async()=>{${body}})()`)); }
async function waitFor(expression, label) {
  for (let i = 0; i < 60; i++) { if (evaluate(`return Boolean(${expression});`)) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
function click(name) { command('find', 'role', 'button', 'click', '--name', name, '--exact'); }
const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const viewer = process.env.CODEGRAPH_BOARD_EXECUTABLE ? fs.realpathSync(process.env.CODEGRAPH_BOARD_EXECUTABLE) : null;
const args = ['ui', project, '--no-open', '--port', String(port)];
const child = spawn(viewer ?? process.execPath, viewer ? args : ['--liftoff-only', '--disable-warning=ExperimentalWarning', path.join(root, 'dist/bin/codegraph.js'), ...args],
  { cwd: root, env: { ...process.env, CODEGRAPH_UI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
const results = [];
function pass(message) { results.push(message); console.log(`PASS ${message}`); }
async function api(endpoint) { const response = await fetch(`${base}${endpoint}`); assert.equal(response.status, 200); return response.json(); }
function geometry() {
  return evaluate(`const transform=document.querySelector('.svelte-flow__viewport').style.transform;
    return {transform,zoom:Number(transform.match(/scale\\(([^)]+)\\)/)[1]),symbols:document.querySelectorAll('.svelte-flow__node-symbol').length,
      cards:[...document.querySelectorAll('.svelte-flow__node-code')].map(node=>({id:node.dataset.id,position:node.style.transform,width:node.style.width,height:node.style.height}))};`);
}
function sameGeometry(before, after) {
  for (const card of before.cards) assert.deepEqual(after.cards.find(item => item.id === card.id), card);
  assert.equal(after.zoom, before.zoom); assert.equal(after.symbols, before.symbols);
}
async function centered(symbol, line) {
  await waitFor(`document.querySelector('[data-code-card="${symbol.id}"] [data-line="${line}"].hot')`, 'highlighted destination');
  await delay(350);
  const distance = evaluate(`const canvas=document.querySelector('.svelte-flow').getBoundingClientRect();
    const card=document.querySelector('[data-code-card="${symbol.id}"]'); const source=card.querySelector('[data-source-body]').getBoundingClientRect();
    const row=card.querySelector('[data-line="${line}"]').getBoundingClientRect();
    return {x:source.left+source.width/2-canvas.left-canvas.width/2,y:row.top+row.height/2-canvas.top-canvas.height/2};`);
  assert.ok(Math.abs(distance.x) < 3 && Math.abs(distance.y) < 3, `Target not centered: ${JSON.stringify(distance)}`);
}
async function open(name) {
  click('Saved boards'); click(`Open ${name}`);
  await waitFor('document.querySelectorAll("[data-code-card] [role=status]").length===0 && !document.querySelector(".panel")', 'saved board settled');
  await delay(150);
}
async function token(card, name) {
  await waitFor(`[...document.querySelectorAll('[data-code-card="${card.id}"] [role="link"]')].some(node=>node.textContent===${JSON.stringify(name)})`, 'inline code link');
  const point = evaluate(`const node=[...document.querySelectorAll('[data-code-card="${card.id}"] [role="link"]')].find(node=>node.textContent===${JSON.stringify(name)});const r=node.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};`);
  command('mouse', 'move', String(Math.round(point.x)), String(Math.round(point.y))); command('mouse', 'down'); command('mouse', 'up');
}
async function arrow(layer, source, target, member) {
  const selector = `[...document.querySelectorAll('.svelte-flow__edge')].find(edge=>edge.getAttribute('aria-label')===${JSON.stringify(`Edge from ${layer === 'source' ? 'code:' : ''}${source.id} to ${layer === 'source' ? 'code:' : ''}${target.id}`)}&&edge.dataset.id.includes('"calls"')${member ? `&&edge.dataset.id.includes(${JSON.stringify(member.id)})` : ''})`;
  await waitFor(selector, `${layer} arrow`);
  evaluate(`(${selector}).focus();return true;`); command('press', 'Enter');
  await waitFor('document.querySelector("[data-connection-menu]")', 'connection popup');
}
try {
  for (let i = 0; ; i++) { try { await api('/api/stats'); break; } catch (cause) { if (child.exitCode !== null || i >= 100) throw cause; await delay(100); } }
  const all = (await api('/api/board/search?limit=100')).items;
  const named = (name, kind) => { const node = all.find(item => item.name === name && item.kind === kind); assert.ok(node, `${kind} ${name}`); return node; };
  const caller = named('Caller', 'class'), target = named('Target', 'class'), run = named('run', 'method'), second = named('second', 'method');
  const file = all.find(item => item.kind === 'file' && item.file === 'target.ts'); assert.ok(file);
  const identity = node => ({ id: node.id, qualifiedName: node.qualifiedName, kind: node.kind, file: node.file, ...(node.signature ? { signature: node.signature } : {}) });
  const document = (items, cards) => ({ version: 1, symbols: items.map(([node, included], i) => ({ key: `s${i}`, identity: identity(node), position: { x: i * 600, y: 0 }, included, hidden: false, expanded: false })),
    cards: cards.map(([node, position, collapsed = false], i) => ({ key: `card${i}`, symbolKey: `s${items.findIndex(([item]) => item.id === node.id)}`, position, width: 600, height: 360, collapsed, zIndex: 12 + i })),
    viewport: { x: 40, y: 50, zoom: 0.75 }, filters: { kind: '', showStructure: false, includeTests: false, includeGenerated: false, includeUncertain: false } });
  const pair = document([[caller, true], [target, true]], [[caller, { x: 0, y: 0 }], [target, { x: 2200, y: 500 }]]);
  const own = document([[caller, true], [target, true], [run, false]], [[caller, { x: 0, y: 0 }], [target, { x: 2200, y: 500 }], [run, { x: 3200, y: 700 }, true]]);
  for (const [name, recipe] of [['Container pair', pair], ['Own target', own], ['Method source', document([[run, false]], [[run, { x: 0, y: 0 }]])], ['New target', document([[caller, true]], [[caller, { x: 0, y: 0 }]])]]) {
    const response = await fetch(`${base}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-CodeGraph-UI': '1' }, body: JSON.stringify({ name, document: recipe }) });
    assert.ok(response.ok, await response.text());
  }
  command('open', `${base}/#/board`); command('set', 'viewport', '1500', '1000');
  evaluate('window.confirm=()=>true;return true;');
  await open('Container pair'); const before = geometry(); assert.equal(before.zoom, 0.75);
  // Sample every frame: fixed end zoom alone would miss d3's smooth-pan zoom excursion.
  evaluate('window.navigationZooms=[];window.sampleNavigationZoom=true;function sample(){if(!window.sampleNavigationZoom)return;window.navigationZooms.push(Number(document.querySelector(".svelte-flow__viewport").style.transform.match(/scale\\(([^)]+)\\)/)[1]));requestAnimationFrame(sample)}sample();return true;');
  await token(caller, 'run'); await centered(target, run.line);
  evaluate('window.sampleNavigationZoom=false;return true;');
  const zooms = evaluate('return window.navigationZooms;'); assert.ok(zooms.length > 2); assert.ok(zooms.every(zoom => Math.abs(zoom - 0.75) < 1e-9), JSON.stringify(zooms));
  const after = geometry(); sameGeometry(before, after); assert.notEqual(before.transform, after.transform);
  assert.equal(after.cards.length, 2); assert.equal(evaluate('return document.querySelectorAll("[data-source-fold]").length;'), 0);
  command('screenshot', path.join(work, 'contained-target.png'));
  pass('inline source link reveals a paged contained method and centers its code without detachment, moved cards, added pins or any zoom excursion');

  await arrow('source', caller, target, run); click('Go to source'); await centered(caller, named('first', 'method').line);
  await arrow('source', caller, target, run); click('Go to target'); await centered(target, run.line);
  sameGeometry(before, geometry()); assert.equal(geometry().cards.length, 2);
  pass('source connection popup navigates to the original call site and contained target declaration; keyboard activation works');

  await arrow('symbol', caller, target); click('Go to source');
  await waitFor('document.querySelectorAll("[data-connection-choice]").length===2', 'grouped source choices');
  evaluate(`const button=[...document.querySelectorAll('[data-connection-choice]')].find(node=>node.textContent.includes(${JSON.stringify(second.qualifiedName)}));button.click();return true;`);
  await waitFor(`document.querySelector('[data-member="${second.id}"]')`, 'exact graph member');
  assert.equal(geometry().cards.length, 2); assert.equal(geometry().zoom, 0.75);
  pass('grouped symbol arrows require an exact member choice and navigate within the symbol layer');

  await open('Own target'); const beforeOwn = geometry(); await token(caller, 'run'); await centered(run, run.line);
  const afterOwn = geometry(); assert.equal(afterOwn.cards.length, 3); assert.equal(afterOwn.zoom, 0.75);
  for (const card of beforeOwn.cards) {
    const changed = afterOwn.cards.find(item => item.id === card.id); assert.equal(changed.position, card.position); assert.equal(changed.width, card.width);
    if (card.id !== `code:${run.id}`) assert.equal(changed.height, card.height);
  }
  await waitFor(`document.querySelector('[data-code-card="${target.id}"] [data-source-fold="${run.id}"]') || !document.querySelector('[data-code-card="${target.id}"] [data-line="${run.line}"]')`, 'existing detachment retained');
  pass('an existing collapsed method source wins over its containing class, expands at its old position and retains existing detachment');

  await open('Method source'); const methodGeometry = geometry(); click('Containing source for run');
  await waitFor(`document.querySelector('.container-menu')?.textContent.includes(${JSON.stringify(target.qualifiedName)})`, 'containing types menu');
  evaluate(`const button=[...document.querySelectorAll('.container-menu button')].find(node=>node.textContent.includes(${JSON.stringify(`Open class source: ${target.qualifiedName}`)}));button.click();return true;`);
  await centered(target, run.line);
  await waitFor(`document.querySelector('[data-code-card="${target.id}"] [data-source-fold="${run.id}"]')`, 'automatic fold in opened container');
  sameGeometry(methodGeometry, geometry()); assert.equal(geometry().cards.length, 2);
  // Repeat the explicit container action from the existing method card: reuse,
  // never duplicate or reattach. DOM activation avoids overlapping card geometry.
  evaluate(`document.querySelector('[data-code-card="${run.id}"] button[aria-expanded]').click();return true;`);
  evaluate(`const button=[...document.querySelectorAll('.container-menu button')].find(node=>node.textContent.includes(${JSON.stringify(`Open class source: ${target.qualifiedName}`)}));button.click();return true;`);
  await centered(target, run.line); assert.equal(geometry().cards.length, 2);
  pass('containing-source menu materializes/reuses the whole class while retaining standalone methods, automatic folds and graph membership');

  await open('Method source'); click('Containing source for run');
  await waitFor(`document.querySelector('.container-menu')?.textContent.includes(${JSON.stringify(file.qualifiedName)})`, 'exact file menu');
  evaluate(`const button=[...document.querySelectorAll('.container-menu button')].find(node=>node.textContent.includes(${JSON.stringify(`Open file source: ${file.qualifiedName}`)}));button.click();return true;`);
  await centered(file, run.line); assert.equal(geometry().cards.length, 2); assert.equal(geometry().symbols, 0);
  pass('containing-source menu opens the exact indexed file without replacing the method or adding graph symbols');

  await open('New target'); const beforeNew = geometry(); await token(caller, 'run'); await centered(run, run.line);
  sameGeometry(beforeNew, geometry()); assert.equal(geometry().cards.length, 2);
  pass('a valid indexed target absent from existing source cards opens a new source-only card and is centered at unchanged zoom');
  for (const [fileName, text] of contents) assert.equal(fs.readFileSync(path.join(project, fileName), 'utf8'), text);
  const errors = command('errors'); assert.ok(!errors || /no errors/i.test(errors), errors);
  fs.writeFileSync(path.join(work, 'snapshot.txt'), command('snapshot'));
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify({ results, zoomSamples: zooms, browserErrors: errors }, null, 2));
  command('screenshot', path.join(work, 'navigation-final.png'));
} catch (cause) {
  try { fs.writeFileSync(path.join(work, 'failure-snapshot.txt'), command('snapshot')); command('screenshot', path.join(work, 'failure.png')); } catch {}
  throw cause;
} finally {
  fs.writeFileSync(path.join(work, 'viewer.log'), log);
  try { command('close'); } catch {}
  child.kill('SIGTERM');
}
