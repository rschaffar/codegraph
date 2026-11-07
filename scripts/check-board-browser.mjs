#!/usr/bin/env node
/** Real browser acceptance of the built single-project Board, using only throwaway code.
 * Run after npm run build inside the Nix dev shell:
 *   CODEGRAPH_BROWSER_EXECUTABLE=/path/to/chromium node scripts/check-board-browser.mjs
 * Set CODEGRAPH_BOARD_EXECUTABLE to an installed executable to test immutable viewer assets.
 * Requires the user-provided agent-browser CLI; never installs a browser or dependencies.
 * Artifacts stay under the printed private temporary directory, never in the repository.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
process.env.CODEGRAPH_TELEMETRY = '0'; process.env.DO_NOT_TRACK = '1'; process.env.CODEGRAPH_NO_PROMPT_HOOK = '1';
const viewerExecutable = process.env.CODEGRAPH_BOARD_EXECUTABLE ? fs.realpathSync(process.env.CODEGRAPH_BOARD_EXECUTABLE) : null;
const CodeGraph = require(path.join(root, 'dist/index.js')).default;
const work = fs.mkdtempSync(path.join(process.env.CODEGRAPH_BOARD_ARTIFACT_ROOT ?? os.tmpdir(), 'codegraph-board-browser-'));
console.log(`Artifacts: ${work}`);
const project = path.join(work, 'project');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.mkdirSync(path.join(project, 'test'));
fs.writeFileSync(path.join(project, 'src/normalize.ts'), 'export function normalize(value: string): string { return value.trim(); }\n');
fs.writeFileSync(path.join(project, 'src/review.ts'), `import { normalize } from './normalize';
export function decorate(value: string): string { return value.toUpperCase(); }
export function entry(value: string): string { return decorate(normalize(value)); }
export class Factory { build(value: string): string { return normalize(value); } }
export class Coordinator {
  constructor(private factory: Factory) {}
  refresh(value: string): string { return this.factory.build(value); }
}
`);
fs.writeFileSync(path.join(project, 'src/tree.cs'), `namespace Review.Sample {
  public class Outer {
    public class Inner {
      public int Compute(int value) { return value + 1; }
    }
  }
}
`);
fs.writeFileSync(path.join(project, 'src/worker.py'), 'class Worker:\n    def run(self, value):\n        return str(value)\n');
fs.writeFileSync(path.join(project, 'src/generated.ts'), '// @generated\nexport function GeneratedTarget() { return 1; }\n');
fs.writeFileSync(path.join(project, 'test/review.test.ts'), 'export function TestTarget() { return 2; }\n');
fs.writeFileSync(path.join(project, 'src/hub.ts'), `import { normalize } from './normalize';\nexport class Hub {\n${Array.from({ length: 700 }, (_, i) => `method${i}(value: string) { return normalize(value); }`).join('\n')}\n}\n`);
const original = new Map(fs.readdirSync(path.join(project, 'src')).map(file => [file, fs.readFileSync(path.join(project, 'src', file))]));
const cg = CodeGraph.initSync(project, { config: { include: ['src/**/*.ts', 'src/**/*.cs', 'src/**/*.py', 'test/**/*.ts'], exclude: [] } });
await cg.indexAll(); cg.resolveReferences(); cg.close();
const session = `board-acceptance-${process.pid}`;
const browser = process.env.CODEGRAPH_BROWSER_EXECUTABLE;
const processes = [];
function command(...args) {
  return execFileSync('agent-browser', ['--session', session, ...(browser ? ['--executable-path', browser] : []), ...args], { encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 }).trim();
}
function evaluate(body) { return JSON.parse(command('eval', `(async()=>{${body}})()`)); }
async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 50; attempt++) { if (evaluate(`return Boolean(${expression});`)) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
function click(name) {
  command('wait', '--fn', `[...document.querySelectorAll("button")].some(button=>(button.getAttribute("aria-label")??button.textContent.replace(/\\s+/g," ").trim())===${JSON.stringify(name)}&&!button.disabled)`);
  command('find', 'role', 'button', 'click', '--name', name, '--exact');
}
function fill(label, value) { command('find', 'label', label, 'fill', value); }
async function unusedPort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function serve(readOnly = false) {
  const port = await unusedPort();
  const args = ['ui', project, '--no-open', '--port', String(port), ...(readOnly ? ['--read-only'] : [])];
  const child = spawn(viewerExecutable ?? process.execPath, viewerExecutable ? args : ['--liftoff-only', '--disable-warning=ExperimentalWarning', path.join(root, 'dist/bin/codegraph.js'), ...args], { cwd: root, env: { ...process.env, CODEGRAPH_UI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(child); let log = ''; child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Viewer exited: ${log}`);
    try { if ((await fetch(`${base}/api/stats`)).ok) return base; } catch {}
    await delay(100);
  }
  throw new Error(`Viewer did not start: ${log}`);
}
const results = [];
function pass(name, details = {}) { results.push({ name, ...details }); console.log(`PASS ${name}`); }
function arrangement(document) {
  const identity = value => JSON.stringify([value.qualifiedName, value.kind, value.file, value.signature ?? null]);
  const byKey = new Map(document.symbols.map(item => [item.key, identity(item.identity)]));
  const rounded = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'number' ? Math.round(item * 1e6) / 1e6 : item));
  return rounded({ symbols: document.symbols.map(({ key, identity: value, ...state }) => ({ identity: identity(value), ...state })).sort((a,b) => a.identity.localeCompare(b.identity)),
    cards: document.cards.map(({ key, symbolKey, ...state }) => ({ identity: byKey.get(symbolKey), ...state })).sort((a,b) => a.identity.localeCompare(b.identity)),
    viewport: document.viewport, filters: document.filters });
}
/** agent-browser 0.39 dispatches `mouse wheel` at (0,0), ignoring prior move.
 * Send trusted native input only to this task's exact loopback page instead.
 */
async function nativeWheelAt(base, point, dy) {
  const endpoint = new URL(command('get', 'cdp-url'));
  assert.equal(endpoint.protocol, 'ws:'); assert.ok(['127.0.0.1', '[::1]', '::1'].includes(endpoint.hostname));
  const socket = new WebSocket(endpoint); const pending = new Map(); let next = 0;
  const timer = setTimeout(() => { for (const item of pending.values()) item.reject(new Error('Native input CDP timeout')); socket.close(); }, 5000);
  try {
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('Owned browser CDP connection failed')), { once: true }); });
    socket.addEventListener('message', event => {
      const value = JSON.parse(String(event.data)); const item = pending.get(value.id); if (!item) return;
      pending.delete(value.id); if (value.error) item.reject(new Error(value.error.message)); else item.resolve(value.result);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetInfos } = await send('Target.getTargets');
    const target = targetInfos.find(item => item.type === 'page' && item.url === `${base}/#/board`);
    assert.ok(target, 'native input must target the owned exact local Board page');
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: dy }, sessionId);
  } finally { clearTimeout(timer); socket.close(); }
}
async function dragPoint(point, dx, dy) {
  command('mouse', 'move', String(point.x), String(point.y)); command('mouse', 'down');
  for (let step = 1; step <= 4; step++) command('mouse', 'move', String(Math.round(point.x + dx * step / 4)), String(Math.round(point.y + dy * step / 4)));
  command('mouse', 'up'); await delay(100);
}
try {
  const base = await serve();
  const api = async (endpoint) => { const response = await fetch(`${base}${endpoint}`); assert.equal(response.status, 200, endpoint); return response.json(); };
  command('open', `${base}/#/board`); command('set', 'viewport', '1440', '1000');
  await waitFor('document.querySelector("[data-add-symbols]")', 'Board route');
  click('+ Add symbols'); fill('Search indexed symbols', 'entry'); click('Search index');
  await waitFor('[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="Add entry")', 'real search');
  // A stalled/interrupted viewport animation must not leave Save/Refresh busy.
  evaluate('window.__raf=requestAnimationFrame; window.__frames=[]; window.__holdFrames=true; window.requestAnimationFrame=fn=>window.__raf(time=>window.__holdFrames?window.__frames.push(fn):fn(time)); [...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="Add entry").click(); return true;');
  await waitFor('document.querySelectorAll("[data-symbol]").length===1', 'explicit seed');
  assert.equal(evaluate('return [...document.querySelectorAll("button")].find(b=>b.textContent==="Refresh index").disabled;'), false, 'request state must not wait for a viewport frame');
  evaluate('window.__holdFrames=false; window.requestAnimationFrame=window.__raf; for(const frame of window.__frames) requestAnimationFrame(frame); return true;');
  await delay(400); click('Close symbol library');
  click('Connections for entry'); await waitFor('document.querySelectorAll("[data-connection-target]").length>0', 'connections');
  assert.equal(evaluate('return document.querySelectorAll("[data-symbol]").length;'), 1);
  const target = await api('/api/board/search?q=normalize&kind=function');
  const normalize = target.items.find(item => item.name === 'normalize'); assert.ok(normalize);
  click('Connections for target normalize'); await waitFor('[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="Back to previous connections")', 'Connections Back');
  click('Back to previous connections'); click('Add target normalize');
  await waitFor('document.querySelectorAll("[data-symbol]").length===2', 'chosen target only'); click('Close connections');
  pass('real-index explicit selection and Connections Back');

  click('Open entry source');
  await waitFor('document.querySelector(`[data-symbol][data-source-related="true"]`)', 'selected source graph highlight');
  await waitFor('[...document.querySelectorAll(".source-card [role=link]")].some(link=>link.textContent.trim()==="decorate")', 'source reference');
  evaluate('[...document.querySelectorAll(".source-card [role=link]")].find(link=>link.textContent.trim()==="decorate").click(); return true;');
  await waitFor('document.querySelectorAll("[data-code-card]").length===2', 'source follows without replacement');
  assert.equal(evaluate('return document.querySelectorAll("[data-symbol]").length;'), 2);
  pass('indexed source links open independent source cards without admitting graph neighbours');
  click('Fit code (2)'); await delay(300);
  evaluate('document.querySelector(".source-card details.size summary").click(); return true;');
  click('Wider'); click('Taller'); click('Collapse code card entry');
  pass('source-card resize and collapsed expanded-height preservation prepared');

  click('Fit graph'); await delay(250); click('Hide normalize'); click('Hidden items (1)');
  await waitFor('document.querySelector(`aside[aria-label="Hidden items"]`)', 'named hidden list'); click('Restore');
  await waitFor('document.querySelectorAll("[data-symbol]").length===2', 'restore'); command('press', 'Escape');
  await waitFor('!document.querySelector(`aside[aria-label="Hidden items"]`)', 'Escape after restoring last hidden row');
  evaluate('window.__position=document.querySelector(".svelte-flow__node-symbol").style.transform; document.querySelector(".svelte-flow__node-symbol").focus(); return true;');
  command('press', 'Enter'); command('press', 'ArrowRight');
  assert.equal(evaluate('return document.querySelector(".svelte-flow__node-symbol").style.transform!==window.__position;'), true);
  pass('hidden recovery and keyboard card movement');

  const headerPoint = evaluate('const node=document.querySelector(".svelte-flow__node-symbol"); window.__dragPosition=node.style.transform; const box=node.querySelector(".board-drag-handle").getBoundingClientRect(); return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};');
  await dragPoint(headerPoint, 45, 24);
  assert.equal(evaluate('return document.querySelector(".svelte-flow__node-symbol").style.transform!==window.__dragPosition;'), true);
  const panPoint = evaluate('const box=document.querySelector(".svelte-flow__pane").getBoundingClientRect(); window.__panViewport=document.querySelector(".svelte-flow__viewport").style.transform; for (const [x,y] of [[box.right-140,box.top+120],[box.right-280,box.bottom-120],[box.left+100,box.bottom-180]]) {const el=document.elementFromPoint(x,y);if(el?.closest(".svelte-flow__pane")&&!el.closest(".svelte-flow__node,.svelte-flow__controls,.svelte-flow__minimap,aside,button"))return{x:Math.round(x),y:Math.round(y)};} throw new Error("No unobstructed canvas pan point");');
  await dragPoint(panPoint, -55, 35);
  assert.equal(evaluate('return document.querySelector(".svelte-flow__viewport").style.transform!==window.__panViewport;'), true);
  evaluate('window.__zoomScale=new DOMMatrixReadOnly(document.querySelector(".svelte-flow__viewport").style.transform).a; window.__wheelEvents=[]; window.addEventListener("wheel",event=>{const receipt={target:event.target?.tagName,className:String(event.target?.className),x:event.clientX,y:event.clientY,dy:event.deltaY,ctrl:event.ctrlKey,trusted:event.isTrusted}; window.__wheelEvents.push(receipt);setTimeout(()=>receipt.prevented=event.defaultPrevented,0);},{capture:true}); return true;');
  command('mouse', 'move', String(panPoint.x), String(panPoint.y)); await nativeWheelAt(base, panPoint, -180);
  await delay(300);
  fs.writeFileSync(path.join(work, 'wheel.json'), JSON.stringify(evaluate('return {before:window.__zoomScale,after:new DOMMatrixReadOnly(document.querySelector(".svelte-flow__viewport").style.transform).a,events:window.__wheelEvents};'), null, 2));
  await waitFor('new DOMMatrixReadOnly(document.querySelector(".svelte-flow__viewport").style.transform).a!==window.__zoomScale', 'native wheel zoom');
  assert.equal(evaluate('return window.__wheelEvents.some(event=>event.trusted&&event.dy===-180&&event.x>0&&event.y>0);'), true);
  pass('real pointer dragging, canvas panning and trusted native wheel zoom');

  fill('Board name', 'Acceptance board'); click('Save');
  await waitFor('document.querySelector(".savebar").textContent.includes("Saved")&&!document.querySelector(".savebar").textContent.includes("Unsaved")', 'save');
  const saved = (await api('/api/boards')).boards.find(item => item.name === 'Acceptance board'); assert.ok(saved);
  const document = (await api(`/api/boards/${saved.id}`)).board;
  assert.equal(document.symbols.filter(item => item.included).length, 2); assert.equal(document.cards.length, 2);
  assert.ok(document.cards.some(item => item.collapsed && item.width > 530 && item.height > 310));
  assert.equal(JSON.stringify(document).includes('return value.trim'), false);
  click('New'); click('Saved boards'); await delay(150); click('Open Acceptance board');
  await waitFor('document.querySelectorAll("[data-symbol]").length===2&&document.querySelectorAll("[data-code-card]").length===2', 'reopen');
  click('Save'); await waitFor('!document.querySelector(".savebar").textContent.includes("Unsaved")', 'reopened geometry save');
  const reopened = (await api(`/api/boards/${saved.id}`)).board;
  assert.deepEqual(arrangement(reopened), arrangement(document));
  pass('metadata-only reopen preserves identity-keyed geometry, viewport, hidden/expanded state and source-card sizes/collapse/z-order');

  click('+ Add symbols'); click('Folders'); await waitFor('document.querySelector("aside").textContent.includes("Preview symbols")', 'folder preview');
  click('Preview folder src'); await waitFor('document.querySelector(`[aria-label="Symbol path filter"]`)?.value==="src"', 'folder scope');
  assert.equal(evaluate('return document.querySelectorAll("[data-symbol]").length;'), 2);
  click('Namespaces'); await waitFor('document.querySelector("aside").textContent.includes("Preview symbols")', 'namespace preview');
  const namespaces = await api('/api/board/groups?type=namespace'); const group = namespaces.items.find(item => item.name.includes('Review.Sample')); assert.ok(group);
  click(`Preview namespace ${group.name}`); await waitFor('document.querySelector("aside").textContent.includes("Namespace:")', 'namespace scope');
  pass('counted folder and namespace selection does not auto-add symbols');
  command('press', 'Escape');

  const hiddenTests = await api('/api/board/search?q=TestTarget'); assert.equal(hiddenTests.total, 0);
  const visibleTests = await api('/api/board/search?q=TestTarget&tests=1'); assert.ok(visibleTests.total > 0);
  const hiddenGenerated = await api('/api/board/search?q=GeneratedTarget'); assert.equal(hiddenGenerated.total, 0);
  assert.ok((await api('/api/board/search?q=GeneratedTarget&generated=1')).total > 0);
  command('find', 'label', 'Tests', 'check'); command('find', 'label', 'Generated code', 'check'); command('find', 'label', 'Uncertain matches', 'check');
  click('Save'); await delay(250);
  const filtered = (await api(`/api/boards/${saved.id}`)).board;
  assert.equal(filtered.filters.includeTests, true); assert.equal(filtered.filters.includeGenerated, true); assert.equal(filtered.filters.includeUncertain, true);
  pass('default visibility filters and persisted opt-in controls');

  const hub = (await api('/api/board/search?q=Hub&kind=class')).items.find(item => item.name === 'Hub'); assert.ok(hub);
  const started = performance.now(); const projectionResponse = await fetch(`${base}/api/board?ids=${encodeURIComponent(JSON.stringify([hub.id, normalize.id]))}`);
  const bytes = await projectionResponse.text(); const projection = JSON.parse(bytes); const queryMs = performance.now() - started;
  assert.ok(projection.symbols.length >= 700); assert.ok(queryMs < 2000, `hub query ${queryMs}ms`);
  const peerPage = await api(`/api/board/connections?id=${encodeURIComponent(normalize.id)}&direction=incoming&members=0&kind=calls&limit=30`);
  assert.ok(peerPage.total >= 700); assert.equal(peerPage.items.length, 30); assert.notEqual(peerPage.nextOffset, null);
  const projectionSamples = []; const connectionSamples = [];
  for (let sample = 0; sample < 10; sample++) {
    let start = performance.now(); const boardResponse = await fetch(`${base}/api/board?ids=${encodeURIComponent(JSON.stringify([hub.id, normalize.id]))}`); assert.equal(boardResponse.status, 200); await boardResponse.text(); projectionSamples.push(performance.now() - start);
    start = performance.now(); await api(`/api/board/connections?id=${encodeURIComponent(normalize.id)}&direction=incoming&members=0&kind=calls&limit=30`); connectionSamples.push(performance.now() - start);
  }
  const distribution = samples => { const sorted = [...samples].sort((a,b)=>a-b); const mid = Math.floor(sorted.length/2); return { samples: sorted.length, medianMs: +(sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2).toFixed(2), p95Ms: +sorted[Math.ceil(sorted.length*.95)-1].toFixed(2), maxMs: +sorted.at(-1).toFixed(2) }; };
  const projectionTiming = distribution(projectionSamples); const connectionTiming = distribution(connectionSamples);
  assert.ok(projectionTiming.p95Ms < 2000 && connectionTiming.p95Ms < 2000);
  pass('hub-heavy bounded projection and target paging', { symbols: projection.symbols.length, edges: projection.relations.length, bytes: Buffer.byteLength(bytes), queryMs: Math.round(queryMs), projectionTiming, connectionTiming });

  // Keyboard source controls must resize without moving the canvas item.
  click('Fit code (2)'); await delay(300);
  evaluate('const card=[...document.querySelectorAll("[data-code-card]")].find(item=>item.querySelector(".size summary")); window.__card=card.closest(".svelte-flow__node"); window.__cardWidth=window.__card.style.width; window.__cardPosition=window.__card.style.transform; card.querySelector(".size summary").click(); [...card.querySelectorAll("button")].find(b=>b.textContent==="Wider").focus(); return true;');
  command('press', 'Enter');
  await waitFor('window.__card.style.width!==window.__cardWidth', 'keyboard source resize');
  command('press', 'ArrowDown');
  assert.equal(evaluate('return window.__card.style.transform===window.__cardPosition;'), true, 'source controls must not trigger node movement');
  click('Save'); await waitFor('!document.querySelector(".savebar").textContent.includes("Unsaved")', 'resized metadata save');
  pass('keyboard source resize and native-control key isolation');

  // A nested C# member is located exactly, then hidden/restored without pinning.
  click('New'); click('+ Add symbols');
  if (evaluate('return [...document.querySelectorAll("button")].some(b=>b.textContent==="Clear namespace");')) click('Clear namespace');
  fill('Search indexed symbols', 'Outer'); click('Search index');
  const outer = (await api('/api/board/search?q=Outer&kind=class')).items.find(item => item.name === 'Outer');
  const compute = (await api('/api/board/search?q=Compute&kind=method')).items.find(item => item.name === 'Compute'); assert.ok(outer && compute);
  await waitFor(`[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")===${JSON.stringify(`Add ${outer.qualifiedName}`)})`, 'nested container search');
  click(`Add ${outer.qualifiedName}`); await delay(400);
  fill('Search indexed symbols', 'Compute'); click('Search index');
  await waitFor(`[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")===${JSON.stringify(`Locate ${compute.qualifiedName}`)})`, 'folded member search');
  click(`Locate ${compute.qualifiedName}`);
  await waitFor('document.querySelector(".member.located [aria-current=location]") && document.querySelector(".notice").textContent.startsWith("Located exact member:")', 'exact nested Locate');
  assert.equal(evaluate('return document.querySelector(".member.located").dataset.depth;'), '2');
  click('Close symbol library');
  click(`Hide member ${compute.qualifiedName}`);
  await waitFor('document.querySelector(".member.hidden")', 'hidden inline preference');
  assert.equal(evaluate('return document.querySelectorAll("[data-symbol]").length;'), 1);
  fill('Board name', 'Nested board'); click('Save'); await waitFor('!document.querySelector(".savebar").textContent.includes("Unsaved")', 'hidden inline save');
  const nestedSaved = (await api('/api/boards')).boards.find(item => item.name === 'Nested board');
  const nestedDocument = (await api(`/api/boards/${nestedSaved.id}`)).board;
  assert.ok(nestedDocument.symbols.some(item => item.identity.qualifiedName === compute.qualifiedName && item.hidden && !item.included));
  click('New'); click('Saved boards'); await delay(150); click('Open Nested board');
  await waitFor('document.querySelector(".member.hidden")', 'restored nested hidden preference');
  assert.equal(evaluate('return document.querySelector(".member.hidden").querySelectorAll(".svelte-flow__handle").length;'), 0);
  click(`Restore member ${compute.qualifiedName}`);
  await waitFor('!document.querySelector(".member.hidden")', 'inline member restore');
  assert.equal(evaluate('return document.querySelectorAll("[data-symbol]").length;'), 1);
  evaluate('window.__ownerPosition=document.querySelector("[data-symbol]").closest(".svelte-flow__node").style.transform; return true;');
  click(`Pin ${compute.qualifiedName} separately`);
  await waitFor('document.querySelectorAll("[data-symbol]").length===2', 'independent nested pin');
  assert.equal(evaluate('return document.querySelector("[data-symbol]").closest(".svelte-flow__node").style.transform===window.__ownerPosition;'), true);
  click('Save'); await waitFor('!document.querySelector(".savebar").textContent.includes("Unsaved")', 'nested pin save');
  pass('recursive member Locate, persistent inline hide/restore and independent pin without moving owner');

  // Use the 700-member hub in the canvas, not only through HTTP.
  click('New'); click('+ Add symbols'); fill('Search indexed symbols', 'Hub'); click('Search index');
  await waitFor('[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="Add Hub")', 'hub search');
  click('Add Hub'); await delay(400); click('Close symbol library'); click('Expand Hub members');
  await waitFor('document.querySelectorAll(".member").length===6', 'bounded initial outline');
  for (let page = 0; page < 3; page++) {
    await delay(60); click('Fit graph'); await delay(300);
    click('Show more members of Hub'); await waitFor(`document.querySelectorAll(".member").length===${12 + page * 6}`, 'incremental outline reveal');
  }
  assert.equal(evaluate('return document.querySelectorAll("[data-symbol]").length;'), 1);
  click('Collapse Hub members');
  click('+ Add symbols'); fill('Search indexed symbols', 'normalize'); click('Search index');
  await waitFor('[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="Add normalize")', 'hub peer search');
  click('Add normalize'); await waitFor('document.querySelectorAll("[data-symbol]").length===2', 'explicit hub peer'); click('Close symbol library');
  click('Fit graph'); await delay(300); click('Connections for normalize'); click('Incoming');
  evaluate('const select=document.querySelector(`[aria-label="Connection relationship filter"]`); select.value="calls"; select.dispatchEvent(new Event("change",{bubbles:true})); return true;');
  await waitFor('document.querySelectorAll("[data-connection-target]").length===30', 'bounded hub targets');
  fill('Search connection targets', 'method3'); click('Next targets');
  await waitFor(`document.querySelector(".connections-panel .batch").textContent.includes("${peerPage.total} targets")`, 'frozen submitted criteria during paging');
  assert.equal(evaluate('return document.querySelectorAll("[data-connection-target]").length;'), 30);
  click('Previous targets'); click('Find');
  await waitFor('document.querySelector(".connections-panel .batch").textContent.includes("111 targets")', 'submitted hub target filter');
  const firstTarget = (await api(`/api/board/connections?id=${encodeURIComponent(normalize.id)}&direction=incoming&members=0&kind=calls&q=method3&limit=30`)).items[0].target;
  click(`Connections for target ${firstTarget.qualifiedName}`); await waitFor('[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="Back to previous connections")', 'hub drill');
  click('Back to previous connections'); await waitFor('document.querySelector(".connections-panel .batch").textContent.includes("111 targets")', 'hub Back criteria');
  command('set', 'viewport', '1366', '768');
  assert.ok(evaluate('const list=document.querySelector(".connections-panel .result-list").getBoundingClientRect(); return list.height;') >= 70);
  command('screenshot', path.join(work, 'laptop-hub.png'));
  command('press', 'Escape');
  assert.ok(evaluate('return Boolean(document.activeElement?.getAttribute("aria-label")?.startsWith("Connections for"));'));
  click('Open Hub source');
  await waitFor('document.querySelector(".source-card .source")?.scrollHeight>document.querySelector(".source-card .source")?.clientHeight', 'long source scroll');
  await delay(350);
  const bodyPoint = evaluate('const box=document.querySelector(".source-card .source").getBoundingClientRect(); window.__sourceViewport=document.querySelector(".svelte-flow__viewport").style.transform; return {x:Math.round(box.left+80),y:Math.round(box.top+60)};');
  command('mouse', 'move', String(bodyPoint.x), String(bodyPoint.y));
  command('scroll', 'down', '180', '--selector', '.source-card .source');
  await waitFor('document.querySelector(".source-card .source").scrollTop>0', 'source-only scroll');
  assert.equal(evaluate('return document.querySelector(".svelte-flow__viewport").style.transform===window.__sourceViewport;'), true);
  pass('long source scrolling does not pan or zoom the board');
  fill('Board name', 'Hub board'); click('Save'); await waitFor('!document.querySelector(".savebar").textContent.includes("Unsaved")', 'hub board save');
  pass('hub outline paging, frozen target windows, scoped Back and laptop/keyboard focus recovery');

  const readOnlyBase = await serve(true);
  command('open', `${readOnlyBase}/#/board`); await waitFor('document.querySelector(`[aria-label="Board name"]`)', 'read-only Board');
  click('Saved boards'); await delay(150); click('Open Acceptance board'); await waitFor('document.querySelectorAll("[data-symbol]").length===2', 'read-only load');
  assert.equal(evaluate('return [...document.querySelectorAll("button")].find(b=>b.textContent==="Save").disabled;'), true);
  const refused = await fetch(`${readOnlyBase}/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-CodeGraph-UI': '1' }, body: '{}' }); assert.equal(refused.status, 403);
  pass('read-only loads saved metadata and refuses browser/server mutations');
  assert.equal(command('errors'), '');
  for (const [file, content] of original) assert.deepEqual(fs.readFileSync(path.join(project, 'src', file)), content);
  pass('viewer did not change source files');
  console.log(`Artifacts: ${work}`);
} finally {
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify({ viewerExecutable, results }, null, 2));
  try { fs.writeFileSync(path.join(work, 'console.txt'), command('errors')); fs.writeFileSync(path.join(work, 'snapshot.txt'), command('snapshot')); command('screenshot', path.join(work, 'final.png')); } catch {}
  try { command('close'); } catch {}
  for (const child of processes) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })]);
  }
}
