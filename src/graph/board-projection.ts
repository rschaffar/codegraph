/** Read-only, all-kind Board queries. No reader-rail curation or inferred ownership. */
import type { CodeGraph } from '../index';
import type { Node } from '../types';
import type { SqliteDatabase } from '../db/sqlite-adapter';

export const MAX_BOARD_SELECTION = 128;
export const MAX_BOARD_SCOPE = 2048;
export const MAX_BOARD_RELATIONS = 5000;
export const MAX_BOARD_DEPTH = 64;
export const MAX_BOARD_ANCESTORS = 2048;
export const MAX_BOARD_TARGET_EVIDENCE = 40;

export interface BoardRelation {
  /** Original SQLite evidence identity, not an aggregate or endpoint-pair ID. */
  id: string;
  source: string;
  target: string;
  kind: string;
  file?: string;
  line?: number;
  col?: number;
  confidence?: number;
  provenance?: string;
  synthesizedBy?: string;
  via?: string;
  registeredAt?: string;
  resolvedBy?: string;
}

export interface BoardFact {
  node: Node;
  ownerId?: string;
  /** Direct, distinct contains children, across every kind. */
  memberCount: number;
  generated?: boolean;
}

export interface BoardScope {
  ids: string[];
  bounded: boolean;
}

export interface BoardConnectionFilter {
  direction: 'incoming' | 'outgoing';
  kind?: string;
  q?: string;
  target?: string;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  provenance: string | null;
  line: number | null;
  col: number | null;
  file: string | null;
}

/** Escape SQL LIKE syntax; filters are literal substrings, never SQL/FTS expressions. */
export function boardLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

const setSql = '(SELECT value FROM json_each(?))';
const json = (ids: readonly string[]): string => JSON.stringify(ids);

export class BoardGraph {
  private readonly db: SqliteDatabase;

  constructor(private readonly cg: CodeGraph) {
    // The engine has no public paged all-kind edge API. Keep the existing
    // internal DB seam localized here; all statements below are parameterized
    // SELECTs, and no alternate project/database is opened.
    this.db = cg['db'].getDb();
  }

  /** One SQLite read snapshot keeps counts, pages and evidence consistent. */
  snapshot<T>(fn: () => T): T {
    return this.db.transaction(() => {
      // A different indexing process may commit between session acquisition and
      // BEGIN. Do not combine pre-snapshot LRU nodes with snapshot edge counts.
      this.cg.dropReadCaches();
      return fn();
    })();
  }

  nodes(ids: readonly string[]): Map<string, Node> {
    return this.cg.getNodesByIds([...ids]);
  }

  /** Bounded breadth-first contains traversal, including the explicit seeds. */
  scope(seeds: readonly string[], members: boolean, notes: string[]): BoardScope {
    const seen = new Set(seeds);
    let frontier = [...seen];
    if (!members) return { ids: [...seen], bounded: false };
    for (let depth = 0; frontier.length; depth++) {
      const remaining = MAX_BOARD_SCOPE - seen.size;
      // LIMIT is in SQL: a god-container never materializes its complete fanout.
      const rows = this.db.prepare(`SELECT DISTINCT e.target AS id FROM edges e
        JOIN nodes n ON n.id = e.target
        WHERE e.source IN ${setSql} AND e.kind = 'contains'
          AND e.target NOT IN ${setSql} LIMIT ?`)
        .all(json(frontier), json([...seen]), remaining + 1) as { id: string }[];
      if (rows.length > remaining || (depth >= MAX_BOARD_DEPTH && rows.length > 0)) {
        if (depth < MAX_BOARD_DEPTH) for (const row of rows.slice(0, remaining)) seen.add(row.id);
        notes.push(`Contains scope bounded at ${MAX_BOARD_SCOPE} symbols / ${MAX_BOARD_DEPTH} levels; totals describe only the returned scope.`);
        return { ids: [...seen], bounded: true };
      }
      frontier = rows.map(row => row.id);
      for (const id of frontier) seen.add(id);
    }
    return { ids: [...seen], bounded: false };
  }

