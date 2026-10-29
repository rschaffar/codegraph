/** Project-local, metadata-only board persistence. Imported identities never authorize file reads. */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { CODEGRAPH_DIR } from '../../directory';
import { PathRefusalError, resolveProjectFile } from '../security';
import { ApiError, badRequest, notFound } from './respond';

export const BOARDS_RELATIVE_DIR = `${CODEGRAPH_DIR}/ui/boards`;
export const MAX_BOARDS = 200;
export const MAX_BOARD_SCAN_ENTRIES = 400;
export const MAX_BOARD_FILE_BYTES = 1024 * 1024;
export const MAX_BOARD_SYMBOLS = 128;
export const MAX_BOARD_CARDS = 32;
export const MAX_BOARD_NAME = 120;
const MAX_COORDINATE = 1_000_000;

export interface BoardIdentity {
  id?: string;
  qualifiedName: string;
  kind: string;
  file: string;
  signature?: string;
}
export interface BoardPosition { x: number; y: number }
export interface BoardDocument {
  version: 1;
  symbols: Array<{
    key: string;
    identity: BoardIdentity;
    position: BoardPosition;
    /** False for identities retained only by source cards, not graph membership. */
    included: boolean;
    hidden: boolean;
    expanded: boolean;
  }>;
  cards: Array<{
    key: string;
    symbolKey: string;
    position: BoardPosition;
    width: number;
    height: number;
    collapsed: boolean;
    zIndex: number;
  }>;
  viewport: BoardPosition & { zoom: number };
  filters: { kind: string; showStructure: boolean };
}
export interface BoardSummary { id: string; name: string; updatedAt: string }
export interface StoredBoard extends BoardSummary {
  version: 1;
  createdAt: string;
  document: BoardDocument;
}
export interface BoardsOptions { readOnly: boolean; readOnlyReason: string | null }

/** Handled as HTTP 409 by the board dispatcher; no shared error vocabulary changes. */
export class BoardConflictError extends Error {
  readonly code = 'conflict';
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Expected a board JSON object.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !fields.includes(key))) throw badRequest('Unknown board property.');
  return result;
}
function text(value: unknown, max: number, label: string): string {
  // eslint-disable-next-line no-control-regex -- untrusted identifiers must not contain control bytes
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw badRequest(`Invalid board ${label} (nonempty, max ${max} characters, no controls).`);
  }
  return value;
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw badRequest(`Board geometry must be finite and between ${min} and ${max}.`);
  }
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw badRequest('Expected a board boolean.');
  return value;
}
function position(value: unknown): BoardPosition {
  const v = object(value, ['x', 'y']);
  return { x: number(v.x, -MAX_COORDINATE, MAX_COORDINATE), y: number(v.y, -MAX_COORDINATE, MAX_COORDINATE) };
}
export function isBoardId(value: string): boolean {
  // Windows device basenames remain devices even with a .json suffix. Refuse
  // them lexically on every platform rather than passing one to a file open.
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value);
}
function localKey(value: unknown): string {
  const key = text(value, 128, 'key');
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw badRequest('Board keys use letters, digits, underscore and dash.');
  return key;
}
/** Syntactic only: this path is NEVER passed to a filesystem read. */
export function parseBoardFile(value: unknown): string {
  const file = text(value, 1024, 'file');
  if (file.includes('\\') || file.includes(':') || file.startsWith('/') ||
      file.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw badRequest('Board files must be project-relative paths without traversal or drive prefixes.');
  }
  return file;
}
function identity(value: unknown): BoardIdentity {
  const v = object(value, ['id', 'qualifiedName', 'kind', 'file', 'signature']);
  return {
    ...(v.id === undefined ? {} : { id: text(v.id, 2048, 'node id') }),
    qualifiedName: text(v.qualifiedName, 2048, 'qualified name'),
    kind: text(v.kind, 128, 'kind'),
    file: parseBoardFile(v.file),
    ...(v.signature === undefined ? {} : { signature: text(v.signature, 4096, 'signature') }),
  };
}

