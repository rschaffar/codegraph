import { isBoardEvidenceUncertain, type BoardEvidence, type BoardRelation, type BoardSymbol } from './board-model';

const MODULE_STRUCTURE = new Set(['imports', 'exports', 'contains']);
const callable = (symbol: BoardSymbol) => symbol.kind === 'function' || symbol.kind === 'method';

/** Separate source-only projection. Never feeds discovery facts into symbol membership. */
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
    if (edge.file && edge.file !== fn.file) continue;
    if (edge.line != null && (!Number.isSafeInteger(edge.line) || edge.line < fn.line || edge.line > (fn.endLine ?? fn.line))) continue;
    const source = origin.find((item) => cards.has(item.id));
    const target = chain(edge.target).find((item) => cards.has(item.id));
    if (!source || !target) continue;
    const mechanism = edge.synthesizedBy ?? edge.via;
    const id = `source-relation:${JSON.stringify([source.id, target.id, edge.kind, mechanism ?? '', isBoardEvidenceUncertain(edge)])}`;
    const relation = grouped.get(id) ?? {
      id, source: `code:${source.id}`, target: `code:${target.id}`,
      sourceHandle: 'source-out', targetHandle: 'source-in', kind: edge.kind, evidence: [],
      ...(mechanism ? { via: mechanism } : {}),
    };
    relation.evidence.push(edge); grouped.set(id, relation);
  }
  return [...grouped.values()];
}

/** Atomic bulk admission: never silently open a prefix when a board limit is hit. */
export function boardSiblingSourceCapacity(existing: readonly string[], siblings: readonly string[], retained: readonly string[]): string | null {
  if (new Set([...existing, ...siblings]).size > 32) return 'Opening all sibling sources would exceed 32 source cards. Close some cards first; none were opened.';
  if (new Set([...retained, ...existing, ...siblings]).size > 128) return 'Opening all sibling sources would exceed 128 retained identities. Remove some items first; none were opened.';
  return null;
}
