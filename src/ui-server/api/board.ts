/** Board HTTP contract; source still goes through the existing /api/source chokepoint. */
import type { CodeGraph } from '../../index';
import { EDGE_KINDS, NODE_KINDS } from '../../types';
import {
  BoardGraph, MAX_BOARD_SELECTION, MAX_BOARD_RELATIONS, MAX_BOARD_TARGET_EVIDENCE,
  type BoardFact, type BoardRelation, type BoardConnectionFilter,
} from '../../graph/board-projection';
import { toNodeRef, type WireNodeRef } from './wire';
import { badRequest, notFound } from './respond';

export type { BoardRelation } from '../../graph/board-projection';
export interface BoardSymbol extends WireNodeRef {
  ownerId?: string;
  purpose?: string;
  /** Direct distinct contains children, not just visible or callable members. */
  memberCount: number;
  membersBounded?: boolean;
}
export interface BoardProjection {
  symbols: BoardSymbol[];
  relations: BoardRelation[];
  /** Only resolved explicit selections, never descendants or identity ancestors. */
  included: string[];
  missing: string[];
  bounded: boolean;
  notes: string[];
  nodeKinds: string[];
  edgeKinds: string[];
}
export interface BoardSearch {
  items: BoardSymbol[];
  total: number;
  nextOffset: number | null;
  bounded: boolean;
  notes: string[];
}
export interface BoardConnections {
  scope: BoardSymbol;
  direction: 'incoming' | 'outgoing';
  withMembers: boolean;
  items: { target: BoardSymbol; owner?: BoardSymbol; evidence: BoardRelation[]; total: number }[];
  /** Exact number of distinct indexed peers matching filters in the reported scope. */
  total: number;
  nextOffset: number | null;
  symbols: BoardSymbol[];
  bounded: boolean;
  notes: string[];
}
export interface BoardEvidence {
  symbols: BoardSymbol[];
  items: BoardRelation[];
  total: number;
  nextOffset: number | null;
  bounded: boolean;
  notes: string[];
}