/** Validate imports without storage or graph access; return a fresh, strictly whitelisted document. */
export function parseBoardDocument(raw: unknown): BoardDocument {
  const v = object(raw, ['version', 'symbols', 'cards', 'viewport', 'filters']);
  if (v.version !== 1) throw badRequest('Unsupported board version (expected 1).');
  if (!Array.isArray(v.symbols) || v.symbols.length > MAX_BOARD_SYMBOLS) throw badRequest(`A board holds at most ${MAX_BOARD_SYMBOLS} symbols.`);
  if (!Array.isArray(v.cards) || v.cards.length > MAX_BOARD_CARDS) throw badRequest(`A board holds at most ${MAX_BOARD_CARDS} cards.`);
  const symbolKeys = new Set<string>();
  const symbolIdentities = new Set<string>();
  const symbols = v.symbols.map((rawSymbol) => {
    const s = object(rawSymbol, ['key', 'identity', 'position', 'included', 'hidden', 'expanded']);
    const key = localKey(s.key);
    if (symbolKeys.has(key)) throw badRequest('Duplicate board symbol key.');
    symbolKeys.add(key);
    const included = boolean(s.included);
    const hidden = boolean(s.hidden);
    if (!included && hidden) throw badRequest('A source-only symbol cannot be hidden; hidden applies only to included graph symbols.');
    const parsedIdentity = identity(s.identity);
    // JSON tuple encoding avoids delimiter collisions; the optional node id
    // is only a hint and must never distinguish two durable identities.
    const tuple = JSON.stringify([parsedIdentity.qualifiedName, parsedIdentity.kind, parsedIdentity.file, parsedIdentity.signature ?? null]);
    if (symbolIdentities.has(tuple)) throw badRequest('Duplicate board symbol identity.');
    symbolIdentities.add(tuple);
    return { key, identity: parsedIdentity, position: position(s.position), included, hidden, expanded: boolean(s.expanded) };
  });
  const cardKeys = new Set<string>();
  const cardSymbols = new Set<string>();
  const cards = v.cards.map((rawCard) => {
    const c = object(rawCard, ['key', 'symbolKey', 'position', 'width', 'height', 'collapsed', 'zIndex']);
    const key = localKey(c.key);
    const symbolKey = localKey(c.symbolKey);
    if (cardKeys.has(key) || symbolKeys.has(key)) throw badRequest('Duplicate board card key.');
    if (!symbolKeys.has(symbolKey)) throw badRequest('A source card must reference a board symbol key.');
    if (cardSymbols.has(symbolKey)) throw badRequest('A board symbol may have only one source card.');
    cardKeys.add(key);
    cardSymbols.add(symbolKey);
    const zIndex = number(c.zIndex, 0, 1_000_000);
    if (!Number.isInteger(zIndex)) throw badRequest('Board zIndex must be an integer.');
    return { key, symbolKey, position: position(c.position), width: number(c.width, 100, 4096), height: number(c.height, 60, 4096), collapsed: boolean(c.collapsed), zIndex };
  });
  const viewport = object(v.viewport, ['x', 'y', 'zoom']);
  const filters = object(v.filters, ['kind', 'showStructure']);
  const document: BoardDocument = {
    version: 1, symbols, cards,
    viewport: { x: number(viewport.x, -MAX_COORDINATE, MAX_COORDINATE), y: number(viewport.y, -MAX_COORDINATE, MAX_COORDINATE), zoom: number(viewport.zoom, 0.05, 8) },
    filters: { kind: filters.kind === '' ? '' : text(filters.kind, 128, 'filter kind'), showStructure: boolean(filters.showStructure) },
  };
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_BOARD_FILE_BYTES - 4096) throw badRequest('Board document is too large.');
  return document;
}

