import { isBoardEvidenceUncertain, type BoardEvidence, type BoardRelation, type BoardSourceAnchor, type BoardSymbol } from './board-model';

const MODULE_STRUCTURE = new Set(['imports', 'exports', 'contains']);
const callable = (symbol: BoardSymbol) => symbol.kind === 'function' || symbol.kind === 'method';
const safeLine = (line: number | undefined): line is number => typeof line === 'number' && Number.isSafeInteger(line) && line > 0;
const within = (line: number, symbol: BoardSymbol): boolean =>
  safeLine(symbol.line) && safeLine(symbol.endLine ?? symbol.line) && line >= symbol.line && line <= (symbol.endLine ?? symbol.line);

/** Stable line-specific ports: outgoing on the right, incoming on the left. */
export function boardSourceHandleId(direction: BoardSourceAnchor['direction'], line: number): string {
  return `source-${direction === 'outgoing' ? 'out' : 'in'}:${line}`;
}

/** Unique ports for this source card only; symbol-layer relationships are ignored. */
export function boardSourceAnchors(relations: readonly BoardRelation[], symbolId: string): BoardSourceAnchor[] {
  const anchors = new Map<string, BoardSourceAnchor>();
  for (const relation of relations) {
    if (!relation.source.startsWith('code:') || !relation.target.startsWith('code:')) continue;
    for (const direction of ['incoming', 'outgoing'] as const) {
      const endpoint = direction === 'outgoing' ? relation.source : relation.target;
      const line = direction === 'outgoing' ? relation.sourceLine : relation.targetLine;
      if (endpoint !== `code:${symbolId}` || !safeLine(line)) continue;
      const id = boardSourceHandleId(direction, line);
      anchors.set(id, { id, line, direction });
    }
  }
  return [...anchors.values()].sort((a, b) => a.line - b.line || a.direction.localeCompare(b.direction));
}

/**
 * Separate source-only projection. Never feeds discovery facts into symbol membership.
 * Missing/unsupported sites produce no line arrow; never guess a callable's start line.
 */
export function boardSourceRelations(
  symbols: readonly BoardSymbol[], evidence: readonly BoardEvidence[], open: readonly string[], kind = '',
): BoardRelation[] {
  const byId = new Map(symbols.map((item) => [item.id, item]));
  const cards = new Set(open);
  function chain(id: string): BoardSymbol[] {
    const path: BoardSymbol[] = []; const seen = new Set<string>();
    let item = byId.get(id);
    while (item && !seen.has(item.id)) {
      seen.add(item.id); path.push(item); item = item.ownerId ? byId.get(item.ownerId) : undefined;
    }
    return path;
  }
  const grouped = new Map<string, BoardRelation>();
  const seen = new Set<string>();
  for (const edge of evidence) {
    if (seen.has(edge.id) || MODULE_STRUCTURE.has(edge.kind) || (kind && edge.kind !== kind)) continue;
    seen.add(edge.id);
    const origin = chain(edge.source);
    // Parameters/local values belong to their callable. Class headers, fields,
    // imports and other file-level dependencies do not establish source arrows.
    const fn = origin.find(callable);
    if (!fn) continue;
    if (!edge.file || edge.file !== fn.file || !safeLine(edge.line) || !within(edge.line, fn)) continue;
    const source = origin.find((item) => cards.has(item.id));
    const destination = chain(edge.target);
    const originalTarget = destination[0];
    const target = destination.find((item) => cards.has(item.id));
    if (!source || !target || !originalTarget) continue;
    if (source.file !== edge.file || !within(edge.line, source)) continue;
    // A folded method still arrives at its own declaration, not the class header.
    const targetLine = originalTarget.line;
    if (!originalTarget.file || originalTarget.file !== target.file || !safeLine(targetLine) || !within(targetLine, target)) continue;
    const mechanism = edge.synthesizedBy ?? edge.via;
    const id = `source-relation:${JSON.stringify([
      source.id, target.id, edge.source, edge.target, edge.file, edge.line, edge.col ?? null, targetLine,
      edge.kind, edge.provenance ?? '', edge.synthesizedBy ?? '', edge.via ?? '',
      edge.registeredAt ?? '', edge.resolvedBy ?? '', isBoardEvidenceUncertain(edge),
    ])}`;
    const relation = grouped.get(id) ?? {
      id, source: `code:${source.id}`, target: `code:${target.id}`,
      sourceLine: edge.line, targetLine,
      sourceHandle: boardSourceHandleId('outgoing', edge.line), targetHandle: boardSourceHandleId('incoming', targetLine),
      kind: edge.kind, evidence: [],
      ...(mechanism ? { via: mechanism } : {}),
    };
    relation.evidence.push(edge); grouped.set(id, relation);
  }
  return [...grouped.values()];
}

/** Atomic bulk admission: source cards share the board's retained-identity budget. */
export function boardSiblingSourceCapacity(existing: readonly string[], siblings: readonly string[], retained: readonly string[]): string | null {
  if (new Set([...retained, ...existing, ...siblings]).size > 128) return 'Opening all sibling sources would exceed 128 retained identities. Remove some items first; none were opened.';
  return null;
}
