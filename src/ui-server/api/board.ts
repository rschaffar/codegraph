/** Board HTTP contract; source still goes through the existing /api/source chokepoint. */
import type { CodeGraph } from '../../index';
import { EDGE_KINDS, NODE_KINDS } from '../../types';
import {
  BoardGraph, MAX_BOARD_SELECTION, MAX_BOARD_RELATIONS, MAX_BOARD_TARGET_EVIDENCE,
  noBoardExclusions, type BoardFact, type BoardRelation, type BoardConnectionFilter,
  type BoardViewFilters, type BoardExclusions, type BoardExcludedCounts, type BoardGroup,
} from '../../graph/board-projection';
import { toNodeRef, type WireNodeRef } from './wire';
import { badRequest, notFound } from './respond';

export type { BoardRelation, BoardViewFilters, BoardExclusions, BoardGroup } from '../../graph/board-projection';
export interface BoardSymbol extends WireNodeRef {
  /** Indexed declaration column, preserving ordering for same-line members. */
  startColumn: number;
  ownerId?: string;
  /** Nearest proven indexed namespace, not a directory-derived label. */
  namespace?: string;
  purpose?: string;
  /** Direct distinct contains children eligible under the active filters, of any kind. */
  memberCount: number;
  membersBounded?: boolean;
}
export interface BoardProjection {
  symbols: BoardSymbol[];
  relations: BoardRelation[];
  /** Only resolved explicit selections, never descendants or identity ancestors. */
  included: string[];
  /** Eligible explicit/automatic scope identities, excluding ancestor-only context. */
  scopeIds?: string[];
  missing: string[];
  bounded: boolean;
  notes: string[];
  nodeKinds: string[];
  edgeKinds: string[];
  excluded: BoardExclusions;
}
export interface BoardSearch {
  /** Page items plus bounded proven identity ancestors; never extra search matches. */
  symbols: BoardSymbol[];
  items: BoardSymbol[];
  total: number;
  nextOffset: number | null;
  bounded: boolean;
  notes: string[];
  excluded: BoardExclusions;
}
export interface BoardGroups extends Omit<BoardSearch, 'items' | 'symbols'> { items: BoardGroup[] }
export interface BoardMembers extends BoardSearch { symbols: BoardSymbol[] }
export interface BoardConnections {
  scope: BoardSymbol;
  direction: 'incoming' | 'outgoing';
  withMembers: boolean;
  items: { target: BoardSymbol; owner?: BoardSymbol; evidence: BoardRelation[]; total: number }[];
  excluded: BoardExclusions;
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
  excluded: BoardExclusions;
}

export function toBoardSymbol(fact: BoardFact): BoardSymbol {
  return { ...toNodeRef(fact.node), startColumn: fact.node.startColumn, memberCount: fact.memberCount,
    ...(fact.ownerId ? { ownerId: fact.ownerId } : {}), ...(fact.generated ? { generated: true } : {}),
    ...(fact.namespace ? { namespace: fact.namespace } : {}) };
}
function symbols(facts: Map<string, BoardFact>): BoardSymbol[] {
  return [...facts.values()].map(toBoardSymbol);
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

const filterKeys = ['tests', 'generated', 'uncertain'];
function flag(query: URLSearchParams, key: string): boolean {
  const value = query.get(key);
  if (value !== null && value !== '0' && value !== '1') throw badRequest(`Board ${key} must be 0 or 1.`);
  return value === '1';
}
function filters(query: URLSearchParams): BoardViewFilters {
  return { includeTests: flag(query, 'tests'), includeGenerated: flag(query, 'generated'), includeUncertain: flag(query, 'uncertain') };
}
function exclusions(notes: string[], counts: BoardExcludedCounts, unit: string): void {
  const reasons = [counts.tests ? `${counts.tests} tests/non-production` : '',
    counts.generated ? `${counts.generated} generated` : '', counts.uncertain ? `${counts.uncertain} uncertain (confidence < 0.6 or name-only)` : ''].filter(Boolean);
  if (reasons.length) notes.push(`Filters excluded ${unit}: ${reasons.join('; ')}. Counts are exact before paging, disjoint by tests, then generated, then uncertain.`);
}
function excludedSymbols(counts: BoardExcludedCounts): BoardExclusions {
  return { symbols: counts, relations: noBoardExclusions() };
}

export function buildBoard(cg: CodeGraph, query: URLSearchParams): BoardProjection {
  validate(query, ['ids', ...filterKeys]);
  const viewFilters = filters(query);
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
    const scope = graph.filterScope(graph.scope(included, true, notes), included, viewFilters);
    const facts = graph.facts(scope.visibleIds, notes, viewFilters);
    const edges = graph.projection(scope, viewFilters);
    const excluded = { symbols: scope.excluded, relations: edges.excluded };
    exclusions(notes, excluded.symbols, 'automatic scope symbols (explicit selections retained)');
    exclusions(notes, excluded.relations, 'relationships in the reported scope');
    if (edges.bounded) notes.push(`Board evidence bounded at ${MAX_BOARD_RELATIONS} relationships; use Connections and paged /api/board/evidence to inspect the remainder.`);
    graph.boundaries(scope.visibleIds, 'outgoing', notes);
    graph.boundaries(scope.visibleIds, 'incoming', notes);
    const result = symbols(facts.facts);
    if (scope.bounded) for (const item of result) if (item.memberCount) item.membersBounded = true;
    return {
      symbols: result, relations: edges.items, included, scopeIds: scope.visibleIds, missing, excluded,
      bounded: scope.bounded || facts.bounded || edges.bounded, notes,
      nodeKinds: [...NODE_KINDS], edgeKinds: [...EDGE_KINDS],
    };
  });
}