  /** Identity context only: returned ancestors are never canvas membership. */
  facts(ids: readonly string[], notes: string[]): { facts: Map<string, BoardFact>; bounded: boolean } {
    const nodes = this.nodes(ids);
    const facts = new Map<string, BoardFact>();
    const owners = new Map<string, string>();
    let frontier = [...nodes.keys()];
    let bounded = false;
    let ancestorCount = 0;
    for (let depth = 0; frontier.length; depth++) {
      const rows = this.db.prepare(`SELECT n.id,
        (SELECT count(DISTINCT e.target) FROM edges e JOIN nodes c ON c.id=e.target
          WHERE e.source=n.id AND e.kind='contains') AS members,
        (SELECT min(e.source) FROM edges e
          WHERE e.target=n.id AND e.kind='contains') AS parent,
        (SELECT count(DISTINCT e.source) FROM edges e
          WHERE e.target=n.id AND e.kind='contains') AS parents
        FROM nodes n WHERE n.id IN ${setSql}`).all(json(frontier)) as
        { id: string; members: number; parent: string | null; parents: number }[];
      const next = new Set<string>();
      for (const row of rows) {
        facts.set(row.id, { node: nodes.get(row.id)!, memberCount: row.members });
        if (row.parents > 1) notes.push(`Ambiguous contains ownership for ${row.id}: ${row.parents} parents; owner omitted.`);
        if (row.parents !== 1 || !row.parent) continue;
        if (!nodes.has(row.parent)) {
          if (depth >= MAX_BOARD_DEPTH || (!next.has(row.parent) && ancestorCount + next.size >= MAX_BOARD_ANCESTORS)) {
            bounded = true;
            continue;
          }
          next.add(row.parent);
        }
        owners.set(row.id, row.parent);
      }
      const loaded = this.nodes([...next]);
      frontier = [...loaded.keys()];
      ancestorCount += loaded.size;
      for (const [id, node] of loaded) nodes.set(id, node);
    }
    // Corrupt cyclic containment is not proof of ownership. Omit every owner
    // whose chain enters a cycle (including a self-parent), rather than choosing.
    const cyclic = new Set<string>();
    for (const id of owners.keys()) {
      const visited = new Set<string>();
      let cursor: string | undefined = id;
      while (cursor && owners.has(cursor)) {
        if (visited.has(cursor)) {
          for (const member of visited) cyclic.add(member);
          break;
        }
        visited.add(cursor);
        cursor = owners.get(cursor);
      }
    }
    for (const [id, ownerId] of owners) {
      if (!facts.has(ownerId)) notes.push(`Missing contains parent ${ownerId} for ${id}; owner omitted.`);
      else if (!cyclic.has(id)) facts.get(id)!.ownerId = ownerId;
    }
    const generated = this.cg.generatedFilePredicate([...facts.values()].map(fact => fact.node.filePath));
    for (const fact of facts.values()) if (generated(fact.node.filePath)) fact.generated = true;
    if (cyclic.size) notes.push(`Cyclic contains ownership: ${cyclic.size} symbols; owners omitted.`);
    if (bounded) notes.push(`Ancestor identity context bounded at ${MAX_BOARD_ANCESTORS} symbols / ${MAX_BOARD_DEPTH} levels; unproven owners omitted.`);
    return { facts, bounded };
  }

  search(q: string, kind: string | undefined, path: string | undefined, offset: number, limit: number): { ids: string[]; total: number } {
    const where: string[] = [];
    const args: string[] = [];
    if (q) {
      where.push("(n.name LIKE ? ESCAPE '\\' OR n.qualified_name LIKE ? ESCAPE '\\')");
      args.push(`%${boardLike(q)}%`, `%${boardLike(q)}%`);
    }
    if (kind) { where.push('n.kind = ?'); args.push(kind); }
    if (path) {
      // Binary range is a case-sensitive, index-seeking folder prefix. LIKE
      // would treat filesystem names case-insensitively and defeat this index.
      where.push('(n.file_path = ? OR (n.file_path >= ? AND n.file_path < ?))');
      args.push(path, `${path}/`, `${path}0`);
    }
    const sql = `FROM nodes n ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const total = this.db.prepare(`SELECT count(*) AS total ${sql}`).get(...args).total as number;
    const rows = this.db.prepare(`SELECT n.id ${sql} ORDER BY n.file_path, n.start_line, n.id LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as { id: string }[];
    return { ids: rows.map(row => row.id), total };
  }

  projection(ids: readonly string[]): { items: BoardRelation[]; bounded: boolean } {
    const rows = this.db.prepare(`SELECT e.*, n.file_path AS file FROM edges e
      JOIN nodes n ON n.id=e.source
      WHERE e.source IN ${setSql} AND e.target IN ${setSql}
      ORDER BY e.source, e.target, e.kind, IFNULL(e.line, -1), IFNULL(e.col, -1) LIMIT ?`)
      .all(json(ids), json(ids), MAX_BOARD_RELATIONS + 1) as EdgeRow[];
    return { items: rows.slice(0, MAX_BOARD_RELATIONS).map(relation), bounded: rows.length > MAX_BOARD_RELATIONS };
  }

