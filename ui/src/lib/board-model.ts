export interface BoardSymbol {
  id: string; kind: string; name: string; qualifiedName: string; file: string; line: number;
  endLine?: number; language?: string; signature?: string; ownerId?: string;
  purpose?: string; folder?: string; memberCount?: number; membersBounded?: boolean;
}
export interface BoardEvidence {
  id: string; source: string; target: string; kind: string; file?: string; line?: number; col?: number;
  confidence?: number; provenance?: string; synthesizedBy?: string; via?: string; registeredAt?: string; resolvedBy?: string;
}
export type SymbolAction = 'connections' | 'hide' | 'restore' | 'expand' | 'more' | 'code' | 'locate';
export type ActOnSymbol = (action: SymbolAction, id: string) => void;
export interface SymbolData extends Record<string, unknown> {
  symbol: BoardSymbol; expanded: boolean; members: BoardSymbol[]; memberCount: number;
  pinned: string[]; hidden: string[]; locatedMember?: string; undrawn: number; act: ActOnSymbol;
}
export interface CodeCardData extends Record<string, unknown> {
  symbolId: string; collapsed: boolean; close: (id: string) => void;
  toggle: (id: string) => void; read: (id: string) => void;
}
export interface SourceCardData extends CodeCardData { symbol: BoardSymbol }
export interface BoardRelation {
  id: string; source: string; target: string; sourceHandle: string; targetHandle: string;
  kind: string; evidence: BoardEvidence[]; via?: string;
}
export interface ConnectionRow {
  target: BoardSymbol; evidence: BoardEvidence[]; status: 'absent' | 'hidden' | 'visible'; representative: string;
}