export function assertBoardsWritable(options: BoardsOptions): void {
  if (options.readOnly) throw new ApiError('refused', options.readOnlyReason ?? 'This viewer is read-only; boards cannot be saved or deleted.');
}
function boardName(value: unknown): string {
  return text(value, MAX_BOARD_NAME, 'name').trim().replace(/\s+/g, ' ');
}
function timestamp(value: unknown): string {
  const result = text(value, 32, 'timestamp');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || !Number.isFinite(Date.parse(result))) throw badRequest('Invalid board timestamp.');
  return result;
}

/** Also refuse links WITHIN the project: metadata must stay in its own directory. */
export function boardsDirectory(projectRoot: string): string {
  resolveProjectFile(projectRoot, BOARDS_RELATIVE_DIR);
  let current = fs.realpathSync(projectRoot);
  for (const part of BOARDS_RELATIVE_DIR.split('/')) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PathRefusalError('Board directories must be real project-local directories.');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return current;
}
export function boardPath(projectRoot: string, id: string): string {
  if (!isBoardId(id)) throw badRequest('Invalid saved board id.');
  const target = path.join(boardsDirectory(projectRoot), `${id}.json`);
  resolveProjectFile(projectRoot, `${BOARDS_RELATIVE_DIR}/${id}.json`);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new PathRefusalError('Saved boards must be regular, unlinked files.');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return target;
}