  private connectionSql(ids: readonly string[], filter: BoardConnectionFilter): { sql: string; args: string[] } {
    const anchor = filter.direction === 'outgoing' ? 'source' : 'target';
    const peer = filter.direction === 'outgoing' ? 'target' : 'source';
    const where = [`e.${anchor} IN ${setSql}`];
    const args = [json(ids)];
    if (filter.kind) { where.push('e.kind = ?'); args.push(filter.kind); }
    if (filter.target) { where.push(`e.${peer} = ?`); args.push(filter.target); }
    if (filter.q) {
      where.push("(p.name LIKE ? ESCAPE '\\' OR p.qualified_name LIKE ? ESCAPE '\\' OR p.file_path LIKE ? ESCAPE '\\')");
      const q = `%${boardLike(filter.q)}%`;
      args.push(q, q, q);
    }
    return { sql: `FROM edges e JOIN nodes p ON p.id=e.${peer} WHERE ${where.join(' AND ')}`, args };
  }

  connections(ids: readonly string[], filter: BoardConnectionFilter, offset: number, limit: number): { items: { id: string; total: number }[]; total: number } {
    const { sql, args } = this.connectionSql(ids, filter);
    const total = this.db.prepare(`SELECT count(DISTINCT p.id) AS total ${sql}`).get(...args).total as number;
    const items = this.db.prepare(`SELECT p.id, count(*) AS total ${sql}
      GROUP BY p.id ORDER BY p.file_path, p.start_line, p.id LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as { id: string; total: number }[];
    return { items, total };
  }

  evidence(ids: readonly string[], filter: BoardConnectionFilter, offset: number, limit: number): { items: BoardRelation[]; total: number } {
    const { sql, args } = this.connectionSql(ids, filter);
    const total = this.db.prepare(`SELECT count(*) AS total ${sql}`).get(...args).total as number;
    // Source file is evidence location even when browsing incoming connections.
    const rows = this.db.prepare(`SELECT e.*, (SELECT file_path FROM nodes WHERE id=e.source) AS file
      ${sql} ORDER BY e.id LIMIT ? OFFSET ?`).all(...args, limit, offset) as EdgeRow[];
    return { items: rows.map(relation), total };
  }

  boundaries(ids: readonly string[], direction: 'incoming' | 'outgoing', notes: string[], kind?: string): void {
    const anchor = direction === 'outgoing' ? 'source' : 'target';
    const peer = direction === 'outgoing' ? 'target' : 'source';
    const kindSql = kind ? ' AND e.kind=?' : '';
    const args = kind ? [json(ids), kind] : [json(ids)];
    const missing = this.db.prepare(`SELECT count(*) AS total FROM edges e
      LEFT JOIN nodes p ON p.id=e.${peer} WHERE e.${anchor} IN ${setSql} AND p.id IS NULL${kindSql}`).get(...args).total as number;
    if (missing) notes.push(`${missing} indexed relationships have outside-index/missing ${peer} endpoints; no symbols fabricated.`);
    if (direction === 'outgoing') {
      const unresolved = this.db.prepare(`SELECT count(*) AS total FROM unresolved_refs
        WHERE from_node_id IN ${setSql}${kind ? ' AND reference_kind=?' : ''}`).get(...args).total as number;
      if (unresolved) notes.push(`${unresolved} unresolved references in scope (not resolved relationships; excluded from totals).`);
    }
  }
}

function relation(row: EdgeRow): BoardRelation {
  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = row.metadata ? JSON.parse(row.metadata) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
  } catch { /* Malformed metadata must not destroy indexed evidence identity. */ }
  const result: BoardRelation = { id: String(row.id), source: row.source, target: row.target, kind: row.kind };
  if (row.file !== null) result.file = row.file.replace(/\\/g, '/');
  if (row.line !== null) result.line = row.line;
  if (row.col !== null) result.col = row.col;
  if (row.provenance) result.provenance = row.provenance;
  if (typeof meta.confidence === 'number' && Number.isFinite(meta.confidence)) result.confidence = meta.confidence;
  for (const key of ['synthesizedBy', 'via', 'registeredAt', 'resolvedBy'] as const) {
    if (typeof meta[key] === 'string') result[key] = meta[key];
  }
  return result;
}
