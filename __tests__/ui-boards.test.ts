import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';
import { MAX_BOARD_DEPTH } from '../src/graph/board-projection';
import { buildBoard } from '../src/ui-server/api/board';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { startUiServer, type UiServerHandle } from '../src/ui-server';
import {
  BOARDS_RELATIVE_DIR, MAX_BOARDS, MAX_BOARD_FILE_BYTES, MAX_BOARD_SCAN_ENTRIES,
  BoardConflictError, boardPath, boardsDirectory, deleteStoredBoard, isBoardId,
  listStoredBoards, parseBoardDocument, readStoredBoard, saveStoredBoard,
  type BoardDocument, type BoardsOptions,
} from '../src/ui-server/api/board-store';
import { buildBoards, handleBoardsRequest, loadBoard, resolveBoard } from '../src/ui-server/api/boards';

const writable: BoardsOptions = { readOnly: false, readOnlyReason: null };
const readOnly: BoardsOptions = { readOnly: true, readOnlyReason: 'Read-only fixture.' };
function document(): BoardDocument {
  return {
    version: 1,
    symbols: [{ key: 's1', identity: { id: 'old-id', qualifiedName: 'alpha', kind: 'function', file: 'src/a.ts' }, position: { x: 12, y: -9 }, included: true, hidden: true, expanded: true }],
    cards: [{ key: 'c1', symbolKey: 's1', position: { x: 30, y: 40 }, width: 400, height: 300, collapsed: false, zIndex: 3 }],
    viewport: { x: 1, y: 2, zoom: 0.75 }, filters: { kind: 'all', showStructure: false },
  };
}
let temp: string;
let root: string;
let indexRoot: string;
let cg: CodeGraph;
let server: UiServerHandle | undefined;
let viewerDir: string;
const alphaSource = 'export function alpha(): number { return 1; }\n';
beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-boards-'));
  indexRoot = path.join(temp, 'indexed');
  fs.mkdirSync(path.join(indexRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(indexRoot, 'src/a.ts'), alphaSource);
  fs.writeFileSync(path.join(indexRoot, 'src/context.ts'), 'export const contextFixture = 1;\n');
  fs.writeFileSync(path.join(indexRoot, 'src/multiline.ts'), 'export function multiline(\n\tvalue: string\r\n): string {\n  return value;\n}\n');
  fs.writeFileSync(path.join(indexRoot, 'src/overloads.ts'), [
    'export function duplicate(x: string): string;',
    'export function duplicate(x: number): number;',
    'export function duplicate(x: string | number): string | number { return x; }',
  ].join('\n'));
  cg = CodeGraph.initSync(indexRoot, { config: { include: ['src/**/*.ts'], exclude: [] } });
  await cg.indexAll();
  // The TS extractor collapses overload declarations. Seed a second real SQLite
  // row to exercise an index that retains duplicate/partial declarations.
  const duplicate = cg.getNodesByQualifiedName('duplicate')[0]!;
  const connection = DatabaseConnection.open(getDatabasePath(indexRoot));
  try {
    const queries = new QueryBuilder(connection.getDb());
    queries.insertNode({ ...duplicate, id: 'duplicate-declaration', startLine: 2, signature: 'duplicate(x: number): number' });
    const add = (id: string, kind: Node['kind'], startColumn = 0, filePath = 'src/context.ts') => queries.insertNode({
      ...duplicate, id, kind, name: id, qualifiedName: id, filePath, startLine: 3, endLine: 4, startColumn,
      endColumn: startColumn + 1, signature: undefined,
    });
    const contains = (source: string, target: string, confidence?: number) => queries.insertEdge({ source, target, kind: 'contains',
      ...(confidence === undefined ? {} : { metadata: { confidence } }) });
    add('context-file', 'file'); add('context-namespace', 'namespace'); add('context-owner', 'class');
    add('context-expanded', 'class', 4); add('context-hidden', 'method', 18); add('context-source', 'function', 7);
    add('context-sibling', 'method', 2); add('context-neighbor', 'function');
    add('context-test', 'method', 0, 'src/context.test.ts'); add('context-generated', 'field', 0, 'src/schema.pb.go');
    add('context-uncertain', 'property');
    contains('context-file', 'context-namespace'); contains('context-namespace', 'context-owner');
    contains('context-namespace', 'context-source'); contains('context-owner', 'context-expanded', 0.4);
    for (const target of ['context-hidden', 'context-sibling', 'context-test', 'context-generated']) contains('context-expanded', target);
    contains('context-expanded', 'context-uncertain', 0.4);
    queries.insertEdge({ source: 'context-hidden', target: 'context-neighbor', kind: 'calls' });
    for (let i = 0; i < MAX_BOARD_DEPTH + 6; i++) {
      add(`context-deep-${i}`, 'namespace');
      if (i) contains(`context-deep-${i - 1}`, `context-deep-${i}`);
    }
  } finally { connection.close(); }
  viewerDir = path.join(temp, 'viewer');
  fs.mkdirSync(viewerDir);
  fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><title>fixture</title>');
}, 120_000);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(temp, 'store-'));
  fs.mkdirSync(path.join(root, '.codegraph'));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.join(indexRoot, '.codegraph/ui'), { recursive: true, force: true });
});
afterAll(() => { cg?.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function save(name = 'Example', doc = document(), id?: string) {
  return saveStoredBoard(root, { name, document: doc, ...(id === undefined ? {} : { id }) }, writable);
}
function rawBoard(id: string, doc = document()) {
  return { version: 1, id, name: id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', document: doc };
}
function put(id: string, contents: string) {
  fs.mkdirSync(boardsDirectory(root), { recursive: true });
  fs.writeFileSync(path.join(root, BOARDS_RELATIVE_DIR, `${id}.json`), contents);
}

function contextDocument(): BoardDocument {
  const doc = document();
  const ids = ['context-owner', 'context-expanded', 'context-hidden', 'context-source', 'context-test'];
  const nodes = cg.getNodesByIds(ids);
  doc.symbols = ids.map((id) => {
    const node = nodes.get(id)!;
    return { key: id, identity: { id, qualifiedName: node.qualifiedName, kind: node.kind, file: node.filePath },
      position: { x: 12, y: -9 }, included: id === 'context-owner', hidden: id === 'context-hidden' || id === 'context-test',
      expanded: id === 'context-expanded' };
  });
  doc.cards[0]!.symbolKey = 'context-source';
  return doc;
}

describe('board import validation without storage', () => {
  it.each([true, false])('round-trips extracted multiline signatures for included=%s identities', (included) => {
    const node = cg.getNodesByQualifiedName('multiline')[0]!;
    expect(node.signature).toContain('\n');
    const doc = document();
    doc.symbols[0]!.included = included;
    doc.symbols[0]!.identity = { id: node.id, qualifiedName: node.qualifiedName, kind: node.kind, file: node.filePath, signature: node.signature };
    expect(parseBoardDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    const saved = save('Multiline', doc);
    expect(readStoredBoard(root, saved.id)!.document).toEqual(doc);
    expect(resolveBoard(cg, doc).resolutions[0]).toMatchObject({ status: 'ok', node: { id: node.id, signature: node.signature } });
    const normalized = structuredClone(doc); normalized.symbols[0]!.identity.signature = node.signature!.replace(/\s+/g, ' ');
    expect(resolveBoard(cg, normalized).resolutions[0]).toMatchObject({ status: 'missing', node: null });
  });

  it('allows bounded signature whitespace without relaxing any other identity field', () => {
    for (const signature of ['(\n  value: string\n): string', '(\r\n\tvalue: string\r\n): string', 's'.repeat(4096)]) {
      const doc = document(); doc.symbols[0]!.identity.signature = signature;
      expect(parseBoardDocument(doc).symbols[0]!.identity.signature).toBe(signature);
    }
    for (const signature of ['', ' \t\r\n', 's'.repeat(4097), ...Array.from({ length: 33 }, (_, index) => index < 32 ? index : 127)
      .filter((code) => ![9, 10, 13].includes(code)).map((code) => `value${String.fromCharCode(code)}`)]) {
      const doc = document(); doc.symbols[0]!.identity.signature = signature;
      expect(() => parseBoardDocument(doc)).toThrow();
    }
    for (const field of ['id', 'qualifiedName', 'kind', 'file'] as const) {
      const doc = document(); doc.symbols[0]!.identity[field] = 'bad\nfield';
      expect(() => parseBoardDocument(doc), field).toThrow();
    }
  });
  it('round-trips the concrete document, including future kinds and hidden layout', () => {
    const doc = document();
    doc.symbols[0]!.identity.kind = 'future_kind';
    doc.filters.kind = 'future_relation';
    expect(parseBoardDocument(doc)).toEqual(doc);
    const parsed = parseBoardDocument(doc);
    parsed.symbols[0]!.position.x = 99;
    expect(doc.symbols[0]!.position.x).toBe(12);
    expect(fs.existsSync(path.join(root, BOARDS_RELATIVE_DIR))).toBe(false);
    expect(parseBoardDocument({ ...doc, symbols: [], cards: [] }).symbols).toEqual([]);
  });
  it.each([false, true])('round-trips tall source cards through validation, storage and resolution (collapsed=%s)', (collapsed) => {
    for (const height of [60, 4097, 10_000, 1_000_001]) {
      const doc = document(); Object.assign(doc.cards[0]!, { height, collapsed });
      expect(parseBoardDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
      const saved = save(`Height ${height}`, doc);
      const restored = readStoredBoard(root, saved.id)!.document;
      expect(restored).toEqual(doc);
      expect(resolveBoard(cg, restored).board).toEqual(doc);
    }
  });
  it('still rejects non-finite, nonnumeric and below-minimum source-card heights', () => {
    for (const height of [NaN, Infinity, -Infinity, undefined, null, '8192', true, [], {}, -1, 0, 59]) {
      const doc = document(); (doc.cards[0] as any).height = height;
      expect(() => parseBoardDocument(doc)).toThrow(/finite and at least 60/);
      expect(() => save('Invalid source height', doc)).toThrow(/finite and at least 60/);
    }
  });
  it('preserves the empty all-kinds filter through validation, save/load and resolution', () => {
    const doc = document();
    doc.filters.kind = '';
    expect(parseBoardDocument(doc)).toEqual(doc);
    const saved = save('All kinds', doc);
    expect(readStoredBoard(root, saved.id)!.document).toEqual(doc);
    expect(resolveBoard(cg, doc).board).toEqual(doc);
    expect(resolveBoard(cg, readStoredBoard(root, saved.id)!.document).resolutions).toHaveLength(1);
    for (const kind of [' '.repeat(2), 'k'.repeat(129), 'calls\u0000', '\n', undefined, null, 1]) {
      expect(() => parseBoardDocument({ ...doc, filters: { ...doc.filters, kind } })).toThrow();
    }
    expect(parseBoardDocument({ ...doc, filters: { kind: 'k'.repeat(128), showStructure: true } }).filters.kind).toHaveLength(128);
  });
  it('round-trips optional visibility filters while preserving legacy V1 defaults and strict booleans', () => {
    const legacy = document();
    const restored = parseBoardDocument(legacy);
    expect(restored).toEqual(legacy);
    expect(restored.filters.includeTests ?? false).toBe(false);
    expect(restored.filters.includeGenerated ?? false).toBe(false);
    expect(restored.filters.includeUncertain ?? false).toBe(false);
    for (const includeTests of [false, true]) for (const includeGenerated of [false, true]) for (const includeUncertain of [false, true]) {
      const doc = document();
      Object.assign(doc.filters, { includeTests, includeGenerated, includeUncertain });
      expect(parseBoardDocument(doc)).toEqual(doc);
      const saved = save(`Filters ${includeTests}/${includeGenerated}/${includeUncertain}`, doc);
      expect(readStoredBoard(root, saved.id)!.document).toEqual(doc);
      expect(resolveBoard(cg, doc).board).toEqual(doc);
    }
    for (const key of ['includeTests', 'includeGenerated', 'includeUncertain']) {
      for (const value of [null, 0, 1, '0', '1', 'true', [], {}]) {
        const doc = document();
        (doc.filters as any)[key] = value;
        expect(() => parseBoardDocument(doc)).toThrow(/boolean/);
      }
    }
    // Discovery scopes cannot turn an imported document into project authority.
    for (const key of ['namespace', 'libraryPath', 'projectPath', 'path']) {
      const doc = document();
      (doc.filters as any)[key] = 'outside';
      expect(() => parseBoardDocument(doc)).toThrow(/Unknown board property/);
    }
  });
  it('persists bounded member reveal limits and source-only nested expansion without source cards', () => {
    const legacy = document();
    expect(parseBoardDocument(legacy).symbols[0]!.memberLimit ?? 6).toBe(6);
    for (const memberLimit of [1, 6, 50, 2048]) {
      const doc = document();
      Object.assign(doc.symbols[0]!, { included: false, hidden: false, expanded: true, memberLimit });
      doc.cards = [];
      expect(parseBoardDocument(doc)).toEqual(doc);
      const saved = save(`Nested ${memberLimit}`, doc);
      expect(readStoredBoard(root, saved.id)!.document).toEqual(doc);
      expect(resolveBoard(cg, doc).board).toEqual(doc);
    }
    for (const memberLimit of [null, '6', 0, -1, 1.5, 2049, Infinity, NaN, true]) {
      const doc = document();
      (doc.symbols[0] as any).memberLimit = memberLimit;
      expect(() => parseBoardDocument(doc)).toThrow();
    }
  });
  it('retains source-only identities without admitting graph membership', () => {
    const doc = document();
    doc.symbols[0]!.included = false;
    doc.symbols[0]!.hidden = false;
    expect(parseBoardDocument(doc)).toEqual(doc);
    const saved = save('Source only', doc);
    expect(readStoredBoard(root, saved.id)!.document).toEqual(doc);
  });
  it('retains hidden unpinned outline identities and restores visibility without pinning or hiding source cards', () => {
    for (const withSourceCard of [false, true]) {
      const doc = document();
      Object.assign(doc.symbols[0]!, { included: false, hidden: true, expanded: true, memberLimit: 50 });
      if (!withSourceCard) doc.cards = [];
      expect(parseBoardDocument(doc)).toEqual(doc);
      const name = `Hidden outline ${withSourceCard}`;
      const saved = saveStoredBoard(indexRoot, { name, document: doc }, writable);
      expect(readStoredBoard(indexRoot, saved.id)!.document).toEqual(doc);
      const loaded = loadBoard(cg, indexRoot, saved.id, readOnly);
      expect(loaded.board).toEqual(doc);
      expect(loaded.resolutions[0]!.node).not.toBeNull();
      expect(loaded.board.symbols[0]).toMatchObject({ included: false, hidden: true, expanded: true, memberLimit: 50 });
      const restored = parseBoardDocument(loaded.board);
      restored.symbols[0]!.hidden = false;
      expect(restored.symbols[0]!.included).toBe(false);
      expect(restored.cards).toEqual(doc.cards);
      expect(restored.symbols[0]!.position).toEqual(doc.symbols[0]!.position);
      saveStoredBoard(indexRoot, { id: saved.id, name, document: restored }, writable);
      expect(loadBoard(cg, indexRoot, saved.id, readOnly).board).toEqual(restored);
      expect(resolveBoard(cg, restored).board.symbols[0]).toMatchObject({ included: false, hidden: false, expanded: true, memberLimit: 50 });
    }
  });
  it('rejects duplicate identity tuples across distinct keys, ignoring node-id hints and membership', () => {
    for (const signature of [undefined, 'alpha(): number']) {
      for (const hint of [undefined, 'different-node-id']) {
        const doc = document();
        doc.symbols[0]!.identity.signature = signature;
        doc.symbols.push({ ...doc.symbols[0]!, key: 's2', included: false, hidden: false, identity: { ...doc.symbols[0]!.identity, id: hint } });
        expect(() => parseBoardDocument(doc)).toThrow(/Duplicate board symbol identity/);
        expect(() => save('Duplicate', doc)).toThrow(/Duplicate board symbol identity/);
      }
    }
    // All four tuple fields are significant; different signatures may represent
    // overloads, but resolution must still reject any live-node convergence.
    for (const change of [{ qualifiedName: 'other' }, { kind: 'future' }, { file: 'src/other.ts' }, { signature: 'alpha(): number' }]) {
      const doc = document();
      doc.symbols.push({ ...doc.symbols[0]!, key: 's2', identity: { ...doc.symbols[0]!.identity, ...change } });
      expect(parseBoardDocument(doc).symbols).toHaveLength(2);
    }
  });
  it('rejects multiple source cards for the same symbol, including source-only symbols', () => {
    for (const included of [true, false]) {
      const doc = document();
      doc.symbols[0]!.included = included;
      doc.symbols[0]!.hidden = false;
      // Keep cardinality valid so this exercises per-target uniqueness, not the
      // early check that source cards cannot outnumber retained symbols.
      doc.symbols.push({ ...doc.symbols[0]!, key: 's2', identity: { ...doc.symbols[0]!.identity, qualifiedName: 'other' } });
      doc.cards.push({ ...doc.cards[0]!, key: 'c2' });
      expect(() => parseBoardDocument(doc)).toThrow(/only one source card/);
      expect(() => save('Duplicate cards', doc)).toThrow(/only one source card/);
    }
  });
  it.each([33, 64, 128])('round-trips %i source cards within the shared identity limit', (count) => {
    const doc = document();
    const symbol = doc.symbols[0]!;
    const card = doc.cards[0]!;
    doc.symbols = Array.from({ length: 128 }, (_, i) => ({ ...symbol, key: `s${i}`, included: false, hidden: false, identity: { ...symbol.identity, qualifiedName: `symbol${i}` } }));
    doc.cards = Array.from({ length: count }, (_, i) => ({ ...card, key: `c${i}`, symbolKey: `s${i}` }));
    expect(parseBoardDocument(doc)).toEqual(doc);
    expect(readStoredBoard(root, save('Many sources', doc).id)!.document).toEqual(doc);
  });
  it('still rejects 129 distinct retained identities, including source-only identities', () => {
    const doc = document(); const symbol = doc.symbols[0]!;
    doc.symbols = Array.from({ length: 129 }, (_, i) => ({ ...symbol, key: `s${i}`, included: false, hidden: false,
      identity: { ...symbol.identity, qualifiedName: `symbol${i}` } }));
    doc.cards[0]!.symbolKey = 's0';
    expect(() => parseBoardDocument(doc)).toThrow(/at most 128 symbols/);
    expect(() => save('Too many identities', doc)).toThrow(/at most 128 symbols/);
  });
  it('rejects unknown properties at every level rather than retaining source, edges or credentials', () => {
    const mutations = [
      (d: any) => { d.source = 'not source'; },
      (d: any) => { d.edges = []; },
      (d: any) => { d.projectRoot = '/outside'; },
      (d: any) => { d.symbols[0].identity.token = 'not-a-real-credential'; },
      (d: any) => { d.symbols[0].source = 'not source'; },
      (d: any) => { d.cards[0].html = '<script>'; },
      (d: any) => { d.cards[0].position.z = 1; },
      (d: any) => { d.viewport.extra = 1; },
      (d: any) => { d.filters.extra = 1; },
    ];
    for (const mutate of mutations) {
      const doc = document(); mutate(doc);
      expect(() => parseBoardDocument(doc)).toThrow();
    }
  });
  it('rejects unsupported versions, malformed fields and unbounded geometry', () => {
    const mutations = [
      (d: any) => { d.version = 2; },
      (d: any) => { delete d.filters; },
      (d: any) => { d.symbols[0].hidden = 'yes'; },
      (d: any) => { delete d.symbols[0].included; },
      (d: any) => { d.symbols[0].key = '../key'; },
      (d: any) => { d.symbols[0].identity.qualifiedName = 'a'.repeat(2049); },
      (d: any) => { d.symbols[0].identity.id = 'a'.repeat(2049); },
      (d: any) => { d.symbols[0].identity.signature = 'a'.repeat(4097); },
      (d: any) => { d.symbols[0].identity.kind = ''; },
      (d: any) => { d.symbols[0].position.x = NaN; },
      (d: any) => { d.symbols[0].position.y = Infinity; },
      (d: any) => { d.viewport.x = 1_000_001; },
      (d: any) => { d.viewport.zoom = 0; },
      (d: any) => { d.cards[0].width = 4097; },
      (d: any) => { d.cards[0].height = -1; },
      (d: any) => { d.cards[0].zIndex = 1.5; },
      (d: any) => { d.cards[0].symbolKey = 'absent'; },
      (d: any) => { d.symbols.push(d.symbols[0]); },
      (d: any) => { d.cards.push(d.cards[0]); },
      (d: any) => { d.cards = null; },
    ];
    for (const mutate of mutations) {
      const doc = document(); mutate(doc);
      expect(() => parseBoardDocument(doc)).toThrow();
    }
    for (const raw of [null, [], 'json', {}, { ...document(), symbols: null }]) expect(() => parseBoardDocument(raw)).toThrow();
  });
  it('rejects documents exceeding the byte cap even within all cardinality limits', () => {
    const doc = document();
    doc.symbols = Array.from({ length: 128 }, (_, i) => ({
      ...doc.symbols[0]!, key: `s${i}`,
      identity: { id: 'i'.repeat(2048), qualifiedName: `${i}`.padEnd(2048, 'q'), kind: 'future', file: 'f'.repeat(1024), signature: 's'.repeat(4096) },
    }));
    doc.cards = [];
    expect(() => parseBoardDocument(doc)).toThrow(/too large/);
  });
  it('refuses traversal, absolute, drive, NUL and backslash identity paths on every platform', () => {
    for (const file of ['../a.ts', 'src/../../a.ts', '/etc/passwd', 'C:/secret', 'C:secret', '\\\\host\\share', 'src\\a.ts', 'src/./a.ts', 'src//a.ts', 'src/a\0.ts', '', 'a'.repeat(1025)]) {
      const doc = document(); doc.symbols[0]!.identity.file = file;
      expect(() => parseBoardDocument(doc), file).toThrow();
    }
  });
});

describe('board comment metadata', () => {
  function comment() { return { key: 'n1', text: '  Notes\n\t<img src=x onerror=alert(1)>\n', position: { x: -20, y: 80 }, width: 320, height: 240, zIndex: 12 }; }
  it('keeps legacy documents unchanged and round-trips comment-only boards through storage and resolution', () => {
    expect(parseBoardDocument(document())).toEqual(document());
    const doc = { ...document(), symbols: [], cards: [], comments: [comment(), { ...comment(), key: 'n2', text: '' }] };
    expect(parseBoardDocument(doc)).toEqual(doc);
    const saved = save('Notes', doc);
    expect(readStoredBoard(root, saved.id)!.document).toEqual(doc);
    const resolved = resolveBoard(cg, doc);
    expect(resolved.board).toEqual(doc); expect(resolved.resolutions).toEqual([]);
    expect(parseBoardDocument({ ...document(), comments: [] }).comments).toEqual([]);
  });
  it('bounds individual text and comment counts independently of symbols and source cards', () => {
    const doc = { ...document(), comments: [comment()] };
    doc.comments[0].text = 'x'.repeat(16_384);
    expect(parseBoardDocument(doc).comments![0].text).toHaveLength(16_384);
    doc.comments[0].text += 'x'; expect(() => parseBoardDocument(doc)).toThrow(/comment text/);
    doc.comments = Array.from({ length: 64 }, (_, i) => ({ ...comment(), key: `n${i}` }));
    expect(parseBoardDocument(doc).comments).toHaveLength(64);
    doc.comments.push({ ...comment(), key: 'overflow' }); expect(() => parseBoardDocument(doc)).toThrow(/64 comment/);
    doc.comments = Array.from({ length: 64 }, (_, i) => ({ ...comment(), key: `n${i}`, text: 'x'.repeat(16_384) }));
    expect(() => parseBoardDocument(doc)).toThrow(/too large/);
  });
  it('rejects malformed, duplicate, cross-kind and unbounded comment metadata', () => {
    const invalid: unknown[] = [null, {}, 'text', [null], [comment(), comment()], [{ ...comment(), key: 's1' }], [{ ...comment(), key: 'c1' }]];
    for (const field of [{ text: null }, { text: 7 }, { text: '\u0000' }, { key: '../note' }, { width: 239 }, { height: 159 },
      { width: Infinity }, { height: 4097 }, { position: { x: NaN, y: 0 } }, { position: { x: 0, y: 1_000_001 } },
      { zIndex: -1 }, { zIndex: 1.5 }, { html: '<b>no</b>' }, { symbolKey: 's1' }]) invalid.push([{ ...comment(), ...field }]);
    for (const comments of invalid) expect(() => parseBoardDocument({ ...document(), comments })).toThrow();
  });
});

describe('project-local board store', () => {
  it('explicit updates preserve createdAt, Save as never overwrites a same-name board', () => {
    expect(buildBoards(root, writable)).toEqual({ boards: [], readOnly: false, readOnlyReason: null, directory: BOARDS_RELATIVE_DIR, skipped: 0, bounded: false });
    const first = save('  Review   One  ');
    expect(first.name).toBe('Review One');
    const before = readStoredBoard(root, first.id)!;
    expect(before.document).toEqual(document());
    expect(() => save('Review One')).toThrow(BoardConflictError);
    const edited = document(); edited.symbols[0]!.position.x = 500;
    const updated = save('Renamed', edited, first.id);
    expect(updated.id).toBe(first.id);
    expect(readStoredBoard(root, first.id)!.createdAt).toBe(before.createdAt);
    expect(readStoredBoard(root, first.id)!.document).toEqual(edited);
    const second = save('Second');
    expect(() => save('Second', edited, first.id)).toThrow(BoardConflictError);
    expect(readStoredBoard(root, second.id)!.name).toBe('Second');
    expect(() => save('Stale', document(), 'missing')).toThrow(/no longer exists/);
    expect(deleteStoredBoard(root, first.id, writable)).toEqual({ deleted: first.id });
    expect(() => deleteStoredBoard(root, first.id, writable)).toThrow(/does not exist/);
    expect(fs.readdirSync(boardsDirectory(root))).toEqual([`${second.id}.json`]);
    if (process.platform !== 'win32') expect(fs.statSync(boardPath(root, second.id)).mode & 0o777).toBe(0o600);
  });
  it('refuses writes read-only before creating directories or parsing input', () => {
    expect(() => saveStoredBoard(root, null, readOnly)).toThrow('Read-only fixture.');
    expect(() => deleteStoredBoard(root, '../x', readOnly)).toThrow('Read-only fixture.');
    expect(fs.existsSync(path.join(root, '.codegraph/ui'))).toBe(false);
    const first = save();
    const bytes = fs.readFileSync(boardPath(root, first.id));
    expect(() => saveStoredBoard(root, { id: first.id, name: 'Different', document: document() }, readOnly)).toThrow();
    expect(() => deleteStoredBoard(root, first.id, readOnly)).toThrow();
    expect(fs.readFileSync(boardPath(root, first.id))).toEqual(bytes);
    expect(buildBoards(root, readOnly).boards).toHaveLength(1);
  });
  it('validates ids and names, and never accepts an arbitrary storage path', () => {
    for (const id of ['', '../x', 'a/b', 'A', '-x', 'x.json', '/tmp/x', 'a'.repeat(81), 'x\0', 'con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9']) {
      expect(isBoardId(id)).toBe(false);
      expect(() => boardPath(root, id)).toThrow();
      expect(() => save('name', document(), id)).toThrow();
      expect(() => deleteStoredBoard(root, id, writable)).toThrow();
    }
    for (const name of ['', ' ', 'a'.repeat(121), 'nul\0name']) expect(() => save(name)).toThrow();
    expect(() => saveStoredBoard(root, { name: 'test', document: document(), projectRoot: '/outside' }, writable)).toThrow();
  });
  it('skips malformed, oversized and mismatched-envelope files without rewriting them', () => {
    save('Valid');
    put('broken', '{bad');
    put('future', JSON.stringify({ ...rawBoard('future'), version: 2 }));
    put('mismatch', JSON.stringify(rawBoard('different')));
    put('extra', JSON.stringify({ ...rawBoard('extra'), source: 'forbidden' }));
    put('big', ' '.repeat(MAX_BOARD_FILE_BYTES + 1));
    const list = listStoredBoards(root);
    expect(list.boards).toHaveLength(1);
    expect(list.skipped).toBe(5);
    expect(list.bounded).toBe(false);
    expect(readStoredBoard(root, 'broken')).toBeNull();
    expect(fs.readFileSync(path.join(root, BOARDS_RELATIVE_DIR, 'broken.json'), 'utf8')).toBe('{bad');
  });
  it('caps valid boards and fails closed when collision checking would be incomplete', () => {
    for (let i = 0; i < MAX_BOARDS; i++) put(`b-${i}`, JSON.stringify(rawBoard(`b-${i}`)));
    expect(listStoredBoards(root).boards).toHaveLength(MAX_BOARDS);
    // Our own cooperative lock must not turn an exactly-full list into a
    // truncated one: explicit updates still work at the creation limit.
    expect(save('b-0', document(), 'b-0').id).toBe('b-0');
    expect(() => save('Overflow')).toThrow(BoardConflictError);
    put('excess', JSON.stringify(rawBoard('excess')));
    expect(listStoredBoards(root).bounded).toBe(true);
    expect(listStoredBoards(root).boards).toHaveLength(MAX_BOARDS);
    expect(() => save('b-0', document(), 'b-0')).toThrow(BoardConflictError);
  });
  it('bounds directory scanning even when every entry is malformed', () => {
    fs.mkdirSync(boardsDirectory(root), { recursive: true });
    for (let i = 0; i <= MAX_BOARD_SCAN_ENTRIES; i++) fs.writeFileSync(path.join(boardsDirectory(root), `bad-${i}`), '');
    expect(listStoredBoards(root)).toEqual({ boards: [], skipped: MAX_BOARD_SCAN_ENTRIES, bounded: true });
    expect(() => save()).toThrow(BoardConflictError);
  });
  it('does not create metadata directories for stale-id updates or missing deletes', () => {
    expect(() => save('Missing', document(), 'missing')).toThrow(/does not exist/);
    expect(() => deleteStoredBoard(root, 'missing', writable)).toThrow(/does not exist/);
    expect(fs.existsSync(path.join(root, '.codegraph/ui'))).toBe(false);
  });
  it('releases its lock after failed writes so corrected requests can succeed', () => {
    const first = save();
    expect(() => save()).toThrow(BoardConflictError);
    expect(fs.existsSync(path.join(boardsDirectory(root), '.write.lock'))).toBe(false);
    expect(() => save('Missing', document(), 'missing')).toThrow();
    expect(fs.existsSync(path.join(boardsDirectory(root), '.write.lock'))).toBe(false);
    expect(save('Corrected', document(), first.id).id).toBe(first.id);
    expect(deleteStoredBoard(root, first.id, writable)).toEqual({ deleted: first.id });
    expect(fs.readdirSync(boardsDirectory(root))).toEqual([]);
  });
  it('refuses concurrent or stale write locks without touching saved bytes', () => {
    const first = save();
    const target = boardPath(root, first.id);
    const bytes = fs.readFileSync(target);
    fs.writeFileSync(path.join(boardsDirectory(root), '.write.lock'), '');
    expect(() => save('Other', document(), first.id)).toThrow(BoardConflictError);
    expect(() => deleteStoredBoard(root, first.id, writable)).toThrow(BoardConflictError);
    expect(fs.readFileSync(target)).toEqual(bytes);
  });
});

// Actual symlink coverage on POSIX. Windows privileges/junction semantics were not tested here.
describe.runIf(process.platform !== 'win32')('board symlink and special-file refusals', () => {
  it('refuses linked metadata directories, including links to another in-project directory', () => {
    const outside = path.join(temp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    for (const component of ['.codegraph', '.codegraph/ui', BOARDS_RELATIVE_DIR]) {
      const linkRoot = fs.mkdtempSync(path.join(temp, 'linked-'));
      try {
        const link = path.join(linkRoot, component);
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(outside, link, 'dir');
        expect(() => saveStoredBoard(linkRoot, { name: 'No', document: document() }, writable)).toThrow();
        expect(() => listStoredBoards(linkRoot)).toThrow();
        expect(() => deleteStoredBoard(linkRoot, 'anything', writable)).toThrow();
      } finally { fs.rmSync(linkRoot, { recursive: true, force: true }); }
    }
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.mkdirSync(path.join(root, '.codegraph/ui'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, BOARDS_RELATIVE_DIR), 'dir');
    expect(() => save()).toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'elsewhere'))).toEqual([]);
  });
  it('never follows or removes a preplanted symlink lock', () => {
    const saved = save();
    const outside = path.join(root, 'lock-target');
    fs.writeFileSync(outside, 'must stay unchanged');
    const lock = path.join(boardsDirectory(root), '.write.lock');
    fs.symlinkSync(outside, lock);
    expect(() => save('Refused', document(), saved.id)).toThrow(BoardConflictError);
    expect(() => deleteStoredBoard(root, saved.id, writable)).toThrow(BoardConflictError);
    expect(fs.lstatSync(lock).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('must stay unchanged');
    fs.unlinkSync(lock);
    expect(save('Allowed', document(), saved.id).id).toBe(saved.id);
  });
  it('never reads, updates or deletes a linked file, even one containing valid board JSON', () => {
    const outside = path.join(temp, 'external-board.json');
    const bytes = JSON.stringify(rawBoard('linked'));
    fs.writeFileSync(outside, bytes);
    fs.mkdirSync(boardsDirectory(root), { recursive: true });
    fs.symlinkSync(outside, path.join(root, BOARDS_RELATIVE_DIR, 'linked.json'));
    expect(() => readStoredBoard(root, 'linked')).toThrow();
    expect(() => save('No', document(), 'linked')).toThrow();
    expect(() => deleteStoredBoard(root, 'linked', writable)).toThrow();
    expect(listStoredBoards(root).skipped).toBe(1);
    expect(fs.readFileSync(outside, 'utf8')).toBe(bytes);
    const inside = path.join(root, 'inside.json'); fs.writeFileSync(inside, JSON.stringify(rawBoard('inside')));
    fs.symlinkSync(inside, path.join(root, BOARDS_RELATIVE_DIR, 'inside.json'));
    expect(() => readStoredBoard(root, 'inside')).toThrow();
    fs.linkSync(inside, path.join(root, BOARDS_RELATIVE_DIR, 'hardlink.json'));
    expect(() => readStoredBoard(root, 'hardlink')).toThrow();
    fs.mkdirSync(path.join(root, BOARDS_RELATIVE_DIR, 'directory.json'));
    expect(() => readStoredBoard(root, 'directory')).toThrow();
    execFileSync('mkfifo', [path.join(root, BOARDS_RELATIVE_DIR, 'pipe.json')]);
    expect(() => readStoredBoard(root, 'pipe')).toThrow();
    expect(listStoredBoards(root).skipped).toBe(5);
  });
});

describe('exact current-index identity resolution', () => {
  it('uses qualified name, exact kind, file and optional signature; id is never authority', () => {
    const alpha = cg.getNodesByQualifiedName('alpha')[0]!;
    expect(alpha).toBeTruthy();
    const doc = document(); doc.symbols[0]!.identity.id = alpha.id;
    expect(resolveBoard(cg, doc).resolutions[0]).toMatchObject({ status: 'ok', node: { id: alpha.id } });
    expect(resolveBoard(cg, doc).board).toEqual(doc);
    expect(() => resolveBoard(cg, { ...doc, version: 2 })).toThrow();
    for (const change of [{ qualifiedName: 'renamed' }, { kind: 'class' }, { file: 'src/elsewhere.ts' }, { signature: 'wrong signature' }]) {
      const changed = document(); Object.assign(changed.symbols[0]!.identity, { id: alpha.id }, change);
      expect(resolveBoard(cg, changed).resolutions[0]).toMatchObject({ status: 'missing', node: null });
    }
    const duplicates = cg.getNodesByQualifiedName('duplicate');
    expect(duplicates.length).toBeGreaterThan(1);
    const ambiguous = document();
    ambiguous.symbols[0]!.identity = { id: duplicates[0]!.id, qualifiedName: 'duplicate', kind: 'function', file: 'src/overloads.ts' };
    expect(resolveBoard(cg, ambiguous).resolutions[0]).toMatchObject({ status: 'ambiguous', node: null });
    const unique = duplicates.find((n) => duplicates.filter((other) => other.signature === n.signature).length === 1)!;
    expect(unique.signature).toBeTruthy();
    ambiguous.symbols[0]!.identity.signature = unique.signature;
    expect(resolveBoard(cg, ambiguous).resolutions[0]!.node?.id).toBe(unique.id);
  });
  it('rejects distinct identities and hints that converge to one live node, including source-only entries', () => {
    const alpha = cg.getNodesByQualifiedName('alpha')[0]!;
    expect(alpha.signature).toBeTruthy();
    const doc = document();
    doc.symbols[0]!.identity.id = alpha.id;
    doc.symbols.push({ ...doc.symbols[0]!, key: 's2', included: false, hidden: false, identity: { ...doc.symbols[0]!.identity, signature: alpha.signature, id: 'outdated-hint' } });
    expect(parseBoardDocument(doc).symbols).toHaveLength(2);
    expect(() => resolveBoard(cg, doc)).toThrow(/same live symbol/);
    const saved = saveStoredBoard(indexRoot, { name: 'Converging', document: doc }, writable);
    expect(() => loadBoard(cg, indexRoot, saved.id, writable)).toThrow(/same live symbol/);
    expect(readStoredBoard(indexRoot, saved.id)!.document).toEqual(doc);
  });
  it('returns hidden/expanded/source-only identity ancestors without seeding membership, descendants or relationships', () => {
    const doc = contextDocument();
    const expected = ['context-file', 'context-namespace', ...doc.symbols.map((s) => s.identity.id!)].sort();
    const loaded = resolveBoard(cg, doc);
    expect(loaded.board).toEqual(doc);
    expect(loaded.resolutions.every((resolution) => resolution.status === 'ok')).toBe(true);
    expect(loaded.symbols!.map((s) => s.id).sort()).toEqual(expected);
    expect(loaded.symbols!.find((s) => s.id === 'context-hidden')).toMatchObject({ ownerId: 'context-expanded', startColumn: 18 });
    expect(loaded.symbols!.find((s) => s.id === 'context-expanded')).toMatchObject({ ownerId: 'context-owner', memberCount: 2, startColumn: 4 });
    expect(loaded.symbols!.find((s) => s.id === 'context-test')).toMatchObject({ test: true, ownerId: 'context-expanded' });
    expect(loaded.symbols!.find((s) => s.id === 'context-owner')!.memberCount).toBe(0); // weak contains path remains filtered
    expect(loaded.board.symbols.filter((s) => s.included).map((s) => s.key)).toEqual(['context-owner']);
    expect(loaded).not.toHaveProperty('included');
    expect(loaded).not.toHaveProperty('scopeIds');
    expect(loaded).not.toHaveProperty('relations');
    const projection = buildBoard(cg, new URLSearchParams({ ids: JSON.stringify(['context-owner']) }));
    expect(projection.included).toEqual(['context-owner']);
    expect(projection.scopeIds).toEqual(['context-owner']);
    expect(projection.symbols.some((s) => ['context-expanded', 'context-hidden', 'context-source', 'context-test'].includes(s.id))).toBe(false);
    expect(projection.relations).toEqual([]);
    const saved = saveStoredBoard(indexRoot, { name: 'Identity context only', document: doc }, writable);
    const reopened = loadBoard(cg, indexRoot, saved.id, readOnly);
    expect(reopened.readOnly).toBe(true);
    expect(reopened.board).toEqual(doc);
    expect(reopened.symbols).toEqual(loaded.symbols);
    expect(readStoredBoard(indexRoot, saved.id)!.document).toEqual(doc);
    expect(doc.symbols.filter((s) => !s.included)).toHaveLength(4);
  });
  it('applies document visibility filters to context member counts, not identity resolution or context membership', () => {
    for (const enabled of [false, true]) {
      const doc = contextDocument();
      Object.assign(doc.filters, { includeTests: enabled, includeGenerated: enabled, includeUncertain: enabled });
      const loaded = resolveBoard(cg, doc);
      expect(loaded.symbols!.find((s) => s.id === 'context-expanded')!.memberCount).toBe(enabled ? 5 : 2);
      expect(loaded.symbols!.find((s) => s.id === 'context-owner')!.memberCount).toBe(enabled ? 1 : 0);
      expect(loaded.symbols!.map((s) => s.id).sort()).toEqual(['context-file', 'context-namespace', ...doc.symbols.map((s) => s.identity.id!)].sort());
      expect(loaded.symbols!.some((s) => ['context-sibling', 'context-generated', 'context-uncertain', 'context-neighbor'].includes(s.id))).toBe(false);
      expect(loaded.resolutions.every((resolution) => resolution.status === 'ok')).toBe(true);
      expect(loaded.board).toEqual(doc);
    }
  });
  it('omits failed resolutions from identity context and reports ancestor bounds without projecting anything', () => {
    const doc = document();
    doc.cards = [];
    doc.symbols[0] = { ...doc.symbols[0]!, included: false, hidden: false,
      identity: { id: `context-deep-${MAX_BOARD_DEPTH + 5}`, qualifiedName: `context-deep-${MAX_BOARD_DEPTH + 5}`, kind: 'namespace', file: 'src/context.ts' } };
    doc.symbols.push({ ...doc.symbols[0]!, key: 'missing', identity: { qualifiedName: 'noLongerHere', kind: 'method', file: 'src/context.ts' } });
    doc.symbols.push({ ...doc.symbols[0]!, key: 'ambiguous', identity: { qualifiedName: 'duplicate', kind: 'function', file: 'src/overloads.ts' } });
    const loaded = resolveBoard(cg, doc);
    expect(loaded.resolutions.map((resolution) => resolution.status)).toEqual(['ok', 'missing', 'ambiguous']);
    expect(loaded.symbols).toHaveLength(MAX_BOARD_DEPTH + 1);
    expect(loaded.symbols!.every((s) => s.id.startsWith('context-deep-'))).toBe(true);
    expect(loaded.notes!.join(' ')).toMatch(/Ancestor identity context bounded/);
    expect(loaded.board).toEqual(doc);
    expect(loaded).not.toHaveProperty('relations');
  });
  it('resolves exact identities and their facts in one read snapshot despite concurrent index changes', () => {
    const projectRoot = fs.mkdtempSync(path.join(temp, 'resolution-snapshot-'));
    const snapshotCg = CodeGraph.initSync(projectRoot);
    let writer: DatabaseConnection | undefined;
    let lookup: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const owner: Node = { id: 'owner', kind: 'class', name: 'owner', qualifiedName: 'owner', filePath: 'live.ts', language: 'typescript',
        startLine: 1, endLine: 10, startColumn: 8, endColumn: 12 };
      const child: Node = { ...owner, id: 'child', kind: 'method', name: 'child', qualifiedName: 'child', startLine: 3, startColumn: 4 };
      snapshotCg['queries'].insertNode(owner);
      snapshotCg['queries'].insertNode(child);
      snapshotCg['queries'].insertEdge({ source: owner.id, target: child.id, kind: 'contains' });
      snapshotCg['db'].getDb().prepare(`INSERT INTO files(path,content_hash,language,size,modified_at,indexed_at) VALUES ('live.ts','x','typescript',0,0,0)`).run();
      const doc = document();
      doc.cards = [];
      doc.symbols = [child, owner].map((node) => ({ key: node.id,
        identity: { id: node.id, qualifiedName: node.qualifiedName, kind: node.kind, file: node.filePath },
        position: { x: 0, y: 0 }, included: node.id === owner.id, hidden: node.id === child.id, expanded: true }));
      writer = DatabaseConnection.open(getDatabasePath(projectRoot));
      const original = snapshotCg.getNodesByQualifiedName.bind(snapshotCg);
      let committed = false;
      lookup = vi.spyOn(snapshotCg, 'getNodesByQualifiedName').mockImplementation((name) => {
        const nodes = original(name); // establishes this request's SQLite snapshot
        if (!committed) {
          writer!.getDb().transaction(() => {
            writer!.getDb().prepare("UPDATE nodes SET qualified_name='renamed-owner', start_column=48 WHERE id='owner'").run();
            writer!.getDb().prepare("UPDATE nodes SET start_column=99 WHERE id='child'").run();
            writer!.getDb().prepare("UPDATE files SET generated=1 WHERE path='live.ts'").run();
            new QueryBuilder(writer!.getDb()).insertNode({ ...child, id: 'duplicate-child' });
          })();
          committed = true;
        }
        return nodes;
      });
      const loaded = resolveBoard(snapshotCg, doc);
      expect(loaded.resolutions.map((resolution) => resolution.status)).toEqual(['ok', 'ok']);
      expect(loaded.symbols!.find((s) => s.id === child.id)).toMatchObject({ ownerId: owner.id, startColumn: 4 });
      expect(loaded.symbols!.find((s) => s.id === owner.id)).toMatchObject({ qualifiedName: 'owner', startColumn: 8, memberCount: 1 });
      expect(loaded.symbols!.some((s) => s.generated)).toBe(false);
      expect(loaded.board).toEqual(doc);
      const refreshed = resolveBoard(snapshotCg, doc);
      expect(refreshed.resolutions.map((resolution) => resolution.status)).toEqual(['ambiguous', 'missing']);
      expect(refreshed.symbols).toEqual([]);
    } finally {
      lookup?.mockRestore(); writer?.close(); snapshotCg.close(); fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
  it('retains distinct missing and ambiguous identity placeholders', () => {
    const doc = document();
    doc.symbols[0]!.identity.qualifiedName = 'noLongerHere';
    doc.symbols.push({ ...doc.symbols[0]!, key: 's2', included: false, hidden: false, identity: { qualifiedName: 'duplicate', kind: 'function', file: 'src/overloads.ts' } });
    const loaded = resolveBoard(cg, doc);
    expect(loaded.board).toEqual(doc);
    expect(loaded.resolutions.map(({ key, status, node }) => ({ key, status, node }))).toEqual([
      { key: 's1', status: 'missing', node: null },
      { key: 's2', status: 'ambiguous', node: null },
    ]);
  });
  it('survives real re-indexed line shifts, but leaves cross-file moves and renames missing', async () => {
    const alpha = cg.getNodesByQualifiedName('alpha')[0]!;
    const doc = document(); doc.symbols[0]!.identity.id = alpha.id;
    const saved = saveStoredBoard(indexRoot, { name: 'Shift', document: doc }, writable);
    fs.writeFileSync(path.join(indexRoot, 'src/a.ts'), `// inserted\n// inserted\n${alphaSource}`);
    await cg.sync();
    const shifted = loadBoard(cg, indexRoot, saved.id, writable);
    expect(shifted.resolutions[0]).toMatchObject({ status: 'moved', node: { file: 'src/a.ts', line: 3 } });
    expect(shifted.resolutions[0]!.node!.id).not.toBe(alpha.id);
    expect(shifted.board).toEqual(doc);
    fs.writeFileSync(path.join(indexRoot, 'src/a.ts'), 'export function renamed(): number { return 1; }\n');
    fs.writeFileSync(path.join(indexRoot, 'src/moved.ts'), alphaSource);
    await cg.sync();
    expect(loadBoard(cg, indexRoot, saved.id, readOnly).resolutions[0]).toMatchObject({ status: 'missing', node: null });
  }, 120_000);
});

async function mount(options = writable) {
  server = await startUiServer({
    projectRoot: indexRoot, viewerDir, port: 0,
    api: (req, res, ctx) => handleBoardsRequest(req, res, ctx, () => cg, options),
  });
  return server;
}
async function call(route: string, options: { method?: string; body?: unknown; raw?: string; marker?: boolean; origin?: string; host?: string; contentType?: string } = {}) {
  const method = options.method ?? 'GET';
  const body = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers: Record<string, string> = { Host: options.host ?? `127.0.0.1:${server!.port}` };
  if (options.marker !== false) headers['X-CodeGraph-UI'] = '1';
  if (options.origin) headers.Origin = options.origin;
  if (body !== undefined) { headers['Content-Type'] = options.contentType ?? 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(body)); }
  return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server!.port, path: route, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = raw; try { parsed = JSON.parse(raw); } catch { /* HEAD and gate text */ }
        resolve({ status: res.statusCode!, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject); req.end(body);
  });
}

describe('real loopback board HTTP boundary', () => {
  it('exposes list/load/save/delete, explicit conflicts and stale-id 404', async () => {
    await mount();
    const first = await call('/api/boards', { method: 'POST', body: { name: 'HTTP board', document: document() } });
    expect(first.status).toBe(200);
    expect(Object.keys(first.body).sort()).toEqual(['id', 'name', 'updatedAt']);
    const id = first.body.id;
    expect((await call('/api/boards')).body.boards).toEqual([first.body]);
    const loaded = await call(`/api/boards/${id}`);
    expect(loaded.status).toBe(200);
    expect(loaded.body.board).toEqual(document());
    expect(loaded.body.resolutions).toHaveLength(1);
    expect((await call('/api/boards', { method: 'HEAD' })).body).toBe('');
    expect((await call('/api/boards', { method: 'POST', body: { name: 'HTTP board', document: document() } })).status).toBe(409);
    expect((await call('/api/boards', { method: 'POST', body: { id, name: 'New name', document: document() } })).status).toBe(200);
    expect((await call('/api/boards', { method: 'POST', body: { id: 'stale', name: 'New', document: document() } })).status).toBe(404);
    expect((await call('/api/boards/stale')).status).toBe(404);
    expect((await call(`/api/boards/${id}`, { method: 'DELETE' })).body).toEqual({ deleted: id });
    expect((await call(`/api/boards/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await call('/api/boards/..%2fescape', { method: 'DELETE' })).status).not.toBe(200);
    expect((await call('/api/boards?projectRoot=/outside')).status).toBe(200);
    expect((await call('/api/unknown')).status).toBe(404);
  });
  it('saves, loads and resolves comment-only boards over HTTP, including read-only loading', async () => {
    const doc: BoardDocument = { ...document(), symbols: [], cards: [], comments: [{ key: 'note', text: 'Personal\nnotes', position: { x: 4, y: 5 }, width: 320, height: 240, zIndex: 7 }] };
    await mount();
    const saved = await call('/api/boards', { method: 'POST', body: { name: 'Notes', document: doc } });
    expect(saved.status).toBe(200);
    expect((await call(`/api/boards/${saved.body.id}`)).body.board).toEqual(doc);
    await server!.close(); server = undefined; await mount(readOnly);
    const resolved = await call('/api/boards/resolve', { method: 'POST', body: { document: doc } });
    expect(resolved.status).toBe(200); expect(resolved.body.board).toEqual(doc); expect(resolved.body.resolutions).toEqual([]);
    expect((await call(`/api/boards/${saved.body.id}`)).body.board).toEqual(doc);
    expect((await call('/api/boards', { method: 'POST', body: { name: 'No write', document: doc } })).status).toBe(403);
    expect(listStoredBoards(indexRoot).boards).toHaveLength(1);
  });
  it('preserves Host, Origin, marker, content-type and no-CORS gates', async () => {
    await mount();
    const body = { name: 'Refused', document: document() };
    for (const options of [{ marker: false }, { origin: 'https://foreign.invalid' }, { host: 'foreign.invalid' }, { contentType: 'text/plain' }]) {
      const answer = await call('/api/boards', { method: 'POST', body, ...options });
      expect(answer.status).toBe(403);
      expect(answer.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(fs.existsSync(path.join(indexRoot, BOARDS_RELATIVE_DIR))).toBe(false);
  });
  it('refuses read-only mutations server-side while permitting import validation with no writes', async () => {
    const saved = saveStoredBoard(indexRoot, { name: 'Existing', document: document() }, writable);
    const bytes = fs.readFileSync(boardPath(indexRoot, saved.id));
    await mount(readOnly);
    expect((await call('/api/boards')).body.readOnlyReason).toBe('Read-only fixture.');
    expect((await call(`/api/boards/${saved.id}`)).body.readOnly).toBe(true);
    expect((await call('/api/boards', { method: 'POST', raw: 'malformed' })).status).toBe(403);
    expect((await call(`/api/boards/${saved.id}`, { method: 'DELETE' })).status).toBe(403);
    expect(fs.readFileSync(boardPath(indexRoot, saved.id))).toEqual(bytes);
    const imported = await call('/api/boards/validate', { method: 'POST', body: document() });
    expect(imported.status).toBe(200);
    expect(imported.body.board).toEqual(document());
    expect(fs.readdirSync(boardsDirectory(indexRoot))).toEqual([`${saved.id}.json`]);
    expect((await call('/api/boards/validate', { method: 'POST', body: { ...document(), version: 99 } })).status).toBe(400);
    const resolved = await call('/api/boards/resolve', { method: 'POST', body: { document: document() } });
    expect(resolved.status).toBe(200);
    expect(resolved.body.board).toEqual(document());
    expect(resolved.body.readOnly).toBe(true);
    expect((await call('/api/boards/resolve', { method: 'POST', marker: false, body: { document: document() } })).status).toBe(403);
    expect((await call('/api/boards/resolve', { method: 'POST', body: { document: document(), projectRoot: '/outside' } })).status).toBe(400);
  });
  it('bounds and validates HTTP bodies independently of the smaller trail reader', async () => {
    await mount();
    expect((await call('/api/boards', { method: 'POST', raw: '{invalid' })).status).toBe(400);
    const large = document();
    large.symbols = Array.from({ length: 64 }, (_, i) => ({ ...large.symbols[0]!, key: `s${i}`, identity: { ...large.symbols[0]!.identity, qualifiedName: `symbol${i}`, signature: 'x'.repeat(1500) } }));
    large.cards = [];
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(64 * 1024);
    expect((await call('/api/boards', { method: 'POST', body: { name: 'Large valid', document: large } })).status).toBe(200);
    // Same bounded-reader behavior as trails: oversize streams are destroyed, not drained.
    await expect(call('/api/boards', { method: 'POST', raw: ' '.repeat(MAX_BOARD_FILE_BYTES + 1) })).rejects.toThrow();
    expect(listStoredBoards(indexRoot).boards).toHaveLength(1);
  });
});