export function buildBoardSearch(cg: CodeGraph, query: URLSearchParams): BoardSearch {
  validate(query, ['q', 'kind', 'path', 'namespace', 'offset', 'limit', ...filterKeys]);
  const viewFilters = filters(query);
  const namespace = text(query, 'namespace', 2048) || undefined;
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
    if (namespace && graph.nodes([namespace]).get(namespace)?.kind !== 'namespace') throw notFound('Board namespace is not an indexed namespace.');
    const page = graph.search(q, kind, path || undefined, offset, limit, viewFilters, namespace);
    const facts = graph.facts(page.ids, notes, viewFilters);
    exclusions(notes, page.excluded, 'matching symbols');
    if (q) notes.push('Exact literal substring-search totals may scan indexed symbols.');
    return { symbols: symbols(facts.facts), items: page.ids.map(id => toBoardSymbol(facts.facts.get(id)!)), total: page.total,
      nextOffset: next(offset, page.ids.length, page.total), bounded: facts.bounded, notes, excluded: excludedSymbols(page.excluded) };
  });
}

export function buildBoardGroups(cg: CodeGraph, query: URLSearchParams): BoardGroups {
  validate(query, ['type', 'q', 'offset', 'limit', ...filterKeys]);
  const type = text(query, 'type', 16, true);
  if (type !== 'folder' && type !== 'namespace') throw badRequest('Board group type must be folder or namespace.');
  const q = text(query, 'q', 256);
  const viewFilters = filters(query);
  const { offset, limit } = paging(query, 30);
  const graph = new BoardGraph(cg);
  return graph.snapshot(() => {
    const page = graph.groups(type, q, offset, limit, viewFilters);
    const notes = [type === 'folder'
      ? 'Groups are distinct indexed containing folders; preview totals include each exact folder prefix and nested contents. No filesystem scan.'
      : 'Groups are indexed namespace nodes; preview totals include the namespace and its transitive contains descendants.'];
    exclusions(notes, page.excluded, 'distinct matching group-scope symbols (overlapping scopes counted once)');
    return { items: page.items, total: page.total, nextOffset: next(offset, page.items.length, page.total),
      bounded: false, notes, excluded: excludedSymbols(page.excluded) };
  });
}

export function buildBoardMembers(cg: CodeGraph, query: URLSearchParams): BoardMembers {
  validate(query, ['id', 'offset', 'limit', ...filterKeys]);
  const id = text(query, 'id', 2048, true);
  const viewFilters = filters(query);
  const { offset, limit } = paging(query, 50);
  const graph = new BoardGraph(cg);
  return graph.snapshot(() => {
    if (!graph.nodes([id]).has(id)) throw notFound('Board member owner is not in this index.');
    const notes: string[] = [];
    const page = graph.members(id, offset, limit, viewFilters);
    const facts = graph.facts([id, ...page.ids], notes, viewFilters);
    exclusions(notes, page.excluded, 'direct member symbols');
    return { symbols: symbols(facts.facts), items: page.ids.map(child => toBoardSymbol(facts.facts.get(child)!)),
      total: page.total, nextOffset: next(offset, page.ids.length, page.total), bounded: facts.bounded,
      notes, excluded: excludedSymbols(page.excluded) };
  });
}

