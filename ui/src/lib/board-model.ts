export interface BoardSymbol {
  id: string; kind: string; name: string; qualifiedName: string; file: string; line: number;
  endLine?: number; startColumn?: number; language?: string; signature?: string; ownerId?: string;
  purpose?: string; folder?: string; memberCount?: number; membersBounded?: boolean;
  test?: boolean; generated?: boolean;
}
export interface BoardEvidence {
  id: string; source: string; target: string; kind: string; file?: string; line?: number; col?: number;
  confidence?: number; provenance?: string; synthesizedBy?: string; via?: string; registeredAt?: string; resolvedBy?: string;
}
export type SymbolAction = 'connections' | 'contents' | 'hide' | 'restore' | 'expand' | 'more' | 'code' | 'locate' | 'pin' | 'siblingSources';
export type ActOnSymbol = (action: SymbolAction, id: string, event?: MouseEvent) => void;
export interface BoardFilters { tests: boolean; generated: boolean; uncertain: boolean }
/** Contiguous direct-child pages, separate from incidental ancestry/Connections facts. */
export interface BoardMemberPageState {
  ids?: readonly string[]; total?: number; loaded?: number; nextOffset?: number | null; loading?: boolean; bounded?: boolean;
}
export interface BoardPresentationOptions extends Partial<BoardFilters> {
  locatedMember?: string; memberPages?: Readonly<Record<string, BoardMemberPageState>>;
  /** Current eligible scope, distinct from cached ancestry/search identity facts. */
  eligibleIds?: ReadonlySet<string>;
}
export interface BoardMemberPage {
  ownerId: string; total: number; loaded: number; shown: number; filtered: number; remaining: number;
  hasMore: boolean; nextOffset: number | null; loading: boolean; bounded: boolean; retained?: number;
}
export interface BoardMemberRow {
  /** Occurrence keys keep shared contains children distinct without duplicating handle IDs. */
  rowKey: number; parentRow: number; reference: boolean;
  symbol: BoardSymbol; ownerId: string; depth: number; hasChildren: boolean; expanded: boolean;
  hidden: boolean; pinned: boolean; located: boolean; handles: boolean; memberCount: number;
  /** Display membership is not necessarily proof of unique ownership. */
  ownershipProven?: boolean;
}
export interface BoardMemberOutline {
  memberRows: BoardMemberRow[]; memberPages: Record<string, BoardMemberPage>; locatedPath: BoardSymbol[];
}
export interface SymbolData extends Record<string, unknown> {
  symbol: BoardSymbol; expanded: boolean; members: BoardSymbol[]; memberCount: number;
  pinned: string[]; hidden: string[]; locatedMember?: string; undrawn: number; act: ActOnSymbol;
  memberRows?: BoardMemberRow[]; memberPages?: Record<string, BoardMemberPage>; locatedPath?: BoardSymbol[];
  /** Opt in only when the host handles the new pin action (the prototype need not). */
  canPinMembers?: boolean;
  canOpenSiblingSources?: boolean;
  siblingsBusy?: boolean; retainedMemberCount?: number;
  related?: boolean; relatedIds?: ReadonlySet<string>;
}
export interface CodeCardData extends Record<string, unknown> {
  symbolId: string; collapsed: boolean; close: (id: string) => void;
  toggle: (id: string) => void; read: (id: string) => void;
}
export interface BoardSourceAnchor {
  id: string; line: number; direction: 'incoming' | 'outgoing';
}
export interface SourceCardData extends CodeCardData {
  symbol: BoardSymbol; follow?: (target: BoardSymbol, line?: number, event?: MouseEvent) => void; highlight?: number | null;
  filters?: BoardFilters;
  sourceAnchors?: readonly BoardSourceAnchor[];
  /** Derived from existing open source cards, not additional saved membership. */
  sourceFolds?: readonly import('./source-folds').SourceFold[];
  sourceOwners?: readonly BoardSymbol[];
  locateDetached?: (symbolId: string, event?: MouseEvent) => void;
  reattachSource?: (symbolId: string, event?: MouseEvent) => void;
  resize?: (id: string, widthDelta: number, heightDelta: number) => void;
  siblings?: (symbolId: string, event?: MouseEvent) => Promise<void>;
  siblingsBusy?: boolean;
  siblingsAvailable?: boolean;
  sourceState?: (symbolId: string, state: { indexed: boolean; indexTick: number; diskTick: number }) => void;
}
export interface BoardRelation {
  id: string; source: string; target: string; sourceHandle: string; targetHandle: string;
  kind: string; evidence: BoardEvidence[]; via?: string;
  /** Verified indexed lines for the independent source-card layer only. */
  sourceLine?: number; targetLine?: number;
}
export interface ConnectionRow {
  target: BoardSymbol; evidence: BoardEvidence[]; status: 'absent' | 'hidden' | 'visible'; representative: string;
}

