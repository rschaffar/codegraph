/** Read-only, all-kind Board queries. No reader-rail curation or inferred ownership. */
import type { CodeGraph } from '../index';
import type { Node } from '../types';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import { isTestFile } from '../search/query-utils';
import { isGeneratedFile } from '../extraction/generated-detection';

export interface BoardViewFilters {
  includeTests?: boolean;
  includeGenerated?: boolean;
  includeUncertain?: boolean;
}
/** Disjoint counts, with tests taking precedence over generated, then uncertain. */
export interface BoardExcludedCounts { tests: number; generated: number; uncertain: number }
export interface BoardExclusions {
  /** Filtered candidate identities; for Connections, peers with no eligible evidence. */
  symbols: BoardExcludedCounts;
  /** Original indexed evidence excluded from the reported scope, before paging/caps. */
  relations: BoardExcludedCounts;
}
export const noBoardExclusions = (): BoardExcludedCounts => ({ tests: 0, generated: 0, uncertain: 0 });
export interface BoardGroup {
  id: string;
  name: string;
  type: 'folder' | 'namespace';
  /** Folder prefix, or a namespace's declaration file (display context only). */
  path?: string;
  /** Namespace scope node ID, never a qualified-name/path approximation. */
  namespace?: string;
  total: number;
  byKind: Array<{ kind: string; count: number }>;
}

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
  namespace?: string;
  /** Direct, distinct eligible contains children, across every kind. */
  memberCount: number;
  generated?: boolean;
}

export interface BoardScope {
  ids: string[];
  bounded: boolean;
}

export interface BoardFilteredScope extends BoardScope {
  visibleIds: string[];
  reasons: Array<[string, number]>;
  excluded: BoardExcludedCounts;
}