function connectionRequest(query: URLSearchParams, evidence: boolean): {
  id: string; members: boolean; filter: BoardConnectionFilter; offset: number; limit: number;
} {
  validate(query, ['id', 'direction', 'members', 'kind', 'q', 'offset', 'limit', ...filterKeys, ...(evidence ? ['target'] : [])]);
  const id = text(query, 'id', 2048, true);
  const direction = text(query, 'direction', 16) || 'outgoing';
  if (direction !== 'incoming' && direction !== 'outgoing') throw badRequest('Board direction must be incoming or outgoing.');
  const members = text(query, 'members', 1) || '0';
  if (members !== '0' && members !== '1') throw badRequest('Board members must be 0 or 1.');
  const filter: BoardConnectionFilter = { ...filters(query), direction, kind: text(query, 'kind', 80) || undefined, q: text(query, 'q', 256) || undefined };
  if (evidence) filter.target = text(query, 'target', 2048, true);
  return { id, members: members === '1', filter, ...paging(query, evidence ? 100 : 30, evidence ? 200 : 100) };
}

export function buildBoardConnections(cg: CodeGraph, query: URLSearchParams): BoardConnections {
  const req = connectionRequest(query, false);
  const graph = new BoardGraph(cg);
  return graph.snapshot(() => {
    if (!graph.nodes([req.id]).has(req.id)) throw notFound('Board scope is not in this index.');
    const notes: string[] = [];
    const scope = graph.filterScope(graph.scope([req.id], req.members, notes), [req.id], req.filter);
    const page = graph.connections(scope, req.filter, req.offset, req.limit);
    exclusions(notes, scope.excluded, 'automatic scope symbols');
    exclusions(notes, page.excluded.symbols, 'connection targets with no eligible evidence');
    exclusions(notes, page.excluded.relations, 'matching relationships');
    const evidence = new Map<string, BoardRelation[]>();
    const referenced = new Set([req.id, ...page.items.map(row => row.id)]);
    let evidenceBounded = false;
    for (const row of page.items) {
      const details = graph.evidence(scope, { ...req.filter, target: row.id }, 0, MAX_BOARD_TARGET_EVIDENCE);
      evidence.set(row.id, details.items);
      if (details.total > details.items.length) evidenceBounded = true;
      for (const edge of details.items) { referenced.add(edge.source); referenced.add(edge.target); }
    }
    if (evidenceBounded) notes.push(`Evidence per target bounded at ${MAX_BOARD_TARGET_EVIDENCE}; target totals are exact. Continue with /api/board/evidence using target and offset.`);
    const facts = graph.facts([...referenced], notes, req.filter);
    const byId = new Map(symbols(facts.facts).map(item => [item.id, item]));
    graph.boundaries(scope.visibleIds, req.filter.direction, notes, req.filter.kind);
    return {
      scope: byId.get(req.id)!, direction: req.filter.direction, withMembers: req.members, excluded: page.excluded,
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
    const scope = graph.filterScope(graph.scope([req.id], req.members, notes), [req.id], req.filter);
    const page = graph.evidence(scope, req.filter, req.offset, req.limit);
    exclusions(notes, scope.excluded, 'automatic scope symbols');
    exclusions(notes, page.excluded.symbols, 'connection targets with no eligible evidence');
    exclusions(notes, page.excluded.relations, 'matching relationships');
    const referenced = new Set([req.id, req.filter.target!]);
    for (const edge of page.items) { referenced.add(edge.source); referenced.add(edge.target); }
    const facts = graph.facts([...referenced], notes, req.filter);
    graph.boundaries(scope.visibleIds, req.filter.direction, notes, req.filter.kind);
    return { symbols: symbols(facts.facts), items: page.items, total: page.total, excluded: page.excluded,
      nextOffset: next(req.offset, page.items.length, page.total), bounded: scope.bounded || facts.bounded, notes };
  });
}