export const BOARD_MEMBER_PAGE_SIZE = 6;
export const BOARD_MEMBER_REVEAL_LIMIT = 2048;
const count = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
export const isBoardEvidenceUncertain = (edge: BoardEvidence): boolean =>
  (typeof edge.confidence === 'number' && Number.isFinite(edge.confidence) && edge.confidence < 0.6) || edge.resolvedBy === 'name-only';
const uncertain = isBoardEvidenceUncertain;
const excluded = (item: BoardSymbol, options: Partial<BoardFilters>): boolean =>
  (options.tests === false && item.test === true) || (options.generated === false && item.generated === true);
const sourceOrder = (a: BoardSymbol, b: BoardSymbol): number =>
  a.file.localeCompare(b.file) || a.line - b.line || (a.startColumn ?? 0) - (b.startColumn ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Pure presentation of a supplied graph slice. Never fetches, persists or adds neighbours. */
export function createBoardModel(symbols: readonly BoardSymbol[], relations: readonly BoardEvidence[]) {
  const byId = new Map(symbols.map((item) => [item.id, item]));
  const childrenByOwner = new Map<string, BoardSymbol[]>();
  const outgoing = new Map<string, BoardEvidence[]>();
  const incoming = new Map<string, BoardEvidence[]>();
  // Repeated pages must not count the same indexed evidence more than once.
  const evidence = [...new Map(relations.map((edge) => [edge.id, edge])).values()];
  const childIdsByOwner = new Map<string, Set<string>>();
  function addChild(owner: string, item: BoardSymbol) {
    const ids = childIdsByOwner.get(owner) ?? new Set<string>();
    if (ids.has(item.id)) return;
    ids.add(item.id); childIdsByOwner.set(owner, ids);
    const list = childrenByOwner.get(owner) ?? []; list.push(item); childrenByOwner.set(owner, list);
  }
  for (const item of byId.values()) if (item.ownerId) addChild(item.ownerId, item);
  for (const edge of evidence) {
    const child = byId.get(edge.target);
    if (edge.kind === 'contains' && child) addChild(edge.source, child);
    const from = outgoing.get(edge.source) ?? []; from.push(edge); outgoing.set(edge.source, from);
    const to = incoming.get(edge.target) ?? []; to.push(edge); incoming.set(edge.target, to);
  }
  for (const list of childrenByOwner.values()) list.sort(sourceOrder);
  function symbol(id: string): BoardSymbol {
    const found = byId.get(id);
    if (!found) throw new Error(`Symbol not loaded: ${id}`);
    return found;
  }
  function directChildren(id: string, options: BoardPresentationOptions): BoardSymbol[] {
    const list = childrenByOwner.get(id) ?? [];
    const ids = options.memberPages?.[id]?.ids;
    if (!ids) return list;
    const items = new Map(list.map((item) => [item.id, item]));
    for (const child of ids) { const item = byId.get(child); if (item) items.set(child, item); }
    return [...items.values()].sort(sourceOrder);
  }
  function children(id: string, options: BoardPresentationOptions = {}): BoardSymbol[] { return [...directChildren(id, options)]; }
  function memberCount(id: string, options: BoardPresentationOptions = {}): number {
    const page = options.memberPages?.[id];
    if (page?.total !== undefined) return count(page.total, 0);
    const indexed = byId.get(id)?.memberCount;
    if (indexed !== undefined) return count(indexed, 0);
    return Math.max(page?.ids?.length ?? 0, (childrenByOwner.get(id) ?? []).filter((item) => !excluded(item, options) && (!options.eligibleIds || options.eligibleIds.has(item.id))).length);
  }
  function scopeIds(id: string, withMembers: boolean): Set<string> {
    const ids = new Set([id]);
    if (withMembers) {
      const queue = [id];
      for (let i = 0; i < queue.length; i++) for (const member of childrenByOwner.get(queue[i]!) ?? []) {
        if (!ids.has(member.id)) { ids.add(member.id); queue.push(member.id); }
      }
    }
    return ids;
  }
  /** Memoized per projection, so hubs don't walk the same ownership chains per edge. */
  function resolver(included: ReadonlySet<string>, hidden: ReadonlySet<string>, filtered: ReadonlySet<string> = new Set<string>()) {
    const cache = new Map<string, string | null>();
    return (id: string): string | null => {
      const path: string[] = []; const seen = new Set<string>();
      let current: string | undefined = id; let result: string | null = null;
      while (current && !seen.has(current)) {
        if (cache.has(current)) { result = cache.get(current)!; break; }
        seen.add(current); path.push(current);
        if (hidden.has(current) || filtered.has(current)) break;
        if (included.has(current)) { result = current; break; }
        current = byId.get(current)?.ownerId;
      }
      for (const visited of path) cache.set(visited, result);
      return result;
    };
  }
  /** Prefer explicitly pinned endpoints; hiding a branch suppresses its folded edges. */
  function representative(id: string, included: readonly string[], hidden: readonly string[]): string | null {
    return resolver(new Set(included), new Set(hidden))(id);
  }
  function hiddenBranch(id: string, hidden: ReadonlySet<string>): string | null {
    const seen = new Set<string>(); let current: string | undefined = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      if (hidden.has(current)) return current;
      current = byId.get(current)?.ownerId;
    }
    return null;
  }
  /** Exact hidden identities remain restorable even without a proven owner. */
  function classifyTarget(id: string, visible: (id: string) => string | null, prior: (id: string) => string | null,
    hidden: ReadonlySet<string>): Pick<ConnectionRow, 'status' | 'representative'> {
    const current = visible(id);
    if (current) return { status: 'visible', representative: current };
    if (hidden.has(id)) return { status: 'hidden', representative: id };
    const previous = prior(id);
    if (!previous) return { status: 'absent', representative: id };
    return { status: 'hidden', representative: hiddenBranch(id, hidden) ?? previous };
  }
  /** For Hidden, representative is the exact Restore anchor, which need not be pinned. */
  function targetState(id: string, included: readonly string[], hidden: readonly string[]): Pick<ConnectionRow, 'status' | 'representative'> {
    const chosen = new Set(included); const invisible = new Set(hidden);
    return classifyTarget(id, resolver(chosen, invisible), resolver(chosen, new Set()), invisible);
  }
  function includeSymbols(included: readonly string[], hidden: readonly string[], ids: readonly string[]) {
    const valid = new Set(ids.filter((id) => byId.has(id)));
    return { included: [...new Set([...included, ...valid])], hidden: hidden.filter((id) => !valid.has(id)) };
  }
  function browseConnections(id: string, direction: 'outgoing' | 'incoming', withMembers: boolean,
    included: readonly string[], hidden: readonly string[], kind = '', query = '', options: Partial<BoardFilters> = {}): ConnectionRow[] {
    const scope = scopeIds(id, withMembers); const chosen = new Set(included); const invisible = new Set(hidden);
    const grouped = new Map<string, BoardEvidence[]>();
    const adjacency = direction === 'outgoing' ? outgoing : incoming;
    for (const anchor of scope) for (const relation of adjacency.get(anchor) ?? []) {
      const peer = direction === 'outgoing' ? relation.target : relation.source;
      if (!byId.has(peer) || (kind && relation.kind !== kind) || (options.uncertain === false && uncertain(relation))) continue;
      if ([anchor, peer].some((endpoint) => byId.has(endpoint) && excluded(symbol(endpoint), options))) continue;
      const list = grouped.get(peer) ?? []; list.push(relation); grouped.set(peer, list);
    }
    const visible = resolver(chosen, invisible); const prior = resolver(chosen, new Set());
    const needle = query.trim().toLowerCase();
    return [...grouped].map(([peer, evidence]) => ({ target: symbol(peer), evidence,
      ...classifyTarget(peer, visible, prior, invisible),
    })).filter(({ target, evidence }) => !needle || `${target.qualifiedName} ${target.kind} ${target.file} ${evidence.map((edge) => edge.kind).join(' ')}`.toLowerCase().includes(needle))
      .sort((a, b) => (a.target.ownerId ?? a.target.file).localeCompare(b.target.ownerId ?? b.target.file) || sourceOrder(a.target, b.target));
  }
  /** Exact loaded ownership path, including representative and endpoint, or no proven path. */
  function ownershipPath(id: string, owner: string): string[] | null {
    if (!byId.has(id) || !byId.has(owner)) return null;
    const path: string[] = []; const seen = new Set<string>();
    let current: string | undefined = id;
    while (current && !seen.has(current)) {
      seen.add(current); path.push(current);
      if (current === owner) return path.reverse();
      current = byId.get(current)?.ownerId;
    }
    return null;
  }
  /** Backwards-compatible direct containing row; Locate should use ownershipPath instead. */
  function memberOf(endpoint: string, owner: string): string | null { return ownershipPath(endpoint, owner)?.[1] ?? null; }
  /** Reveal only the path, not every preceding sibling of a large container. */
  function revealMember(id: string, owner: string, expanded: readonly string[], limits: Record<string, number> = {}) {
    const path = ownershipPath(id, owner) ?? [];
    return { path, expanded: [...new Set([...expanded, ...path.slice(0, -1)])], limits: { ...limits },
      locatedMember: path.length > 1 ? id : undefined };
  }
  function outline(owner: string, chosen: ReadonlySet<string>, hidden: ReadonlySet<string>, expanded: ReadonlySet<string>,
    limits: Record<string, number>, options: BoardPresentationOptions, resolve: (id: string) => string | null): BoardMemberOutline {
    const memberRows: BoardMemberRow[] = [];
    const memberPages: Record<string, BoardMemberPage> = Object.create(null);
    const path = options.locatedMember ? ownershipPath(options.locatedMember, owner) ?? [] : [];
    const reveal = new Map(path.slice(0, -1).map((id, index) => [id, path[index + 1]!]));
    // Expand a symbol at most once per ownership context. Repeated contains
    // memberships remain labelled rows, not silently dropped or recursively cloned.
    const proven = new Set([owner]); const unproven = new Set([owner]);
    type Frame = { ownerId: string; depth: number; parentRow: number; proven: boolean; item?: BoardSymbol };
    const stack: Frame[] = [{ ownerId: owner, depth: 1, parentRow: -1, proven: true }];
    // Iterative depth-first traversal also terminates on malformed cycles/deep input.
    while (stack.length) {
      const frame = stack.pop()!;
      if (frame.item) {
        const item = frame.item;
        const ownershipProven = frame.proven && item.ownerId === frame.ownerId;
        const seen = ownershipProven ? proven : unproven;
        const reference = seen.has(item.id); seen.add(item.id);
        const total = memberCount(item.id, options); const isHidden = hidden.has(item.id);
        const hasRetained = directChildren(item.id, options).some((child) => hidden.has(child.id) || chosen.has(child.id));
        const hasChildren = total > 0 || hasRetained;
        const isExpanded = hasChildren && expanded.has(item.id) && !isHidden && !reference;
        const rowKey = memberRows.length;
        memberRows.push({ rowKey, parentRow: frame.parentRow, reference, symbol: item, ownerId: frame.ownerId, depth: frame.depth, hasChildren,
          expanded: isExpanded, hidden: isHidden, pinned: chosen.has(item.id) && !isHidden,
          located: ownershipProven && item.id !== owner && options.locatedMember === item.id,
          handles: ownershipProven && item.id !== owner && !isHidden && resolve(item.id) === owner, memberCount: total, ownershipProven });
        if (isExpanded) stack.push({ ownerId: item.id, depth: frame.depth + 1, parentRow: rowKey, proven: ownershipProven });
        continue;
      }
      if (!expanded.has(frame.ownerId) || hidden.has(frame.ownerId)) continue;
      const state = options.memberPages?.[frame.ownerId];
      const all = directChildren(frame.ownerId, options);
      const ids = state?.ids ? new Set(state.ids) : options.eligibleIds;
      const loadedChildren = ids ? all.filter((item) => ids.has(item.id)) : all;
      const eligible = loadedChildren.filter((item) => !excluded(item, options));
      const limit = Math.min(BOARD_MEMBER_REVEAL_LIMIT, count(limits[frame.ownerId], BOARD_MEMBER_PAGE_SIZE));
      const visible = new Set(eligible.slice(0, limit).map((item) => item.id));
      // Retained pin/hidden preferences are not eligible discovery results and
      // must not vanish merely because a filtered page omits their identities.
      for (const item of all) if (hidden.has(item.id) || chosen.has(item.id)) visible.add(item.id);
      const revealed = reveal.get(frame.ownerId);
      if (revealed) visible.add(revealed);
      const shown = all.filter((item) => visible.has(item.id));
      const total = memberCount(frame.ownerId, options);
      const loaded = Math.max(loadedChildren.length, count(state?.loaded, 0));
      const filtered = loadedChildren.length - eligible.length;
      const nextOffset = state?.nextOffset !== undefined ? state.nextOffset : loaded < total ? loaded : null;
      const shownEligible = eligible.filter((item) => visible.has(item.id)).length;
      const more = eligible.some((item) => !visible.has(item.id)) || nextOffset !== null;
      memberPages[frame.ownerId] = { ownerId: frame.ownerId, total, loaded, shown: shownEligible, filtered, retained: shown.length - shownEligible,
        remaining: Math.max(0, total - shownEligible - filtered), hasMore: limit < BOARD_MEMBER_REVEAL_LIMIT && more,
        nextOffset, loading: state?.loading ?? false, bounded: (state?.bounded ?? byId.get(frame.ownerId)?.membersBounded ?? false) || (limit >= BOARD_MEMBER_REVEAL_LIMIT && more) };
      for (let index = shown.length - 1; index >= 0; index--) stack.push({ ...frame, item: shown[index]! });
    }
    return { memberRows, memberPages, locatedPath: path.map(symbol) };
  }
  function visibleOutline(owner: string, included: readonly string[], hidden: readonly string[], expanded: readonly string[],
    limits: Record<string, number> = {}, options: BoardPresentationOptions = {}): BoardMemberOutline {
    const chosen = new Set(included); const invisible = new Set(hidden);
    const filtered = new Set([...byId.values()].filter((item) => excluded(item, options)).map((item) => item.id));
    return outline(owner, chosen, invisible, new Set(expanded), limits, options, resolver(chosen, invisible, filtered));
  }
  function projectBoard(included: readonly string[], hidden: readonly string[], expanded: readonly string[],
    kind = '', showStructure = false, limits: Record<string, number> = {}, options: BoardPresentationOptions = {}) {
    const chosen = new Set(included); const invisible = new Set(hidden); const open = new Set(expanded);
    // Explicit selections always remain cards, even under an exclusion preset.
    const filtered = new Set([...byId.values()].filter((item) => excluded(item, options)).map((item) => item.id));
    const baseResolve = resolver(chosen, invisible); const resolve = resolver(chosen, invisible, filtered);
    const visible = [...byId.values()].filter((item) => chosen.has(item.id) && !invisible.has(item.id));
    const outlines = new Map(visible.map((item) => [item.id, outline(item.id, chosen, invisible, open, limits, options, resolve)]));
    const ports = new Map([...outlines].map(([id, value]) => [id, new Set(value.memberRows.filter((row) => row.handles).map((row) => row.symbol.id))]));
    type Endpoint = { representative: string; port: string | null };
    const endpoints = new Map<string, Endpoint | null>();
    function endpoint(id: string): Endpoint | null {
      if (endpoints.has(id)) return endpoints.get(id)!;
      const owner = resolve(id);
      if (!owner) { endpoints.set(id, null); return null; }
      const path: string[] = []; const seen = new Set<string>();
      let current: string | undefined = id; let port: string | null = null;
      while (current && current !== owner && !seen.has(current)) {
        const cached = endpoints.get(current);
        if (cached?.representative === owner) { port = cached.port; break; }
        seen.add(current); path.push(current);
        if (ports.get(owner)?.has(current)) { port = current; break; }
        current = byId.get(current)?.ownerId;
      }
      const result = { representative: owner, port };
      endpoints.set(id, result); for (const member of path) endpoints.set(member, result);
      return result;
    }
    const grouped = new Map<string, BoardRelation>(); const undrawn = new Map<string, number>();
    for (const relation of evidence) {
      const source = endpoint(relation.source); const target = endpoint(relation.target);
      if (!source || !target || (kind && relation.kind !== kind) || (!showStructure && relation.kind === 'contains') ||
        (options.uncertain === false && uncertain(relation))) {
        const owners = new Set([baseResolve(relation.source), baseResolve(relation.target)]);
        for (const owner of owners) if (owner) undrawn.set(owner, (undrawn.get(owner) ?? 0) + 1);
        continue;
      }
      const sourceHandle = source.port ? `out-${source.port}` : 'out';
      const targetHandle = target.port ? `in-${target.port}` : 'in';
      const mechanism = relation.via ?? relation.synthesizedBy ?? (relation.provenance === 'heuristic' ? 'heuristic' : undefined);
      const id = JSON.stringify([source.representative, sourceHandle, target.representative, targetHandle, relation.kind, mechanism ?? '', uncertain(relation)]);
      const edge = grouped.get(id) ?? { id, source: source.representative, target: target.representative, sourceHandle, targetHandle,
        kind: relation.kind, evidence: [], via: mechanism };
      edge.evidence.push(relation); grouped.set(id, edge);
    }
    return {
      symbols: visible.map((item) => {
        const detail = outlines.get(item.id)!;
        // Retain the old direct-list API for hosts that don't render nested rows.
        const members = detail.memberRows.filter((row) => row.depth === 1).map((row) => row.symbol);
        return { symbol: item, members: open.has(item.id) ? members : directChildren(item.id, options)
          .filter((member) => (!options.eligibleIds || options.eligibleIds.has(member.id)) && !excluded(member, options) || chosen.has(member.id) || invisible.has(member.id)).slice(0, Math.min(BOARD_MEMBER_REVEAL_LIMIT, count(limits[item.id], BOARD_MEMBER_PAGE_SIZE))),
          memberCount: memberCount(item.id, options), retainedMemberCount: directChildren(item.id, options).filter((child) => invisible.has(child.id) || chosen.has(child.id)).length, undrawn: undrawn.get(item.id) ?? 0, ...detail };
      }),
      edges: [...grouped.values()],
    };
  }
  /** Source selection is decoration only, grounded in original endpoints. */
  function sourceSelection(ids: readonly string[], included: readonly string[], hidden: readonly string[]) {
    const members = new Set<string>();
    for (const id of ids) for (const member of scopeIds(id, true)) members.add(member);
    const resolve = resolver(new Set(included), new Set(hidden));
    const representatives = new Set<string>();
    for (const id of members) { const owner = resolve(id); if (owner) representatives.add(owner); }
    const evidenceIds = new Set(evidence.filter((edge) => members.has(edge.source) || members.has(edge.target)).map((edge) => edge.id));
    return { members, representatives, evidenceIds };
  }
  function filterSymbols(query: string, folder: string, kind = '', options: Partial<BoardFilters> = {}): BoardSymbol[] {
    const needle = query.trim().toLowerCase();
    return [...byId.values()].filter((item) => !excluded(item, options) && (!folder || item.folder === folder) && (!kind || item.kind === kind) &&
      (!needle || `${item.name} ${item.qualifiedName} ${item.folder ?? ''} ${item.kind} ${item.purpose ?? ''}`.toLowerCase().includes(needle)));
  }
  return { symbol, children, scopeIds, representative, targetState, includeSymbols, browseConnections, projectBoard, filterSymbols,
    memberOf, ownershipPath, revealMember, visibleOutline, sourceSelection };
}