/** Pure presentation of a supplied graph slice. Never fetches, persists or adds neighbours. */
export function createBoardModel(symbols: readonly BoardSymbol[], relations: readonly BoardEvidence[]) {
  const byId = new Map(symbols.map((item) => [item.id, item]));
  function symbol(id: string): BoardSymbol {
    const found = byId.get(id);
    if (!found) throw new Error(`Symbol not loaded: ${id}`);
    return found;
  }
  function children(id: string): BoardSymbol[] {
    return symbols.filter((item) => item.ownerId === id).sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  }
  function scopeIds(id: string, withMembers: boolean): Set<string> {
    const ids = new Set([id]);
    if (withMembers) {
      const queue = [id];
      for (let i = 0; i < queue.length; i++) for (const member of children(queue[i]!)) {
        if (!ids.has(member.id)) { ids.add(member.id); queue.push(member.id); }
      }
    }
    return ids;
  }
  /** Prefer explicitly pinned endpoints; hiding one suppresses its folded edges too. */
  function representative(id: string, included: readonly string[], hidden: readonly string[]): string | null {
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      if (hidden.includes(current)) return null;
      if (included.includes(current)) return current;
      current = byId.get(current)?.ownerId;
    }
    return null;
  }
  function targetState(id: string, included: readonly string[], hidden: readonly string[]): Pick<ConnectionRow, 'status' | 'representative'> {
    const visible = representative(id, included, hidden);
    if (visible) return { status: 'visible', representative: visible };
    const prior = representative(id, included, []);
    return prior ? { status: 'hidden', representative: prior } : { status: 'absent', representative: id };
  }
  function includeSymbols(included: readonly string[], hidden: readonly string[], ids: readonly string[]) {
    const valid = ids.filter((id) => byId.has(id));
    return { included: [...new Set([...included, ...valid])], hidden: hidden.filter((id) => !valid.includes(id)) };
  }
  function browseConnections(id: string, direction: 'outgoing' | 'incoming', withMembers: boolean,
    included: readonly string[], hidden: readonly string[], kind = '', query = ''): ConnectionRow[] {
    const scope = scopeIds(id, withMembers);
    const grouped = new Map<string, BoardEvidence[]>();
    for (const relation of relations) {
      const from = direction === 'outgoing' ? relation.source : relation.target;
      const peer = direction === 'outgoing' ? relation.target : relation.source;
      if (!scope.has(from) || !byId.has(peer) || (kind && relation.kind !== kind)) continue;
      const list = grouped.get(peer) ?? []; list.push(relation); grouped.set(peer, list);
    }
    const needle = query.trim().toLowerCase();
    return [...grouped].map(([peer, evidence]) => ({ target: symbol(peer), evidence, ...targetState(peer, included, hidden) }))
      .filter(({ target, evidence }) => !needle || `${target.qualifiedName} ${target.kind} ${target.file} ${evidence.map((edge) => edge.kind).join(' ')}`.toLowerCase().includes(needle))
      .sort((a, b) => (a.target.ownerId ?? a.target.file).localeCompare(b.target.ownerId ?? b.target.file) || a.target.name.localeCompare(b.target.name));
  }
  /** Direct row that contains an endpoint; also used to explain nested Locate. */
  function memberOf(endpoint: string, owner: string): string | null {
    let current = endpoint;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const parent = byId.get(current)?.ownerId;
      if (parent === owner) return current;
      if (!parent) return null;
      current = parent;
    }
    return null;
  }
  function memberPort(endpoint: string, owner: string, expanded: readonly string[], limits: Record<string, number>): string | null {
    if (endpoint === owner || !expanded.includes(owner)) return null;
    const member = memberOf(endpoint, owner);
    return member && children(owner).slice(0, limits[owner] ?? 6).some((item) => item.id === member) ? member : null;
  }
  function projectBoard(included: readonly string[], hidden: readonly string[], expanded: readonly string[],
    kind = '', showStructure = false, limits: Record<string, number> = {}) {
    const visible = symbols.filter((item) => included.includes(item.id) && !hidden.includes(item.id));
    const grouped = new Map<string, BoardRelation>();
    const drawn = new Set<string>();
    for (const relation of relations) {
      if ((kind && relation.kind !== kind) || (!showStructure && relation.kind === 'contains')) continue;
      const source = representative(relation.source, included, hidden);
      const target = representative(relation.target, included, hidden);
      if (!source || !target) continue;
      const sourcePort = memberPort(relation.source, source, expanded, limits);
      const targetPort = memberPort(relation.target, target, expanded, limits);
      const sourceHandle = sourcePort ? `out-${sourcePort}` : 'out';
      const targetHandle = targetPort ? `in-${targetPort}` : 'in';
      const mechanism = relation.via ?? relation.synthesizedBy ?? (relation.provenance === 'heuristic' ? 'heuristic' : undefined);
      const id = JSON.stringify([source, sourceHandle, target, targetHandle, relation.kind, mechanism ?? '', (relation.confidence ?? 1) < 0.6]);
      const edge = grouped.get(id) ?? { id, source, target, sourceHandle, targetHandle, kind: relation.kind, evidence: [], via: mechanism };
      edge.evidence.push(relation); grouped.set(id, edge); drawn.add(relation.id);
    }
    return {
      symbols: visible.map((item) => ({ symbol: item, members: children(item.id).slice(0, limits[item.id] ?? 6), memberCount: item.memberCount ?? children(item.id).length,
        undrawn: relations.filter((edge) => !drawn.has(edge.id) &&
          (representative(edge.source, included, hidden) === item.id || representative(edge.target, included, hidden) === item.id)).length })),
      edges: [...grouped.values()],
    };
  }
  function filterSymbols(query: string, folder: string, kind = ''): BoardSymbol[] {
    const needle = query.trim().toLowerCase();
    return symbols.filter((item) => (!folder || item.folder === folder) && (!kind || item.kind === kind) &&
      (!needle || `${item.name} ${item.qualifiedName} ${item.folder} ${item.kind} ${item.purpose}`.toLowerCase().includes(needle)));
  }
  return { symbol, children, scopeIds, representative, targetState, includeSymbols, browseConnections, projectBoard, filterSymbols, memberOf };
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