/** Bounded actual reads, not readFileSync after a potentially stale size check. */
export function readStoredBoard(projectRoot: string, id: string): StoredBoard | null {
  const target = boardPath(projectRoot, id);
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BOARD_FILE_BYTES) return null;
    const buffer = Buffer.alloc(MAX_BOARD_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_BOARD_FILE_BYTES) return null;
    const v = object(JSON.parse(buffer.subarray(0, size).toString('utf8')), ['version', 'id', 'name', 'createdAt', 'updatedAt', 'document']);
    if (v.version !== 1 || v.id !== id) return null;
    return { version: 1, id, name: boardName(v.name), createdAt: timestamp(v.createdAt), updatedAt: timestamp(v.updatedAt), document: parseBoardDocument(v.document) };
  } catch (err) {
    if (err instanceof PathRefusalError) throw err;
    if (err instanceof SyntaxError || err instanceof ApiError || ['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes((err as NodeJS.ErrnoException).code ?? '')) return null;
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface StoredBoardList { boards: StoredBoard[]; skipped: number; bounded: boolean }
export function listStoredBoards(projectRoot: string): StoredBoardList {
  const dir = boardsDirectory(projectRoot);
  let handle: fs.Dir;
  try { handle = fs.opendirSync(dir); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { boards: [], skipped: 0, bounded: false };
    throw err;
  }
  const result: StoredBoardList = { boards: [], skipped: 0, bounded: false };
  let scanned = 0;
  try {
    let entry: fs.Dirent | null;
    while ((entry = handle.readSync()) !== null) {
      if (scanned >= MAX_BOARD_SCAN_ENTRIES) { result.bounded = true; break; }
      scanned += 1;
      if (entry.name === '.write.lock' || entry.name.endsWith('.tmp')) continue;
      if (!entry.name.endsWith('.json') || !isBoardId(entry.name.slice(0, -5))) { result.skipped += 1; continue; }
      if (result.boards.length >= MAX_BOARDS) { result.bounded = true; break; }
      try {
        const board = readStoredBoard(projectRoot, entry.name.slice(0, -5));
        if (board) result.boards.push(board);
        else result.skipped += 1;
      } catch { result.skipped += 1; }
    }
  } finally { handle.closeSync(); }
  result.boards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return result;
}

function writeFailure(err: unknown): never {
  if (err instanceof ApiError || err instanceof BoardConflictError || err instanceof PathRefusalError) throw err;
  const code = (err as NodeJS.ErrnoException).code;
  throw new ApiError(['EACCES', 'EPERM', 'EROFS'].includes(code ?? '') ? 'refused' : 'internal', 'Saved board metadata could not be written.');
}

/** Cooperative cross-process serialization protects name collisions as well as target ids. */
function mutate<T>(projectRoot: string, options: BoardsOptions, createDirectory: boolean, action: () => T): T {
  assertBoardsWritable(options);
  const dir = boardsDirectory(projectRoot);
  let lockFd: number | undefined;
  const lock = path.join(dir, '.write.lock');
  try {
    if (createDirectory) fs.mkdirSync(dir, { recursive: true });
    boardsDirectory(projectRoot);
    try {
      lockFd = fs.openSync(lock, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new BoardConflictError('Another board write is active (or a stale .write.lock needs removal).');
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !createDirectory) throw notFound('That saved board does not exist.');
      throw err;
    }
    return action();
  } catch (err) { return writeFailure(err); }
  finally {
    if (lockFd !== undefined) {
      // Do not unlink another writer's lock if the directory/lock was replaced
      // meanwhile. Holding the original descriptor also prevents inode reuse.
      try {
        boardsDirectory(projectRoot);
        const owned = fs.fstatSync(lockFd);
        const current = fs.lstatSync(lock);
        if (current.isFile() && current.nlink === 1 && current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(lock);
      } catch { /* fail closed on next write */ }
      finally { fs.closeSync(lockFd); }
    }
  }
}

export function saveStoredBoard(projectRoot: string, body: unknown, options: BoardsOptions): BoardSummary {
  assertBoardsWritable(options);
  const v = object(body, ['name', 'id', 'document']);
  const name = boardName(v.name);
  const document = parseBoardDocument(v.document);
  if (v.id !== undefined && (typeof v.id !== 'string' || !isBoardId(v.id))) throw badRequest('Invalid saved board id.');
  const requestedId = v.id as string | undefined;
  return mutate(projectRoot, options, requestedId === undefined, () => {
    const existing = requestedId === undefined ? null : readStoredBoard(projectRoot, requestedId);
    if (requestedId !== undefined && !existing) throw notFound('That saved board no longer exists. Use Save as to create a new board.');
    const list = listStoredBoards(projectRoot);
    // Never declare a name available when the complete bounded directory was not checked.
    if (list.bounded) throw new BoardConflictError('The boards directory exceeds its scan limit; remove excess entries before saving.');
    if (list.boards.some((b) => b.name === name && b.id !== requestedId)) throw new BoardConflictError('A board with that name already exists. Choose a different name or explicitly update its id.');
    if (!existing && list.boards.length >= MAX_BOARDS) throw new BoardConflictError('The saved board limit has been reached.');
    const id = requestedId ?? `board-${randomUUID()}`;
    const now = new Date().toISOString();
    const stored: StoredBoard = { version: 1, id, name, createdAt: existing?.createdAt ?? now, updatedAt: now, document };
    const serialized = `${JSON.stringify(stored)}\n`;
    if (Buffer.byteLength(serialized) > MAX_BOARD_FILE_BYTES) throw badRequest('Board file is too large.');
    const target = boardPath(projectRoot, id);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      boardPath(projectRoot, id);
      if (existing) fs.renameSync(temp, target);
      else { fs.linkSync(temp, target); fs.unlinkSync(temp); } // atomic, exclusive publication
    } finally {
      boardsDirectory(projectRoot);
      try { fs.unlinkSync(temp); } catch { /* already published or failed before creation */ }
    }
    return { id, name, updatedAt: now };
  });
}
export function deleteStoredBoard(projectRoot: string, id: string, options: BoardsOptions): { deleted: string } {
  assertBoardsWritable(options);
  if (!isBoardId(id)) throw badRequest('Invalid saved board id.');
  return mutate(projectRoot, options, false, () => {
    const target = boardPath(projectRoot, id);
    try { fs.unlinkSync(target); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('That saved board does not exist.');
      throw err;
    }
    return { deleted: id };
  });
}