export interface BoardConnectionFilter extends BoardViewFilters {
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
const sourceOrder = 'file_path, start_line, start_column, id';
const pathCtes = `board_test_files AS (SELECT value AS path FROM json_each(?)),
  board_generated_files AS (SELECT value AS path FROM json_each(?))`;
// TEXT affinity lets SQLite index the materialized scope's target lookup;
// untyped json_extract would force an O(scope × edges) scan of that join.
const scopeCte = `board_scope AS MATERIALIZED (SELECT CAST(json_extract(value, '$[0]') AS TEXT) AS id,
  json_extract(value, '$[1]') AS reason FROM json_each(?))`;
// Identity context and heuristic provenance do not imply uncertainty. Malformed
// metadata, numeric strings and booleans must behave like absent confidence.
const uncertainSql = `(CASE WHEN json_valid(e.metadata) THEN
  (CASE WHEN (json_type(e.metadata, '$.confidence') IN ('integer', 'real')
    AND json_extract(e.metadata, '$.confidence') >= -1.7976931348623157e308
    AND json_extract(e.metadata, '$.confidence') < 0.6)
    OR json_extract(e.metadata, '$.resolvedBy') = 'name-only' THEN 1 ELSE 0 END)
  ELSE 0 END)`;
const folderSql = `CASE WHEN instr(n.file_path, '/') = 0 THEN '' ELSE
  substr(n.file_path, 1, length(rtrim(n.file_path, replace(n.file_path, '/', ''))) - 1) END`;
interface BoardSql { cte: string; args: string[] }

function nodeReason(alias: string, filters: BoardViewFilters): string {
  return `CASE ${!filters.includeTests ? `WHEN ${alias}.file_path IN (SELECT path FROM board_test_files) THEN 1` : ''}
    ${!filters.includeGenerated ? `WHEN ${alias}.file_path IN (SELECT path FROM board_generated_files) THEN 2` : ''}
    WHEN 0 THEN 0 ELSE 0 END`;
}
function edgeReason(filters: BoardViewFilters): string {
  return `CASE ${!filters.includeTests ? `WHEN s.file_path IN (SELECT path FROM board_test_files)
    OR t.file_path IN (SELECT path FROM board_test_files) THEN 1` : ''}
    ${!filters.includeGenerated ? `WHEN s.file_path IN (SELECT path FROM board_generated_files)
    OR t.file_path IN (SELECT path FROM board_generated_files) THEN 2` : ''}
    ${!filters.includeUncertain ? `WHEN ${uncertainSql} THEN 3` : ''}
    WHEN 0 THEN 0 ELSE 0 END`;
}
/** Smallest nonzero reason, or zero only when every reason is zero. */
const reasonPriority = (...reasons: string[]): string =>
  `(min(${reasons.map(reason => `CASE WHEN ${reason}=0 THEN 4 ELSE ${reason} END`).join(',')}) % 4)`;

export class BoardGraph {
  private readonly db: SqliteDatabase;
  private pathArgs?: string[];

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
      this.pathArgs = undefined;
      return fn();
    })();
  }

  nodes(ids: readonly string[]): Map<string, Node> {
    return this.cg.getNodesByIds([...ids]);
  }

  /** Classify DISTINCT indexed paths, never every node or current disk source.
   * The covering file-path index and files PK keep this O(indexed files); SQL
   * joins below do all node/edge filtering and exact counting. Snapshot-local.
   */
  private paths(): string[] {
    if (!this.pathArgs) {
      const tests: string[] = [];
      const generated: string[] = [];
      const rows = this.db.prepare(`SELECT n.file_path, IFNULL(f.generated, 0) AS generated
        FROM (SELECT DISTINCT file_path FROM nodes) n LEFT JOIN files f ON f.path=n.file_path`).iterate();
      for (const row of rows) {
        if (isTestFile(row.file_path.replace(/\\/g, '/'))) tests.push(row.file_path);
        if (row.generated === 1 || isGeneratedFile(row.file_path)) generated.push(row.file_path);
      }
      this.pathArgs = [json(tests), json(generated)];
    }
    return this.pathArgs;
  }

  private counts(query: BoardSql, table = 'board_candidates'): { total: number; excluded: BoardExcludedCounts } {
    const row = this.db.prepare(`${query.cte} SELECT
      count(CASE WHEN reason=0 THEN 1 END) AS total,
      count(CASE WHEN reason=1 THEN 1 END) AS tests,
      count(CASE WHEN reason=2 THEN 1 END) AS generated,
      count(CASE WHEN reason=3 THEN 1 END) AS uncertain FROM ${table}`).get(...query.args);
    return { total: row.total, excluded: { tests: row.tests, generated: row.generated, uncertain: row.uncertain } };
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
          AND e.target NOT IN ${setSql}
        ORDER BY n.file_path, n.start_line, n.start_column, n.id LIMIT ?`)
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

  /** Retain explicit identities even when filtered. For automatic descendants,
   * propagate a blocked contains path's reason; another eligible path wins.
   * UNION deduplicates (id, reason), so corrupt cycles terminate in SQL.
   */
  filterScope(scope: BoardScope, seeds: readonly string[], filters: BoardViewFilters): BoardFilteredScope {
    const cte = `WITH RECURSIVE ${pathCtes},
      board_contains AS MATERIALIZED (SELECT e.source, e.target, ${edgeReason(filters)} AS reason
        FROM edges e INDEXED BY idx_edges_source_kind JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
        WHERE e.kind='contains' AND e.source IN ${setSql} AND e.target IN ${setSql}),
      board_reachable(id, reason) AS (SELECT value, 0 FROM json_each(?) UNION
        SELECT e.target, CASE WHEN r.reason=0 THEN e.reason WHEN e.reason=0 THEN r.reason
          ELSE min(r.reason, e.reason) END
        FROM board_reachable r JOIN board_contains e ON e.source=r.id),
      board_candidates AS (SELECT id, min(reason) AS reason FROM board_reachable GROUP BY id)`;
    const args = [...this.paths(), json(scope.ids), json(scope.ids), json(seeds)];
    const rows = this.db.prepare(`${cte} SELECT id, reason FROM board_candidates ORDER BY id`).all(...args) as { id: string; reason: number }[];
    const excluded = noBoardExclusions();
    const visibleIds: string[] = [];
    for (const row of rows) {
      if (!row.reason) visibleIds.push(row.id);
      else excluded[(['', 'tests', 'generated', 'uncertain'] as const)[row.reason] as keyof BoardExcludedCounts]++;
    }
    return { ...scope, visibleIds, reasons: rows.map(row => [row.id, row.reason]), excluded };
  }

  /** Identity context only: returned ancestors are never canvas membership. */
  facts(ids: readonly string[], notes: string[], filters: BoardViewFilters = {}): { facts: Map<string, BoardFact>; bounded: boolean } {
    const nodes = this.nodes(ids);
    const facts = new Map<string, BoardFact>();
    const owners = new Map<string, string>();
    let frontier = [...nodes.keys()];
    let bounded = false;
    let ancestorCount = 0;
    for (let depth = 0; frontier.length; depth++) {
      const rows = this.db.prepare(`WITH ${pathCtes} SELECT n.id,
        (SELECT count(DISTINCT e.target) FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
          WHERE e.source=n.id AND e.kind='contains' AND (${edgeReason(filters)})=0) AS members,
        (SELECT min(e.source) FROM edges e
          WHERE e.target=n.id AND e.kind='contains') AS parent,
        (SELECT count(DISTINCT e.source) FROM edges e
          WHERE e.target=n.id AND e.kind='contains') AS parents
        FROM nodes n WHERE n.id IN ${setSql}`).all(...this.paths(), json(frontier)) as
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
    for (const fact of facts.values()) {
      let cursor: BoardFact | undefined = fact;
      const visited = new Set<string>();
      while (cursor && !visited.has(cursor.node.id)) {
        visited.add(cursor.node.id);
        if (cursor.node.kind === 'namespace') { fact.namespace = cursor.node.qualifiedName; break; }
        cursor = cursor.ownerId ? facts.get(cursor.ownerId) : undefined;
      }
    }
    const generated = this.cg.generatedFilePredicate([...facts.values()].map(fact => fact.node.filePath));
    for (const fact of facts.values()) if (generated(fact.node.filePath)) fact.generated = true;
    if (cyclic.size) notes.push(`Cyclic contains ownership: ${cyclic.size} symbols; owners omitted.`);
    if (bounded) notes.push(`Ancestor identity context bounded at ${MAX_BOARD_ANCESTORS} symbols / ${MAX_BOARD_DEPTH} levels; unproven owners omitted.`);
    return { facts, bounded };
  }

  search(q: string, kind: string | undefined, path: string | undefined, offset: number, limit: number,
    filters: BoardViewFilters = {}, namespace?: string): { ids: string[]; total: number; excluded: BoardExcludedCounts } {
    const where: string[] = [];
    const args = [...this.paths()];
    const namespaceCte = namespace ? `, board_namespace(id) AS (SELECT ? UNION
      SELECT e.target FROM board_namespace a JOIN edges e ON e.source=a.id AND e.kind='contains')` : '';
    if (namespace) { args.push(namespace); where.push('n.id IN (SELECT id FROM board_namespace)'); }
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
    const cte = `WITH RECURSIVE ${pathCtes}${namespaceCte}, board_candidates AS (
      SELECT n.id, n.file_path, n.start_line, n.start_column, ${nodeReason('n', filters)} AS reason
      FROM nodes n ${where.length ? `WHERE ${where.join(' AND ')}` : ''})`;
    const counts = this.counts({ cte, args });
    const rows = this.db.prepare(`${cte} SELECT id FROM board_candidates WHERE reason=0
      ORDER BY ${sourceOrder} LIMIT ? OFFSET ?`).all(...args, limit, offset) as { id: string }[];
    return { ids: rows.map(row => row.id), ...counts };
  }

  /** Direct children, uncapped by the recursive projection scope. */
  members(id: string, offset: number, limit: number, filters: BoardViewFilters): { ids: string[]; total: number; excluded: BoardExcludedCounts } {
    const cte = `WITH ${pathCtes}, board_candidates AS (
      SELECT t.id, t.file_path, t.start_line, t.start_column, min(${edgeReason(filters)}) AS reason
      FROM edges e JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
      WHERE e.source=? AND e.kind='contains' GROUP BY t.id)`;
    const args = [...this.paths(), id];
    const counts = this.counts({ cte, args });
    const rows = this.db.prepare(`${cte} SELECT id FROM board_candidates WHERE reason=0
      ORDER BY ${sourceOrder} LIMIT ? OFFSET ?`).all(...args, limit, offset) as { id: string }[];
    return { ids: rows.map(row => row.id), ...counts };
  }

  /** Indexed groups only. Folder totals use the exact same binary prefix as
   * search; namespace totals use real transitive contains, never name splitting.
   * All counting/aggregation stays in SQL; only a bounded page reaches JS.
   */
  groups(type: 'folder' | 'namespace', q: string, offset: number, limit: number, filters: BoardViewFilters): {
    items: BoardGroup[]; total: number; excluded: BoardExcludedCounts;
  } {
    const args = [...this.paths()];
    const pattern = `%${boardLike(q)}%`;
    let groups: string;
    let candidates: string;
    const columns = `g.id AS group_id, n.id, n.kind, ${nodeReason('n', filters)} AS reason`;
    if (type === 'folder') {
      groups = `board_folders AS (SELECT DISTINCT ${folderSql} AS path FROM nodes n),
        board_groups AS (SELECT 'folder:' || path AS id, CASE WHEN path='' THEN '.' ELSE path END AS name,
          path, NULL AS namespace FROM board_folders ${q ? "WHERE path LIKE ? ESCAPE '\\'" : ''})`;
      if (q) args.push(pattern);
      // Separate root/equality/range branches let SQLite seek file_path for
      // every non-root folder, instead of scanning all nodes for each group.
      candidates = `SELECT ${columns} FROM board_groups g JOIN nodes n
        ON n.file_path >= g.path || '/' AND n.file_path < g.path || '0' WHERE g.path<>''
        UNION ALL SELECT ${columns} FROM board_groups g JOIN nodes n ON n.file_path=g.path WHERE g.path<>''
        UNION ALL SELECT ${columns} FROM board_groups g CROSS JOIN nodes n WHERE g.path=''`;
    } else {
      groups = `board_groups AS (SELECT id, COALESCE(NULLIF(qualified_name, ''), name) AS name, file_path AS path, qualified_name AS namespace
        FROM nodes ${q ? "WHERE kind='namespace' AND (name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\' OR file_path LIKE ? ESCAPE '\\')" : "WHERE kind='namespace'"}),
        board_namespace_members(group_id, id) AS (SELECT id, id FROM board_groups UNION
          SELECT m.group_id, e.target FROM board_namespace_members m
          JOIN edges e ON e.source=m.id AND e.kind='contains')`;
      if (q) args.push(pattern, pattern, pattern);
      candidates = `SELECT g.group_id, n.id, n.kind, ${nodeReason('n', filters)} AS reason
        FROM board_namespace_members g JOIN nodes n ON n.id=g.id`;
    }
    const cte = `WITH RECURSIVE ${pathCtes}, ${groups}, board_candidates AS (${candidates}),
      board_totals AS (SELECT group_id, count(*) AS total FROM board_candidates WHERE reason=0 GROUP BY group_id)`;
    const total = this.db.prepare(`${cte} SELECT count(*) AS total FROM board_totals`).get(...args).total as number;
    const rows = this.db.prepare(`${cte} SELECT g.*, t.total FROM board_totals t JOIN board_groups g ON g.id=t.group_id
      ORDER BY g.path, g.name, g.id LIMIT ? OFFSET ?`).all(...args, limit, offset) as
      { id: string; name: string; path: string; namespace: string | null; total: number }[];
    const kindRows = this.db.prepare(`${cte} SELECT group_id, kind, count(*) AS count FROM board_candidates
      WHERE reason=0 AND group_id IN ${setSql} GROUP BY group_id, kind ORDER BY group_id, kind`)
      .all(...args, json(rows.map(row => row.id))) as { group_id: string; kind: string; count: number }[];
    const byKind = new Map<string, Array<{ kind: string; count: number }>>();
    for (const row of kindRows) {
      if (!byKind.has(row.group_id)) byKind.set(row.group_id, []);
      byKind.get(row.group_id)!.push({ kind: row.kind, count: row.count });
    }
    // Overlapping recursive group scopes must not multiply excluded-symbol counts.
    const excluded = this.counts({ cte: `${cte}, board_unique AS (
      SELECT id, min(reason) AS reason FROM board_candidates GROUP BY id)`, args }, 'board_unique').excluded;
    return { items: rows.map(row => ({ id: row.id, name: row.name, type,
      path: row.path, ...(type === 'namespace' ? { namespace: row.id } : {}), total: row.total,
      byKind: byKind.get(row.id) ?? [] })), total, excluded };
  }

  projection(scope: BoardFilteredScope, filters: BoardViewFilters): { items: BoardRelation[]; bounded: boolean; excluded: BoardExcludedCounts } {
    const cte = `WITH ${pathCtes}, ${scopeCte}, board_edges AS MATERIALIZED (
      SELECT e.*, s.file_path AS file, sc.reason AS source_reason, tc.reason AS target_reason,
        ${edgeReason(filters)} AS edge_reason FROM board_scope sc JOIN edges e ON e.source=sc.id
        JOIN board_scope tc ON tc.id=e.target JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target),
      board_candidates AS (SELECT *, ${reasonPriority('edge_reason', 'source_reason', 'target_reason')} AS reason FROM board_edges)`;
    const args = [...this.paths(), JSON.stringify(scope.reasons)];
    const counts = this.counts({ cte, args });
    const rows = this.db.prepare(`${cte} SELECT * FROM board_candidates WHERE reason=0
      ORDER BY source, target, kind, IFNULL(line, -1), IFNULL(col, -1), id LIMIT ?`)
      .all(...args, MAX_BOARD_RELATIONS) as EdgeRow[];
    return { items: rows.map(relation), bounded: counts.total > MAX_BOARD_RELATIONS, excluded: counts.excluded };
  }

  private connectionSql(scope: BoardFilteredScope, filter: BoardConnectionFilter): BoardSql {
    const anchor = filter.direction === 'outgoing' ? 'source' : 'target';
    const peer = filter.direction === 'outgoing' ? 'target' : 'source';
    const where: string[] = [];
    const args = [...this.paths(), JSON.stringify(scope.reasons)];
    if (filter.kind) { where.push('e.kind = ?'); args.push(filter.kind); }
    if (filter.target) { where.push(`e.${peer} = ?`); args.push(filter.target); }
    if (filter.q) {
      where.push("(p.name LIKE ? ESCAPE '\\' OR p.qualified_name LIKE ? ESCAPE '\\' OR p.file_path LIKE ? ESCAPE '\\')");
      const q = `%${boardLike(filter.q)}%`;
      args.push(q, q, q);
    }
    return { cte: `WITH ${pathCtes}, ${scopeCte}, board_edges AS MATERIALIZED (
      SELECT e.*, s.file_path AS file, p.id AS peer_id, p.file_path AS peer_file,
        p.start_line AS peer_line, p.start_column AS peer_column, sc.reason AS scope_reason,
        ${edgeReason(filter)} AS edge_reason FROM board_scope sc JOIN edges e ON e.${anchor}=sc.id
        JOIN nodes p ON p.id=e.${peer} JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}),
      board_candidates AS (SELECT *, ${reasonPriority('edge_reason', 'scope_reason')} AS reason FROM board_edges)`, args };
  }

  private connectionCounts(query: BoardSql): { total: number; excluded: BoardExclusions } {
    const relations = this.counts(query).excluded;
    const peers = this.counts({ ...query, cte: `${query.cte}, board_peers AS (
      SELECT peer_id, min(reason) AS reason FROM board_candidates GROUP BY peer_id)` }, 'board_peers');
    return { total: peers.total, excluded: { symbols: peers.excluded, relations } };
  }

  connections(scope: BoardFilteredScope, filter: BoardConnectionFilter, offset: number, limit: number): {
    items: { id: string; total: number }[]; total: number; excluded: BoardExclusions;
  } {
    const query = this.connectionSql(scope, filter);
    const counts = this.connectionCounts(query);
    const items = this.db.prepare(`${query.cte} SELECT peer_id AS id, count(*) AS total FROM board_candidates WHERE reason=0
      GROUP BY peer_id ORDER BY peer_file, peer_line, peer_column, peer_id LIMIT ? OFFSET ?`)
      .all(...query.args, limit, offset) as { id: string; total: number }[];
    return { items, ...counts };
  }

  evidence(scope: BoardFilteredScope, filter: BoardConnectionFilter, offset: number, limit: number): {
    items: BoardRelation[]; total: number; excluded: BoardExclusions;
  } {
    const query = this.connectionSql(scope, filter);
    const counts = this.counts(query);
    const excluded = this.connectionCounts(query).excluded;
    // Source file remains evidence location when browsing incoming connections.
    const rows = this.db.prepare(`${query.cte} SELECT * FROM board_candidates WHERE reason=0
      ORDER BY id LIMIT ? OFFSET ?`).all(...query.args, limit, offset) as EdgeRow[];
    return { items: rows.map(relation), total: counts.total, excluded };
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
