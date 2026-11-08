/** Real-browser regression for reviewer-owned comment cards. Build first.
 * CODEGRAPH_BOARD_ARTIFACT_ROOT selects the parent for retained test evidence.
 * CODEGRAPH_BOARD_EXECUTABLE optionally selects an installed viewer build.
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
const CodeGraph = require(path.join(root, 'dist/index.js')).default;
const work = fs.mkdtempSync(path.join(process.env.CODEGRAPH_BOARD_ARTIFACT_ROOT ?? os.tmpdir(), 'codegraph-comments-browser-'));
console.log(`Artifacts: ${work}`);
const project = path.join(work, 'project'); fs.mkdirSync(project);
const source = 'export function example() { return 1; }\n'; fs.writeFileSync(path.join(project, 'example.ts'), source);
const cg = CodeGraph.initSync(project, { config: { include: ['*.ts'], exclude: [] } });
await cg.indexAll(); cg.resolveReferences(); cg.close();
const session = `board-comments-${process.pid}`;
function command(...args) {
  return execFileSync('agent-browser', ['--session', session, ...(process.env.CODEGRAPH_BROWSER_EXECUTABLE ? ['--executable-path', process.env.CODEGRAPH_BROWSER_EXECUTABLE] : []), ...args],
    { encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 }).trim();
}
function evaluate(body) { return JSON.parse(command('eval', `(async()=>{${body}})()`)); }
function click(name) { command('find', 'role', 'button', 'click', '--name', name, '--exact'); }
function fill(label, value) { command('find', 'label', label, 'fill', value); }
async function waitFor(expression) { command('wait', '--fn', expression); }
const children = [];
async function serve(readOnly = false) {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const executable = process.env.CODEGRAPH_BOARD_EXECUTABLE;
  const args = ['ui', project, '--no-open', '--port', String(port), ...(readOnly ? ['--read-only'] : [])];
  const child = spawn(executable ?? process.execPath, executable ? args : ['--liftoff-only', '--disable-warning=ExperimentalWarning', path.join(root, 'dist/bin/codegraph.js'), ...args],
    { cwd: root, env: { ...process.env, CODEGRAPH_UI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let log = ''; child.stdout.on('data', chunk => log += chunk); child.stderr.on('data', chunk => log += chunk);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Viewer exited: ${log}`);
    try { if ((await fetch(`${base}/api/stats`)).ok) return base; } catch {}
    await delay(100);
  }
  throw new Error(`Viewer did not start: ${log}`);
}
function geometry() { return evaluate('const node=document.querySelector(".svelte-flow__node-comment");return {position:node.style.transform,width:node.style.width,height:node.style.height,viewport:document.querySelector(".svelte-flow__viewport").style.transform};'); }
async function drag(selector, dx, dy) {
  const point = evaluate(`const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};`);
  command('mouse', 'move', String(point.x), String(point.y)); command('mouse', 'down');
  for (let step = 1; step <= 4; step++) command('mouse', 'move', String(point.x + dx * step / 4), String(point.y + dy * step / 4));
  command('mouse', 'up'); await delay(100);
}
try {
  const base = await serve();
  command('open', `${base}/#/board`); command('set', 'viewport', '1440', '1000');
  await waitFor('document.querySelector("[data-add-symbols]")'); command('snapshot');
  click('+ Add comment'); await waitFor('document.activeElement?.getAttribute("aria-label")==="Comment text"');
  const text = '  My review notes\n\t<img src=x onerror=alert(1)>\nKeep this whitespace.\n';
  fill('Comment text', text);
  assert.equal(evaluate('return document.querySelector("textarea").value;'), text);
  assert.equal(evaluate('return document.querySelectorAll(".comment-card img").length;'), 0);
  const original = geometry(); command('press', 'ArrowLeft'); command('press', 'Delete');
  assert.deepEqual(geometry(), original, 'text keyboard input must not move or delete a card');
  fill('Comment text', text);
  await drag('.comment-card header strong', 96, 48);
  const moved = geometry(); assert.notEqual(moved.position, original.position); assert.equal(moved.viewport, original.viewport);
  await drag('.svelte-flow__node-comment .svelte-flow__resize-control.bottom.right', 80, 40);
  const resized = geometry(); assert.notEqual(resized.width, moved.width); assert.notEqual(resized.height, moved.height); assert.equal(resized.viewport, original.viewport);
  fill('Board name', 'Comment browser review'); click('Save');
  await waitFor('document.querySelector(".savebar").textContent.includes("Saved")&&!document.querySelector(".savebar").textContent.includes("Unsaved")');
  const list = await (await fetch(`${base}/api/boards`)).json(); const id = list.boards[0].id;
  const saved = (await (await fetch(`${base}/api/boards/${id}`)).json()).board;
  assert.equal(saved.comments[0].text, text); assert.deepEqual(saved.symbols, []); assert.deepEqual(saved.cards, []);
  evaluate('const button=[...document.querySelectorAll("button")].find(item=>item.textContent==="Export JSON");button.id="comment-test-export";return true;');
  const exported = path.join(work, 'comments.json'); command('download', '#comment-test-export', exported);
  assert.deepEqual(JSON.parse(fs.readFileSync(exported, 'utf8')).document.comments, saved.comments);
  click('New'); assert.equal(evaluate('return document.querySelectorAll("[data-comment-card]").length;'), 0);
  command('upload', 'input[type=file]', exported); await waitFor('document.querySelector("textarea")?.value.includes("My review notes")');
  assert.equal(evaluate('return document.querySelector("textarea").value;'), text);
  evaluate('window.confirm=()=>true;return true;');
  click('Saved boards'); click('Open Comment browser review');
  await waitFor('document.querySelector("textarea")?.value.includes("My review notes")');
  assert.deepEqual(geometry(), resized);
  command('screenshot', path.join(work, 'comment-card.png'));
  const readonly = await serve(true); command('open', `${readonly}/#/board`); await waitFor('document.querySelector("[data-add-symbols]")');
  click('Saved boards'); click('Open Comment browser review'); await waitFor('document.querySelector("textarea")');
  fill('Comment text', 'Editable in memory');
  assert.equal(evaluate('return [...document.querySelectorAll("button")].find(b=>b.textContent==="Save").disabled;'), true);
  click('Delete comment'); assert.equal(evaluate('return document.querySelectorAll("[data-comment-card]").length;'), 0);
  assert.equal(fs.readFileSync(path.join(project, 'example.ts'), 'utf8'), source);
  const stored = JSON.parse(fs.readFileSync(path.join(project, '.codegraph/ui/boards', `${id}.json`), 'utf8'));
  assert.deepEqual(stored.document, saved, 'read-only editing must leave saved metadata unchanged');
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify({ passed: ['multiline plain text', 'keyboard editing isolation', 'pointer drag', 'pointer resize', 'save', 'export/import', 'open geometry', 'read-only editing/deletion without persistence', 'source unchanged'] }, null, 2));
  console.log('PASS comment-card browser checks');
} finally {
  try { command('close'); } catch {}
  for (const child of children) { child.kill('SIGTERM'); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }); }
}