function symbol(fact: BoardFact): BoardSymbol {
  return { ...toNodeRef(fact.node), memberCount: fact.memberCount,
    ...(fact.ownerId ? { ownerId: fact.ownerId } : {}), ...(fact.generated ? { generated: true } : {}) };
}
function symbols(facts: Map<string, BoardFact>): BoardSymbol[] {
  return [...facts.values()].map(symbol);
}
function next(offset: number, count: number, total: number): number | null {
  return offset + count < total ? offset + count : null;
}
function validate(query: URLSearchParams, allowed: string[]): void {
  for (const key of query.keys()) {
    if (!allowed.includes(key)) throw badRequest(`Unsupported Board parameter: ${key}.`);
    if (query.getAll(key).length !== 1) throw badRequest(`Duplicate Board parameter: ${key}.`);
  }
}
function text(query: URLSearchParams, key: string, max = 2048, required = false): string {
  const value = query.get(key) ?? '';
  if ((required && !value) || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw badRequest(`Invalid Board ${key}.`);
  return value;
}
function integer(query: URLSearchParams, key: string, fallback: number, max: number, min = 0): number {
  const value = query.get(key);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw badRequest(`Board ${key} must be an integer.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw badRequest(`Board ${key} must be between ${min} and ${max}.`);
  return n;
}
function paging(query: URLSearchParams, fallback: number, max = 100): { offset: number; limit: number } {
  return { offset: integer(query, 'offset', 0, 1_000_000_000), limit: integer(query, 'limit', fallback, max, 1) };
}

export function buildBoard(cg: CodeGraph, query: URLSearchParams): BoardProjection {
  validate(query, ['ids']);
  const raw = text(query, 'ids', MAX_BOARD_SELECTION * 2052, true);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw badRequest('Board ids must be a JSON array of symbol IDs.'); }
  if (!Array.isArray(parsed) || parsed.length > MAX_BOARD_SELECTION || parsed.some(id => typeof id !== 'string' || !id || id.length > 2048 || /[\u0000-\u001f\u007f]/.test(id))) {
    throw badRequest(`Board ids must contain at most ${MAX_BOARD_SELECTION} nonempty symbol IDs.`);
  }
  const ids = [...new Set(parsed as string[])];
  const graph = new BoardGraph(cg);
  return graph.snapshot(() => {
    const notes: string[] = [];
    const selected = graph.nodes(ids);
    const included = ids.filter(id => selected.has(id));
    const missing = ids.filter(id => !selected.has(id));
    const scope = graph.scope(included, true, notes);
    const facts = graph.facts(scope.ids, notes);
    const edges = graph.projection(scope.ids);
    if (edges.bounded) notes.push(`Board evidence bounded at ${MAX_BOARD_RELATIONS} relationships; use Connections and paged /api/board/evidence to inspect the remainder.`);
    graph.boundaries(scope.ids, 'outgoing', notes);
    graph.boundaries(scope.ids, 'incoming', notes);
    const result = symbols(facts.facts);
    if (scope.bounded) for (const item of result) if (item.memberCount) item.membersBounded = true;
    return {
      symbols: result, relations: edges.items, included, missing,
      bounded: scope.bounded || facts.bounded || edges.bounded, notes,
      nodeKinds: [...NODE_KINDS], edgeKinds: [...EDGE_KINDS],
    };
  });
}

export function buildBoardSearch(cg: CodeGraph, query: URLSearchParams): BoardSearch {
  validate(query, ['q', 'kind', 'path', 'offset', 'limit']);
  const q = text(query, 'q', 256);
  const kind = text(query, 'kind', 80) || undefined;
  let path = text(query, 'path', 1024).replace(/\\/g, '/').replace(/\/$/, '');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some(part => part === '..' || part === '.')) throw badRequest('Board path must be project-relative.');
  if (query.get('path')?.startsWith('/') || query.get('path')?.startsWith('\\')) throw badRequest('Board path must be project-relative.');
  if (!path) path = '';
  const { offset, limit } = paging(query, 40);
  const graph = new BoardGraph(cg);
  return graph.snapshot(() => {
    const notes: string[] = [];
    const page = graph.search(q, kind, path || undefined, offset, limit);
    const facts = graph.facts(page.ids, notes);
    return { items: page.ids.map(id => symbol(facts.facts.get(id)!)), total: page.total,
      nextOffset: next(offset, page.ids.length, page.total), bounded: facts.bounded, notes };
  });
}

function connectionRequest(query: URLSearchParams, evidence: boolean): {
  id: string; members: boolean; filter: BoardConnectionFilter; offset: number; limit: number;
} {
  validate(query, ['id', 'direction', 'members', 'kind', 'q', 'offset', 'limit', ...(evidence ? ['target'] : [])]);
  const id = text(query, 'id', 2048, true);
  const direction = text(query, 'direction', 16) || 'outgoing';
  if (direction !== 'incoming' && direction !== 'outgoing') throw badRequest('Board direction must be incoming or outgoing.');
  const members = text(query, 'members', 1) || '0';
  if (members !== '0' && members !== '1') throw badRequest('Board members must be 0 or 1.');
  const filter: BoardConnectionFilter = { direction, kind: text(query, 'kind', 80) || undefined, q: text(query, 'q', 256) || undefined };
  if (evidence) filter.target = text(query, 'target', 2048, true);
  return { id, members: members === '1', filter, ...paging(query, evidence ? 100 : 30, evidence ? 200 : 100) };
}

export function buildBoardConnections(cg: CodeGraph, query: URLSearchParams): BoardConnections {
  const req = connectionRequest(query, false);
  const graph = new BoardGraph(cg);
  return graph.snapshot(() => {
    if (!graph.nodes([req.id]).has(req.id)) throw notFound('Board scope is not in this index.');
    const notes: string[] = [];
    const scope = graph.scope([req.id], req.members, notes);
    const page = graph.connections(scope.ids, req.filter, req.offset, req.limit);
    const evidence = new Map<string, BoardRelation[]>();
    const referenced = new Set([req.id, ...page.items.map(row => row.id)]);
    let evidenceBounded = false;
    for (const row of page.items) {
      const details = graph.evidence(scope.ids, { ...req.filter, target: row.id }, 0, MAX_BOARD_TARGET_EVIDENCE);
      evidence.set(row.id, details.items);
      if (details.total > details.items.length) evidenceBounded = true;
      for (const edge of details.items) { referenced.add(edge.source); referenced.add(edge.target); }
    }
    if (evidenceBounded) notes.push(`Evidence per target bounded at ${MAX_BOARD_TARGET_EVIDENCE}; target totals are exact. Continue with /api/board/evidence using target and offset.`);
    const facts = graph.facts([...referenced], notes);
    const byId = new Map(symbols(facts.facts).map(item => [item.id, item]));
    graph.boundaries(scope.ids, req.filter.direction, notes, req.filter.kind);
    return {
      scope: byId.get(req.id)!, direction: req.filter.direction, withMembers: req.members,
      items: page.items.map(row => {
        const target = byId.get(row.id)!;
        return { target, ...(target.ownerId ? { owner: byId.get(target.ownerId)! } : {}), evidence: evidence.get(row.id)!, total: row.total };
      }),
      total: page.total, nextOffset: next(req.offset, page.items.length, page.total),
      symbols: [...byId.values()], bounded: scope.bounded || facts.bounded || evidenceBounded, notes,
    };
  });
}

export function buildBoardEvidence(cg: CodeGraph, query: URLSearchParams): BoardEvidence {
  const req = connectionRequest(query, true);
  const graph = new BoardGraph(cg);
  return graph.snapshot(() => {
    const nodes = graph.nodes([req.id, req.filter.target!]);
    if (!nodes.has(req.id) || !nodes.has(req.filter.target!)) throw notFound('Board scope or target is not in this index.');
    const notes: string[] = [];
    const scope = graph.scope([req.id], req.members, notes);
    const page = graph.evidence(scope.ids, req.filter, req.offset, req.limit);
    const referenced = new Set([req.id, req.filter.target!]);
    for (const edge of page.items) { referenced.add(edge.source); referenced.add(edge.target); }
    const facts = graph.facts([...referenced], notes);
    graph.boundaries(scope.ids, req.filter.direction, notes, req.filter.kind);
    return { symbols: symbols(facts.facts), items: page.items, total: page.total,
      nextOffset: next(req.offset, page.items.length, page.total), bounded: scope.bounded || facts.bounded, notes };
  });
}