/** Bounded discovery cache. Retained/displayed facts and the incoming page are
 * protected; merely sharing an expanded owner does not retain every search hit. */
export function mergeBoardFacts(current: readonly BoardSymbol[], incoming: readonly BoardSymbol[], retain: ReadonlySet<string>, max = 16384): BoardSymbol[] {
  const facts = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) facts.set(item.id, item);
  const keep = new Set([...retain, ...incoming.map((item) => item.id)]);
  for (const id of [...keep]) {
    let cursor = facts.get(id)?.ownerId; const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) { seen.add(cursor); keep.add(cursor); cursor = facts.get(cursor)?.ownerId; }
  }
  for (const id of facts.keys()) { if (facts.size <= max) break; if (!keep.has(id)) facts.delete(id); }
  return [...facts.values()];
}

/** One linear grouping pass instead of filtering all edges again for every lane. */
export function edgeLaneMap(
  edges: readonly (Pick<BoardRelation, 'id' | 'source' | 'target'> & Partial<Pick<BoardRelation, 'sourceHandle' | 'targetHandle'>>)[],
  byHandles = false,
): Map<string, number> {
  const pairs = new Map<string, typeof edges[number][]>();
  for (const edge of edges) {
    const key = JSON.stringify(byHandles ? [edge.source, edge.sourceHandle, edge.target, edge.targetHandle] : [edge.source, edge.target]);
    const group = pairs.get(key) ?? []; group.push(edge); pairs.set(key, group);
  }
  const lanes = new Map<string, number>();
  for (const group of pairs.values()) group.forEach((edge, index) => {
    lanes.set(edge.id, edge.source === edge.target ? 320 + index * 48 : (index - (group.length - 1) / 2) * 56);
  });
  return lanes;
}

export function nextSymbolPosition(occupied: readonly { position: { x: number; y: number }; width?: number; height?: number }[], preferred: { x: number; y: number }) {
  const position = { ...preferred };
  while (occupied.some((node) => position.x < node.position.x + (node.width ?? 286) + 30 && position.x + 316 > node.position.x &&
    position.y < node.position.y + (node.height ?? 240) + 30 && position.y + 270 > node.position.y)) position.y += 300;
  return position;
}
export function nextCodePosition(cards: readonly { position: { x: number; y: number }; width?: number; height?: number }[], top = 820): { x: number; y: number } {
  const bottom = Math.max(top, ...cards.map((card) => card.position.y + (card.height ?? 310))) + 60;
  for (let y = top; y <= bottom; y += 370) for (const x of [30, 600]) {
    if (!cards.some((card) => x < card.position.x + (card.width ?? 530) + 20 && x + 550 > card.position.x &&
      y < card.position.y + (card.height ?? 310) + 20 && y + 330 > card.position.y)) return { x, y };
  }
  return { x: 30, y: bottom };
}
