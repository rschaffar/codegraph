/** Board persistence HTTP seam. Mount before the API's existing write dispatch. */
import type { IncomingMessage, ServerResponse } from 'http';
import type { CodeGraph } from '../../index';
import type { Node } from '../../types';
import type { UiRequestContext } from '../index';
import { PathRefusalError } from '../security';
import { sendJson } from '../static';
import { ApiError, badRequest, fail, notFound, ok } from './respond';
import { toNodeRef, type WireNodeRef } from './wire';
import {
  assertBoardsWritable, BoardConflictError, BOARDS_RELATIVE_DIR, MAX_BOARD_FILE_BYTES,
  deleteStoredBoard, listStoredBoards, parseBoardDocument, readStoredBoard, saveStoredBoard,
  type BoardDocument, type BoardIdentity, type BoardsOptions, type BoardSummary,
} from './board-store';

export type { BoardDocument, BoardsOptions } from './board-store';
export { parseBoardDocument } from './board-store';
export interface BoardResolution {
  key: string;
  status: 'ok' | 'moved' | 'missing' | 'ambiguous';
  node: WireNodeRef | null;
  note: string | null;
}
export interface WireBoards {
  boards: BoardSummary[];
  readOnly: boolean;
  readOnlyReason: string | null;
  directory: string;
  skipped: number;
  bounded: boolean;
}
export interface BoardLoaded {
  board: BoardDocument;
  resolutions: BoardResolution[];
  readOnly?: boolean;
}
export interface WireBoard extends BoardLoaded {
  readOnly: boolean;
}

function matches(node: Node, identity: BoardIdentity): boolean {
  return node.qualifiedName === identity.qualifiedName && node.kind === identity.kind &&
    node.filePath.replace(/\\/g, '/') === identity.file &&
    (identity.signature === undefined || node.signature === identity.signature);
}
/** Never fuzzy-match names or change files. A matching id cannot hide duplicate declarations. */
function resolveIdentities(cg: CodeGraph, document: BoardDocument): BoardResolution[] {
  return document.symbols.map(({ key, identity }) => {
    const candidates = cg.getNodesByQualifiedName(identity.qualifiedName).filter((node) => matches(node, identity));
    if (candidates.length === 0) return { key, status: 'missing', node: null, note: 'No exact symbol identity remains in this project index.' };
    if (candidates.length !== 1) return { key, status: 'ambiguous', node: null, note: 'Several symbols match this identity; choose one explicitly.' };
    const node = candidates[0] as Node;
    const moved = identity.id !== undefined && identity.id !== node.id;
    return {
      key, status: moved ? 'moved' : 'ok', node: toNodeRef(node),
      note: moved ? 'The symbol has a new node id in the same file (for example after a line shift).' : null,
    };
  });
}
/** In-memory imports and live-index refresh: validate first, never touch storage. */
export function resolveBoard(cg: CodeGraph, document: unknown): BoardLoaded {
  const board = parseBoardDocument(document);
  const resolutions = resolveIdentities(cg, board);
  const resolvedIds = new Set<string>();
  for (const resolution of resolutions) {
    if (!resolution.node) continue;
    if (resolvedIds.has(resolution.node.id)) throw badRequest('Distinct board keys resolve to the same live symbol.');
    resolvedIds.add(resolution.node.id);
  }
  return { board, resolutions };
}
export function buildBoards(projectRoot: string, options: BoardsOptions): WireBoards {
  const list = listStoredBoards(projectRoot);
  return {
    boards: list.boards.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })),
    readOnly: options.readOnly, readOnlyReason: options.readOnly ? options.readOnlyReason : null,
    directory: BOARDS_RELATIVE_DIR, skipped: list.skipped, bounded: list.bounded,
  };
}
export function loadBoard(cg: CodeGraph, projectRoot: string, id: string, options: BoardsOptions): WireBoard {
  const stored = readStoredBoard(projectRoot, id);
  if (!stored) throw notFound('That board is missing or is not a valid saved board.');
  return { ...resolveBoard(cg, stored.document), readOnly: options.readOnly };
}
export function saveBoard(projectRoot: string, body: unknown, options: BoardsOptions): BoardSummary {
  return saveStoredBoard(projectRoot, body, options);
}
export function removeBoard(projectRoot: string, id: string, options: BoardsOptions): { deleted: string } {
  return deleteStoredBoard(projectRoot, id, options);
}

/** Board-specific cap; leaves the trails' smaller shared body limit unchanged. */
export async function readBoardJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BOARD_FILE_BYTES) {
        req.destroy();
        throw badRequest('Board request exceeds the 1 MiB body limit.');
      }
      chunks.push(buffer);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw badRequest('Board request body could not be read.');
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw badRequest('Board request needs a valid JSON body.'); }
}

/**
 * Call behind startUiServer's Host/Origin/marker gate, before dispatchWrite:
 *   if (await handleBoardsRequest(req, res, ctx, () => session.acquire(), boards)) return true;
 * Returns false without acquiring the graph for paths outside /api/boards.
 * List/save/delete do not need an index. ctx.projectRoot is server-owned, never a body/query path.
 */
export async function handleBoardsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: UiRequestContext,
  acquire: () => CodeGraph,
  options: BoardsOptions
): Promise<boolean> {
  const route = ctx.pathname.endsWith('/') ? ctx.pathname.slice(0, -1) : ctx.pathname;
  if (route !== '/api/boards' && !route.startsWith('/api/boards/')) return false;
  try {
    const id = route.startsWith('/api/boards/') ? route.slice('/api/boards/'.length) : null;
    if (ctx.method === 'GET' || ctx.method === 'HEAD') {
      return ok(res, id === null ? buildBoards(ctx.projectRoot, options) : loadBoard(acquire(), ctx.projectRoot, id, options), ctx.method);
    }
    if (ctx.method === 'POST' && (id === 'resolve' || id === 'validate')) {
      // These are read operations with a body: allowed read-only, no directory creation.
      const body = await readBoardJsonBody(req);
      let document: unknown = body;
      if (id === 'resolve') {
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).length !== 1 || !Object.hasOwn(body, 'document')) {
          throw badRequest('Board resolution expects exactly {document}.');
        }
        document = (body as { document: unknown }).document;
      }
      return ok(res, { ...resolveBoard(acquire(), document), readOnly: options.readOnly }, ctx.method);
    }
    assertBoardsWritable(options); // refuse BEFORE reading an attacker-controlled body
    if (ctx.method === 'POST' && id === null) {
      return ok(res, saveBoard(ctx.projectRoot, await readBoardJsonBody(req), options), ctx.method);
    }
    if (ctx.method === 'DELETE' && id !== null) return ok(res, removeBoard(ctx.projectRoot, id, options), ctx.method);
    throw badRequest('Use POST /api/boards to save, or DELETE /api/boards/<id> to remove.');
  } catch (err) {
    if (err instanceof BoardConflictError) {
      sendJson(res, 409, { code: 'conflict', error: err.message }, ctx.method);
      return true;
    }
    return fail(res, err instanceof PathRefusalError ? new ApiError('refused', err.message) : err, ctx.method);
  }
}
